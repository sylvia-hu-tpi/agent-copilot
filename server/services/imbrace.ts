/**
 * iMBrace SDK client factory（docs/ARCHITECTURE.md §7.3）。
 *
 * ⚠️ 憲法第 1 條：`server/` 以外的任何地方不得 import 此檔或 @imbrace/sdk。
 * ⚠️ 不要建立全域單例 client —— 每位客服的操作必須以自己的身分執行，
 *    否則 join() 與訊息送出的歸屬會全部錯亂，稽核軌跡失去意義。
 */

import { ImbraceClient } from '@imbrace/sdk'
import type { Environment } from '@imbrace/sdk'
import type { OrganizationChoice } from '../../shared/types/auth.js'

export interface SessionCredentials {
  accessToken: string
  organizationId?: string
}

export interface ClientOptions {
  env?: Environment
  /** 直接指定 gateway URL，覆寫 env 的預設對應（iMBrace 有時直接給 URL 而非環境名） */
  baseUrl?: string
  timeout?: number
}

/** 以個別客服的 session token 建立 client —— 正式流程走這支 */
export function clientForSession(
  session: SessionCredentials,
  opts: ClientOptions = {},
): ImbraceClient {
  return new ImbraceClient({
    accessToken: session.accessToken,
    organizationId: session.organizationId,
    env: opts.env ?? 'stable',
    baseUrl: opts.baseUrl,
    timeout: opts.timeout,
  })
}

/**
 * 以 API Key 建立 client（server-to-server，非個別客服身分）。
 * 僅用於不需歸屬到特定客服的背景作業，例如 Data Board schema setup script。
 */
export function clientForApiKey(
  apiKey: string,
  opts: ClientOptions & { organizationId?: string } = {},
): ImbraceClient {
  return new ImbraceClient({
    apiKey,
    organizationId: opts.organizationId,
    env: opts.env ?? 'stable',
    baseUrl: opts.baseUrl,
    timeout: opts.timeout,
  })
}

/** 未認證 client —— 只用於登入流程本身（requestOtp / authenticate） */
export function anonymousClient(opts: ClientOptions = {}): ImbraceClient {
  return new ImbraceClient({
    env: opts.env ?? 'stable',
    baseUrl: opts.baseUrl,
    timeout: opts.timeout,
  })
}

// ── 登入流程的防腐層（docs/ARCHITECTURE.md §5.1 / §7.1）────────────────
//
// ⚠️ 本區塊存在的理由：SDK 的登入 API 有三個不照著寫就整個系統起不來的坑，
//    而錯誤形態是 401 而非明確報錯，很難從症狀反推。把它們全部關在這裡，
//    route handler 只看得到乾淨的函式。
//
// ⚠️ 本檔被 scripts/spike 以 tsx 直接 import，**不得**使用 Nitro auto-import
//    （useRuntimeConfig / createError 等）。此處只丟原生 Error。

/** loginWithOtp 的原始回傳形狀（SDK 型別是 Record<string, unknown>，此處補回實際形狀） */
interface RawLoginResponse {
  /** SDK 依序找 accessToken / token / access_token，三者擇一存在 */
  accessToken?: string
  token?: string
  access_token?: string
  user_id?: string
  userId?: string
  display_name?: string
  name?: string
  organizations?: Array<{
    organization_id: string
    display_name: string
    role?: string
    is_admin?: boolean
    status?: string
  }>
}

export interface LoginResult {
  operatorId: string
  operatorName: string
  /**
   * `login_acc_` 前綴的中間 token。
   *
   * ⚠️ SDK 只把它存進 private 的 TokenManager，沒有公開 getter，
   *    但 loginWithOtp 會把原始回應整包 spread 出來 —— 這是唯一取得它的途徑。
   *    必須存進 BFF session：第 ③ 步是另一個 HTTP 請求，屆時 client 已重建，
   *    TokenManager 裡什麼都沒有（§5.1 ①）。
   */
  loginToken: string
  organizations: OrganizationChoice[]
}

/**
 * 第 ② 步：驗證 OTP。
 *
 * ⚠️ 必須用 `client.loginWithOtp()`，不可用 `client.auth.authenticate()` ——
 *    後者只回傳資料、不會把 token 存進 TokenManager，
 *    導致第 ③ 步的 exchange 等於未認證而 401。
 */
export async function loginWithOtp(
  client: ImbraceClient,
  email: string,
  otp: string,
): Promise<LoginResult> {
  const raw = await client.loginWithOtp(email, otp) as RawLoginResponse

  const operatorId = raw.user_id ?? raw.userId
  if (!operatorId) throw new Error('登入回應缺少 user_id')

  const loginToken = raw.accessToken ?? raw.token ?? raw.access_token
  if (!loginToken) throw new Error('登入回應缺少 access token')

  return {
    operatorId,
    loginToken,
    operatorName: raw.display_name ?? raw.name ?? email,
    organizations: (raw.organizations ?? []).map(o => ({
      id: o.organization_id,
      name: o.display_name,
      role: o.role,
      isAdmin: o.is_admin,
      status: o.status,
    })),
  }
}

export interface ExchangeResult {
  accessToken: string
  /** ⚠️ 這正是 client.selectOrganization() 會丟掉的東西 —— 沒有它客服會被迫重跑 OTP */
  refreshToken?: string
}

