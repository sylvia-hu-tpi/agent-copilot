/**
 * 以指定區間取快照並產生結案摘要草稿（契約 §2、FR-020、FR-022）。
 * **改區間、按「重新產生」都呼叫這一支。**
 *
 * ⚠️ **本端點不設固定秒數上限**（契約 R2.9、SC-004）。耗時由涵蓋區間長度決定
 *    （實測短區間中位數 9.4 秒，長區間逾 1 分鐘可接受）。訂任何秒數都是錯的口徑。
 *    對應地，前端在等待期間 MUST 誠實：不顯示會過期的時間承諾、不在完成前顯示
 *    完成訊號、**全程可取消**。
 *    ⚠️ 這與寫入路徑的 30 秒硬逾時（FR-032a）是**兩個性質相反的預算**，
 *    MUST NOT 互相污染。
 *
 * ⚠️ **MUST NOT 接受任何訊息內容**（research #11）。前端只說「從哪裡起算」，
 *    訊息一律由 server 自己取 —— 讓前端送內容等於開一條可竄改「送給 AI 的對話內容」的路。
 *
 * ⚠️ 產生失敗 MUST 回 **502**，MUST NOT 回一份欄位全空的 200（R2.6）——
 *    後者會讓客服對著一張空表按下寫入，而畫面上看不出哪裡不對。
 */

import { z } from 'zod'
import { CLOSURE_VOCABULARY } from '../../../../../config/categories.js'
import type { ClosureDraft, ClosureDraftAiPart } from '../../../../../shared/types/copilot.js'
import { useAIProvider } from '../../../../services/ai/index.js'
import { parseClosureDraftAiPart } from '../../../../services/ai/schemas.js'
import { fetchPeriodMessages } from '../../../../services/closure/period.js'
import { computeReadonlyFields } from '../../../../services/closure/readonly-fields.js'
import { loadConversationContext } from '../../../../services/conversation-context.js'
/*
  ⚠️ 從**桶檔** `copilot-analysis.ts` 匯入，MUST NOT 直接 import
     `analysis-state.js` —— 那是分析管線的內部檔案，只有管線成員可以值 import 它
     （`test/contract-guards.test.ts`「分析管線的對外介面只有一個出口」）。
  ⚠️ 也 MUST NOT 在這裡自己寫一份「什麼算是客戶的文字發言」：
     它與情緒評分點的判定必須是同一個定義，兩份分岔不會報錯，
     只會讓知識庫檢索用的 query 與情緒時間軸涵蓋的訊息悄悄不一致。
*/
import { isTextCustomerMessage } from '../../../../services/copilot-analysis.js'
import { useKnowledgeProvider } from '../../../../services/knowledge/index.js'
import { useStateStore } from '../../../../state/index.js'
import { conversationIdParam } from '../../../../utils/conversation-param.js'
import { imbraceClientFor } from '../../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../../utils/session.js'

const Body = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodOrigin: z.enum(['closure', 'first', 'custom']),
})

export default defineEventHandler(async (event): Promise<ClosureDraft> => {
  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)

  const parsedBody = Body.safeParse(await readBody(event))
  if (!parsedBody.success) {
    throw createError({ statusCode: 400, message: '結案草稿的請求格式不正確' })
  }
  const { periodStart, periodOrigin } = parsedBody.data

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  /*
    ⚠️ 取消 MUST 真的中止在途的呼叫（R2.9），MUST NOT 只是把畫面關掉 ——
       後者的呼叫照送、錢照付、結果無人看，且不會報錯。
       前端 abort 掉 fetch → 這條 HTTP 連線關閉 → `req.on('close')` → 這個 controller abort。
    ⚠️ 能做到的那一半是誠實的那一半：SDK 沒有暴露 `AbortSignal`，
       已經送出的 AI 呼叫取消不了（004 research #2 同一個限制）。
  */
  const cancel = new AbortController()
  event.node.req.on('close', () => cancel.abort())

  // ⚠️ 快照 MUST 在**本次請求內**取得（R2.1）。每次呼叫 ＝ 一次新快照 ＝ 一個新 draftId
  const history = await fetchPeriodMessages(client, ctx.id, periodStart)

  /*
    知識庫檢索 —— 比照 `server/services/blocks/suggestion.ts` 的用法：
    以客戶的文字發言組 query。
    ⚠️ 檢索失敗**不**讓整份草稿失敗：`citedSopIds` 的白名單後驗會因此變成空集合，
       而空的引用清單是誠實的降級（憲法 4.3 丟棄不合格 id 的同一個精神）。
  */
  const query = history.filter(isTextCustomerMessage).map(m => m.text).join('\n')
  let knowledgeHits: Awaited<ReturnType<ReturnType<typeof useKnowledgeProvider>['search']>> = []
  if (query.trim()) {
    try {
      knowledgeHits = await useKnowledgeProvider().search(query, { topK: 5 })
    }
    catch {
      // ⚠️ 不記錄 query（憲法 1.5：那是客戶對話個資）
      console.warn(`[closure] 知識庫檢索失敗，改以空集合續行（conversation=${ctx.id}）`)
    }
  }

  let aiPart: ClosureDraftAiPart
  try {
    const raw = await useAIProvider().summarizeClosure({
      history,
      vocabulary: CLOSURE_VOCABULARY,
      knowledgeHits,
      signal: cancel.signal,
    })
    // 憲法 4.2／4.3／4.6：白名單後驗在這裡，不在 provider 裡
    aiPart = parseClosureDraftAiPart(raw, CLOSURE_VOCABULARY, knowledgeHits.map(h => h.id))
  }
  catch (err) {
    // 客服自己取消的不是失敗 —— 連線已經斷了，回什麼都沒人看
    if (err instanceof Error && err.name === 'AbortError') {
      throw createError({ statusCode: 499, message: '結案摘要產生已取消' })
    }
    // ⚠️ 錯誤訊息與日誌 MUST NOT 含訊息全文（R2.8、憲法 1.5）
    console.warn(`[closure] 摘要產生失敗（conversation=${ctx.id}）：${errText(err)}`)
    throw createError({ statusCode: 502, message: '結案摘要產生失敗', data: { reason: errText(err) } })
  }

  const store = useStateStore()
  const readonly = computeReadonlyFields({
    ctx,
    analysis: await store.getAnalysisState(ctx.id),
    session: await store.getCopilotSession(ctx.id),
    periodStart,
    operatorId: session.operatorId,
    confidence: aiPart.confidence,
  })

  return {
    // ⚠️ **由 server 產生**（data-model §2）：「重新產生 ＝ 新草稿 ＝ 新 id」與
    //    「寫入逾時後重試 ＝ 同一份 ＝ 同一個 id」的差別完全由它承載。
    //    前端若自己產生，這條規則就散在前端各處。
    draftId: crypto.randomUUID(),
    conversationId: ctx.id,
    period: {
      start: periodStart,
      origin: periodOrigin,
      // 快照的則數就是這次真正涵蓋的則數 —— 與候選清單的估算是兩件事
      messageCount: history.length,
      truncated: false,
    },
    summary: aiPart.summary,
    intent: aiPart.intent,
    category: aiPart.category,
    resolution: aiPart.resolution,
    actionsTaken: aiPart.actionsTaken,
    sentimentOutcome: aiPart.sentimentOutcome,
    citedSopIds: aiPart.citedSopIds,
    followUps: aiPart.followUps,
    readonly,
  }
})

/** ⚠️ 只取訊息本身，不帶 stack、不帶請求 body —— 憑證與個資都可能在裡面（FR-035） */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
