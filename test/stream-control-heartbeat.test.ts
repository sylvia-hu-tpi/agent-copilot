/**
 * `watch()` 的冪等性 —— specs/003-analysis-trigger-policy 契約不變式 A（FR-001、FR-002）。
 *
 * ⚠️ **這是本規格的止血點。** presence 心跳每 20 秒送一次 `watch`，而 `attach()` 帶有
 *    「送快照 ＋ 補跑分析」的副作用；原實作對心跳與真實變化走同一條路（一律解舊訂閱再
 *    重新 attach），於是一個放著不動的對話每 20 秒重跑一輪完整分析
 *    —— 2026-08-27 於真實環境實測換算約 3,780 次 AI 呼叫／小時／對話。
 *
 * ⚠️ 寫錯時**不報錯、不會有型別錯誤**：畫面一切正常，只有呼叫量暴增。
 *    因此下面驗的是契約表格的**每一列**，而不只是「心跳不 attach」這一句。
 *
 * ⚠️ 測的是 `createWatchRegistry()` 而不是 `stream.get.ts`：後者用了 Nitro auto-import，
 *    vitest 無法直接 import（比照 test/stream-reconnect-background.test.ts 的既有慣例）。
 */

import { describe, expect, it, vi } from 'vitest'
import { createWatchRegistry } from '../server/utils/stream-control.js'

const CONV = 'conv_a'

function fakeAttach() {
  const detached: string[] = []
  const attach = vi.fn(async (conversationId: string) => {
    return vi.fn(() => { detached.push(conversationId) })
  })
  return { attach, detached }
}

describe('不變式 A：相同 {priority, joined} 的重複 watch 沒有任何副作用', () => {
  it('首次 watch → attach（註冊表為空，視為首次）', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'foreground', true)

    expect(attach.mock.calls).toEqual([[CONV, 'foreground', true]])
  })

  it('每 20 秒的 presence 心跳（狀態未變）→ no-op：不 attach、不解舊訂閱', async () => {
    const { attach, detached } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'foreground', true)
    attach.mockClear()

    // 30 次心跳 —— 相當於放著不動 10 分鐘
    for (let i = 0; i < 30; i++) await watchers.watch(CONV, 'foreground', true)

    expect(attach).not.toHaveBeenCalled()
    // ⚠️ 不解舊訂閱同樣重要：解了又不重建，這個對話就再也收不到事件
    expect(detached).toEqual([])
    expect(watchers.size).toBe(1)
  })

  it('客服切到背景分頁（priority foreground→background）→ attach', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'foreground', true)
    attach.mockClear()

    await watchers.watch(CONV, 'background', true)

    expect(attach.mock.calls).toEqual([[CONV, 'background', true]])
  })

  it('客服切回前景（priority background→foreground）→ attach（摘要才補得了跑，002 US4 AC#5）', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'background', true)
    attach.mockClear()

    await watchers.watch(CONV, 'foreground', true)

    expect(attach.mock.calls).toEqual([[CONV, 'foreground', true]])
  })

  it('按下 JOIN（joined false→true）→ attach', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'foreground', false)
    attach.mockClear()

    await watchers.watch(CONV, 'foreground', true)

    expect(attach.mock.calls).toEqual([[CONV, 'foreground', true]])
    expect(watchers.isJoined(CONV)).toBe(true)
  })

  it('按下離開／結案（joined true→false）→ attach，且 isJoined() 隨即翻轉', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'foreground', true)
    expect(watchers.isJoined(CONV)).toBe(true)
    attach.mockClear()

    await watchers.watch(CONV, 'foreground', false)

    expect(attach.mock.calls).toEqual([[CONV, 'foreground', false]])
    expect(watchers.isJoined(CONV)).toBe(false)
  })

  it('unwatch() 後再 watch() → 視為首次而 attach（條目連同 {priority, joined} 一併刪除）', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV, 'foreground', true)
    watchers.unwatch(CONV)
    attach.mockClear()

    await watchers.watch(CONV, 'foreground', true)

    expect(attach.mock.calls).toEqual([[CONV, 'foreground', true]])
  })

  it('SSE 重連／重新整理（全新註冊表）→ 視為首次而 attach（快照照送，001 FR-010）', async () => {
    const { attach } = fakeAttach()
    const first = createWatchRegistry(attach)
    await first.watch(CONV, 'foreground', true)
    first.closeAll()

    attach.mockClear()
    const reconnected = createWatchRegistry(attach)
    await reconnected.watch(CONV, 'foreground', true)

    expect(attach.mock.calls).toEqual([[CONV, 'foreground', true]])
  })
})

describe('不變式 A：restoreJoined() MUST 一併寫入 {priority, joined}', () => {
  /**
   * ⚠️ 漏寫的症狀：復原的對話會在 20 秒後的第一次心跳被誤判為「首次」而重跑一輪 ——
   *    缺陷只縮小而未消除，且只在「重連後恰好滿 20 秒」時出現，極難重現。
   */
  it('復原後緊接著的 background/joined:true 心跳是 no-op，不重跑一輪', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(async () => [CONV])
    expect(attach.mock.calls).toEqual([[CONV, 'background', true]])
    attach.mockClear()

    // 客服此刻正在看別的對話 → 這個對話的心跳仍是 background / joined:true
    await watchers.watch(CONV, 'background', true)

    expect(attach).not.toHaveBeenCalled()
  })

  it('復原後切回前景仍能升級（②「優先度升級不可略過」不受影響）', async () => {
    const { attach, detached } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(async () => [CONV])
    attach.mockClear()

    await watchers.watch(CONV, 'foreground', true)

    expect(detached).toEqual([CONV])
    expect(attach.mock.calls).toEqual([[CONV, 'foreground', true]])
  })
})

describe('不變式 C：isJoined() 是每條連線各自一份，且在 attach 期間就答得出來', () => {
  it('註冊表在 attach() 的副作用之前就寫入 —— attach 期間查詢 isJoined() 已是正確值', async () => {
    // ⚠️ 沿用舊順序（attach 完成後才登記）的話，attach 期間送出的分析事件會被
    //    stream.get.ts 的過濾一律判成「未 JOIN」而丟棄 —— 又一個不報錯的漏事件。
    const seen: boolean[] = []
    const watchers = createWatchRegistry(async (conversationId) => {
      seen.push(watchers.isJoined(conversationId))
      return () => {}
    })

    await watchers.watch(CONV, 'foreground', true)

    expect(seen).toEqual([true])
  })

  it('兩條連線的註冊表互不影響（closure per 連線，MUST NOT 是模組全域）', async () => {
    const a = createWatchRegistry(async () => () => {})
    const b = createWatchRegistry(async () => () => {})

    await a.watch(CONV, 'foreground', true)
    await b.watch(CONV, 'foreground', false)

    expect(a.isJoined(CONV)).toBe(true)
    expect(b.isJoined(CONV)).toBe(false)
  })

  it('從未監看過的對話回傳 false（安全預設）', () => {
    const watchers = createWatchRegistry(async () => () => {})
    expect(watchers.isJoined('never-watched')).toBe(false)
  })
})
