/**
 * 摘要／情緒分析，以及整條分析管線的**對外入口** —— specs/001-sentiment-panel。
 *
 * @analysis-pipeline
 *
 * ⚠️ **上面那行是機器讀的成員標記，MUST NOT 刪，新增管線檔也 MUST 加。**
 *    `test/contract-guards.test.ts` 靠它認出「誰是這條管線的成員」，決定兩件事：
 *    ① 本檔受「不得 import `copilot-runtime.ts`」保護；② 本檔可以值 import 管線內部檔
 *    （管線外不行）。
 *
 *    ⚠️ 為什麼是標記而不是檔名 regex：2026-09-02 原本用 `analysis-*.ts` 這類路徑比對，
 *    實測 `analysis-stage2.ts`（帶數字）與 `analysisSentiment.ts` 兩種很自然的命名
 *    **完全逃出兩條守衛且零訊號** —— 那正是守衛自己要防的失效形態，只是從「忘了加一行
 *    清單」變成「取錯一個檔名」。標記法的失效方向相反且會響：忘了加標記的新管線檔，
 *    它自己的 `import ... analysis-state.js` 會立刻被判成「管線外值 import」而紅，
 *    **而那個紅指向正確的動作**（把檔案登記進管線），不像檔名法會誘導人改走 barrel
 *    ——照那個誘導修完，該檔就永久不受 `copilot-runtime` 守衛保護了。
 *
 * 冷啟動（JOIN）與增量（新客戶發言）共用同一套邏輯：
 *   ① 呼叫 AIProvider 前先把該區塊標為 'analyzing' 並立即 publish（不等待 AI 呼叫），
 *      對應 FR-011／SC-001——沒有這一步，客服要等 AI 呼叫完成（5～12.2 秒）才會看到任何反應。
 *   ② 純附件（無文字）客戶發言過濾為 SentimentMarker，不送模型（FR-002、FR-012）。
 *   ③ 經 withRetry() 呼叫 AIProvider（server/services/ai/retry-policy.ts，FR-014）。
 *   ④ 經 Zod schema 驗證輸出（憲法 4.2，server/services/ai/schemas.ts）。
 *   ⑤ 依全量 timeline 重新計算 sentimentBlock.stats（FR-015，不受最近 50 點顯示上限影響）。
 *   ⑥ 寫回 CopilotAnalysisState（與 CopilotSession 是不同物件，見 server/state/types.ts）。
 *   ⑦ publish 最終結果事件；錯誤記錄僅留 conversationId、失敗分類、錯誤類別與 HTTP 狀態碼
 *      （憲法 1.5，research.md #6）——不含訊息全文或 drivers，這些都不是個資。
 *
 * ── 這條管線由五個檔案組成 ────────────────────────────────────────────
 *
 * | 檔案 | 負責 | 獨有的執行期狀態 |
 * |---|---|---|
 * | `analysis-state.ts` | 狀態讀寫、推播、三態轉移、失敗批次記憶 | `stateLocks` |
 * | `analysis-dedupe.ts` | 同 (對話, 區塊) 的併發去重 | `analysisInFlight`／`analysisRerunPending` |
 * | `blocks/suggestion.ts` | 建議卡（含兩段式的世代與尾巴） | `suggestionTails`／`suggestionTailDone` |
 * | `blocks/sentiment.ts` | 情緒（分批、並行、時間軸合併、缺口補算） | 無（`resolveHistory` 是裝配點，不是狀態） |
 * | **本檔** | 摘要、對外入口、debounce 排程 | `coldStartRecoveries`／`backgroundInFlight`／`debounceTimers` |
 *
 * ⚠️ **`blocks/summary.ts` 刻意不切**（2026-09-03，第三刀當下的決定）：摘要沒有自己的
 *    執行期狀態，單獨成檔換不到任何不變式，只多一層檔案。第三刀切完後本檔只剩
 *    摘要 ＋ 對外入口 ＋ debounce，**那就是這條管線的終點形狀，不必再往下拆。**
 *
 * ⚠️ **每一份執行期狀態只由擁有它的那個檔案碰。** 這是本次拆檔唯一的切線依據，
 *    也是判斷「新程式碼該放哪個檔案」的判準：它要碰哪一份 Map，就寫在那個檔案裡。
 *    跨檔案摸別人的 Map 會繞過該 Map 的不變式（鎖、世代、refcount），
 *    而這一整類錯誤的共同症狀是**安靜地做錯事**，不是報錯。
 *
 * ⚠️ **管線外的呼叫端一律 import 本檔**（它 re-export 了整條管線的對外介面），
 *    MUST NOT 直接**值** import `analysis-state.ts`／`analysis-dedupe.ts`／`blocks/*.ts`。
 *    理由不只是「介面要有唯一答案」：`analysis-state.ts` 對管線內部敞開了整套三態轉移的
 *    驅動面（`beginAnalyzing()`／`finishBlockError()`／`publishBlock()`／`updateAnalysisState()`），
 *    拆檔前這些是 module-private，靠語法保證「三態只由管線內部驅動」。
 *    某支 route 若為了省事直接 import `beginAnalyzing()`，就繞過了 `runBlockDeduped()` 的
 *    去重與失敗批次記憶檢查 —— 同一區塊同時跑兩份分析、或在被記憶擋下的狀態上多打一輪 AI，
 *    而 typecheck 全過、測試全綠，只有帳單與 SC-001 會知道。
 *    由 `test/contract-guards.test.ts` 的「管線內部檔案不得被管線外值 import」守住。
 *
 * ⚠️ **純型別 import 不在此限**（執行期被抹除，拿不到任何函式）：`server/state/types.ts`
 *    就 `import type { AnalysisBlock } from './analysis-state.js'`，那是正確用法。
 *
 * 建議卡在此之外多兩步：知識庫檢索（不重試，失敗即以空集合續行，FR-004）
 * 與白名單後驗＋confidence 強制歸零（憲法 4.3、4.4），見 `blocks/suggestion.ts`。
 */

