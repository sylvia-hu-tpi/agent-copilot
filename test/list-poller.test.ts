/**
 * 第一層清單輪詢 —— §9.3.1。
 *
 * ⚠️ 這一層的失敗形態全部是**靜默的**：偵測不到變動時不會報錯，
 *    只是訊息晚 30 秒才出現，或 mode 切換後 Composer 沒跟著變。
 *    因此每一種變動都要有自己的測試。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ConversationListPoller,
  LIST_INTERVAL_BACKGROUND_MS,
  LIST_INTERVAL_FOREGROUND_MS,
} from '../server/sources/conversation-list-poller.js'
import type { Conversation } from '../shared/types/conversation.js'

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    channel: 'line',
    contactId: 'con_1',
    status: 'open',
    name: 'TWN#GW4772',
    mode: null,
    operators: [],
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...over,
  }
}

function makePoller(pages: Conversation[][], foreground = true) {
  let i = 0
  const poller = new ConversationListPoller({
    fetchAll: async () => pages[Math.min(i++, pages.length - 1)] ?? [],
    hasForeground: () => foreground,
  })
  return poller
}

describe('變動偵測', () => {
  it('第一輪只建立基準，不發事件 —— 否則開站瞬間每個對話都會亮未讀', async () => {
    const poller = makePoller([[conv()]])
    expect(await poller.tick()).toEqual([])
  })

  it('last_message_at 跳動 → hasNewMessages', async () => {
    const poller = makePoller([
      [conv({ lastMessageAt: '2026-08-25T00:00:00.000Z' })],
      [conv({ lastMessageAt: '2026-08-25T00:05:00.000Z', updatedAt: '2026-08-25T00:05:00.000Z' })],
    ])
    await poller.tick()
    const [change] = await poller.tick()

    expect(change?.hasNewMessages).toBe(true)
    expect(change?.conversationId).toBe('c1')
  })

  it('mode 改變 → modeChanged，且帶得出前一個值', async () => {
    const poller = makePoller([
      [conv({ mode: null })],
      [conv({ mode: 'manual', updatedAt: '2026-08-25T00:01:00.000Z' })],
    ])
    await poller.tick()
    const [change] = await poller.tick()

    expect(change?.modeChanged).toBe(true)
    expect(change?.previousMode).toBeNull()
    expect(change?.conversation.mode).toBe('manual')
  })

  it('LEAVE（manual → automation）同樣要偵測到', async () => {
    const poller = makePoller([
      [conv({ mode: 'manual' })],
      [conv({ mode: 'automation', updatedAt: '2026-08-25T00:02:00.000Z' })],
    ])
    await poller.tick()
    const [change] = await poller.tick()

    expect(change?.modeChanged).toBe(true)
    expect(change?.previousMode).toBe('manual')
  })

  it('完全沒變 → 不發事件', async () => {
    const poller = makePoller([[conv()], [conv()]])
    await poller.tick()
    expect(await poller.tick()).toEqual([])
  })

  it('只有 updated_at 動了也要發 —— JOIN/LEAVE 只會反映在這個欄位', async () => {
    const poller = makePoller([
      [conv()],
      [conv({ updatedAt: '2026-08-25T00:03:00.000Z' })],
    ])
    await poller.tick()
    expect(await poller.tick()).toHaveLength(1)
  })
})

describe('清單涵蓋率（實測 85%，§9.3.1）', () => {
  it('有 last_message_at 的對話 → 第二層可降為對帳頻率', async () => {
    const poller = makePoller([[conv({ lastMessageAt: '2026-08-25T00:00:00.000Z' })]])
    await poller.tick()
    expect(poller.isListCovered('c1')).toBe(true)
  })

  it('⚠️ 沒有 last_message_at 的對話必須回報未涵蓋 —— 否則那些對話會變成 30 秒才更新', async () => {
    const poller = makePoller([[conv({ lastMessageAt: undefined })]])
    await poller.tick()
    expect(poller.isListCovered('c1')).toBe(false)
  })

  it('沒見過的對話一律視為未涵蓋', async () => {
    const poller = makePoller([[conv()]])
    expect(poller.isListCovered('unknown')).toBe(false)
  })
})

describe('頻率與韌性', () => {
  it('有人前景在線 3 秒，全部背景時降到 30 秒（§9.2）', () => {
    expect(makePoller([[]], true).intervalMs()).toBe(LIST_INTERVAL_FOREGROUND_MS)
    expect(makePoller([[]], false).intervalMs()).toBe(LIST_INTERVAL_BACKGROUND_MS)
  })

  /**
   * ⚠️ 全程用假計時器，且**在 start() 之前就切換** —— 迴圈的計時器是在 start() 當下排的，
   *    先跑真計時器再切假的，advanceTimersByTime 對那支已存在的計時器完全無效，
   *    測試會綠得毫無意義（2026-08-29 第一版就是這樣，改寫於此以免再犯）。
   */
  it('第一拍排在無人連線時 → 有人上線後 wake() 讓它回到前景頻率（2026-08-29 實測缺陷）', async () => {
    let foreground = false
    let polls = 0
    const poller = new ConversationListPoller({
      fetchAll: async () => { polls++; return [] },
      hasForeground: () => foreground,
    })

    vi.useFakeTimers()
    try {
      poller.start()
      await vi.advanceTimersByTimeAsync(0)
      // 第一拍是在「沒人連線」時跑的 —— 下一拍照 30 秒排
      expect(polls).toBe(1)
      expect(poller.intervalMs()).toBe(LIST_INTERVAL_BACKGROUND_MS)

      // 反向對照：沒有 wake() 的話，3 秒過去仍然不會有第二拍
      foreground = true
      await vi.advanceTimersByTimeAsync(LIST_INTERVAL_FOREGROUND_MS + 50)
      expect(polls).toBe(1)

      // 有人上線 → wake() 重算「下一拍本來該在什麼時候」。此刻已經超過那個時間，
      // 所以是立刻補跑，而不是再等一個完整間隔
      poller.wake()
      await vi.advanceTimersByTimeAsync(50)
      expect(polls).toBe(2)
    }
    finally {
      poller.stop()
      vi.useRealTimers()
    }
  })

  it('wake() 不會讓每一次心跳都多打一次清單（已排得夠早就不動）', async () => {
    let polls = 0
    const poller = new ConversationListPoller({
      fetchAll: async () => { polls++; return [] },
      hasForeground: () => true,
    })

    vi.useFakeTimers()
    try {
      poller.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(polls).toBe(1)

      // 第一拍就是在前景排的 —— 下一拍已經是 3 秒，再怎麼叫醒也不該提前
      for (let i = 0; i < 5; i++) poller.wake()
      await vi.advanceTimersByTimeAsync(LIST_INTERVAL_FOREGROUND_MS - 100)
      expect(polls).toBe(1)

      await vi.advanceTimersByTimeAsync(200)
      expect(polls).toBe(2)
    }
    finally {
      poller.stop()
      vi.useRealTimers()
    }
  })

  it('停掉之後 wake() 不得把迴圈救活', async () => {
    let polls = 0
    const poller = new ConversationListPoller({
      fetchAll: async () => { polls++; return [] },
      hasForeground: () => true,
    })

    vi.useFakeTimers()
    try {
      poller.start()
      await vi.advanceTimersByTimeAsync(0)
      poller.stop()
      poller.wake()
      await vi.advanceTimersByTimeAsync(LIST_INTERVAL_BACKGROUND_MS * 2)
      expect(polls).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('取數失敗不拋出、不清空快取 —— 一次網路抖動不該讓迴圈死掉', async () => {
    const errors: unknown[] = []
    let calls = 0
    const poller = new ConversationListPoller({
      fetchAll: async () => {
        calls++
        if (calls === 2) throw new Error('網路抖動')
        return [conv({ mode: 'manual' })]
      },
      hasForeground: () => true,
      onError: err => errors.push(err),
    })

    await poller.tick()
    expect(await poller.tick()).toEqual([])
    expect(errors).toHaveLength(1)
    // 快取仍在 —— 路由要靠它讀 mode，不能因為一次失敗就變成 undefined
    expect(poller.latest('c1')?.mode).toBe('manual')
  })

  it('單一訂閱者拋錯不影響其他訂閱者', async () => {
    const errors: unknown[] = []
    const seen: string[] = []
    // ⚠️ 不可用 Date.now() 當變動來源：兩次 tick 常落在同一毫秒，
    //    updatedAt 相同就偵測不到變動，測試會假性失敗
    let revision = 0
    const poller = new ConversationListPoller({
      fetchAll: async () => [conv({ updatedAt: `rev-${revision++}` })],
      hasForeground: () => true,
      onError: err => errors.push(err),
    })

    poller.onChange(() => { throw new Error('壞掉的訂閱者') })
    poller.onChange(c => seen.push(c.conversationId))

    await poller.tick()
    await poller.tick()

    expect(seen).toEqual(['c1'])
    expect(errors).toHaveLength(1)
  })
})
