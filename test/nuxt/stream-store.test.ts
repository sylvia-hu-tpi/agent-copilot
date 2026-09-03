/**
 * SSE 自動重連 —— 對**真正的** `app/stores/stream.ts` 驗，不是對重寫的複本。
 *
 * §18 M1 驗收「SSE 斷線後能自動重連並補齊斷線期間的訊息」拆成兩半：
 *   ├─ 伺服器端能不能補齊（`GET /api/messages?since=`）→ `test/realtime-http.ts`
 *   └─ 前端斷線後會不會重連、重連後會不會去對帳 → **這一支**
 *
 * ⚠️ 為何不 mock 這個 store：要驗的東西全都在它裡面 ——
 *    「首次連線不對帳、重連才對帳」「退避間隔」「401 與斷網要分開處理」。
 *    寫一份簡化版來測，等於把要測的東西整個測掉（與 `mock-gateway.ts` 同一個理由）。
 *
 * ⚠️ Nuxt 的 auto-import 是編譯期轉換，vitest 下不存在 ——
 *    因此 `ref` / `computed` / `$fetch` / `navigateTo` / `useAuthStore`
 *    以 global 注入。這是 store 在真實執行環境中拿到它們的同一種方式（全域自由變數）。
 *
 * ⚠️ **本檔必須放在 `test/nuxt/`**，那是 Nuxt 預留的目錄：`.nuxt/tsconfig.app.json`
 *    的 include 已經有 `../test/nuxt/` 這一條，因此 `nuxt typecheck` 會用**真正的**
 *    auto-import 與 DOM 型別檢查它。搬到 `test/` 底下就會落到 Node 環境的
 *    `tsconfig.scripts.json`，那裡沒有 `EventSource` 也沒有 `ref`，必紅。
 */

import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 假的 EventSource ────────────────────────────────────────────────────
// 只實作 store 真正用到的表面：onopen / onmessage / onerror / close。
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static reset(): void {
    FakeEventSource.instances = []
  }

  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1)
    if (!last) throw new Error('尚未建立任何 EventSource')
    return last
  }

  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  /** 伺服器接受了連線 */
  open(): void {
    this.onopen?.()
  }

  /** 連線斷了。⚠️ 瀏覽器在這裡拿不到 HTTP 狀態碼 —— 斷網與 401 長得一模一樣 */
  fail(): void {
    this.onerror?.()
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data })
  }
}

const fetchMock = vi.fn<(path: string) => Promise<unknown>>()
const navigateToMock = vi.fn()
const invalidateMock = vi.fn()

let useStreamStore: typeof import('../../app/stores/stream.js')['useStreamStore']
/** ⚠️ 從 store 匯入而非在測試裡抄一份 —— 常數改了測試才會跟著改 */
let SESSION_PROBE_RETRY_EVERY_FAILURES: number

