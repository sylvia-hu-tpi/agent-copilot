/**
 * 多連線的計數 —— specs/005-m2-residual-defects US1（FR-001～FR-006a、SC-001／SC-002／SC-002a），
 * contracts/connection-lifecycle.md 的八條不變式 I-1～I-8 逐條對應。
 *
 * ⚠️ **這一組測試就是本 story「壞掉時會變紅的東西」。** 雙分頁缺陷不報錯、不影響型別、
 *    畫面看起來完全正常（訊息流還在、輸入框還能打字），只是客戶接下來說的話再也不會出現。
 *
 * ⚠️ 驗的是 `credentials.ts` 與 `session-registry.ts`，**不是** `session-manager.ts`／`stream.get.ts`：
 *    後兩者經 `copilot-runtime.ts` 用到 Nitro auto-import，vitest／tsc 碰不得
 *    （理由見 `session-registry.ts` 檔頭）。真實 HTTP／SSE 的端到端由 `test/realtime-http.ts` 涵蓋。
 *
 * ⚠️ **回收是惰性的**（research.md #4）：推進假時鐘本身**不會移除任何東西**，登記要在
 *    `borrowCredential()` 之類的讀取點跑過之後才真的消失。下面每一條「被剔除」的斷言都先讀一次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CREDENTIAL_HEARTBEAT_MS,
  CREDENTIAL_TTL_MS,
  borrowCredential,
  hasForegroundOperator,
  registerCredential,
  registeredCredentials,
  registeredOrgIds,
  resetCredentials,
  setCredentialActivity,
  touchCredential,
} from '../server/services/credentials.js'
import {
  acquirePipeline,
  attachWatcher,
  detachWatcher,
  pipelineCount,
  pipelineRefs,
  releasePipelineRef,
  resetSessionRegistry,
} from '../server/services/session-registry.js'
import { useStateStore } from '../server/state/index.js'

const ORG = 'org_cc'
const ALICE = 'u_alice'
const BOB = 'u_bob'

let seq = 0
function convId(label: string): string {
  return `conv-cc-${label}-${Date.now()}-${++seq}`
}

function register(operatorId: string, connectionId: string, clientId = `client-${connectionId}`, orgId = ORG) {
  return registerCredential({ connectionId, clientId, operatorId, orgId, accessToken: `acc_${operatorId}_${connectionId}` })
}

function identity(operatorId: string, clientId: string) {
  return { orgId: ORG, operatorId, clientId, accessToken: `acc_${operatorId}_beat` }
}

// ── session-registry 的三步驟包裝：每一步之後都驗 I-4 ─────────────────

async function expectInvariant(conversationId: string): Promise<void> {
  const session = await useStateStore().getCopilotSession(conversationId)
  expect(session?.watchers.length ?? 0).toBe(pipelineRefs(conversationId) ?? 0)
}

async function attach(conversationId: string, operatorId: string, connectionId: string): Promise<void> {
  await attachWatcher(conversationId, { operatorId, connectionId })
  acquirePipeline(conversationId, () => () => {})
  await expectInvariant(conversationId)
}

/** 關線（正常關閉與異常中斷走的是**同一條**清理路徑，FR-005） */
async function release(conversationId: string, connectionId: string): Promise<'closed' | 'open' | 'missing'> {
  await detachWatcher(conversationId, connectionId)
  const result = releasePipelineRef(conversationId)
  await expectInvariant(conversationId)
  return result
}

beforeEach(() => {
  resetCredentials()
  resetSessionRegistry()
})

afterEach(() => {
  vi.useRealTimers()
  resetCredentials()
  resetSessionRegistry()
})

// ── T004：I-1／I-2／I-3（憑證登記）──────────────────────────────────────

describe('I-1：一條 SSE 連線 ⟺ 恰好一筆憑證登記（FR-001／FR-002）', () => {
  it('同一位客服兩條連線 → 兩筆登記；關掉一條只移除那一筆，另一條仍可借到', () => {
    const offA = register(ALICE, 'conn-a')
    register(ALICE, 'conn-b')
    expect(registeredCredentials(ORG)).toHaveLength(2)

    offA()
    const left = registeredCredentials(ORG)
    expect(left).toHaveLength(1)
    expect(left[0]?.connectionId).toBe('conn-b')
    // 對照現況（修正前）：關掉其中一個，整個 operator 的項目被刪，這裡會是 null
    expect(borrowCredential(ORG)?.accessToken).toBe(`acc_${ALICE}_conn-b`)
  })

  it('unsubscribe 是冪等的：呼叫兩次不會誤刪別條連線', () => {
    const offA = register(ALICE, 'conn-a')
    register(ALICE, 'conn-b')
    offA()
    offA()
    expect(registeredCredentials(ORG).map(c => c.connectionId)).toEqual(['conn-b'])
  })
})

