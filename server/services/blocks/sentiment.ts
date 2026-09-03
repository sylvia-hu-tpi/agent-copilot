/**
 * @analysis-pipeline （管線成員標記，MUST NOT 刪 —— 理由見 `copilot-analysis.ts` 檔頭）
 *
 * 情緒 sparkline —— specs/001-sentiment-panel、specs/005-m2-residual-defects US2。
 *
 * 三個區塊裡唯一需要「把一次分析切成多批、有上限地並行、再把結果併回同一條時間軸」的一個：
 * 批次大小與並行度兩個常數、有上限的並行 map、時間軸的合併與統計、走勢敘述的第二次呼叫，
 * 以及恢復後的缺口補算。這些與摘要／建議卡完全無關，因此整段獨立成檔（拆檔第三刀）。
 *
 * ⚠️ **本檔沒有自己的模組層 `Map`／`Set`。** 拆檔的切線依據是「誰擁有哪一份執行期狀態」，
 *    而情緒的狀態全部落在 `CopilotAnalysisState.sentimentBlock`（經 `analysis-state.ts` 讀寫），
 *    唯一的模組層可變值是 `resolveHistory` —— 那是一個**函式變數**（裝配點），不是狀態容器。
 *    因此 `test/contract-guards.test.ts` 的 `OWNERSHIP` 表**不需要**為本檔新增一格；
 *    那張表推導自「模組層 `Map`／`Set`」，本檔一份都沒有。
 *
 * ⚠️ **`resolveHistory` 由 `copilot-runtime.ts` 在載入時注入**（`setHistoryResolver()`）。
 *    管線 MUST NOT import `copilot-runtime.ts`，理由見 `copilot-analysis.ts` 檔頭；
 *    裝配那一行被刪掉時 US2 會靜默失效，由 `test/contract-guards.test.ts` 掃描守住。
 *
 * ⚠️ **日誌前綴刻意維持 `[copilot-analysis]`，MUST NOT 改成 `[sentiment]`。**
 *    拆檔的驗收是「行為一個字都沒變」，而日誌字串是可觀測行為的一部分 ——
 *    改了它，既有的 log 樣式比對與任何靠前綴 grep 的排查流程都會安靜地失準。
 *    要改的話是另一個獨立的決定，不該混在搬家的 diff 裡。
 */

import type { Message } from '../../../shared/types/conversation.js'
import type {
  SentimentMarker,
  SentimentPoint,
  SentimentTimelineEntry,
} from '../../../shared/types/copilot.js'
import { useStateStore } from '../../state/index.js'
import type { CopilotAnalysisState } from '../../state/types.js'
import { useAIProvider } from '../ai/index.js'
import { withRetry } from '../ai/retry-policy.js'
import { parseSentimentNarrative, parseSentimentPoints } from '../ai/schemas.js'
import { runBlockDeduped } from '../analysis-dedupe.js'
import {
  batchAnchor,
  beginAnalyzing,
  clearFailedBatch,
  finishBlockError,
  isAttachmentOnlyCustomerMessage,
  isBatchAlreadyFailed,
  isTextCustomerMessage,
  nowIso,
  publishBlock,
  publishRetrying,
  updateAnalysisState,
} from '../analysis-state.js'

