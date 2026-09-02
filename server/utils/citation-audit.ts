/**
 * 引用稽核事件 `suggestion.citation.audited` —— specs/005-m2-residual-defects US3
 * （FR-015／FR-015a、SC-005），欄位與六值 outcome 的正典是 contracts/citation-audit-event.md。
 *
 * ── 這個事件回答什麼 ─────────────────────────────────────────────
 * 建議卡標示「未引用知識庫」時，成因可能是：① 知識庫本次未命中、② 命中了但模型未引用、
 * ③ 命中了但引用被憲法 4.3 的白名單整卡捨棄（模型杜撰 sopId）、④ 命中了但模型未回任何卡、
 * ⑤ 命中了但第二段呼叫失敗。五者在畫面上與日誌上長得一模一樣，而處置完全不同。
 * 每一次引用結果**落定**時（含失敗）輸出一筆，由 `outcome` 即可判定屬於哪一種，不需重跑分析。
 *
 * ── 為什麼放在 `server/utils/`、不放進分析管線 ─────────────────────
 * ⚠️ 刻意的（research.md #15）。拆檔守衛禁止「管線外值 import 管線內部檔」；本模組若放進管線，
 *    FR-017 的量測腳本（`scripts/spike/27-citation-quality.ts`）就 import 不到它，唯一的繞法是從
 *    barrel re-export —— 那等於把稽核塞進分析管線的對外介面。管線內部檔 import 管線外的工具
 *    從來就是允許的，方向沒有問題。
 *
 * ── 落點（FR-015 第三點、FR-015a）──────────────────────────────────
 * **標準輸出是完整集合，無例外**：每一筆以一行 JSON（NDJSON）寫到 stdout。MUST NOT 以 log 級別
 * 分流讓 stdout 成為子集 —— 日後接任何只收 stdout 的集中式平台（Loki 等）才真的零改動
 * （SysTalk.Red 已踩在那個位置上並自陳是代價）。
 * 額外落點（`CITATION_AUDIT_FILE`，JSONL）只能是它的拷貝，預設**不啟用**。
 *
 * ⚠️ **要防的是「開檔」不是「寫入」**（FR-015a）。SysTalk.Red 2026-09-01 的 SIT 事故：log 目錄
 *    `mkdirSync` EACCES 發生在啟動最前段、早於任何 error handling，服務無限重啟 ——
 *    日誌落不了地，卻賠掉整個服務（憲法 3.1 的反例，兇手是日誌自己）。因此建目錄／開檔
 *    一律惰性（第一筆事件時才做）並包在 try/catch，失敗降級為只寫 stdout，
 *    並在 stderr 留**一行**可辨識的原因 —— 少了那一行，症狀只剩「檔案是空的」。
 * ⚠️ 路徑 MUST 是絕對路徑：dev 的 cwd 可寫會讓相對路徑的坑在開發期完全隱形，
 *    容器的 WORKDIR 屬 root 卻跑非 root、bind mount 會遮蔽映像裡的 chown，到容器裡才炸。
 *
 * ── PII（憲法 1.5）────────────────────────────────────────────────
 * `text`／`title`／`snippet` 在型別上標成 `never`：「順手記進去」在 `npm run typecheck` 就過不了。
 * ⚠️ **`invalidSopIds` 不是 PII，MUST 保留**：它是模型憑空造出來的識別碼字串，不是客戶內容，
 *    而它正是 FR-017 歸因分析的原料（要判斷杜撰的形狀是「造一個像 id 的字串」還是「填成標題」）。
 * ⚠️ 但型別守擋不到這個欄位（`string[]`，內容由模型自由生成）——上面那句是對已觀測形狀的歸納，
 *    不是保證。模型哪天把整段客訴塞進 `sopId`，這個欄位就會把客戶內容原樣寫進 stdout。
 *    因此另有一道**機械式**收斂：> 64 字元者改記 `sha256:<前16碼>+<原長度>`（真實 id 與像 id 的
 *    杜撰字串都遠短於 64、原樣保留；長段客戶內容必然超過而被擋）。MUST NOT 簡化成「一律雜湊」——
 *    那會殺掉 SC-006 判斷杜撰形狀的原料。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

export const CITATION_AUDIT_EVENT = 'suggestion.citation.audited' as const

/** contracts/citation-audit-event.md §2 —— SC-005 的五種成因由它分辨 */
export type CitationOutcome = 'cited' | 'no-hits' | 'not-cited' | 'discarded' | 'no-cards' | 'failed'

