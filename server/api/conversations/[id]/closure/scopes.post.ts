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
  cachedPageFetcher,
  countByCandidate,
  defaultIndex,
  messagePageFetcher,
  oldestMessageAt,
} from '../../../../services/closure/period.js'
import type { ClosureScopesResponse } from '../../../../../shared/types/copilot.js'
import { listClosuresFor } from '../../../../services/closure/board-repository.js'
import { conversationIdParam } from '../../../../utils/conversation-param.js'
import { imbraceClientFor } from '../../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../../utils/session.js'
import { requireClosureBoardId } from '../../../../services/closure/config.js'

// ⚠️ 回傳型別 MUST 標註 —— store 是以 `$fetch<ClosureScopesResponse>()` 斷言的，
//    沒有這個註記，兩邊分岔時哪一邊都不會報錯（見該型別的說明）。
export default defineEventHandler(async (event): Promise<ClosureScopesResponse> => {
  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)
  const boardId = requireClosureBoardId()

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  /*
    ⚠️ **一個分頁快取餵兩種掃描**（2026-09-08 改）。`oldestMessageAt()` 與
       `countByCandidate()` 都從 `skip=0` 由新往舊翻同一段歷史，以前各翻各的 ——
       長期客戶開一次面板最多 15 次串行分頁請求，其中 5 次純屬重複。
       共用快取後上限降到 10 次，而且下面的則數掃描幾乎全部命中快取。
  */
  const pages = cachedPageFetcher(messagePageFetcher(client, ctx.id))

  /*
    ⚠️ 最舊一則的掃描與 Board 查詢**互不相依，一律併行**：以前是串行 await，
       Board 那一趟的往返時間白白加在面板開啟的等待上。

    ⚠️ 取不到（對話完全沒有訊息）時用 `now`：此時 fallback 的則數會是 0，
       畫面上會誠實地顯示「0 則」而不是一個編出來的日期。
  */
  const [oldestAt, closuresResult] = await Promise.all([
    oldestMessageAt(pages),
    // R1.4：查詢失敗是失敗，不是「沒有結案紀錄」—— 但 MUST NOT 讓它在這裡逸出，
    // 否則另一條 promise 的 rejection 會變成 unhandled（兩條都在飛）
    listClosuresFor(client, boardId, ctx.id)
      .then(rows => ({ ok: true as const, rows }))
      .catch((err: unknown) => ({ ok: false as const, err })),
  ])

  if (!closuresResult.ok) {
    throw createError({
      statusCode: 502,
      message: '無法載入結案紀錄',
      data: {
        reason: closuresResult.err instanceof Error
          ? closuresResult.err.message
          : String(closuresResult.err),
      },
    })
  }
  const closures = closuresResult.rows
  const firstMessageAt = oldestAt ?? new Date().toISOString()

  const set = buildCandidates(
    closures,
    firstMessageAt,
    id => (id ? operatorName(session.orgId, id) ?? id : ''),
  )

  // ⚠️ **一趟**掃完所有候選與 fallback 的則數（憲法 6.4）。
  //    `pages` 是上面那趟掃描的快取，這裡多半不會再打任何請求。
  const counts = await countByCandidate(
    pages,
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
