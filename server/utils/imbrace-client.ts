/**
 * 依 runtimeConfig 建立 iMBrace client —— docs/ARCHITECTURE.md §7.3。
 *
 * 為何與 server/services/imbrace.ts 分成兩個檔案：
 * 後者被 scripts/spike 以 tsx 直接 import，不能碰 Nitro 的 auto-import；
 * 本檔則是 Nitro 專屬的薄包裝，負責把 runtimeConfig 餵進去。
 *
 * ⚠️ 不要建立全域單例 client（§7.3）。每位客服的操作必須以自己的身分執行，
 *    否則 join() 與訊息送出的歸屬會全部錯亂，稽核軌跡失去意義。
 */

import type { Environment, ImbraceClient } from '@imbrace/sdk'
import {
  anonymousClient,
  clientForSession,
  type ClientOptions,
} from '../services/imbrace.js'
import type { ActiveSession } from '../state/types.js'

function options(): ClientOptions {
  const cfg = useRuntimeConfig()
  return {
    env: cfg.public.imbraceEnv as Environment,
    // 空字串代表未設定 —— 交給 env 的預設對應，不要傳空字串給 SDK
    baseUrl: cfg.imbraceBaseUrl || undefined,
  }
}

/** 只用於登入流程本身（requestOtp / loginWithOtp） */
export function anonymousImbraceClient(): ImbraceClient {
  return anonymousClient(options())
}

/** 帶著中間 `login_acc_` token 的 client —— 只能拿來 exchange，不能呼叫業務 API */
export function loginTokenImbraceClient(loginToken: string): ImbraceClient {
  return clientForSession({ accessToken: loginToken }, options())
}

/** 以客服自己的身分操作 —— 業務 API 一律走這支 */
export function imbraceClientFor(session: ActiveSession): ImbraceClient {
  return clientForSession(
    { accessToken: session.accessToken, organizationId: session.orgId },
    options(),
  )
}

/**
 * 背景輪詢專用：以登記處借來的憑證建立 client。
 *
 * ⚠️ **只可用於唯讀輪詢**。所有寫入操作（JOIN / LEAVE / 切換 mode / 送出訊息）
 *    一律走 `imbraceClientFor(session)`，以發起者自己的身分執行 ——
 *    否則稽核軌跡會全部掛到「剛好被借用憑證的那個人」身上（憲法 1.3）。
 *    理由與界線詳見 `server/services/credentials.ts` 的檔頭。
 */
export function imbraceClientForPolling(
  cred: { accessToken: string, orgId: string },
): ImbraceClient {
  return clientForSession(
    { accessToken: cred.accessToken, organizationId: cred.orgId },
    options(),
  )
}
