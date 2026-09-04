/**
 * 涵蓋區間的候選清單（契約 `closure-http-api.md` §1、FR-021 系列）。
 * **面板開啟時呼叫一次**；重試時再呼叫。
 *
 * ⚠️ **無狀態**：`baselineAt` 與 `closureBaseline` 回給前端保存，server 端**不記**
 *    （記了就等於 server 端存了結案流程的狀態，而 FR-040「重新整理等同取消」
 *    就得靠額外的清理邏輯成立 —— 清理漏掉時不會報錯）。
 *
 * ⚠️ **查詢失敗 MUST 回 502，MUST NOT 回一個只有 `fallback` 的 200**（R1.4）。
 *    「Board 查不到」與「這個對話從未結案」在畫面上是完全不同的兩件事：
 *    前者要重試按鈕，後者要「預設從第一則起算」的告知。
 *    用 200 帶空陣列表達失敗，會讓長期客戶的報告安靜地涵蓋整個聊天室歷史。
 */

import { loadConversationContext } from '../../../../services/conversation-context.js'
import { operatorName } from '../../../../services/directory.js'
import {
  buildCandidates,
  countByCandidate,
  defaultIndex,
  messagePageFetcher,
} from '../../../../services/closure/period.js'
import { listClosuresFor } from '../../../../services/closure/board-repository.js'
import { fetchLatest } from '../../../../sources/message-fetch.js'
import { conversationIdParam } from '../../../../utils/conversation-param.js'
import { imbraceClientFor } from '../../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../../utils/session.js'
import { requireClosureBoardId } from '../../../../services/closure/config.js'

export default defineEventHandler(async (event) => {
  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)
  const boardId = requireClosureBoardId()

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  /*
    最舊的一則訊息 —— `fallback`（「從第一則對話起算」）的起點，
    也是「自訂起算時間」彈窗的可選下界。

    ⚠️ 取不到（對話完全沒有訊息）時用 `now`：此時 fallback 的則數會是 0，
       畫面上會誠實地顯示「0 則」而不是一個編出來的日期。
  */
  const firstMessageAt = await oldestMessageAt(client, ctx.id)

  let closures
  try {
    closures = await listClosuresFor(client, boardId, ctx.id)
  }
  catch (err) {
    // R1.4：查詢失敗是失敗，不是「沒有結案紀錄」
    throw createError({
      statusCode: 502,
      message: '無法載入結案紀錄',
      data: { reason: err instanceof Error ? err.message : String(err) },
    })
  }

  const set = buildCandidates(
    closures,
    firstMessageAt,
    id => (id ? operatorName(session.orgId, id) ?? id : ''),
  )

  // ⚠️ **一趟**掃完所有候選與 fallback 的則數（憲法 6.4）
  const counts = await countByCandidate(
    messagePageFetcher(client, ctx.id),
    [...set.candidates.map(c => c.start), set.fallback.start],
  )
  const all = [...set.candidates, set.fallback]
  all.forEach((c, i) => {
    c.messageCount = counts[i]!.messageCount
    c.truncated = counts[i]!.truncated
  })

  return {
    candidates: set.candidates,
    fallback: set.fallback,
    overflowCount: set.overflowCount,
    // ⚠️ MUST NOT 單純回 0（R1.2）—— 最上面那個常常是「上次結案後 0 則」
    defaultIndex: defaultIndex(set.candidates),
    firstMessageAt,
    // FR-034 的基準線：前端原樣保存並在 commit 時帶回
    baselineAt: new Date().toISOString(),
    closureBaseline: closures.map(c => c.recordId),
  }
})

/**
 * 這個對話最舊一則訊息的時間。
 *
 * ⚠️ 走 `skip` 分頁往回翻到底 —— 平台**不支援**「取最舊 N 則」，
 *    而 `fetchLatest()` 的 `limit` 是從最新算起。上限與掃描上限同源，
 *    超過時取「掃得到的最舊那一則」：對長期客戶而言 fallback 本來就會是
 *    `truncated`（「超過 500 則」），起點稍晚不影響那個呈現。
 */
async function oldestMessageAt(
  client: ReturnType<typeof imbraceClientFor>,
  conversationId: string,
): Promise<string> {
  const PAGE = 100
  const MAX_PAGES = 10
  let oldest: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const chunk = await fetchLatest(client, conversationId, { limit: PAGE, skip: page * PAGE })
    if (chunk.length === 0) break
    oldest = chunk[0]!.at
    if (chunk.length < PAGE) break
  }
  return oldest ?? new Date().toISOString()
}