export interface CitationAuditEvent {
  event: typeof CITATION_AUDIT_EVENT
  /** 落定時刻，ISO 8601 */
  at: string
  conversationId: string
  /** 這一批的錨點（`basedOnMessageId`），逐對話歸因用 */
  anchor: string | null
  /** 落定來自第一段或第二段；單段（背景、命中已在手）記 1 */
  stage: 1 | 2
  /** 本次知識庫命中數 */
  hitCount: number
  /** 模型回傳的卡片數（Zod 驗證後、白名單前）。呼叫失敗時記 0 */
  cardsReturned: number
  /** 白名單後保留數 */
  cardsKept: number
  /** 被判定為不在命中集合的識別碼字串本身，逐筆施加長度收斂 */
  invalidSopIds: string[]
  outcome: CitationOutcome
  /** ⚠️ 這三個欄位刻意標成 never —— 讓「順手記進去」在 typecheck 就過不了（憲法 1.5） */
  text?: never
  title?: never
  snippet?: never
}

export interface CitationAuditInput {
  conversationId: string
  anchor: string | null
  stage: 1 | 2
  hitCount: number
  cardsReturned: number
  cardsKept: number
  /** 保留下來的卡裡帶 `sopId` 的張數 —— 分辨 `cited` 與 `not-cited` */
  citedKept: number
  invalidSopIds: string[]
  /** 第二段（或單段）呼叫失敗：重試用盡／逾時／平台回錯 */
  failed?: boolean
}

/** 長度收斂的界（見檔頭）。真實 `sopId` 與像 id 的杜撰字串都遠短於它 */
export const INVALID_SOP_ID_MAX_LENGTH = 64

/** > 64 字元改記 `sha256:<前16碼>+<原長度>`：仍能判斷「同一個超長字串是否重複出現」，但內容不外流 */
export function collapseSopId(id: string): string {
  if (id.length <= INVALID_SOP_ID_MAX_LENGTH) return id
  return `sha256:${createHash('sha256').update(id).digest('hex').slice(0, 16)}+${id.length}`
}

/**
 * 六值判定（contracts §2）。順序：`hitCount === 0` 一律 `no-hits`（沒有命中就沒有引用可談，
 * 包含失敗與回空）→ `failed` → `no-cards` → `discarded` → `cited`／`not-cited`。
 */
export function deriveCitationOutcome(input: Pick<CitationAuditInput, 'hitCount' | 'cardsReturned' | 'cardsKept' | 'citedKept' | 'failed'>): CitationOutcome {
  if (input.hitCount === 0) return 'no-hits'
  if (input.failed) return 'failed'
  if (input.cardsReturned === 0) return 'no-cards'
  if (input.cardsKept === 0) return 'discarded'
  return input.citedKept > 0 ? 'cited' : 'not-cited'
}

export function buildCitationAudit(input: CitationAuditInput): CitationAuditEvent {
  return {
    event: CITATION_AUDIT_EVENT,
    at: new Date().toISOString(),
    conversationId: input.conversationId,
    anchor: input.anchor,
    stage: input.stage,
    hitCount: input.hitCount,
    cardsReturned: input.cardsReturned,
    cardsKept: input.cardsKept,
    invalidSopIds: input.invalidSopIds.map(collapseSopId),
    outcome: deriveCitationOutcome(input),
  }
}

