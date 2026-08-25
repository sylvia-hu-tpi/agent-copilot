/**
 * 假的 iMBrace gateway —— 讓登入流程能在沒有真實憑證、沒有網路的情況下跑整合測試。
 *
 * ⚠️ 為何不 mock @imbrace/sdk：§5.1 的三個坑全都發生在「SDK 實際打出什麼請求」這一層
 * （token 有沒有被存起來、x-organization-id 有沒有帶上、refresh_token 有沒有被丟掉）。
 * 把 SDK 換成假的，等於把要測的東西整個測掉了。
 * 因此這裡假的是「伺服器」，SDK 用真的 —— client factory 本來就支援 baseUrl 覆寫。
 *
 * 路徑取自 @imbrace/sdk@1.4.0：
 *   {baseUrl}/platform/v1/login/_signin_email_request
 *   {baseUrl}/platform/v1/login/authenticate
 *   {baseUrl}/platform/v1/access/_exchange_access_token
 *
 * ── M1 新增（形狀全部照 `npm run spike:write` 的實測結果）───────────
 *   {baseUrl}/channel-service/v1/team_conversations/{id}   詳情（回 tcu_ / mode / is_joined / users）
 *   {baseUrl}/channel-service/v1/team_conversations/_join  JOIN 與切換 mode（同一支端點）
 *   {baseUrl}/channel-service/v1/team_conversations/_leave
 *   {baseUrl}/channel-service/v1/conversation_messages     取訊息（由新到舊）／送訊息
 *
 * ⚠️ 詳情回的 `id` 是 `tcu_` 而 `conversation_id` 是 `conv_` —— 這個「同一個對話
 *    有三種識別碼」的形狀必須忠實重現，否則測不到 §9.3 那一整類靜默失準的 bug。
 *
 * ⚠️ 訊息**由新到舊**排序（實測確認）。若這裡寫成由舊到新，
 *    `fetchLatest()` 的 `.reverse()` 就會被測成「正確」，而實際上是反的。
 */

import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | undefined>
  body: unknown
}

export interface MockGateway {
  baseUrl: string
  requests: RecordedRequest[]
  /** 取出打到某路徑的最後一筆請求，供斷言標頭與 body */
  lastRequestTo(pathSuffix: string): RecordedRequest | undefined
  /**
   * 在對話中插入一則訊息 —— 模擬「同事或 AI 搶先回覆」。
   * §10.4 的撞單檢查沒有這個就測不出來。
   */
  pushMessage(from: string, text: string): { id: string }
  /** 目前的服務模式（JOIN／切換後會變）*/
  currentMode(): string | null
  /** 已送出的訊息（驗證送出路徑真的打到平台）*/
  sentMessages(): Array<Record<string, unknown>>
  close(): Promise<void>
}

export interface MockGatewayOptions {
  /** authenticate 回傳的組織清單 */
  organizations?: Array<Record<string, unknown>>
  /** exchange 是否回傳 refresh_token（用來驗證 F-2 與 §5.1 ③） */
  withRefreshToken?: boolean
  /** 指定路徑要回傳的 HTTP 狀態碼，用來測失敗路徑。
   *  ⚠️ 不要用 5xx／429：SDK 會自動指數退避重試（1s→2s→4s），測試會逾時。 */
  failWith?: Record<string, number>
  /** authenticate 回 200 但不帶 token —— 測防腐層有沒有把這種「假成功」擋下來 */
  omitLoginToken?: boolean
  /** 對話的初始服務模式（§10.6）。`null` 代表從未 JOIN */
  mode?: 'manual' | 'hybrid' | 'automation' | null
}

const DEFAULT_ORGS = [
  { organization_id: 'org_a', display_name: '客服一部', role: 'admin', is_admin: false },
  { organization_id: 'org_b', display_name: '客服二部', role: 'member', is_admin: false },
]

/** 探測用對話。⚠️ 三種識別碼刻意設成互相對得起來但字串不同（§9.3）*/
const CONV_BARE = '68e39cf1-68df-47a0-9e68-6e19c72eff8a'
const CONV_PREFIXED = `conv_${CONV_BARE}`
const TCU_ID = 'tcu_042cae1b-8833-4580-be7e-54f03289ae41'