/**
 * ⚠️ **2026-08-27 實測發現**：情緒分析是「一次呼叫評完全部客戶發言」，延遲隨訊息則數
 * 線性增加——真實對話 16 則客戶發言，單次呼叫實測 12.7～29.9 秒，遠超 FR-014 的 15 秒
 * 單次逾時門檻（該門檻是依「回一句話」的通用 AI 呼叫延遲訂的，中位數 5 秒、最慢 12.2 秒，
 * 見 docs/PLATFORM_CAPABILITY.md，不是為「輸出量隨輸入線性增加」的任務設計）。
 * 對話可長達 398 則（docs/ARCHITECTURE.md §9.3 實測上限），沒有固定逾時秒數能安全涵蓋
 * 所有長度，因此改為**切成固定則數的小批，各自獨立套用 FR-014 的
 * 15 秒逾時／1s→4s 退避／40 秒預算**——不改動 FR-014 本身的任何數字，只是把「一次分析」
 * 的計算單位從「這個區塊要處理的全部訊息」改成「這一小批訊息」，讓每次呼叫的工作量
 * 回到 FR-014 原本設計時假設的量級。
 *
 * 代價：對很長的對話，退回一次手動重試（`retryBlock()`）會重新處理**全部**批次，
 * 不會只補上失敗的那幾批——若某一批持續失敗，之前已成功的批次也會跟著重算一次。
 * 這是刻意的簡化：分批間的部分進度目前不落地保存，避免另外設計「這個區塊分析到
 * 第幾批」的狀態，換取實作與 FR-014 既有狀態機（analyzing/retrying/error 三態）
 * 完全相容，不需要新增第四種「部分完成」狀態。
 *
 * ⚠️ **批次大小抓 6，不是保證值，是機率賭注**：實測發現延遲不是單純隨則數線性增加，
 * 平台本身有明顯波動——4 則批次 3 次都在 8.5～9.7 秒，6 則批次量到 10.0～**18.6 秒**
 * （超過 15 秒門檻），8 則批次曾連續三次嘗試全部逾時。批次切得越小，單次逾時機率越低，
 * 但長對話需要的批次數越多、總耗時越長；沒有一個數字能保證「絕對不逾時」，這是安全
 * 邊際與總時間的取捨，6 是使用者接受「偶爾需要手動重試」後選定的中間值。
 */
/**
 * ⚠️ 對外 export 只為了讓量測腳本（`scripts/spike/21-progressive-citations.ts`）算得出
 *    「這段對話會切成幾批」——001 SC-005 的判讀完全取決於這個分母，而抄一份常數過去
 *    正是本專案吃過虧的失敗模式（見 spike 18 檔頭「量測工具比正式路徑寬鬆會漏掉真的缺陷」）。
 *    **MUST NOT 有任何生產路徑改從外部覆寫它。**
 */
export const SENTIMENT_CHUNK_SIZE = 6

/**
 * `SENTIMENT_CONCURRENCY` 的預設值 —— 2026-09-01 使用者裁定的 3；`test/sentiment-concurrency.test.ts`
 * 斷言未設 env 時就是它。⚠️ MUST 宣告在下面的 `SENTIMENT_CONCURRENCY` 之前（模組載入時就會用到）。
 *
 * ⚠️ **2026-09-03 由 FR-018 的正式掃描複核後維持 3（使用者裁決）** —— 3／4／5 每檔位 n=45：
 * 檔位 4 與 5 在**總時間與單次失敗率兩列上同時比 3 差**（總時間 91% → 84%／82%，
 * 破 15 秒率 3.8% → 6.4%／10.6%），連 FR-019 的第一個條件都沒過。
 * 成因之一是 `withRetry()` 逾時不取消已送出的呼叫（`ai/retry-policy.ts`），
 * 實際負載 ＝ 設定值 ＋ 尚未落地的放棄呼叫，於是檔位越高越自我增強。
 * **這是被量過並經裁決的數字，不是沒人動過的預設值；要調高 MUST 先跑同口徑掃描**
 * （`npm run spike:sentiment-concurrency`，數據見 `docs/ARCHITECTURE.md` §8.2b）。
 */
export const DEFAULT_SENTIMENT_CONCURRENCY = 3

