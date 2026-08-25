/**
 * `realtime-http.ts` 的骨架 —— 對「已建置的 Nitro 伺服器」跑真實 HTTP 與 SSE。
 *
 * ⚠️ **`smoke-http.ts` 刻意不用這一份**，即使兩者的 spawn 與等待就緒長得幾乎一樣。
 *    那支是 M0／M1 的驗收基準，已經通過、而且會被當成「壞掉時的對照組」——
 *    讓它依賴一個為了新測試而長出來的抽象，等於把兩支的命運綁在一起：
 *    改這裡的參數會同時改掉那支驗的東西，而那正是驗收腳本最不該有的性質。
 *    重複的約 35 行是**刻意付出的代價**，不是還沒重構完。
 *
 * ⚠️ 因此本檔只長 `realtime-http.ts` 真正用得到的東西。
 *    不要為了「將來也許有人要」而先加介面 —— 沒有第二個呼叫端來校準，
 *    多出來的每一個方法都只是猜測。
 *
 * ⚠️ **每個 HttpClient 有自己的 cookie jar。** §18 M1 的兩項驗收都是
 *    「A 做了什麼、B 看到什麼」—— 共用一份 cookie 的話兩邊會是同一個 session，
 *    而那正好會讓 presence 自我排除、撞單的 sameOperator 過濾全部測成「正確」。
 *
 * ⚠️ **SSE 用 fetch 手動解析，不用 EventSource。** Node 沒有 EventSource，
 *    而且我方本來就刻意不依賴它內建的重連（見 `app/stores/stream.ts` 檔頭）——
 *    這裡要能精準控制「什麼時候斷、什麼時候接回來」，內建重連反而礙事。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import type { CopilotEvent } from '../shared/types/events.js'
import { startMockGateway, type MockGateway, type MockGatewayOptions } from './mock-gateway.js'

const ROOT = resolve(import.meta.dirname, '..')

export interface HttpResponse {
  status: number
  body: string
}

/** 收到一則 SSE 事件的時刻 —— 「4 秒內看到」量的就是這個 */
export interface ReceivedEvent {
  at: number
  event: CopilotEvent
}

export interface StreamClient {
  clientId: string
  received: ReceivedEvent[]
  /** 目前已收到幾則 —— 之後的 `waitFor` 從這裡往後找，才不會比對到舊事件 */
  cursor(): number
  waitFor(
    predicate: (evt: CopilotEvent) => boolean,
    opts?: { since?: number, timeoutMs?: number, label?: string },
  ): Promise<ReceivedEvent>
  /** 模擬斷線。⚠️ 真的關掉 socket，伺服器端的 `onClosed` 清理也會被跑到 */
  close(): void
}

export interface HttpClient {
  call(path: string, init?: RequestInit): Promise<HttpResponse>
  /** 三段式登入 + 選組織，走完之後 session 是 active */
  signIn(email: string, organizationId?: string): Promise<void>
  openStream(clientId: string): Promise<StreamClient>
}

export interface NitroHarness {
  baseUrl: string
  gateway: MockGateway
  /** 開一個獨立 cookie jar 的用戶端 —— 一個 jar 等於一位客服的一個瀏覽器 */
  client(): HttpClient
  close(): Promise<void>
}

export async function startNitro(
  opts: { port?: number, gateway?: MockGatewayOptions } = {},
): Promise<NitroHarness> {
  const gateway = await startMockGateway(opts.gateway)
  // ⚠️ 預設不是 3123 —— 那個埠屬於 `smoke-http.ts`。
  //    兩支現在各自 spawn，`npm run smoke` 是接連跑的，撞埠只會得到
  //    「伺服器在 30000ms 內未就緒」這種完全指不出原因的錯誤訊息。
  const port = opts.port ?? 3124
  const baseUrl = `http://127.0.0.1:${port}`

  let server: ChildProcess | undefined
  try {
    server = spawn(process.execPath, ['.output/server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_SESSION_SECRET: 'smoke-test-secret',
        NUXT_IMBRACE_BASE_URL: gateway.baseUrl,
        NUXT_PUBLIC_IMBRACE_ENV: 'stable',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stderr?.on('data', d => process.stderr.write(`[server] ${d}`))

    await waitForServer(baseUrl)
  }
  catch (err) {
    server?.kill()
    await gateway.close()
    throw err
  }

  const streams: StreamClient[] = []

  return {
    baseUrl,
    gateway,
    client: () => createClient(baseUrl, streams),
    close: async () => {
      for (const s of streams) s.close()
      server?.kill()
      await gateway.close()
    },
  }
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) return
    }
    catch {
      // 尚未啟動，繼續等
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`伺服器在 ${timeoutMs}ms 內未就緒`)
}