/** 一行 NDJSON → 事件；不是本事件（或壞掉的一行）回 `null`。量測腳本與集中式平台都用這個形狀 */
export function parseCitationAuditLine(line: string): CitationAuditEvent | null {
  try {
    const parsed = JSON.parse(line) as Partial<CitationAuditEvent> | null
    if (!parsed || parsed.event !== CITATION_AUDIT_EVENT) return null
    return parsed as CitationAuditEvent
  }
  catch {
    return null
  }
}

// ── 落點 ────────────────────────────────────────────────────────────

type Listener = (event: CitationAuditEvent) => void

interface Sink {
  /** 讀過設定了沒（惰性：第一筆事件才讀 env、才開檔） */
  resolved: boolean
  fd: number | null
  /** 已經在 stderr 留過那一行 —— 只留一行，不要每筆都吼 */
  warned: boolean
}

interface AuditOverrides {
  /** 測試用：取代 `process.env.CITATION_AUDIT_FILE`（`null`＝明確停用） */
  file?: string | null
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

const sink: Sink = { resolved: false, fd: null, warned: false }
let overrides: AuditOverrides = {}
const listeners = new Set<Listener>()

function warnOnce(reason: string): void {
  if (sink.warned) return
  sink.warned = true
  const write = overrides.stderr ?? ((line: string) => process.stderr.write(line))
  // ⚠️ 只有一行、不含路徑以外的任何內容 —— 這一行的用途是分辨「沒開起來」與「沒有東西可寫」
  write(`[citation-audit] 額外落點停用，僅寫標準輸出：${reason}\n`)
}

/** 第一筆事件時才建目錄／開檔；失敗只降級（FR-015a），MUST NOT 拋出 */
function resolveSink(): void {
  if (sink.resolved) return
  sink.resolved = true

  const file = overrides.file !== undefined ? overrides.file : (process.env.CITATION_AUDIT_FILE || null)
  if (!file) return

  if (!isAbsolute(file)) {
    warnOnce(`CITATION_AUDIT_FILE MUST 是絕對路徑（收到 ${JSON.stringify(file)}）`)
    return
  }

  try {
    mkdirSync(dirname(file), { recursive: true })
    sink.fd = openSync(file, 'a')
  }
  catch (err) {
    sink.fd = null
    warnOnce(`開檔失敗 ${file}（${err instanceof Error ? err.message : String(err)}）`)
  }
}

/**
 * 發出一筆事件：stdout（完整集合）→ 額外落點（拷貝）→ 行程內訂閱者（量測腳本、測試）。
 * ⚠️ 任何一段失敗都 MUST NOT 影響呼叫端（憲法 3.2）——稽核不得阻斷分析路徑。
 */
export function emitCitationAudit(input: CitationAuditInput): CitationAuditEvent {
  const event = buildCitationAudit(input)
  const line = `${JSON.stringify(event)}\n`

  try {
    (overrides.stdout ?? ((l: string) => { process.stdout.write(l) }))(line)
  }
  catch {
    // stdout 都寫不了，這裡沒有更好的去處；不得為此中斷分析
  }

  resolveSink()
  if (sink.fd !== null) {
    try {
      writeSync(sink.fd, line)
    }
    catch (err) {
      // 寫入失敗（磁碟滿、檔案被搬走）：降級同開檔失敗，之後不再嘗試
      sink.fd = null
      warnOnce(`寫入失敗（${err instanceof Error ? err.message : String(err)}）`)
    }
  }

  for (const listener of [...listeners]) {
    try {
      listener(event)
    }
    catch {
      // 訂閱者爆掉不得影響其他訂閱者與分析本身
    }
  }
  return event
}

/** 行程內訂閱（`scripts/spike/27-citation-quality.ts` 與測試用）—— 與 stdout 是同一份資料 */
export function onCitationAudit(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 測試用：覆寫落點與輸出，並重置惰性開檔的狀態 */
export function configureCitationAuditForTests(next: AuditOverrides): void {
  overrides = next
  sink.resolved = false
  sink.fd = null
  sink.warned = false
}

export function resetCitationAuditForTests(): void {
  configureCitationAuditForTests({})
  listeners.clear()
}
