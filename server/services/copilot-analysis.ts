/**
 * 摘要／情緒／建議卡分析管線 —— specs/001-sentiment-panel、specs/002-suggestion-knowledge-search。
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
 * 建議卡（specs/002-suggestion-knowledge-search）額外多兩步：知識庫檢索（不重試，
 * 失敗即以空集合續行，FR-004）與白名單後驗＋confidence 強制歸零（憲法 4.3、4.4）。
 */

import { isWorkflowInternalMessage } from '../../shared/types/conversation.js'
import type { Message } from '../../shared/types/conversation.js'
import type {
  ConversationSummary,
  SentimentMarker,
  SentimentPoint,
  SentimentTimelineEntry,
  SuggestionCard,
} from '../../shared/types/copilot.js'
import type { KnowledgeHit } from '../../shared/types/knowledge.js'
import type { WatchPriority } from '../sources/types.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic } from '../state/types.js'
import type { CopilotAnalysisState, FailedBatch } from '../state/types.js'
import { useAIProvider } from './ai/index.js'
import type { FailureKind, WithRetryOptions } from './ai/retry-policy.js'
import {
  AICallTimeoutError,
  AIOutputValidationError,
  AIProviderHttpError,
  RetryExhaustedError,
  withRetry,
} from './ai/retry-policy.js'
import { parseConversationSummary, parseSentimentPoints, parseSuggestionCards } from './ai/schemas.js'
import { KNOWLEDGE_SEARCH_TIMEOUT_MS } from './knowledge/agent-knowledge-provider.js'
import { useKnowledgeProvider } from './knowledge/index.js'

export type AnalysisBlock = 'summary' | 'sentiment' | 'suggestions'

/** sliding TTL：每次讀取或寫入皆續期。見 data-model.md「CopilotAnalysisState」生命週期一節 */
const ANALYSIS_STATE_TTL_MS = 2 * 60 * 60 * 1000

/**
 * ⚠️ **2026-08-27 實測發現**：情緒分析是「一次呼叫評完全部客戶發言」，延遲隨訊息則數
 * 線性增加——真實對話 16 則客戶發言，單次呼叫實測 12.7～29.9 秒，遠超 FR-014 的 15 秒
 * 單次逾時門檻（該門檻是依「回一句話」的通用 AI 呼叫延遲訂的，中位數 5 秒、最慢 12.2 秒，
 * 見 docs/PLATFORM_CAPABILITY.md，不是為「輸出量隨輸入線性增加」的任務設計）。
 * 對話可長達 398 則（docs/ARCHITECTURE.md §9.3 實測上限），沒有固定逾時秒數能安全涵蓋
 * 所有長度，因此改為**切成固定則數的小批，依序各自呼叫、各自獨立套用 FR-014 的
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
const SENTIMENT_CHUNK_SIZE = 6

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function isTextCustomerMessage(m: Message): boolean {
  return m.sender.type === 'customer' && m.text !== ''
}

/** ⚠️ 判別式僅在本功能範圍內成立，M3 附件文字化落地後須改用顯式旗標——見 data-model.md 附註 */
function isAttachmentOnlyCustomerMessage(m: Message): boolean {
  return m.sender.type === 'customer' && m.text === '' && (m.attachments?.length ?? 0) > 0
}

function nowIso(): string {
  return new Date().toISOString()
}

function initialState(conversationId: string): CopilotAnalysisState {
  const at = nowIso()
  return {
    conversationId,
    summaryBlock: { status: 'empty', summary: null, updatedAt: at },
    sentimentBlock: { status: 'empty', timeline: [], stats: { lowestScore: null, lowestAt: null }, updatedAt: at },
    suggestionBlock: {
      status: 'empty',
      cards: [],
      knowledgeSearch: { ran: false, hitCount: 0 },
      // 004：尚無卡片時 `citation` 沒有語意，取不會誤導的值（data-model.md §1）
      citation: 'none',
      basedOnMessageId: null,
      provenance: { stage: 1, stage1RetryAttempt: 0 },
      updatedAt: at,
    },
  }
}

async function ensureState(conversationId: string): Promise<CopilotAnalysisState> {
  const store = useStateStore()
  const existing = await store.getAnalysisState(conversationId)
  if (existing) return existing
  const fresh = initialState(conversationId)
  await store.setAnalysisState(fresh, ANALYSIS_STATE_TTL_MS)
  return fresh
}

/**
 * ⚠️ 即使 `getAnalysisState()`／`setAnalysisState()` 內部沒有任何 `await`，
 *    async function 呼叫本身一定會讓出至少一個 microtask —— 摘要／情緒／建議卡三個區塊
 *    透過 `Promise.all()` 並行執行時，若不序列化，各自的 read-modify-write 會交錯，
 *    後寫入者會拿著「對方尚未更新前」的舊快照覆蓋回去，把對方剛寫入的欄位悄悄復原。
 *    因此同一個 conversationId 的所有更新一律排進同一條佇列，逐一執行。
 */
const stateLocks = new Map<string, Promise<unknown>>()

// ── 失敗批次記憶（specs/003-analysis-trigger-policy §1、FR-005～FR-008、FR-011）─────
//
// ⚠️ 三個純存取函式，刻意匯出供測試直接引用。狀態放在 `CopilotAnalysisState` **頂層**
//    （見 server/state/types.ts 的 `failedBatches` 註解），MUST NOT 併入任一 Block。

