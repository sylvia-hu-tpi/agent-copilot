/**
 * MemoryStateStore —— docs/ARCHITECTURE.md §8.3
 *
 * 這裡驗證的是「語意」而非實作細節，因為 M4 換 Redis 時同一份測試要能直接沿用：
 * 過期、poll lock 互斥、去重方向（seen 回 true 代表重複）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStateStore } from '../server/state/memory-store.js'
import type { ActiveSession } from '../server/state/types.js'

/** autoSweep 關掉：測試自行控制時間，不要有背景計時器介入 */
function makeStore() {
  return new MemoryStateStore({ autoSweep: false })
}

function activeSession(expiresInMs: number): ActiveSession {
  return {
    stage: 'active',
    email: 'agent@example.com',
    operatorId: 'u_1',
    operatorName: '測試客服',
    orgId: 'org_a',
    orgName: '客服一部',
    accessToken: 'acc_secret',
    // 切換組織所需（U-3）—— 兩者都不得離開 server，見 ActiveSession 的說明
    loginToken: 'login_acc_secret',
    organizations: [{ id: 'org_a', name: '客服一部' }],
    expiresAt: Date.now() + expiresInMs,
  }
}

const presenceEntry = (operatorId: string) => ({
  operatorId,
  operatorName: '客服',
  state: 'viewing' as const,
  // §10.2：'viewing'（正在檢視）與 joined（已加入）是兩個正交維度，不可併成一個列舉
  joined: false,
  source: 'sse' as const,
  at: new Date().toISOString(),
})

afterEach(() => {
  vi.useRealTimers()
})

describe('session', () => {
  it('存得進、取得回', async () => {
    const store = makeStore()
    await store.setSession('sid', activeSession(60_000))
    expect((await store.getSession('sid'))?.stage).toBe('active')
  })

  it('過期的 session 讀不到，且會就地清掉', async () => {
    const store = makeStore()
    await store.setSession('sid', activeSession(-1))
    expect(await store.getSession('sid')).toBeNull()
    expect(await store.getSession('sid')).toBeNull()
  })

  it('刪除後讀不到', async () => {
    const store = makeStore()
    await store.setSession('sid', activeSession(60_000))
    await store.deleteSession('sid')
    expect(await store.getSession('sid')).toBeNull()
  })
})

describe('presence', () => {
  it('同一人重複上報只留一筆', async () => {
    const store = makeStore()
    await store.addPresence('conv_1', presenceEntry('u_1'), 60_000)
    await store.addPresence('conv_1', presenceEntry('u_1'), 60_000)
    expect(await store.listPresence('conv_1')).toHaveLength(1)
  })

  it('TTL 到了就自動消失 —— 瀏覽器沒送 LEAVE 就關掉時不會留下幽靈', async () => {
    vi.useFakeTimers()
    const store = makeStore()
    await store.addPresence('conv_1', presenceEntry('u_1'), 5_000)

    vi.advanceTimersByTime(4_000)
    expect(await store.listPresence('conv_1')).toHaveLength(1)

    vi.advanceTimersByTime(2_000)
    expect(await store.listPresence('conv_1')).toHaveLength(0)
  })

  it('沒有任何人時回空陣列，不是 null —— §10.2 空狀態是常態', async () => {
    const store = makeStore()
    expect(await store.listPresence('conv_never_seen')).toEqual([])
  })

  it('移除單一 operator 不影響其他人', async () => {
    const store = makeStore()
    await store.addPresence('conv_1', presenceEntry('u_1'), 60_000)
    await store.addPresence('conv_1', presenceEntry('u_2'), 60_000)
    await store.removePresence('conv_1', 'u_1')

    const list = await store.listPresence('conv_1')
    expect(list.map(e => e.operatorId)).toEqual(['u_2'])
  })
})

describe('poll lock', () => {
  it('第二個取用者拿不到鎖 —— §9.1 共享訂閱靠這個保證一個對話只輪詢一次', async () => {
    const store = makeStore()
    expect(await store.acquirePollLock('conv_1', 10_000)).toBe(true)
    expect(await store.acquirePollLock('conv_1', 10_000)).toBe(false)
  })

  it('釋放後可再取得', async () => {
    const store = makeStore()
    await store.acquirePollLock('conv_1', 10_000)
    await store.releasePollLock('conv_1')
    expect(await store.acquirePollLock('conv_1', 10_000)).toBe(true)
  })

  it('持有者當掉沒釋放時，鎖會隨 TTL 自動失效', async () => {
    vi.useFakeTimers()
    const store = makeStore()
    await store.acquirePollLock('conv_1', 5_000)

    vi.advanceTimersByTime(6_000)
    expect(await store.acquirePollLock('conv_1', 5_000)).toBe(true)
  })

  it('不同對話的鎖互不影響', async () => {
    const store = makeStore()
    await store.acquirePollLock('conv_1', 10_000)
    expect(await store.acquirePollLock('conv_2', 10_000)).toBe(true)
  })
})

describe('seen（去重）', () => {
  it('首見回 false、再見回 true —— 方向容易寫反，這條就是防呆', async () => {
    const store = makeStore()
    expect(await store.seen('evt_1', 60_000)).toBe(false)
    expect(await store.seen('evt_1', 60_000)).toBe(true)
  })

  it('不同 key 互不影響', async () => {
    const store = makeStore()
    await store.seen('evt_1', 60_000)
    expect(await store.seen('evt_2', 60_000)).toBe(false)
  })

  it('TTL 過後視為新事件', async () => {
    vi.useFakeTimers()
    const store = makeStore()
    await store.seen('evt_1', 5_000)

    vi.advanceTimersByTime(6_000)
    expect(await store.seen('evt_1', 5_000)).toBe(false)
  })
})

describe('sweep', () => {
  it('把過期的 session / presence / lock / seen 全部清掉', async () => {
    const store = makeStore()
    await store.setSession('sid', activeSession(-1))
    await store.addPresence('conv_1', presenceEntry('u_1'), -1)
    await store.acquirePollLock('conv_1', -1)
    await store.seen('evt_1', -1)

    store.sweep()

    expect(await store.getSession('sid')).toBeNull()
    expect(await store.listPresence('conv_1')).toEqual([])
    expect(await store.acquirePollLock('conv_1', 10_000)).toBe(true)
    expect(await store.seen('evt_1', 10_000)).toBe(false)
  })
})