describe('I-2：逾期登記不被 borrowCredential() 回傳（FR-005a、SC-002）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('推進超過 CREDENTIAL_TTL_MS 後 borrowCredential() 回 null，且該筆在讀取時被剔除', () => {
    register(ALICE, 'conn-a')
    vi.advanceTimersByTime(CREDENTIAL_TTL_MS + 1_000)

    expect(borrowCredential(ORG)).toBeNull()
    expect(registeredCredentials(ORG)).toHaveLength(0)
    expect(registeredOrgIds()).not.toContain(ORG)
  })

  it('未逾期者照常回傳；混雜時只剔除逾期的那一筆', () => {
    register(ALICE, 'conn-old')
    vi.advanceTimersByTime(30_000)
    register(BOB, 'conn-new')
    vi.advanceTimersByTime(20_000) // old 已 50 秒無心跳、new 才 20 秒

    expect(borrowCredential(ORG)?.connectionId).toBe('conn-new')
    expect(registeredCredentials(ORG).map(c => c.connectionId)).toEqual(['conn-new'])
  })
})

describe('I-3：hasForegroundOperator() ＝ 任一未逾期登記為前景（FR-002）', () => {
  it('兩個分頁一前景一背景 → true；兩者都背景 → false（修正前是後送者贏）', () => {
    register(ALICE, 'conn-a', 'client-a')
    register(ALICE, 'conn-b', 'client-b')
    setCredentialActivity(ORG, ALICE, 'client-b', 'background')
    expect(hasForegroundOperator(ORG)).toBe(true)

    setCredentialActivity(ORG, ALICE, 'client-a', 'background')
    expect(hasForegroundOperator(ORG)).toBe(false)

    setCredentialActivity(ORG, ALICE, 'client-b', 'foreground')
    expect(hasForegroundOperator(ORG)).toBe(true)
  })

  it('逾期的前景登記不算數', () => {
    vi.useFakeTimers()
    register(ALICE, 'conn-a')
    vi.advanceTimersByTime(CREDENTIAL_TTL_MS + 1)
    expect(hasForegroundOperator(ORG)).toBe(false)
  })

  it('沒有登記可依附時 setCredentialActivity() 是 no-op（不 upsert，重建是連線心跳的責任）', () => {
    expect(() => setCredentialActivity(ORG, ALICE, 'ghost', 'foreground')).not.toThrow()
    expect(registeredCredentials(ORG)).toHaveLength(0)
  })
})

// ── T005：I-4 —— watchers.length === pipeline.refs（FR-004）───────────────

/**
 * ⚠️ **驗的是單副本。** `pipeline.refs` 是 process-local 的 Map，`watchers` 進 `StateStore`
 *    （M4 換 Redis 後跨副本）；多副本下這條等式本來就不成立（data-model.md §2）。
 *    本規格不擴大也不解決那個落差，這裡只保證單一副本內兩個計數器對同一件事給同一個答案。
 */