/** 讀：這個區塊上次是在哪一批失敗的？從未失敗過（或狀態不存在）回 `null` */
export function readFailedBatch(state: CopilotAnalysisState | null, block: AnalysisBlock): FailedBatch | null {
  return state?.failedBatches?.[block] ?? null
}

/**
 * 寫：記下「這個區塊、這一批」失敗了。同一批再次失敗時 `count` 遞增（手動重試也失敗的情形），
 * 並清掉 `released` —— 放行只有一次機會，失敗了就重新擋住。
 * @param batchLastMessageId 該批最後一則客戶訊息 id —— 自癒機制的支點，見 FailedBatch 註解
 */
export function markFailedBatch(
  state: CopilotAnalysisState,
  block: AnalysisBlock,
  batchLastMessageId: string,
): CopilotAnalysisState {
  const prev = state.failedBatches?.[block]
  const count = prev?.lastMessageId === batchLastMessageId ? prev.count + 1 : 1
  return {
    ...state,
    failedBatches: {
      ...state.failedBatches,
      [block]: { lastMessageId: batchLastMessageId, at: nowIso(), count },
    },
  }
}

/** 清：分析成功時整筆移除 —— 這一批已經有結果了，記憶沒有存在意義 */
export function clearFailedBatch(state: CopilotAnalysisState, block: AnalysisBlock): CopilotAnalysisState {
  if (!state.failedBatches?.[block]) return state
  const next = { ...state.failedBatches }
  delete next[block]
  return { ...state, failedBatches: next }
}

/**
 * 放行：手動重試（FR-008）與重新 JOIN 冷啟動（FR-015）用。門檻不再擋這一批，
 * 但 `count` 保留（見 `FailedBatch.released` 的說明 —— 刪掉整筆會讓 `count` 變成死欄位）。
 */
export function releaseFailedBatch(state: CopilotAnalysisState, block: AnalysisBlock): CopilotAnalysisState {
  const prev = state.failedBatches?.[block]
  if (!prev || prev.released) return state
  return {
    ...state,
    failedBatches: { ...state.failedBatches, [block]: { ...prev, released: true } },
  }
}

/**
 * 「這一批是不是已經失敗過、而且還沒被放行」—— 各區塊分析進入點的門檻（FR-006）。
 *
 * ⚠️ `batchLastMessageId` 為 `null` 時一律回 `false`（放行）：沒有可判定的批次，
 *    寧可下次再試一次，也不要用一個假的鍵擋住未來的分析。
 */
async function isBatchAlreadyFailed(
  conversationId: string,
  block: AnalysisBlock,
  batchLastMessageId: string | null,
): Promise<boolean> {
  if (batchLastMessageId === null) return false
  const state = await useStateStore().getAnalysisState(conversationId)
  const failed = readFailedBatch(state, block)
  return failed !== null && failed.lastMessageId === batchLastMessageId && !failed.released
}

/**
 * 該批的判定鍵：這一批**最後一則客戶訊息**的 id（data-model.md §1）。
 *
 * ⚠️ 取「最後一則客戶訊息」而非「最後一則訊息」：客服自己送出的訊息 MUST NOT 觸發
 *    重新分析（001 FR-005）。用整批的最後一則當鍵的話，客服回一句話就會讓鍵改變，
 *    等同繞過失敗批次記憶再跑一輪 —— 而那條路不會報錯。
 *
 * ⚠️ 為何不用訊息 id 集合的雜湊：批次一律是時間上連續的尾段，最後一則不同即代表新的一批。
 *    雜湊更精確但換不到任何行為差異，只多一份要維護的推導邏輯。
 *
 * 找不到（整批沒有客戶訊息）時回 `null`，呼叫端一律當作「無法判定」而放行。
 */
function batchAnchor(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.sender.type === 'customer') return m.id
  }
  return null
}

// ── JOIN 界線（specs/003-analysis-trigger-policy 決策 3、FR-012）───────────────────

/**
 * 「這個對話還有沒有人 JOIN」的解析器。
 *
 * ⚠️ **本檔 MUST NOT 直接 import `copilot-runtime.ts`**（那裡才拿得到 `messageSource`）：
 *    它經 `server/utils/imbrace-client.ts` 用到 Nitro auto-import 的 `useRuntimeConfig()`，
 *    一旦被 `test/` 透過本檔間接拉進型別圖，`tsconfig.scripts.json` 會整份紅
 *    —— 那份設定檔開頭已經把這個陷阱寫成警告。因此相依方向反過來：
 *    由 `copilot-runtime.ts` 在載入時呼叫 `setJoinedResolver()` 注入進來。
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

// ── 同區塊併發去重（specs/003-analysis-trigger-policy §3、FR-009）──────────────────
//
// ⚠️ 粒度 MUST 是「對話 ＋ 區塊」，MUST NOT 是「對話」：三個區塊本來就是 `Promise.all`
//    併行的（`runColdStart()`／`runIncremental()`），用對話粒度會把它們串成序列，
//    直接拖慢 002 SC-001 的 3 秒／10 秒門檻。
//
// ⚠️ MUST NOT 與上面的 `stateLocks` 合併：那份保護的是**狀態寫入**不互相覆蓋，
//    粒度是整個對話，而且它會把兩份分析**依序都跑完** —— 那是序列化，不是去重。

/** 鍵：`${conversationId}:${block}` */
const analysisInFlight = new Map<string, Promise<void>>()
/** 同鍵。標記「這次跑完後還要再跑一次」——旗標而非佇列 */
const analysisRerunPending = new Set<string>()

