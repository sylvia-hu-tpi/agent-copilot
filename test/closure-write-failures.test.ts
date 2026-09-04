/**
 * SC-003：**四種寫入失敗形態各 10 次，全部不得顯示成功**（契約 §4、FR-032、FR-035a）。
 *
 * | 形態 | 注入 | `failKind` |
 * |---|---|---|
 * | 逾時 | `hangMs.create` 超過 repository 逾時 | `failed` |
 * | 平台 4xx | `failWith.create = 422` | `failed` |
 * | 平台 5xx | `failWith.create = 503`（**真注入**） | `failed` |
 * | 200 但回查不存在 | `createButHideFromGet` | **`unverified`** |
 *
 * ⚠️⚠️ **第四種是本規格最重要的一條測試**（契約 R3.5）。平台不保證唯一鍵約束
 *      （實測 5 個 board `uniqueSeen: 0`），200 不等於紀錄真的建立了 ——
 *      而「畫面顯示成功、Board 上其實沒有」不會報錯。少了這條，
 *      那件事永遠不會被發現。
 *
 * ⚠️ **5xx 是真的注入，不以 4xx 或 hangMs 代替。** SDK 的退避重試寫死在
 *    `node_modules/@imbrace/sdk/dist/http.js`（`maxRetries = 3`，1s→2s→4s，不可設定），
 *    一次 5xx 因此要花約 7 秒。代價由「以不同 draftId 並行 ＋ 只放寬這一組的 timeout」
 *    承擔 —— 那不是例外，是已知成本。用 4xx 代替的話，SC-003 的 5xx 一格從未被驗到，
 *    而「重試耗盡後被吞成成功」這個 bug 只在 5xx 路徑上出現。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ClosureSummary } from '../shared/types/copilot.js'
import { clientForSession } from '../server/services/imbrace.js'
import {
  ClosureWriteError,
  commitClosure,
  resetClosureFieldMapCache,
} from '../server/services/closure/board-repository.js'
import { MOCK_CONV_BARE, startMockGateway, type MockGateway } from './mock-gateway.js'
import { errorHaystack, leakedSecrets } from './redact-assert.js'

const RUNS = 10
const SHORT_TIMEOUT_MS = 300

let gateway: MockGateway | undefined

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  resetClosureFieldMapCache()
})

function clientFor(gw: MockGateway) {
  return clientForSession(
    { accessToken: 'acc_TESTTOKEN', organizationId: 'org_a' },
    { baseUrl: gw.baseUrl },
  )
}

function summaryFor(draftId: string): ClosureSummary {
  return {
    recordId: '', draftId, conversationId: MOCK_CONV_BARE,
    periodStart: '2026-09-03T10:00:00.000Z', periodMessageCount: 12, periodOrigin: 'closure',
    channel: 'line', contactId: 'con_1', operators: ['u_test_operator'],
    joinedAt: '2026-09-03T10:00:00.000Z', closedAt: '2026-09-03T12:00:00.000Z',
    summary: '摘要', intent: '意圖', category: '訂單查詢', resolution: 'resolved',
    actionsTaken: [], sentimentOutcome: 'satisfied',
    sentimentStart: null, sentimentEnd: null, sentimentTrough: null, sentimentNote: '評分點不齊',
    citedSopIds: [], followUps: [], confidence: null,
    reviewedBy: 'u_test_operator', reviewedAt: '2026-09-03T12:00:00.000Z',
  }
}

const silentLog = { info: () => {}, warn: () => {} }

/** 跑一次寫入並回傳「它是怎麼失敗的」—— 成功會讓斷言直接紅掉 */
async function attempt(
  gw: MockGateway,
  draftId: string,
  timeoutMs = SHORT_TIMEOUT_MS,
): Promise<ClosureWriteError> {
  try {
    await commitClosure(clientFor(gw), gw.boardId(), summaryFor(draftId), {
      reqId: `req-${draftId}`, log: silentLog, timeoutMs,
    })
  }
  catch (err) {
    if (err instanceof ClosureWriteError) return err
    throw err
  }
  throw new Error(`${draftId}：寫入 MUST NOT 成功 —— 已注入故障`)
}

function assertClean(err: ClosureWriteError, label: string): void {
  const leaked = leakedSecrets(errorHaystack(err))
  expect(leaked, `${label}：錯誤內容外洩了憑證`).toEqual([])
}

describe('SC-003 ①：逾時 ×10 → failKind: failed、504', () => {
  it(`${RUNS} 次全部以 failed／504 失敗，且不外洩憑證`, async () => {
    gateway = await startMockGateway({ board: { hangMs: { create: 5_000 } } })
    for (let i = 0; i < RUNS; i++) {
      const err = await attempt(gateway, `timeout-${i}`)
      expect(err.failKind).toBe('failed')
      expect(err.status).toBe(504)
      expect(err.reqId).toBe(`req-timeout-${i}`)
      assertClean(err, '逾時')
    }
  }, 30_000)
})

describe('SC-003 ②：平台 4xx ×10 → failKind: failed、502', () => {
  it(`${RUNS} 次全部以 failed／502 失敗，且不外洩憑證`, async () => {
    gateway = await startMockGateway({ board: { failWith: { create: 422 } } })
    for (let i = 0; i < RUNS; i++) {
      const err = await attempt(gateway, `http4xx-${i}`)
      expect(err.failKind).toBe('failed')
      expect(err.status).toBe(502)
      assertClean(err, '4xx')
    }
    expect(gateway.boardItems(), '4xx 時 MUST NOT 留下任何紀錄').toEqual([])
  })
})