beforeEach(async () => {
  FakeEventSource.reset()
  fetchMock.mockReset().mockResolvedValue({})
  navigateToMock.mockReset()
  invalidateMock.mockReset()

  const storage = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  })
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('navigateTo', navigateToMock)
  vi.stubGlobal('useAuthStore', () => ({ invalidate: invalidateMock }))

  vi.useFakeTimers()
  setActivePinia(createPinia())

  // ⚠️ 動態載入：stubGlobal 必須在 module 求值前生效
  ;({ useStreamStore, SESSION_PROBE_RETRY_EVERY_FAILURES } = await import('../../app/stores/stream.js'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SSE 連線與自動重連（§9.5 / §18 M1）', () => {
  it('連上時帶著自己的 clientId —— 少了它控制訊息會廣播給該客服的所有分頁', () => {
    const store = useStreamStore()
    store.connect()

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(store.status).toBe('connecting')
    expect(FakeEventSource.latest.url).toContain('/api/stream?clientId=')
    expect(store.clientId).not.toBe('')
    expect(FakeEventSource.latest.url).toContain(encodeURIComponent(store.clientId))
  })

  it('重複呼叫 connect() 不會開出第二條連線', () => {
    const store = useStreamStore()
    store.connect()
    store.connect()

    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('⚠️ 首次連上不觸發對帳 —— 此時還沒有任何 lastMessageId 可比對', () => {
    const store = useStreamStore()
    const onResync = vi.fn()
    store.onReconnected(onResync)

    store.connect()
    FakeEventSource.latest.open()

    expect(store.status).toBe('open')
    expect(onResync).not.toHaveBeenCalled()
  })

  it('斷線 → 自動重連 → 重連上時才觸發對帳（這是補齊漏訊的唯一入口）', async () => {
    const store = useStreamStore()
    const onResync = vi.fn()
    store.onReconnected(onResync)

    store.connect()
    FakeEventSource.latest.open()
    FakeEventSource.latest.fail()

    expect(store.status).toBe('reconnecting')
    expect(store.failures).toBe(1)
    // 斷掉的那條要確實關閉，不留給 EventSource 自己用固定間隔重試
    expect(FakeEventSource.instances[0]?.closed).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeEventSource.instances).toHaveLength(2)

    FakeEventSource.latest.open()
    expect(store.status).toBe('open')
    expect(store.failures).toBe(0)
    expect(onResync).toHaveBeenCalledTimes(1)
  })

  it('退避是指數的且有上限 —— 伺服器重啟期間不可用固定頻率猛打', async () => {
    const store = useStreamStore()
    store.connect()
    FakeEventSource.latest.open()

    const delays: number[] = []
    for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = FakeEventSource.instances.length
      FakeEventSource.latest.fail()

      // 差一毫秒都還不該重連
      await vi.advanceTimersByTimeAsync(expected - 1)
      expect(FakeEventSource.instances).toHaveLength(before)

      await vi.advanceTimersByTimeAsync(1)
      expect(FakeEventSource.instances).toHaveLength(before + 1)
      delays.push(expected)
    }

    expect(delays.at(-1)).toBe(30_000)
  })

  it('連續失敗時把「即時更新不可信」攤給使用者看（憲法 3.2）', async () => {
    const store = useStreamStore()
    store.connect()
    FakeEventSource.latest.open()

    FakeEventSource.latest.fail()
    expect(store.degraded).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    FakeEventSource.latest.fail()
    expect(store.degraded).toBe(true)
  })

  it('⚠️ 連續失敗後主動探測 session —— 401 與斷網在 onerror 裡分不出來', async () => {
    fetchMock.mockRejectedValue({ statusCode: 401 })

    const store = useStreamStore()
    store.connect()
    FakeEventSource.latest.open()

    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).not.toHaveBeenCalled()

    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me')
    expect(invalidateMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(store.status).toBe('idle')
  })

  it('⚠️ 探測失敗但不是 401 時不得登出 —— 那只是網路還沒通', async () => {
    fetchMock.mockRejectedValue({ statusCode: 503 })

    const store = useStreamStore()
    store.connect()
    FakeEventSource.latest.open()

    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(1_000)
    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(0)

    expect(navigateToMock).not.toHaveBeenCalled()
    expect(store.status).toBe('reconnecting')

    // 門檻重新到期前不重問，不要每次重試都打一發（重新武裝由下一條測試守）
    await vi.advanceTimersByTimeAsync(2_000)
    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ 這一條與上一條是**一對夾擊條件**，MUST 同時存在。
   *
   * 只有上一條時，「探測一次就永遠不再問」的實作會通過測試 —— 而那正是
   * 2026-09-03 T058 手動驗收踩到的缺陷：斷線當下 server 正在重啟，探測拿到的是
   * 網路錯誤而非 401，一次性旗標就此鎖死；等 server 起來、`/api/stream` 因 session
   * 已被清而回 401 時，分頁**永遠不會再探測**，於是無限重試卻不導去登入頁，
   * 畫面停在「連線中斷，重新連線中…」直到使用者自己重新整理。
   *
   * 壞掉時紅的是最後那兩行：`navigateTo` 不會被呼叫。
   */
  it('⚠️ 探測沒有定論後 MUST 重新武裝 —— 稍後真的 401 時仍要發現得了（不可從此不再問）', async () => {
    // 第一次探測撞上 server 重啟：拿到的是網路錯誤，不是 401
    fetchMock.mockRejectedValue({ statusCode: 503 })

    const store = useStreamStore()
    store.connect()
    FakeEventSource.latest.open()

    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(1_000)
    FakeEventSource.latest.fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).not.toHaveBeenCalled()

    // server 起來了，但 session 已隨重啟被清掉 —— 之後每一次 /api/stream 都是 401
    fetchMock.mockRejectedValue({ statusCode: 401 })

    // 繼續斷線重試，直到門檻重新到期
    for (let i = 0; i < SESSION_PROBE_RETRY_EVERY_FAILURES; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
      FakeEventSource.latest.fail()
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    expect(invalidateMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith('/login')
  })

  it('disconnect() 之後不再重連，且下一次 connect() 視同首次（不對帳）', async () => {
    const store = useStreamStore()
    const onResync = vi.fn()
    store.onReconnected(onResync)

    store.connect()
    FakeEventSource.latest.open()
    store.disconnect()

    expect(store.status).toBe('idle')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)

    store.connect()
    FakeEventSource.latest.open()
    expect(onResync).not.toHaveBeenCalled()
  })
})

describe('事件轉發', () => {
  it('心跳不轉給訂閱者 —— 它只是為了讓中間的 proxy 不要切線', () => {
    const store = useStreamStore()
    const handler = vi.fn()
    store.on(handler)
    store.connect()
    FakeEventSource.latest.open()

    FakeEventSource.latest.emit({ type: 'stream.heartbeat', at: '2026-08-25T00:00:00Z' })
    expect(handler).not.toHaveBeenCalled()

    const appended = { type: 'messages.appended', conversationId: 'c1', messages: [] }
    FakeEventSource.latest.emit(appended)
    expect(handler).toHaveBeenCalledWith(appended)
  })

  it('壞掉的一則事件不會讓整條連線失效', () => {
    const store = useStreamStore()
    const handler = vi.fn()
    store.on(handler)
    store.connect()
    FakeEventSource.latest.open()

    FakeEventSource.latest.emitRaw('{ 這不是 JSON')
    FakeEventSource.latest.emit({ type: 'control.updated', conversationId: 'c1' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(store.status).toBe('open')
  })

  it('單一訂閱者拋錯不影響其他訂閱者', () => {
    const store = useStreamStore()
    const boom = vi.fn(() => {
      throw new Error('壞掉的 handler')
    })
    const ok = vi.fn()
    store.on(boom)
    store.on(ok)
    store.connect()
    FakeEventSource.latest.open()

    vi.spyOn(console, 'error').mockImplementation(() => {})
    FakeEventSource.latest.emit({ type: 'control.updated', conversationId: 'c1' })

    expect(boom).toHaveBeenCalled()
    expect(ok).toHaveBeenCalled()
  })
})
