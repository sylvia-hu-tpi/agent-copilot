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
}

const DEFAULT_ORGS = [
  { organization_id: 'org_a', display_name: '客服一部', role: 'admin', is_admin: false },
  { organization_id: 'org_b', display_name: '客服二部', role: 'member', is_admin: false },
]

export async function startMockGateway(opts: MockGatewayOptions = {}): Promise<MockGateway> {
  const requests: RecordedRequest[] = []
  const fail = opts.failWith ?? {}

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
            id: 'conv_1',
            channel_type: 'line',
            contact_id: 'con_1',
            status: 'open',
            name: 'TWN#GW4772',
            users: [],
            timestamp: '2026-08-25T00:00:00.000Z',
          }],
        })
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}