function createClient(baseUrl: string, streams: StreamClient[]): HttpClient {
  /**
   * cookie jar：手動維護而不用共享的 fetch。
   * ⚠️ 這正是「兩位客服」的分界 —— 每個 client 一個 jar，兩邊才是不同的 session。
   */
  let cookie = ''

  async function call(path: string, init: RequestInit = {}): Promise<HttpResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
    })
    const first = (res.headers.getSetCookie?.() ?? [])[0]
    if (first) cookie = first.split(';')[0] ?? cookie
    const body = await res.text()
    return { status: res.status, body }
  }

  async function signIn(email: string, organizationId = 'org_a'): Promise<void> {
    const post = async (path: string, payload: unknown) => {
      const res = await call(path, { method: 'POST', body: JSON.stringify(payload) })
      if (res.status !== 200) throw new Error(`${path} 回 ${res.status}：${res.body}`)
      return res
    }
    await post('/api/auth/otp', { email })
    await post('/api/auth/login', { email, otp: '123456' })
    await post('/api/auth/organization', { organizationId })
  }

  async function openStream(clientId: string): Promise<StreamClient> {
    const stream = await connectStream(baseUrl, cookie, clientId)
    streams.push(stream)
    return stream
  }

  return { call, signIn, openStream }
}

interface Waiter {
  predicate: (evt: CopilotEvent) => boolean
  resolve: (received: ReceivedEvent) => void
}

async function connectStream(
  baseUrl: string,
  cookie: string,
  clientId: string,
): Promise<StreamClient> {
  const controller = new AbortController()
  const res = await fetch(`${baseUrl}/api/stream?clientId=${encodeURIComponent(clientId)}`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (!res.ok || !res.body) throw new Error(`SSE 連線失敗：${res.status}`)

  const received: ReceivedEvent[] = []
  const waiters = new Set<Waiter>()
  let closed = false

  function deliver(event: CopilotEvent): void {
    const item: ReceivedEvent = { at: Date.now(), event }
    received.push(item)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue
      waiters.delete(waiter)
      waiter.resolve(item)
    }
  }

  void (async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 以空行分隔訊息
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const data = frame
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .join('\n')
          if (data) {
            try {
              deliver(JSON.parse(data) as CopilotEvent)
            }
            catch {
              // 壞掉的一則不該讓整條連線失效（與前端 store 同一個處理方式）
            }
          }
          sep = buffer.indexOf('\n\n')
        }
      }
    }
    catch {
      // abort 或伺服器關閉 —— 兩者在這裡都只代表「這條連線結束了」
    }
  })()

  return {
    clientId,
    received,
    cursor: () => received.length,
    waitFor: (predicate, options = {}) => {
      const { since = 0, timeoutMs = 15_000, label = '事件' } = options
      // ⚠️ 先掃已收到的：等待與事件抵達之間有空隙，只掛 waiter 會漏掉剛到的那一則
      const already = received.slice(since).find(r => predicate(r.event))
      if (already) return Promise.resolve(already)
      if (closed) return Promise.reject(new Error(`連線已關閉，等不到${label}`))

      return new Promise<ReceivedEvent>((resolvePromise, reject) => {
        let timer: NodeJS.Timeout | undefined
        const waiter: Waiter = {
          predicate,
          resolve: (item) => {
            clearTimeout(timer)
            resolvePromise(item)
          },
        }
        waiters.add(waiter)
        timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`等待${label}逾時（${timeoutMs}ms）`))
        }, timeoutMs)
      })
    },
    close: () => {
      if (closed) return
      closed = true
      controller.abort()
    },
  }
}