import type { Message } from '../../shared/types/conversation.js'
import type { ConversationSummary } from '../../shared/types/copilot.js'
import type { WatchPriority } from '../sources/types.js'
import { useStateStore } from '../state/index.js'
import type { CopilotAnalysisState } from '../state/types.js'
import { useAIProvider } from './ai/index.js'
import { withRetry } from './ai/retry-policy.js'
import { parseConversationSummary } from './ai/schemas.js'
import { runBlockDeduped } from './analysis-dedupe.js'
import { analyzeSentimentBatch } from './blocks/sentiment.js'
import { analyzeSuggestions, cancelSuggestionTail } from './blocks/suggestion.js'
import type { AnalysisBlock } from './analysis-state.js'
import {
  batchAnchor,
  beginAnalyzing,
  clearFailedBatch,
  ensureState,
  finishBlockError,
  isBatchAlreadyFailed,
  nowIso,
  publishBlock,
  publishRetrying,
  releaseFailedBatch,
  updateAnalysisState,
} from './analysis-state.js'

// ── 對外介面的唯一出口（re-export）───────────────────────────────────
//
// ⚠️ 拆檔前這些全部定義在本檔，呼叫端（route、session-manager、8 支測試）都是
//    從這裡 import 的。保留這一段 re-export 讓拆檔的 diff 完全不碰呼叫端 ——
//    「行為一個字都沒變」因此可以純粹靠既有測試斷言，而不是靠人工核對。

export type { AnalysisBlock } from './analysis-state.js'
export {
  clearFailedBatch,
  isTextCustomerMessage,
  markFailedBatch,
  readFailedBatch,
  releaseFailedBatch,
} from './analysis-state.js'
export {
  awaitSuggestionTail,
  checkSuggestionsSuperseded,
  forceNullConfidence,
  hasSuggestionTail,
  markSupersededCards,
  settleOrphanedPendingCitation,
  whitelistFilter,
} from './blocks/suggestion.js'
export {
  DEFAULT_SENTIMENT_CONCURRENCY,
  lastCoveredMessageId,
  newCustomerMessagesSince,
  resolveSentimentConcurrency,
  SENTIMENT_BACKFILL_MAX_MESSAGES,
  SENTIMENT_CHUNK_SIZE,
  SENTIMENT_CONCURRENCY,
  setHistoryResolver,
} from './blocks/sentiment.js'

// ── JOIN 界線（specs/003-analysis-trigger-policy 決策 3、FR-012）───────────────────

