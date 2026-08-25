/**
 * StateStore / EventBus 的單一取得入口 —— docs/ARCHITECTURE.md §8.3。
 *
 * 呼叫端一律走這裡，不要直接 new MemoryStateStore()。
 * M4 要換 Redis 時，只需改動本檔的分派邏輯。
 *
 * ⚠️ 實例掛在 globalThis 而非模組變數：dev 模式下 Nitro HMR 會重新載入模組，
 *    模組層級的單例會被重建，登入中的 session 每次存檔都會消失。
 */

import { MemoryEventBus } from './memory-bus.js'
import { MemoryStateStore } from './memory-store.js'
import type { EventBus, StateStore } from './types.js'

const STORE_KEY = Symbol.for('agent-copilot.state-store')
const BUS_KEY = Symbol.for('agent-copilot.event-bus')

type Global = typeof globalThis & {
  [STORE_KEY]?: StateStore
  [BUS_KEY]?: EventBus
}

export function useStateStore(): StateStore {
  const g = globalThis as Global
  if (!g[STORE_KEY]) {
    // M4：若 runtimeConfig.redisUrl 有值則改用 RedisStateStore
    g[STORE_KEY] = new MemoryStateStore()
  }
  return g[STORE_KEY]
}

export function useEventBus(): EventBus {
  const g = globalThis as Global
  if (!g[BUS_KEY]) {
    g[BUS_KEY] = new MemoryEventBus()
  }
  return g[BUS_KEY]
}

export * from './types.js'