/**
 * 同一個 (對話, 區塊) 同時只跑一份分析；進行中又被觸發時**合併**成「跑完後再跑一次」
 * （FR-009），MUST NOT 直接丟棄。
 *
 * **為何是旗標而非佇列**：合併語意是「至少再跑一次最新的」。累積 N 次觸發就跑 N 次
 * 沒有意義 —— 分析的輸入是當下的狀態，不是被合併掉的那些事件。
 *
 * ⚠️ rerun 的那一次 **MUST 重新過一次失敗批次記憶檢查**（`fn` 自己會查，見各分析入口）。
 *    否則「失敗 → 期間又被觸發 → rerun 無視記憶再跑一次」會在錯誤狀態上多出一輪呼叫，
 *    把 SC-001 的「不超過 1 輪」打破。
 */
async function runBlockDeduped(
  conversationId: string,
  block: AnalysisBlock,
  fn: () => Promise<void>,
): Promise<void> {
  const key = `${conversationId}:${block}`

  const inFlight = analysisInFlight.get(key)
  if (inFlight) {
    analysisRerunPending.add(key)
    return
  }

  const task = (async () => {
    try {
      await fn()
    }
    finally {
      analysisInFlight.delete(key)
    }
  })()
  analysisInFlight.set(key, task)
  await task

  if (analysisRerunPending.delete(key)) await runBlockDeduped(conversationId, block, fn)
}

async function updateAnalysisState(
  conversationId: string,
  mutate: (state: CopilotAnalysisState) => CopilotAnalysisState,
): Promise<CopilotAnalysisState> {
  const prior = stateLocks.get(conversationId) ?? Promise.resolve()
  const task = prior.then(async () => {
    const store = useStateStore()
    const current = await store.getAnalysisState(conversationId) ?? initialState(conversationId)
    const next = mutate(current)
    await store.setAnalysisState(next, ANALYSIS_STATE_TTL_MS)
    return next
  })
  // 用 catch 吸收失敗，避免佇列因單次失敗被永久卡死；但呼叫端仍會拿到原始的 rejection（見下方 return task）
  stateLocks.set(conversationId, task.catch(() => {}))
  return task
}

async function publishBlock(conversationId: string, block: AnalysisBlock, state: CopilotAnalysisState): Promise<void> {
  if (block === 'summary') {
    await useEventBus().publish(conversationTopic(conversationId), {
      type: 'summary.updated',
      conversationId,
      summary: state.summaryBlock,
    })
  }
  else if (block === 'sentiment') {
    await useEventBus().publish(conversationTopic(conversationId), {
      type: 'sentiment.updated',
      conversationId,
      sentiment: state.sentimentBlock,
    })
  }
  else {
    await useEventBus().publish(conversationTopic(conversationId), {
      type: 'suggestion.updated',
      conversationId,
      suggestion: state.suggestionBlock,
    })
  }
}

/**
 * ⚠️ 憲法 1.5：僅記 conversationId、失敗分類、錯誤類別與 HTTP 狀態碼——這些都不是
 * 訊息內容，不違反「日誌不得輸出訊息全文」。多記這一點細節是為了能分辨「逾時」
 * 「平台回錯誤狀態碼」「輸出格式不符」這三種完全不同的成因，只有 kind 分不出來
 * （三者常常同樣被歸類為 transient 或 permanent）。
 */
function logFailure(conversationId: string, block: AnalysisBlock, kind: FailureKind, err: unknown): void {
  const cause = err instanceof RetryExhaustedError ? err.cause : err
  const detail = cause instanceof AIProviderHttpError
    ? `AIProviderHttpError(status=${cause.statusCode})`
    : cause instanceof AICallTimeoutError
      ? 'AICallTimeoutError'
      : cause instanceof AIOutputValidationError
        ? 'AIOutputValidationError'
        : cause instanceof Error ? cause.constructor.name : typeof cause
  const attempts = err instanceof RetryExhaustedError ? `，已重試 ${err.retryAttempt} 次` : ''
  console.error(`[copilot-analysis] ${conversationId} ${block} 分析失敗（${kind}／${detail}${attempts}）`)
}

// ── 步驟①：進入 analyzing，保留舊內容（呈現規則，data-model.md）──────────

/**
 * ⚠️ **這裡 MUST NOT 清除失敗批次記憶**（specs/003-analysis-trigger-policy data-model.md §1）。
 *    直覺上會想寫在這裡（「開始分析就清掉」），但本函式是每次分析的**共同入口**，
 *    包含那些「被記憶擋下之前就已排入」的分析 —— 寫在這裡會讓 FR-006 完全失效，
 *    而且測試全綠、型別全過，只有真實故障時呼叫量不降反升。
 *    記憶只在「有理由相信這次會不一樣」時才清：手動重試（FR-008）、冷啟動（FR-015）、分析成功。
 */
