/**
 * @analysis-pipeline （管線成員標記，MUST NOT 刪 —— 理由見 `copilot-analysis.ts` 檔頭）
 *
 * 分析管線的**共用基礎**：狀態讀寫、事件推播、三態轉移、失敗批次記憶。
 *
 * 這一層**不認得任何一個區塊的內容** —— 它只知道 `AnalysisBlock` 這個 union，
 * 不知道摘要長什麼樣、情緒怎麼分批、建議卡有幾段。三個區塊的領域邏輯分別在
 * `copilot-analysis.ts`（摘要／情緒）與 `blocks/suggestion.ts`（建議卡）。
 *
 * ⚠️ **`stateLocks` 是本檔獨有的狀態，MUST NOT 被任何其他檔案碰到。**
 *    它序列化的是「同一個對話的所有 read-modify-write」，一旦有第二個地方
 *    自己 `getAnalysisState()` → 改 → `setAnalysisState()`，那條路就繞過了鎖，
 *    而症狀是「某個區塊剛寫進去的欄位被另一個區塊的舊快照悄悄復原」——
 *    不報錯、不影響型別。要改狀態一律走 `updateAnalysisState()`。
 *
 * ⚠️ 本檔（與整條分析管線）**MUST NOT import `copilot-runtime.ts`**，理由見
 *    `copilot-analysis.ts` 的 `setJoinedResolver()`；`test/contract-guards.test.ts`
 *    掃描整個管線守住這一條。
 *
 * ⚠️ 這裡的 `stateLocks` 是 **process-local** 的 `Map`，不是 `globalThis`-keyed，
 *    也沒有跨副本的對應機制。M4 上多副本時它保護不到另一個副本的寫入
 *    （docs/ARCHITECTURE.md §8.3「多副本部署前 MUST 先換上 Redis 實作」）。
 */

import type { Message } from '../../shared/types/conversation.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic } from '../state/types.js'
import type { CopilotAnalysisState, FailedBatch } from '../state/types.js'
import type { FailureKind } from './ai/retry-policy.js'
import {
  AICallTimeoutError,
  AIOutputValidationError,
  AIProviderHttpError,
  RetryExhaustedError,
} from './ai/retry-policy.js'

export type AnalysisBlock = 'summary' | 'sentiment' | 'suggestions'

/** sliding TTL：每次讀取或寫入皆續期。見 data-model.md「CopilotAnalysisState」生命週期一節 */
const ANALYSIS_STATE_TTL_MS = 2 * 60 * 60 * 1000
/** ⚠️ export 的理由同 `copilot-analysis.ts` 的 `SENTIMENT_CHUNK_SIZE`：量測腳本要用同一個判別式數批次，不另抄一份 */
export function isTextCustomerMessage(m: Message): boolean {
  return m.sender.type === 'customer' && m.text !== ''
}

/** ⚠️ 判別式僅在本功能範圍內成立，M3 附件文字化落地後須改用顯式旗標——見 data-model.md 附註 */
export function isAttachmentOnlyCustomerMessage(m: Message): boolean {
  return m.sender.type === 'customer' && m.text === '' && (m.attachments?.length ?? 0) > 0
}

export function nowIso(): string {
  return new Date().toISOString()
}

function initialState(conversationId: string): CopilotAnalysisState {
  const at = nowIso()
  return {
    conversationId,
    summaryBlock: { status: 'empty', summary: null, updatedAt: at },
    sentimentBlock: { status: 'empty', timeline: [], stats: { lowestScore: null, lowestAt: null }, narrative: null, updatedAt: at },
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

export async function ensureState(conversationId: string): Promise<CopilotAnalysisState> {
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
export async function isBatchAlreadyFailed(
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
export function batchAnchor(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.sender.type === 'customer') return m.id
  }
  return null
}
export async function updateAnalysisState(
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

export async function publishBlock(conversationId: string, block: AnalysisBlock, state: CopilotAnalysisState): Promise<void> {
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
export function logFailure(conversationId: string, block: AnalysisBlock, kind: FailureKind, err: unknown): void {
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
export async function beginAnalyzing(conversationId: string, block: AnalysisBlock): Promise<void> {
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

export async function publishRetrying(
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
export async function finishBlockError(
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
