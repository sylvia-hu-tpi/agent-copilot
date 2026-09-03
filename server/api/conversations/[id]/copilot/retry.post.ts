/**
 * 手動重試單一區塊 —— FR-008，specs/001-sentiment-panel/contracts/copilot-retry-api.md。
 *
 * ⚠️ 非同步：202 立即回應，不等分析完成才回——同步等待的話客服按下重試後
 *    最長要等 40 秒（FR-014 重試預算）才有 UI 回饋，違反「AI 故障不得拖慢主線」的精神。
 *    結果透過既有 `summary.updated`／`sentiment.updated` SSE 事件送達。
 *
 * ⚠️ 授權沿用既有 session 驗證，不另設「誰能重試」的權限層——面板對所有正在檢視
 *    該對話的客服共享同一份 `CopilotAnalysisState`，比照該對話本身的協同精神。
 */

import { z } from 'zod'
import { controlFromMode } from '../../../../../shared/types/conversation.js'
import { retryBlock } from '../../../../services/copilot-analysis.js'
import { useCopilotRuntime } from '../../../../services/copilot-runtime.js'
import { fetchLatest } from '../../../../sources/message-fetch.js'
import { useStateStore } from '../../../../state/index.js'
import { conversationIdParam } from '../../../../utils/conversation-param.js'
import { imbraceClientFor } from '../../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../../utils/session.js'
import { readBodyAs } from '../../../../utils/validate.js'

const Body = z.object({
  block: z.enum(['summary', 'sentiment', 'suggestions']),
})

export default defineEventHandler(async (event) => {
  const conversationId = conversationIdParam(event)
  const { block } = await readBodyAs(event, Body)
  const session = await requireActiveBffSession(event)

  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state) {
    throw createError({ statusCode: 404, message: '這個對話尚無任何分析結果，無法重試' })
  }

  const targetStatus = block === 'summary'
    ? state.summaryBlock.status
    : block === 'sentiment'
      ? state.sentimentBlock.status
      : state.suggestionBlock.status
  if (targetStatus !== 'error') {
    throw createError({
      statusCode: 409,
      message: `${block} 目前不是 error 狀態（現為 ${targetStatus}），重試請求被忽略`,
    })
  }

  const client = imbraceClientFor(session)
  const aiReplies = controlFromMode(
    useCopilotRuntime(session.orgId).listPoller.latest(conversationId)?.mode,
  ).aiReplies
  void (async () => {
    try {
      const history = await fetchLatest(client, conversationId)
      await retryBlock(conversationId, block, history, aiReplies)
    }
    catch (err) {
      console.error(`[copilot-analysis] ${conversationId} ${block} 手動重試取歷史失敗:`, err instanceof Error ? err.message : String(err))
    }
  })()

  setResponseStatus(event, 202)
  return { conversationId, block }
})