async function beginAnalyzing(conversationId: string, block: AnalysisBlock): Promise<void> {
  const next = await updateAnalysisState(conversationId, (state) => {
    const at = nowIso()
    if (block === 'summary') {
      return { ...state, summaryBlock: { ...state.summaryBlock, status: 'analyzing' as const, firstFailureAt: undefined, retryAttempt: undefined, updatedAt: at } }
    }
    if (block === 'sentiment') {
      return { ...state, sentimentBlock: { ...state.sentimentBlock, status: 'analyzing' as const, firstFailureAt: undefined, retryAttempt: undefined, updatedAt: at } }
    }
    return { ...state, suggestionBlock: { ...state.suggestionBlock, status: 'analyzing' as const, firstFailureAt: undefined, retryAttempt: undefined, updatedAt: at } }
  })
  await publishBlock(conversationId, block, next)
}

async function publishRetrying(
  conversationId: string,
  block: AnalysisBlock,
  info: { attempt: number, firstFailureAt: string },
): Promise<void> {
  const next = await updateAnalysisState(conversationId, (state) => {
    const at = nowIso()
    if (block === 'summary') {
      return {
        ...state,
        summaryBlock: {
          ...state.summaryBlock,
          status: 'retrying' as const,
          retryAttempt: info.attempt,
          firstFailureAt: info.firstFailureAt,
          updatedAt: at,
        },
      }
    }
    if (block === 'sentiment') {
      return {
        ...state,
        sentimentBlock: {
          ...state.sentimentBlock,
          status: 'retrying' as const,
          retryAttempt: info.attempt,
          firstFailureAt: info.firstFailureAt,
          updatedAt: at,
        },
      }
    }
    return {
      ...state,
      suggestionBlock: {
        ...state.suggestionBlock,
        status: 'retrying' as const,
        retryAttempt: info.attempt,
        firstFailureAt: info.firstFailureAt,
        updatedAt: at,
      },
    }
  })
  await publishBlock(conversationId, block, next)
}

/**
 * @param batchLastMessageId 這一批的判定鍵（`batchAnchor()`）。**MUST 由呼叫端傳入** ——
 *   本函式看不到那一批訊息。為 `null` 時**不寫入**失敗批次記憶：沒有可判定的批次，
 *   寧可下次再試一次，也不要用一個假的鍵擋住未來的分析（data-model.md §1）。
 */
async function finishBlockError(
  conversationId: string,
  block: AnalysisBlock,
  err: unknown,
  batchLastMessageId: string | null,
): Promise<void> {
  const kind: FailureKind = err instanceof RetryExhaustedError ? err.kind : 'permanent'
  const firstFailureAt = err instanceof RetryExhaustedError ? err.firstFailureAt : nowIso()
  logFailure(conversationId, block, kind, err)

  const next = await updateAnalysisState(conversationId, (input) => {
    // FR-005：記下「這個區塊、這一批」失敗了。同一批再次失敗（手動重試也失敗）時 count 遞增。
    const state = batchLastMessageId === null ? input : markFailedBatch(input, block, batchLastMessageId)
    const at = nowIso()
    if (block === 'summary') {
      return {
        ...state,
        summaryBlock: {
          ...state.summaryBlock,
          status: 'error' as const,
          retryAttempt: undefined,
          firstFailureAt,
          updatedAt: at,
        },
      }
    }
    if (block === 'sentiment') {
      return {
        ...state,
        sentimentBlock: {
          ...state.sentimentBlock,
          status: 'error' as const,
          retryAttempt: undefined,
          firstFailureAt,
          updatedAt: at,
        },
      }
    }
    return {
      ...state,
      suggestionBlock: {
        ...state.suggestionBlock,
        status: 'error' as const,
        retryAttempt: undefined,
        firstFailureAt,
        updatedAt: at,
      },
    }
  })
  await publishBlock(conversationId, block, next)
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

    try {
      const outcome = await withRetry(
        async () => parseConversationSummary(await useAIProvider().summarize(input)),
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

async function finishSentimentSuccess(
  conversationId: string,
  newPoints: SentimentPoint[],
  markers: Message[],
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
      sentimentBlock: {
        status: 'ready' as const,
        timeline,
        stats: computeStats(timeline),
        retryAttempt: undefined,
        firstFailureAt: undefined,
        updatedAt: nowIso(),
      },
    }
  })
  await publishBlock(conversationId, 'sentiment', next)
}

async function analyzeSentimentBatch(conversationId: string, messages: Message[]): Promise<void> {
  const textMessages = messages.filter(isTextCustomerMessage)
  const markerMessages = messages.filter(isAttachmentOnlyCustomerMessage)

  if (textMessages.length === 0) {
    // 純附件輪不呼叫模型，因此不受失敗批次記憶約束 —— 它不會失敗，也不該被擋
    if (markerMessages.length > 0) await mergeMarkersOnly(conversationId, markerMessages)
    return
  }

  await runBlockDeduped(conversationId, 'sentiment', async () => {
    const anchor = batchAnchor(messages)
    if (await isBatchAlreadyFailed(conversationId, 'sentiment', anchor)) return

    await beginAnalyzing(conversationId, 'sentiment')

    try {
      const allPoints: SentimentPoint[] = []
      // 依序處理每一小批（見 SENTIMENT_CHUNK_SIZE 的說明）——刻意不平行送出，
      // 避免對話很長時一次對同一個 agent 開幾十條並發請求。
      for (const part of chunk(textMessages, SENTIMENT_CHUNK_SIZE)) {
        const outcome = await withRetry(
          async () => parseSentimentPoints(await useAIProvider().analyzeSentiment({ messages: part })),
          { onRetry: info => publishRetrying(conversationId, 'sentiment', info) },
        )
        allPoints.push(...outcome.value)
      }
      await finishSentimentSuccess(conversationId, allPoints, markerMessages)
    }
    catch (err) {
      await finishBlockError(conversationId, 'sentiment', err, anchor)
    }
  })
}

