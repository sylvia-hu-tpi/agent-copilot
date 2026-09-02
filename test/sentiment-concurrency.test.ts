/**
 * `SENTIMENT_CONCURRENCY` 的 env 覆寫 —— specs/005-m2-residual-defects US4（FR-018、T044a）。
 *
 * ⚠️ 這道門只為 `spike:sentiment-concurrency` 而開。它壞掉的方式與其他三則一樣不會報錯：
 *    預設值被改掉、或 env 被塞了 `''`／`'abc'` 而變成 0／NaN 的並行度，症狀只是
 *    「某個環境的情緒延遲莫名其妙不一樣」或分析永遠不完成。手動 spike 不算「會變紅的東西」。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SENTIMENT_CONCURRENCY,
  resolveSentimentConcurrency,
  SENTIMENT_CONCURRENCY,
} from '../server/services/copilot-analysis.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SENTIMENT_CONCURRENCY（T044a）', () => {
  it('未設 env 時 ＝ 3 —— 預設值被改掉時這裡會紅', () => {
    // vitest 的環境不會有這個變數（package.json 的 scripts 由 contract-guards 守著不得設定）
    expect(process.env.SENTIMENT_CONCURRENCY).toBeUndefined()
    expect(DEFAULT_SENTIMENT_CONCURRENCY).toBe(3)
    expect(SENTIMENT_CONCURRENCY).toBe(3)
  })

  it('空字串與非數字回退 3（Number("") 是 0、Number("abc") 是 NaN，交給 mapWithConcurrency 是靜默錯誤）', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(resolveSentimentConcurrency('')).toBe(3)
    expect(resolveSentimentConcurrency('abc')).toBe(3)
    expect(resolveSentimentConcurrency(undefined)).toBe(3)
    // 空字串與 undefined 視同「沒設」，不吼；'abc' 是設錯，要留一行
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toContain('SENTIMENT_CONCURRENCY')
  })

  it('0、負數、小數都不是合法的並行度 → 回退 3 並留一行', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(resolveSentimentConcurrency('0')).toBe(3)
    expect(resolveSentimentConcurrency('-1')).toBe(3)
    expect(resolveSentimentConcurrency('2.5')).toBe(3)
    expect(stderr).toHaveBeenCalledTimes(3)
  })

  it('合法的正整數照用（掃描腳本靠這條把 4／5 傳進子行程）', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(resolveSentimentConcurrency('4')).toBe(4)
    expect(resolveSentimentConcurrency('5')).toBe(5)
    expect(resolveSentimentConcurrency('1')).toBe(1)
    expect(stderr).not.toHaveBeenCalled()
  })
})
