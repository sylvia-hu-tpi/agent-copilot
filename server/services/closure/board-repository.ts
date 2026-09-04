/**
 * 結案紀錄的 Data Board 倉儲 —— 憲法 5.3 的落點，
 * `specs/006-closure-handoff-summary` 契約 R3.4／R3.5／R3.13、FR-030～FR-032a。
 *
 * ⚠️⚠️ **本檔 MUST NOT 出現 `filter:` 或 `sort:`**（契約守衛 G4）。理由與
 *      `period.ts` 檔頭相同：兩者實測都被平台**靜默忽略**（回 200 ＋ 一批沒過濾／
 *      沒排序的紀錄）。防腐層（`server/services/imbrace.ts`）的簽章已經不提供它們，
 *      這條守衛是第二道。
 *
 * ⚠️ **本檔是「倉儲」，不是 provider**（憲法 2.4）：它有唯一實作、不為替換而存在。
 *    Data Board 是 iMBrace 的既定產品，不在「規格未定的外部依賴」之列，
 *    隔離已由 `imbrace.ts` 的防腐層承擔，這裡再包一層 provider 介面是多餘的。
 *
 * ⚠️ **本目錄不是分析管線的成員**（見 `board-schema.ts` 檔頭）：
 *    不加 `@analysis-pipeline` 標記、不進 `test/contract-guards.test.ts` 的
 *    狀態擁有權表、不參與背景節流。
 *
 * ⚠️ **日誌 MUST NOT 含 `summary`／`intent`**（憲法 1.5）—— 那是客戶對話個資。
 *    每一步只記 `reqId`／`draftId`／`recordId` 與筆數，那足以回答 B8 要問的
 *    「三步走到哪一步」，而那正是這些日誌存在的唯一目的。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import type { ClosureSummary } from '../../../shared/types/copilot.js'
import {
  createBoardItem,
  getBoard,
  getBoardItem,
  searchBoardItems,
  updateBoardItem,
} from '../imbrace.js'
import { CLOSURE_BOARD_FIELDS } from './board-schema.js'

/**
 * 寫入路徑的硬逾時（FR-032a、契約 R3.12）。
 *
 * ⚠️ **這是 FR-040a「寫入中不可取消」的成立前提。** 兩者 MUST 一起存在 ——
 *    只做「不可取消」而沒有上界，客服會被困在一個既不能取消、也不會自己結束的狀態裡。
 *
 * ⚠️ **MUST NOT 被 SC-004 的「不設固定秒數」波及。** 那條講的是**摘要產生**
 *    （工作量隨涵蓋區間變動，訂任何秒數都是錯的口徑）；寫入的工作量固定為
 *    三次 Board 呼叫（實測次秒級），正是該有門檻的那一類。
 *    兩個預算性質相反，MUST NOT 互相污染。
 */
export const CLOSURE_WRITE_TIMEOUT_MS = 30_000

/** 欄位 id 對照的快取壽命。失效只是多一次 `getBoard()`，不是狀態（憲法 9.2） */
const FIELD_MAP_TTL_MS = 10 * 60 * 1000

/**
 * 寫入失敗。
 *
 * ⚠️ `failKind` 是契約 R3.15 的落點：`'unverified'` **專指**「寫入回 200 但回查不存在」，
 *    其餘（逾時、4xx、5xx）一律 `'failed'`。
 *    ⚠️ 兩者的**狀態機出口相同**（前端一律回 `ready` ＋ 保留草稿），
 *    差異只在文案與按鈕 —— 前端 MUST NOT 為此開第二條狀態路徑。
 */
export class ClosureWriteError extends Error {
  constructor(
    message: string,
    public readonly failKind: 'failed' | 'unverified',
    public readonly status: 502 | 504,
    public readonly reqId: string,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ClosureWriteError'
  }
}

/** 從 Board 讀回來的一列結案紀錄（只取候選清單與 FR-034 需要的欄位） */
export interface ClosureRecordRow {
  recordId: string
  /** 平台的 item id —— 回查與更新用。與 `recordId` 刻意分開，見 `commitClosure()` */
  itemId: string
  draftId: string
  conversationId: string
  closedAt: string
  category: string
  reviewedBy: string | null
  createdAt: string | null
}

