/**
 * 摘要／情緒分析管線 —— specs/001-sentiment-panel/plan.md、data-model.md。
 *
 * 冷啟動（JOIN）與增量（新客戶發言）共用同一套邏輯：
 *   ① 呼叫 AIProvider 前先把該區塊標為 'analyzing' 並立即 publish（不等待 AI 呼叫），
 *      對應 FR-011／SC-001——沒有這一步，客服要等 AI 呼叫完成（5～12.2 秒）才會看到任何反應。
 *   ② 純附件（無文字）客戶發言過濾為 SentimentMarker，不送模型（FR-002、FR-012）。
 *   ③ 經 withRetry() 呼叫 AIProvider（server/services/ai/retry-policy.ts，FR-014）。
 *   ④ 經 Zod schema 驗證輸出（憲法 4.2，server/services/ai/schemas.ts）。
 *   ⑤ 依全量 timeline 重新計算 sentimentBlock.stats（FR-015，不受最近 50 點顯示上限影響）。
 *   ⑥ 寫回 CopilotAnalysisState（與 CopilotSession 是不同物件，見 server/state/types.ts）。
 *   ⑦ publish 最終結果事件；錯誤記錄僅留 conversationId 與失敗分類（憲法 1.5，research.md #6）。
 */

import type { Message } from '../../shared/types/conversation.js'
import type {
  ConversationSummary,
  SentimentMarker,
  SentimentPoint,
  SentimentTimelineEntry,
} from '../../shared/types/copilot.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic } from '../state/types.js'
import type { CopilotAnalysisState } from '../state/types.js'
import { useAIProvider } from './ai/index.js'
import type { FailureKind } from './ai/retry-policy.js'
import { RetryExhaustedError, withRetry } from './ai/retry-policy.js'
import { parseConversationSummary, parseSentimentPoints } from './ai/schemas.js'

export type AnalysisBlock = 'summary' | 'sentiment'

/** sliding TTL：每次讀取或寫入皆續期。見 data-model.md「CopilotAnalysisState」生命週期一節 */
const ANALYSIS_STATE_TTL_MS = 2 * 60 * 60 * 1000

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
 *    async function 呼叫本身一定會讓出至少一個 microtask —— 摘要／情緒兩個區塊
 *    透過 `Promise.all()` 並行執行時，若不序列化，兩者的 read-modify-write 會交錯，
 *    後寫入者會拿著「對方尚未更新前」的舊快照覆蓋回去，把對方剛寫入的欄位悄悄復原。
 *    因此同一個 conversationId 的所有更新一律排進同一條佇列，逐一執行。
 */
const stateLocks = new Map<string, Promise<unknown>>()

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
  else {
    await useEventBus().publish(conversationTopic(conversationId), {
      type: 'sentiment.updated',
      conversationId,
      sentiment: state.sentimentBlock,
    })
  }
}

/** ⚠️ 憲法 1.5：僅記 conversationId 與失敗分類，不得輸出訊息全文或 drivers（research.md #6） */
function logFailure(conversationId: string, block: AnalysisBlock, kind: FailureKind): void {
  console.error(`[copilot-analysis] ${conversationId} ${block} 分析失敗（${kind}）`)
}

// ── 步驟①：進入 analyzing，保留舊內容（呈現規則，data-model.md）──────────

async function beginAnalyzing(conversationId: string, block: AnalysisBlock): Promise<void> {
  const next = await updateAnalysisState(conversationId, (state) => {
    const at = nowIso()
    // firstFailureAt／retryAttempt 僅在 status ∈ {retrying, error} 時有值（data-model.md）——
    // 這是一次全新的嘗試（含手動重試 error → analyzing），上一輪失敗序列的時間戳不再適用，
    // 否則殘留的舊 firstFailureAt 會讓前端／測試誤以為本輪早就逾了 40 秒預算。
    return block === 'summary'
      ? { ...state, summaryBlock: { ...state.summaryBlock, status: 'analyzing' as const, firstFailureAt: undefined, retryAttempt: undefined, updatedAt: at } }
      : { ...state, sentimentBlock: { ...state.sentimentBlock, status: 'analyzing' as const, firstFailureAt: undefined, retryAttempt: undefined, updatedAt: at } }
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
    return block === 'summary'
      ? {
          ...state,
          summaryBlock: {
            ...state.summaryBlock,
            status: 'retrying' as const,
            retryAttempt: info.attempt,
            firstFailureAt: info.firstFailureAt,
            updatedAt: at,
          },
        }
      : {
          ...state,
          sentimentBlock: {
            ...state.sentimentBlock,
            status: 'retrying' as const,
            retryAttempt: info.attempt,
            firstFailureAt: info.firstFailureAt,
            updatedAt: at,
          },
        }
  })
  await publishBlock(conversationId, block, next)
}

