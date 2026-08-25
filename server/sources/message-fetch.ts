/**
 * 取得「某一對話」的訊息。
 *
 * ⚠️ 為何需要這個檔案：
 * `@imbrace/sdk@1.4.0` 的 `messages.list()` 簽章是
 *   list(params?: { type?, q?, limit?, skip? })
 * —— 沒有 conversation_id，也沒有 since。但 §9 的整套輪詢策略都建立在
 * 「取某對話自 lastMessageId 之後的新訊息」之上。
 *
 * ── 實測結論（2026-08-25，§9.3）─────────────────────────────────
 * 勝出策略是 `raw-conversation-id`：`GET /v1/conversation_messages?conversation_id=`，
 * precision 100%。後端**強制要求**此參數（不帶會 400），只是 SDK 未公開。
 *
 * 兩件必須一起記住的事：
 *  ① **不支援增量拉取** —— since / after / since_id 等八種寫法全部被忽略。
 *     因此 `fetchSince()` 是「取最新 N 則後在本地切」，不是真的增量。
 *  ② **訊息預設由新到舊排序**，所以 `limit=N` 直接就是最新 N 則，
 *     不需要 sort 參數，也不需要 skip=total-N。
 *
 * `tryStrategies()` 保留給 spike 作為證據蒐集；正式路徑走 `fetchLatest()` / `fetchSince()`。
 */

import type { ImbraceClient, ConversationMessage, PagedResponse } from '@imbrace/sdk'
import type { Message } from '../../shared/types/conversation.js'
import {
  createSenderResolver,
  sameConversation,
  toMessage,
  unwrapPaged,
} from './mappers.js'

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

/**
 * ⚠️ 必須用 sameConversation 而非字串相等。
 *
 * 初版寫成 `m.conversation_id === convId`，而對話清單給的是裸 UUID、
 * 訊息帶 `conv_` 前綴 —— 結果是「明明取回 70 則正確訊息，precision 卻算成 0%」，
 * 進而把一個完全可行的策略判成不可行，差點誤判 M1 被阻塞。
 */
function precisionOf(msgs: ConversationMessage[], convId: string): number {
  if (msgs.length === 0) return 0
  const hit = msgs.filter(m => sameConversation(m.conversation_id, convId)).length
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
    const msgs = all.filter(m => sameConversation(m.conversation_id, convId))
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

// ─────────────────────────────────────────────────────────────
// 正式取數路徑（M1）
// ─────────────────────────────────────────────────────────────

/**
 * §9.3 緩解措施 ①：只取最新 N 則，而非整串對話。
 *
 * 實測單一對話最多 398 則。全量取回是「每次輪詢的 payload 大得多」的真正成本來源，
 * 而畫面上根本用不到那麼多。首次載入需要更多歷史時，由前端以 `skip` 分頁回補。
 */
export const DEFAULT_MESSAGE_LIMIT = 50

/**
 * 取某對話的最新 N 則訊息，**由舊到新**排序。
 *
 * ⚠️ 平台回的是由新到舊，此處反轉成由舊到新。
 *    這是刻意的：上層（訊息流渲染、`lastMessageId` 比對、撞單檢查的「誰在我之後說話」）
 *    全都是時間順的邏輯，讓每個呼叫端各自反轉遲早會有人漏掉。
 */
export async function fetchLatest(
  client: ImbraceClient,
  conversationId: string,
  opts: { limit?: number, skip?: number } = {},
): Promise<Message[]> {
  const params: Record<string, string> = {
    conversation_id: conversationId,
    limit: String(opts.limit ?? DEFAULT_MESSAGE_LIMIT),
  }
  if (opts.skip) params.skip = String(opts.skip)

  const raw = await rawList(client, params)
  // ⚠️ 不傳對話上下文：姓名只可能來自 users[]，而那是團隊名冊（§10.2）。
  //    型別由 `from` 的前綴決定，不需要上下文 —— 這正是 senderTypeOf 的設計。
  const resolve = createSenderResolver()

  return raw
    .map(m => toMessage(m, resolve))
    // 平台回的是由新到舊 → 反轉
    .reverse()
}

/**
 * 取「`sinceMessageId` 之後」的訊息。
 *
 * ⚠️ **這不是真的增量拉取**（平台不支援，見檔頭）。實作是「取最新 N 則後在本地切」。
 *    因此有一個必須知道的邊界：**若斷線期間新增超過 N 則，較舊的那些會漏掉。**
 *    N=50、前景輪詢 3 秒的前提下這不會發生，但長時間斷線後要用
 *    `fetchLatest()` 重新載入整段，不要靠這支補齊。
 *
 * @param sinceMessageId 版本錨點。找不到（已被擠出視窗）時回傳整批，由呼叫端自行去重。
 */
export async function fetchSince(
  client: ImbraceClient,
  conversationId: string,
  sinceMessageId?: string | null,
  opts: { limit?: number } = {},
): Promise<Message[]> {
  const latest = await fetchLatest(client, conversationId, opts)
  if (!sinceMessageId) return latest

  const idx = latest.findIndex(m => m.id === sinceMessageId)
  return idx >= 0 ? latest.slice(idx + 1) : latest
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
