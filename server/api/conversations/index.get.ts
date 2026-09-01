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
import { annotateViewerJoined } from '../../services/viewer-joined.js'
import { useStateStore } from '../../state/index.js'
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

  /*
    補上「你在此對話中」的 `viewerJoined`（畫布 §8.2）。

    ⚠️ 這是**加值步驟，不是必要步驟**：平台清單根本沒有 `is_joined`（實測 0/16，§10.2.1），
       要標就得自己補查詳情。成本控制、候選集合為什麼是 `mode` 而不是 `is_agent_joined`、
       以及兩個已知盲區，全部寫在 `annotateViewerJoined()` 的檔頭。
    ⚠️ 它**不會拋錯**（內部 `allSettled`）—— 補查失敗時清單照常回，只是少了標記。
       在這裡加 try/catch 會蓋掉真正該冒出來的錯，所以刻意不加。
  */
  await annotateViewerJoined(useStateStore(), client, session.operatorId, items)

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