export interface CommitOptions {
  reqId: string
  /** 預設 `console`。抽出來是為了讓測試能斷言「三步各記一行且都帶 reqId」 */
  log?: Pick<typeof console, 'info' | 'warn'>
  /** ⚠️ 只有測試該傳（T037／T038 注入短值）。正式路徑一律用預設的 30 秒 */
  timeoutMs?: number
}

// ── 欄位 id 對照（name → id）───────────────────────────────────────────
//
// ⚠️ **這是本規格最危險的一條路徑的另一半。** 寫入用的是欄位 id，而
//    `createField()` 回的是整個 board（SDK 註解寫反了）—— 照它做的話所有欄位
//    共用同一把 id，寫入互相覆蓋而平台照樣回 200。因此 id 一律由 `getBoard()` 反查。
//
// ⚠️ 快取掛在 `globalThis` 而非模組變數：dev 模式下 Nitro HMR 會重新載入模組
//    （比照 `server/services/ai/index.ts` 與 `copilot-runtime.ts` 的理由）。
// ⚠️ 這是**純衍生的唯讀快取**，不是狀態（憲法 9.2）——失效只是多一次呼叫，
//    因此不擴大多副本前的 Redis 前置條件。

const FIELD_MAP_KEY = Symbol.for('agent-copilot.closure-field-map')
type FieldMapGlobal = typeof globalThis & {
  [FIELD_MAP_KEY]?: Map<string, { at: number, ids: Map<string, string> }>
}

function fieldMapCache(): Map<string, { at: number, ids: Map<string, string> }> {
  const g = globalThis as FieldMapGlobal
  if (!g[FIELD_MAP_KEY]) g[FIELD_MAP_KEY] = new Map()
  return g[FIELD_MAP_KEY]
}

/**
 * 欄位名 → 欄位 id。
 *
 * @param opts.bypassCache `--verify` MUST 傳 `true` —— 欄位在平台上被改名或重建後
 *        快取會靜默失效，而驗證的整個意義就是不信任任何一份可能過期的副本。
 */
export async function fieldIdMap(
  client: ImbraceClient,
  boardId: string,
  opts: { bypassCache?: boolean } = {},
): Promise<Map<string, string>> {
  const cache = fieldMapCache()
  const hit = cache.get(boardId)
  if (!opts.bypassCache && hit && Date.now() - hit.at < FIELD_MAP_TTL_MS) return hit.ids

  const board = await getBoard(client, boardId)
  if (!board) throw new Error(`找不到 Data Board ${boardId} —— 請確認 IMBRACE_CLOSURE_BOARD_ID`)

  const ids = new Map(board.fields.map(f => [f.name, f.id]))
  cache.set(boardId, { at: Date.now(), ids })
  return ids
}

/** 測試用：清掉快取 */
export function resetClosureFieldMapCache(): void {
  fieldMapCache().clear()
}

// ── ClosureSummary → Board 的 `{ fieldId: value }` ────────────────────

/** JSON 陣列欄位（`LongText`，實測可原樣往返，006-E6） */
const JSON_FIELDS = new Set(['operators', 'cited_sops', 'follow_ups'])

/**
 * ⚠️ **`null` 的欄位一律「不送」，MUST NOT 送 `0` 或空字串**（FR-022b）。
 *    實測未設定的 `Number` 回讀為 `null`，與 `0` 明確可分（006-E4）——
 *    這條規則因此是成立的，而它一旦被寫錯，報表會把「這段情緒不可信」
 *    讀成「客戶情緒是最低分」，且不會有任何錯誤訊息。
 *
 * ⚠️ 受控詞彙欄位的空字串同樣不送 —— 「模型挑不到、客服也沒補」與
 *    「選了一個叫做空字串的分類」在報表上是兩件事。
 *
 * ⚠️ 對照表未涵蓋的欄位名會被**跳過**並不報錯：那代表 Board 上少了一欄，
 *    由 `npm run board:verify` 負責指出（B2）。在寫入路徑上炸開只會讓
 *    客服在按下寫入時看到一個他無能為力的錯誤。
 */
