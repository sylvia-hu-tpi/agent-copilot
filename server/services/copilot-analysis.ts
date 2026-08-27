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
import type { CopilotAnalysisState } from '../state/types.js'
import { useAIProvider } from './ai/index.js'
import type { FailureKind } from './ai/retry-policy.js'
import {
  AICallTimeoutError,
  AIOutputValidationError,
  AIProviderHttpError,
  RetryExhaustedError,
  withRetry,
} from './ai/retry-policy.js'
import { parseConversationSummary, parseSentimentPoints, parseSuggestionCards } from './ai/schemas.js'
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
    suggestionBlock: { status: 'empty', cards: [], knowledgeSearch: { ran: false, hitCount: 0 }, updatedAt: at },
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

async function finishBlockError(conversationId: string, block: AnalysisBlock, err: unknown): Promise<void> {
  const kind: FailureKind = err instanceof RetryExhaustedError ? err.kind : 'permanent'
  const firstFailureAt = err instanceof RetryExhaustedError ? err.firstFailureAt : nowIso()
  logFailure(conversationId, block, kind, err)

  const next = await updateAnalysisState(conversationId, (state) => {
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
    await finishBlockError(conversationId, 'sentiment', err)
  }
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

async function analyzeSuggestions(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
): Promise<void> {
  await beginAnalyzing(conversationId, 'suggestions')

  const query = input.history
    .filter(isTextCustomerMessage)
    .map(m => m.text)
    .join('\n')

  let knowledgeHits: KnowledgeHit[] = []
  try {
    knowledgeHits = await useKnowledgeProvider().search(query, { topK: 5 })
  }
  catch (err) {
    // FR-004：檢索失敗時以空集合續行（誠實降級，非整塊轉 error）——
    // 憲法 6.2 v3.0.1 禁止的是「略過檢索」，不是「結果是空的」
    console.error(`[copilot-analysis] ${conversationId} 知識庫檢索失敗，改以無引用續行:`, err instanceof Error ? err.message : String(err))
  }
  // 檢索呼叫**送出後**即視為已跑過，無論結果多寡或是否拋錯 —— 憲法 6.2 v3.0.1 要求的可稽核證據
  const knowledgeSearch = { ran: true, hitCount: knowledgeHits.length }

  try {
    const outcome = await withRetry(
      async () => parseSuggestionCards(await useAIProvider().suggest({
        history: input.history,
        knowledgeHits,
        aiReplies: input.aiReplies,
      })),
      { onRetry: info => publishRetrying(conversationId, 'suggestions', info) },
    )

    const whitelisted = whitelistFilter(outcome.value, knowledgeHits)
    const cards = forceNullConfidence(whitelisted, knowledgeHits)

    const next = await updateAnalysisState(conversationId, state => ({
      ...state,
      suggestionBlock: {
        status: 'ready' as const,
        cards,
        knowledgeSearch,
        retryAttempt: undefined,
        firstFailureAt: undefined,
        updatedAt: nowIso(),
      },
    }))
    await publishBlock(conversationId, 'suggestions', next)
  }
  catch (err) {
    await finishBlockError(conversationId, 'suggestions', err)
  }
}

// ── 對外入口 ──────────────────────────────────────────────────────────

/** JOIN 冷啟動（T013）：送交模型全量歷史，各區塊各自獨立分析並可各自先行顯示（FR-011） */
export async function runColdStart(conversationId: string, history: Message[], aiReplies: boolean): Promise<void> {
  await ensureState(conversationId)
  // FR-009：客戶尚無任何發言（含純附件）時維持 empty，不呼叫 AI
  if (!history.some(m => m.sender.type === 'customer')) return

  await Promise.all([
    analyzeSummary(conversationId, { history, previousSummary: undefined }),
    analyzeSentimentBatch(conversationId, history),
    analyzeSuggestions(conversationId, { history, aiReplies }),
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

  if (priority === 'background') {
    if (backgroundInFlight.size >= BACKGROUND_CONCURRENCY_LIMIT && !backgroundInFlight.has(conversationId)) {
      scheduleIncremental(conversationId, newCustomerMessages, priority, aiReplies)
      return
    }
    backgroundInFlight.add(conversationId)
    try {
      await Promise.all([
        analyzeSentimentBatch(conversationId, newCustomerMessages),
        analyzeSuggestions(conversationId, { history: newCustomerMessages, aiReplies }),
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
    analyzeSuggestions(conversationId, { history: newCustomerMessages, aiReplies }),
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
  if (block === 'summary') {
    await analyzeSummary(conversationId, { history, previousSummary: undefined })
  }
  else if (block === 'sentiment') {
    await analyzeSentimentBatch(conversationId, history)
  }
  else {
    await analyzeSuggestions(conversationId, { history, aiReplies })
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