// ── 建議卡（specs/002-suggestion-knowledge-search）──────────────────────

/**
 * FR-003、憲法 4.3：`sopId` 非 null 時必須存在於呼叫當下 `knowledgeHits` 的 `id` 集合，
 * 否則**整卡捨棄**（不只清空 `sopId`）——那是模型杜撰引用，不是格式問題（research.md #6）。
 */
export function whitelistFilter(cards: SuggestionCard[], hits: KnowledgeHit[]): SuggestionCard[] {
  const validIds = new Set(hits.map(h => h.id))
  return cards.filter(c => c.sopId === null || validIds.has(c.sopId))
}

/**
 * 憲法 4.4、FR-002：`knowledgeHits` 全數 `score === null` 時（iMBrace 路徑恆如此），
 * `confidence` MUST 被覆寫為 `null`——Zod 的 `.nullable()` 擋不住模型自評的數字，
 * 只靠 prompt 交代等同沒有規則，因此抽成純函式在寫入前強制執行。
 */
export function forceNullConfidence(cards: SuggestionCard[], hits: KnowledgeHit[]): SuggestionCard[] {
  if (!hits.every(h => h.score === null)) return cards
  return cards.map(c => (c.confidence === null ? c : { ...c, confidence: null }))
}

// ── 建議卡搶答判定（FR-015、US4 AC#2）───────────────────────────────────

/** 字元二連 gram 集合——中文多半無空白可斷詞，退而求其次用字元層級比對 */
function charBigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2))
  return grams
}

/**
 * 兩段文字的重疊比例（交集大小 / 較短一方的 gram 數）——刻意不用 Jaccard（交集/聯集），
 * 那會讓「同事的回覆比建議卡長很多但完整包含其內容」被稀釋成低相似度，
 * 而那正是最常見的搶答情境（同事的回覆通常比建議卡措辭更完整）。
 */
function overlapRatio(a: string, b: string): number {
  const A = charBigrams(a)
  const B = charBigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let intersection = 0
  for (const g of A) if (B.has(g)) intersection++
  return intersection / Math.min(A.size, B.size)
}

/** spec.md Assumptions 允許簡單的關鍵詞重疊／相似度比對——判定方式留待實作決定 */
const SUPERSEDE_OVERLAP_THRESHOLD = 0.6

/**
 * 標記與 `reply` 內容明顯重複的既有卡片（FR-015）。已標記過的卡片不重複覆蓋
 * （保留最先搶答者的紀錄）。內容不重疊時回傳原陣列（同一參照），供呼叫端判斷是否需要發布。
 */
export function markSupersededCards(
  cards: SuggestionCard[],
  reply: { kind: 'agent' | 'ai', messageId: string, text: string },
): SuggestionCard[] {
  let changed = false
  const next = cards.map((c) => {
    if (c.supersededBy) return c
    if (overlapRatio(c.text, reply.text) < SUPERSEDE_OVERLAP_THRESHOLD) return c
    changed = true
    return { ...c, supersededBy: { kind: reply.kind, messageId: reply.messageId } }
  })
  return changed ? next : cards
}

/**
 * 同事回覆或（Hybrid 模式下）AI 自動回覆抵達時，檢查既有建議卡是否已被搶答（US4 AC#2）。
 * ⚠️ AI workflow 的內部訊息（`isWorkflowInternalMessage()`）不算「已回覆」，
 *    比照撞單檢查的排除原則（憲法 6.5）——客戶根本收不到那則訊息。
 */
export async function checkSuggestionsSuperseded(conversationId: string, messages: Message[]): Promise<void> {
  const replies = messages.filter(m =>
    (m.sender.type === 'agent' || m.sender.type === 'ai')
    && !(m.sender.type === 'ai' && isWorkflowInternalMessage(m)),
  )
  if (replies.length === 0) return

  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state || state.suggestionBlock.cards.length === 0) return

  let cards = state.suggestionBlock.cards
  for (const reply of replies) {
    cards = markSupersededCards(cards, { kind: reply.sender.type as 'agent' | 'ai', messageId: reply.id, text: reply.text })
  }
  if (cards === state.suggestionBlock.cards) return

  const next = await updateAnalysisState(conversationId, s => ({
    ...s,
    suggestionBlock: { ...s.suggestionBlock, cards, updatedAt: nowIso() },
  }))
  await publishBlock(conversationId, 'suggestions', next)
}

