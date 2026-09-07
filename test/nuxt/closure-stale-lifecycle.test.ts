/**
 * 過期標記的生命週期 —— FR-044 的**另一半**。
 *
 * `test/message-merge-stale.test.ts` 守的是「什麼時候該標」（`added > 0`，
 * 2026-09-07 的誤報缺陷）。這支守的是「**標上去之後會不會被弄丟**」——
 * 而後者的代價完全不對稱：
 *
 *   誤報 → 客服多按一次「重新產生」，煩人。
 *   漏報 → 客服把一份**遺漏了訊息**的摘要寫進 CRM，而畫面上沒有任何跡象。
 *
 * ⚠️ 因此 `markStale()` 是**單向**的：只有「以當前區間重新產生」才清得掉它。
 *    任何「切回來就重算一次」的寫法都會把真實的過期標記洗掉 —— 那是修上一個
 *    誤報缺陷時最容易踩過頭的方向，也正是這支測試要擋的東西。
 *
 * ⚠️ **本檔必須放在 `test/nuxt/`**（理由同 `closure-store-failures.test.ts`）：
 *    它 import `app/stores/closure.ts`，只有這個目錄由 `nuxt typecheck`
 *    以真正的 auto-import 型別檢查。
 */

import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONV = 'conv-stale-lifecycle'

const fetchMock = vi.fn<(path: string, opts?: Record<string, unknown>) => Promise<unknown>>()
let useClosureStore: typeof import('../../app/stores/closure.js')['useClosureStore']

const SCOPES = {
  candidates: [],
  fallback: { start: '2026-09-07T00:00:00.000Z', origin: 'first', messageCount: 9, truncated: false },
  overflowCount: 0,
  defaultIndex: -1,
  firstMessageAt: '2026-09-07T00:00:00.000Z',
  baselineAt: '2026-09-07T09:00:00.000Z',
  closureBaseline: [],
}

function draft(draftId: string): Record<string, unknown> {
  return {
    draftId,
    conversationId: CONV,
    period: { start: SCOPES.fallback.start, origin: 'first', messageCount: 9, truncated: false },
    summary: '客服已完成說明', intent: '客戶詢問訂單',
    category: '訂單查詢', resolution: 'resolved',
    actionsTaken: ['已提供操作說明'], sentimentOutcome: 'satisfied',
    citedSopIds: [], followUps: [],
    readonly: {
      operators: ['u_1'], joinedAt: SCOPES.fallback.start, closedAt: null,
      sentimentStart: null, sentimentEnd: null, sentimentTrough: null,
      sentimentNote: '評分點不齊', channel: 'line', contactId: 'con_1', confidence: null,
    },
  }
}

let nextDraftId = 0

beforeEach(async () => {
  fetchMock.mockReset()
  nextDraftId = 0
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

/** 開面板 → 產生草稿 → 停在 `ready`。每次產生給一個新的 draftId（US2 AC#2） */
async function openReady(store: ReturnType<typeof useClosureStore>): Promise<void> {
  fetchMock.mockImplementation(async (path) => {
    if (path.endsWith('/closure/scopes')) return SCOPES
    if (path.endsWith('/closure/draft')) return draft(`draft_${++nextDraftId}`)
    throw new Error(`未預期的路徑 ${path}`)
  })
  await store.open(CONV)
  expect(store.get(CONV)?.status).toBe('ready')
}

describe('標上去（B-1／B-2：真的有新訊息）', () => {
  it('草稿產生後 stale MUST 為 false —— 剛產生的東西不可能是過期的', async () => {
    const store = useClosureStore()
    await openReady(store)
    expect(store.get(CONV)?.stale).toBe(false)
  })

  it('markStale() MUST 把 stale 翻成 true，且 MUST NOT 動到草稿或狀態', async () => {
    const store = useClosureStore()
    await openReady(store)
    const before = JSON.parse(JSON.stringify(store.get(CONV)!.draft))

    store.markStale(CONV)

    const after = store.get(CONV)!
    expect(after.stale).toBe(true)
    // ⚠️ FR-020／FR-044：只標記，MUST NOT 自動重新產生 —— 客服正在編輯的內容不可被蓋掉
    expect(JSON.parse(JSON.stringify(after.draft)), '草稿 MUST 逐欄未變').toEqual(before)
    expect(after.status, 'MUST NOT 自己跑去 generating').toBe('ready')
    const draftCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/closure/draft'))
    expect(draftCalls, '標記過期 MUST NOT 觸發任何一次 AI 呼叫').toHaveLength(1)
  })

  it('沒有結案面板時 markStale() MUST 是 no-op（沒在結案就沒有東西會過期）', () => {
    const store = useClosureStore()
    store.markStale(CONV)
    expect(store.get(CONV)).toBeUndefined()
  })
})

describe('弄不丟（B-4：修過頭的方向）', () => {
  it('⚠️ markStale() 是單向的 —— 重複呼叫 MUST NOT 把它翻回 false', async () => {
    const store = useClosureStore()
    await openReady(store)
    store.markStale(CONV)
    store.markStale(CONV)
    store.markStale(CONV)
    expect(store.get(CONV)?.stale).toBe(true)
  })

  it('⚠️ 編輯草稿欄位 MUST NOT 清掉過期標記 —— 客服改字不代表他看過那則新訊息', async () => {
    const store = useClosureStore()
    await openReady(store)
    store.markStale(CONV)
    store.updateField(CONV, 'summary', '客服已完成說明，並補充了退貨政策')
    expect(store.get(CONV)?.stale).toBe(true)
  })
})

describe('清得掉（B-3：重新產生）', () => {
  it('regenerate() MUST 清掉 stale，並拿到**新的** draftId（US2 AC#2）', async () => {
    const store = useClosureStore()
    await openReady(store)
    const firstId = store.get(CONV)!.draft!.draftId
    store.markStale(CONV)
    expect(store.get(CONV)?.stale).toBe(true)

    await store.regenerate(CONV)

    const after = store.get(CONV)!
    expect(after.stale, '重新產生後 MUST 不再是過期的').toBe(false)
    expect(after.status).toBe('ready')
    expect(after.draft?.draftId, '重新產生 ＝ 一份新草稿，MUST 是新的 draftId').not.toBe(firstId)
  })

  it('⚠️ 重新產生**失敗**時 MUST NOT 留下「不過期」的假象', async () => {
    const store = useClosureStore()
    await openReady(store)
    store.markStale(CONV)

    fetchMock.mockImplementation(async (path) => {
      if (path.endsWith('/closure/draft')) throw new Error('產生失敗')
      throw new Error(`未預期的路徑 ${path}`)
    })
    await store.regenerate(CONV)

    const after = store.get(CONV)!
    // FR-046：失敗就是失敗，MUST NOT 呈現空白草稿
    expect(after.status).toBe('draftError')
    expect(after.draft, '失敗時 MUST NOT 留下草稿').toBeNull()
    // ⚠️ 沒有草稿就沒有「這份摘要過不過期」可言 —— 提示掛在 `v-if="draft"` 底下，
    //    此刻不會渲染。真正該擋的是「有草稿、卻宣稱它是最新的」，而那條路徑不存在。
    expect(after.stale && after.draft !== null, '不可出現「有草稿且宣稱最新」的假象').toBe(false)
  })
})