/**
 * 「這個對話還有沒有人 JOIN」的解析器。
 *
 * ⚠️ **整條分析管線的五個檔案都 MUST NOT import `copilot-runtime.ts`**
 *    （那裡才拿得到 `messageSource`）：它經 `server/utils/imbrace-client.ts` 用到
 *    Nitro auto-import 的 `useRuntimeConfig()`，一旦被 `test/` 透過管線間接拉進型別圖，
 *    `tsconfig.scripts.json` 會整份紅 —— 那份設定檔開頭已經把這個陷阱寫成警告。
 *    因此相依方向反過來：由 `copilot-runtime.ts` 在載入時呼叫 `setJoinedResolver()`
 *    注入進來。`test/contract-guards.test.ts` 逐一掃描那五個檔案守住這條。
 *
 * ⚠️ 預設是 `() => true`（不設門檻）：純單元測試不會載入 runtime，預設擋掉會讓
 *    既有測試全部安靜地失去分析。裝配那一行被刪掉時同樣不會報錯，
 *    因此由 `test/contract-guards.test.ts` 直接掃描 `copilot-runtime.ts` 守住它。
 */
type JoinedResolver = (conversationId: string) => boolean
let resolveJoined: JoinedResolver = () => true

/** 由 `copilot-runtime.ts` 於載入時呼叫；測試也用它注入特定情境（比照 `setAIProvider()`） */
export function setJoinedResolver(resolver: JoinedResolver | null): void {
  resolveJoined = resolver ?? (() => true)
}

// ── 摘要卡 ────────────────────────────────────────────────────────────

async function analyzeSummary(
  conversationId: string,
  input: { history: Message[], previousSummary?: ConversationSummary },
): Promise<void> {
  if (input.history.length === 0) return

  await runBlockDeduped(conversationId, 'summary', async () => {
    const anchor = batchAnchor(input.history)
    // FR-006：這一批在這個區塊已經失敗過 → 不再自動重試。
    // ⚠️ MUST 在 beginAnalyzing() **之前** —— 之後才檢查等於已經對外宣告「分析中」，
    //    畫面會閃一下「分析中」再跳回錯誤（且 FR-006 的呼叫量目標也達不到）。
    // ⚠️ runBlockDeduped() 的 rerun 會重新執行整個 callback，因此這道檢查會再過一次
    //    （契約不變式 B 的推論三）。
    if (await isBatchAlreadyFailed(conversationId, 'summary', anchor)) return

    await beginAnalyzing(conversationId, 'summary')

    /**
     * ⚠️ 增量情境的 `previousSummary` MUST 在**回呼內**從 state 重讀，不能用觸發當下捕捉的那份
     *    （2026-09-02，005 code review 抓到）：`runBlockDeduped()` 的 rerun 跑的是最新那次觸發的閉包，
     *    而它的 `previousSummary` 是在前一批還在飛時讀的 —— 前一批落地後 rerun 拿舊摘要 ＋ 新訊息
     *    重算，前一批的事實從摘要裡消失、`basedOnMessageId` 直接跳過它們，不報錯。
     *    冷啟動與手動重試傳 `undefined`（全量歷史），維持 undefined。
     */
    const previousSummary = input.previousSummary === undefined
      ? undefined
      : (await useStateStore().getAnalysisState(conversationId))?.summaryBlock.summary ?? input.previousSummary

    try {
      const outcome = await withRetry(
        async () => parseConversationSummary(await useAIProvider().summarize({ history: input.history, previousSummary })),
        { onRetry: info => publishRetrying(conversationId, 'summary', info) },
      )

      const next = await updateAnalysisState(conversationId, state => ({
        // 成功即清除該區塊的失敗批次記憶
        ...clearFailedBatch(state, 'summary'),
        summaryBlock: {
          status: 'ready' as const,
          summary: outcome.value,
          retryAttempt: undefined,
          firstFailureAt: undefined,
          updatedAt: nowIso(),
        },
      }))
      await publishBlock(conversationId, 'summary', next)
    }
    catch (err) {
      await finishBlockError(conversationId, 'summary', err, anchor)
    }
  })
}

// ── 對外入口 ──────────────────────────────────────────────────────────

