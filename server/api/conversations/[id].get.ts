/**
 * 單一對話的詳情 —— docs/ARCHITECTURE.md §10.6。
 *
 * ⚠️ 這一趟請求不是可有可無的：`tcu_` id 只有詳情 API 會回，
 *    而 JOIN / LEAVE / 切換 mode 全都需要它（§10.6 ②）。
 *    前端開啟工作區時必須先打這一支，否則 JOIN 按下去會靜默不作用。
 */

import { controlFromMode } from '../../../shared/types/conversation.js'
import { loadConversationContext } from '../../services/conversation-context.js'
import { snapshotOf } from '../../services/presence.js'
import { useStateStore } from '../../state/index.js'
import { conversationIdParam } from '../../utils/conversation-param.js'
import { imbraceClientFor } from '../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../utils/session.js'

export default defineEventHandler(async (event) => {
  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  const presence = await snapshotOf(useStateStore(), ctx.id, {
    mode: ctx.mode ?? null,
    excludeOperatorId: session.operatorId,
    viewerJoined: ctx.viewerJoined,
  })

  return {
    conversation: ctx,
    control: controlFromMode(ctx.mode),
    presence,
  }
})
