/**
 * 取得「某一對話」的訊息。
 *
 * ⚠️ 為何需要這個檔案：
 * `@imbrace/sdk@1.4.0` 的 `messages.list()` 簽章是
 *   list(params?: { type?, q?, limit?, skip? })
 * —— 沒有 conversation_id，也沒有 since。但 §9 的整套輪詢策略都建立在
 * 「取某對話自 lastMessageId 之後的新訊息」之上。
 *
 * 因此這裡列出候選策略，由 spike 實測出哪一種可行，
 * 勝出者即成為 PollingMessageSource 的取數核心（M1）。
 */

import type { ImbraceClient, ConversationMessage, PagedResponse } from '@imbrace/sdk'
import { unwrapPaged } from './mappers.js'

export type FetchStrategy =
  /** SDK 原生 list，用 q 帶 conversation id */
  | 'sdk-q'
  /** SDK 原生 list 不帶條件，取回後在本地過濾（最後手段：浪費頻寬） */
  | 'sdk-client-filter'
  /** 繞過 SDK，直接打 REST 並帶 conversation_id（若後端支援） */
  | 'raw-conversation-id'

export interface FetchResult {
  strategy: FetchStrategy
  messages: ConversationMessage[]
  /** 回傳中真正屬於該對話的比例 —— 用來判斷策略是否真的有效 */
  precision: number
  note: string
}

function precisionOf(msgs: ConversationMessage[], convId: string): number {
  if (msgs.length === 0) return 0
  const hit = msgs.filter(m => m.conversation_id === convId).length
  return hit / msgs.length
}

function unwrap(res: PagedResponse<ConversationMessage> | ConversationMessage[] | unknown): ConversationMessage[] {
  return unwrapPaged<ConversationMessage>(res)
}

/**
 * 依序嘗試各策略，回傳第一個 precision 達標者。
 * spike 會把所有策略的結果都記錄下來（見 03-incremental.ts）。
 */
export async function tryStrategies(
  client: ImbraceClient,
  convId: string,
  limit = 100,
): Promise<FetchResult[]> {
  const results: FetchResult[] = []

  // ① SDK list + q
  try {
    const res = await client.messages.list({ q: convId, limit })
    const msgs = unwrap(res)
    results.push({
      strategy: 'sdk-q',
      messages: msgs,
      precision: precisionOf(msgs, convId),
      note: `q=<convId> 取回 ${msgs.length} 則`,
    })
  } catch (e) {
    results.push({
      strategy: 'sdk-q', messages: [], precision: 0,
      note: `失敗：${e instanceof Error ? e.message : String(e)}`,
    })
  }

  // ② 繞過 SDK，直接帶 conversation_id
  //    SDK 未公開此參數，但後端很可能支援 —— 值得一試，因為這是最乾淨的解。
  try {
    const msgs = await rawList(client, { conversation_id: convId, limit: String(limit) })
    results.push({
      strategy: 'raw-conversation-id',
      messages: msgs,
      precision: precisionOf(msgs, convId),
      note: `REST ?conversation_id= 取回 ${msgs.length} 則`,
    })
  } catch (e) {
    results.push({
      strategy: 'raw-conversation-id', messages: [], precision: 0,
      note: `失敗：${e instanceof Error ? e.message : String(e)}`,
    })
  }

  // ③ 不帶條件，本地過濾
  try {
    const res = await client.messages.list({ limit })
    const all = unwrap(res)
    const msgs = all.filter(m => m.conversation_id === convId)
    results.push({
      strategy: 'sdk-client-filter',
      messages: msgs,
      precision: msgs.length ? 1 : 0,
      note: `取回 ${all.length} 則、命中 ${msgs.length} 則（頻寬浪費 ${all.length ? Math.round((1 - msgs.length / all.length) * 100) : 0}%）`,
    })
  } catch (e) {
    results.push({
      strategy: 'sdk-client-filter', messages: [], precision: 0,
      note: `失敗：${e instanceof Error ? e.message : String(e)}`,
    })
  }

  return results
}

/**
 * 直接打 REST，帶 SDK 未公開的查詢參數。
 * 用 SDK 內部的 fetch 以沿用其認證標頭。
 */
export async function rawList(
  client: ImbraceClient,
  params: Record<string, string>,
): Promise<ConversationMessage[]> {
  // SDK 的 http/base 是 private，但 messages resource 上掛著同一個 transport。
  const res = client.messages as unknown as {
    http: { getFetch(): typeof fetch }
    base: string
  }
  const url = new URL(`${res.base}/v1/conversation_messages`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const r = await res.http.getFetch()(url, { method: 'GET' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return unwrap(await r.json())
}
