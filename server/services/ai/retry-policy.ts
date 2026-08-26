/**
 * AI 呼叫的失敗分類與重試／退避策略 —— specs/001-sentiment-panel/research.md #2。
 *
 * ⚠️ 規範性數值一律以 spec.md FR-014 為唯一權威來源，這裡不重述可能過期的副本：
 *    單次呼叫逾時 15 秒、退避 1s → 4s、自首次失敗起算總預算 40 秒（含執行時間）、最多 2 次重試。
 *
 * `classifyFailure()` 刻意回傳三值而非二值：'rate-limited'（429）在 M2 的處置與
 * 'permanent' 相同（直接轉 error、不自動重試），但原因不同 —— M3 全域退避佇列建立時
 * 只有 'rate-limited' 會改接佇列，現在若省事併入 'permanent' 屆時將無從辨識。
 */

const CALL_TIMEOUT_MS = 15_000
const BUDGET_MS = 40_000
const BACKOFF_MS = [1_000, 4_000] as const
const MAX_RETRIES = BACKOFF_MS.length

export type FailureKind = 'transient' | 'rate-limited' | 'permanent'

/** withRetry() 內部呼叫逾時（15 秒）時拋出，classifyFailure() 一律歸為 transient */
export class AICallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`AI 呼叫逾時（${timeoutMs}ms）`)
  }
}

/**
 * AIProvider 實作（含 MockAIProvider）遇到 HTTP 層錯誤時應拋出此類別，
 * 帶上狀態碼供 classifyFailure() 判別。
 */
export class AIProviderHttpError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message)
  }
}

/** AI 輸出未通過 Zod schema 驗證（憲法 4.2）—— server/services/ai/schemas.ts 拋出 */
export class AIOutputValidationError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/**
 * 重試次數或總預算用盡、或遇到非暫時性失敗時拋出。
 *
 * ⚠️ 憲法 1.5：`message` 不得含訊息全文，僅供除錯用的分類與次數。
 */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly retryAttempt: number,
    public readonly firstFailureAt: string,
    public override readonly cause?: unknown,
  ) {
    super(`AI 呼叫失敗（${kind}），已重試 ${retryAttempt} 次`)
  }
}

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof AICallTimeoutError) return 'transient'
  if (error instanceof AIOutputValidationError) return 'permanent'
  if (error instanceof AIProviderHttpError) {
    if (error.statusCode === 429) return 'rate-limited'
    if (error.statusCode >= 500 && error.statusCode < 600) return 'transient'
    return 'permanent'
  }
  // 上述未列舉的失敗 MUST 預設歸類為非暫時性（FR-014）—— 對原因不明的失敗盲目重試，
  // 代價由客服的等待時間支付。
  return 'permanent'
}

export interface WithRetryOutcome<T> {
  value: T
  /** 最終成功前已重試的次數（0 代表首次呼叫即成功） */
  retryAttempt: number
  /** 僅曾經失敗過才有值 */
  firstFailureAt?: string
}

export interface WithRetryOptions {
  /**
   * 每次進入重試前呼叫（不含首次呼叫），供呼叫端立即發布「重試中 (n/2)」狀態。
   * 會被 `await`——下一次退避等待在此回呼完成前不會開始，確保狀態發布先於下次呼叫。
   */
  onRetry?: (info: { attempt: number, firstFailureAt: string, nextDelayMs: number }) => void | Promise<void>
  callTimeoutMs?: number
  budgetMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AICallTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([fn(), timeout])
  }
  finally {
    clearTimeout(timer!)
  }
}

/**
 * 包裹一次 AI 呼叫（含輸出驗證，見呼叫端如何組裝 fn），依 FR-014 執行重試／退避。
 *
 * @throws {RetryExhaustedError} 非暫時性失敗、429、或重試次數/總預算用盡時
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<WithRetryOutcome<T>> {
  const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS
  const budgetMs = opts.budgetMs ?? BUDGET_MS

  let attempt = 0
  let firstFailureAtMs: number | undefined

  for (;;) {
    try {
      const value = await callWithTimeout(fn, callTimeoutMs)
      return {
        value,
        retryAttempt: attempt,
        firstFailureAt: firstFailureAtMs !== undefined ? new Date(firstFailureAtMs).toISOString() : undefined,
      }
    }
    catch (err) {
      const kind = classifyFailure(err)
      if (firstFailureAtMs === undefined) firstFailureAtMs = Date.now()
      const firstFailureAt = new Date(firstFailureAtMs).toISOString()

      if (kind !== 'transient' || attempt >= MAX_RETRIES) {
        throw new RetryExhaustedError(kind, attempt, firstFailureAt, err)
      }

      const elapsed = Date.now() - firstFailureAtMs
      if (elapsed >= budgetMs) {
        throw new RetryExhaustedError(kind, attempt, firstFailureAt, err)
      }

      attempt++
      const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
      await opts.onRetry?.({ attempt, firstFailureAt, nextDelayMs: delay })
      await sleep(delay)
    }
  }
}
