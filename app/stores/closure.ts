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
  ClosureCitedSop,
  ClosureCommitResponse,
  ClosureDraft,
  ClosureFollowUp,
  ClosurePeriodOrigin,
  ClosureScopeCandidate,
  ClosureScopesResponse,
} from '#shared/types/copilot'

/*
  ⚠️ **三個回應型別已經搬到 `shared/types/copilot.ts`**（2026-09-08）。
     以前這裡手抄了一份 server 端的形狀，而兩支 route 又沒有回傳型別註記 ——
     `$fetch<T>()` 因此是單方面的斷言：server 改名 `overflowCount` 或
     `newClosuresSincePanelOpen[].operatorName` 仍然全綠，UI 只是安靜地讀到
     `undefined`（FR-034 的提示會顯示一個空的客服名字）。
     兩邊都指向 shared 之後，改一邊就是 tsc 錯誤。
     ⚠️ 這兩個別名只為了不動既有的元件 import；**MUST NOT 在這裡重新宣告欄位**。
*/
export type { ClosureScopeCandidate }
export type ClosureScopes = ClosureScopesResponse
export type ClosureCommitResult = ClosureCommitResponse

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
  /**
   * 錯誤的可讀原因。
   *
   * ⚠️ **空字串 ＝ 取不到原因**（不是「沒有錯誤」）。以前這裡會塞一句寫死的
   *    「未知錯誤」，而它會經 `failMeta` 顯示給客服 —— 憲法 8.5 要求 UI 文案
   *    集中在 i18n。改成留空後，由元件以 `closure.fail.unknownReason` 補上。
   */
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
  /**
   * 寫入成功後拿到的 Board 紀錄 id（`null` ＝ 還沒寫入成功）。
   *
   * ⚠️ **C1 橫幅要顯示它**（FR-047b）：LEAVE 失敗時客服唯一能拿去 CRM 上把這筆
   *    找出來的識別碼就是它。以前橫幅讀的是 `error.reqId`，而 `markLeaveFailed()`
   *    根本沒寫 `reqId` —— 於是文案永遠渲染成「摘要已存入 CRM（），但⋯」。
   *    ⚠️ 就算 `reqId` 有值也不對：那是**請求**的 id，不是**紀錄**的 id。
   */
  recordId: string | null
  /**
   * 這次 `generating` 是「**重新產生**」而不是首次產生。
   *
   * ⚠️ **不能用 `draft !== null` 推導**：契約 R2.2 要求發請求前先把 `draft` 清空
   *    （保留舊內容的話，畫面上顯示的是上一個區間的摘要，而客服看不出來），
   *    因此 `generating` 期間 `draft` **恆為 `null`**，兩種產生分不出來。
   *    2026-09-04 就是這樣讓 regen 的提示與忙碌鍵變成死程式碼的。
   */
  regenerating: boolean
  /** 在途請求的取消控制器。⚠️ 不是狀態，是資源；`cancel()`／落定時一律清掉 */
  abort: AbortController | null
}

/** 可由客服編輯的欄位（data-model §2）—— `updateField()` 只接受這些 */
export type ClosureEditableKey =
  | 'summary' | 'intent' | 'category' | 'resolution'
  | 'actionsTaken' | 'sentimentOutcome' | 'citedSops' | 'followUps'

type ClosureEditableValue = string | string[] | ClosureFollowUp[] | ClosureCitedSop[]

function blank(): ClosureSession {
  return {
    status: 'loadingScopes',
    scopes: null,
    selected: null,
    draft: null,
    stale: false,
    error: null,
    recordId: null,
    regenerating: false,
    abort: null,
  }
}

/**
 * ⚠️ 取不到原因時回**空字串**，MUST NOT 在這裡塞一句中文 ——
 *    這個值會經 `failMeta` 顯示給客服，而憲法 8.5 要求 UI 文案集中在 i18n
 *    （「即使目前只有繁體中文」）。補話的責任在元件那一側。
 */