async function finishBlockError(conversationId: string, block: AnalysisBlock, err: unknown): Promise<void> {
  const kind: FailureKind = err instanceof RetryExhaustedError ? err.kind : 'permanent'
  const firstFailureAt = err instanceof RetryExhaustedError ? err.firstFailureAt : nowIso()
  logFailure(conversationId, block, kind)

  const next = await updateAnalysisState(conversationId, (state) => {
    const at = nowIso()
    return block === 'summary'
      ? {
          ...state,
          summaryBlock: {
            ...state.summaryBlock,
            status: 'error' as const,
            retryAttempt: undefined,
            firstFailureAt,
            updatedAt: at,
          },
        }
      : {
          ...state,
          sentimentBlock: {
            ...state.sentimentBlock,
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

  await beginAnalyzing(conversationId, 'summary')

  try {
    const outcome = await withRetry(
      async () => parseConversationSummary(await useAIProvider().summarize(input)),
      { onRetry: info => publishRetrying(conversationId, 'summary', info) },
    )

    const next = await updateAnalysisState(conversationId, state => ({
      ...state,
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
    await finishBlockError(conversationId, 'summary', err)
  }
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
      ...state,
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
    if (markerMessages.length > 0) await mergeMarkersOnly(conversationId, markerMessages)
    return
  }

  await beginAnalyzing(conversationId, 'sentiment')

  try {
    const outcome = await withRetry(
      async () => parseSentimentPoints(await useAIProvider().analyzeSentiment({ messages: textMessages })),
      { onRetry: info => publishRetrying(conversationId, 'sentiment', info) },
    )
    await finishSentimentSuccess(conversationId, outcome.value, markerMessages)
  }
  catch (err) {
    await finishBlockError(conversationId, 'sentiment', err)
  }
}

// ── 對外入口 ──────────────────────────────────────────────────────────

/** JOIN 冷啟動（T013）：送交模型全量歷史，兩區塊各自獨立分析並可各自先行顯示（FR-011） */
export async function runColdStart(conversationId: string, history: Message[]): Promise<void> {
  await ensureState(conversationId)
  // FR-009：客戶尚無任何發言（含純附件）時維持 empty，不呼叫 AI
  if (!history.some(m => m.sender.type === 'customer')) return

  await Promise.all([
    analyzeSummary(conversationId, { history, previousSummary: undefined }),
    analyzeSentimentBatch(conversationId, history),
  ])
}

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
 */
export async function runIncremental(conversationId: string, newCustomerMessages: Message[]): Promise<void> {
  if (newCustomerMessages.length === 0) return
  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state) return

  await Promise.all([
    analyzeSummary(conversationId, {
      history: newCustomerMessages,
      previousSummary: state.summaryBlock.summary ?? undefined,
    }),
    analyzeSentimentBatch(conversationId, newCustomerMessages),
  ])
}

/**
 * 手動重試單一區塊（FR-008，server/api/conversations/[id]/copilot/retry.post.ts）。
 * 等同冷啟動的該區塊部分：使用全量歷史重新分析，不影響另一區塊（contracts/copilot-retry-api.md）。
 */
export async function retryBlock(conversationId: string, block: AnalysisBlock, history: Message[]): Promise<void> {
  await ensureState(conversationId)
  if (block === 'summary') {
    await analyzeSummary(conversationId, { history, previousSummary: undefined })
  }
  else {
    await analyzeSentimentBatch(conversationId, history)
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

// ── debounce（§11.1）─────────────────────────────────────────────────

const DEBOUNCE_MS = 1_000
const debounceTimers = new Map<string, { timer: ReturnType<typeof setTimeout>, pending: Message[] }>()

/**
 * 新客戶發言的 debounce 聚合入口（§11.1：1 秒內多筆客戶發言合併為單次分析）。
 *
 * ⚠️ 呼叫端（server/services/session-manager.ts 的 onMessages()）負責過濾出
 *    `sender.type === 'customer'` 的訊息（FR-005：客服自己送出的訊息 MUST NOT 觸發重新分析）——
 *    本函式信任呼叫端已過濾，不重複檢查。
 */
export function scheduleIncremental(conversationId: string, customerMessages: Message[]): void {
  if (customerMessages.length === 0) return

  const existing = debounceTimers.get(conversationId)
  const pending = existing ? [...existing.pending, ...customerMessages] : [...customerMessages]
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    debounceTimers.delete(conversationId)
    void runIncremental(conversationId, pending)
  }, DEBOUNCE_MS)
  timer.unref?.()
  debounceTimers.set(conversationId, { timer, pending })
}
