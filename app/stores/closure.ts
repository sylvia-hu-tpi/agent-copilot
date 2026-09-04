/**
 * 結案流程的 tab-local 狀態 —— specs/006-closure-handoff-summary data-model.md §5。
 *
 * ⚠️⚠️ **MUST NOT 加 `localStorage`／`sessionStorage` 持久化**（契約守衛 G3）。
 *
 *      憲法 8.4「草稿絕不遺失」的標的是 **Composer 草稿** —— 客服自己打的字，
 *      遺失無從復原。**結案草稿不是那種東西**：它是模型產物，重按一次即可重生，
 *      而且尚未寫入任何紀錄。FR-040 因此逐字要求「重新整理等同取消，
 *      且不需任何清理或補償動作」。
 *
 *      **這不是偏離憲法，是兩個不同的標的。** 但這段話必須留在這裡 ——
 *      否則下一個人看到「草稿」兩個字就會依 8.4 加上持久化，
 *      而那會讓 FR-040 靜默失效：重新整理後畫面上出現一份草稿，
 *      它對應的快照與 `draftId` 卻是上一次的，客服按下寫入時不會有任何警告。
 *
 * ⚠️ **`commit()` 是全 repo 唯一呼叫 `/closure/commit` 的地方**（SC-001、契約 R3.1）。
 *    `test/closure-commit-guard.test.ts` 會掃 `app/**` 確認只有這一處。
 *    自動寫入路徑（閒置逾時、離開時、產生完成時）全部違反 FR-011，
 *    而**四種都不會報錯**：畫面照常，只是 CRM 多了一筆沒有人看過的紀錄。
 *
 * ⚠️ **四種寫入失敗共用同一個狀態機出口**（契約 R3.15）：一律回 `ready` ＋ 掛一則錯誤
 *    （草稿原封不動、面板不關、不離開對話）。`failKind` 只切換**文案與按鈕**（B7／B8），
 *    MUST NOT 開第二條狀態路徑 —— **沒有 `writeFailed` 這個狀態**。
 *    做成獨立狀態的話，「草稿還在不在」就變成兩個狀態各自維護的事，而漏掉一邊不會報錯。
 */

import { defineStore } from 'pinia'
import type {
  ClosureDraft,
  ClosureFollowUp,
  ClosurePeriodOrigin,
} from '#shared/types/copilot'

/** 涵蓋範圍選擇器要顯示的一列 */
export interface ClosureScopeCandidate {
  start: string
  origin: ClosurePeriodOrigin
  messageCount: number | null
  truncated: boolean
  label?: { category: string, reviewedByName: string, closedAt: string }
}

export interface ClosureScopes {
  candidates: ClosureScopeCandidate[]
  fallback: ClosureScopeCandidate
  overflowCount: number
  defaultIndex: number
  firstMessageAt: string
  baselineAt: string
  closureBaseline: string[]
}

export interface ClosureCommitResult {
  recordId: string
  reviewedBy: string
  reviewedAt: string
  created: boolean
  reqId: string
  newClosuresSincePanelOpen: Array<{ recordId: string, operatorName: string, closedAt: string }>
}

/**
 * ⚠️ **八個狀態，沒有第九個 `writeFailed`。** 見檔頭最後一段。
 *   `writing`／`leaving` 是**唯一**不可取消的兩個（FR-040a）——
 *   而它們之所以可以不可取消，是因為寫入路徑有 30 秒硬上界（FR-032a）。
 *   兩者缺一，客服會被困在既不能取消也不會自己結束的狀態裡。
 */
export type ClosureStatus =
  | 'loadingScopes'
  | 'scopesError'
  | 'generating'
  | 'draftError'
  | 'ready'
  | 'writing'
  | 'leaving'
  | 'writtenLeaveFailed'

export interface ClosureError {
  /** `'unverified'` ＝ 寫入回 200 但回查不存在（B8）；其餘一律 `'failed'`（B7） */
  failKind?: 'failed' | 'unverified'
  message: string
  reqId?: string
  at: string
}

