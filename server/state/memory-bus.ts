/**
 * EventBus 的記憶體實作 —— docs/ARCHITECTURE.md §8.3。
 *
 * ⚠️ 僅適用單副本：publish 只會送達「同一個 Node 程序內」的訂閱者。
 *    M4 換 redis-bus.ts（Redis pub/sub）後才能跨副本。
 */

import type { EventBus, Unsubscribe } from './types.js'

type Handler = (payload: unknown) => void

export class MemoryEventBus implements EventBus {
  private topics = new Map<string, Set<Handler>>()

  async publish(topic: string, payload: unknown): Promise<void> {
    const handlers = this.topics.get(topic)
    if (!handlers) return
    // 複製一份再迭代：handler 內部可能 unsubscribe 自己
    for (const h of [...handlers]) {
      try {
        h(payload)
      }
      catch (err) {
        // ⚠️ 憲法 3.2：單一訂閱者爆掉不得影響其他訂閱者與訊息流。
        // 不輸出 payload —— 憲法 1.5，日誌不得帶訊息全文。
        console.error(`[event-bus] handler failed on topic ${topic}:`, (err as Error).message)
      }
    }
  }

  subscribe(topic: string, handler: Handler): Unsubscribe {
    let handlers = this.topics.get(topic)
    if (!handlers) {
      handlers = new Set()
      this.topics.set(topic, handlers)
    }
    handlers.add(handler)

    let done = false
    return () => {
      if (done) return
      done = true
      handlers.delete(handler)
      if (handlers.size === 0) this.topics.delete(topic)
    }
  }

  /** 監控用（§17：SSE 連線數的粗略上界） */
  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0
  }
}
