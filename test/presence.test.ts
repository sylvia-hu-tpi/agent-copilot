/**
 * Presence 四來源合併 —— §10.2。
 *
 * 涵蓋 §18 M1 的兩項驗收：
 *   [ ] PresenceBar 在**無人**時顯示正常空狀態
 *   [ ] `u_` 反推的同事標示為「N 分鐘前回覆過」，**不可**標示成「正在檢視」
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  hasUnidentifiedActor,
  inferFromMessages,
  reportViewing,
  snapshotOf,
  MESSAGE_INFERENCE_WINDOW_MS,
} from '../server/services/presence.js'
import { rememberOperators, resetDirectory } from '../server/services/directory.js'
import { MemoryStateStore } from '../server/state/memory-store.js'
import type { Message } from '../shared/types/conversation.js'

const ORG = 'org_1'
const CONV = 'c1'

function agentMessage(id: string, from: string, minutesAgo = 1): Message {
  return {
    id,
    conversationId: CONV,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sender: { type: 'agent', id: from },
    text: 'hi',
  }
}

let store: MemoryStateStore | undefined

afterEach(() => {
  store?.dispose()
  store = undefined
  resetDirectory()
})

function makeStore(): MemoryStateStore {
  store = new MemoryStateStore({ autoSweep: false })
  return store
}

// ── ③ mode 訊號：最容易寫成假警報的地方 ────────────────────────────

describe('hasUnidentifiedActor —— ③ mode 的判定', () => {
  it('mode=automation / null 時不報告有人 —— 那兩個值代表沒人能送出訊息', () => {
    expect(hasUnidentifiedActor('automation', { viewerJoined: false, namedCount: 0 })).toBe(false)
    expect(hasUnidentifiedActor(null, { viewerJoined: false, namedCount: 0 })).toBe(false)
  })

  it('mode=manual/hybrid 且我沒 JOIN、也看不到具名的人 → 報告「有同事正在處理」', () => {
    expect(hasUnidentifiedActor('manual', { viewerJoined: false, namedCount: 0 })).toBe(true)
    expect(hasUnidentifiedActor('hybrid', { viewerJoined: false, namedCount: 0 })).toBe(true)
  })

  it('⚠️ 我自己 JOIN 之後不可報告 —— 否則每位客服都會看到「有同事」而那是他自己', () => {
    // 這是設計期抓到的真實缺陷：mode 是對話層級狀態，我 JOIN 就會讓它變成 manual。
    // 少了 viewerJoined 這個條件，假警報會出現在每一次 JOIN 之後。
    expect(hasUnidentifiedActor('manual', { viewerJoined: true, namedCount: 0 })).toBe(false)
    expect(hasUnidentifiedActor('hybrid', { viewerJoined: true, namedCount: 0 })).toBe(false)
  })

  it('已經知道是誰時不再另外報告 —— 會被讀成「除了看得到的人以外還另有其人」', () => {
    expect(hasUnidentifiedActor('manual', { viewerJoined: false, namedCount: 1 })).toBe(false)
  })
})

// ── ①② 的合併規則 ──────────────────────────────────────────────────

describe('來源合併', () => {
  it('無人時回空陣列且不報告匿名者 —— 空狀態是常態，不是壞掉', async () => {
    const s = makeStore()
    const snap = await snapshotOf(s, CONV, { mode: null })
    expect(snap.operators).toEqual([])
    expect(snap.unidentifiedActor).toBe(false)
  })

  it('② 反推出來的同事 source 必須是 message、state 不可是 viewing', async () => {
    const s = makeStore()
    rememberOperators(ORG, [{ id: 'u_lee', name: '李小華' }])

    await inferFromMessages(s, CONV, [agentMessage('m1', 'u_lee', 3)], {
      orgId: ORG,
      excludeOperatorId: 'u_me',
    })

    const [entry] = await s.listPresence(CONV)
    expect(entry?.source).toBe('message')
    // ⚠️ 顯示成「正在檢視」會讓客服以為有人守著而實際沒人 —— 比不顯示更糟
    expect(entry?.state).not.toBe('viewing')
    expect(entry?.operatorName).toBe('李小華')
    // ⚠️ 也不可推論成「現在能送出訊息」—— 那是過去式
    expect(entry?.joined).toBe(false)
  })

  it('查不到姓名時留白，不可自行編一個', async () => {
    const s = makeStore()
    await inferFromMessages(s, CONV, [agentMessage('m1', 'u_stranger')], { orgId: ORG })
    const [entry] = await s.listPresence(CONV)
    expect(entry?.operatorName).toBe('')
  })

  it('② 不可覆蓋同一個人的 ① —— 那是資訊降級', async () => {
    const s = makeStore()
    await reportViewing(s, CONV, { id: 'u_lee', name: '李小華' }, 'composing', true)
    await inferFromMessages(s, CONV, [agentMessage('m1', 'u_lee')], { orgId: ORG })

    const [entry] = await s.listPresence(CONV)
    // 同事還在打字，不該退回「3 分鐘前回覆過」
    expect(entry?.source).toBe('sse')
    expect(entry?.state).toBe('composing')
  })

  it('超出反推窗口的訊息不列入', async () => {
    const s = makeStore()
    const tooOld = MESSAGE_INFERENCE_WINDOW_MS / 60_000 + 5
    await inferFromMessages(s, CONV, [agentMessage('m1', 'u_lee', tooOld)], { orgId: ORG })
    expect(await s.listPresence(CONV)).toEqual([])
  })

  it('排除自己 —— 「我 1 分鐘前回覆過」沒有意義，還會擠掉該看的人', async () => {
    const s = makeStore()
    await inferFromMessages(s, CONV, [agentMessage('m1', 'u_me')], {
      orgId: ORG,
      excludeOperatorId: 'u_me',
    })
    expect(await s.listPresence(CONV)).toEqual([])
  })

  it('snapshotOf 把自己排除掉 —— PresenceBar 回答的是「還有誰」', async () => {
    const s = makeStore()
    await reportViewing(s, CONV, { id: 'u_me', name: '我' }, 'viewing', false)
    await reportViewing(s, CONV, { id: 'u_lee', name: '李小華' }, 'viewing', false)

    const snap = await snapshotOf(s, CONV, { mode: 'manual', excludeOperatorId: 'u_me' })
    expect(snap.operators.map(o => o.operatorId)).toEqual(['u_lee'])
  })

  it('① 排在 ② 前面 —— 可信度高的先顯示', async () => {
    const s = makeStore()
    await inferFromMessages(s, CONV, [agentMessage('m1', 'u_lee')], { orgId: ORG })
    await reportViewing(s, CONV, { id: 'u_wang', name: '王大明' }, 'composing', true)

    const snap = await snapshotOf(s, CONV, { mode: 'manual' })
    expect(snap.operators.map(o => o.source)).toEqual(['sse', 'message'])
  })

  it('viewerJoined 未明講時，從自己的 presence 條目推得出來', async () => {
    const s = makeStore()
    await reportViewing(s, CONV, { id: 'u_me', name: '我' }, 'joined', true)

    const snap = await snapshotOf(s, CONV, { mode: 'manual', excludeOperatorId: 'u_me' })
    // 我 JOIN 了 → manual 是我造成的 → 不可報告「有同事」
    expect(snap.unidentifiedActor).toBe(false)
  })
})
