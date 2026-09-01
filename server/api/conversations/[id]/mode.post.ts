/**
 * 切換服務模式 —— docs/ARCHITECTURE.md §10.6。
 *
 * ⚠️ **切換模式與 JOIN 是同一支端點**（2026-08-25 由官方介面的網路請求實測確認）。
 *    對已 JOIN 的對話再打一次 `_join`、換不同的 mode 即為切換。
 *    先前判定「SDK 無法設定 mode」是錯的 —— 它一直做得到，只是型別沒宣告。
 *
 * ⚠️ **mode 是對話層級的共用狀態，不是本地偏好。**
 *    切換會影響該對話的所有人，包含正在官方介面工作的同事。
 *    尤其切到 `automation` 會讓**所有人**的 Composer 都變成唯讀 ——
 *    UI 上必須讓客服意識到這一點。
 */

import { z } from 'zod'
import { controlFromMode } from '../../../../shared/types/conversation.js'
import {
  loadConversationContext,
  requireTeamConversationId,
} from '../../../services/conversation-context.js'
import { useCopilotRuntime } from '../../../services/copilot-runtime.js'
import { setConversationMode } from '../../../services/imbrace.js'
import { snapshotOf } from '../../../services/presence.js'
import { useEventBus, useStateStore } from '../../../state/index.js'
import { conversationTopic } from '../../../state/types.js'
import { conversationIdParam } from '../../../utils/conversation-param.js'
import { imbraceClientFor } from '../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../utils/session.js'
import { readBodyAs } from '../../../utils/validate.js'

const Body = z.object({
  mode: z.enum(['manual', 'hybrid', 'automation']),
})

export default defineEventHandler(async (event) => {
  const conversationId = conversationIdParam(event)
  const { mode } = await readBodyAs(event, Body)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  await setConversationMode(client, requireTeamConversationId(ctx), mode)

  const store = useStateStore()
  const control = controlFromMode(mode)
  const bus = useEventBus()

  /*
    左欄「你在此對話中」的判定快取（§10.2.1）—— 切換 mode 會讓既有的快取項過期
    （它以「解析當下的 mode」當失效訊號），寫穿可以省掉下一次輪詢的一次補查。

    ⚠️ 切成 `automation` **不等於離開** —— 那是 Automation Only（唯讀），人還在裡面
       （§10.6）。因此 `joined` 沿用剛剛查到的 `ctx.viewerJoined`，
       MUST NOT 因為 mode 變成 automation 就寫成 false。
  */
  await store.setViewerJoined(session.operatorId, ctx.id, { joined: ctx.viewerJoined, mode })

  await bus.publish(conversationTopic(ctx.id), {
    type: 'control.updated',
    conversationId: ctx.id,
    control,
  })
  await bus.publish(conversationTopic(ctx.id), {
    type: 'presence.updated',
    conversationId: ctx.id,
    presence: await snapshotOf(store, ctx.id, { mode }),
  })

  void useCopilotRuntime(session.orgId).listPoller.tick()

  return { conversationId: ctx.id, control }
})
