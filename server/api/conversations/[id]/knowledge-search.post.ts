/**
 * 知識庫自然語言快查 —— specs/002-suggestion-knowledge-search/contracts/knowledge-search-api.md。
 *
 * 一次性 request/response，不經 SSE、不進 CopilotAnalysisState（research.md #7）——
 * 這是客服主動、即時的查詢動作，沒有「切走再切回還要保留結果」的需求。
 *
 * ⚠️ 憲法 3.1／3.2：這支端點 MUST NOT 回 5xx——`KnowledgeProvider.search()` 逾時或
 *    拋錯時捕捉並回傳 200 `{ hits: [], degraded: true }`，前端據此顯示「知識庫服務暫時
 *    無法使用」＋重試，而非「查無相關結果」。
 */

import { z } from 'zod'
import { useKnowledgeProvider } from '../../../services/knowledge/index.js'
import { resolveKnowledgeSearch } from '../../../services/knowledge/resolve-search.js'
import { isViewerJoined } from '../../../services/conversation-context.js'
import { imbraceClientFor } from '../../../utils/imbrace-client.js'
import { useStateStore } from '../../../state/index.js'
import { conversationIdParam } from '../../../utils/conversation-param.js'
import { requireActiveBffSession } from '../../../utils/session.js'
import { readBodyAs } from '../../../utils/validate.js'
import type { KnowledgeSearchResponse } from '../../../../shared/types/knowledge.js'

const Body = z.object({
  query: z.string(),
  /** 有值時 query 沿用原查詢字串，但限定在該 sourceRef.ref 對應的檔案內搜尋（「展開全文」） */
  expandRef: z.string().optional(),
})

export default defineEventHandler(async (event): Promise<KnowledgeSearchResponse> => {
  const conversationId = conversationIdParam(event)
  const { query, expandRef } = await readBodyAs(event, Body)
  const session = await requireActiveBffSession(event)

  // FR-025：JOIN 門檻。
  // ⚠️ 優先於空白查詢短路：未 JOIN 時無論查詢內容為何都不該使用本功能，
  //    不可讓空白輸入意外繞過這道門檻。
  // ⚠️ 走 isViewerJoined() 而非直接查 listJoinedConversations()——後者的記錄只有
  //    join.post.ts 會寫且存在記憶體裡，伺服器重啟後會與平台的持久 JOIN 不同步，
  //    症狀是「面板開著、分析在跑，但快查說我沒加入」。理由詳見該函式的說明。
  const ok = await isViewerJoined(
    useStateStore(),
    imbraceClientFor(session),
    session.orgId,
    session.operatorId,
    conversationId,
  )
  if (!ok) throw createError({ statusCode: 403, message: '需先加入對話' })

  return resolveKnowledgeSearch(query, () => useKnowledgeProvider().search(query, { topK: 5, fileId: expandRef }))
})