// ── 兩段式的執行期控制流（specs/004-progressive-citations data-model.md §4）──────
//
// ⚠️ 這一整段是 server-only 的**控制流**狀態，MUST NOT 進 `CopilotAnalysisState` ——
//    進了 state 就會隨 `publishBlock()` 送出的整個 block 流到瀏覽器
//    （`test/contract-guards.test.ts` 有守衛擋 `shared/` 出現這些名字）。

/**
 * 第二段（帶知識庫命中重新生成）的單次呼叫逾時。
 *
 * ✅ **2026-08-29 裁決為 20 秒**（004 research.md #5）。第二段一律 `maxRetries: 0`，
 * **不進重試迴圈**，因此改這個數字不牽動 001 FR-014 的 15s／1s→4s／40s 三數綁定，
 * 兩者沒有耦合 —— MUST NOT 因為「統一」而把這裡改成 15 秒。
 *
 * 為什麼不是 15 秒：建議卡生成實測最慢 13.0 秒，15 秒只剩 13% 餘裕；平台漂移 36% 就會逾時，
 * 而第二段逾時是**靜默**落成 `citation: 'none'`（依 FR-003 不轉 error、不顯示重試中），
 * 客服只會看到「未引用知識庫」而沒有任何異常跡象 —— 直接侵蝕 SC-002 的「≥ 90% 取得引用」。
 */
const SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 20_000

/** 第一段的落定結果 —— 尾巴在落定 `citation` 之前 MUST 先等它（FR-003a ①） */
type Stage1Result =
  | { kind: 'landed' } // 已發布 ready/pending（cards 可能為空）
  | { kind: 'failed' } // 已 finishBlockError()，區塊為 error
  | { kind: 'aborted' } // 被 stage1Abort 取消，區塊仍停在 analyzing／retrying

interface SuggestionTail {
  /** 每次 `analyzeSuggestionsOnce()` 啟動 +1；過期判定的**唯一**依據 */
  generation: number
  /**
   * ⚠️ **兩個 controller MUST NOT 合併成一個**（data-model.md §4）。觸發者與標的相反：
   *   - `stage1Abort`：由**第二段自己**在成功路徑上（檢索有命中時）觸發，標的是第一段
   *     尚未送出的重試（FR-006a）
   *   - `tailAbort`：由**外部**（新世代、`cancelPendingAnalysis()` ＝ LEAVE）觸發，
   *     標的是尚未送出的第二段呼叫
   * 共用一個的後果是：第二段一開始就把它 abort 掉，之後 LEAVE 再 abort 完全是 no-op ——
   * 第二段的 AI 呼叫照送、錢照付、結果無人看，而且**不會有任何錯誤**。
   */
  stage1Abort: AbortController
  tailAbort: AbortController
  /** 第二段已寫入；同世代後到的第一段結果 MUST NOT 覆蓋它（FR-006a） */
  citedLanded: boolean
  stage1Settled: Promise<Stage1Result>
  /** 由第一段的三條出口之一呼叫。**三條都要**，漏一條尾巴會永遠掛在 await 上而不報錯 */
  settleStage1: (result: Stage1Result) => void
  /** 尾巴結束（成功、放棄、丟棄皆算）；`awaitSuggestionTail()` 供測試等待 */
  done: Promise<void>
  finishTail: () => void
  /** research.md #3 的檢索備忘 —— FR-005「命中已在手」用 */
  lastRetrieval?: { anchor: string | null, hits: KnowledgeHit[], at: string }
  /**
   * FR-015：第二段等待期間抵達的同事／AI 回覆，由 `checkSuggestionsSuperseded()` 在
   * **訊息抵達當下**追加（它那一刻手上正拿著回覆全文，且已做完 workflow-internal 過濾）。
   * 第二段整批換卡前重放，否則同事已回過的建議會以未標記的新卡復活（憲法 7.2）。
   * ⚠️ MUST NOT 改由分析函式手上的 `input.history` 推導 —— 那份資料裡沒有同事回覆（§8）。
   */
  repliesDuringTail: { kind: 'agent' | 'ai', messageId: string, text: string }[]
}

const suggestionTails = new Map<string, SuggestionTail>()

/**
 * 尾巴的結束 Promise，**與登記本身分開存放**：`cancelPendingAnalysis()`（LEAVE）會把登記
 * 整筆刪掉，但那一刻尾巴本身可能還在 `await retrieval`。測試要能等到它真的收工，
 * 才問得出「第二段有沒有被送出」。尾巴自己在 finally 移除，因此只會留下進行中的那些。
 */
const suggestionTailDone = new Map<string, Promise<void>>()

/**
 * 開一個新世代：舊尾巴的第二段就此作廢（abort 尚未送出的呼叫），並換上全新的兩個 controller。
 *
 * ⚠️ 過期判定一律比對 `generation`，**MUST NOT 用 `basedOnMessageId`**（research.md #2）：
 *    手動重試會用同一個錨點再跑一次，錨點比對會放行舊尾巴覆蓋新結果，而且不會報錯。
 */
