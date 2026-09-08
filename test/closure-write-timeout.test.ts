/**
 * FR-032a／契約 R3.12：**寫入路徑有 30 秒硬逾時。**
 *
 * ⚠️⚠️ **這是 FR-040a「寫入中不可取消」的成立前提，兩者 MUST 一起存在。**
 *      只做「不可取消」而沒有上界，客服會被困在一個既不能取消、
 *      也不會自己結束的狀態裡 —— 而那個畫面上唯一的訊息是「寫入中…」，
 *      看起來完全正常。
 *
 * ⚠️ **這個門檻 MUST NOT 被 SC-004 的「不設固定秒數」波及。**
 *    那條講的是**摘要產生**（工作量隨涵蓋區間變動，訂任何秒數都是錯的口徑）；
 *    寫入的工作量固定為三次 Board 呼叫（實測次秒級），正是該有門檻的那一類。
 *    兩個預算性質相反，本檔的最後一條就是在釘住這件事。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ClosureSummary } from '../shared/types/copilot.js'
import { clientForSession } from '../server/services/imbrace.js'
import {
  CLOSURE_WRITE_TIMEOUT_MS,
  ClosureWriteError,
  commitClosure,
  resetClosureFieldMapCache,
} from '../server/services/closure/board-repository.js'
import { MOCK_CONV_BARE, startMockGateway, type MockGateway } from './mock-gateway.js'

let gateway: MockGateway | undefined

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  resetClosureFieldMapCache()
})

function summaryFor(draftId: string): ClosureSummary {
  return {
    recordId: '', draftId, conversationId: MOCK_CONV_BARE,
    periodStart: '2026-09-03T10:00:00.000Z', periodMessageCount: 3, periodOrigin: 'closure',
    channel: 'line', contactId: 'con_1', operators: ['u_test_operator'],
    joinedAt: '2026-09-03T10:00:00.000Z', closedAt: '2026-09-03T12:00:00.000Z',
    summary: '摘要', intent: '意圖', category: '訂單查詢', resolution: 'resolved',
    actionsTaken: [], sentimentOutcome: 'satisfied',
    sentimentStart: null, sentimentEnd: null, sentimentTrough: null, sentimentNote: null,
    citedSopIds: [], followUps: [], confidence: null,
    reviewedBy: 'u_test_operator', reviewedAt: '2026-09-03T12:00:00.000Z',
  }
}

describe('FR-032a：createItem 永不回應時，寫入 MUST 在逾時值內落定', () => {
  it('以 failed／504 失敗，而不是永遠掛著', async () => {
    // ⚠️ 「永不回應」而不是「回錯誤」—— 後者是另一條路徑（4xx／5xx），
    //    而「連線掛著」正是唯一會讓 writing 狀態卡死的那一種
    gateway = await startMockGateway({ board: { hangMs: { create: 60_000 } } })

    const timeoutMs = 400
    const started = Date.now()
    let caught: unknown
    try {
      await commitClosure(
        clientForSession({ accessToken: 'acc_TESTTOKEN', organizationId: 'org_a' }, { baseUrl: gateway.baseUrl }),
        gateway.boardId(),
        summaryFor('draft-timeout'),
        { reqId: 'to-1', log: { info: () => {}, warn: () => {} }, timeoutMs },
      )
    }
    catch (err) {
      caught = err
    }
    const elapsed = Date.now() - started

    expect(caught).toBeInstanceOf(ClosureWriteError)
    const err = caught as ClosureWriteError
    expect(err.failKind).toBe('failed')
    expect(err.status).toBe(504)
    expect(err.reqId).toBe('to-1')
    // 真的在逾時值附近落定（留一段寬裕給機器負載，但遠低於 gateway 的 60 秒）
    expect(elapsed).toBeLessThan(timeoutMs + 5_000)
  })

  it('逾時後**不重試** —— 要不要重按由客服自己決定（他才知道 CRM 上到底有沒有）', async () => {
    gateway = await startMockGateway({ board: { hangMs: { create: 60_000 } } })
    const gw = gateway

    await expect(commitClosure(
      clientForSession({ accessToken: 'acc_TESTTOKEN', organizationId: 'org_a' }, { baseUrl: gw.baseUrl }),
      gw.boardId(),
      summaryFor('draft-noretry'),
      { reqId: 'to-2', log: { info: () => {}, warn: () => {} }, timeoutMs: 400 },
    )).rejects.toThrow(ClosureWriteError)

    // 我方只送出一次。⚠️ 這裡數的是「我方的重試」——
    // SDK 對逾時（連線掛著、非 5xx）不會退避重試，因此 1 次就是 1 次。
    expect(gw.boardCallCount('create')).toBe(1)
  })
})

describe('⚠️ 正式預設值必須是 30 秒，且與 SC-004 的「不設固定秒數」互不污染', () => {
  it('CLOSURE_WRITE_TIMEOUT_MS === 30_000', () => {
    /*
      ⚠️ 這條看起來像在測一個常數，實際上釘的是一個**會被誤刪的設計決定**：
         SC-004 把「摘要產生」的秒數門檻整個拿掉了，而拿掉之後很容易順手把
         寫入的這一個也一起拿掉 —— 兩者的名字都叫「逾時」。
         拿掉之後 `writing` 狀態就沒有上界，而 FR-040a 讓它不可取消。
    */
    expect(CLOSURE_WRITE_TIMEOUT_MS).toBe(30_000)
  })
})
