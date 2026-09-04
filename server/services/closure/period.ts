/**
 * 涵蓋區間的候選推導、則數掃描與快照取數
 * （specs/006-closure-handoff-summary FR-021 系列、契約 R1.1～R1.6）。
 *
 * ⚠️⚠️ **本檔 MUST NOT 出現 `filter:` 或 `sort:`**（契約守衛 G4 會掃）。
 *      2026-09-03 實測：`boards.search()` 的兩個參數**都被平台靜默忽略** ——
 *      `filter` 回整批不報錯；`sort` 拿一個不存在的欄位去排會得到完全相同的順序
 *      （決定性證據），實際是依建立時間排。過濾與排序一律 `q` 粗篩後**本地**做。
 *      ⚠️ `sort` 那條特別危險：結案紀錄的建立順序**通常**等於 `closed_at` 順序，
 *      要到有人補登或時鐘不同步才分岔 —— 屆時客服拿到排錯的候選，畫面上看不出來。
 *
 * ⚠️ **則數掃描只跑一趟。** 每個候選各掃一次的話，五個候選就是五趟全歷史分頁 ——
 *    §6.4 明文要求沿用既有的 `skip` 分頁（平台不支援增量），一趟已經夠貴了。
 *    由新到舊掃到「最舊的候選起點」或 500 則上限為止，一趟算完所有候選。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import type { Message } from '../../../shared/types/conversation.js'
import type { ClosurePeriodOrigin } from '../../../shared/types/copilot.js'
import { CLOSURE_SCAN_LIMIT } from '../../../shared/types/copilot.js'
import { fetchLatest } from '../../sources/message-fetch.js'
import type { ClosureRecordRow } from './board-repository.js'

/** 一頁的大小 —— 與 `DEFAULT_MESSAGE_LIMIT` 無關，這裡刻意取大一點以減少往返 */
const SCAN_PAGE_SIZE = 100

/** 候選清單最多列幾筆（FR-021b）。其餘的以 `overflowCount` 表達 */
export const CANDIDATE_LIMIT = 5

export interface ScopeCandidate {
  start: string
  origin: ClosurePeriodOrigin
  messageCount: number | null
  truncated: boolean
  /** 只有 `origin === 'closure'` 的候選有 —— 讓客服認得出「那一次是誰結的、結成什麼」 */
  label?: { category: string, reviewedByName: string, closedAt: string }
}

export interface CandidateSet {
  candidates: ScopeCandidate[]
  /** 「從第一則對話起算」—— **永遠存在、永遠墊底**，是安全網 */
  fallback: ScopeCandidate
  /** 未列出的更早結案筆數；0 代表沒有 */
  overflowCount: number
}

/**
 * 由結案紀錄推導候選清單。
 *
 * ⚠️ `fallback` 是**獨立欄位**而不是 `candidates` 的最後一筆（契約 R1.1）——
 *    分開才不會有「排序寫錯就把安全網排到中間」的可能。
 * ⚠️ `overflowCount` MUST 由本地比對後的筆數算出，**MUST NOT** 用
 *    `estimatedTotalHits`（那是 `q` 的命中數，不是該對話的結案紀錄數）。
 *
 * @param closures 已由 `listClosuresFor()` 依 `closed_at` **本地**降冪排好的全部紀錄
 * @param firstMessageAt 這個對話第一則訊息的時間 —— `fallback` 的起點與自訂起算的下界
 * @param resolveName `reviewed_by` → 顯示名（`server/services/directory.ts`）
 */
export function buildCandidates(
  closures: readonly ClosureRecordRow[],
  firstMessageAt: string,
  resolveName: (operatorId: string | null) => string,
): CandidateSet {
  const candidates: ScopeCandidate[] = closures.slice(0, CANDIDATE_LIMIT).map(c => ({
    start: c.closedAt,
    origin: 'closure' as const,
    messageCount: null,
    truncated: false,
    label: {
      category: c.category,
      reviewedByName: resolveName(c.reviewedBy),
      closedAt: c.closedAt,
    },
  }))

  return {
    candidates,
    fallback: { start: firstMessageAt, origin: 'first', messageCount: null, truncated: false },
    overflowCount: Math.max(0, closures.length - CANDIDATE_LIMIT),
  }
}

