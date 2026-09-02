/**
 * iMBrace SDK client factory（docs/ARCHITECTURE.md §7.3）。
 *
 * ⚠️ 憲法 1.2：`server/` 以外的任何地方不得 import 此檔或 @imbrace/sdk。
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

// ── 對話詳情 ────────────────────────────────────────────────────────────
//
// ⚠️ §10.6 ②：`tcu_` id 只有詳情 API 會回，清單 payload 沒有。
//    因此「從對話列表按 JOIN」必須先取一次詳情才拿得到識別碼。

/**
 * 以**對話 id**（裸 UUID 或 `conv_` 前綴皆可）取得詳情。
 *
 * ── 2026-08-25 實測修正 ─────────────────────────────────────────
 * 初版走 `getByConversationId()`，理由是「`get()` 吃的是 tcu_ id，
 * 拿對話 id 去打會查不到」。**這個推理是錯的，而且錯得很貴** ——
 * 它是照 SDK 編譯後的 URL 組法反推出來的，沒有實測。
 *
 * `npm run spike:write` 的實測結果：
 *   ❌ `getByConversationId()` → `{ data: [], total: 0 }`（兩種 id 形式都一樣）
 *   ✅ `get(<對話 id>)`        → 完整 team_conversation 物件（兩種 id 形式都可以）
 *
 * 也就是說 `GET /v1/team_conversations/{id}` 的 `{id}` **同時接受對話 id 與 tcu id**，
 * 平台會自行解析。回傳物件的 `id` / `_id` 是 tcu_，另有 `conversation_id` 欄位。
 *
 * ⚠️ 若照初版寫法上線，症狀會是「所有對話都查不到詳情」→ JOIN 按鈕全壞，
 *    而錯誤形態是 404 而非「查詢方式錯」，很難從症狀反推。
 *
 * 實測回傳的欄位（供上層取用，SDK 型別一個都沒宣告）：
 *   `id` / `_id` = `tcu_…`、`conversation_id` = `conv_…`、
 *   `mode`、`is_joined`（我的視角）、`is_agent_joined`、`is_presence`、
 *   `users[]`（14 人的**團隊名冊**，不是參與者 —— §10.2）
 */
export async function getConversationDetail(
  client: ImbraceClient,
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  const res = await client.conversations.get(conversationId) as unknown

  // ⚠️ 仍保留解容器的分支：SDK 型別標的是單一物件，但這個 gateway 的
  //    其他端點回的是分頁容器，形狀靠不住（見 unwrapPagedRaw 的說明）。
  //    空容器要回 null，不可把 `{ data: [], total: 0 }` 本身當成詳情往上傳 ——
  //    那會讓上層以為查到了，然後在讀 id 時炸在別的地方。
  if (isPagedContainer(res)) {
    const list = unwrapPagedRaw(res)
    return list[0] ?? null
  }

  return res && typeof res === 'object' && !Array.isArray(res)
    ? res as Record<string, unknown>
    : null
}

/** 回應是不是「分頁容器」而不是資料本身 */
function isPagedContainer(res: unknown): boolean {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return false
  const r = res as Record<string, unknown>
  return ['data', 'items', 'results', 'hits'].some(k => Array.isArray(r[k]))
}

/**
 * ⚠️ 與 sources/mappers.ts 的 `unwrapPaged` 是同一段邏輯，此處刻意複製而非 import。
 *
 * 理由：本檔被 `scripts/spike/*` 以 tsx 直接 import，必須維持零內部相依 ——
 * mappers.ts 會 import SDK 型別與領域型別，把相依鏈拉進來只為了一個 6 行的函式並不划算。
 * 若日後這段邏輯要修，兩處都要改（已在 mappers.ts 端註明）。
 */
function unwrapPagedRaw(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[]
  const r = res as Record<string, unknown> | null | undefined
  for (const key of ['data', 'items', 'results', 'hits']) {
    if (Array.isArray(r?.[key])) return r[key] as Record<string, unknown>[]
  }
  return []
}

// ── 送出訊息（docs/ARCHITECTURE.md §10.4）───────────────────────────────

