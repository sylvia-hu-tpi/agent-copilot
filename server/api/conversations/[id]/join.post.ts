/**
 * JOIN 一個對話 —— docs/ARCHITECTURE.md §10.6 / §4.3。
 *
 * ⚠️ **JOIN 不是排他鎖**（憲法 7.1）。平台不提供，我方也不打算加 ——
 *    AgentCopilot 攔不住任何人在 iMBrace 官方介面按 JOIN，
 *    因此任何「鎖」都是假的。策略是讓碰撞在造成傷害前被看見，而非防止碰撞。
 *
 * ⚠️ **JOIN 之後 AI 仍會自動回覆**（§10.5）。官方介面按 JOIN 的預設是 Manual Mode
 *    （AI 關閉），我方沿用同一個預設 —— 兩邊行為不一致會直接造成誤送。
 */

import { z } from 'zod'
import { controlFromMode } from '../../../../shared/types/conversation.js'
import { joinConversation } from '../../../services/imbrace.js'
import {
  loadConversationContext,
  requireTeamConversationId,
} from '../../../services/conversation-context.js'
import { useCopilotRuntime } from '../../../services/copilot-runtime.js'
import { reportViewing } from '../../../services/presence.js'
import { useEventBus, useStateStore } from '../../../state/index.js'
import { conversationTopic } from '../../../state/types.js'
import { conversationIdParam } from '../../../utils/conversation-param.js'
import { isDuplicateJoinEvent } from '../../../utils/dedupe.js'
import { imbraceClientFor } from '../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../utils/session.js'
import { readBodyAs } from '../../../utils/validate.js'

const Body = z.object({
  /** 官方介面按下 JOIN 的預設值。刻意不接受 `automation` —— 那是 LEAVE 的結果，不是 JOIN 的意圖 */
  mode: z.enum(['manual', 'hybrid']).default('manual'),
})

export default defineEventHandler(async (event) => {
  const conversationId = conversationIdParam(event)
  const { mode } = await readBodyAs(event, Body)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  // ⚠️ 必須用 tcu_ id。傳對話 id 進去平台可能只是靜默不作用（§10.6 ①）
  await joinConversation(client, requireTeamConversationId(ctx), mode)

  const store = useStateStore()

  // ① 本地快路徑。⚠️ 去重是為了 M4 接上 webhook 後的第二條路徑（§4.3）
  const duplicate = await isDuplicateJoinEvent(store, 'join', ctx.id, session.operatorId)

  await reportViewing(
    store,
    ctx.id,
    { id: session.operatorId, name: session.operatorName },
    'joined',
    true,
  )

  const control = controlFromMode(mode)
  if (!duplicate) {
    await useEventBus().publish(conversationTopic(ctx.id), {
      type: 'control.updated',
      conversationId: ctx.id,
      control,
    })
  }

  // 讓第一層輪詢立刻反映新的 mode，不必等下一個週期
  void useCopilotRuntime(session.orgId).listPoller.tick()

  return { conversationId: ctx.id, control, deduped: duplicate }
})