/*
  ⚠️ **只放寬這一組的 timeout**，MUST NOT 全域放寬。
     SDK 的退避（1s→2s→4s ≈ 7 秒）寫死在 `node_modules/@imbrace/sdk/dist/http.js`，
     不可設定；10 次序列跑要 70 秒，以不同 draftId 並行後約 7 秒。
     全域放寬的話，其他測試真的卡住時也要等一樣久才看得到紅燈。

  ⚠️ **這一組的 repository 逾時 MUST 比 SDK 的退避長**（下面用 12 秒）。
     用其他組的 300ms 的話，逾時會**先**發生 —— 拿到的是 `504 逾時`，
     而 5xx 那一格從未被驗到。症狀是測試全綠而缺口還在，
     正是這份規格一直在防的那種事。
*/
describe('SC-003 ③：平台 5xx ×10（真注入）→ failKind: failed、502', { timeout: 30_000 }, () => {
  /** 比 SDK 的 1s→2s→4s 退避長，但仍遠短於正式的 30 秒 */
  const BEYOND_SDK_BACKOFF_MS = 12_000

  it('10 次並行全部失敗，且 create 被打了 40 次（重試耗盡後仍是失敗，不是被吞成成功）', async () => {
    gateway = await startMockGateway({ board: { failWith: { create: 503 } } })
    const gw = gateway

    const errors = await Promise.all(
      Array.from({ length: RUNS }, (_, i) => attempt(gw, `http5xx-${i}`, BEYOND_SDK_BACKOFF_MS)),
    )

    for (const err of errors) {
      expect(err.failKind).toBe('failed')
      expect(err.status).toBe(502)
      assertClean(err, '5xx')
    }
    /*
      ⚠️ 10 × 4 次嘗試（首次 ＋ SDK 的 3 次重試）。
         這個數字證明的是「重試真的耗盡了，而最後仍然是失敗」——
         少了它，「SDK 重試成功了但我方報成失敗」與「一次都沒重試」
         這兩種相反的 bug 都會看起來一樣。
    */
    expect(gw.boardCallCount('create')).toBe(RUNS * 4)
    expect(gw.boardItems(), '5xx 時 MUST NOT 留下任何紀錄').toEqual([])
  })
})

describe('SC-003 ④：200 但回查不存在 ×10 → failKind: unverified、502', () => {
  it('⚠️ 本規格最重要的一條：平台說成功但查不到，MUST 當作失敗', async () => {
    gateway = await startMockGateway({ board: { createButHideFromGet: true } })
    for (let i = 0; i < RUNS; i++) {
      const err = await attempt(gateway, `unverified-${i}`)
      // ⚠️ 這一格與其他三種刻意不同，因為客服接下來該做的事不同：
      //    其餘三種可直接重試；這一種 MUST 先請客服到 CRM 查驗（畫布 B8）
      expect(err.failKind).toBe('unverified')
      expect(err.status).toBe(502)
      expect(err.reqId).toBe(`req-unverified-${i}`)
      assertClean(err, 'unverified')
    }
    // 紀錄其實是建立了的 —— 這正是 B8 那句「先到 CRM 確認」的理由
    expect(gateway.boardItems().length).toBe(RUNS)
  })
})

describe('FR-035a：三步寫入各記一行日誌，且都帶著同一個 reqId', () => {
  it('成功路徑記三行（search／create／verify），每一行都有 reqId，且不含 summary／intent', async () => {
    gateway = await startMockGateway()
    const lines: string[] = []
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) }

    await commitClosure(clientFor(gateway), gateway.boardId(), summaryFor('draft-log'), {
      reqId: 'abcd1234', log,
    })

    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toContain('req=abcd1234')
    expect(lines.some(l => l.includes('step=search'))).toBe(true)
    expect(lines.some(l => l.includes('step=create'))).toBe(true)
    expect(lines.some(l => l.includes('step=verify'))).toBe(true)

    /*
      ⚠️ 憲法 1.5：`summary`／`intent` 是客戶對話個資，MUST NOT 進日誌。
         reqId／draftId／recordId 足以回答 B8 要問的「三步走到哪一步」，
         而那正是這些日誌存在的唯一目的。
    */
    const all = lines.join('\n')
    expect(all).not.toContain('摘要')
    expect(all).not.toContain('意圖')
  })

  it('⚠️ MUST NOT 只在出錯時產生 reqId —— 失敗時前兩步的日誌也要在', async () => {
    gateway = await startMockGateway({ board: { createButHideFromGet: true } })
    const lines: string[] = []
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) }

    await expect(
      commitClosure(clientFor(gateway), gateway.boardId(), summaryFor('draft-log-fail'), {
        reqId: 'ffff0000', log,
      }),
    ).rejects.toThrow(ClosureWriteError)

    // 出錯之前的兩步看得到 —— B8 要判斷的正是那兩步
    expect(lines.some(l => l.includes('step=search') && l.includes('req=ffff0000'))).toBe(true)
    expect(lines.some(l => l.includes('step=create') && l.includes('req=ffff0000'))).toBe(true)
    expect(lines.some(l => l.includes('verified=false'))).toBe(true)
  })
})
