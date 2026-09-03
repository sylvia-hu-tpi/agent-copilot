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
import { CONNECTION_HEARTBEAT_MS } from '#shared/types/events'

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
 * 探測**沒有得到確定答案**時，要再累積幾次失敗才重問一次。
 *
 * ⚠️ **2026-09-03 修**：原本是「一輪斷線只探測一次」的一次性旗標，而旗標在**發動探測之前**
 *    就鎖上了。於是斷線當下若 server 正在重啟，探測拿到的是網路錯誤而非 401 →
 *    `probeSession()` 直接返回 → 閂永遠鎖著。等 server 起來、`/api/stream` 因 session
 *    已被清而回 401 時，`onerror` 雖然繼續累加失敗，**卻再也不會探測第二次** ——
 *    分頁無限重試（退避上限 30 秒）卻**永遠不會導去登入頁**，只能手動重新整理才脫困。
 *    2026-09-03 的 T058 手動驗收實際踩到：兩個分頁一起卡在「連線中斷，重新連線中…」。
 * ⚠️ 但「不要每次重試都打一發 `/api/auth/me`」是刻意的約束（`test/nuxt/stream-store.test.ts`
 *    有斷言），所以不是把閂拿掉，而是**改成會重新武裝的門檻**：問過一次而沒有定論，
 *    就往後推這麼多次失敗再問。退避上限 30 秒，因此穩定狀態下約每 90 秒才探測一次。
 */
export const SESSION_PROBE_RETRY_EVERY_FAILURES = 3

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
  /**
   * 連線層級的存活心跳（specs/005-m2-residual-defects FR-005a）。
   *
   * ⚠️ **刻意掛在這裡、不掛在 `useConversationView.ts`**：那支的 presence 心跳以「進入某個對話」
   *    為前提（body 必填 `conversationId`），分頁開著但還沒點進任何對話時完全不送 ——
   *    而那正是「憑證登記已存在、卻沒有任何心跳」的狀態。連線心跳必須與有沒有進入對話無關。
   *    兩支心跳回答的是不同問題，MUST NOT 合併。
   * ⚠️ 少了它，server 端的登記會在 45 秒後被 TTL 回收（FR-005a 的兜底），這個分頁就再也
   *    收不到新訊息而畫面一切正常 —— 正是 US1 要修的那個症狀。心跳失敗一律靜默：
   *    server 端的 upsert 會在下一拍把被剔除的登記重建回來。
   */
  let beatTimer: ReturnType<typeof setInterval> | undefined
  /** ⚠️ 已經連過至少一次 —— 用來區分「首次連線」與「重連」，只有後者要對帳 */
  let hasConnectedBefore = false
  /**
   * 下一次探測 session 的失敗次數門檻 —— 不必每次重試都打一次 `/api/auth/me`。
   * ⚠️ 探測沒有定論時會**往後推**（而不是從此不再問），見
   * `SESSION_PROBE_RETRY_EVERY_FAILURES` 的說明。
   */
  let nextProbeAtFailures = SESSION_PROBE_AFTER_FAILURES
  /** 探測進行中 —— 避免同一輪重試把探測疊著送 */
  let probeInFlight = false

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
      startBeat()
      // ⚠️ 首次連線不對帳：此時還沒有任何對話被開啟，也沒有 lastMessageId 可比對。
      //    對帳只在「曾經連上、斷掉、又接回來」時才有意義。
      if (hasConnectedBefore) {
        for (const h of [...reconnectedHandlers]) h()
      }
      hasConnectedBefore = true
      nextProbeAtFailures = SESSION_PROBE_AFTER_FAILURES
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

      // 斷線原因可能是 session 過期，而 onerror 分辨不出來 —— 主動確認
      if (failures.value >= nextProbeAtFailures && !probeInFlight) {
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
   * ⚠️ **但也不可因為問不出結果就從此不再問**（2026-09-03 修）：沒有定論時
   *    MUST 把門檻往後推、之後重問，否則「探測撞上 server 重啟」會讓分頁
   *    永久卡在重連中而永遠發現不了 401。見 `SESSION_PROBE_RETRY_EVERY_FAILURES`。
   */
  async function probeSession(): Promise<void> {
    probeInFlight = true
    try {
      await $fetch('/api/auth/me')
      // 200：session 還在，這次斷線與登入狀態無關 —— 但它之後仍可能過期，所以只是往後推
      nextProbeAtFailures = failures.value + SESSION_PROBE_RETRY_EVERY_FAILURES
    }
    catch (err) {
      const e = err as { statusCode?: number, response?: { status?: number } }
      const code = e?.statusCode ?? e?.response?.status
      if (code !== 401) {
        // 非 401：什麼都斷定不了。MUST NOT 登出，但 MUST 保留之後重問的機會
        nextProbeAtFailures = failures.value + SESSION_PROBE_RETRY_EVERY_FAILURES
        return
      }

      disconnect()
      useAuthStore().invalidate()
      await navigateTo('/login')
    }
    finally {
      probeInFlight = false
    }
  }

  function scheduleReconnect(): void {
    if (retryTimer) clearTimeout(retryTimer)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (failures.value - 1), RECONNECT_MAX_MS)
    retryTimer = setTimeout(connect, delay)
  }

  /** 每 `CONNECTION_HEARTBEAT_MS` 告訴 server「這條連線還在」—— 見 `beatTimer` 的說明 */
  function startBeat(): void {
    stopBeat()
    beatTimer = setInterval(() => {
      void $fetch('/api/connection/beat', {
        method: 'POST',
        body: { clientId: clientId.value },
      }).catch(() => {
        // 心跳失敗只代表這一拍沒送到；下一拍的 upsert 會把登記補回來。不打擾使用者。
      })
    }, CONNECTION_HEARTBEAT_MS)
  }

  function stopBeat(): void {
    if (beatTimer) clearInterval(beatTimer)
    beatTimer = undefined
  }

  function teardownSource(): void {
    stopBeat()
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
    nextProbeAtFailures = SESSION_PROBE_AFTER_FAILURES
    failures.value = 0
  }

  return { status, degraded, clientId, failures, connect, disconnect, on, onReconnected }
})
