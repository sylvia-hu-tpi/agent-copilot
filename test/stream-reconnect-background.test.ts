/**
 * SSE 連線建立時的背景 watch 復原，與後續的優先度升級 ——
 * specs/002-suggestion-knowledge-search research.md #8 決策 3／4（T055、T056）。
 *
 * ⚠️ 這兩條規則壞掉時**不會報錯、不會有型別錯誤**，只會安靜地少算：
 *    ① 復原漏掉 → 背景對話在斷線的當下悄悄停止分析，客服切回去才發現什麼都沒算。
 *    ② 升級被 `watched.has()` 擋下 → 對話永遠停在 background，摘要永遠不補跑。
 *    正因為無聲，才必須有單元測試守著。
 *
 * ⚠️ 測的是 `createWatchRegistry()` 而不是 `stream.get.ts` 本身：後者用了 Nitro
 *    auto-import（`defineEventHandler`／`createEventStream`），vitest 與 tsx 都無法
 *    直接 import——比照 test/knowledge-search-api.test.ts 與 test/presence-away-joined.test.ts
 *    的既有慣例，把不依賴 H3Event 的決策邏輯抽出來測。
 *    真實 HTTP／SSE 的端到端行為由 test/realtime-http.ts 的「⑤ 多對話背景更新」場景涵蓋。
 */

import { describe, expect, it, vi } from 'vitest'
import { createWatchRegistry } from '../server/utils/stream-control.js'

const CONV_A = 'conv_a'
const CONV_B = 'conv_b'
const CONV_C = 'conv_c'

/** 一支會記錄每次呼叫、並回傳可辨識的 unsubscribe 的假 `attach()` */
function fakeAttach() {
  const detached: string[] = []
  const attach = vi.fn(async (conversationId: string) => {
    const off = vi.fn(() => { detached.push(conversationId) })
    return off
  })
  return { attach, detached }
}

describe('createWatchRegistry() —— 連線建立時的背景復原（決策 4）', () => {
  it('listJoinedConversations 回傳多筆時，每一筆都以 background／joined:true 各 attach 一次', async () => {
    const { attach } = fakeAttach()
    const listJoinedConversations = vi.fn(async () => [CONV_A, CONV_B, CONV_C])
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(listJoinedConversations)

    expect(listJoinedConversations).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledTimes(3)
    expect(attach.mock.calls).toEqual([
      [CONV_A, 'background', true],
      [CONV_B, 'background', true],
      [CONV_C, 'background', true],
    ])
    expect(watchers.size).toBe(3)
    for (const convId of [CONV_A, CONV_B, CONV_C]) expect(watchers.has(convId)).toBe(true)
  })

  it('沒有任何已 JOIN 對話時不呼叫 attach（純 viewing 的客服照樣能建立連線）', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(async () => [])

    expect(attach).not.toHaveBeenCalled()
    expect(watchers.size).toBe(0)
  })

  it('已在監看中的對話不重複 attach —— 客服的 presence 心跳可能已搶先升級成 foreground', async () => {
    const { attach } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.watch(CONV_A, 'foreground', true)
    attach.mockClear()

    await watchers.restoreJoined(async () => [CONV_A, CONV_B])

    // CONV_A 被跳過（否則會把它降級回 background），只有 CONV_B 被掛上
    expect(attach.mock.calls).toEqual([[CONV_B, 'background', true]])
    expect(watchers.size).toBe(2)
  })
})

describe('createWatchRegistry() —— 已監看對話的優先度升級（決策 3）', () => {
  it('對已以 background 掛上的其中一筆送出 foreground watch 時能成功升級，不被「已在監看中」擋下', async () => {
    const { attach, detached } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(async () => [CONV_A, CONV_B, CONV_C])
    attach.mockClear()

    await watchers.watch(CONV_B, 'foreground', true)

    // 先解除舊訂閱，再以新優先度重新 attach()
    expect(detached).toEqual([CONV_B])
    expect(attach.mock.calls).toEqual([[CONV_B, 'foreground', true]])
    // 其餘兩筆不受影響，仍在背景監看中
    expect(watchers.size).toBe(3)
    expect(watchers.has(CONV_A)).toBe(true)
    expect(watchers.has(CONV_C)).toBe(true)
  })

  it('升級後再切走（降回 background）同樣走「先解舊再建新」，不會累積孤兒訂閱', async () => {
    const { attach, detached } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(async () => [CONV_A])
    await watchers.watch(CONV_A, 'foreground', true)
    await watchers.watch(CONV_A, 'background', true)

    expect(attach.mock.calls).toEqual([
      [CONV_A, 'background', true],
      [CONV_A, 'foreground', true],
      [CONV_A, 'background', true],
    ])
    // 每次重新 attach 前都解除了前一份，watched 只留最後一份
    expect(detached).toEqual([CONV_A, CONV_A])
    expect(watchers.size).toBe(1)
  })

  it('unwatch 解除該筆並移出註冊表；closeAll 解除全部（憲法 6.1：訂閱數歸零即停止輪詢）', async () => {
    const { attach, detached } = fakeAttach()
    const watchers = createWatchRegistry(attach)

    await watchers.restoreJoined(async () => [CONV_A, CONV_B, CONV_C])

    watchers.unwatch(CONV_B)
    expect(detached).toEqual([CONV_B])
    expect(watchers.has(CONV_B)).toBe(false)
    expect(watchers.size).toBe(2)

    // 不在監看中的 conversationId 送 unwatch 是 no-op，不拋錯
    expect(() => watchers.unwatch(CONV_B)).not.toThrow()

    watchers.closeAll()
    expect(detached).toEqual([CONV_B, CONV_A, CONV_C])
    expect(watchers.size).toBe(0)
  })
})
