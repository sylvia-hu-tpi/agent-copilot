/**
 * iMBrace SDK client factory（docs/ARCHITECTURE.md §7.3）。
 *
 * ⚠️ 憲法第 1 條：`server/` 以外的任何地方不得 import 此檔或 @imbrace/sdk。
 * ⚠️ 不要建立全域單例 client —— 每位客服的操作必須以自己的身分執行，
 *    否則 join() 與訊息送出的歸屬會全部錯亂，稽核軌跡失去意義。
 */

import { ImbraceClient } from '@imbrace/sdk'
import type { Environment } from '@imbrace/sdk'

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