/**
 * 同時最多幾批在飛（2026-09-01 使用者裁定，取代原本的「依序送出」）。
 *
 * **為什麼改**：2026-09-01 的端到端實測（`npm run spike:progressive -- --repeat 3`，n=15）
 * 量到情緒區塊的總延遲 **≈ 批次數 × 5.5～6.4 秒**，每批的中位數幾乎是常數。依序送出時
 * 1 批的對話 6/6 落在 001 SC-005 的 10 秒內，3 批（17 則客戶發言）0/6、5 批（25 則）0/3。
 * 也就是說 SC-005 在依序架構下**只在客戶發言 ≤ 6 則時成立** —— 這不是模型抖動，
 * 是結構性的，任何固定秒數的門檻都只是在賭對話有多長（冷啟動一次可吃到 50 則，§11.8 ①）。
 *
 * **為什麼是 3，不是無上限**：原本「刻意不平行送出」的理由是「避免對話很長時一次對同一個
 * agent 開幾十條並發請求」——那個顧慮**沒有被推翻**，只是把 1 改成 3。398 則的對話
 * （§9.3 實測上限）依序要 67 批、無上限則是 67 條並發，兩者都不可接受；上限 3 讓
 * 並發數與對話長度脫鉤。
 *
 * ⚠️ **這個改動的風險是靜默的，MUST 以實測把關**：並發可能讓平台側排隊而抬高**單次**
 *    延遲，一旦單次超過 FR-014 的 15 秒就會觸發重試，重試用盡則整批轉 error。
 *    也就是「總時間變短」與「失敗率上升」可能同時發生，而畫面上只會看到偶發紅字。
 *    調高這個數字前 MUST 重跑 `spike:progressive` 並同時看**單次延遲**與**失敗率**，
 *    不能只看總時間變快就加碼。
 *
 * ── 為什麼開放 env 覆寫（specs/005-m2-residual-defects US4，research.md #19）──────
 * **這道門只為 `spike:sentiment-concurrency` 而開，生產設定 MUST NOT 設定它。**
 * FR-018 要求對 3／4／5 三個檔位各跑 n=45，而這是 module-level `const`，**同一行程內無法切換**，
 * 掃描必須換行程，換行程只能靠 env 傳遞。兩個被否決的替代：「讓量測腳本自己複製一份並行邏輯」
 * 違反本專案吃過虧的「量測工具比正式路徑寬鬆會漏掉真的缺陷」；「改成每次呼叫時讀的可變值」
 * 才是真的在生產路徑上開旋鈕。折衷是只在**模組載入時**讀一次，並由 `test/contract-guards.test.ts`
 * 守住 `.env.example`／`nuxt.config.ts`／`package.json` 的 scripts 不得設定它。
 * ⚠️ 它一旦被抄進某個環境的設定（例如本機的 `.env.local`，守衛看不到那裡），症狀是
 *    「那個環境的情緒延遲莫名其妙不一樣」，沒有任何錯誤。
 * ⚠️ `SENTIMENT_CHUNK_SIZE` **不比照辦理**：它決定的是「一次呼叫的工作量」，那是 FR-014 逾時數字
 *    的前提，不是量測的自變數。
 */
export const SENTIMENT_CONCURRENCY = resolveSentimentConcurrency(process.env.SENTIMENT_CONCURRENCY)

/**
 * 把 env 字串解析成並行度：MUST 是正整數，否則回退預設值並在 stderr 留一行。
 *
 * ⚠️ 不能寫成 `Number(process.env.X ?? 3)`：`Number('')` 是 `0`、`Number('abc')` 是 `NaN`，
 *    交給 `mapWithConcurrency()` 會變成零並行或永遠不完成 —— 正是本規格要防的那一類靜默錯誤。
 *    匯出是為了讓測試對這個判斷本身驗（`SENTIMENT_CONCURRENCY` 在模組載入時就綁定了，測試改不了 env）。
 */
export function resolveSentimentConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SENTIMENT_CONCURRENCY
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`[copilot-analysis] SENTIMENT_CONCURRENCY=${JSON.stringify(raw)} 不是正整數，改用預設 ${DEFAULT_SENTIMENT_CONCURRENCY}\n`)
    return DEFAULT_SENTIMENT_CONCURRENCY
  }
  return n
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 有上限的並行 map —— 回傳值**依輸入順序**排列，與完成順序無關。
 *
 * ⚠️ **第一個失敗就停止派工**：已在飛的那幾條會跑完（沒有辦法取消，`withRetry()` 不吃
 *    AbortSignal），但佇列裡還沒開始的不會再送出。這保住了依序版本「某一批失敗就不再
 *    浪費後續呼叫」的成本性質 —— 少了這一段，一段 9 批的長對話在第 1 批就失敗時，
 *    仍會把剩下 8 批全部打出去，那是 003 FR-006 一路在防的呼叫量浪費。
 *
 * ⚠️ 結果依 index 落位而非 `push`，因此**輸出順序是決定性的**。情緒的下游
 *    （`finishSentimentSuccess()`）雖然會自己 `sortByAt()`，但讓這支函式的契約與
 *    排程時序無關，測試才驗得住。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  // ⚠️ 用陣列而不是 `let firstError: … | null`：後者在 worker 閉包裡賦值之後，
  //    TS 會把函式尾端的 `firstError` 收斂成 `never`（跨閉包的賦值不進入控制流分析）。
  const errors: unknown[] = []
  let next = 0

  const worker = async (): Promise<void> => {
    while (errors.length === 0) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i]!)
      }
      catch (err) {
        // 只留第一個錯誤：後續 worker 看到它就不再取新工作，行為與依序版本的早退一致
        if (errors.length === 0) errors.push(err)
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  if (errors.length > 0) throw errors[0]
  return results
}