describe('I-4（單副本）：session.watchers.length === pipeline.refs 在每次 attach／release 後成立', () => {
  it('同一客服兩條連線：關掉一條 → 1 === 1、session 不刪；關掉第二條 → 0、session 與 pipeline 一起消失', async () => {
    const conv = convId('same-op')
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, ALICE, 'conn-b')
    expect(pipelineRefs(conv)).toBe(2)

    expect(await release(conv, 'conn-a')).toBe('open')
    expect((await useStateStore().getCopilotSession(conv))?.watchers).toEqual([{ operatorId: ALICE, connectionId: 'conn-b' }])

    expect(await release(conv, 'conn-b')).toBe('closed')
    expect(await useStateStore().getCopilotSession(conv)).toBeNull()
    expect(pipelineRefs(conv)).toBeNull()
  })

  it('兩位客服各一條：其中一位離開 → 另一位不受影響（既有行為不退步，FR-006）', async () => {
    const conv = convId('two-ops')
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, BOB, 'conn-b')

    expect(await release(conv, 'conn-a')).toBe('open')
    expect((await useStateStore().getCopilotSession(conv))?.watchers).toEqual([{ operatorId: BOB, connectionId: 'conn-b' }])
    expect(pipelineRefs(conv)).toBe(1)
  })

  /**
   * 異常中斷（網路斷、瀏覽器崩潰）：`stream.onClosed()` 一樣會跑到，走的是**同一條**清理路徑（FR-005）。
   * 在單元層級它與正常關閉沒有區別 —— 這條的價值是把「同一條路徑」寫成斷言，
   * 日後若有人為異常中斷另闢一條清理路，等式會在這裡先紅。
   */
  it('異常中斷走同一條清理路徑：等式仍成立', async () => {
    const conv = convId('abnormal')
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, ALICE, 'conn-b')

    // 模擬 conn-b 的 socket 被硬拔：呼叫端拿到的仍是同一支 release
    expect(await release(conv, 'conn-b')).toBe('open')
    expect(await release(conv, 'conn-a')).toBe('closed')
    expect(pipelineCount()).toBe(0)
  })

  it('I-6：同一 connectionId 對同一對話至多一筆（attach 重入不會重複計數）', async () => {
    const conv = convId('dup-conn')
    await attachWatcher(conv, { operatorId: ALICE, connectionId: 'conn-a' })
    await attachWatcher(conv, { operatorId: ALICE, connectionId: 'conn-a' })
    expect((await useStateStore().getCopilotSession(conv))?.watchers).toHaveLength(1)
  })

  it('isResume：同一客服的第二個分頁現在是 resume（005 的行為變更，data-model §2）', async () => {
    const conv = convId('resume')
    const first = await attachWatcher(conv, { operatorId: ALICE, connectionId: 'conn-a' })
    const second = await attachWatcher(conv, { operatorId: ALICE, connectionId: 'conn-b' })
    expect(first.isResume).toBe(false)
    expect(second.isResume).toBe(true)
  })
})

// ── T006：contracts §3 的四個情境 ───────────────────────────────────────

describe('contracts/connection-lifecycle.md §3：必須通過的四個情境', () => {
  it('① 同一客服兩條連線，關掉一條 → borrowCredential() 仍回傳（另一條持續收到新訊息）', () => {
    const offA = register(ALICE, 'conn-a')
    register(ALICE, 'conn-b')
    offA()
    expect(borrowCredential(ORG)).not.toBeNull()
  })

  it('② 兩條連線都 attach 同一對話，關掉一條 → session 不被刪除（錨點才能繼續前推）', async () => {
    const conv = convId('s3-2')
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, ALICE, 'conn-b')
    await release(conv, 'conn-a')

    const session = await useStateStore().getCopilotSession(conv)
    expect(session).not.toBeNull()
    // 錨點前推的前提就是 session 還在 —— advanceAnchor() 在 session 為 null 時直接 return
    await useStateStore().setCopilotSession({ ...session!, lastMessageId: 'm_after', updatedAt: Date.now() })
    expect((await useStateStore().getCopilotSession(conv))?.lastMessageId).toBe('m_after')
  })

  it('③ 所有連線都關閉 → 憑證與 session 才真正清掉，不留用已登出 token 繼續輪詢的殘留', async () => {
    const conv = convId('s3-3')
    const offA = register(ALICE, 'conn-a')
    const offB = register(ALICE, 'conn-b')
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, ALICE, 'conn-b')

    offA()
    await release(conv, 'conn-a')
    expect(borrowCredential(ORG)).not.toBeNull()
    expect(await useStateStore().getCopilotSession(conv)).not.toBeNull()

    offB()
    await release(conv, 'conn-b')
    expect(borrowCredential(ORG)).toBeNull()
    expect(registeredOrgIds()).toEqual([])
    expect(await useStateStore().getCopilotSession(conv)).toBeNull()
  })

  it('④ 兩位不同客服各一條，其中一位離開 → 另一位的憑證與 session 不受影響', async () => {
    const conv = convId('s3-4')
    const offA = register(ALICE, 'conn-a')
    register(BOB, 'conn-b')
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, BOB, 'conn-b')

    offA()
    await release(conv, 'conn-a')
    expect(borrowCredential(ORG)?.operatorId).toBe(BOB)
    expect((await useStateStore().getCopilotSession(conv))?.watchers).toEqual([{ operatorId: BOB, connectionId: 'conn-b' }])
  })
})

// ── T007：存活兜底（FR-005a、必讀 3a）───────────────────────────────────

