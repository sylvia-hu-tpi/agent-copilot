/**
 * FR-014：失敗分類與重試／退避策略 —— specs/001-sentiment-panel/research.md #2。
 *
 * 數值以 spec.md FR-014 為唯一權威來源：單次呼叫逾時 15 秒、退避 1s → 4s、
 * 自首次失敗起算總預算 40 秒（含執行時間）、最多 2 次重試。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AICallTimeoutError,
  AIOutputValidationError,
  AIProviderHttpError,
  RetryExhaustedError,
  classifyFailure,
  withRetry,
} from '../server/services/ai/retry-policy.js'

describe('classifyFailure()', () => {
  it('逾時 → transient', () => {
    expect(classifyFailure(new AICallTimeoutError(15_000))).toBe('transient')
  })

  it('5xx → transient', () => {
    expect(classifyFailure(new AIProviderHttpError('boom', 500))).toBe('transient')
    expect(classifyFailure(new AIProviderHttpError('boom', 503))).toBe('transient')
  })

  it('429 → rate-limited', () => {
    expect(classifyFailure(new AIProviderHttpError('rate limited', 429))).toBe('rate-limited')
  })

  it('401／請求無效 → permanent', () => {
    expect(classifyFailure(new AIProviderHttpError('unauthorized', 401))).toBe('permanent')
    expect(classifyFailure(new AIProviderHttpError('bad request', 400))).toBe('permanent')
  })

  it('Zod 驗證失敗 → permanent', () => {
    expect(classifyFailure(new AIOutputValidationError('bad shape'))).toBe('permanent')
  })

  it('未列舉的失敗 MUST 預設歸類為 permanent', () => {
    expect(classifyFailure(new Error('unknown'))).toBe('permanent')
    expect(classifyFailure('not even an error')).toBe('permanent')
    expect(classifyFailure(undefined)).toBe('permanent')
  })
})

describe('withRetry()', () => {
  it('transient 失敗走 1s → 4s 兩次重試，第三次成功時回報 retryAttempt=2', async () => {
    vi.useFakeTimers()
    const callTimes: number[] = []
    let attempts = 0

    const fn = vi.fn(async () => {
      callTimes.push(Date.now())
      attempts++
      if (attempts < 3) throw new AIProviderHttpError('server error', 500)
      return 'ok'
    })

    const onRetry = vi.fn()
    const promise = withRetry(fn, { onRetry })
    await vi.runAllTimersAsync()
    const outcome = await promise

    expect(outcome.value).toBe('ok')
    expect(outcome.retryAttempt).toBe(2)
    expect(fn).toHaveBeenCalledTimes(3)

    // 第 1、2 次呼叫間隔 ≈ 1 秒、第 2、3 次 ≈ 4 秒
    expect(callTimes[1]! - callTimes[0]!).toBe(1_000)
    expect(callTimes[2]! - callTimes[1]!).toBe(4_000)

    expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1, nextDelayMs: 1_000 }))
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, nextDelayMs: 4_000 }))

    vi.useRealTimers()
  })

  it('rate-limited（429）0 次重試，直接轉錯誤（M2 不在區塊層級重試 429）', async () => {
    const fn = vi.fn(async () => {
      throw new AIProviderHttpError('rate limited', 429)
    })

    await expect(withRetry(fn)).rejects.toMatchObject({ kind: 'rate-limited', retryAttempt: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('permanent（401／請求無效）0 次重試，直接轉錯誤', async () => {
    const fn = vi.fn(async () => {
      throw new AIProviderHttpError('unauthorized', 401)
    })

    await expect(withRetry(fn)).rejects.toMatchObject({ kind: 'permanent', retryAttempt: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('Zod 驗證失敗 0 次重試，直接轉錯誤', async () => {
    const fn = vi.fn(async () => {
      throw new AIOutputValidationError('bad shape')
    })

    await expect(withRetry(fn)).rejects.toMatchObject({ kind: 'permanent', retryAttempt: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('單次呼叫逾 15 秒視為失敗（transient），會進入重試', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const fn = vi.fn(() => {
      attempts++
      // 第一次呼叫故意不 resolve/reject，讓它被 15 秒逾時機制淘汰
      if (attempts === 1) return new Promise<string>(() => {})
      return Promise.resolve('ok')
    })

    const promise = withRetry(fn)
    await vi.runAllTimersAsync()
    const outcome = await promise

    expect(outcome.value).toBe('ok')
    expect(outcome.retryAttempt).toBe(1)
    vi.useRealTimers()
  })

  it('自首次失敗起算逾 40 秒預算即停止，轉 error（1+15+4+15=35s 之後理論上還能再試，但次數已用盡 2 次即停）', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(async () => {
      throw new AIProviderHttpError('server error', 500)
    })

    const promise = withRetry(fn)
    // 避免 unhandled rejection 警告：promise 在 runAllTimersAsync() 期間就會 reject，
    // 但下面的斷言要等它 resolve 之後才附加 —— 先掛一個空 catch 佔位
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toBeInstanceOf(RetryExhaustedError)
    await expect(promise).rejects.toMatchObject({ kind: 'transient', retryAttempt: 2 })
    // 最多 2 次重試（合計 3 次呼叫）
    expect(fn).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('firstFailureAt 只在曾經失敗過才有值，且維持首次失敗當下的時間戳（供驗證 40 秒預算）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'))

    let attempts = 0
    const fn = vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new AIProviderHttpError('server error', 500)
      return 'ok'
    })

    const promise = withRetry(fn)
    await vi.runAllTimersAsync()
    const outcome = await promise

    expect(outcome.firstFailureAt).toBe('2026-08-26T00:00:00.000Z')
    vi.useRealTimers()
  })

  it('從未失敗過時 firstFailureAt 為 undefined', async () => {
    const outcome = await withRetry(async () => 'ok')
    expect(outcome.firstFailureAt).toBeUndefined()
    expect(outcome.retryAttempt).toBe(0)
  })
})
