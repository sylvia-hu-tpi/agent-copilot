/**
 * AI 呼叫的失敗分類與重試／退避策略 —— specs/001-sentiment-panel/research.md #2。
 *
 * ⚠️ 規範性數值一律以 spec.md FR-014 為唯一權威來源，這裡不重述可能過期的副本：
 *    單次呼叫逾時 15 秒、退避 1s → 4s、自首次失敗起算總預算 40 秒（含執行時間）、最多 2 次重試。
 *
 * `classifyFailure()` 刻意回傳三值而非二值：'rate-limited'（429）在 M2 的處置與
 * 'permanent' 相同（直接轉 error、不自動重試），但原因不同 —— M3 全域退避佇列建立時
 * 只有 'rate-limited' 會改接佇列，現在若省事併入 'permanent' 屆時將無從辨識。
 *
 * ⚠️ **`maxRetries: 0` 時 FR-014 的三數綁定不適用**（specs/004-progressive-citations #4）：
 *    不進重試迴圈就沒有退避、也用不到總預算，只剩單次逾時一個數字有效。004 的建議卡第二段
 *    正是這樣呼叫的，它的單次逾時由 `SUGGESTION_STAGE2_CALL_TIMEOUT_MS` 承載 ——
 *    **改那個常數 MUST NOT 連帶動下面這三個**，兩者沒有耦合。
 */

/**
 * ⚠️ export 只為了讓量測腳本（`scripts/spike/21-progressive-citations.ts`）標出
 *    「這一次呼叫已經破了會觸發重試的門檻」。腳本自己抄一份數字，就會在這裡改了之後
 *    安靜地繼續用舊值判讀——那是本專案吃過虧的失敗模式。
 *    **MUST NOT 有任何生產路徑改從外部覆寫它**（要改單次逾時請用 `opts.callTimeoutMs`）。
 */
export const CALL_TIMEOUT_MS = 15_000
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

/**
 * `signal` 在退避等待中或下一次呼叫送出前被 abort 時拋出（004 data-model.md §5）。
 *
 * ⚠️ **`classifyFailure()` 刻意不處理它** —— 它不是一種 AI 失敗，而是呼叫端自己撤回了這次呼叫。
 *    呼叫端 MUST 在分類／記錄失敗之前先攔截它（例如 004 第一段被第二段 abort 時是**靜默返回**，
 *    不轉 error），否則會被歸為 `'permanent'` 而讓區塊莫名其妙變成錯誤狀態。
 */
export class RetryAbortedError extends Error {
  constructor() {
    super('AI 呼叫已被呼叫端取消')
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
  /**
   * 最多自動重試次數；預設 `BACKOFF_MS.length`（＝ 2，001 FR-014）。
   * 004 的建議卡第二段傳 `0` —— **不重試是呼叫端的明示選擇**，不是這裡改預設值。
   * 傳 0 時 `onRetry` 永遠不會被呼叫（也就不會閃出「重試中」），失敗一次即拋 `RetryExhaustedError`。
   */
  maxRetries?: number
  /**
   * 取消訊號。**只在退避等待中與下一次呼叫送出前檢查**，已經在飛的呼叫不受影響
   * （SDK 未暴露 signal，見 004 research.md #2）—— abort 能省下的是「還沒送出」的那一次。
   * 被 abort 時拋 `RetryAbortedError`（不是 `RetryExhaustedError`）。
   */
  signal?: AbortSignal
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 退避等待，但 `signal` 一 abort 就立刻結束（不必空等完剩下的秒數）。
 * ⚠️ MUST 移除 listener：同一個 signal 會跨多次退避重複使用，不移除會逐次累積。
 */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal!.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
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
 * @throws {RetryAbortedError} `opts.signal` 在退避等待中或下一次呼叫送出前被 abort 時
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<WithRetryOutcome<T>> {
  const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS
  const budgetMs = opts.budgetMs ?? BUDGET_MS
  const maxRetries = opts.maxRetries ?? MAX_RETRIES

  let attempt = 0
  let firstFailureAtMs: number | undefined

  for (;;) {
    // ⚠️ 送出前檢查（含首次）——已在飛的呼叫取消不了，能省的只有還沒送出的那一次
    if (opts.signal?.aborted) throw new RetryAbortedError()
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

      if (kind !== 'transient' || attempt >= maxRetries) {
        throw new RetryExhaustedError(kind, attempt, firstFailureAt, err)
      }

      const elapsed = Date.now() - firstFailureAtMs
      if (elapsed >= budgetMs) {
        throw new RetryExhaustedError(kind, attempt, firstFailureAt, err)
      }

      attempt++
      const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
      await opts.onRetry?.({ attempt, firstFailureAt, nextDelayMs: delay })
      await sleepOrAbort(delay, opts.signal)
    }
  }
}