/** JOIN 冷啟動（T013）：送交模型全量歷史，各區塊各自獨立分析並可各自先行顯示（FR-011） */
export async function runColdStart(conversationId: string, history: Message[], aiReplies: boolean): Promise<void> {
  await ensureState(conversationId)
  // FR-009：客戶尚無任何發言（含純附件）時維持 empty，不呼叫 AI
  if (!history.some(m => m.sender.type === 'customer')) return

  // FR-015：重新 JOIN 走冷啟動 —— 三個區塊的失敗批次記憶一併放行。
  // 客服刻意重新接手這個對話，本身就是「有理由相信這次會不一樣」（data-model.md §1）。
  await updateAnalysisState(conversationId, state =>
    releaseFailedBatch(releaseFailedBatch(releaseFailedBatch(state, 'summary'), 'sentiment'), 'suggestions'),
  )

  await Promise.all([
    analyzeSummary(conversationId, { history, previousSummary: undefined }),
    analyzeSentimentBatch(conversationId, history),
    analyzeSuggestions(conversationId, { history, aiReplies }, 'progressive'),
  ])
}

/**
 * 程序重啟後的冷啟動復原 —— 目前進行中的對話（避免同一個對話被多條連線同時復原）。
 * ⚠️ 只是「省下重複的那一次」，不是保證層：真正讓它收斂的是 `runColdStart()` 一開始就
 *    `ensureState()`（`analysis-state.ts`），狀態一旦建立，後續 attach 就不會再走到這條路。
 */
const coldStartRecoveries = new Set<string>()

/**
 * **重啟復原**：已 JOIN 但沒有 `CopilotAnalysisState` 的對話，補跑一次冷啟動。
 *
 * ⚠️ **為什麼需要它**：`CopilotAnalysisState` 原本只由 `join.post.ts` 建立，而**平台側的
 *    JOIN 是持久的**。伺服器重啟會清空 `MemoryStateStore`，客服重新連上後畫面仍顯示
 *    「已接手」、面板照常展開，但 `runIncremental()` 卡在開頭的 `if (!state) return` ——
 *    **面板永遠空白、沒有日誌、不報錯**，唯一的復原方式是客服自己想到要 LEAVE 再 JOIN。
 *    開發時每次重啟 dev server 都會遇到（2026-08-28 一個晚上撞到四次）。
 *
 * ⚠️ **代價**：重啟後每個「已 JOIN 且有連線」的對話都會重跑一次冷啟動（三個區塊各一次
 *    AI 呼叫）。這是刻意接受的——它換回的正是 JOIN 當初承諾的東西，且量級受限於
 *    「客服實際接手的對話數」。M4 換上 Redis 後狀態跨重啟保留，這條路徑自然不再觸發。
 *
 * ⚠️ 呼叫端 MUST 先確認**這條連線對該對話已 JOIN**（003 FR-003／FR-016a）——
 *    未 JOIN 的對話不該為此付出任何 AI 成本。
 */
export async function recoverColdStart(
  conversationId: string,
  history: Message[],
  aiReplies: boolean,
): Promise<void> {
  if (coldStartRecoveries.has(conversationId)) return
  // ⚠️ 佔位 MUST 在**任何 `await` 之前**：下面那行狀態檢查是 async，會讓出 microtask，
  //    先查再佔位的話，同一客服的兩個分頁會雙雙通過檢查、各跑一次完整冷啟動
  //    （三個區塊各一次 AI 呼叫）。`runBlockDeduped()`（`analysis-dedupe.ts`）擋不住這個——它合併的是
  //    「同一區塊的併發」，而這裡是兩份各自完整的冷啟動。
  coldStartRecoveries.add(conversationId)
  try {
    // 取歷史那段時間內可能已經有別人建立了狀態 —— 再確認一次，這不是多餘的
    if (await useStateStore().getAnalysisState(conversationId)) return

    console.warn(`[copilot-analysis] ${conversationId} 沒有分析狀態但已 JOIN —— 補跑冷啟動（重啟復原）`)
    await runColdStart(conversationId, history, aiReplies)
  }
  finally {
    coldStartRecoveries.delete(conversationId)
  }
}

