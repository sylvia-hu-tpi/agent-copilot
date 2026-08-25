/**
 * 對話清單 —— docs/ARCHITECTURE.md §5 / M0 驗收「能列出對話清單」
 *
 * ⚠️ 用 search() 而非 list()：後者沒有 business unit scope 時永遠回空陣列且不報錯。
 */

import { z } from 'zod'
import type { Conversation as SdkConversation } from '@imbrace/sdk'
import { toConversation, unwrapPaged } from '../../sources/mappers.js'
import { resolveBusinessUnitId } from '../../services/business-unit.js'
import { imbraceClientFor } from '../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../utils/session.js'
import { getQueryAs } from '../../utils/validate.js'

const Query = z.object({
  q: z.string().trim().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  skip: z.coerce.number().int().min(0).default(0),
})

export default defineEventHandler(async (event) => {
  const { q, limit, skip } = getQueryAs(event, Query)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const businessUnitId = await resolveBusinessUnitId(client, session.orgId)

  const res = await client.conversations.search({ businessUnitId, q, limit, skip })
  const items = unwrapPaged<SdkConversation>(res).map(toConversation)

  return { items, limit, skip }
})