// ── 歷史來源（specs/005-m2-residual-defects US2，research.md #10）─────────────────

/**
 * 「從這個錨點之後的歷史」的解析器 —— 恢復補算要撈缺口用。形狀完全比照
 * `copilot-analysis.ts` 的 `setJoinedResolver()`：管線 MUST NOT import `copilot-runtime.ts`
 * （理由見 `copilot-analysis.ts` 的 `JoinedResolver` 那一段），由它在載入時把
 * `messageSource.fetchSince` 注入進來。
 * 錨點語意沿用 `fetchSince()` 的約定：找不到（已被擠出最近 50 則視窗）或為 `null` 時
 * **回傳整批**，由呼叫端自行去重（`newCustomerMessagesSince()` 對整條 timeline 做差集）。
 *
 * ⚠️ 預設回空陣列＝「視為無缺口」（安全的無作用值，純單元測試不載入 runtime）。
 *    這也代表裝配那一行漏掉時 US2 會**靜默失效**（缺口永遠補不到、旗標卻被清掉），
 *    因此 `test/contract-guards.test.ts` 直接掃描 `copilot-runtime.ts` 是否仍呼叫 `setHistoryResolver(`。
 */
type HistoryResolver = (conversationId: string, sinceMessageId: string | null) => Promise<Message[]>
let resolveHistory: HistoryResolver = async () => []

export function setHistoryResolver(resolver: HistoryResolver | null): void {
  resolveHistory = resolver ?? (async () => [])
}

/**
 * 單輪補算的上限：**18 則缺口訊息**（＝ 3 批 × `SENTIMENT_CHUNK_SIZE`，FR-009）。
 *
 * ⚠️ 操作定義是「缺口訊息數」不是「批次數」：缺口與本輪新發言**合併後**才切批，切出來的批次數
 *    不可觀測；新發言本身的批次不計入。單輪 AI 呼叫次數的上界是 ⌈新發言數 ÷ 6⌉ ＋ 3。
 * ⚠️ 數字的理由是「對齊 `SENTIMENT_CONCURRENCY` 的一波並行」，讓補算那幾輪的延遲與現況同量級。
 *    並行度一改，這個理由就不再自動成立 —— T050 要求採用新檔位時 MUST 一併複查它。
 * ⚠️ 超過上限的部分留給後續輪次，由下一次**自然觸發**（新的客戶發言）帶動；
 *    MUST NOT 自行 `scheduleIncremental()` 續排（「補完為止」的迴圈是這裡唯一會踩爆 003 SC-001 的寫法）。
 */
export const SENTIMENT_BACKFILL_MAX_MESSAGES = SENTIMENT_CHUNK_SIZE * 3

// ── 情緒 sparkline ────────────────────────────────────────────────────

function sortByAt(entries: SentimentTimelineEntry[]): SentimentTimelineEntry[] {
  return [...entries].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
}

function computeStats(timeline: SentimentTimelineEntry[]): { lowestScore: number | null, lowestAt: string | null } {
  let lowestScore: number | null = null
  let lowestAt: string | null = null
  for (const entry of timeline) {
    if (entry.kind !== 'point') continue
    if (lowestScore === null || entry.score < lowestScore) {
      lowestScore = entry.score
      lowestAt = entry.at
    }
  }
  return { lowestScore, lowestAt }
}

/** 純附件輪不觸發 analyzing（不送模型），直接併入 timeline（FR-012） */
async function mergeMarkersOnly(conversationId: string, markers: Message[]): Promise<void> {
  const next = await updateAnalysisState(conversationId, (state) => {
    const byId = new Map(state.sentimentBlock.timeline.map(e => [e.messageId, e]))
    for (const m of markers) {
      const marker: SentimentMarker = { kind: 'attachment_only', messageId: m.id, at: m.at }
      byId.set(m.id, marker)
    }
    const timeline = sortByAt([...byId.values()])
    return {
      ...state,
      sentimentBlock: {
        ...state.sentimentBlock,
        // 已有內容（ready/retrying/error/analyzing）時維持原狀態，只更新 timeline；
        // 只有從未產生過任何內容（empty）時才因為「已經有東西可顯示」而轉 ready
        status: state.sentimentBlock.status === 'empty' ? ('ready' as const) : state.sentimentBlock.status,
        timeline,
        updatedAt: nowIso(),
      },
    }
  })
  await publishBlock(conversationId, 'sentiment', next)
}