/**
 * 背景並行節流（憲法 6.2、specs/002-suggestion-knowledge-search research.md #9）——
 * 同時進行背景重算的對話數量上限。這份狀態本質類似 `debounceTimers`：純執行期狀態，
 * 程序重啟後全部中斷重來也無妨。
 *
 * ⚠️ **2026-09-02 訂正**：原註解寫著「globalThis-keyed 是為了比照既有單例的 HMR 安全模式」，
 *    但這一行從來就是普通的 `new Set()` —— 註解描述的是一個不存在的性質。
 *    它與本管線其餘七份執行期狀態一樣是 **process-local**，多副本下上限會變成 N × 10
 *    而不報錯（docs/ARCHITECTURE.md §18 M2「分析管線拆檔」的 📌 註記已把八份逐一盤點，
 *    §18 M4 有對應的驗收項）。**MUST NOT 據原說法認定它已經跨副本安全。**
 */
const BACKGROUND_CONCURRENCY_LIMIT = 10
const backgroundInFlight = new Set<string>()

/**
 * 新客戶發言的增量觸發（T019，session-manager.ts 的 debounce 之後呼叫）。
 * ⚠️ FR-004：送交模型的輸入僅含既有摘要與新訊息，MUST NOT 含完整歷史。
 * ⚠️ FR-005：呼叫端必須先過濾為 `sender.type === 'customer'` 的訊息，這裡不重複檢查。
 *
 * ⚠️ **2026-08-26 修正**：`session-manager.ts` 的 `onMessages()` 對任何「正在被 SSE
 * 檢視」的對話都會觸發（既有 M1 設計，未 JOIN 的對話也會為了 presence／通知而背景輪詢），
 * 不代表該對話已經 JOIN。分析範圍以 JOIN 為界（FR-001：「客服 JOIN 對話後」才產生摘要），
 * 因此這裡改成：**若尚無 `CopilotAnalysisState`（代表從未經過 `runColdStart()`／未曾 JOIN
 * 過），直接略過，不得在此建立**——否則單純打開一個對話頁面就會悄悄跑一次分析。
 *
 * ⚠️ `priority === 'background'` 時（specs/002-suggestion-knowledge-search FR-019、FR-020）：
 *   - 名額已滿（`backgroundInFlight.size >= BACKGROUND_CONCURRENCY_LIMIT`）且本對話尚未佔用
 *     名額時，**不執行**——改為呼叫 `scheduleIncremental()` 以相同長度重新排一次 debounce
 *     （沿用既有的 pending 合併邏輯，等同「保留 pending，不清空，不顯示為錯誤」）。
 *   - 否則佔用一個名額執行，**跳過 `analyzeSummary()`**（摘要是給人看的，人不在就不必更新），
 *     只執行情緒與建議卡分析（含其必要的知識庫檢索——憲法 6.2 MUST NOT 略過檢索）。
 */