describe('存活兜底：TTL ＋ 連線心跳（FR-005a）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('沒有心跳 → 45 秒後被回收（異常中斷時關閉事件沒觸發的保險）', () => {
    register(ALICE, 'conn-a', 'client-a')
    vi.advanceTimersByTime(CREDENTIAL_TTL_MS + 1)
    expect(borrowCredential(ORG)).toBeNull()
  })

  it('每 20 秒一拍心跳 → 永遠不被回收', () => {
    register(ALICE, 'conn-a', 'client-a')
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(CREDENTIAL_HEARTBEAT_MS)
      expect(touchCredential(identity(ALICE, 'client-a'))).toEqual({ touched: 1, created: false })
    }
    vi.advanceTimersByTime(CREDENTIAL_HEARTBEAT_MS)
    expect(borrowCredential(ORG)?.connectionId).toBe('conn-a')
  })

  /**
   * ⚠️ **漏拍後重建（upsert）—— 必讀 3a。** 背景分頁的計時器被瀏覽器節流到約每分鐘一拍（> 45 秒 TTL）：
   *    登記被剔除，而 SSE 連線沒有斷、不會重連，沒有任何路徑會重新登記。
   *    心跳若寫成「找不到就 no-op」，那條連線的憑證永遠回不來 —— 症狀與原始缺陷逐字相同。
   *
   * ⚠️ 回收是惰性的：推進 60 秒後 MUST 先呼叫 `borrowCredential()` 觸發剔除、斷言登記數為 0，
   *    再送心跳。少了那一步讀取，心跳只是刷新了仍在 Map 裡的舊筆，upsert 分支從未被執行而測試全綠。
   */
  it('漏拍 60 秒後被剔除 → 下一拍心跳把登記重建回來（upsert，connectionId 另產）', () => {
    const offA = register(ALICE, 'conn-a', 'client-a')
    vi.advanceTimersByTime(60_000)

    expect(borrowCredential(ORG)).toBeNull() // 讀取點觸發剔除
    expect(registeredCredentials(ORG)).toHaveLength(0)

    expect(touchCredential(identity(ALICE, 'client-a'))).toEqual({ touched: 0, created: true })
    const rebuilt = borrowCredential(ORG)
    expect(rebuilt).not.toBeNull()
    expect(rebuilt?.connectionId).not.toBe('conn-a')
    expect(rebuilt?.clientId).toBe('client-a')
    expect(rebuilt?.accessToken).toBe(identity(ALICE, 'client-a').accessToken)

    // 原連線手上的 unsubscribe 拿的是舊 connectionId，會打空 —— 重建的那一筆改由心跳擁有
    offA()
    expect(borrowCredential(ORG)?.connectionId).toBe(rebuilt?.connectionId)

    // …分頁真的關掉後心跳停止，≤ TTL 由惰性回收清掉（SC-002 對異常中斷已接受的保證）
    vi.advanceTimersByTime(CREDENTIAL_TTL_MS + 1)
    expect(borrowCredential(ORG)).toBeNull()
  })

  /**
   * 漏拍後**刷新**（不重建）：逾期但尚未被讀取剔除的舊筆，心跳直接刷新 —— 原 `connectionId` 保留，
   * SSE 關閉時的 unsubscribe 仍打得中（contracts §4「定址時不先套 TTL 濾網」，2026-09-02 裁定）。
   * 少了這條，「先套濾網再比對」的寫法會通過上面那條，卻讓每一次漏拍都製造一筆孤兒登記。
   */
  it('漏拍 60 秒但沒有讀取點跑過 → 心跳刷新舊筆、connectionId 不變、登記數仍為 1', () => {
    const offA = register(ALICE, 'conn-a', 'client-a')
    vi.advanceTimersByTime(60_000)

    expect(touchCredential(identity(ALICE, 'client-a'))).toEqual({ touched: 1, created: false })
    expect(registeredCredentials(ORG)).toHaveLength(1)
    expect(borrowCredential(ORG)?.connectionId).toBe('conn-a')

    // 原連線的 unsubscribe 仍打得中
    offA()
    expect(registeredCredentials(ORG)).toHaveLength(0)
  })

  it('心跳只認同一位客服、同一個 clientId：不會續命別人的登記', () => {
    register(ALICE, 'conn-a', 'client-a')
    register(BOB, 'conn-b', 'client-b')
    vi.advanceTimersByTime(30_000)
    touchCredential(identity(ALICE, 'client-a'))
    vi.advanceTimersByTime(30_000) // bob 已 60 秒無心跳

    expect(registeredOrgIds()).toEqual([ORG])
    expect(registeredCredentials(ORG).map(c => c.connectionId)).toEqual(['conn-a'])
  })

  it('重建的登記以 background 起算（會被剔除的幾乎都是被節流的隱藏分頁），presence 心跳可再改回前景', () => {
    vi.advanceTimersByTime(1)
    touchCredential(identity(ALICE, 'client-a'))
    expect(hasForegroundOperator(ORG)).toBe(false)
    setCredentialActivity(ORG, ALICE, 'client-a', 'foreground')
    expect(hasForegroundOperator(ORG)).toBe(true)
  })
})