/**
 * 取一頁訊息的時間戳（由新到舊的第 `skip` 筆起算 `limit` 筆）。
 *
 * ⚠️ 抽成介面是為了讓 `test/closure-scope-selection.test.ts` 用記憶體 fixture 驗
 *    四個代表情境 —— 那四個情境要的是「候選推導與則數計算對不對」，
 *    不是「HTTP 通不通」。真實 client 的版本見 `messagePageFetcher()`。
 */
export type MessagePageFetcher = (skip: number, limit: number) => Promise<string[]>

export function messagePageFetcher(
  client: ImbraceClient,
  conversationId: string,
): MessagePageFetcher {
  return async (skip, limit) => {
    // `fetchLatest()` 回的是**由舊到新**（它已經反轉過），這裡只要時間戳
    const page = await fetchLatest(client, conversationId, { limit, skip })
    return page.map(m => m.at)
  }
}

export interface CountResult {
  messageCount: number | null
  truncated: boolean
}

/**
 * **一趟**掃描算出所有起點的則數。
 *
 * ⚠️ 則數的三種值 MUST 可區分（data-model §1）：
 *      `0`／`false`     → 這個候選之後真的沒有新訊息 → 該列**不可選**
 *      `n > 0`／`false` → 確切則數
 *      `null`／`true`   → 超過 500 則的掃描上限，數不完 → 「超過 500 則」，**仍可選**
 *    ⚠️ **`null` MUST NOT 序列化成 `0`**（契約 R1.3）—— 0 則的候選不可選，
 *    數不完的候選則是**可選且通常是客服真正要的那一個**（長期客戶的「從第一則起算」）。
 *    兩者混淆會讓長期客戶完全結不了案，而畫面上只會顯示一個灰掉的選項。
 *
 * ⚠️ 判定用 `>=` 而非 `>`：涵蓋區間的語意是「這個時點**之後的第一則**訊息起」，
 *    而 `fallback` 的起點正是第一則訊息自己的時間戳 —— 用 `>` 會讓
 *    「從第一則對話起算」少算掉第一則，而那個 off-by-one 不會有任何錯誤訊息。
 *
 * @param starts 要計算的起點（候選 ＋ fallback），順序不拘
 * @returns 與 `starts` 等長、順序相同
 */
export async function countByCandidate(
  fetchPage: MessagePageFetcher,
  starts: readonly string[],
  opts: { scanLimit?: number, pageSize?: number } = {},
): Promise<CountResult[]> {
  const scanLimit = opts.scanLimit ?? CLOSURE_SCAN_LIMIT
  const pageSize = opts.pageSize ?? SCAN_PAGE_SIZE
  if (starts.length === 0) return []

  const startMs = starts.map(s => Date.parse(s))
  const oldestNeeded = Math.min(...startMs.filter(n => !Number.isNaN(n)))

  const counts = starts.map(() => 0)
  let scanned = 0
  /** 實際掃到的**最舊**一則的時間 —— 截斷判定唯一的依據 */
  let oldestScannedMs = Number.POSITIVE_INFINITY
  let reachedOldest = false
  let exhausted = false

  for (let skip = 0; scanned < scanLimit && !reachedOldest && !exhausted; skip += pageSize) {
    const page = await fetchPage(skip, pageSize)
    if (page.length === 0) { exhausted = true; break }
    if (page.length < pageSize) exhausted = true

    // `fetchPage` 回的是由舊到新；由新到舊走才知道什麼時候可以停
    for (let i = page.length - 1; i >= 0; i--) {
      const at = Date.parse(page[i]!)
      if (Number.isNaN(at)) continue

      // 已經比所有候選都舊 → 再往前掃也不會增加任何候選的計數，停
      if (at < oldestNeeded) { reachedOldest = true; break }

      scanned++
      oldestScannedMs = Math.min(oldestScannedMs, at)
      for (let c = 0; c < startMs.length; c++) {
        if (!Number.isNaN(startMs[c]!) && at >= startMs[c]!) counts[c]!++
      }
      if (scanned >= scanLimit) break
    }
  }

  /*
    ⚠️ 截斷判定是**逐個候選**的，不是整批的。

    掃了 500 則就把全部候選標成「數不完」的話，最上面那個
    「上一次結案之後只有 3 則」也會變成「超過 500 則」—— 而那一列
    本來是客服最可能選的，畫面上會從一個確切數字變成一句模糊的話。

    判準：掃描確實是被上限中止的（不是資料掃完、也不是已經掃過所有候選的起點），
    **且**這個候選的起點比我們實際掃到的最舊一則還舊 —— 那才代表它的區間
    有一段沒被走到，計數不完整。起點比最舊一則新的候選，則數是精確的。
  */
  const stoppedByLimit = scanned >= scanLimit && !reachedOldest && !exhausted
  return starts.map((_, i) => {
    const incomplete = stoppedByLimit
      && !Number.isNaN(startMs[i]!)
      && startMs[i]! < oldestScannedMs
    return incomplete
      ? { messageCount: null, truncated: true }
      : { messageCount: counts[i]!, truncated: false }
  })
}

