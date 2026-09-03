/**
 * 共享訂閱與本地增量比對 —— 憲法 6.1、§9.1、§9.3。
 *
 * 涵蓋 §18 M1 的一項驗收：
 *   [ ] 三個瀏覽器檢視同一對話時，該對話**只被輪詢一次**
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PollingMessageSource } from '../server/sources/polling-message-source.js'
import { MemoryStateStore } from '../server/state/memory-store.js'
import type { Message } from '../shared/types/conversation.js'

function msg(id: string, at = '2026-08-25T00:00:00.000Z'): Message {
  return {
    id,
    conversationId: 'c1',
    at,
    sender: { type: 'customer', id: 'con_1' },
    text: id,
  }
}

interface Harness {
  source: PollingMessageSource
  store: MemoryStateStore
  /** fetchLatest 被呼叫的次數 —— 「只被輪詢一次」就是驗這個 */
  calls: () => number
  setMessages: (m: Message[]) => void
}

function makeSource(initial: Message[] = []): Harness {
  const store = new MemoryStateStore({ autoSweep: false })
  let current = initial
  let calls = 0

  const source = new PollingMessageSource({
    fetchLatest: async () => {
      calls++
      return current
    },
    store,
    // 預設當作「未被第一層涵蓋」，讓第二層跑滿 §9.2 頻率
    isListCovered: () => false,
  })

  return {
    source,
    store,
    calls: () => calls,
    setMessages: (m) => { current = m },
  }
}

let active: Harness | undefined

afterEach(async () => {
  await active?.source.dispose()
  active?.store.dispose()
  active = undefined
  vi.useRealTimers()
})

describe('共享訂閱（憲法 6.1）', () => {
  it('三個訂閱者檢視同一對話 → 只拉一次，結果 fan-out 給三個人', async () => {
    active = makeSource([msg('m1')])
    const received: string[][] = [[], [], []]

    active.source.subscribe('c1', ms => received[0]!.push(...ms.map(m => m.id)))
    active.source.subscribe('c1', ms => received[1]!.push(...ms.map(m => m.id)))
    active.source.subscribe('c1', ms => received[2]!.push(...ms.map(m => m.id)))

    await vi.waitFor(() => expect(received[0]).toEqual(['m1']))

    // ⚠️ 這一行是驗收條件本身：三個人看，只能有一次 API 呼叫
    expect(active.calls()).toBe(1)
    expect(received[1]).toEqual(['m1'])
    expect(received[2]).toEqual(['m1'])
    expect(active.source.metrics('c1')?.subscribers).toBe(3)
  })

  it('訂閱數歸零即停止輪詢，並釋放 poll lock', async () => {
    active = makeSource([msg('m1')])
    const off = active.source.subscribe('c1', () => {})
    await vi.waitFor(() => expect(active!.calls()).toBe(1))

    off()

    expect(active.source.metrics('c1')).toBeNull()
    expect(active.source.activeCount()).toBe(0)
    // 鎖必須被釋放，否則另一個副本永遠接手不了（§9.1）
    expect(await active.store.acquirePollLock('c1', 1_000)).toBe(true)
  })

  it('同一位客服開兩個分頁，關掉其中一個不會讓另一個停止收訊息', async () => {
    active = makeSource([msg('m1')])
    const tabA: string[] = []
    const tabB: string[] = []

    const offA = active.source.subscribe('c1', ms => tabA.push(...ms.map(m => m.id)))
    active.source.subscribe('c1', ms => tabB.push(...ms.map(m => m.id)))
    await vi.waitFor(() => expect(tabB).toEqual(['m1']))

    offA()

    // 訂閱者以 symbol 為鍵，不是 operatorId —— 否則這裡會變成 0
    expect(active.source.metrics('c1')?.subscribers).toBe(1)
  })
})

describe('本地 lastMessageId 比對（§9.3 緩解措施 ②）', () => {
  it('首次拉取把整批當新訊息推出去 —— 那是訊息流的初始內容', async () => {
    active = makeSource([msg('m1'), msg('m2')])
    const got: string[] = []
    active.source.subscribe('c1', ms => got.push(...ms.map(m => m.id)))

    await vi.waitFor(() => expect(got).toEqual(['m1', 'm2']))
  })

  it('之後只推「錨點之後」的部分，不重推已知訊息', async () => {
    active = makeSource([msg('m1')])
    const got: string[] = []
    active.source.subscribe('c1', ms => got.push(...ms.map(m => m.id)))
    await vi.waitFor(() => expect(got).toEqual(['m1']))

    active.setMessages([msg('m1'), msg('m2'), msg('m3')])
    active.source.poke('c1')

    await vi.waitFor(() => expect(got).toEqual(['m1', 'm2', 'm3']))
  })

  it('錨點被視窗擠掉時整批重送 —— 寧可重複也不可漏送（§9.4）', async () => {
    active = makeSource([msg('m1')])
    const batches: string[][] = []
    active.source.subscribe('c1', ms => batches.push(ms.map(m => m.id)))
    await vi.waitFor(() => expect(batches).toHaveLength(1))

    // m1 已不在視窗內 —— 模擬斷線太久
    active.setMessages([msg('m8'), msg('m9')])
    active.source.poke('c1')

    await vi.waitFor(() => expect(batches[1]).toEqual(['m8', 'm9']))
  })

  it('沒有新訊息時不呼叫訂閱者 —— 避免畫面無謂重繪', async () => {
    active = makeSource([msg('m1')])
    let notifications = 0
    active.source.subscribe('c1', () => { notifications++ })
    await vi.waitFor(() => expect(notifications).toBe(1))

    active.source.poke('c1')
    await vi.waitFor(() => expect(active!.calls()).toBe(2))
    expect(notifications).toBe(1)
  })
})

