/**
 * Session cookie 的簽章 —— docs/ARCHITECTURE.md §7.2。
 *
 * ⚠️ 刻意獨立成一個「不碰 Nitro」的檔案：secret 由參數傳入，不呼叫 useRuntimeConfig。
 *    這樣簽章邏輯才能用一般的 vitest 直接測 —— 它是 session 安全性的核心，
 *    不該只能靠跑起整個伺服器的 e2e 來覆蓋。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

function signatureOf(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url')
}

export function signSessionId(id: string, secret: string): string {
  return `${id}.${signatureOf(id, secret)}`
}

/** 驗簽並取回 session id；失敗回 null。以 timingSafeEqual 比對，避免時序側通道 */
export function unsignSessionId(raw: string | undefined, secret: string): string | null {
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null

  const id = raw.slice(0, dot)
  const got = Buffer.from(raw.slice(dot + 1))
  const want = Buffer.from(signatureOf(id, secret))
  if (got.length !== want.length) return null
  return timingSafeEqual(got, want) ? id : null
}