export function toFieldsById(
  summary: ClosureSummary,
  fieldIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    record_id: summary.recordId,
    draft_id: summary.draftId,
    conversation_id: summary.conversationId,
    period_start: summary.periodStart,
    period_message_count: summary.periodMessageCount,
    period_origin: summary.periodOrigin,
    channel: summary.channel,
    contact_id: summary.contactId,
    operators: summary.operators,
    joined_at: summary.joinedAt,
    closed_at: summary.closedAt,
    summary: summary.summary,
    intent: summary.intent,
    category: summary.category,
    resolution: summary.resolution,
    actions_taken: summary.actionsTaken,
    sentiment_outcome: summary.sentimentOutcome,
    sentiment_start: summary.sentimentStart,
    sentiment_end: summary.sentimentEnd,
    sentiment_trough: summary.sentimentTrough,
    period_sentiment_note: summary.sentimentNote,
    cited_sops: summary.citedSopIds,
    follow_ups: summary.followUps,
    confidence: summary.confidence,
    reviewed_by: summary.reviewedBy,
    reviewed_at: summary.reviewedAt,
  }

  const out: Record<string, unknown> = {}
  for (const spec of CLOSURE_BOARD_FIELDS) {
    const fid = fieldIds.get(spec.name)
    if (!fid) continue
    const value = raw[spec.name]
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value === '') continue
    out[fid] = JSON_FIELDS.has(spec.name) ? JSON.stringify(value) : value
  }
  return out
}