/**
 * 預設選中的候選索引（契約 R1.2、FR-021d）。
 *
 * ⚠️ **MUST NOT 單純回 `0`。** 最上面那個候選常常是「上一次結案之後 0 則」
 *    （剛結完案又被按了一次），預設選它會產出一份空摘要 ——
 *    而空摘要寫進 CRM 不會報錯。
 * ⚠️ `messageCount === null`（數不完）**算有訊息** —— 它代表「超過 500 則」，
 *    不是「沒有」。把 null 判成 0 會讓長期客戶的候選全部被跳過。
 *
 * @returns 最上面 `messageCount > 0` 的索引；全部為 0 時回 `-1`（落到 `fallback`）
 */
export function defaultIndex(candidates: readonly ScopeCandidate[]): number {
  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i]!.messageCount
    if (n === null || n > 0) return i
  }
  return -1
}

/**
 * 取「`periodStart` 起」的全部訊息作為**本次請求內的快照**（契約 R2.1、FR-020）。
 *
 * ⚠️ `closure`／`first`／`custom` 三種 origin **共用這一條路徑**（research #12）。
 *    為每種 origin 各寫一條取數，等於讓「快照」有三個定義，
 *    而其中一條寫成「取最新」不會有任何型別錯誤（契約守衛 G1 掃的正是這件事）。
 *
 * ⚠️ 上限同樣是 500 則。超過時取**最新的 500 則**（區間的尾端），
 *    不是最舊的 500 則 —— 結案報告談的是這段服務怎麼收尾的。
 */
export async function fetchPeriodMessages(
  client: ImbraceClient,
  conversationId: string,
  periodStart: string,
  opts: { scanLimit?: number, pageSize?: number } = {},
): Promise<Message[]> {
  const scanLimit = opts.scanLimit ?? CLOSURE_SCAN_LIMIT
  const pageSize = opts.pageSize ?? SCAN_PAGE_SIZE
  const startMs = Date.parse(periodStart)

  const collected: Message[] = []
  for (let skip = 0; collected.length < scanLimit; skip += pageSize) {
    const page = await fetchLatest(client, conversationId, { limit: pageSize, skip })
    if (page.length === 0) break

    let hitOlder = false
    // 由新到舊塞，收滿或走過起點就停
    for (let i = page.length - 1; i >= 0; i--) {
      const m = page[i]!
      const at = Date.parse(m.at)
      if (!Number.isNaN(startMs) && !Number.isNaN(at) && at < startMs) { hitOlder = true; break }
      collected.push(m)
      if (collected.length >= scanLimit) break
    }
    if (hitOlder || page.length < pageSize) break
  }

  // 收集時是由新到舊，交給 AI 前反轉回由舊到新 —— prompt 讀的是對話順序
  return collected.reverse()
}
