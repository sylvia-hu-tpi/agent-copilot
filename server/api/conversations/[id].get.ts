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

  /*
    左欄「你在此對話中」的判定回填（§10.2.1）—— 這一趟本來就查了詳情，`is_joined` 已在手上。

    ⚠️ 這是**盲區①的修正點**：同事已經在裡面（`mode` 已是 `manual`）時，你從 iMBrace
       官方介面 JOIN 進去，`mode` 不會變動、清單那邊收不到任何失效訊號。
       客服點開該對話時走到這裡，快取就被更正了。順手回填，不多花任何一次呼叫。
  */
  const store = useStateStore()
  await store.setViewerJoined(session.operatorId, ctx.id, {
    joined: ctx.viewerJoined,
    mode: ctx.mode ?? null,
  })

  const presence = await snapshotOf(store, ctx.id, {
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
