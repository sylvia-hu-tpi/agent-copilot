/**
 * BFF cookie session —— docs/ARCHITECTURE.md §7.2。
 *
 * 三條不可退讓的規則：
 *  1. cookie 只放「不可逆的 session id + 簽章」，access token 一律留在 server
 *  2. httpOnly + Secure + SameSite=Lax（webhook 是 server-to-server，不受 SameSite 影響）
 *  3. 8 小時滑動視窗 —— 客服常共用工作站，30 天 token 直接對應到瀏覽器是高風險
 *
 * ⚠️ 命名為何都帶 `BffSession`：本檔位於 server/utils/，Nitro 會 auto-import
 *    其具名匯出至 server 全域。h3 本身已匯出 getSession / clearSession / useSession，
 *    若沿用同名會靜默覆蓋 h3 的版本，造成極難追查的行為異常。
 */

import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { signSessionId, unsignSessionId } from './session-signature.js'
import { useStateStore } from '../state/index.js'
import type { ActiveSession, Session } from '../state/types.js'

export const SESSION_COOKIE = 'ac_session'

/** 8 小時滑動視窗（§7.2）。比 iMBrace token 的 30 天 TTL 短得多，這是刻意的。 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function secret(): string {
  const s = useRuntimeConfig().sessionSecret
  if (!s) {
    // 不可靜默 fallback 成隨機值：那會讓 session 在每次重啟後全失效，
    // 且在多副本下每個副本簽章不同 —— 症狀是「隨機被登出」，極難追查。
    throw createError({
      statusCode: 500,
      statusMessage: '缺少 NUXT_SESSION_SECRET（見 .env.example）',
    })
  }
  return s
}

const signedValue = (id: string): string => signSessionId(id, secret())
const unsignValue = (raw: string | undefined): string | null => unsignSessionId(raw, secret())

function setSessionCookie(event: H3Event, id: string): void {
  setCookie(event, SESSION_COOKIE, signedValue(id), {
    httpOnly: true,
    // dev 走 http://localhost，Secure cookie 在部分瀏覽器設定下會被丟棄
    secure: !import.meta.dev,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

// ── 對外 API ────────────────────────────────────────────────────────────

/** 建立新 session（登入第 ② 步呼叫），回傳 session id */
export async function startBffSession(event: H3Event, session: Session): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await useStateStore().setSession(id, session)
  setSessionCookie(event, id)
  return id
}

/** 覆寫既有 session 內容（第 ③ 步 pending_org → active），同時延長滑動視窗 */
export async function saveBffSession(event: H3Event, session: Session): Promise<void> {
  const id = unsignValue(getCookie(event, SESSION_COOKIE))
  if (!id) throw createError({ statusCode: 401, statusMessage: 'session 不存在或已過期' })
  await useStateStore().setSession(id, { ...session, expiresAt: Date.now() + SESSION_TTL_MS })
  setSessionCookie(event, id)
}

/**
 * 讀取 session，並推進 8 小時滑動視窗。
 * 沒有 / 過期 / 驗簽失敗一律回 null —— 呼叫端自行決定是 401 還是導向登入。
 */
export async function readBffSession(event: H3Event): Promise<Session | null> {
  const id = unsignValue(getCookie(event, SESSION_COOKIE))
  if (!id) return null

  const store = useStateStore()
  const session = await store.getSession(id)
  if (!session) return null

  // 滑動視窗：每次存取都往後推，並同步更新 cookie 的 maxAge
  await store.setSession(id, { ...session, expiresAt: Date.now() + SESSION_TTL_MS })
  setSessionCookie(event, id)
  return session
}

/** 取得已選定組織的 session；否則丟 401。業務 API 一律用這支。 */
export async function requireActiveBffSession(event: H3Event): Promise<ActiveSession> {
  const session = await readBffSession(event)
  if (!session) throw createError({ statusCode: 401, statusMessage: '尚未登入' })
  if (session.stage !== 'active') {
    throw createError({ statusCode: 401, statusMessage: '尚未選擇組織' })
  }
  return session
}

/** 取得登入中（尚未選組織）的 session；否則丟 401。organization.post.ts 用。 */
export async function requirePendingBffSession(event: H3Event) {
  const session = await readBffSession(event)
  if (!session) throw createError({ statusCode: 401, statusMessage: '尚未登入' })
  if (session.stage !== 'pending_org') {
    throw createError({ statusCode: 409, statusMessage: '此 session 已選定組織' })
  }
  return session
}

/** 登出：清 store 與 cookie */
export async function dropBffSession(event: H3Event): Promise<void> {
  const id = unsignValue(getCookie(event, SESSION_COOKIE))
  if (id) await useStateStore().deleteSession(id)
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
}