/**
 * 第 ③ 步：以組織 id 換發 `acc_` token，**並保留 refresh_token**。
 *
 * ⚠️ 為何不用 `client.selectOrganization()`：那支便利方法只保留 `token`，
 *    丟掉 `refresh_token`（§5.1 ③）。但也不能直接呼叫 `client.auth.exchangeAccessToken()` ——
 *    exchange 端點要求請求本身帶 `x-organization-id` header，
 *    而設定它的 `client.http` 在 SDK 中是 private。
 *
 *    因此這裡複製 selectOrganization 的前半段（setOrganizationId）再自行 exchange。
 *    **這個 cast 是整個專案唯一允許存取 SDK private 成員的地方** ——
 *    若 SDK 日後開放保留 refresh_token 的官方做法，只需改這一個函式。
 */
export async function exchangeOrganizationToken(
  client: ImbraceClient,
  organizationId: string,
): Promise<ExchangeResult> {
  const withHttp = client as unknown as {
    http?: { setOrganizationId?: (id: string | undefined) => void }
  }
  if (typeof withHttp.http?.setOrganizationId !== 'function') {
    // SDK 內部結構變動時要立刻炸開，而不是靜默送出沒有 x-organization-id 的請求
    throw new Error(
      '@imbrace/sdk 內部結構已變更：找不到 client.http.setOrganizationId。'
      + '請重新確認 exchangeAccessToken 的組織標頭要如何設定（見 §5.1 ③）',
    )
  }
  withHttp.http.setOrganizationId(organizationId)

  const exchanged = await client.auth.exchangeAccessToken(organizationId)
  if (!exchanged?.token) throw new Error('exchange 回應缺少 token')

  client.setAccessToken(exchanged.token)
  return {
    accessToken: exchanged.token,
    refreshToken: exchanged.refresh_token || undefined,
  }
}

// ── JOIN / LEAVE / 模式切換（docs/ARCHITECTURE.md §10.6）─────────────────
//
// ⚠️ 2026-08-25 由官方介面的網路請求實測確認：
//    **切換模式與 JOIN 是同一支端點** —— POST /v1/team_conversations/_join，
//    body 為 `{ team_conversation_id, mode }`。SDK 的 conversations.join()
//    打的正是這支，只是它的型別把欄位宣告成 `conversation_id`。
//
// ⚠️ 兩個不照著寫就會失敗的地方：
//    ① 識別碼必須是 `tcu_` 開頭的 team_conversation id，不是對話 id。
//       兩者完全不同，見 mappers.normalizeConversationId 的說明。
//       清單 payload **不含** tcu id，必須先 conversations.get() 取得。
//    ② SDK 型別宣告的是 `conversation_id`，但實際 API 要的是
//       `team_conversation_id`。靠 JoinConversationInput 的索引簽章傳進去。

/** 對話的服務模式。與 shared/types/conversation.ts 的 ConversationMode 同義 */
export type ImbraceConversationMode = 'manual' | 'hybrid' | 'automation'

/**
 * JOIN 一個對話，並指定服務模式。
 *
 * @param teamConversationId `tcu_` 開頭的 id（**不是**對話 id）
 * @param mode 官方介面按下 JOIN 時預設 `manual`（AI 關閉）
 */
export async function joinConversation(
  client: ImbraceClient,
  teamConversationId: string,
  mode: ImbraceConversationMode = 'manual',
): Promise<unknown> {
  assertTeamConversationId(teamConversationId, 'joinConversation')
  return client.conversations.join(joinBody(teamConversationId, mode))
}

/**
 * 切換服務模式。與 JOIN 是同一支端點 —— 對已 JOIN 的對話再打一次即為切換。
 *
 * ⚠️ mode 是**對話層級的共用狀態**：切換會影響該對話的所有人，
 *    包含正在官方介面工作的同事。這不是本地偏好設定。
 */
export async function setConversationMode(
  client: ImbraceClient,
  teamConversationId: string,
  mode: ImbraceConversationMode,
): Promise<unknown> {
  assertTeamConversationId(teamConversationId, 'setConversationMode')
  return client.conversations.join(joinBody(teamConversationId, mode))
}

export async function leaveConversation(
  client: ImbraceClient,
  teamConversationId: string,
): Promise<unknown> {
  assertTeamConversationId(teamConversationId, 'leaveConversation')
  return client.conversations.leave(joinBody(teamConversationId))
}

/**
 * ⚠️ SDK 把 `conversation_id` 宣告成必填，但實測官方介面送出的 body **只有**
 *    `{ team_conversation_id, mode }`。型別與實際 API 不一致，此處以單一 cast
 *    集中吸收 —— 這是整個檔案唯一需要繞過 SDK 型別的地方。
 */
function joinBody(
  teamConversationId: string,
  mode?: ImbraceConversationMode,
): Parameters<ImbraceClient['conversations']['join']>[0] {
  return {
    team_conversation_id: teamConversationId,
    ...(mode ? { mode } : {}),
  } as unknown as Parameters<ImbraceClient['conversations']['join']>[0]
}

/**
 * 傳錯識別碼時當場報錯。
 *
 * ⚠️ 這個防呆有存在必要：對話 id 與 tcu id 都是 UUID 形狀，傳錯不會有型別錯誤，
 *    而平台對錯誤的 id 可能只是靜默不作用 —— 症狀是「按了 JOIN 但沒反應」。
 */
function assertTeamConversationId(id: string, caller: string): void {
  if (!id?.startsWith('tcu_')) {
    throw new Error(
      `${caller}() 需要 team_conversation id（tcu_ 開頭），收到的是 "${id}"。`
      + '對話 id 與 team_conversation id 是兩個不同的東西 ——'
      + '請先用 conversations.get() 取得詳情，其 id 欄位才是 tcu_（見 §10.6）',
    )
  }
}
