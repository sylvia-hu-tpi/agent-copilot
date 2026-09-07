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
import type { ClosureScopeCandidate } from '../../../shared/types/copilot.js'
import { CLOSURE_SCAN_LIMIT } from '../../../shared/types/copilot.js'
import { fetchLatest } from '../../sources/message-fetch.js'
import type { ClosureRecordRow } from './board-repository.js'

/** 一頁的大小 —— 與 `DEFAULT_MESSAGE_LIMIT` 無關，這裡刻意取大一點以減少往返 */
const SCAN_PAGE_SIZE = 100

/** 候選清單最多列幾筆（FR-021b）。其餘的以 `overflowCount` 表達 */
export const CANDIDATE_LIMIT = 5

/**
 * ⚠️ **定義在 `shared/types/copilot.ts`，這裡只是本地別名。**
 *    這個形狀同時是 `POST /closure/scopes` 的回應內容與 store 讀的型別；
 *    在這裡自己再宣告一份的話，改欄位名不會有任何型別錯誤，
 *    UI 只會安靜地讀到 `undefined`。
 */
export type ScopeCandidate = ClosureScopeCandidate

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

/**
 * 把同一組分頁的結果記下來，讓多個掃描共用一趟往返。
 *
 * ⚠️ 這支存在的理由是 `scopes.post.ts` 要對**同一段歷史**跑兩種掃描：
 *    `oldestMessageAt()` 找最舊一則、`countByCandidate()` 算各候選的則數。
 *    兩者都從 `skip=0` 由新往舊翻同樣的頁，以前是各翻各的 ——
 *    面板開一次最多打 15 次串行分頁請求，其中 5 次是純重複。
 *
 * ⚠️ 快取以 `skip:limit` 為鍵，**只在同一次請求內有效**（呼叫端每次自己建一個）。
 *    跨請求共用會讓「面板開啟時看到的則數」凍結在第一次開啟的那一刻，
 *    而客服完全看不出畫面是舊的。
 */
export function cachedPageFetcher(inner: MessagePageFetcher): MessagePageFetcher {
  const cache = new Map<string, Promise<string[]>>()
  return (skip, limit) => {
    const key = `${skip}:${limit}`
    const hit = cache.get(key)
    if (hit) return hit
    // ⚠️ 存 Promise 而非結果 —— 存結果的話兩個併發的掃描會各送一次請求
    const p = inner(skip, limit)
    cache.set(key, p)
    return p
  }
}

/**
 * 這個對話最舊一則訊息的時間 —— `fallback`（「從第一則對話起算」）的起點，
 * 也是「自訂起算時間」彈窗的可選下界。
 *
 * ⚠️ 走 `skip` 分頁往回翻到底 —— 平台**不支援**「取最舊 N 則」，
 *    而 `fetchLatest()` 的 `limit` 是從最新算起（§6.4）。
 * ⚠️ 上限 `SCAN_MAX_PAGES` 頁；超過時取「掃得到的最舊那一則」：對長期客戶而言
 *    fallback 本來就會是 `truncated`（「超過 500 則」），起點稍晚不影響那個呈現。
 * ⚠️ 這個上限**刻意大於** `CLOSURE_SCAN_LIMIT`（則數掃描的上限）：則數只需要數到
 *    500 就能回報「數不完」，但 fallback 的**起點**要盡量真實 —— 兩者是不同的用途，
 *    以前的註解寫成「上限與掃描上限同源」是錯的（2026-09-08 訂正）。
 *
 * @returns 最舊一則的時間戳；對話完全沒有訊息時回 `null`
 */
export async function oldestMessageAt(fetchPage: MessagePageFetcher): Promise<string | null> {
  let oldest: string | null = null
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const chunk = await fetchPage(page * SCAN_PAGE_SIZE, SCAN_PAGE_SIZE)
    if (chunk.length === 0) break
    // `fetchPage` 回的是由舊到新，因此這一頁最舊的是第一筆
    oldest = chunk[0]!
    if (chunk.length < SCAN_PAGE_SIZE) break
  }
  return oldest
}

/** `oldestMessageAt()` 最多往回翻幾頁 —— 見該函式對「為何不與掃描上限同源」的說明 */
const SCAN_MAX_PAGES = 10

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
/** `fetchPeriodMessages()` 的結果 —— 訊息本身，以及它是否被掃描上限截斷 */
export interface PeriodMessages {
  /** 由舊到新（prompt 讀的是對話順序） */
  messages: Message[]
  /** `true` ＝ 收滿掃描上限、區間還有更早的沒讀到（則數 MUST 以 `null` 呈現） */
  truncated: boolean
}

export async function fetchPeriodMessages(
  client: ImbraceClient,
  conversationId: string,
  periodStart: string,
  opts: { scanLimit?: number, pageSize?: number } = {},
): Promise<PeriodMessages> {
  const scanLimit = opts.scanLimit ?? CLOSURE_SCAN_LIMIT
  const pageSize = opts.pageSize ?? SCAN_PAGE_SIZE
  const startMs = Date.parse(periodStart)

  const collected: Message[] = []
  /** 走到比 `periodStart` 更舊的訊息 ＝ 這個區間已經完整讀到 */
  let hitOlder = false
  /** 資料本身掃完了（最後一頁不滿） */
  let exhausted = false

  for (let skip = 0; collected.length < scanLimit; skip += pageSize) {
    const page = await fetchLatest(client, conversationId, { limit: pageSize, skip })
    if (page.length === 0) { exhausted = true; break }
    if (page.length < pageSize) exhausted = true

    // 由新到舊塞，收滿或走過起點就停
    for (let i = page.length - 1; i >= 0; i--) {
      const m = page[i]!
      const at = Date.parse(m.at)
      if (!Number.isNaN(startMs) && !Number.isNaN(at) && at < startMs) { hitOlder = true; break }
      collected.push(m)
      if (collected.length >= scanLimit) break
    }
    if (hitOlder || exhausted) break
  }

  /*
    ⚠️ 截斷判定與 `countByCandidate()` 用**同一組條件**：收滿上限，
       **而且**不是因為走過了區間起點（`hitOlder`）或資料掃完（`exhausted`）。

       只看 `collected.length >= scanLimit` 的話，「資料剛好掃完而則數又剛好達到上限」
       會被誤判成截斷 —— 那一筆的則數其實是精確的。反過來，硬寫 `truncated: false`
       （2026-09-04 之前的版本）則讓真的超過 500 則的區間回報「500 則、未截斷」，
       而 Board 的 `period_message_count` 逐字定義是「留空 ＝ 超過 500 則，數不完（不是 0）」
       —— 寫進去的 500 是個謊。

    ⚠️ `!hitOlder` 目前**是冗餘的**：內層先判 `at < startMs` 才 push、push 完才判收滿，
       因此撞到更舊的訊息時 `collected` 必然還沒滿。寫出來是為了讓這個判準與
       `countByCandidate()` 逐字對齊 —— 迴圈順序一改它就會真的生效。
  */
  return {
    messages: collected.reverse(),
    truncated: collected.length >= scanLimit && !hitOlder && !exhausted,
  }
}