/**
 * @param gapRemaining 這一輪補算之後**還有沒有**未涵蓋的客戶發言（超過每輪 18 則上限的部分）。
 *   冷啟動與手動重試不傳（＝`false`）：兩者的輸入都是 `fetchLatest()` 的完整視窗，成功即必然涵蓋，
 *   不需另判「是否涵蓋到最新」（data-model.md §3 生命週期表）。
 *
 *   ⚠️ **這個參數是「無條件寫入」的**（下方 `sentimentGap: gapRemaining`），沒有「不要動旗標」
 *      這個選項。因此呼叫端在「這一輪其實沒有判斷過缺口」的路徑上 MUST NOT 順手傳 `false`
 *      —— 那不是「不知道」，那是「明確宣告缺口已清空」，會讓補算永遠停擺且不留任何痕跡。
 *      `resolveSentimentInput()` 取歷史失敗時回 `true` 正是為了這件事（見該函式的 catch）。
 */
async function finishSentimentSuccess(
  conversationId: string,
  newPoints: SentimentPoint[],
  markers: Message[],
  gapRemaining = false,
): Promise<void> {
  const next = await updateAnalysisState(conversationId, (state) => {
    const byId = new Map(state.sentimentBlock.timeline.map(e => [e.messageId, e]))
    for (const p of newPoints) byId.set(p.messageId, p)
    for (const m of markers) {
      const marker: SentimentMarker = { kind: 'attachment_only', messageId: m.id, at: m.at }
      byId.set(m.id, marker)
    }
    const timeline = sortByAt([...byId.values()])
    return {
      // 成功即清除該區塊的失敗批次記憶
      ...clearFailedBatch(state, 'sentiment'),
      // 005 FR-007／FR-009：補完就清；還有剩就留給下一次自然觸發（不自行續排）
      sentimentGap: gapRemaining,
      sentimentBlock: {
        status: 'ready' as const,
        timeline,
        stats: computeStats(timeline),
        /**
         * ⚠️ **新的評分點落地時 MUST 把舊敘述歸零。**
         *    敘述講的是「當時那條時間軸」——多了幾點之後「近 3 輪持續上升」可能已經不成立。
         *    留著舊敘述是在畫面上放一句**可能已經錯了的斷言**；空白只是暫時沒有資訊。
         *    這裡刻意接受一次短暫的閃動，換取「畫面上的話一定是真的」。
         */
        narrative: null,
        retryAttempt: undefined,
        firstFailureAt: undefined,
        updatedAt: nowIso(),
      },
    }
  })
  await publishBlock(conversationId, 'sentiment', next)

  // ⚠️ 分數先發、敘述後補：折線與示警是有時效的（客戶正在生氣），
  //    不能為了一段散文多等一次 AI 往返。失敗不影響上面已經發出去的 ready。
  await narrateSentimentTrend(conversationId)
}

/**
 * 走勢文字摘要（畫布 2a、D-19）—— **在分數發布之後**才跑的第二次呼叫。
 *
 * ⚠️ **失敗一律吞掉，MUST NOT 讓情緒區塊轉 error。** 分數與示警是這個區塊的主體，
 *    為了一段敘述把折線圖一起打掉是本末倒置（憲法 3.2：降級要看得見，但不該擴大災情）。
 *    產不出來時 `narrative` 維持 `null`，UI 就不顯示那一段。
 *
 * ⚠️ **少於兩個評分點時不呼叫。** 一個點沒有「走勢」可談，硬要模型講會得到一句
 *    憑空發揮的話——而 UI 本來就有 `singlePoint` 的說明（「僅一次評分，尚不足以看出走勢」）。
 *
 * ⚠️ 只送 score／label／drivers，不送訊息原文（見 `AIProvider.narrateSentiment`）。
 */