function messageOf(err: unknown): string {
  const data = (err as { data?: { message?: string } })?.data
  return data?.message
    ?? (err as { statusMessage?: string })?.statusMessage
    ?? (err as { message?: string })?.message
    ?? ''
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

  /**
   * 這個對話是否**還在結案流程中**。
   *
   * ⚠️⚠️ **`writtenLeaveFailed` 不算**（2026-09-08 修，FR-047b 逐字：
   *      「包含『摘要已寫入但離開失敗』那個狀態 —— 結案本身已完成，
   *      區塊 MUST NOT 留在畫面上」）。
   *
   *      以前這裡是 `sessions.has(id)`，於是寫入成功但 LEAVE 失敗時：
   *      第 6 區塊還掛在畫面上（`draft` 已被清空，只剩一個空的選擇器）、
   *      標題列還轉著「結案中…」並開放「取消結案」、服務模式還鎖著、
   *      Composer 還掛著橫幅、Sidebar 還標「結案未完成」、心跳還在對同事
   *      廣播 `closing: true` —— 而那筆紀錄早就在 CRM 上了。
   *      更糟的是「取消結案」在那個狀態下可按，一按就把 session 丟掉，
   *      連 C1 重試橫幅一起消失，客服仍在 JOIN 狀態且畫面上再無任何線索。
   *
   * ⚠️ **這是五處呈現的唯一判定來源**（見 `pages/c/[conversationId].vue`）。
   *    要判斷「LEAVE 失敗」請直接讀 `status`，MUST NOT 在這裡開特例。
   */
  const isClosing = (conversationId: string): boolean =>
    (get(conversationId)?.status ?? null) !== null
    && get(conversationId)!.status !== 'writtenLeaveFailed'

  /**
   * ⚠️ `writing`／`leaving` 之外一律可取消（FR-040a）。
   *    產生摘要期間**必須**可取消：它沒有固定秒數上界（SC-004），
   *    不可取消 ＋ 沒有上界 ＝ 客服被困住。
   *
   * ⚠️ `writtenLeaveFailed` **不可取消**：紀錄已經在 CRM 上了，這時「取消」
   *    唯一的效果是把重試離開的唯一入口刪掉（FR-033、畫布 C1 沒有這條出路）。
   */
  const canCancel = (conversationId: string): boolean => {
    const s = get(conversationId)
    if (!s) return false
    return s.status !== 'writing' && s.status !== 'leaving' && s.status !== 'writtenLeaveFailed'
  }

  /**
   * Sidebar 的「結案未完成」標記（FR-041）—— ⚠️ 不是倒數、不是自動寫入。
   * ⚠️ 與 `isClosing()` 同義且刻意如此：兩個名字對應畫面上兩個不同的東西
   *    （右欄版面／左欄標記），但判定 MUST 是同一個 —— 分開寫就會分岔。
   */
  const hasPending = (conversationId: string): boolean => isClosing(conversationId)

  // ── Actions ─────────────────────────────────────────────────────────

  /** 按下「結案」—— **只開面板**，不 LEAVE、不產生草稿、不寫任何東西 */
  async function open(conversationId: string): Promise<void> {
    put(conversationId, blank())
    await loadScopes(conversationId)
  }

  /**
   * 結案已經寫進 CRM 了，這個 session 只剩「重試離開」一件事。
   *
   * ⚠️ 產生類的動作（`loadScopes`／`pick`／`regenerate`）在這個狀態下 MUST 全部拒絕。
   *    沒有這道守衛的話：`markLeaveFailed()` 保留了 `scopes`，選擇器只要還畫得出來
   *    就能再選一次範圍 → 拿到**新的 `draftId`** → 寫入鍵重新亮起 → 而 Board 的冪等
   *    只認 `draftId` → 同一次服務在正式 Board 上多出第二筆紀錄，全程不報錯。
   *    第一道防線是 `isClosing()` 讓整個區塊消失，這是第二道。
   */
  function isSettled(conversationId: string): boolean {
    return get(conversationId)?.status === 'writtenLeaveFailed'
  }

  /**
   * 「這個回應仍然屬於當前那一次請求嗎」—— 落定前一律先問。
   *
   * ⚠️⚠️ **只靠 `abort.abort()` 是擋不住競態的**（2026-09-08 修）。原本的寫法假設
   *      「舊的那次被 abort 掉之後就會走 `isAbort` 靜默收工」，但那有兩個破口：
   *
   *      ① **abort 抓不到。** Nuxt 的 `$fetch`（ofetch）會把中止一律重新包成
   *         `FetchError`，原始的 `AbortError` 只留在 `cause` 裡。舊的 `isAbort()`
   *         只看 `err.name`，因此判不出來，直接落到下面的 `draftError` 分支：
   *         面板閃一下「結案摘要產生失敗」，而且把**新那次**的 `abort` 清成 null
   *         （於是接下來想取消也取消不了），直到新的回應到達才自己好回來。
   *         單元測試以裸的 `AbortError` 模擬，正好繞過了這個差異。
   *      ② **已經完成的請求 abort 不掉。** 舊那次若在 abort 之前就回來了，
   *         它的 `.then` 照樣會跑，把上一個區間的草稿蓋到新狀態上。
   *
   *      比對 controller 身分把兩個破口一起關掉：不是當前這一次的回應，一律不碰狀態。
   */
  function isMine(conversationId: string, abort: AbortController): boolean {
    const s = get(conversationId)
    return !!s && s.abort === abort
  }

  async function loadScopes(conversationId: string): Promise<void> {
    if (isSettled(conversationId)) return
    const abort = new AbortController()
    patch(conversationId, { status: 'loadingScopes', error: null, abort })
    try {
      const scopes = await $fetch<ClosureScopes>(
        `/api/conversations/${conversationId}/closure/scopes`,
        { method: 'POST', signal: abort.signal },
      )
      // 面板已被取消 —— 回應到得比取消晚，MUST NOT 把它復活
      if (!get(conversationId)) return
      patch(conversationId, { scopes, abort: null })

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
      if (!isMine(conversationId, abort)) return
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
    if (isSettled(conversationId)) return
    // ⚠️ 先中止在途的那一次 —— 兩次產生同時在跑的話，先回來的那個會被後回來的蓋掉，
    //    而「先發的後回」完全可能（區間越長越慢）。abort 之後舊的 catch 走 `isAbort` 靜默收工。
    get(conversationId)?.abort?.abort()
    const abort = new AbortController()
    // ⚠️ 在 `draft` 被清掉**之前**取 —— 它是「這次是重新產生」的唯一依據（見型別註解）
    const hadDraft = !!get(conversationId)?.draft
    patch(conversationId, {
      status: 'generating',
      selected: { periodStart, periodOrigin },
      draft: null,
      stale: false,
      error: null,
      regenerating: hadDraft,
      abort,
    })

    try {
      const draft = await $fetch<ClosureDraft>(
        `/api/conversations/${conversationId}/closure/draft`,
        { method: 'POST', body: { periodStart, periodOrigin }, signal: abort.signal },
      )
      if (!isMine(conversationId, abort)) return
      patch(conversationId, { status: 'ready', draft, regenerating: false, abort: null })
    }
    catch (err) {
      if (!isMine(conversationId, abort)) return
      if (isAbort(err)) return
      // FR-046：顯示錯誤與重試，**MUST NOT 呈現空白草稿**
      patch(conversationId, {
        status: 'draftError',
        draft: null,
        regenerating: false,
        abort: null,
        error: { message: messageOf(err), at: new Date().toISOString() },
      })
    }
  }

  /** 「重新產生」＝ 以當前區間再跑一次 ⇒ **新的 `draftId`**（US2 AC#2） */
  async function regenerate(conversationId: string): Promise<void> {
    if (isSettled(conversationId)) return
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
    // ⚠️ `scopes` 也是前提：FR-034 的基準線就存在裡面（見下方 body）
    if (!s?.draft || !s.selected || !s.scopes || s.status !== 'ready') return null
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
            // ⚠️ 情緒涵蓋判定的比較對象 —— server 端算不出來（守衛 G1 禁止它讀訊息），
            //    只能由草稿原樣帶回。漏帶會讓三個情緒欄全部留空，且不會報錯。
            periodFirstCustomerAt: draft.period.firstCustomerAt,
            summary: draft.summary,
            intent: draft.intent,
            category: draft.category,
            resolution: draft.resolution,
            actionsTaken: draft.actionsTaken,
            sentimentOutcome: draft.sentimentOutcome,
            /*
              ⚠️ **Board 只收 id**（`cited_sops`）—— 標題只活在草稿裡，供客服判斷該不該刪。
                 檔名會隨版本／可見範圍後綴變動，存進稽核紀錄的必須是穩定的識別。
                 ⚠️ 在這裡就地 `.map()`，MUST NOT 在 store 上另存一份 id 陣列 ——
                 那又是一組必須恆等卻沒有機制保證的鏡像欄位（見下方 `baselineAt` 那段）。
            */
            citedSopIds: draft.citedSops.map(s => s.id),
            followUps: draft.followUps,
            /*
              ⚠️ 直接讀 `scopes`，**不再另存一份鏡像欄位**（2026-09-08）。
                 以前 session 上有 `baselineAt`／`closureBaseline` 兩個欄位，
                 內容永遠等於 `scopes` 裡的同名欄位、只在載入候選時寫一次、只在這裡讀。
                 兩個必須恆等卻沒有任何機制保證的欄位 —— 哪天有人只更新 `scopes`
                 而忘了鏡像，送出的就是一條過期的 FR-034 基準線，而且不會報錯。
            */
            baselineAt: s.scopes.baselineAt,
            closureBaseline: s.scopes.closureBaseline,
          },
        },
      )
      if (!get(conversationId)) return null
      // ⚠️ `recordId` MUST 存下來 —— LEAVE 失敗時 C1 橫幅要靠它讓客服在 CRM 上找到這筆
      patch(conversationId, { status: 'leaving', recordId: result.recordId })
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
   *
   * ⚠️ **這個狀態下 `isClosing()`／`hasPending()` 都是 `false`、`canCancel()` 也是**
   *    （FR-047b）。session 之所以留著，只是為了那條橫幅要顯示的 `recordId`
   *    與失敗原因，以及讓「重試離開」有東西可重試 —— 它已經不是「結案中」。
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

/**
 * 取消不是失敗 —— 呼叫端已經不在看了，改狀態只會讓被取消的面板復活。
 *
 * ⚠️ **MUST 一併看 `cause`**：Nuxt 的 `$fetch`（ofetch）把每一個失敗都重新包成
 *    `FetchError`（`name` 就是 `'FetchError'`），原始的 `AbortError`／`DOMException`
 *    只留在 `cause` 裡。只看最外層的 `name` 會把「客服自己按了取消」判成一次真正的失敗。
 */
function isAbort(err: unknown): boolean {
  const named = (e: unknown): boolean => {
    const name = (e as { name?: string })?.name
    return name === 'AbortError' || name === 'CanceledError'
  }
  return named(err) || named((err as { cause?: unknown })?.cause)
}