export async function startMockGateway(opts: MockGatewayOptions = {}): Promise<MockGateway> {
  const requests: RecordedRequest[] = []
  const fail = opts.failWith ?? {}

  // ── 可變的對話狀態 ────────────────────────────────────────────
  let mode: string | null = opts.mode ?? null
  let seq = 0
  const sent: Array<Record<string, unknown>> = []

  /** ⚠️ 由舊到新存放，回應時才反轉 —— 平台實測是由新到舊回傳 */
  const messages: Array<Record<string, unknown>> = []

  function addMessage(from: string, text: string): { id: string } {
    const id = `msg_${++seq}`
    messages.push({
      id,
      conversation_id: CONV_PREFIXED,
      from,
      type: 'text',
      content: { text },
      created_at: new Date(Date.UTC(2026, 7, 25, 0, seq, 0)).toISOString(),
    })
    return { id }
  }

  addMessage('con_1', '你好，我的訂單還沒到')
  addMessage('pub_bot', '您好，我幫您查詢一下')

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = req.url ?? ''

      requests.push({
        method: req.method ?? '',
        path,
        headers: req.headers as Record<string, string | undefined>,
        body: raw ? JSON.parse(raw) : undefined,
      })

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      const failStatus = Object.entries(fail).find(([suffix]) => path.endsWith(suffix))?.[1]
      if (failStatus) return send(failStatus, { message: 'mock failure' })

      if (path.endsWith('/login/_signin_email_request')) {
        return send(200, {})
      }

      if (path.endsWith('/login/authenticate')) {
        return send(200, {
          ...(opts.omitLoginToken ? {} : { accessToken: 'login_acc_TESTTOKEN' }),
          user_id: 'u_test_operator',
          display_name: '測試客服',
          organizations: opts.organizations ?? DEFAULT_ORGS,
        })
      }

      // channel-service：conversations.search 需要 bu id，bu id 由 channel.list 推導
      if (path.includes('/channel-service/v1/channels')) {
        return send(200, { data: [{ id: 'ch_1', bu_id: 'bu_test', name: 'LINE' }] })
      }

      if (path.includes('/team_conversations/_search')) {
        return send(200, {
          data: [{
            // ⚠️ 清單的 id 是**對話 id**（裸 UUID），沒有 tcu —— 這正是
            //    「從列表按 JOIN 必須先取一次詳情」的原因（§10.6 ②）
            id: CONV_BARE,
            channel_type: 'line',
            contact_id: 'con_1',
            status: 'open',
            name: 'TWN#GW4772',
            mode,
            // ⚠️ 清單 payload 的 users 實測為 null
            users: null,
            last_message_at: messages.at(-1)?.created_at,
            updated_at: new Date().toISOString(),
          }],
        })
      }

      // ── M1：對話詳情 ──────────────────────────────────────
      // ⚠️ 路徑參數同時接受對話 id 與 tcu id（實測確認），此處忠實重現
      const detailMatch = /\/team_conversations\/([^/?]+)$/.exec(path)
      if (req.method === 'GET' && detailMatch && !path.includes('_search')) {
        const id = decodeURIComponent(detailMatch[1] ?? '')
        const known = [CONV_BARE, CONV_PREFIXED, TCU_ID].includes(id)
        if (!known) return send(404, { message: 'conversation not found' })
        return send(200, {
          object_name: 'team_conversation',
          id: TCU_ID,
          _id: TCU_ID,
          conversation_id: CONV_PREFIXED,
          channel_type: 'line',
          contact_id: 'con_1',
          status: 'open',
          name: 'TWN#GW4772',
          mode,
          is_joined: mode === 'manual' || mode === 'hybrid',
          is_agent_joined: true,
          is_presence: false,
          // ⚠️ 團隊名冊，不是對話參與者（§10.2）—— 只當姓名對照表用
          users: [
            { id: 'u_test_operator', display_name: '測試客服', is_bot: false },
            { id: 'u_other', display_name: '李小華', is_bot: false },
            { id: 'u_bot', display_name: 'Bot', is_bot: true },
          ],
          updated_at: new Date().toISOString(),
        })
      }

      // ── M1：JOIN／切換 mode 是同一支端點（§10.6 實測）────────
      if (path.includes('/team_conversations/_join')) {
        const body = (requests.at(-1)?.body ?? {}) as { mode?: string }
        mode = body.mode ?? 'manual'
        return send(200, { success: true })
      }

      if (path.includes('/team_conversations/_leave')) {
        // ⚠️ LEAVE 後回到 automation —— 與「有人但選 Automation Only」同值
        mode = 'automation'
        return send(200, { success: true })
      }

      // ── M1：訊息 ─────────────────────────────────────────────
      if (path.includes('/conversation_messages')) {
        if (req.method === 'POST') {
          const body = (requests.at(-1)?.body ?? {}) as Record<string, unknown>
          // ⚠️ 平台對缺欄位的實際回應（實測）
          if (!body.conversation_id) return send(400, { code: 400, message: 'conversation_id required' })
          sent.push(body)
          const created = addMessage('u_test_operator', String(body.text ?? ''))
          return send(200, { id: created.id, conversation_id: CONV_PREFIXED })
        }

        const url = new URL(`http://x${path}`)
        if (!url.searchParams.get('conversation_id')) {
          return send(400, { code: 400, message: 'conversation_id required' })
        }
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const skip = Number(url.searchParams.get('skip') ?? 0)
        // ⚠️ 由新到舊 —— 這正是 limit=N 等於「最新 N 則」的原因
        const newestFirst = [...messages].reverse()
        return send(200, { data: newestFirst.slice(skip, skip + limit), total: messages.length })
      }

      if (path.endsWith('/access/_exchange_access_token')) {
        return send(200, {
          token: 'acc_TESTTOKEN',
          ...(opts.withRefreshToken === false ? {} : { refresh_token: 'refresh_TESTTOKEN' }),
        })
      }

      return send(404, { message: `mock gateway: 未實作的路徑 ${path}` })
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    lastRequestTo: (suffix: string) => [...requests].reverse().find(r => r.path.endsWith(suffix)),
    pushMessage: addMessage,
    currentMode: () => mode,
    sentMessages: () => sent,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}