async function narrateSentimentTrend(conversationId: string): Promise<void> {
  const current = await useStateStore().getAnalysisState(conversationId)
  const points = (current?.sentimentBlock.timeline ?? [])
    .filter((e): e is SentimentPoint => e.kind === 'point')
  if (points.length < 2) return

  let narrative
  try {
    narrative = parseSentimentNarrative(await useAIProvider().narrateSentiment({
      points: points.map(p => ({ score: p.score, label: p.label, drivers: p.drivers })),
    }))
  }
  catch {
    // 憲法 1.5：不記錄任何可能夾帶對話內容的錯誤訊息，只留一行通用的降級紀錄
    console.warn(`[copilot-analysis] ${conversationId} 情緒走勢摘要產生失敗，該段留空（不影響分數）`)
    return
  }

  const next = await updateAnalysisState(conversationId, (state) => {
    // ⚠️ 期間若又有新的一批分數落地，這份敘述已經對不上那條時間軸了——直接丟棄。
    //    判斷依據是點數：narrate 期間新增的點只會讓它變多。
    const now = state.sentimentBlock.timeline.filter(e => e.kind === 'point').length
    if (now !== points.length) return state
    return { ...state, sentimentBlock: { ...state.sentimentBlock, narrative, updatedAt: nowIso() } }
  })
  if (next.sentimentBlock.narrative === narrative) {
    await publishBlock(conversationId, 'sentiment', next)
  }
}

/**
 * 恢復時的補算（specs/005-m2-residual-defects US2，FR-007／FR-008／FR-009）：
 * 把「情緒時間軸已涵蓋到哪裡」與實際客戶發言的差集併進這一輪的輸入。
 *
 * 缺口 ＝ { m ∈ 歷史 : m 是客戶發言 ∧ m 在 `timeline[0]` 之後 ∧ m.id ∉ timeline }（data-model.md §3）。
 *
 * ⚠️ **抓取錨點是 `timeline[0].messageId`，MUST NOT 用 `lastCoveredMessageId()`**（research.md #7／#8）。
 *    後者是高水位：中段批次失敗後，後續成功的批次會把高水位推到缺口**之後**，以它為錨點就永遠
 *    撈不到中段缺口 —— 每一項任務都做完，卻一則也沒補到，而且把缺口造在尾端的測試會通過。
 * ⚠️ **左界是 `timeline[0]`，不是對話的第一則訊息**：冷啟動一次只吃最近 `DEFAULT_MESSAGE_LIMIT`（50）則，
 *    更早的訊息是刻意不看、不是缺口。`fetchSince(timeline[0])` 回的是它之後的訊息；錨點若已被擠出
 *    視窗，`fetchSince()` 依既有約定回整批 —— 整批都比被擠出去的錨點新，左界仍然成立。
 * ⚠️ **timeline 為空時**（冷啟動情緒整批失敗）錨點為 `null`，整個視窗的客戶發言都是缺口 ——
 *    與 `stream.get.ts` 重連快照對 `lastCoveredMessageId() === null` 的處理相同（spec FR-008）。
 *
 * ⚠️ **MUST 在 `runBlockDeduped()` 的回呼內呼叫**：併發觸發會合併成 rerun，rerun 重新執行的是
 *    **最新那次觸發**的閉包（`analysis-dedupe.ts`，2026-09-02 起）—— 而那批訊息很可能已被前一輪的
 *    補算當作缺口撈進來評完（它們在平台上早就存在）。缺口在回呼內從**當下**的時間軸重算、
 *    並先濾掉已在時間軸上的訊息（下方 `fresh`，**不是多餘的**），同一則客戶發言才只送進 AI 一次
 *    （spec Edge Case「補算與新發言同時發生」，`test/sentiment-backfill.test.ts` 的併發測試守著）。
 */
