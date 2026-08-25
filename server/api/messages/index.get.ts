/**
 * 取訊息 —— docs/ARCHITECTURE.md §9.3。
 *
 * ⚠️ **`since` 是我方在本地實作的，平台不支援增量拉取。**
 *    已實測 `since` / `after` / `since_id` / `from_created_at` / `start_time` /
 *    `created_at_gt` 等八種寫法**全部被忽略**（回傳筆數與全量相同）。
 *    因此這裡的 `since` 是「取最新 N 則後在本地切」——
 *    斷線超過 N 則的量時要改用不帶 since 的完整載入，不要靠它補齊。
 *
 * ⚠️ 預設只取最新 50 則（§9.3 緩解措施 ①）。實測單一對話最多 398 則，
 *    每次都取全量是輪詢成本的真正來源。回補歷史用 `skip` 分頁。
 */

import { z } from 'zod'
import {
  DEFAULT_MESSAGE_LIMIT,
  fetchLatest,
  fetchSince,
} from '../../sources/message-fetch.js'
import { assertConversationId } from '../../utils/conversation-param.js'
import { imbraceClientFor } from '../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../utils/session.js'
import { getQueryAs } from '../../utils/validate.js'

const Query = z.object({
  conversationId: z.string().min(1),
  /** 版本錨點。給了就只回它之後的訊息 */
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_MESSAGE_LIMIT),
  /** 回補歷史用。⚠️ 與 since 併用沒有意義，故兩者擇一 */
  skip: z.coerce.number().int().min(0).default(0),
})

export default defineEventHandler(async (event) => {
  const { conversationId, since, limit, skip } = getQueryAs(event, Query)
  const convId = assertConversationId(conversationId)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)

  const messages = since && !skip
    ? await fetchSince(client, convId, since, { limit })
    : await fetchLatest(client, convId, { limit, skip })

  return {
    conversationId: convId,
    messages,
    /** 前端拿它當下一次的錨點 */
    lastMessageId: messages[messages.length - 1]?.id ?? since ?? null,
    /** 取滿 limit 代表可能還有更舊的，前端才顯示「載入更多」 */
    hasMore: messages.length >= limit,
  }
})
