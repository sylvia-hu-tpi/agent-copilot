/**
 * 單一對話的工作區狀態 —— 訊息流、presence、control、送出。
 *
 * 對應 docs/ARCHITECTURE.md §9.5（SSE）、§10.2（presence）、§10.4（撞單）、§10.6（mode）。
 *
 * ── 三個容易寫錯的地方 ───────────────────────────────────────────
 * ⚠️ ① **訊息必須以 id 去重。** 後端在錨點找不到時（斷線太久被 N 則的視窗擠出去）
 *    會回傳整批，寧可重送也不漏送。前端如果直接 append 就會看到重複的訊息。
 *
 * ⚠️ ② **`mode` 不可快取。** 它是對話層級的共用狀態，同事在官方介面切換
 *    我方也要跟著變（§10.6）。因此一律以 SSE 的 `control.updated` 為準，
 *    不用本地推測的值覆蓋它。
 *
 * ⚠️ ③ **撞單被攔截時不可清草稿。** 那正是客服最需要那段文字的時刻。
 */

import type {
  ConversationControl,
  Message,
} from '#shared/types/conversation'
import type {
  CollisionReport,
  CopilotEvent,
  PresenceSnapshot,
} from '#shared/types/events'

/** 心跳間隔 —— 必須小於 server 端的 PRESENCE_TTL_MS（45s），容忍漏一拍 */
const HEARTBEAT_MS = 20_000

interface ConversationDetailResponse {
  conversation: {
    id: string
    name: string
    channel: string
    contactId: string
    status: string
    mode: ConversationControl['mode']
    teamConversationId?: string
    viewerJoined: boolean
    /** 畫布 §8.3 meta 列的「建立於 …」。實測填充率 100%，見 shared/types/conversation.ts */
    createdAt?: string
  }
  control: ConversationControl
  presence: PresenceSnapshot
}

interface MessagesResponse {
  conversationId: string
  messages: Message[]
  lastMessageId: string | null
  hasMore: boolean
}

interface SendErrorData {
  reason?: 'collision' | 'automation_only' | 'locked'
  collision?: CollisionReport
  control?: ConversationControl
}

