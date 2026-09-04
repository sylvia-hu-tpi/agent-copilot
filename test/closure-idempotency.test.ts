/**
 * SC-002／US2：**重複觸發不製造重複紀錄，也不銷毀服務歷史。**
 *
 * ⚠️ 這一支守的是憲法 5.3 最容易寫反的那一半：冪等鍵是 **`draft_id`**，
 *    **MUST NOT 是 `conversation_id`**。用後者的話：
 *      · 「不同時間的多次服務」→ 第二次結案會覆蓋第一次，**服務歷史被銷毀**
 *      · 「多位客服各自結案」→ 後寫的洗掉先寫的，**同事的工作成果不見**
 *    兩種都不報錯、畫面上都顯示成功。
 *
 * ⚠️ 另一半是契約 R3.13 的**本地逐字比對**：`q` 是全文檢索不是精確比對。
 *    省掉本地比對等於「隨便抓一筆看起來像的」去 `updateItem` ——
 *    改到的是別人的結案紀錄，而且不會報錯。本檔以「預先塞入 draft_id 含相同
 *    前綴的他人紀錄」造出那個情境（下方 ③）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClosureSummary } from '../shared/types/copilot.js'
import { clientForSession } from '../server/services/imbrace.js'
import {
  closuresSincePanelOpen,
  commitClosure,
  listClosuresFor,
  resetClosureFieldMapCache,
  type ClosureRecordRow,
} from '../server/services/closure/board-repository.js'
import { MOCK_CONV_BARE, startMockGateway, type MockGateway } from './mock-gateway.js'

/** 逾時注入短一點 —— 正式預設值是 30 秒（`CLOSURE_WRITE_TIMEOUT_MS`），另有測試守它 */
const SHORT_TIMEOUT_MS = 400

let gateway: MockGateway | undefined

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  resetClosureFieldMapCache()
  vi.restoreAllMocks()
})

function clientFor(gw: MockGateway) {
  return clientForSession(
    { accessToken: 'acc_TESTTOKEN', organizationId: 'org_a' },
    { baseUrl: gw.baseUrl },
  )
}

function summaryFor(draftId: string, over: Partial<ClosureSummary> = {}): ClosureSummary {
  return {
    recordId: '',
    draftId,
    conversationId: MOCK_CONV_BARE,
    periodStart: '2026-09-03T10:00:00.000Z',
    periodMessageCount: 12,
    periodOrigin: 'closure',
    channel: 'line',
    contactId: 'con_1',
    operators: ['u_test_operator'],
    joinedAt: '2026-09-03T10:00:00.000Z',
    closedAt: '2026-09-03T12:00:00.000Z',
    summary: '第一版摘要',
    intent: '客戶詢問訂單',
    category: '訂單查詢',
    resolution: 'resolved',
    actionsTaken: [],
    sentimentOutcome: 'satisfied',
    sentimentStart: null,
    sentimentEnd: null,
    sentimentTrough: null,
    sentimentNote: '評分點不齊',
    citedSopIds: [],
    followUps: [],
    confidence: null,
    reviewedBy: 'u_test_operator',
    reviewedAt: '2026-09-03T12:00:00.000Z',
    ...over,
  }
}

const silentLog = { info: () => {}, warn: () => {} }

describe('SC-002 ①：同一份草稿重試 10 次 → Board 上恰好 1 筆，內容是最後一版', () => {
  it('前 N 次寫入逾時（紀錄其實已建立），第 10 次成功且 created === false', async () => {
    /*
      ⚠️ 注入的形態是「**實際建立紀錄但不回應**」，不是「不建立也不回應」——
         真正危險的情境正是「平台其實寫進去了，只是我方沒收到回應」。
         不建立的話，重試產生第二筆這個 bug 在測試裡永遠不會出現。
    */
    gateway = await startMockGateway({ board: { createButTimeout: { times: 9 } } })
    const client = clientFor(gateway)
    const draftId = 'draft-retry-1'

    const outcomes: Array<{ ok: boolean, created?: boolean }> = []
    for (let i = 1; i <= 10; i++) {
      // FR-030c：第 10 次送出的是**改過之後**的內容
      const summary = summaryFor(draftId, { summary: `第 ${i} 版摘要` })
      try {
        const r = await commitClosure(client, gateway.boardId(), summary, {
          reqId: `req-${i}`, log: silentLog, timeoutMs: SHORT_TIMEOUT_MS,
        })
        outcomes.push({ ok: true, created: r.created })
      }
      catch {
        outcomes.push({ ok: false })
      }
    }

    // 第一次逾時（紀錄已建立），之後每一次都命中既有那筆走 update
    expect(outcomes[0]).toEqual({ ok: false })
    expect(outcomes[9]).toEqual({ ok: true, created: false })

    const mine = gateway.boardItems().filter(r => r.draft_id === draftId)
    expect(mine, '同一份草稿 MUST 恰好一筆').toHaveLength(1)
    expect(mine[0]!.summary).toBe('第 10 版摘要')
    // 至少要真的重試過 —— 否則上面那個 1 可能只是「只寫了一次」
    expect(gateway.boardCallCount('update')).toBeGreaterThan(0)
  })
})

