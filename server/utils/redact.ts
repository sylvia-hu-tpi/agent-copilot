/**
 * PII 遮蔽（docs/ARCHITECTURE.md §16.4 / 憲法第 8 條：日誌不得輸出訊息全文）。
 *
 * 此檔為正式產出 —— M1 起所有 logger 與錯誤回報都應經過這裡。
 * spike 用它把樣本存成可安全進版控、可當測試 fixture 的形式。
 */

import { createHash } from 'node:crypto'

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** 訊息全文 → 可安全記錄的指紋：長度 + 雜湊 + 前 8 字 */
export function redactText(text: string, keep = 8): string {
  if (!text) return '<empty>'
  const head = text.slice(0, keep)
  return `${head}…<len:${text.length} sha:${hashText(text)}>`
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const PHONE = /\+?\d[\d\s-]{7,}\d/g
const URL_QS = /(\?|&)([\w-]+)=([^&\s]+)/g

/** 保留結構、抹掉可識別內容 —— 適合存成 fixture */
export function scrubPii(text: string): string {
  return text
    .replace(EMAIL, '<email>')
    .replace(PHONE, '<phone>')
    .replace(URL_QS, (_m, sep, key) => `${sep}${key}=<redacted>`)
}

/** 遞迴遮蔽物件中的已知敏感欄位 */
const SENSITIVE_KEYS = new Set([
  'text', 'caption', 'title', 'content', 'name', 'display_name',
  'email', 'phone', 'avatar_url', 'accessToken', 'token',
  'refresh_token', 'apiKey', 'api_key',
])

export function scrubObject<T>(value: T, depth = 0): unknown {
  if (depth > 12) return '<max-depth>'
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(v => scrubObject(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) && typeof v === 'string'
        ? redactText(scrubPii(v))
        : scrubObject(v, depth + 1)
    }
    return out
  }
  return value
}