export function useConversationView(conversationId: Ref<string>) {
  const stream = useStreamStore()
  const closure = useClosureStore()

  const messages = ref<Message[]>([])
  const detail = ref<ConversationDetailResponse['conversation'] | null>(null)
  const control = ref<ConversationControl | null>(null)
  const presence = ref<PresenceSnapshot>({ operators: [], unidentifiedActor: false, mode: null })

  const loading = ref(false)
  const loadingMore = ref(false)
  const hasMore = ref(false)
  const error = ref<string | null>(null)

  const sending = ref(false)
  const sendError = ref<string | null>(null)
  /** 非 null 時 UI 必須擋住送出並顯示對話框（憲法 3.3① —— 刻意阻斷的封閉集合之一） */
  const collision = ref<CollisionReport | null>(null)

  const busy = ref(false)

  /** 版本錨點（§10.4）—— 撞單檢查以它為基準 */
  const lastMessageId = computed(() => messages.value.at(-1)?.id ?? null)

  const viewerJoined = computed(() => detail.value?.viewerJoined ?? false)
  const canSend = computed(() => (control.value?.agentCanSend ?? false) && viewerJoined.value)

  // ── 訊息合併 ──────────────────────────────────────────────────────

  /**
   * ⚠️ 以 id 去重，並維持時間順序。
   *
   * 後端的 `fetchSince()` 在錨點失效時回傳整批（寧可重送也不漏送，§9.4），
   * 所以這裡一定會收到已經有的訊息 —— 直接 append 的話畫面上會出現重複。
   */
  function merge(incoming: Message[]): void {
    if (incoming.length === 0) return
    const byId = new Map(messages.value.map(m => [m.id, m]))
    for (const m of incoming) byId.set(m.id, m)
    messages.value = [...byId.values()].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
    )
  }

  // ── 載入 ──────────────────────────────────────────────────────────

  async function loadAll(): Promise<void> {
    if (!conversationId.value) return
    loading.value = true
    error.value = null
    try {
      const [d, m] = await Promise.all([
        $fetch<ConversationDetailResponse>(`/api/conversations/${conversationId.value}`),
        $fetch<MessagesResponse>('/api/messages', { query: { conversationId: conversationId.value } }),
      ])
      detail.value = d.conversation
      control.value = d.control
      presence.value = d.presence
      messages.value = m.messages
      hasMore.value = m.hasMore
    }
    catch (err) {
      error.value = messageOf(err)
    }
    finally {
      loading.value = false
    }
  }

  /** 回補更早的歷史（§9.3：平台不支援增量，回補靠 skip 分頁） */
  async function loadOlder(): Promise<void> {
    if (loadingMore.value || !hasMore.value || !conversationId.value) return
    loadingMore.value = true
    try {
      const res = await $fetch<MessagesResponse>('/api/messages', {
        query: { conversationId: conversationId.value, skip: messages.value.length },
      })
      merge(res.messages)
      hasMore.value = res.hasMore
    }
    catch (err) {
      error.value = messageOf(err)
    }
    finally {
      loadingMore.value = false
    }
  }

  /**
   * 斷線重連後的對帳（§9.5）。
   *
   * ⚠️ 這不是最佳化，是正確性。斷線期間的 SSE 事件是真的消失了，
   *    不會補送 —— 少一則訊息是最難重現、最難追查的一類 bug。
   */
  async function resync(): Promise<void> {
    if (!conversationId.value) return
    try {
      const res = await $fetch<MessagesResponse>('/api/messages', {
        query: {
          conversationId: conversationId.value,
          ...(lastMessageId.value ? { since: lastMessageId.value } : {}),
        },
      })
      merge(res.messages)
    }
    catch {
      // 對帳失敗不打斷工作流程（憲法 3.2）；下一次心跳或事件會再有機會
    }
  }

  // ── SSE ───────────────────────────────────────────────────────────

  function handle(evt: CopilotEvent): void {
    // ⚠️ 一條連線承載所有對話的事件，必須過濾
    if (!('conversationId' in evt) || evt.conversationId !== conversationId.value) return

    switch (evt.type) {
      case 'messages.appended':
        merge(evt.messages)
        /*
          ⚠️ 結案期間有新訊息**只標記過期，MUST NOT 自動重新產生摘要**（FR-020／FR-044）。
             自動重產會讓客服正在編輯的內容被無聲蓋掉，而且每一則新訊息都多跑一次 AI。
             「要不要把它納入摘要」是客服的決定，畫面上只提供那個提示。
        */
        if (evt.conversationId) closure.markStale(evt.conversationId)
        break
      case 'presence.updated':
        presence.value = evt.presence
        break
      case 'control.updated':
        // ⚠️ 以 server 為準，不用本地推測覆蓋（§10.6：mode 是共用狀態）
        control.value = evt.control
        // specs/003-analysis-trigger-policy T032a：順手重讀一次對話詳情，讓 viewerJoined 跟著翻轉
        void refreshViewerJoined()
        break
    }
  }

  /**
   * 重讀對話詳情，只為了把 `viewerJoined` 對齊伺服器 —— specs/003-analysis-trigger-policy T032a。
   *
   * ⚠️ **這是「同一位客服開兩個分頁、在其中一個按下離開」唯一會生效的路徑。**
   *    `leave` 只廣播 `control.updated`（服務模式），**不帶「你已退出」的資訊**；
   *    另一個分頁的 `viewerJoined` 因此永遠停在 `true`，它的心跳會持續回報「仍在 JOIN」
   *    → 對話層級的聚合永遠為真 → **分析根本不會停、面板也不會消失**，
   *    SC-002 與 SC-006 在此情境下失效（spec.md Edge Cases）。
   *
   * ⚠️ MUST NOT 為此新增推播事件欄位（Assumptions「不改對外契約」）——
   *    重讀一次既有的詳情端點就夠了，而 `control.updated` 本來就不是高頻事件。
   *
   * ⚠️ 失敗時靜默：這只是對齊，下一次事件或心跳還有機會（憲法 3.2）。
   */
  let refreshingJoined = false
  async function refreshViewerJoined(): Promise<void> {
    if (refreshingJoined || !conversationId.value) return
    refreshingJoined = true
    const target = conversationId.value
    try {
      const d = await $fetch<ConversationDetailResponse>(`/api/conversations/${target}`)
      // 期間可能已經切換對話 —— 別把舊對話的詳情蓋到新的上面
      if (target !== conversationId.value) return
      detail.value = d.conversation
      presence.value = d.presence
    }
    catch {
      // 靜默降級
    }
    finally {
      refreshingJoined = false
    }
  }

  // ── Presence 心跳（來源 ①）────────────────────────────────────────

  /**
   * @param state `away` 代表明確離開這個對話 —— 切走或關閉分頁時要送，
   *              否則同事會在畫面上看到一個「正在檢視」的幽靈直到 TTL 過期。
   */
  async function beat(state: 'viewing' | 'composing' | 'joined' | 'away'): Promise<void> {
    if (!conversationId.value || !stream.clientId) return
    try {
      await $fetch('/api/presence', {
        method: 'POST',
        body: {
          conversationId: conversationId.value,
          state,
          joined: viewerJoined.value,
          /*
            specs/006 FR-045（SHOULD）：讓同事看見「有人正在結案」。
            ⚠️ 它與 `state` 正交，因此每一次心跳都要帶對 —— 少帶就等於
               「結案期間打一個字，提示就閃掉」（見 `PresenceEntry.closing`）。
            ⚠️ 純提示、**不阻擋**：看到的人仍可回覆、仍可自行結案（憲法 3.3）。
          */
          closing: closure.isClosing(conversationId.value),
          visible: typeof document === 'undefined' || document.visibilityState === 'visible',
          clientId: stream.clientId,
        },
      })
    }
    catch {
      // presence 上報失敗只影響同事看到的畫面，不影響本人工作 —— 靜默降級
    }
  }

  // ── JOIN / LEAVE / 切換模式 ───────────────────────────────────────

  async function join(mode: 'manual' | 'hybrid' = 'manual'): Promise<void> {
    await act(async () => {
      const res = await $fetch<{ control: ConversationControl }>(
        `/api/conversations/${conversationId.value}/join`,
        { method: 'POST', body: { mode } },
      )
      control.value = res.control
      if (detail.value) detail.value.viewerJoined = true
      await beat('joined')
    })
  }

  /**
   * 「離開對話」—— 單純退出，不留下任何紀錄（FR-020、FR-021）。
   *
   * ⚠️ `beat('viewing')` **MUST 保留且 MUST 在 viewerJoined 翻成 false 之後送**：
   *    這一次心跳會帶著 `joined: false` 抵達控制通道 → `watch()` 判定為真實變化 → 重新
   *    attach → 該連線的訂閱者 `joined` 翻轉 → 對話層級聚合隨之翻轉 → 分析停止。
   *    全程一次往返，遠低於 SC-002 的 5 秒。**這就是 LEAVE 停止分析的整條路徑**
   *    （specs/003-analysis-trigger-policy 決策 4：不另開一條「LEAVE 專用的停止通道」，
   *    否則「分析要不要跑」會有兩個真相來源，而那正是本規格在修的根因形狀）。
   */
  async function leave(): Promise<void> {
    await act(async () => {
      const res = await $fetch<{ control: ConversationControl }>(
        `/api/conversations/${conversationId.value}/leave`,
        { method: 'POST' },
      )
      control.value = res.control
      if (detail.value) detail.value.viewerJoined = false
      await beat('viewing')
    })
  }

  /**
   * 「結案」—— **只開結案面板**，不 LEAVE、不停止分析、不隱藏面板
   * （specs/006-closure-handoff-summary FR-004、FR-005、FR-033、research #16）。
   *
   * ⚠️ **這是刻意獨立的程式碼路徑，MUST NOT 改寫成 `leave()` 的別名或某個參數值**
   *    （003 FR-022a）。兩者的差別現在是實質的：`leave()` 立刻退出、不留紀錄；
   *    這一支開始一段會寫進正式 CRM 的流程。
   *
   * ── 2026-09-04（006）：LEAVE 從這裡移到「寫入成功之後」 ──────────
   *
   *   舊版是「先 leave → 停止分析 → 隱藏面板」，那是 M2 的**階段性行為**。
   *   006 把停止分析與隱藏面板**兩件事都移到寫入成功後的 LEAVE**（`finishClosure()`）。
   *
   *   ⚠️ 這個改動讓 FR-005「結案期間分析照常執行、門檻維持 003 FR-012 的單一條件」
   *      **靠刪掉一行就自動成立** —— 客服仍是 JOIN 狀態，分析照常跑。
   *      因此 MUST NOT 為結案在 `server/services/copilot-analysis.ts` 新增
   *      第二個門檻條件（驗法：`grep -n "closing\|closure" server/services/copilot-analysis.ts`
   *      零結果）。
   *
   *   ⚠️ **MUST NOT 把「按下結案就自動產生並寫入」接回來**（憲法 5.1、FR-011）：
   *      中間那道人審是規則本身，不是流程裝飾。
   */
  async function closeConversation(): Promise<void> {
    if (!conversationId.value) return
    await closure.open(conversationId.value)
  }

  /** 取消結案 —— 回到「已接手」狀態，**不會留下任何紀錄**（FR-040） */
  function cancelClosing(): void {
    if (!conversationId.value) return
    closure.cancel(conversationId.value)
  }

  /**
   * 「一鍵寫入 CRM」成功之後才 LEAVE（FR-033）。
   *
   * ⚠️ **LEAVE 失敗 MUST NOT 回退結案**：紀錄已經在 CRM 上了，回退只會讓它變成孤兒。
   *    改為進入 `writtenLeaveFailed` —— 第 6 區塊消失、頂端出現一條可重試離開的橫幅
   *    （FR-047b、畫布 C1）。
   */
  async function finishClosure(): Promise<void> {
    const id = conversationId.value
    if (!id) return
    try {
      await leave()
      if (error.value) throw new Error(error.value)
      closure.finish(id)
    }
    catch (err) {
      closure.markLeaveFailed(id, messageOf(err))
    }
  }

  /** C1 橫幅的「重試離開」 */
  async function retryLeaveAfterClosure(): Promise<void> {
    await finishClosure()
  }

  async function setMode(mode: 'manual' | 'hybrid' | 'automation'): Promise<void> {
    await act(async () => {
      const res = await $fetch<{ control: ConversationControl }>(
        `/api/conversations/${conversationId.value}/mode`,
        { method: 'POST', body: { mode } },
      )
      control.value = res.control
    })
  }

  async function act(fn: () => Promise<void>): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await fn()
    }
    catch (err) {
      error.value = messageOf(err)
    }
    finally {
      busy.value = false
    }
  }

  // ── 送出（§10.4）──────────────────────────────────────────────────

  /**
   * @param force 客服看過撞單提示後仍選擇送出
   * @returns true 代表確實送出了 —— 呼叫端據此決定要不要清草稿
   */
  async function send(text: string, force = false): Promise<boolean> {
    if (!text.trim() || sending.value) return false
    sending.value = true
    sendError.value = null
    if (force) collision.value = null

    try {
      await $fetch('/api/messages', {
        method: 'POST',
        body: {
          conversationId: conversationId.value,
          text: text.trim(),
          // ⚠️ 必填。後端不接受「沒帶就跳過檢查」—— 靜默跳過會讓整層防線
          //    在某次前端重構後無聲失效
          baseMessageId: lastMessageId.value,
          force,
        },
      })
      collision.value = null
      return true
    }
    catch (err) {
      const data = (err as { data?: SendErrorData })?.data
      if (data?.reason === 'collision' && data.collision) {
        // ⚠️ 刻意阻斷使用者的三種情境之一（憲法 3.3①）。草稿保留不動。
        collision.value = data.collision
        if (data.control) control.value = data.control
      }
      else {
        sendError.value = messageOf(err)
        if (data?.control) control.value = data.control
      }
      return false
    }
    finally {
      sending.value = false
    }
  }

  function dismissCollision(): void {
    collision.value = null
  }

  // ── 生命週期 ──────────────────────────────────────────────────────

  let heartbeat: ReturnType<typeof setInterval> | undefined
  const offHandlers: Array<() => void> = []

  onMounted(() => {
    stream.connect()
    offHandlers.push(stream.on(handle))
    offHandlers.push(stream.onReconnected(() => void resync()))

    heartbeat = setInterval(() => void beat(viewerJoined.value ? 'joined' : 'viewing'), HEARTBEAT_MS)

    // ⚠️ 分頁切到背景時要立刻回報，第一層清單輪詢的頻率依此決定（§9.2）
    document.addEventListener('visibilitychange', onVisibility)
    // ⚠️ 關閉分頁時盡力送一次 away。不保證送達（瀏覽器可能直接砍掉請求），
    //    所以 server 端的 TTL 才是真正的保險 —— 這裡只是讓同事早一點看到。
    window.addEventListener('pagehide', onPageHide)
  })

  function onVisibility(): void {
    void beat(viewerJoined.value ? 'joined' : 'viewing')
  }

  function onPageHide(): void {
    if (!conversationId.value || !stream.clientId) return
    const body = JSON.stringify({
      conversationId: conversationId.value,
      state: 'away',
      joined: viewerJoined.value,
      /*
        ⚠️ 這裡帶的一定是 `false`：頁面正在卸載，而結案狀態是 tab-local 的
           —— 分頁一關它就不存在了（FR-040「重新整理等同取消」）。
           送 `closure.isClosing()` 的真值會在同事畫面上留下一個永遠不會消失的
           「正在結案」，直到 45 秒 TTL 過期為止，而那是一個不存在的人。
        ⚠️ **仍然要明寫**，不能省略：`reportViewing()` 會整筆覆寫條目，
           而省略欄位與送 false 在這一支剛好同義 —— 但下一個人看到「這裡沒帶」
           會以為是漏掉的（`joined` 就曾經因此被漏掉過）。
      */
      closing: false,
      visible: false,
      clientId: stream.clientId,
    })
    // sendBeacon 在頁面卸載時比 fetch 可靠
    navigator.sendBeacon?.('/api/presence', new Blob([body], { type: 'application/json' }))
  }

  onBeforeUnmount(() => {
    if (heartbeat) clearInterval(heartbeat)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    for (const off of offHandlers) off()
    void beat('away')
  })

  // 切換對話：先跟舊的說再見，再載入新的
  watch(conversationId, async (next, prev) => {
    if (prev && prev !== next) {
      // ⚠️ specs/002-suggestion-knowledge-search／contracts/presence-watch-control.md：
      //    joined 必須是離開前那一刻的真實值——寫死 false 會讓 server 端誤判為「已 LEAVE」，
      //    把仍然 JOIN 著的背景對話的 Copilot 管線整組卸載（research.md #8 的根因）。
      //    MUST 在下面的 loadAll() 覆蓋 detail 之前讀取，此刻它仍是「prev」那個對話的狀態。
      await $fetch('/api/presence', {
        method: 'POST',
        body: {
          conversationId: prev,
          state: 'away',
          joined: detail.value?.viewerJoined ?? false,
          // 切走時把「正在結案」一併帶對 —— 結案狀態是 tab-local 的，切走不等於取消
          closing: closure.isClosing(prev),
          visible: true,
          clientId: stream.clientId,
        },
      }).catch(() => {})
    }
    messages.value = []
    collision.value = null
    sendError.value = null
    await loadAll()
    await beat(viewerJoined.value ? 'joined' : 'viewing')
  }, { immediate: true })

  return {
    messages,
    detail,
    control,
    presence,
    loading,
    loadingMore,
    hasMore,
    error,
    sending,
    sendError,
    collision,
    busy,
    lastMessageId,
    viewerJoined,
    canSend,
    loadOlder,
    reload: loadAll,
    join,
    leave,
    /** ⚠️ 獨立於 `leave()` 的出口 —— 兩者的差異是實質的，MUST NOT 合併（003 FR-022a） */
    closeConversation,
    cancelClosing,
    finishClosure,
    retryLeaveAfterClosure,
    setMode,
    send,
    beat,
    dismissCollision,
  }
}

function messageOf(err: unknown): string {
  const e = err as { statusMessage?: string, data?: { message?: string }, message?: string }
  return e?.data?.message || e?.statusMessage || e?.message || '操作失敗'
}