/**
 * 送出一則文字訊息。
 *
 * ⚠️ **SDK 的 `messages.send()` 型別完全沒有宣告對話識別碼**：
 *
 * ```ts
 * send(body: { type, text?, url?, caption?, title?, payload? })
 * ```
 *
 * 但它打的是 `POST /v1/conversation_messages` 且**把 body 原樣送出**，
 * 而該端點不可能不需要知道要送到哪個對話 —— 這是 SDK 型別漏宣告，
 * 與 §10.6 的 `join()` 少宣告 `mode` 是同一類問題。
 * 此處以與 `joinBody()` 相同的方式，用單一 cast 集中吸收。
 *
 * ⚠️ **`conversation_id` 的正確形式尚未實測**（見 `IMBRACE_QUESTIONS.md` H-6）。
 *    取數端點 `?conversation_id=` 兩種形式都收，故此處送**帶 `conv_` 前綴**的形式
 *    —— 那是訊息物件自己 `conversation_id` 欄位的形狀，最可能與寫入端一致。
 *    若實測失敗，只需改這一個函式（`npm run spike:send`）。
 */
export async function sendTextMessage(
  client: ImbraceClient,
  conversationId: string,
  text: string,
): Promise<Record<string, unknown>> {
  const body = {
    type: 'text' as const,
    text,
    conversation_id: withConvPrefix(conversationId),
  }
  const res = await client.messages.send(
    body as unknown as Parameters<ImbraceClient['messages']['send']>[0],
  )
  return res as unknown as Record<string, unknown>
}

/**
 * 對話清單查詢 —— **必須走這支，不要直接呼叫 `client.conversations.search()`**。
 *
 * ⚠️⚠️ **SDK 宣告的分頁參數是 `skip`，但平台實際吃的是 `offset`。**
 *    傳 `skip` 不會報錯、不會是 400 —— 平台回 200 並**原封送回第一頁**。
 *    症狀因此是「載入更多按下去沒反應」，而不是任何一種錯誤。
 *    2026-08-29 由 `npm run spike:list-order` 實測定位（探測 ②③④）：
 *      skip / from / page / start / skip_count → 全部回傳與第一頁相同的內容
 *      offset                                  → ✅ 精確的筆數位移
 *    佐證：`offset=8&limit=8` 與全量的第 9–16 筆逐筆相符；
 *          `offset=1&limit=3` 等於第 2–4 筆（確認是位移而非頁碼語意）。
 *
 * ⚠️ 排序：平台預設依 **`updated_at` 由新到舊**（同一支 spike，n=16，15 組比對全部成立）。
 *    **不是** `last_message_at`（該欄位填充率僅 81%，遞減比例只有 67%）。
 *    §9.3.1 第一層只取前 `LIST_PAGE_SIZE` 筆而不分頁，正是依賴這個排序 ——
 *    有新訊息的對話會讓 `updated_at` 跳動而前移，因此落在取數視窗內。
 *    ⚠️ 若平台日後改變預設排序，那個「只取前 N 筆」的安排會**安靜地失效**。
 */
export async function searchConversations(
  client: ImbraceClient,
  params: { businessUnitId: string, q: string, limit?: number, offset?: number },
): Promise<unknown> {
  const res = client.conversations as unknown as {
    http: { getFetch(): typeof fetch }
    v1: string
  }
  const url = new URL(`${res.v1}/team_conversations/_search`)
  url.searchParams.set('business_unit_id', params.businessUnitId)
  url.searchParams.set('type', 'text')
  url.searchParams.set('q', params.q)
  if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit))
  if (params.offset) url.searchParams.set('offset', String(params.offset))

  const r = await res.http.getFetch()(url, { method: 'GET' })
  if (!r.ok) throw new Error(`conversations.search 失敗：HTTP ${r.status}`)
  return r.json()
}