function nextSuggestionGeneration(conversationId: string): SuggestionTail {
  const prev = suggestionTails.get(conversationId)
  prev?.tailAbort.abort()

  let settleStage1: (result: Stage1Result) => void
  const stage1Settled = new Promise<Stage1Result>((resolve) => {
    settleStage1 = resolve
  })
  let finishTail: () => void
  const done = new Promise<void>((resolve) => {
    finishTail = resolve
  })

  const tail: SuggestionTail = {
    generation: (prev?.generation ?? 0) + 1,
    stage1Abort: new AbortController(),
    tailAbort: new AbortController(),
    citedLanded: false,
    stage1Settled,
    settleStage1: settleStage1!,
    done,
    finishTail: finishTail!,
    // 檢索備忘刻意**沿用**上一筆：FR-005 的「命中已在手」判斷靠它，
    // 而手動重試正是新世代——這裡清掉會讓那條路徑永遠走不到。
    lastRetrieval: prev?.lastRetrieval,
    repliesDuringTail: [],
  }
  suggestionTails.set(conversationId, tail)
  suggestionTailDone.set(conversationId, done)
  return tail
}

/** 這個對話現在有沒有尾巴在跑 —— 重連快照用來分辨「pending 還有人接手」與「程序重啟後的孤兒」 */
export function hasSuggestionTail(conversationId: string): boolean {
  return suggestionTails.has(conversationId)
}

/**
 * ⚠️ **僅供測試**：等待這個對話最後一次尾巴收工。正式路徑上沒有人需要等第二段 ——
 * 它就是為了「不讓任何人等」才被放到鎖外的。
 */
export function awaitSuggestionTail(conversationId: string): Promise<void> {
  return suggestionTailDone.get(conversationId) ?? Promise.resolve()
}

/** 這個世代還是不是最新的？不是就整個丟棄，一個字都不要寫回 state */
function isCurrentGeneration(conversationId: string, tail: SuggestionTail): boolean {
  return suggestionTails.get(conversationId)?.generation === tail.generation
}

// ── 建議卡的共用工具（004 T010）────────────────────────────────────────

/**
 * 一次「生成 → 驗證 → 白名單 → confidence 歸零」。兩段共用，順序與 002 相同（憲法 4.2～4.4）。
 *
 * ⚠️ **白名單集合是本次呼叫傳入的 `hits`**（data-model.md §7）：第一段是空集合（因此任何
 *    `sopId !== null` 的卡都會被整卡捨棄，那是既有行為），第二段是**第二段呼叫當下**的命中。
 *    第二段若沿用第一段的空集合，所有帶 `sopId` 的卡會被整卡捨棄、畫面永遠看不到引用，
 *    而 `status` 仍是 `ready` —— 不報錯。
 */
async function generateSuggestionCards(
  input: { history: Message[], aiReplies: boolean },
  hits: KnowledgeHit[],
  opts: {
    maxRetries?: number
    callTimeoutMs?: number
    onRetry?: WithRetryOptions['onRetry']
    signal?: AbortSignal
  },
): Promise<{ cards: SuggestionCard[], retryAttempt: number }> {
  const outcome = await withRetry(
    async () => parseSuggestionCards(await useAIProvider().suggest({
      history: input.history,
      knowledgeHits: hits,
      // ⚠️ 兩段都要帶（002 FR-016）。第二段漏帶會讓 Hybrid 模式下的補位提示在第二段消失。
      aiReplies: input.aiReplies,
    })),
    {
      maxRetries: opts.maxRetries,
      callTimeoutMs: opts.callTimeoutMs,
      onRetry: opts.onRetry,
      signal: opts.signal,
    },
  )

  const whitelisted = whitelistFilter(outcome.value, hits)
  return { cards: forceNullConfidence(whitelisted, hits), retryAttempt: outcome.retryAttempt }
}

/** 落地一批卡並推播。`clearFailedBatch()` 一併做掉——這批有結果了，失敗記憶沒有存在意義 */
async function publishSuggestionReady(
  conversationId: string,
  args: {
    cards: SuggestionCard[]
    knowledgeSearch: { ran: boolean, hitCount: number }
    citation: 'pending' | 'cited' | 'none'
    basedOnMessageId: string | null
    provenance: { stage: 1 | 2, stage1RetryAttempt: number }
  },
): Promise<void> {
  const next = await updateAnalysisState(conversationId, state => ({
    ...clearFailedBatch(state, 'suggestions'),
    suggestionBlock: {
      status: 'ready' as const,
      cards: args.cards,
      knowledgeSearch: args.knowledgeSearch,
      citation: args.citation,
      basedOnMessageId: args.basedOnMessageId,
      provenance: args.provenance,
      retryAttempt: undefined,
      firstFailureAt: undefined,
      updatedAt: nowIso(),
    },
  }))
  await publishBlock(conversationId, 'suggestions', next)
}

async function analyzeSuggestions(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  strategy: SuggestionStrategy,
): Promise<void> {
  await runBlockDeduped(conversationId, 'suggestions', () => analyzeSuggestionsOnce(conversationId, input, strategy))
}

/**
 * 建議卡的兩種執行策略（004 FR-001／FR-013）。
 *
 * ⚠️ 參數名 MUST 是 `strategy`，**不是 `mode`**：`mode` 在本專案是對話服務模式的受控字彙
 *    （`manual`／`hybrid`／`automation`，CLAUDE.md 列為靜默失效地雷之一），而同一支函式的
 *    輸入正帶著由它推導出的 `aiReplies`。同一段程式碼裡兩個 `mode` 指不同東西是找麻煩。
 *
 *   - `'progressive'`：前景兩段式——第一段不帶知識庫先落地（`pending`），檢索有命中時
 *     第二段整批換上（`cited`）
 *   - `'single'`：等檢索完成再一次生成（背景對話 FR-013、命中已在手 FR-005）
 */
