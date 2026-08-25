/**
 * OTP 三段式登入的整合測試 —— docs/ARCHITECTURE.md §5.1 / §7.1
 *
 * §5.1 的結語：「登入是唯一『不照著寫就整個系統起不來』的環節，
 * 且錯誤形態是 401 而非明確報錯，很難從症狀反推。M0 應優先把這段跑通並寫成整合測試。」
 *
 * 本檔用真實的 @imbrace/sdk 打向假 gateway，因此覆蓋到的是「SDK 實際送出什麼」：
 *  ① loginWithOtp 有沒有把 login_acc_ token 取出來（用 authenticate 會漏掉）
 *  ② exchange 前有沒有帶上 x-organization-id（沒帶會 401）
 *  ③ refresh_token 有沒有被保留（selectOrganization 會丟掉它）
 *
 * ⚠️ 未覆蓋：HTTP route handler 與 cookie 往返（那需要跑起整個 Nitro）。
 *    簽章與 session 生命週期改由 session.test.ts 覆蓋。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  anonymousClient,
  exchangeOrganizationToken,
  loginWithOtp,
} from '../server/services/imbrace.js'
import { startMockGateway, type MockGateway } from './mock-gateway.js'

let gateway: MockGateway | undefined

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
})

describe('② loginWithOtp', () => {
  it('把 login_acc_ token 與組織清單一次取回，不必再打 organizations.list()', async () => {
    gateway = await startMockGateway()
    const client = anonymousClient({ baseUrl: gateway.baseUrl })

    const result = await loginWithOtp(client, 'agent@example.com', '123456')

    expect(result.loginToken).toBe('login_acc_TESTTOKEN')
    expect(result.operatorId).toBe('u_test_operator')
    expect(result.operatorName).toBe('測試客服')
    expect(result.organizations).toEqual([
      { id: 'org_a', name: '客服一部', role: 'admin', isAdmin: false, status: undefined },
      { id: 'org_b', name: '客服二部', role: 'member', isAdmin: false, status: undefined },
    ])

    // 只打了 authenticate，沒有第二趟 organizations.list()
    const orgListCalls = gateway.requests.filter(r => r.path.includes('/organizations'))
    expect(orgListCalls).toHaveLength(0)
  })

  it('回應 200 但缺 token 時當場報錯，而不是讓第 ③ 步收到看不懂的 401', async () => {
    // ⚠️ 這是最惡劣的失敗形態：平台回 200，SDK 也不會抱怨，
    //    但 TokenManager 裡是空的 —— 錯誤要到下一個請求才以 401 浮現。
    gateway = await startMockGateway({ omitLoginToken: true })
    const client = anonymousClient({ baseUrl: gateway.baseUrl })

    await expect(loginWithOtp(client, 'agent@example.com', '123456'))
      .rejects.toThrow(/缺少 access token/)
  })
})

describe('③ exchangeOrganizationToken', () => {
  it('送出 exchange 前必須先帶上 x-organization-id', async () => {
    gateway = await startMockGateway()
    const client = anonymousClient({ baseUrl: gateway.baseUrl })
    await loginWithOtp(client, 'agent@example.com', '123456')

    await exchangeOrganizationToken(client, 'org_a')

    const req = gateway.lastRequestTo('/access/_exchange_access_token')
    // ⚠️ 這條斷言就是 §5.1 ② 的整個重點：少了這個 header 會 401，且症狀無法反推
    expect(req?.headers['x-organization-id']).toBe('org_a')
  })

  it('保留 refresh_token —— 這正是 client.selectOrganization() 會丟掉的東西', async () => {
    gateway = await startMockGateway()
    const client = anonymousClient({ baseUrl: gateway.baseUrl })
    await loginWithOtp(client, 'agent@example.com', '123456')

    const result = await exchangeOrganizationToken(client, 'org_a')

    expect(result.accessToken).toBe('acc_TESTTOKEN')
    expect(result.refreshToken).toBe('refresh_TESTTOKEN')
  })

  it('平台未回 refresh_token 時為 undefined，而不是空字串', async () => {
    gateway = await startMockGateway({ withRefreshToken: false })
    const client = anonymousClient({ baseUrl: gateway.baseUrl })
    await loginWithOtp(client, 'agent@example.com', '123456')

    const result = await exchangeOrganizationToken(client, 'org_a')

    expect(result.refreshToken).toBeUndefined()
  })

  it('SDK 內部結構變動時立刻炸開，而不是靜默送出沒有組織標頭的請求', async () => {
    gateway = await startMockGateway()
    const client = anonymousClient({ baseUrl: gateway.baseUrl })
    // 模擬 SDK 日後把 http 改名或移除
    Object.defineProperty(client, 'http', { value: {}, configurable: true })

    await expect(exchangeOrganizationToken(client, 'org_a'))
      .rejects.toThrow(/內部結構已變更/)
  })
})

describe('① requestOtp', () => {
  it('打到 _signin_email_request，且 body 只帶 email', async () => {
    gateway = await startMockGateway()
    const client = anonymousClient({ baseUrl: gateway.baseUrl })

    await client.requestOtp('agent@example.com')

    const req = gateway.lastRequestTo('/login/_signin_email_request')
    expect(req?.method).toBe('POST')
    expect(req?.body).toEqual({ email: 'agent@example.com' })
  })
})
