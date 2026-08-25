/**
 * §9.2 自適應頻率表的逐格驗證。
 *
 * ⚠️ 這支測試的價值不在「函式會不會算錯」，而在**把文件的表釘死**。
 *    §9.2 的數字是 2026-08-25 依實測放寬過的（原表建立在「支援 since 增量拉取」
 *    的假設上，而八種寫法全部被忽略）。若日後有人憑直覺把前景改回 1.5 秒，
 *    這裡會立刻紅 —— 並在測試名稱裡看到為什麼不該改。
 */

import { describe, expect, it } from 'vitest'
import {
  POLL_BACKOFF_AFTER,
  POLL_BACKOFF_MAX_MS,
  pollIntervalMs,
} from '../server/sources/polling-message-source.js'

const base = { emptyStreak: 0 } as const

describe('§9.2 修訂後的頻率表', () => {
  it.each([
    ['前景聚焦 + 已 JOIN', 'foreground', true, 3_000],
    ['前景聚焦 + 觀察中', 'foreground', false, 5_000],
    ['背景 + 已 JOIN', 'background', true, 15_000],
    ['背景 + 觀察中', 'background', false, 30_000],
  ] as const)('%s → %dms', (_label, priority, joined, expected) => {
    expect(pollIntervalMs({ ...base, priority, joined })).toBe(expected)
  })

  it('前景已 JOIN 是 3 秒而非 1.5 秒 —— 撞單防護靠 §10.4 送出前檢查，不靠輪詢頻率', () => {
    expect(pollIntervalMs({ priority: 'foreground', joined: true, emptyStreak: 0 })).toBe(3_000)
  })
})

describe('連續無新訊息時的指數退避', () => {
  it(`第 ${POLL_BACKOFF_AFTER - 1} 次仍維持基礎間隔 —— 退避不可提早開始`, () => {
    expect(pollIntervalMs({
      priority: 'foreground', joined: true, emptyStreak: POLL_BACKOFF_AFTER - 1,
    })).toBe(3_000)
  })

  it('第 5 次起開始加倍', () => {
    expect(pollIntervalMs({ priority: 'foreground', joined: true, emptyStreak: 5 })).toBe(6_000)
    expect(pollIntervalMs({ priority: 'foreground', joined: true, emptyStreak: 6 })).toBe(12_000)
    expect(pollIntervalMs({ priority: 'foreground', joined: true, emptyStreak: 7 })).toBe(24_000)
  })

  it(`上限 ${POLL_BACKOFF_MAX_MS}ms —— 再久也不能讓對話變成「永遠不更新」`, () => {
    expect(pollIntervalMs({ priority: 'foreground', joined: true, emptyStreak: 50 }))
      .toBe(POLL_BACKOFF_MAX_MS)
    expect(pollIntervalMs({ priority: 'background', joined: false, emptyStreak: 50 }))
      .toBe(POLL_BACKOFF_MAX_MS)
  })
})
