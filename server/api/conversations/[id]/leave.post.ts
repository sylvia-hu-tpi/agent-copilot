/**
 * LEAVE 一個對話 —— docs/ARCHITECTURE.md §10.6。
 *
 * ⚠️ LEAVE 後平台的 `mode` 會回到 `automation` —— 與「有人但選了 Automation Only」同值。
 *    這個歧義對撞單防護無害（Automation Only 的人送不出訊息），
 *    但對 presence 語意有害，因此 UI 文案不可寫成「目前沒有其他人在看」（§10.2）。
 */

import { controlFromMode } from '../../../../shared/types/conversation.js'
import {
  loadConversationContext,
  requireTeamConversationId,
} from '../../../services/conversation-context.js'
import { useCopilotRuntime } from '../../../services/copilot-runtime.js'
import { leaveConversation } from '../../../services/imbrace.js'
import { clearViewing } from '../../../services/presence.js'
import { useEventBus, useStateStore } from '../../../state/index.js'
import { conversationTopic } from '../../../state/types.js'
import { conversationIdParam } from '../../../utils/conversation-param.js'
import { isDuplicateJoinEvent } from '../../../utils/dedupe.js'
import { imbraceClientFor } from '../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../utils/session.js'

export default defineEventHandler(async (event) => {
  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  await leaveConversation(client, requireTeamConversationId(ctx))

  const store = useStateStore()
  const duplicate = await isDuplicateJoinEvent(store, 'leave', ctx.id, session.operatorId)

  // ⚠️ 只清掉「我」的 presence。同事的條目由他們自己的心跳與 TTL 管理 ——
  //    在這裡順手清掉全部，會讓同事從彼此的畫面上消失。
  await clearViewing(store, ctx.id, session.operatorId)

  // 背景 JOIN 持久追蹤（specs/002-suggestion-knowledge-search/research.md #8）
  await store.removeJoinedConversation(session.operatorId, ctx.id)

  const control = controlFromMode('automation')
  if (!duplicate) {
    await useEventBus().publish(conversationTopic(ctx.id), {
      type: 'control.updated',
      conversationId: ctx.id,
      control,
    })
  }

  void useCopilotRuntime(session.orgId).listPoller.tick()

  return { conversationId: ctx.id, control, deduped: duplicate }
})
