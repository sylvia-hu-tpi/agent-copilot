/**
 * SC-003 的 **store 層**：四種寫入失敗形態在前端走**同一個狀態機出口**
 * （契約 §4、R3.15、FR-032、FR-040a、US3 AC#4）。
 *
 * ⚠️⚠️ **四種的狀態轉移必須完全相同** —— 回 `ready`、草稿逐欄保留、面板不關、
 *      不離開對話。只有 `error.failKind` 不同（決定 B7／B8 的文案與按鈕）。
 *      開第二條狀態路徑就會有一條被漏掉，而**漏掉的那條會顯示成功**。
 *
 * ⚠️ **本檔必須放在 `test/nuxt/`**（理由同 `closure-wait-honesty.test.ts`）：
 *    它 import `app/stores/closure.ts`，只有這個目錄由 `nuxt typecheck`
 *    以真正的 auto-import 型別檢查。
 */

import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONV = 'conv-store-failures'

const fetchMock = vi.fn<(path: string, opts?: Record<string, unknown>) => Promise<unknown>>()
let useClosureStore: typeof import('../../app/stores/closure.js')['useClosureStore']

const SCOPES = {
  candidates: [],
  fallback: { start: '2026-09-01T00:00:00.000Z', origin: 'first', messageCount: 9, truncated: false },
  overflowCount: 0,
  defaultIndex: -1,
  firstMessageAt: '2026-09-01T00:00:00.000Z',
  baselineAt: '2026-09-03T10:15:00.000Z',
  closureBaseline: ['rec_existing'],
}

const DRAFT = {
  draftId: 'draft_1',
  conversationId: CONV,
  period: { start: SCOPES.fallback.start, origin: 'first', messageCount: 9, truncated: false },
  summary: '客服已完成說明', intent: '客戶詢問訂單',
  category: '訂單查詢', resolution: 'resolved',
  actionsTaken: ['已提供操作說明'], sentimentOutcome: 'satisfied',
  citedSopIds: ['sop_1'], followUps: [{ action: '三日後回電' }],
  readonly: {
    operators: ['u_1'], joinedAt: SCOPES.fallback.start, closedAt: null,
    sentimentStart: null, sentimentEnd: null, sentimentTrough: null,
    sentimentNote: '評分點不齊', channel: 'line', contactId: 'con_1', confidence: null,
  },
}

/** 造一個 `$fetch` 會拋出的錯誤 —— 形狀比照 ofetch 對非 2xx 的包裝 */
function httpError(status: number, failKind: 'failed' | 'unverified', reqId: string): Error {
  const err = new Error('寫入失敗') as Error & { statusCode: number, data: unknown }
  err.statusCode = status
  err.data = { message: '寫入失敗', data: { failKind, reqId } }
  return err
}

/** 四種失敗形態（契約 §4 的對照表） */
const FAILURES = [
  { label: '逾時', status: 504, failKind: 'failed' as const },
  { label: '平台 4xx', status: 502, failKind: 'failed' as const },
  { label: '平台 5xx', status: 502, failKind: 'failed' as const },
  { label: '200 但回查不存在', status: 502, failKind: 'unverified' as const },
]