// ── T008：複製分頁共用 clientId（research.md #1／#2）─────────────────────

describe('複製分頁：兩條連線帶相同 clientId', () => {
  it('① 關掉其中一條不影響另一條（鍵是 connectionId，不是 clientId）', () => {
    const offA = register(ALICE, 'conn-a', 'client-dup')
    register(ALICE, 'conn-b', 'client-dup')
    offA()
    expect(borrowCredential(ORG)?.connectionId).toBe('conn-b')
  })

  it('② 一次心跳把兩筆的 lastSeenAt 都更新（MUST NOT「取一筆」）', () => {
    vi.useFakeTimers()
    register(ALICE, 'conn-a', 'client-dup')
    register(ALICE, 'conn-b', 'client-dup')
    vi.advanceTimersByTime(30_000)

    expect(touchCredential(identity(ALICE, 'client-dup'))).toEqual({ touched: 2, created: false })
    vi.advanceTimersByTime(30_000) // 距登記 60 秒、距心跳 30 秒

    borrowCredential(ORG)
    expect(registeredCredentials(ORG).map(c => c.connectionId).sort()).toEqual(['conn-a', 'conn-b'])
  })

  it('activity 也更新全部命中者：一個分頁切背景，複製出來的分頁一起切', () => {
    register(ALICE, 'conn-a', 'client-dup')
    register(ALICE, 'conn-b', 'client-dup')
    setCredentialActivity(ORG, ALICE, 'client-dup', 'background')
    expect(registeredCredentials(ORG).every(c => c.activity === 'background')).toBe(true)
  })
})

// ── T009：I-7／I-8 夾擊（FR-006a、SC-002a）───────────────────────────────

/**
 * ⚠️ **兩條 MUST 同時存在。** 只驗其中一條時，把「主動離開」與「關掉分頁」合併成同一條清理路徑的
 *    錯誤修法會通過測試。主動離開是關於「這個人」的決定（`removeJoinedConversation()` 是 per-operator
 *    的持久紀錄，該客服所有分頁的面板一起消失，003 T032a）；關線只是少了一條連線。
 *    兩條路徑今天就是分開的（research.md #6），這裡守的是不退步；靜態面另由
 *    `test/contract-guards.test.ts` 守 `leave.post.ts` 不得出現連線層級識別項。
 */
describe('I-7／I-8 夾擊：主動離開對該客服所有連線生效，關線只影響該條連線', () => {
  it('I-8：關掉一條連線 → 只少那一筆 watcher，JOIN 紀錄（客服層級）完全不動', async () => {
    const store = useStateStore()
    const conv = convId('i8')
    await store.addJoinedConversation(ALICE, conv)
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, ALICE, 'conn-b')

    await release(conv, 'conn-a')

    expect((await store.getCopilotSession(conv))?.watchers).toEqual([{ operatorId: ALICE, connectionId: 'conn-b' }])
    expect(await store.listJoinedConversations(ALICE)).toContain(conv)
    await store.removeJoinedConversation(ALICE, conv) // JOIN 紀錄是全域 store，收拾乾淨才不會污染下一條
  })

  it('I-7：主動離開 → JOIN 紀錄整個消失（不論開了幾條連線），而且完全不經 watchers', async () => {
    const store = useStateStore()
    const conv = convId('i7')
    await store.addJoinedConversation(ALICE, conv)
    await attach(conv, ALICE, 'conn-a')
    await attach(conv, ALICE, 'conn-b')

    // leave.post.ts 做的事：removeJoinedConversation() ＋ 廣播 control.updated（這裡只驗前者）
    await store.removeJoinedConversation(ALICE, conv)

    expect(await store.listJoinedConversations(ALICE)).not.toContain(conv)
    // 連線計數一筆都沒少：離開的傳播走 control.updated，不走 watchers（兩條路徑分開）
    expect((await store.getCopilotSession(conv))?.watchers).toHaveLength(2)
    expect(pipelineRefs(conv)).toBe(2)
  })
})
