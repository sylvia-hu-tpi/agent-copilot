/**
 * 路由參數中的對話 id —— **一律經此正規化**。
 *
 * ⚠️ 為何值得一個獨立檔案：§9.3「對話有三種識別碼」是本專案目前最容易靜默出錯的地方。
 *    前端可能從清單帶裸 UUID 來、從訊息帶 `conv_` 前綴來，兩者都是同一個對話，
 *    但若不正規化就直接拿去查 CopilotSession / presence / EventBus topic，
 *    會得到兩把不同的鍵 —— 症狀是「訊息進來了但面板沒反應」，極難追查。
 *
 * ⚠️ `tcu_` 開頭的識別碼在此**當場擋下**：它是 team_conversation 記錄自己的 id，
 *    不是對話 id。形狀同樣是 UUID，傳錯不會有型別錯誤。
 */

import type { H3Event } from 'h3'
import { normalizeConversationId } from '../sources/mappers.js'

export function conversationIdParam(event: H3Event, name = 'id'): string {
  const raw = getRouterParam(event, name)
  if (!raw) throw createError({ statusCode: 400, message: '缺少對話 id' })
  return assertConversationId(decodeURIComponent(raw))
}

export function assertConversationId(raw: string): string {
  if (raw.startsWith('tcu_')) {
    throw createError({
      statusCode: 400,
      message:
        `"${raw}" 是 team_conversation id，不是對話 id。`
        + '兩者形狀都是 UUID 但指的不是同一個東西（見 §9.3）',
    })
  }
  return normalizeConversationId(raw)
}
