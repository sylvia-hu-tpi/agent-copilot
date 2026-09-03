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
 * ── 這條管線由四個檔案組成 ────────────────────────────────────────────
 *
 * | 檔案 | 負責 | 獨有的執行期狀態 |
 * |---|---|---|
 * | `analysis-state.ts` | 狀態讀寫、推播、三態轉移、失敗批次記憶 | `stateLocks` |
 * | `analysis-dedupe.ts` | 同 (對話, 區塊) 的併發去重 | `analysisInFlight`／`analysisRerunPending` |
 * | `blocks/suggestion.ts` | 建議卡（含兩段式的世代與尾巴） | `suggestionTails`／`suggestionTailDone` |
 * | **本檔** | 摘要、情緒、對外入口、debounce 排程 | `coldStartRecoveries`／`backgroundInFlight`／`debounceTimers` |
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
import type {
  ConversationSummary,
  SentimentMarker,
  SentimentPoint,
  SentimentTimelineEntry,
} from '../../shared/types/copilot.js'
import type { WatchPriority } from '../sources/types.js'
import { useStateStore } from '../state/index.js'
import type { CopilotAnalysisState } from '../state/types.js'
import { useAIProvider } from './ai/index.js'
import { withRetry } from './ai/retry-policy.js'
import { parseConversationSummary, parseSentimentNarrative, parseSentimentPoints } from './ai/schemas.js'
import { runBlockDeduped } from './analysis-dedupe.js'
import { analyzeSuggestions, cancelSuggestionTail } from './blocks/suggestion.js'
import type { AnalysisBlock } from './analysis-state.js'
import {
  batchAnchor,
  beginAnalyzing,
  clearFailedBatch,
  ensureState,
  finishBlockError,
  isAttachmentOnlyCustomerMessage,
  isBatchAlreadyFailed,
  isTextCustomerMessage,
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

// ── JOIN 界線（specs/003-analysis-trigger-policy 決策 3、FR-012）───────────────────

/**
 * 「這個對話還有沒有人 JOIN」的解析器。
 *
 * ⚠️ **整條分析管線的四個檔案都 MUST NOT import `copilot-runtime.ts`**
 *    （那裡才拿得到 `messageSource`）：它經 `server/utils/imbrace-client.ts` 用到
 *    Nitro auto-import 的 `useRuntimeConfig()`，一旦被 `test/` 透過管線間接拉進型別圖，
 *    `tsconfig.scripts.json` 會整份紅 —— 那份設定檔開頭已經把這個陷阱寫成警告。
 *    因此相依方向反過來：由 `copilot-runtime.ts` 在載入時呼叫 `setJoinedResolver()`
 *    注入進來。`test/contract-guards.test.ts` 逐一掃描那四個檔案守住這條。
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

// ── 歷史來源（specs/005-m2-residual-defects US2，research.md #10）─────────────────

/**
 * 「從這個錨點之後的歷史」的解析器 —— 恢復補算要撈缺口用。形狀完全比照 `setJoinedResolver()`：
 * 管線 MUST NOT import `copilot-runtime.ts`（理由見上），由它在載入時把 `messageSource.fetchSince`
 * 注入進來。錨點語意沿用 `fetchSince()` 的約定：找不到（已被擠出最近 50 則視窗）或為 `null` 時
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
     */
    console.error(`[copilot-analysis] ${conversationId} 補算取歷史失敗，這一輪只分析新發言：${err instanceof Error ? err.constructor.name : typeof err}`)
    return { input: fresh, gapChecked: false, gapRemaining: false }
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
async function analyzeSentimentBatch(
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
       * （見兩個常數上方的說明；2026-09-01 由「依序」改為有上限的並行）。
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
