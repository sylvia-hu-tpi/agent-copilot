/**
 * 左欄「你在此對話中」的判定 —— docs/ARCHITECTURE.md §10.2.1。
 *
 * ⚠️ **這個檔案守的是「成本」與「不亂標」兩件事，不只是正確性。**
 *
 * 平台清單沒有 `is_joined`（實測 0/16），要標就得補查詳情；而前景清單輪詢是 3 秒一次。
 * 因此「哪些情況**不可以**打平台」與「不確定時該倒向哪一邊」跟「答案對不對」一樣重要 ——
 * 前者一旦破功，症狀是上線後的請求量隨對話總量成長，而**測試與型別都不會有任何反應**。
 */

import { describe, expect, it, vi } from 'vitest'
import type { ImbraceClient } from '@imbrace/sdk'
import type { Conversation } from '../shared/types/conversation.js'
import { MemoryStateStore } from '../server/state/memory-store.js'
import {
  annotateViewerJoined,
  VIEWER_JOINED_RESOLVE_LIMIT,
} from '../server/services/viewer-joined.js'

const OP = 'u_me'

function makeStore() {
  return new MemoryStateStore({ autoSweep: false })
}

function conv(id: string, mode: Conversation['mode']): Conversation {
  return {
    id,
    channel: 'web',
    contactId: `con_${id}`,
    status: 'active',
    name: `TWN#${id.toUpperCase()}`,
    mode,
    operators: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

/**
 * 假的平台 client —— 只實作 `conversations.get()`，那是 `getConversationDetail()` 唯一用到的。
 * `detail` 決定每個 id 回什麼；`get` 是 spy，用來斷言「有沒有打平台、打了幾次」。
 */
function makeClient(detail: Record<string, { is_joined?: boolean, mode?: string } | Error>) {
  const get = vi.fn(async (id: string) => {
    const d = detail[id]
    if (d instanceof Error) throw d
    return d ?? null
  })
  return { client: { conversations: { get } } as unknown as ImbraceClient, get }
}

describe('不必打平台就答得出來的情況（成本控制的主體）', () => {
  it('我方自己 JOIN 過的 → true，且完全不打平台', async () => {
    const store = makeStore()
    await store.addJoinedConversation(OP, 'c1')
    const { client, get } = makeClient({})

    const items = [conv('c1', 'manual')]
    await annotateViewerJoined(store, client, OP, items)

    expect(items[0]!.viewerJoined).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  it('沒有人能送出訊息（mode 為 automation／null）→ false，且不打平台', async () => {
    const store = makeStore()
    const { client, get } = makeClient({})

    const items = [conv('c1', 'automation'), conv('c2', null)]
    await annotateViewerJoined(store, client, OP, items)

    expect(items.map(i => i.viewerJoined)).toEqual([false, false])
    expect(get).not.toHaveBeenCalled()
  })

  it('快取命中且 mode 未變 → 用快取，不打平台（這是 3 秒輪詢下的常態路徑）', async () => {
    const store = makeStore()
    await store.setViewerJoined(OP, 'c1', { joined: false, mode: 'manual' })
    const { client, get } = makeClient({ c1: { is_joined: true, mode: 'manual' } })

    const items = [conv('c1', 'manual')]
    await annotateViewerJoined(store, client, OP, items)

    expect(items[0]!.viewerJoined).toBe(false)
    expect(get).not.toHaveBeenCalled()
  })

  it('「答案是 false」也必須進快取 —— 否則同事的對話每輪都會再問一次平台', async () => {
    const store = makeStore()
    const { client } = makeClient({})

    await annotateViewerJoined(store, client, OP, [conv('c1', 'automation')])

    expect(await store.getViewerJoined(OP, 'c1')).toEqual({ joined: false, mode: 'automation' })
  })
})

describe('`mode` 是失效訊號', () => {
  it('快取的 mode 與現值不同 → 重新向平台解析', async () => {
    const store = makeStore()
    await store.setViewerJoined(OP, 'c1', { joined: false, mode: 'automation' })
    const { client, get } = makeClient({ c1: { is_joined: true, mode: 'manual' } })

    const items = [conv('c1', 'manual')]
    await annotateViewerJoined(store, client, OP, items)

    expect(get).toHaveBeenCalledTimes(1)
    expect(items[0]!.viewerJoined).toBe(true)
    // 重新解析後要把新的 mode 一起記下來，否則下一輪還會再問一次
    expect(await store.getViewerJoined(OP, 'c1')).toEqual({ joined: true, mode: 'manual' })
  })

  it('解析結果取自**詳情**的 mode，不是清單的 —— 兩者不同步時詳情較新', async () => {
    const store = makeStore()
    const { client } = makeClient({ c1: { is_joined: false, mode: 'hybrid' } })

    await annotateViewerJoined(store, client, OP, [conv('c1', 'manual')])

    expect(await store.getViewerJoined(OP, 'c1')).toEqual({ joined: false, mode: 'hybrid' })
  })
})

describe('單輪上限：削平冷啟動的突刺', () => {
  it(`候選超過 ${VIEWER_JOINED_RESOLVE_LIMIT} 則時，這一輪只解析前 ${VIEWER_JOINED_RESOLVE_LIMIT} 則`, async () => {
    const store = makeStore()
    const n = VIEWER_JOINED_RESOLVE_LIMIT + 5
    const detail: Record<string, { is_joined: boolean, mode: string }> = {}
    for (let i = 0; i < n; i++) detail[`c${i}`] = { is_joined: false, mode: 'manual' }
    const { client, get } = makeClient(detail)

    const items = Array.from({ length: n }, (_, i) => conv(`c${i}`, 'manual'))
    await annotateViewerJoined(store, client, OP, items)

    expect(get).toHaveBeenCalledTimes(VIEWER_JOINED_RESOLVE_LIMIT)
    // 排不進來的維持 undefined ——「還不知道」，不是「不是我」
    expect(items[n - 1]!.viewerJoined).toBeUndefined()
  })

  it('沒解析到的下一輪會補上（上限是突刺上限，不是正確性上限）', async () => {
    const store = makeStore()
    const n = VIEWER_JOINED_RESOLVE_LIMIT + 2
    const detail: Record<string, { is_joined: boolean, mode: string }> = {}
    for (let i = 0; i < n; i++) detail[`c${i}`] = { is_joined: true, mode: 'manual' }
    const { client } = makeClient(detail)

    const first = Array.from({ length: n }, (_, i) => conv(`c${i}`, 'manual'))
    await annotateViewerJoined(store, client, OP, first)
    const second = Array.from({ length: n }, (_, i) => conv(`c${i}`, 'manual'))
    await annotateViewerJoined(store, client, OP, second)

    expect(second.every(i => i.viewerJoined === true)).toBe(true)
  })
})

describe('降級：這一欄壞掉不可以把清單一起打掉', () => {
  it('平台查詢失敗 → 不拋錯，其他項目的答案仍在', async () => {
    const store = makeStore()
    const { client } = makeClient({
      c1: new Error('boom'),
      c2: { is_joined: true, mode: 'manual' },
    })

    const items = [conv('c1', 'manual'), conv('c2', 'manual')]
    await expect(annotateViewerJoined(store, client, OP, items)).resolves.toBeDefined()

    expect(items[0]!.viewerJoined).toBeUndefined()
    expect(items[1]!.viewerJoined).toBe(true)
  })

  it('失敗的那則**不寫快取** —— 否則一次網路失誤會變成要等 mode 變動才消失的錯誤答案', async () => {
    const store = makeStore()
    const { client } = makeClient({ c1: new Error('boom') })

    await annotateViewerJoined(store, client, OP, [conv('c1', 'manual')])

    expect(await store.getViewerJoined(OP, 'c1')).toBeUndefined()
  })
})

describe('快取是每位客服各一份', () => {
  it('A 的答案不會外洩給 B', async () => {
    const store = makeStore()
    await store.setViewerJoined('u_a', 'c1', { joined: true, mode: 'manual' })

    expect(await store.getViewerJoined('u_b', 'c1')).toBeUndefined()
  })
})