export async function runIncremental(
  conversationId: string,
  newCustomerMessages: Message[],
  priority: WatchPriority,
  aiReplies: boolean,
): Promise<void> {
  if (newCustomerMessages.length === 0) return
  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state) return

  // ⚠️ **2026-08-28 修正（specs/003-analysis-trigger-policy FR-012）**：
  //    上面那道「有沒有分析狀態」的門檻回答不了「現在還有沒有人 JOIN」——
  //    `CopilotAnalysisState` 有 2 小時 sliding TTL，LEAVE 不會清掉它，
  //    於是客服按下離開之後分析照跑（SC-002 失效，且完全不報錯）。
  //
  //    ⚠️ 檢查點在 debounce **觸發的當下**，不是排入時：這涵蓋所有路徑
  //    （心跳補跑、onMessages 增量、背景名額釋出後的重排），判斷的也是觸發時的真實狀態。
  //    `cancelPendingAnalysis()` 只是清理層，擋不住背景名額滿時自己重排的那條路。
  //
  //    ⚠️ 它是**對話層級**的聚合，因此 FR-014「同事仍 JOIN 時我的 LEAVE 不停止分析」
  //    不需要額外邏輯。已在飛的分析不中斷 —— 本門檻只擋「排入新的」。
  if (!resolveJoined(conversationId)) return

  if (priority === 'background') {
    if (backgroundInFlight.size >= BACKGROUND_CONCURRENCY_LIMIT && !backgroundInFlight.has(conversationId)) {
      scheduleIncremental(conversationId, newCustomerMessages, priority, aiReplies)
      return
    }
    backgroundInFlight.add(conversationId)
    try {
      await Promise.all([
        // 005 US2：只有情緒帶 backfill —— 補算只擴充情緒的輸入（research.md #11），建議卡照舊只吃這一批
        analyzeSentimentBatch(conversationId, newCustomerMessages, { backfill: true }),
        // ⚠️ **背景刻意不走兩段式**（004 FR-013）：沒有人在等，第一段的產出沒有人會看到，
        //    而背景並行上限 10 個對話正是這裡省下的量。前景與背景的**不一致是刻意的**，
        //    MUST NOT 為了一致性把它改回 'progressive'（見 `blocks/suggestion.ts` 的 `SuggestionStrategy` 註解）。
        analyzeSuggestions(conversationId, { history: newCustomerMessages, aiReplies }, 'single'),
      ])
    }
    finally {
      backgroundInFlight.delete(conversationId)
    }
    return
  }

  await Promise.all([
    analyzeSummary(conversationId, {
      history: newCustomerMessages,
      previousSummary: state.summaryBlock.summary ?? undefined,
    }),
    /**
     * 005 US2：**只有情緒**帶 `backfill`（research.md #11）。三個區塊的錨點語意不同：
     * 摘要用 `summaryBlock.summary.basedOnMessageId`（`catchUpSummaryIfStale()` 已警告過誤用的後果），
     * 建議卡是針對「這一批」生成的 —— 把舊發言塞進去會產生一批答非所問的卡。
     * 情緒是唯一「每則發言各自一個點、缺一點就是缺一點」的區塊，也只有它有缺口問題。
     */
    analyzeSentimentBatch(conversationId, newCustomerMessages, { backfill: true }),
    analyzeSuggestions(conversationId, { history: newCustomerMessages, aiReplies }, 'progressive'),
  ])
}

/**
 * US4 AC#5、FR-020、research.md #10：客服重新聚焦（切回前景）背景對話時，
 * 摘要才補跑——背景期間 `runIncremental()` 一律跳過 `analyzeSummary()`，
 * 這裡用既有的 `basedOnMessageId` 版本錨點（零成本，見型別註解）找出尚未涵蓋的客戶發言，
 * 沒有新發言時 no-op；有新發言時直接呼叫既有的 `analyzeSummary()`——
 * 它自己會先發布 `analyzing`（保留舊內容）才呼叫 AIProvider，UI 因此會顯示「更新中」（US4 AC#5）。
 *
 * ⚠️ 比對基準是 `summaryBlock.summary.basedOnMessageId`，**不是**情緒時間軸的
 *    `lastCoveredMessageId()`——背景期間情緒持續更新、摘要不動，兩者現在可能不同步，
 *    誤用對方的錨點會讓摘要漏補或誤判為已是最新。
 */
export async function catchUpSummaryIfStale(conversationId: string, history: Message[]): Promise<void> {
  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state) return

  const anchor = state.summaryBlock.summary?.basedOnMessageId ?? null
  const idx = anchor ? history.findIndex(m => m.id === anchor) : -1
  const unseen = (idx >= 0 ? history.slice(idx + 1) : history).filter(m => m.sender.type === 'customer')
  if (unseen.length === 0) return

  await analyzeSummary(conversationId, { history: unseen, previousSummary: state.summaryBlock.summary ?? undefined })
}

/**
 * 手動重試單一區塊（FR-008，server/api/conversations/[id]/copilot/retry.post.ts）。
 * 等同冷啟動的該區塊部分：使用全量歷史重新分析，不影響另一區塊（contracts/copilot-retry-api.md）。
 */
export async function retryBlock(
  conversationId: string,
  block: AnalysisBlock,
  history: Message[],
  aiReplies: boolean,
): Promise<void> {
  await ensureState(conversationId)

  // FR-008：手動重試是「客服明確要求再試一次」—— 放行該區塊的失敗批次記憶，
  // 否則 FR-006 的門檻會把這次重試也一併擋下，重試按鈕變成完全無效（且不報錯）。
  // ⚠️ 只放行這一個區塊：另一區塊的記憶與本次操作無關（contracts/copilot-retry-api.md）。
  await updateAnalysisState(conversationId, state => releaseFailedBatch(state, block))

  if (block === 'summary') {
    await analyzeSummary(conversationId, { history, previousSummary: undefined })
  }
  else if (block === 'sentiment') {
    await analyzeSentimentBatch(conversationId, history)
  }
  else {
    await analyzeSuggestions(conversationId, { history, aiReplies }, 'progressive')
  }
}