function readField(
  fields: Record<string, unknown>,
  fieldIds: ReadonlyMap<string, string>,
  name: string,
): unknown {
  const fid = fieldIds.get(name)
  return fid ? fields[fid] : undefined
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function toRow(
  item: { id: string, fields: Record<string, unknown>, createdAt: string | null },
  fieldIds: ReadonlyMap<string, string>,
): ClosureRecordRow {
  const recordId = str(readField(item.fields, fieldIds, 'record_id'))
  return {
    // ⚠️ `record_id` 空的舊紀錄退回平台 item id —— 讓「基準線比對」（FR-034）
    //    不會因為某一列缺這個欄位就把它當成新出現的紀錄
    recordId: recordId || item.id,
    itemId: item.id,
    draftId: str(readField(item.fields, fieldIds, 'draft_id')),
    conversationId: str(readField(item.fields, fieldIds, 'conversation_id')),
    closedAt: str(readField(item.fields, fieldIds, 'closed_at')),
    category: str(readField(item.fields, fieldIds, 'category')),
    reviewedBy: str(readField(item.fields, fieldIds, 'reviewed_by')) || null,
    createdAt: item.createdAt,
  }
}

/**
 * 某個對話的全部結案紀錄，**依 `closed_at` 本地降冪**。
 *
 * ⚠️ 三件 MUST，全部因為平台的 `filter`／`sort` 被靜默忽略（契約 R1.6）：
 *   ① `q` 只是粗篩，MUST **本地逐字比對 `conversation_id`**；
 *   ② 排序 MUST **本地**做 —— 平台實際是依建立時間排，
 *      而建立順序**通常**等於 `closed_at` 順序，直到有人補登才分岔；
 *   ③ 筆數 MUST 由本地比對後的結果算，**MUST NOT** 用 `estimatedTotalHits`。
 *
 * @returns 全部符合的紀錄（不截斷）—— `overflowCount` 由呼叫端以 `length - 5` 算
 */
export async function listClosuresFor(
  client: ImbraceClient,
  boardId: string,
  conversationId: string,
): Promise<ClosureRecordRow[]> {
  const fieldIds = await fieldIdMap(client, boardId)
  const { hits } = await searchBoardItems(client, boardId, conversationId, 200)
  return hits
    .map(h => toRow(h, fieldIds))
    .filter(r => r.conversationId === conversationId)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
}

/**
 * 「面板開啟之後才出現的他人結案」（FR-034、契約 R3.10）。
 *
 * ⚠️ 抽成純函式是為了讓它**只有一份定義**：`commit.post.ts` 內聯三行的話，
 *    這條規則就沒有任何測試守得住，而它錯的方式是「多列或少列一則提示」——
 *    多列會讓客服以為自己蓋掉了同事的紀錄（實際上沒有），
 *    少列則讓他不知道同事剛結過案。兩種都不報錯。
 *
 * ⚠️ 面板開啟當下就存在的結案 MUST NOT 出現在結果裡 ——
 *    客服在候選清單上已經看過一次了，再提一次只會變成噪音。
 * ⚠️ **自己剛寫的那一筆也要排除** —— 否則每一次成功寫入都會提示「有人結案了」，
 *    而那個人就是自己。
 */
export function closuresSincePanelOpen(
  rows: readonly ClosureRecordRow[],
  baseline: readonly string[],
  ownRecordId: string,
): ClosureRecordRow[] {
  const seen = new Set(baseline)
  return rows.filter(r => !seen.has(r.recordId) && r.recordId !== ownRecordId)
}

/**
 * 冪等寫入（憲法 5.3、契約 R3.4／R3.5／R3.13）。
 *
 * ```
 * ① searchBoardItems(q: draftId)  →  **本地逐字比對 draft_id**
 * ② 0 筆 → createItem／1 筆 → updateItem／≥2 筆 → 更新最早建立的那筆 ＋ 警告
 * ③ getBoardItem 回查  →  找不到或 draft_id 不符 → 失敗（unverified）
 * ```
 *
 * ⚠️ **① 的本地比對 MUST NOT 省略**（契約 R3.13）：`q` 是全文檢索不是精確比對，
 *    少了它，「查有既有紀錄」會退化成「隨便抓一筆看起來像的」，
 *    接著 `updateItem` 會去改到**別人的結案紀錄** —— 不報錯，
 *    而且被改掉的是同事的工作成果。
 *
 * ⚠️ **比對的 MUST 是 `draft_id`，MUST NOT 是 `conversation_id`**：
 *    用後者會在「不同時間的多次服務」銷毀服務歷史，
 *    在「多位客服各自結案」洗掉同事的工作成果。同一通對話多筆並存是正常的。
 *
 * ⚠️ **③ 不可省。** 平台不保證唯一鍵約束（實測 5 個 board `uniqueSeen: 0`），
 *    200 不等於紀錄真的建立了 —— 而「畫面顯示成功、Board 上其實沒有」不會報錯。
 *    這是本規格最重要的一條測試（R3.5）。
 *
 * ⚠️ 逾時**不重試**：要不要重按由客服自己決定（他才知道 CRM 上到底有沒有）。
 */
export async function commitClosure(
  client: ImbraceClient,
  boardId: string,
  summary: ClosureSummary,
  opts: CommitOptions,
): Promise<{ recordId: string, created: boolean }> {
  const { reqId } = opts
  const log = opts.log ?? console
  const timeoutMs = opts.timeoutMs ?? CLOSURE_WRITE_TIMEOUT_MS

  /*
    ⚠️ 逾時以 `AbortSignal.timeout()` 驅動並用 `Promise.race()` 收斂。

    SDK 沒有暴露 `AbortSignal`（與 `withRetry()` 面對的是同一個限制），
    因此**已經在飛的那次 HTTP 呼叫取消不了** —— 這裡能保證的是
    「呼叫端在 timeoutMs 內一定會拿到答案」，而那正是 FR-040a 需要的那一半：
    客服不會被困在一個不會結束的 `writing` 狀態裡。
    ⚠️ 誠實地只做到能做的：MUST NOT 在註解或文案裡宣稱「已中止寫入」——
    平台那邊可能已經寫進去了，那正是 B8（`unverified`）存在的理由。
  */
  const deadline = AbortSignal.timeout(timeoutMs)
  const timeout = new Promise<never>((_, reject) => {
    deadline.addEventListener('abort', () => reject(
      new ClosureWriteError(`寫入逾時（${timeoutMs}ms）`, 'failed', 504, reqId),
    ), { once: true })
  })

  try {
    return await Promise.race([writeSteps(), timeout])
  }
  catch (err) {
    if (err instanceof ClosureWriteError) throw err
    // 平台 4xx／5xx 與任何其他失敗 —— 一律 `failed`（契約 §4 的對照表）
    log.warn(`[closure] req=${reqId} draft=${summary.draftId} 寫入失敗：${errText(err)}`)
    throw new ClosureWriteError(`寫入 Data Board 失敗：${errText(err)}`, 'failed', 502, reqId, err)
  }

  async function writeSteps(): Promise<{ recordId: string, created: boolean }> {
    const fieldIds = await fieldIdMap(client, boardId)

    // ── ① 查既有草稿紀錄 ────────────────────────────────────
    const { hits } = await searchBoardItems(client, boardId, summary.draftId, 50)
    // ⚠️ 本地逐字比對，見本函式說明。`q` 命中但 draft_id 不符的一律不算。
    const mine = hits
      .map(h => toRow(h, fieldIds))
      .filter(r => r.draftId === summary.draftId)
    log.info(`[closure] req=${reqId} step=search draft=${summary.draftId} `
      + `hits=${hits.length} matched=${mine.length}`)

    // ── ② 建立或更新 ────────────────────────────────────────
    let itemId: string
    let recordId: string
    let created: boolean
    if (mine.length === 0) {
      /*
        ⚠️ `recordId` 由我方產生，不是平台的 item id。

        兩者刻意分開：平台 item id 要等 `createItem()` 回來才知道，
        而「把它寫回 `record_id` 欄位」需要第四次呼叫 —— 那會打破契約 R3.4
        固定的三步，而三步固定正是這條路徑可被逐步稽核的原因。
        自己產一把 id 讓 `record_id` 在**建立當下**就有值，欄位不會是空的。
      */
      recordId = crypto.randomUUID()
      itemId = await createBoardItem(client, boardId, toFieldsById({ ...summary, recordId }, fieldIds))
      created = true
    }
    else {
      // ⚠️ ≥2 筆：取**最早建立**的那筆。取最新的話，同一份草稿的重試會在
      //    每次都命中不同的紀錄上打轉，而多出來的那些永遠沒人更新。
      const target = [...mine].sort(byCreatedAtAsc)[0]!
      if (mine.length >= 2) {
        log.warn(`[closure] req=${reqId} draft=${summary.draftId} `
          + `⚠️ 同一 draft_id 命中 ${mine.length} 筆，更新最早建立的 ${target.recordId}`)
      }
      itemId = target.itemId
      recordId = target.recordId
      created = false
      // ⚠️ FR-030c：更新為**當下**的草稿內容。⚠️ 平台的 update 是部分更新
      //    （006-E9），因此整份都要送 —— 只送有改的欄位會讓上一次的舊值留著。
      await updateBoardItem(client, boardId, itemId, toFieldsById({ ...summary, recordId }, fieldIds))
    }
    log.info(`[closure] req=${reqId} step=${created ? 'create' : 'update'} `
      + `draft=${summary.draftId} record=${recordId} item=${itemId}`)

    // ── ③ 回查 ──────────────────────────────────────────────
    const back = await getBoardItem(client, boardId, itemId)
    const backDraftId = back ? str(readField(back.fields, fieldIds, 'draft_id')) : ''
    const verified = !!back && backDraftId === summary.draftId
    log.info(`[closure] req=${reqId} step=verify draft=${summary.draftId} `
      + `record=${recordId} verified=${verified}`)

    if (!verified) {
      /*
        ⚠️ **回查不到 MUST 當作失敗**（契約 R3.5），MUST NOT 因為寫入回了 200 就報成功。

        `failKind: 'unverified'` 與其他三種刻意不同，因為客服該做的事不同：
        其餘三種可直接重試；這一種代表平台說寫成功了，MUST 先請客服到 CRM 查驗
        （畫布 B8 把這一步綁進主鈕文字：「已確認沒有，重試寫入」）。
      */
      throw new ClosureWriteError(
        back
          ? '寫入後回查到的紀錄 draft_id 不符，無法確認寫入結果'
          : '寫入後回查不到該筆紀錄，無法確認寫入結果',
        'unverified',
        502,
        reqId,
      )
    }

    return { recordId, created }
  }
}

function byCreatedAtAsc(a: ClosureRecordRow, b: ClosureRecordRow): number {
  return Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? '')
}

/** ⚠️ 只取訊息本身，不帶 stack、不帶請求 body —— 憑證與個資都可能在裡面（FR-035） */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