beforeEach(async () => {
  fetchMock.mockReset()
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('$fetch', fetchMock)
  setActivePinia(createPinia())
  ;({ useClosureStore } = await import('../../app/stores/closure.js'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 開面板 → 產生草稿 → 停在 `ready` */
async function openReady(store: ReturnType<typeof useClosureStore>): Promise<void> {
  fetchMock.mockImplementation(async (path) => {
    if (path.endsWith('/closure/scopes')) return SCOPES
    if (path.endsWith('/closure/draft')) return JSON.parse(JSON.stringify(DRAFT))
    throw new Error(`未預期的路徑 ${path}`)
  })
  await store.open(CONV)
  expect(store.get(CONV)?.status).toBe('ready')
}

describe('SC-003（store 層）：四種失敗共用同一個出口', () => {
  for (const f of FAILURES) {
    it(`${f.label} → 回 ready、草稿逐欄未變、面板不關、沒有任何 /leave`, async () => {
      const store = useClosureStore()
      await openReady(store)
      // ⚠️ 用 JSON 深拷貝而非 `structuredClone` —— 後者對 Vue 的 reactive proxy 會拋 DataCloneError
      const before = JSON.parse(JSON.stringify(store.get(CONV)!.draft))

      fetchMock.mockImplementation(async (path) => {
        if (path.endsWith('/closure/commit')) throw httpError(f.status, f.failKind, 'r-1')
        throw new Error(`未預期的路徑 ${path}`)
      })

      const result = await store.commit(CONV)
      expect(result).toBeNull()

      const after = store.get(CONV)
      // ⚠️ 四種**完全相同**的三件事
      expect(after?.status, '失敗一律回 ready，沒有 writeFailed 這個狀態').toBe('ready')
      expect(JSON.parse(JSON.stringify(after?.draft)), '草稿 MUST 逐欄未變').toEqual(before)
      expect(after, '面板 MUST NOT 關').toBeDefined()
      // ⚠️ 只有這一件不同 —— 它決定 B7／B8 的文案與按鈕，不決定狀態
      expect(after?.error?.failKind).toBe(f.failKind)
      expect(after?.error?.reqId).toBe('r-1')

      const leaveCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/leave'))
      expect(leaveCalls, '寫入失敗 MUST NOT 離開對話').toEqual([])
    })
  }

  it('⚠️ 四種的狀態轉移完全相同（只比 failKind 不同）', async () => {
    const shapes: string[] = []
    for (const f of FAILURES) {
      setActivePinia(createPinia())
      const store = useClosureStore()
      await openReady(store)
      fetchMock.mockImplementation(async (path) => {
        if (path.endsWith('/closure/commit')) throw httpError(f.status, f.failKind, 'r-x')
        throw new Error(`未預期的路徑 ${path}`)
      })
      await store.commit(CONV)
      const s = store.get(CONV)!
      shapes.push(JSON.stringify({
        status: s.status,
        hasDraft: !!s.draft,
        stale: s.stale,
        canCancel: store.canCancel(CONV),
      }))
    }
    expect(new Set(shapes).size, `四種的狀態轉移必須一致，實際有 ${new Set(shapes).size} 種`).toBe(1)
  })
})

describe('FR-040a：writing 期間不可取消；落定後恢復可取消且草稿仍在', () => {
  it('寫入中 canCancel 為 false、cancel() 無效；失敗落定後回 ready 且可取消', async () => {
    const store = useClosureStore()
    await openReady(store)

    let rejectCommit: ((err: unknown) => void) | undefined
    fetchMock.mockImplementation(async (path) => {
      if (path.endsWith('/closure/commit')) {
        return new Promise((_, reject) => { rejectCommit = reject })
      }
      throw new Error(`未預期的路徑 ${path}`)
    })

    const pending = store.commit(CONV)
    await vi.waitFor(() => expect(store.get(CONV)?.status).toBe('writing'))

    expect(store.canCancel(CONV)).toBe(false)
    store.cancel(CONV)
    expect(store.get(CONV)?.status, 'writing 期間 cancel() MUST 無效').toBe('writing')

    rejectCommit!(httpError(504, 'failed', 'r-2'))
    await pending

    expect(store.get(CONV)?.status).toBe('ready')
    expect(store.canCancel(CONV)).toBe(true)
    expect(store.get(CONV)?.draft?.summary).toBe(DRAFT.summary)
  })
})

describe('US3 AC#4：已寫入但 LEAVE 失敗 —— MUST NOT 回退結案', () => {
  it('進入 writtenLeaveFailed、草稿清空、重試離開成功後條目消失', async () => {
    const store = useClosureStore()
    await openReady(store)

    fetchMock.mockImplementation(async (path) => {
      if (path.endsWith('/closure/commit')) {
        return {
          recordId: 'rec_1', reviewedBy: 'u_1', reviewedAt: '2026-09-03T12:00:00.000Z',
          created: true, reqId: 'r-3', newClosuresSincePanelOpen: [],
        }
      }
      throw new Error(`未預期的路徑 ${path}`)
    })

    const result = await store.commit(CONV)
    expect(result?.recordId).toBe('rec_1')
    // 成功 → leaving（LEAVE 由呼叫端另外打，契約 R3.9）
    expect(store.get(CONV)?.status).toBe('leaving')

    // LEAVE 失敗
    store.markLeaveFailed(CONV, '離開對話失敗')
    const s = store.get(CONV)
    expect(s?.status).toBe('writtenLeaveFailed')
    // FR-047b：第 6 區塊已消失
    expect(s?.draft).toBeNull()
    // ⚠️ MUST NOT 回退結案 —— 紀錄已經在 CRM 上，回退只會讓它變成孤兒
    expect(s?.error?.message).toBe('離開對話失敗')

    // 重試離開成功 → 條目刪除，畫面回到未結案
    store.finish(CONV)
    expect(store.get(CONV)).toBeUndefined()
  })

  it('FR-034：寫入成功時把「面板開啟後才出現的他人結案」原樣帶回給 UI', async () => {
    const store = useClosureStore()
    await openReady(store)

    fetchMock.mockImplementation(async (path) => {
      if (path.endsWith('/closure/commit')) {
        return {
          recordId: 'rec_2', reviewedBy: 'u_1', reviewedAt: '2026-09-03T12:00:00.000Z',
          created: true, reqId: 'r-4',
          newClosuresSincePanelOpen: [
            { recordId: 'rec_other', operatorName: '林佩君', closedAt: '2026-09-03T10:20:00.000Z' },
          ],
        }
      }
      throw new Error(`未預期的路徑 ${path}`)
    })

    const result = await store.commit(CONV)
    // ⚠️ **告知不是攔截**：流程照常往 leaving 走，紀錄照常已寫入
    expect(store.get(CONV)?.status).toBe('leaving')
    expect(result?.newClosuresSincePanelOpen).toEqual([
      { recordId: 'rec_other', operatorName: '林佩君', closedAt: '2026-09-03T10:20:00.000Z' },
    ])
  })
})