async function resolveSentimentInput(
  conversationId: string,
  messages: Message[],
): Promise<{ input: Message[], gapChecked: boolean, gapRemaining: boolean }> {
  const state = await useStateStore().getAnalysisState(conversationId)
  const covered = new Set(state?.sentimentBlock.timeline.map(e => e.messageId) ?? [])
  /**
   * 已在時間軸上的訊息不再送：併發時 rerun 重跑的是最新那次觸發的閉包，而它的那批訊息很可能
   * 已經被前一輪的補算當作缺口撈進來評完了（它們在平台上早就存在）。不濾的話同一則進 AI 兩次。
   * ⚠️ 這一步不撈歷史、只看手上的 state —— S-1（FR-012）的零成本仍然成立。
   */
  const fresh = messages.filter(m => !covered.has(m.id))
  // S-1（FR-012）：沒有缺口旗標時**不取歷史**，輸入與現況逐字相同（扣掉已評過的）
  if (state?.sentimentGap !== true) return { input: fresh, gapChecked: false, gapRemaining: false }

  const freshIds = new Set(fresh.map(m => m.id))

  const anchor = state.sentimentBlock.timeline[0]?.messageId ?? null
  let history: Message[]
  try {
    history = await resolveHistory(conversationId, anchor)
  }
  catch (err) {
    /**
     * ⚠️ 取歷史是一趟 REST 往返，MUST NOT 讓它的失敗往外拋：這裡在 `runBlockDeduped()` 的回呼內、
     *    AI 呼叫的 try/catch 之外，拋出去會讓 `void runIncremental()` 變成 unhandled rejection ——
     *    Copilot 的故障拖垮主線（憲法 3.1）。降級為「這一輪不補、只分析新發言」，旗標維持 true，
     *    下一次自然觸發再試。只記 id 與錯誤類別（憲法 1.5）。
     *
     * ⚠️ **`gapRemaining` MUST 是 `true`，不是 `false`** —— 它是「旗標維持 true」這句話的唯一實作。
     *    `finishSentimentSuccess()` 無條件寫 `sentimentGap: gapRemaining`，回 `false` 會讓這一輪
     *    新發言分析成功後把旗標**清掉**：缺口從此永遠補不回來，而且不報錯、狀態仍是 `ready`。
     *    （2026-09-03 修：原本回 `false`，與本註解自己的敘述及 `copilot-runtime.ts` 的裝配註解都相反。）
     *    語意上也精確 —— 走到這裡代表上方 `state.sentimentGap === true` 已成立且這一輪什麼都沒補到，
     *    缺口確實「還有剩」。因此不需要第三種「不要動旗標」的狀態。
     */
    console.error(`[copilot-analysis] ${conversationId} 補算取歷史失敗，這一輪只分析新發言：${err instanceof Error ? err.constructor.name : typeof err}`)
    return { input: fresh, gapChecked: false, gapRemaining: true }
  }
  // 歷史依 fetchSince() 的約定由舊到新，取前 18 則就是時間最早的 18 則
  const gap = newCustomerMessagesSince(state, history).filter(m => !freshIds.has(m.id))
  const take = gap.slice(0, SENTIMENT_BACKFILL_MAX_MESSAGES)

  // ⚠️ 缺口在前、新發言在後，**不重新排序**：`batchAnchor()` 取最後一則客戶發言當失敗批次記憶的鍵，
  //    新發言墊在後面，鍵就仍是「這一批新發言的最後一則」—— 與沒有補算時完全相同（FR-006 的門檻語意不變）。
  return {
    input: [...take, ...fresh],
    gapChecked: true,
    gapRemaining: gap.length > take.length,
  }
}

/**
 * @param opts.backfill 只有增量觸發（`runIncremental()`）帶 `true`：有缺口旗標時把缺口併進輸入。
 *   冷啟動與手動重試不帶 —— 它們的輸入本來就是完整視窗。
 */
