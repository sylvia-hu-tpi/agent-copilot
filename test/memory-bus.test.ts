/**
 * MemoryEventBus —— docs/ARCHITECTURE.md §8.3
 *
 * 重點是憲法第 6 條：單一訂閱者爆掉不得影響其他訂閱者。
 * SSE 連線斷掉時 handler 丟例外是常態，不是例外情況。
 */

import { describe, expect, it, vi } from 'vitest'
import { MemoryEventBus } from '../server/state/memory-bus.js'
import { conversationTopic, operatorTopic } from '../server/state/types.js'

describe('MemoryEventBus', () => {
  it('publish 會送到同一 topic 的所有訂閱者', async () => {
    const bus = new MemoryEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe('t', a)
    bus.subscribe('t', b)

    await bus.publish('t', { hello: 'world' })

    expect(a).toHaveBeenCalledWith({ hello: 'world' })
    expect(b).toHaveBeenCalledWith({ hello: 'world' })
  })

  it('不同 topic 互不干擾', async () => {
    const bus = new MemoryEventBus()
    const other = vi.fn()
    bus.subscribe('t2', other)

    await bus.publish('t1', {})

    expect(other).not.toHaveBeenCalled()
  })

  it('沒有訂閱者時 publish 不會丟錯', async () => {
    const bus = new MemoryEventBus()
    await expect(bus.publish('nobody', {})).resolves.toBeUndefined()
  })

  it('unsubscribe 後不再收到', async () => {
    const bus = new MemoryEventBus()
    const h = vi.fn()
    const off = bus.subscribe('t', h)
    off()

    await bus.publish('t', {})

    expect(h).not.toHaveBeenCalled()
    expect(bus.subscriberCount('t')).toBe(0)
  })

  it('重複呼叫 unsubscribe 是安全的', () => {
    const bus = new MemoryEventBus()
    const off = bus.subscribe('t', vi.fn())
    off()
    expect(() => off()).not.toThrow()
  })

  it('handler 丟例外不得影響其他 handler —— 憲法第 6 條', async () => {
    const bus = new MemoryEventBus()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const survivor = vi.fn()

    bus.subscribe('t', () => { throw new Error('boom') })
    bus.subscribe('t', survivor)

    await bus.publish('t', {})

    expect(survivor).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('handler 在被呼叫時 unsubscribe 自己不會弄壞這一輪派送', async () => {
    const bus = new MemoryEventBus()
    const later = vi.fn()
    const off = bus.subscribe('t', () => off())
    bus.subscribe('t', later)

    await bus.publish('t', {})

    expect(later).toHaveBeenCalled()
  })
})

describe('topic 命名慣例', () => {
  it('與 §8.3 的表格一致', () => {
    expect(operatorTopic('u_1')).toBe('operator:u_1')
    expect(conversationTopic('conv_1')).toBe('conversation:conv_1')
  })
})