export interface ClosureSession {
  status: ClosureStatus
  scopes: ClosureScopes | null
  selected: { periodStart: string, periodOrigin: ClosurePeriodOrigin } | null
  draft: ClosureDraft | null
  /** 結案期間有新訊息抵達 —— 只顯示過期標記，**MUST NOT** 自動重新產生（FR-020／FR-044） */
  stale: boolean
  error: ClosureError | null
  baselineAt: string | null
  closureBaseline: string[]
  /** 在途請求的取消控制器。⚠️ 不是狀態，是資源；`cancel()`／落定時一律清掉 */
  abort: AbortController | null
}

/** 可由客服編輯的欄位（data-model §2）—— `updateField()` 只接受這些 */
export type ClosureEditableKey =
  | 'summary' | 'intent' | 'category' | 'resolution'
  | 'actionsTaken' | 'sentimentOutcome' | 'citedSopIds' | 'followUps'

type ClosureEditableValue = string | string[] | ClosureFollowUp[]

function blank(): ClosureSession {
  return {
    status: 'loadingScopes',
    scopes: null,
    selected: null,
    draft: null,
    stale: false,
    error: null,
    baselineAt: null,
    closureBaseline: [],
    abort: null,
  }
}

function messageOf(err: unknown): string {
  const data = (err as { data?: { message?: string } })?.data
  return data?.message
    ?? (err as { statusMessage?: string })?.statusMessage
    ?? (err as { message?: string })?.message
    ?? '未知錯誤'
}

function failKindOf(err: unknown): 'failed' | 'unverified' {
  const kind = (err as { data?: { data?: { failKind?: string } } })?.data?.data?.failKind
    ?? (err as { data?: { failKind?: string } })?.data?.failKind
  // ⚠️ 預設 `failed`：認不出來的失敗當成「可直接重試」那一類。
  //    反過來預設 `unverified` 會讓每一次平常的失敗都要求客服先去 CRM 查一遍。
  return kind === 'unverified' ? 'unverified' : 'failed'
}

function reqIdOf(err: unknown): string | undefined {
  const data = (err as { data?: { data?: { reqId?: string } } })?.data?.data
    ?? (err as { data?: { reqId?: string } })?.data
  return data?.reqId
}