describe('SC-002 ②：兩份不同草稿寫同一個對話 → 2 筆並存，先寫那筆不變', () => {
  it('第二次結案 MUST NOT 覆蓋第一次（否則服務歷史被銷毀）', async () => {
    gateway = await startMockGateway()
    const client = clientFor(gateway)

    const first = await commitClosure(
      client, gateway.boardId(),
      summaryFor('draft-A', { summary: 'A 的摘要', closedAt: '2026-09-01T10:00:00.000Z' }),
      { reqId: 'r1', log: silentLog },
    )
    const second = await commitClosure(
      client, gateway.boardId(),
      summaryFor('draft-B', { summary: 'B 的摘要', closedAt: '2026-09-03T10:00:00.000Z' }),
      { reqId: 'r2', log: silentLog },
    )

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(first.recordId).not.toBe(second.recordId)

    const rows = gateway.boardItems().filter(r => r.conversation_id === MOCK_CONV_BARE)
    expect(rows, '同一通對話有多筆結案紀錄是正常的').toHaveLength(2)
    expect(rows.find(r => r.draft_id === 'draft-A')!.summary).toBe('A 的摘要')
    expect(rows.find(r => r.draft_id === 'draft-B')!.summary).toBe('B 的摘要')
  })
})

describe('R3.13（反例）：q 命中但 draft_id 不符時 MUST 建新的，MUST NOT 去改別人的', () => {
  it('前綴相同的他人紀錄不會被 updateItem 改到', async () => {
    gateway = await startMockGateway()
    const client = clientFor(gateway)

    // 別人的兩筆紀錄，`draft_id` 與我方的**共用前綴** —— 全文檢索會一起命中
    gateway.seedBoardItem({
      draft_id: 'draft-shared-prefix-OTHER-1',
      conversation_id: MOCK_CONV_BARE,
      summary: '同事的摘要 1',
      closed_at: '2026-09-02T09:00:00.000Z',
      reviewed_by: 'u_other',
      record_id: 'rec_other_1',
    })
    gateway.seedBoardItem({
      draft_id: 'draft-shared-prefix-OTHER-2',
      conversation_id: MOCK_CONV_BARE,
      summary: '同事的摘要 2',
      closed_at: '2026-09-02T11:00:00.000Z',
      reviewed_by: 'u_other',
      record_id: 'rec_other_2',
    })

    const result = await commitClosure(
      client, gateway.boardId(),
      summaryFor('draft-shared-prefix', { summary: '我的摘要' }),
      { reqId: 'r1', log: silentLog },
    )

    expect(result.created, 'q 命中他人紀錄時 MUST 仍走 createItem').toBe(true)
    // 一次都不該更新 —— 更新到的會是同事的工作成果
    expect(gateway.boardCallCount('update')).toBe(0)
    const rows = gateway.boardItems()
    expect(rows.find(r => r.draft_id === 'draft-shared-prefix-OTHER-1')!.summary).toBe('同事的摘要 1')
    expect(rows.find(r => r.draft_id === 'draft-shared-prefix-OTHER-2')!.summary).toBe('同事的摘要 2')
    expect(rows.filter(r => r.draft_id === 'draft-shared-prefix')).toHaveLength(1)
  })
})