export async function analyzeSentimentBatch(
  conversationId: string,
  messages: Message[],
  opts: { backfill?: boolean } = {},
): Promise<void> {
  if (!messages.some(isTextCustomerMessage)) {
    /**
     * 純附件輪不呼叫模型，因此不受失敗批次記憶約束 —— 它不會失敗，也不該被擋，
     * 更 MUST NOT 進去重鎖：`runBlockDeduped()` 只保留最新那次觸發的 fn，一則附件若在文字批次
     * 在飛時抵達，會把等待中的文字批次擠掉（那批就從此不被分析）。
     * 唯一的例外是補算模式下已知有缺口：那一輪要撈歷史、要送 AI，得走鎖內的完整路徑。
     */
    const state = opts.backfill ? await useStateStore().getAnalysisState(conversationId) : null
    if (state?.sentimentGap !== true) {
      const markerMessages = messages.filter(isAttachmentOnlyCustomerMessage)
      if (markerMessages.length > 0) await mergeMarkersOnly(conversationId, markerMessages)
      return
    }
  }

  await runBlockDeduped(conversationId, 'sentiment', async () => {
    // FR-006 的門檻先看「這一批新發言」：同一批剛失敗過就連歷史都不必撈（SC-004 守的是呼叫量，
    // 但補算在錯誤狀態上每輪多撈一趟歷史同樣沒有意義）。`null` 錨點由 isBatchAlreadyFailed() 自己放行
    const preAnchor = batchAnchor(messages)
    if (await isBatchAlreadyFailed(conversationId, 'sentiment', preAnchor)) return

    const { input, gapChecked, gapRemaining } = opts.backfill
      ? await resolveSentimentInput(conversationId, messages)
      : { input: messages, gapChecked: false, gapRemaining: false }

    const textMessages = input.filter(isTextCustomerMessage)
    const markerMessages = input.filter(isAttachmentOnlyCustomerMessage)

    if (textMessages.length === 0) {
      if (markerMessages.length > 0) await mergeMarkersOnly(conversationId, markerMessages)
      // 撈過歷史而缺口已經不存在（例如 rerun 時前一輪已補完）→ 旗標清掉，下一輪不再撈
      if (gapChecked && !gapRemaining) {
        await updateAnalysisState(conversationId, s => (s.sentimentGap === true ? { ...s, sentimentGap: false } : s))
      }
      return
    }

    const anchor = batchAnchor(input)
    if (anchor !== preAnchor && await isBatchAlreadyFailed(conversationId, 'sentiment', anchor)) return

    await beginAnalyzing(conversationId, 'sentiment')

    try {
      /**
       * 每一小批各自呼叫，最多 `SENTIMENT_CONCURRENCY` 批同時在飛
       * （理由見本檔 `SENTIMENT_CHUNK_SIZE` 與 `SENTIMENT_CONCURRENCY` 兩個常數的宣告處；
       * 2026-09-01 由「依序」改為有上限的並行）。
       *
       * ⚠️ 並行之後 `onRetry` 可能由不同批次交錯觸發，畫面上的 `retryAttempt`
       *    因此不再是單調遞增的 —— 它顯示的是「最近一次重試是第幾次嘗試」，
       *    不是「這個區塊總共重試了幾次」。UI 沒有承諾後者，但不要拿它去做算術。
       */
      const perBatch = await mapWithConcurrency(
        chunk(textMessages, SENTIMENT_CHUNK_SIZE),
        SENTIMENT_CONCURRENCY,
        async part => (await withRetry(
          async () => parseSentimentPoints(await useAIProvider().analyzeSentiment({ messages: part })),
          { onRetry: info => publishRetrying(conversationId, 'sentiment', info) },
        )).value,
      )
      const allPoints: SentimentPoint[] = perBatch.flat()
      await finishSentimentSuccess(conversationId, allPoints, markerMessages, gapRemaining)
    }
    catch (err) {
      // 補算失敗一樣停在 error 等手動重試（FR-010）：finishBlockError() 會把 sentimentGap 設回 true，
      // 由下一次自然觸發再帶動一次 —— MUST NOT 在這裡自行續排（003 SC-001）
      await finishBlockError(conversationId, 'sentiment', err, anchor)
    }
  })
}

/**
 * 目前分析狀態已涵蓋到哪一則客戶訊息 —— T010c 重連快照的補跑判斷依據。
 * timeline 依時間排序，最後一筆的 messageId 即為已處理過的最新客戶訊息（含純附件輪）。
 */
export function lastCoveredMessageId(state: CopilotAnalysisState): string | null {
  const timeline = state.sentimentBlock.timeline
  return timeline[timeline.length - 1]?.messageId ?? null
}

/**
 * T010c 重連快照的補跑輸入：從 `fetchSince()` 的結果篩出真正尚未處理過的客戶訊息。
 *
 * ⚠️ `fetchSince()`／`MessageSource.fetchSince()` 明文約定：錨點找不到（已被擠出最近
 * 50 則視窗）時回傳整批，**由呼叫端自行去重**（見 server/sources/message-fetch.ts 註解）。
 * 忽略這個約定會讓「已涵蓋的最新訊息」在對話存活夠久、訊息數超過視窗大小後被誤判成
 * 「新訊息」而重複觸發分析——症狀是同一筆事實在 `keyFacts` 之類的欄位裡一直重複累加
 * （2026-08-26 由使用者在真實環境回報後定位）。
 */
export function newCustomerMessagesSince(state: CopilotAnalysisState, since: Message[]): Message[] {
  const covered = new Set(state.sentimentBlock.timeline.map(e => e.messageId))
  return since.filter(m => m.sender.type === 'customer' && !covered.has(m.id))
}
