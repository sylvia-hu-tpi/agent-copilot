/**
 * 對話清單 —— docs/ARCHITECTURE.md §5 / M0 驗收「能列出對話清單」
 *
 * ⚠️ 用 search() 而非 list()：後者沒有 business unit scope 時永遠回空陣列且不報錯。
 */

import { z } from 'zod'
import type { Conversation as SdkConversation } from '@imbrace/sdk'
import { toConversation, unwrapPaged } from '../../sources/mappers.js'
import { searchConversations } from '../../services/imbrace.js'
import { resolveBusinessUnitId } from '../../services/business-unit.js'
import { imbraceClientFor } from '../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../utils/session.js'
import { getQueryAs } from '../../utils/validate.js'

const Query = z.object({
  q: z.string().trim().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /**
   * ⚠️ 對外的參數名維持 `skip`（前端已在用），但**送給平台的是 `offset`** ——
   *    平台會靜默忽略 `skip` 並回傳第一頁。轉換關在 `searchConversations()` 裡。
   */
  skip: z.coerce.number().int().min(0).default(0),
})

export default defineEventHandler(async (event) => {
  const { q, limit, skip } = getQueryAs(event, Query)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const businessUnitId = await resolveBusinessUnitId(client, session.orgId)

  const res = await searchConversations(client, { businessUnitId, q, limit, offset: skip })
  const items = unwrapPaged<SdkConversation>(res).map(toConversation)

  /**
   * 側欄底部「顯示 N / M」的 M。
   *
   * ⚠️ SDK 型別沒有宣告 `total`，但實測其他 conversations 端點的回應帶著它
   *    （見 `docs/PLATFORM_CAPABILITY.md` §4.1 的 `{data:[],total:0}` 樣本）。
   *    因此**取得到就用、取不到就回 null**，由 UI 決定不顯示分母 ——
   *    絕不用 `items.length` 冒充總數，那會在只載入首頁時顯示「30 / 30」而實際有 200 筆。
   */
  const raw = res as { total?: unknown } | null
  const total = typeof raw?.total === 'number' ? raw.total : null

  return { items, total, limit, skip }
})