describe('R3.4：同一 draft_id 命中 ≥2 筆 → 更新最早建立的那筆，並留一行警告', () => {
  it('取最早建立的那筆，且 log.warn 被呼叫', async () => {
    gateway = await startMockGateway()
    const client = clientFor(gateway)

    // 先塞兩筆同 draft_id 的紀錄（seed 的順序即建立順序）
    const older = gateway.seedBoardItem({
      draft_id: 'draft-dup', conversation_id: MOCK_CONV_BARE,
      summary: '較早那筆', record_id: 'rec_older',
    })
    gateway.seedBoardItem({
      draft_id: 'draft-dup', conversation_id: MOCK_CONV_BARE,
      summary: '較晚那筆', record_id: 'rec_newer',
    })

    const warn = vi.fn()
    const result = await commitClosure(
      client, gateway.boardId(),
      summaryFor('draft-dup', { summary: '更新後的內容' }),
      { reqId: 'r1', log: { info: () => {}, warn } },
    )

    expect(result.created).toBe(false)
    expect(result.recordId).toBe('rec_older')
    expect(warn).toHaveBeenCalled()

    const rows = gateway.boardItems().filter(r => r.draft_id === 'draft-dup')
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.record_id === 'rec_older')!.summary).toBe('更新後的內容')
    // 較晚那筆原封不動 —— 我們不會為了「整理」而動它
    expect(rows.find(r => r.record_id === 'rec_newer')!.summary).toBe('較晚那筆')
    expect(older.id).toBeTruthy()
  })
})

describe('R1.6（反例）：closed_at 與建立順序相反時，仍依 closed_at 降冪', () => {
  it('平台是依建立時間回的，排序 MUST 在本地做', async () => {
    gateway = await startMockGateway()
    const client = clientFor(gateway)

    // 建立順序：舊 → 新；`closed_at` 順序：新 → 舊（刻意相反，模擬補登）
    gateway.seedBoardItem({
      draft_id: 'd1', conversation_id: MOCK_CONV_BARE, record_id: 'rec_1',
      closed_at: '2026-09-05T10:00:00.000Z',
    })
    gateway.seedBoardItem({
      draft_id: 'd2', conversation_id: MOCK_CONV_BARE, record_id: 'rec_2',
      closed_at: '2026-09-03T10:00:00.000Z',
    })
    gateway.seedBoardItem({
      draft_id: 'd3', conversation_id: MOCK_CONV_BARE, record_id: 'rec_3',
      closed_at: '2026-09-01T10:00:00.000Z',
    })

    const rows = await listClosuresFor(client, gateway.boardId(), MOCK_CONV_BARE)
    expect(rows.map(r => r.recordId)).toEqual(['rec_1', 'rec_2', 'rec_3'])
  })

  it('conversation_id 不符者被本地比對濾掉（filter 實測被平台靜默忽略）', async () => {
    gateway = await startMockGateway()
    const client = clientFor(gateway)

    gateway.seedBoardItem({
      draft_id: 'd1', conversation_id: MOCK_CONV_BARE, record_id: 'rec_mine',
      closed_at: '2026-09-05T10:00:00.000Z',
    })
    gateway.seedBoardItem({
      draft_id: 'd2', conversation_id: 'some-other-conversation', record_id: 'rec_theirs',
      closed_at: '2026-09-04T10:00:00.000Z',
    })

    const rows = await listClosuresFor(client, gateway.boardId(), MOCK_CONV_BARE)
    expect(rows.map(r => r.recordId)).toEqual(['rec_mine'])
  })
})

describe('R3.10：newClosuresSincePanelOpen 只列面板開啟後新出現的紀錄', () => {
  const row = (recordId: string, over: Partial<ClosureRecordRow> = {}): ClosureRecordRow => ({
    recordId,
    itemId: `bi_${recordId}`,
    draftId: `draft_${recordId}`,
    conversationId: MOCK_CONV_BARE,
    closedAt: '2026-09-03T11:00:00.000Z',
    category: '訂單查詢',
    reviewedBy: 'u_other',
    createdAt: '2026-09-03T11:00:00.000Z',
    ...over,
  })

  it('基準線內的紀錄不出現；開啟後新增的出現且帶 reviewedBy 與 closedAt', () => {
    const rows = [row('rec_existing'), row('rec_new'), row('rec_mine')]
    const out = closuresSincePanelOpen(rows, ['rec_existing'], 'rec_mine')

    expect(out.map(r => r.recordId)).toEqual(['rec_new'])
    expect(out[0]!.reviewedBy).toBe('u_other')
    expect(out[0]!.closedAt).toBe('2026-09-03T11:00:00.000Z')
  })

  it('⚠️ 自己剛寫的那一筆一定被排除 —— 否則每次成功都會提示「有人結案了」', () => {
    const rows = [row('rec_mine')]
    expect(closuresSincePanelOpen(rows, [], 'rec_mine')).toEqual([])
  })

  it('沒有新紀錄時是空陣列（FR-034 的正常情形，不是錯誤）', () => {
    const rows = [row('rec_a'), row('rec_b')]
    expect(closuresSincePanelOpen(rows, ['rec_a', 'rec_b'], 'rec_c')).toEqual([])
  })
})