describe('fetchSince', () => {
  it('切出錨點之後的訊息', async () => {
    active = makeSource([msg('m1'), msg('m2'), msg('m3')])
    expect((await active.source.fetchSince('c1', 'm1')).map(m => m.id)).toEqual(['m2', 'm3'])
  })

  it('沒有錨點時回傳全部 —— 對話的第一則訊息也要能被撞單檢查看到', async () => {
    active = makeSource([msg('m1'), msg('m2')])
    expect((await active.source.fetchSince('c1', null)).map(m => m.id)).toEqual(['m1', 'm2'])
  })
})

describe('getPriority（specs/002-suggestion-knowledge-search/research.md #9）', () => {
  it('沒有任何訂閱者時回傳 background（安全預設）', async () => {
    active = makeSource([msg('m1')])
    expect(active.source.getPriority('c1')).toBe('background')
  })

  it('至少一位前景訂閱者時回傳 foreground（前景蓋過背景）', async () => {
    active = makeSource([msg('m1')])
    active.source.subscribe('c1', () => {}, { priority: 'background' })
    active.source.subscribe('c1', () => {}, { priority: 'foreground' })
    expect(active.source.getPriority('c1')).toBe('foreground')
  })

  it('全部訂閱者皆為背景時回傳 background', async () => {
    active = makeSource([msg('m1')])
    active.source.subscribe('c1', () => {}, { priority: 'background' })
    expect(active.source.getPriority('c1')).toBe('background')
  })
})

/**
 * specs/003-analysis-trigger-policy 決策 3 —— 分析管線的 JOIN 界線（FR-012、FR-014）。
 *
 * ⚠️ 這是「靜默失效」型的判斷：寫錯不報錯、不會有型別錯誤，只會讓分析在 LEAVE 之後
 *    繼續跑（門檻太寬）或在同事仍 JOIN 時停掉（門檻太窄）。兩者都只能靠這裡驗。
 */
describe('isJoined（specs/003-analysis-trigger-policy 決策 3）', () => {
  it('沒有任何訂閱者時回傳 false（安全預設，比照 getPriority 的 background）', async () => {
    active = makeSource([msg('m1')])
    expect(active.source.isJoined('c1')).toBe(false)
    // 從未見過的對話同樣是 false，不拋錯
    expect(active.source.isJoined('never-seen')).toBe(false)
  })

  it('單一訂閱者 joined:true → true', async () => {
    active = makeSource([msg('m1')])
    active.source.subscribe('c1', () => {}, { joined: true })
    expect(active.source.isJoined('c1')).toBe(true)
  })

  it('未指定 joined 時預設為 false（subscribe 的既有預設值）', async () => {
    active = makeSource([msg('m1')])
    active.source.subscribe('c1', () => {})
    expect(active.source.isJoined('c1')).toBe(false)
  })

  it('兩位訂閱者其一 joined:false → 仍為 true（對話層級聚合，FR-014）', async () => {
    active = makeSource([msg('m1')])
    active.source.subscribe('c1', () => {}, { joined: true })
    active.source.subscribe('c1', () => {}, { joined: false })
    expect(active.source.isJoined('c1')).toBe(true)
  })

  it('全部退訂後回傳 false —— entry 被回收，等同從未 JOIN', async () => {
    active = makeSource([msg('m1')])
    const offA = active.source.subscribe('c1', () => {}, { joined: true })
    const offB = active.source.subscribe('c1', () => {}, { joined: false })

    offA()
    // 只剩 joined:false 的那位 → 聚合翻為 false（這正是最後一位客服 LEAVE 的形狀）
    expect(active.source.isJoined('c1')).toBe(false)

    offB()
    expect(active.source.isJoined('c1')).toBe(false)
  })
})

describe('錯誤處理（憲法 3.2 靜默降級）', () => {
  it('單一訂閱者拋錯不影響其他訂閱者', async () => {
    active = makeSource([msg('m1')])
    const good: string[] = []
    const errors: unknown[] = []

    const store = active.store
    const source = new PollingMessageSource({
      fetchLatest: async () => [msg('m1')],
      store,
      isListCovered: () => false,
      onError: (_id, err) => errors.push(err),
    })
    active.source = source

    source.subscribe('c1', () => { throw new Error('壞掉的訂閱者') })
    source.subscribe('c1', ms => good.push(...ms.map(m => m.id)))

    await vi.waitFor(() => expect(good).toEqual(['m1']))
    expect(errors).toHaveLength(1)
  })

  it('取數失敗不會讓輪詢迴圈死掉', async () => {
    const store = new MemoryStateStore({ autoSweep: false })
    const errors: unknown[] = []
    let attempt = 0

    const source = new PollingMessageSource({
      fetchLatest: async () => {
        attempt++
        if (attempt === 1) throw new Error('網路抖動')
        return [msg('m1')]
      },
      store,
      isListCovered: () => false,
      onError: (_id, err) => errors.push(err),
    })
    active = { source, store, calls: () => attempt, setMessages: () => {} }

    const got: string[] = []
    source.subscribe('c1', ms => got.push(...ms.map(m => m.id)))
    await vi.waitFor(() => expect(errors).toHaveLength(1))

    source.poke('c1')
    await vi.waitFor(() => expect(got).toEqual(['m1']))
  })
})
