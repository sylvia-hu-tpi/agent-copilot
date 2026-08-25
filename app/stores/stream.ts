/**
 * SSE 連線 —— docs/ARCHITECTURE.md §9.5。
 *
 * **每個瀏覽器分頁只有一條連線**，所有對話共用。切換對話時不重連，
 * 改由 `POST /api/presence` 的控制通道動態增減訂閱
 * （理由見 `server/utils/stream-control.ts` 的檔頭）。
 *
 * ── 兩件不能省的事 ───────────────────────────────────────────────
 * ⚠️ ① **重連後必須對帳。** 斷線期間的事件是真的消失了，不會補送。
 *    §9.5 刻意不做事件重播緩衝（多副本下必然會漏），改由前端以自己的
 *    `lastMessageId` 回源頭重新拉取。因此本 store 在每次連上時發出
 *    `reconnected` 訊號，由 `useConversationView` 去對帳。
 *
 * ⚠️ ② **不能只依賴 EventSource 內建的自動重連。** 它的重試間隔固定且不可調，
 *    伺服器重啟或網路長時間中斷時會以固定頻率一直打，
 *    而且 401（session 過期）時會無限重試同一個必然失敗的請求。
 *    因此這裡自己關掉再依指數退避重開，並在連續失敗時把狀態攤給使用者看。
 */

import { defineStore } from 'pinia'
import type { CopilotEvent } from '#shared/types/events'

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting'

type Handler = (event: CopilotEvent) => void

/** 指數退避：1s → 2s → 4s → … → 30s（§15.2 降級表） */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * 連續失敗幾次後去確認「是不是根本被登出了」。
 *
 * ⚠️ 為何需要這一步：`EventSource.onerror` **拿不到 HTTP 狀態碼** ——
 *    網路斷線與 401（session 過期）在這裡長得一模一樣。
 *    不區分的話，session 過期會變成「無限重試一個必然失敗的請求」，
 *    而畫面上只顯示「連線中斷，重新連線中…」——
 *    **客服會以為是網路問題而一直等，實際上他早就被登出了。**
 *
 *    M1 手動驗收時，這個缺陷被 dev server 的 HMR 整頁重載掩蓋過去
 *    （重載會觸發路由守衛，守衛才發現 401）。生產環境沒有 HMR，
 *    那條路徑不存在，所以必須在這裡自己探測。
 */
const SESSION_PROBE_AFTER_FAILURES = 2

/**
 * 這個分頁的識別碼。
 *
 * ⚠️ 存在 `sessionStorage` 而非 `localStorage`：後者會讓同一個瀏覽器的
 *    兩個分頁共用同一個 id，於是 A 分頁的控制訊息會被送到 B 分頁的連線，
 *    「訂閱數歸零即停止輪詢」（憲法 6.1）就失去依據。
 */
function resolveClientId(): string {
  const KEY = 'ac.clientId'
  try {
    const existing = sessionStorage.getItem(KEY)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    sessionStorage.setItem(KEY, fresh)
    return fresh
  }
  catch {
    // 隱私模式下 sessionStorage 可能直接丟例外 —— 退回記憶體中的一次性 id
    return crypto.randomUUID()
  }
}

export const useStreamStore = defineStore('stream', () => {
  const status = ref<StreamStatus>('idle')
  const clientId = ref('')
  /** 連續失敗次數 —— 決定退避間隔，也決定要不要對使用者顯示警告 */
  const failures = ref(0)

  const handlers = new Set<Handler>()
  const reconnectedHandlers = new Set<() => void>()

  let source: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  /** ⚠️ 已經連過至少一次 —— 用來區分「首次連線」與「重連」，只有後者要對帳 */
  let hasConnectedBefore = false
  /** 這一輪斷線已經探測過 session，不必每次重試都打一次 /api/auth/me */
  let sessionProbed = false

  /** 即時更新是否可信。false 時 UI 必須明說畫面可能不是最新的（憲法 3.2） */
  const degraded = computed(() => status.value === 'reconnecting' && failures.value >= 2)

  function on(handler: Handler): () => void {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  /** 每次（重新）連上時觸發 —— 對帳的進入點 */
  function onReconnected(handler: () => void): () => void {
    reconnectedHandlers.add(handler)
    return () => reconnectedHandlers.delete(handler)
  }

  function connect(): void {
    if (source || import.meta.server) return
    if (!clientId.value) clientId.value = resolveClientId()

    status.value = hasConnectedBefore ? 'reconnecting' : 'connecting'
    const es = new EventSource(`/api/stream?clientId=${encodeURIComponent(clientId.value)}`)
    source = es

    es.onopen = () => {
      status.value = 'open'
      failures.value = 0
      // ⚠️ 首次連線不對帳：此時還沒有任何對話被開啟，也沒有 lastMessageId 可比對。
      //    對帳只在「曾經連上、斷掉、又接回來」時才有意義。
      if (hasConnectedBefore) {
        for (const h of [...reconnectedHandlers]) h()
      }
      hasConnectedBefore = true
      sessionProbed = false
    }

    es.onmessage = (raw: MessageEvent<string>) => {
      let evt: CopilotEvent
      try {
        evt = JSON.parse(raw.data) as CopilotEvent
      }
      catch {
        // 壞掉的一則事件不該讓整條連線失效
        return
      }
      // 心跳只是為了讓中間的 proxy 不要切線，沒有訂閱者需要它
      if (evt.type === 'stream.heartbeat') return
      for (const h of [...handlers]) {
        try {
          h(evt)
        }
        catch (err) {
          console.error('[stream] handler failed:', err)
        }
      }
    }

    es.onerror = () => {
      // ⚠️ 一律自己關掉再重開，不讓 EventSource 用它固定的間隔重試。
      teardownSource()
      failures.value++
      status.value = 'reconnecting'

      // 斷線原因可能是 session 過期，而 onerror 分辨不出來 —— 主動確認一次
      if (failures.value >= SESSION_PROBE_AFTER_FAILURES && !sessionProbed) {
        sessionProbed = true
        void probeSession()
      }

      scheduleReconnect()
    }
  }

  /**
   * 確認 session 還在不在。只有明確的 401 才動作 ——
   * 其他錯誤（含網路本身就不通）一律當成「還在斷線中」，繼續重試。
   *
   * ⚠️ 不可把「探測失敗」當成「已登出」：網路斷掉時這支請求本來就會失敗，
   *    那樣會把單純的網路抖動變成把客服踢出去，草稿與工作脈絡一起消失。
   */
  async function probeSession(): Promise<void> {
    try {
      await $fetch('/api/auth/me')
    }
    catch (err) {
      const e = err as { statusCode?: number, response?: { status?: number } }
      const code = e?.statusCode ?? e?.response?.status
      if (code !== 401) return

      disconnect()
      useAuthStore().invalidate()
      await navigateTo('/login')
    }
  }

  function scheduleReconnect(): void {
    if (retryTimer) clearTimeout(retryTimer)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (failures.value - 1), RECONNECT_MAX_MS)
    retryTimer = setTimeout(connect, delay)
  }

  function teardownSource(): void {
    if (!source) return
    source.onopen = null
    source.onmessage = null
    source.onerror = null
    source.close()
    source = null
  }

  function disconnect(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    teardownSource()
    status.value = 'idle'
    hasConnectedBefore = false
    sessionProbed = false
    failures.value = 0
  }

  return { status, degraded, clientId, failures, connect, disconnect, on, onReconnected }
})
