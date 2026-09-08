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
import { CLOSURE_PERIOD_ORIGINS } from '../../../../../shared/types/copilot.js'
import type { ClosureDraft, ClosureDraftAiPart } from '../../../../../shared/types/copilot.js'
import type { KnowledgeHit } from '../../../../../shared/types/knowledge.js'
import { useAIProvider } from '../../../../services/ai/index.js'
import { parseClosureDraftAiPart } from '../../../../services/ai/schemas.js'
import { toCitedSops } from '../../../../services/closure/cited-sops.js'
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
import { readBodyAs } from '../../../../utils/validate.js'

const Body = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodOrigin: z.enum(CLOSURE_PERIOD_ORIGINS),
})

export default defineEventHandler(async (event): Promise<ClosureDraft> => {
  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)

  // ⚠️ 走共用的 `readBodyAs()`（`server/utils/validate.ts`）而非自己 safeParse ——
  //    它會補上欄位名（「periodStart：Invalid datetime」），自己寫的那版只回一句
  //    籠統的「格式不正確」，而客服看到的是「寫入失敗、可重試」，重試永遠一樣失敗。
  const { periodStart, periodOrigin } = await readBodyAs(event, Body)

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  /*
    ⚠️ 取消 MUST 真的中止在途的呼叫（R2.9），MUST NOT 只是把畫面關掉 ——
       後者的呼叫照送、錢照付、結果無人看，且不會報錯。
       前端 abort 掉 fetch → 這條 HTTP 連線關閉 → `res` 的 `close` → 這個 controller abort。

    ⚠️⚠️ **監聽的 MUST 是 `event.node.res`，MUST NOT 是 `event.node.req`**（2026-09-08 修）。
         Node（實測 v24.19）的 `IncomingMessage` 在 **body 被讀完的當下**就發出 `close`，
         而 `readBody()` 已經在上面讀完了 —— 之後才掛的 listener **永遠不會觸發**，
         於是「取消結案」從來沒有真的中止過任何 AI 呼叫，下面那條 499 分支不可達。
         把 listener 移到 `readBody()` **之前**也是錯的：那樣每一個正常請求都會 abort。
         `res` 的 `close` 才是「客戶端斷線」的訊號，並用 `writableEnded` 排除正常結束。

    ⚠️ 能做到的那一半是誠實的那一半：SDK 沒有暴露 `AbortSignal`，
       已經送出的 AI 呼叫取消不了（004 research #2 同一個限制）。
  */
  const cancel = new AbortController()
  const res = event.node.res
  res.on('close', () => {
    if (!res.writableEnded) cancel.abort()
  })

  // ⚠️ 快照 MUST 在**本次請求內**取得（R2.1）。每次呼叫 ＝ 一次新快照 ＝ 一個新 draftId
  const { messages: history, truncated: periodTruncated } = await fetchPeriodMessages(client, ctx.id, periodStart)

  /*
    ⚠️ **`firstCustomerAt` 是情緒涵蓋判定唯一正確的比較對象**（見 `sentiment-range.ts` 檔頭）。
       只有客戶的文字發言會產生評分點，因此取的是第一則**客戶文字發言**而非第一則訊息。
       它與 `messageCount` 同屬「本次快照的事實」，隨草稿回給前端、由前端在 commit 時帶回
       —— `commit.post.ts` 不得 import 任何取數模組（守衛 G1），自己算不出來。
  */
  const customerTexts = history.filter(isTextCustomerMessage)
  const firstCustomerAt = customerTexts[0]?.at ?? null

  /*
    知識庫檢索 —— 比照 `server/services/blocks/suggestion.ts` 的用法：以客戶的文字發言組 query。

    ⚠️⚠️ **檢索結果直接成為 `citedSops`，不經過模型**（2026-09-08 改）。
         結案 agent 的 system prompt 逐字列出「不要輸出 citedSopIds —— 由系統填入」，
         因此舊寫法（把命中當白名單去過濾模型的輸出）永遠在過濾一個空清單：
         正式環境的欄位恆為空、面板區塊恆不顯示，只有退回 Mock 的環境看得到值。
         面板只提供「移除」而沒有「新增」，本來就是為「系統先填、客服再刪」設計的。
         ⚠️ 對外文案 MUST 是「相關的知識庫來源」而非「引用的」—— 模型沒看過這份清單。

    ⚠️ 因此檢索與 AI 呼叫**互不相依，一律並行**。舊寫法是串行 await，
       每次產生草稿都先白等一次檢索（數百毫秒到數秒）才開始 AI 呼叫，
       那段時間直接加在 SC-004 量到的中位數上。

    ⚠️ 檢索失敗**不**讓整份草稿失敗：退回空清單是誠實的降級（憲法 4.3 的同一個精神）。
  */
  const query = customerTexts.map(m => m.text).join('\n')

  let knowledgeHits: KnowledgeHit[] = []
  let aiPart: ClosureDraftAiPart
  try {
    const [hits, raw] = await Promise.all([
      searchKnowledge(query, ctx.id),
      useAIProvider().summarizeClosure({
        history,
        vocabulary: CLOSURE_VOCABULARY,
        signal: cancel.signal,
      }),
    ])
    knowledgeHits = hits
    // 憲法 4.2／4.6：受控詞彙的白名單後驗在這裡，不在 provider 裡
    aiPart = parseClosureDraftAiPart(raw, CLOSURE_VOCABULARY)
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
  // ⚠️ 兩筆讀取互不相依 —— 併行。記憶體 store 下只差兩個 microtask，
  //    但 M4 換 Redis 後每次產生草稿都要付兩次跨機往返（§8.3）。
  const [analysis, copilotSession] = await Promise.all([
    store.getAnalysisState(ctx.id),
    store.getCopilotSession(ctx.id),
  ])
  const readonly = computeReadonlyFields({
    ctx,
    analysis,
    session: copilotSession,
    periodStart,
    firstCustomerAt,
    operatorId: session.operatorId,
    operatorLabel: session.operatorName,
    orgId: session.orgId,
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
      /*
        快照的則數就是這次真正涵蓋的則數 —— 與候選清單的估算是兩件事。

        ⚠️ 但**收滿掃描上限時 MUST 是 `null` ＋ `truncated: true`**（2026-09-04 修）：
           Board 的 `period_message_count` 逐字定義是「留空 ＝ 超過 500 則的掃描上限，
           數不完（不是 0）」，回報 `500 / truncated:false` 等於在紀錄上寫一個
           數不完卻看起來精確的數字。UI 那側也靠 `truncated` 才分得出
           「超過 500 則」與「尚未算出」。
      */
      ...(periodTruncated
        ? { messageCount: null, truncated: true }
        : { messageCount: history.length, truncated: false }),
      firstCustomerAt,
    },
    summary: aiPart.summary,
    intent: aiPart.intent,
    category: aiPart.category,
    resolution: aiPart.resolution,
    actionsTaken: aiPart.actionsTaken,
    sentimentOutcome: aiPart.sentimentOutcome,
    /*
      ⚠️ 由系統填入，不是模型挑的 —— 見上方檢索那一段。
      ⚠️ **MUST 經 `toCitedSops()`**：同一份文件命中多段就是多筆 `KnowledgeHit`，
         直接 `.map()` 會讓同一個來源在清單裡出現兩次（見該檔說明）。
      ⚠️ 這裡帶 `title` 是因為畫面上要顯示檔名；Board 的 `cited_sops` 仍只存 id，
         由前端在 commit 時 `.map(s => s.id)` 落回去。
    */
    citedSops: toCitedSops(knowledgeHits),
    followUps: aiPart.followUps,
    readonly,
  }
})

/**
 * 知識庫檢索 —— **這支永遠不拋錯**，失敗時退回空清單並留一行日誌。
 *
 * ⚠️ 它與 AI 呼叫一起進 `Promise.all()`，若讓它拋出去，檢索失敗會連帶讓
 *    一份已經產生成功的摘要變成 502。降級的是引用清單，不是整份草稿。
 * ⚠️ 不記錄 `query`（憲法 1.5：那是客戶對話個資）；錯誤訊息本身不含 query，
 *    記它才能事後歸因。
 */
async function searchKnowledge(query: string, conversationId: string): Promise<KnowledgeHit[]> {
  if (!query.trim()) return []
  try {
    return await useKnowledgeProvider().search(query, { topK: 5 })
  }
  catch (err) {
    console.warn(`[closure] 知識庫檢索失敗，改以空集合續行（conversation=${conversationId}）：${errText(err)}`)
    return []
  }
}

/** ⚠️ 只取訊息本身，不帶 stack、不帶請求 body —— 憑證與個資都可能在裡面（FR-035） */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