// ── AI Agent 的 client user id（specs/005-m2-residual-defects FR-021，research.md #21）──
//
// ⚠️ SDK 的 `aiAgent.streamChat()` 在 `user_id` 缺席時會**先串行 await 一次**
//    `POST /ai-agent/chat-client/auth/user` 取 id 才打 `/v2/chat`（`node_modules/@imbrace/sdk/dist/resources/ai-agent.js`）。
//    每一次摘要、每一次情緒批次、每一次建議卡都多付一趟往返去查同一個固定值，實測 54ms
//    （`npm run spike:userid`，並核對過多次取得的 id 一致 —— 快取的前提成立）。
//
// ⚠️ **這個 id 是 AI 服務的 client user id，與客服身分無關。** 填成客服的 `operatorId` 不會報錯，
//    只會讓 AI 服務端的用量統計掛到錯的人身上。憲法 1.3 管的是寫入歸屬，本項不觸及該條，
//    但這個註解 MUST 留在這裡。
//
// ⚠️ 直接複製 SDK 內部那一行的呼叫形狀（`POST`、無 body），不用 `client.aiAgent.getChatClientUser()`
//    （它會多送一個 JSON body）—— 省下的必須是 `streamChat()` 實際付出的那一趟。
//    存取 SDK 的 private `http`／`base` 是與 `exchangeOrganizationToken()` 同一類的繞道，關在本檔。

const AI_USER_KEY = Symbol.for('agent-copilot.ai-client-user-id')
type AiUserGlobal = typeof globalThis & { [AI_USER_KEY]?: Map<string, Promise<string>> }

function aiUserCache(): Map<string, Promise<string>> {
  const g = globalThis as AiUserGlobal
  if (!g[AI_USER_KEY]) g[AI_USER_KEY] = new Map()
  return g[AI_USER_KEY]
}

/**
 * 取得（並以 process-local 快取）這個 client 對 AI Agent 服務的 user id。
 *
 * 快取鍵是 `aiAgent.base`（gateway 位址）—— AI provider 只用一個 API-key client，spike 19 已驗證
 * 同一個 client 多次取得的 id 一致。取得失敗**不快取**（下一次再試），由呼叫端決定要不要退回
 * 「不帶 `user_id`、讓 SDK 自己去查」的舊路徑。
 *
 * @throws SDK 內部結構變動（找不到 `aiAgent.http`／`base`）、HTTP 非 2xx、回應缺 `id`
 */
export async function resolveAiClientUserId(client: ImbraceClient): Promise<string> {
  const agent = client.aiAgent as unknown as { http?: { getFetch?: () => typeof fetch }, base?: unknown }
  if (typeof agent?.http?.getFetch !== 'function' || typeof agent.base !== 'string') {
    // SDK 內部結構變動時要立刻炸開，而不是靜默退回舊路徑而讓 FR-021 無聲失效
    throw new Error(
      '@imbrace/sdk 內部結構已變更：找不到 client.aiAgent.http.getFetch／client.aiAgent.base。'
      + '請重新確認 chat-client/auth/user 的呼叫形狀（見 scripts/spike/19-userid-roundtrip.ts）',
    )
  }
  const key = agent.base
  const cached = aiUserCache().get(key)
  if (cached) return cached

  const fetchFn = agent.http.getFetch()
  const task = (async () => {
    const res = await fetchFn(`${key}/chat-client/auth/user`, { method: 'POST' })
    if (!res.ok) throw new Error(`chat-client/auth/user 失敗：HTTP ${res.status}`)
    const data = await res.json() as { id?: unknown }
    if (typeof data.id !== 'string' || !data.id) throw new Error('chat-client/auth/user 回應缺少 id')
    return data.id
  })()
  aiUserCache().set(key, task)
  task.catch(() => aiUserCache().delete(key))
  return task
}

/** 測試用：清掉快取 */
export function resetAiClientUserIdCache(): void {
  aiUserCache().clear()
}

/**
 * 補上 `conv_` 前綴。
 *
 * ⚠️ 與 `mappers.normalizeConversationId()` 方向相反 —— 那支是**對內**正規化成裸 UUID，
 *    這支是**對外**還原成平台寫入端要的形式。兩者都存在是刻意的：
 *    正規形式只在我方系統內部通用，出了防腐層就要換回平台的形狀。
 */
function withConvPrefix(conversationId: string): string {
  return conversationId.startsWith('conv_') ? conversationId : `conv_${conversationId}`
}