// ── debounce（§11.1、§11.2）───────────────────────────────────────────

const DEBOUNCE_MS = 1_000
/** 明顯長於前景（§11.2、FR-021）——背景對話不急著在客服沒看的當下就把結果算出來 */
const BACKGROUND_DEBOUNCE_MS = 8_000

interface PendingDebounce {
  timer: ReturnType<typeof setTimeout>
  pending: Message[]
  priority: WatchPriority
  aiReplies: boolean
}
const debounceTimers = new Map<string, PendingDebounce>()

/**
 * 新客戶發言的 debounce 聚合入口（§11.1：1 秒內多筆客戶發言合併為單次分析；
 * §11.2：背景對話改用明顯更長的 `BACKGROUND_DEBOUNCE_MS`）。
 *
 * ⚠️ 呼叫端（server/services/session-manager.ts 的 onMessages()）負責過濾出
 *    `sender.type === 'customer'` 的訊息（FR-005：客服自己送出的訊息 MUST NOT 觸發重新分析）——
 *    本函式信任呼叫端已過濾，不重複檢查。
 *
 * ⚠️ 與既有 pending 合併時，優先度取「前景蓋過背景」（同一份對話對任一位客服而言只要有人
 *    前景聚焦就該用前景頻率）——沿用 `PollingMessageSource.aggregateState()` 同一條規則，
 *    避免兩處判斷各自為政而互相矛盾。
 */
export function scheduleIncremental(
  conversationId: string,
  customerMessages: Message[],
  priority: WatchPriority,
  aiReplies: boolean,
): void {
  if (customerMessages.length === 0) return

  const existing = debounceTimers.get(conversationId)
  const pending = existing ? [...existing.pending, ...customerMessages] : [...customerMessages]
  const mergedPriority: WatchPriority = existing?.priority === 'foreground' || priority === 'foreground'
    ? 'foreground'
    : 'background'
  if (existing) clearTimeout(existing.timer)

  const delayMs = mergedPriority === 'background' ? BACKGROUND_DEBOUNCE_MS : DEBOUNCE_MS
  const timer = setTimeout(() => {
    debounceTimers.delete(conversationId)
    void runIncremental(conversationId, pending, mergedPriority, aiReplies)
  }, delayMs)
  timer.unref?.()
  debounceTimers.set(conversationId, { timer, pending, priority: mergedPriority, aiReplies })
}

/**
 * 清掉這個對話尚未執行、等待中的分析排程（specs/003-analysis-trigger-policy FR-013）。
 *
 * ⚠️ **這是清理層，不是保證層。** 真正的保證是 `runIncremental()` 在 debounce
 *    觸發的當下檢查 JOIN 狀態（見該處註解）—— 只做清理會漏掉「背景名額滿時
 *    `runIncremental()` 自己重新 `scheduleIncremental()`」那條路，那是清理之後才排的。
 *    反過來只做保證層則行為正確、但留著一個空轉的計時器。兩層都要。
 */
export function cancelPendingAnalysis(conversationId: string): void {
  // ── 004：先處置尾巴，**MUST 在下面那個早退之前** ────────────────────────
  //
  // ⚠️ 這個順序是規範，不是風格。下面的早退問的是「有沒有等待中的 debounce 排程」，
  //    與「有沒有第二段的尾巴」無關 —— 而 JOIN 冷啟動觸發的尾巴正是**沒有** debounce
  //    排程的那一種。寫在早退之後，LEAVE 之後第二段照跑、錢照付、結果無人看，
  //    而且不會有任何錯誤。
  //
  // ⚠️ 這裡刻意呼叫 `blocks/suggestion.ts` 的函式，而不是自己去摸 `suggestionTails` ——
  //    那個 Map 的不變式（世代計數）只在它自己的檔案裡守得住（見本檔開頭的表）。
  cancelSuggestionTail(conversationId)

  const pending = debounceTimers.get(conversationId)
  if (!pending) return
  clearTimeout(pending.timer)
  debounceTimers.delete(conversationId)
}