type SuggestionStrategy = 'progressive' | 'single'

async function analyzeSuggestionsOnce(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  strategy: SuggestionStrategy,
): Promise<void> {
  const anchor = batchAnchor(input.history)
  if (await isBatchAlreadyFailed(conversationId, 'suggestions', anchor)) return

  await beginAnalyzing(conversationId, 'suggestions')

  const query = input.history
    .filter(isTextCustomerMessage)
    .map(m => m.text)
    .join('\n')

  // ⚠️ Phase 2 過渡狀態：`'progressive'` 由 T013 實作，此刻沒有任何呼叫端會傳它。
  await runSingleStage(conversationId, input, { anchor, query })
}

/**
 * 單段：等檢索完成，再以命中結果一次生成（背景對話 FR-013、命中已在手 FR-005）。
 *
 * @param presetHits 已完成的檢索結果（FR-005 的備忘）。有值時 MUST NOT 再發一次檢索——
 *   同一批訊息、同一個 query，知識庫在數十秒內不會改變。
 */
async function runSingleStage(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  ctx: { anchor: string | null, query: string, presetHits?: KnowledgeHit[] },
): Promise<void> {
  let knowledgeHits: KnowledgeHit[] = ctx.presetHits ?? []
  if (!ctx.presetHits) {
    try {
      // ⚠️ **2026-08-29（004 FR-003）**：與快查共用 `KNOWLEDGE_SEARCH_TIMEOUT_MS`。
      //    原本這裡帶的是建議卡專用的 8 秒短逾時常數（已刪除），理由是保護
      //    「先檢索再生成」這條**串行**路徑的門檻；而實測檢索最快 9.4 秒，
      //    那個上限等於建議卡永遠拿不到引用。MUST NOT 為建議卡另立第二個逾時值。
      knowledgeHits = await useKnowledgeProvider().search(ctx.query, {
        topK: 5,
        timeoutMs: KNOWLEDGE_SEARCH_TIMEOUT_MS,
      })
    }
    catch (err) {
      // FR-004：檢索失敗時以空集合續行（誠實降級，非整塊轉 error）——
      // 憲法 6.2 禁止的是「略過檢索」，不是「結果是空的」
      console.error(`[copilot-analysis] ${conversationId} 知識庫檢索失敗，改以無引用續行:`, err instanceof Error ? err.message : String(err))
    }
  }
  // 檢索呼叫**送出後**即視為已跑過，無論結果多寡或是否拋錯 —— 憲法 6.2 要求的可稽核證據
  const knowledgeSearch = { ran: true, hitCount: knowledgeHits.length }

  try {
    const { cards } = await generateSuggestionCards(input, knowledgeHits, {
      onRetry: info => publishRetrying(conversationId, 'suggestions', info),
    })

    await publishSuggestionReady(conversationId, {
      cards,
      knowledgeSearch,
      citation: knowledgeHits.length > 0 ? 'cited' : 'none',
      basedOnMessageId: ctx.anchor,
      // 單段沒有第一段，`stage1RetryAttempt` 恆為 0（data-model.md §1）
      provenance: { stage: 2, stage1RetryAttempt: 0 },
    })
  }
  catch (err) {
    await finishBlockError(conversationId, 'suggestions', err, ctx.anchor)
  }
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
    analyzeSuggestions(conversationId, { history, aiReplies }, 'single'),
  ])
}

/**
 * 背景並行節流（憲法 6.2、specs/002-suggestion-knowledge-search research.md #9）——
 * 同時進行背景重算的對話數量上限；globalThis-keyed 是為了比照既有單例的 HMR 安全模式，
 * 這份狀態本質類似 `debounceTimers`：純執行期狀態，程序重啟後全部中斷重來也無妨。
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
        analyzeSentimentBatch(conversationId, newCustomerMessages),
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
    analyzeSentimentBatch(conversationId, newCustomerMessages),
    analyzeSuggestions(conversationId, { history: newCustomerMessages, aiReplies }, 'single'),
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
    await analyzeSuggestions(conversationId, { history, aiReplies }, 'single')
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
  // ① abort：沒有人 JOIN 的對話不該再花第二段的錢（003 FR-013 的延伸）。
  // ② delete：`lastRetrieval` 備忘的唯一用途是手動重試（FR-005），而 LEAVE 之後
  //    沒有人能按重試，備忘從那一刻起就沒有意義。不刪的話這個 Map 會隨程序生命週期
  //    逐對話累積，每筆還帶著知識庫全文片段 —— 對照 `CopilotAnalysisState` 有 2 小時
  //    sliding TTL，它會是唯一沒有任何回收機制的狀態。
  const tail = suggestionTails.get(conversationId)
  if (tail) {
    tail.tailAbort.abort()
    suggestionTails.delete(conversationId)
  }

  const pending = debounceTimers.get(conversationId)
  if (!pending) return
  clearTimeout(pending.timer)
  debounceTimers.delete(conversationId)
}