export const useClosureStore = defineStore('closure', () => {
  const sessions = ref<Map<string, ClosureSession>>(new Map())

  function get(conversationId: string): ClosureSession | undefined {
    return sessions.value.get(conversationId)
  }

  /** ⚠️ 換整個 Map 才會觸發 reactivity —— 就地改 Map 的值 Vue 看不到 */
  function put(conversationId: string, next: ClosureSession): void {
    const copy = new Map(sessions.value)
    copy.set(conversationId, next)
    sessions.value = copy
  }

  function patch(conversationId: string, over: Partial<ClosureSession>): void {
    const cur = get(conversationId)
    if (!cur) return
    put(conversationId, { ...cur, ...over })
  }

  function drop(conversationId: string): void {
    const copy = new Map(sessions.value)
    copy.delete(conversationId)
    sessions.value = copy
  }

  // ── Getters ─────────────────────────────────────────────────────────

  const isClosing = (conversationId: string): boolean => sessions.value.has(conversationId)

  /**
   * ⚠️ `writing`／`leaving` 之外一律可取消（FR-040a）。
   *    產生摘要期間**必須**可取消：它沒有固定秒數上界（SC-004），
   *    不可取消 ＋ 沒有上界 ＝ 客服被困住。
   */
  const canCancel = (conversationId: string): boolean => {
    const s = get(conversationId)
    if (!s) return false
    return s.status !== 'writing' && s.status !== 'leaving'
  }

  /** Sidebar 的「結案未完成」標記（FR-041）—— ⚠️ 不是倒數、不是自動寫入 */
  const hasPending = (conversationId: string): boolean => sessions.value.has(conversationId)

  // ── Actions ─────────────────────────────────────────────────────────

  /** 按下「結案」—— **只開面板**，不 LEAVE、不產生草稿、不寫任何東西 */
  async function open(conversationId: string): Promise<void> {
    put(conversationId, blank())
    await loadScopes(conversationId)
  }

  async function loadScopes(conversationId: string): Promise<void> {
    const abort = new AbortController()
    patch(conversationId, { status: 'loadingScopes', error: null, abort })
    try {
      const scopes = await $fetch<ClosureScopes>(
        `/api/conversations/${conversationId}/closure/scopes`,
        { method: 'POST', signal: abort.signal },
      )
      // 面板已被取消 —— 回應到得比取消晚，MUST NOT 把它復活
      if (!get(conversationId)) return
      patch(conversationId, {
        scopes,
        baselineAt: scopes.baselineAt,
        closureBaseline: scopes.closureBaseline,
        abort: null,
      })

      /*
        ⚠️ `defaultIndex === -1` 代表「全部候選都是 0 則」或「從未結案」——
           落到 `fallback`（從第一則對話起算），MUST NOT 退回 `candidates[0]`。
      */
      const chosen = scopes.defaultIndex >= 0
        ? scopes.candidates[scopes.defaultIndex]
        : scopes.fallback
      if (chosen) await pick(conversationId, chosen.start, chosen.origin)
    }
    catch (err) {
      if (!get(conversationId)) return
      if (isAbort(err)) return
      // R1.4：查詢失敗是失敗 —— MUST NOT 以任何預設區間頂替，MUST NOT 產生草稿
      patch(conversationId, {
        status: 'scopesError',
        abort: null,
        error: { message: messageOf(err), at: new Date().toISOString() },
      })
    }
  }

  /**
   * 選一個涵蓋區間並產生草稿。
   *
   * ⚠️ **先把 `draft` 清空再發請求**（契約 R2.2）。保留舊內容的話，改區間期間
   *    畫面上顯示的是**上一個區間**的摘要 —— 而客服看不出來，因為兩份長得一樣。
   */
  async function pick(
    conversationId: string,
    periodStart: string,
    periodOrigin: ClosurePeriodOrigin,
  ): Promise<void> {
    get(conversationId)?.abort?.abort()
    const abort = new AbortController()
    patch(conversationId, {
      status: 'generating',
      selected: { periodStart, periodOrigin },
      draft: null,
      stale: false,
      error: null,
      abort,
    })

    try {
      const draft = await $fetch<ClosureDraft>(
        `/api/conversations/${conversationId}/closure/draft`,
        { method: 'POST', body: { periodStart, periodOrigin }, signal: abort.signal },
      )
      if (!get(conversationId)) return
      patch(conversationId, { status: 'ready', draft, abort: null })
    }
    catch (err) {
      if (!get(conversationId)) return
      if (isAbort(err)) return
      // FR-046：顯示錯誤與重試，**MUST NOT 呈現空白草稿**
      patch(conversationId, {
        status: 'draftError',
        draft: null,
        abort: null,
        error: { message: messageOf(err), at: new Date().toISOString() },
      })
    }
  }

  /** 「重新產生」＝ 以當前區間再跑一次 ⇒ **新的 `draftId`**（US2 AC#2） */
  async function regenerate(conversationId: string): Promise<void> {
    const selected = get(conversationId)?.selected
    if (!selected) return
    await pick(conversationId, selected.periodStart, selected.periodOrigin)
  }

  /** ⚠️ 只允許 data-model §2 的可編輯欄位 —— 唯讀欄位由 server 重算，改了也沒用（R3.7） */
  function updateField(
    conversationId: string,
    key: ClosureEditableKey,
    value: ClosureEditableValue,
  ): void {
    const s = get(conversationId)
    if (!s?.draft) return
    put(conversationId, { ...s, draft: { ...s.draft, [key]: value } as ClosureDraft })
  }

  /** 結案期間有新訊息 —— 只標記，**MUST NOT** 自動重新產生（FR-020／FR-044） */
  function markStale(conversationId: string): void {
    const s = get(conversationId)
    if (!s || s.stale) return
    patch(conversationId, { stale: true })
  }

  /**
   * **全 repo 唯一呼叫 `/closure/commit` 的地方。**
   *
   * ⚠️ 成功 → `leaving`（由呼叫端接著跑既有的 `/leave`，R3.9）。
   * ⚠️ 失敗 → **回 `ready`** ＋ `error`，`draft` 原封不動（FR-032）。
   *    四種失敗形態共用這一條出口，只有 `failKind` 不同。
   */
  async function commit(conversationId: string): Promise<ClosureCommitResult | null> {
    const s = get(conversationId)
    if (!s?.draft || !s.selected || s.status !== 'ready') return null
    const draft = s.draft

    // ⚠️ `writing` 期間不可取消（FR-040a）—— 因此這裡不掛 AbortController
    patch(conversationId, { status: 'writing', error: null, abort: null })

    try {
      const result = await $fetch<ClosureCommitResult>(
        `/api/conversations/${conversationId}/closure/commit`,
        {
          method: 'POST',
          body: {
            draftId: draft.draftId,
            periodStart: draft.period.start,
            periodOrigin: draft.period.origin,
            periodMessageCount: draft.period.messageCount,
            summary: draft.summary,
            intent: draft.intent,
            category: draft.category,
            resolution: draft.resolution,
            actionsTaken: draft.actionsTaken,
            sentimentOutcome: draft.sentimentOutcome,
            citedSopIds: draft.citedSopIds,
            followUps: draft.followUps,
            baselineAt: s.baselineAt,
            closureBaseline: s.closureBaseline,
          },
        },
      )
      if (!get(conversationId)) return null
      patch(conversationId, { status: 'leaving' })
      return result
    }
    catch (err) {
      if (!get(conversationId)) return null
      /*
        ⚠️ **這一段就是 US3 的全部內容。** 回 `ready`、草稿逐欄保留、面板不關、不離開對話。
           `failKind` 只決定 B7／B8 的文案與按鈕，狀態轉移完全相同。
      */
      patch(conversationId, {
        status: 'ready',
        error: {
          failKind: failKindOf(err),
          message: messageOf(err),
          reqId: reqIdOf(err),
          at: new Date().toISOString(),
        },
      })
      return null
    }
  }

  /**
   * 取消結案 —— 回到「已接手」狀態，**不留下任何紀錄**。
   * ⚠️ `writing`／`leaving` 期間不可取消（FR-040a）。
   */
  function cancel(conversationId: string): void {
    if (!canCancel(conversationId)) return
    get(conversationId)?.abort?.abort()
    drop(conversationId)
  }

  /** 寫入且 LEAVE 都成功 —— 條目消失，第 6 區塊隨之整塊不存在（FR-047） */
  function finish(conversationId: string): void {
    drop(conversationId)
  }

  /**
   * 已寫入但 LEAVE 失敗（FR-033、FR-047b）。
   *
   * ⚠️ **MUST NOT 回退結案** —— 紀錄已經在 CRM 上了，回退只會讓它變成孤兒。
   *    草稿清空是因為第 6 區塊此時已經沒有意義（它的工作完成了），
   *    剩下的是頂端一條「重試離開」的橫幅。
   */
  function markLeaveFailed(conversationId: string, message: string): void {
    const s = get(conversationId)
    if (!s) return
    put(conversationId, {
      ...s,
      status: 'writtenLeaveFailed',
      draft: null,
      abort: null,
      error: { message, at: new Date().toISOString() },
    })
  }

  return {
    sessions,
    get,
    isClosing,
    canCancel,
    hasPending,
    open,
    loadScopes,
    pick,
    regenerate,
    updateField,
    markStale,
    commit,
    cancel,
    finish,
    markLeaveFailed,
  }
})

/** 取消不是失敗 —— 呼叫端已經不在看了，改狀態只會讓被取消的面板復活 */
function isAbort(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'AbortError' || name === 'CanceledError'
}
