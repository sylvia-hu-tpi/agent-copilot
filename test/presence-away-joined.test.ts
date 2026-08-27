/**
 * `state:'away'` 的控制通道語意 —— specs/002-suggestion-knowledge-search/contracts/
 * presence-watch-control.md（憲法 v3.0.0 修訂動機的程式碼根因，見 research.md #8）。
 *
 * ⚠️ `resolvePresenceControl()` 抽自 presence.post.ts，不依賴 H3Event。
 *    `clearViewing()` 是否「仍無條件執行」屬於 presence-viewing 的既有行為（未被本次
 *    修正觸及），由既有的 test/presence.test.ts 涵蓋，這裡只驗證新的控制通道判斷。
 */

import { describe, expect, it } from 'vitest'
import { resolvePresenceControl } from '../server/utils/stream-control.js'

describe('resolvePresenceControl()（contracts/presence-watch-control.md「修正後」表格）', () => {
  it('state: away, joined: true → { kind: watch, priority: background }（不是 unwatch）', () => {
    expect(resolvePresenceControl('away', true, true)).toEqual({ kind: 'watch', priority: 'background' })
    // visible 不影響 away 分支的 priority——切走就是背景，無論分頁是否仍在前景
    expect(resolvePresenceControl('away', true, false)).toEqual({ kind: 'watch', priority: 'background' })
  })

  it('state: away, joined: false → { kind: unwatch }（真的沒 JOIN 或已 LEAVE）', () => {
    expect(resolvePresenceControl('away', false, true).kind).toBe('unwatch')
    expect(resolvePresenceControl('away', false, false).kind).toBe('unwatch')
  })

  it('聚焦某對話（viewing/composing/joined）時行為不變：依 visible 決定 foreground/background', () => {
    expect(resolvePresenceControl('viewing', false, true)).toEqual({ kind: 'watch', priority: 'foreground' })
    expect(resolvePresenceControl('viewing', false, false)).toEqual({ kind: 'watch', priority: 'background' })
    expect(resolvePresenceControl('joined', true, true)).toEqual({ kind: 'watch', priority: 'foreground' })
    expect(resolvePresenceControl('composing', true, true)).toEqual({ kind: 'watch', priority: 'foreground' })
  })
})
