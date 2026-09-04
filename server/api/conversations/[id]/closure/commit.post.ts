/**
 * 寫入 Data Board —— **本規格唯一會寫入正式紀錄的端點**（契約 §3、FR-030～FR-035a）。
 *
 * ⚠️⚠️ **本檔 MUST NOT import 任何訊息取數模組**（契約 R3.3、守衛 G1）。
 *      「送出時取最新」與「取當初的快照」在型別上完全相同，兩者都是 `Message[]` ——
 *      這條規則是 FR-020 的快照語意唯一會變紅的地方。摘要一旦被實作成寫入時重取，
 *      客服看過的內容與寫進 CRM 的內容會不一樣，而畫面上分不出來。
 *
 * ⚠️ **本檔 MUST NOT 呼叫 LEAVE，也 MUST NOT 變更平台對話狀態**（R3.9）。
 *    LEAVE 由前端在收到 200 之後另外呼叫既有的 `/leave` —— 串在一起的話，
 *    LEAVE 失敗就無從表達「紀錄已寫入、只是還沒離開」那個狀態（FR-033、FR-047b）。
 *
 * ⚠️ **`reviewedBy`／`reviewedAt` 由 server 依 session 填**（R3.6、憲法 7.5）。
 *    從 body 取等於讓稽核欄位可偽造 —— 而稽核軌跡正是本規格的產品價值本體。
 *
 * ⚠️ **唯讀欄位由 server 重算**（R3.7），request body 帶來的一律忽略。
 *    只靠前端 `disabled` 是擋不住的，而被改掉之後 SC-006b 的重算驗證會永遠對不起來。
 */

import { z } from 'zod'
import {
  ACTIONS_TAKEN,
  CATEGORIES,
  RESOLUTIONS,
  SENTIMENT_OUTCOMES,
} from '../../../../../config/categories.js'
import type { ClosureSummary } from '../../../../../shared/types/copilot.js'
import {
  ClosureWriteError,
  closuresSincePanelOpen,
  commitClosure,
  listClosuresFor,
} from '../../../../services/closure/board-repository.js'
import { requireClosureBoardId } from '../../../../services/closure/config.js'
import { computeReadonlyFields } from '../../../../services/closure/readonly-fields.js'
import { loadConversationContext } from '../../../../services/conversation-context.js'
import { operatorName } from '../../../../services/directory.js'
import { useStateStore } from '../../../../state/index.js'
import { conversationIdParam } from '../../../../utils/conversation-param.js'
import { imbraceClientFor } from '../../../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../../../utils/session.js'

/**
 * ⚠️ 受控詞彙一律由 `config/categories.ts` 建 `z.enum`，**MUST NOT 在這裡再抄一份**
 *    字面聯集（憲法 4.6）。抄一份的那一刻，設定檔就從「唯一來源」退化成副本，
 *    而分岔的症狀是「新增的分類永遠送不進去」，且不會報錯。
 * ⚠️ 空字串是合法值：模型挑不到、客服也沒補時該欄位就是留空（FR-015）。
 */
const enumOrEmpty = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.literal('')])

const Body = z.object({
  draftId: z.string().min(1),
  periodStart: z.string().datetime({ offset: true }),
  periodOrigin: z.enum(['closure', 'first', 'custom']),
  periodMessageCount: z.number().int().nonnegative().nullable(),
  summary: z.string().min(1),
  intent: z.string().min(1),
  category: enumOrEmpty(CATEGORIES as unknown as readonly [string, ...string[]]),
  resolution: enumOrEmpty(RESOLUTIONS as unknown as readonly [string, ...string[]]),
  actionsTaken: z.array(z.enum(ACTIONS_TAKEN as unknown as readonly [string, ...string[]])),
  sentimentOutcome: enumOrEmpty(SENTIMENT_OUTCOMES as unknown as readonly [string, ...string[]]),
  citedSopIds: z.array(z.string()),
  followUps: z.array(z.object({
    action: z.string().min(1),
    owner: z.string().optional(),
    dueHint: z.string().optional(),
  })),
  baselineAt: z.string().datetime({ offset: true }),
  closureBaseline: z.array(z.string()),
})

export default defineEventHandler(async (event) => {
  // ⚠️ FR-035a／R3.14：**請求進入時**就產生，MUST NOT 只在出錯時產生 ——
  //    那樣看不到出錯之前的兩步，而 B8 要判斷的正是那兩步。
  const reqId = crypto.randomUUID().slice(0, 8)

  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)
  const boardId = requireClosureBoardId()

  const parsedBody = Body.safeParse(await readBody(event))
  if (!parsedBody.success) {
    throw createError({
      statusCode: 400,
      message: '結案寫入的請求格式不正確',
      data: { reqId, failKind: 'failed' },
    })
  }
  const body = parsedBody.data

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話', data: { reqId } })

  const store = useStateStore()
  // ⚠️ 與 `draft.post.ts` **共用同一支** `computeReadonlyFields()`（R3.7）——
  //    在這裡另寫一份的話，客服看到的與寫進 CRM 的會分岔，兩份都不報錯
  const readonly = computeReadonlyFields({
    ctx,
    analysis: await store.getAnalysisState(ctx.id),
    session: await store.getCopilotSession(ctx.id),
    periodStart: body.periodStart,
    operatorId: session.operatorId,
    // ⚠️ 結案摘要沒有檢索分數可依據，`confidence` 全程為 null（憲法 4.4）
    confidence: null,
  })

  const now = new Date().toISOString()
  const summary: ClosureSummary = {
    // `recordId` 由倉儲在建立當下產生／沿用既有那筆，這裡只是佔位
    recordId: '',
    draftId: body.draftId,
    conversationId: ctx.id,
    periodStart: body.periodStart,
    periodMessageCount: body.periodMessageCount,
    periodOrigin: body.periodOrigin,
    // ── 以下六項由 server 重算，body 帶來的一律忽略（R3.7）──
    channel: readonly.channel,
    contactId: readonly.contactId,
    operators: readonly.operators,
    joinedAt: readonly.joinedAt,
    sentimentStart: readonly.sentimentStart,
    sentimentEnd: readonly.sentimentEnd,
    sentimentTrough: readonly.sentimentTrough,
    sentimentNote: readonly.sentimentNote,
    // ── 以下由 server 依 session 與當下時間填（R3.6）──
    closedAt: now,
    reviewedBy: session.operatorId,
    reviewedAt: now,
    // ── 以下是客服編輯後的版本（R3.2）——這正是本規格的存在理由 ──
    summary: body.summary,
    intent: body.intent,
    category: body.category,
    resolution: body.resolution as ClosureSummary['resolution'],
    actionsTaken: body.actionsTaken,
    sentimentOutcome: body.sentimentOutcome as ClosureSummary['sentimentOutcome'],
    citedSopIds: body.citedSopIds,
    followUps: body.followUps,
    confidence: readonly.confidence,
  }

  let result: { recordId: string, created: boolean }
  try {
    result = await commitClosure(client, boardId, summary, { reqId })
  }
  catch (err) {
    if (err instanceof ClosureWriteError) {
      // R3.8／R3.15：失敗一律非 2xx，且讓前端分得出兩種**呈現**（不是兩條狀態路徑）
      throw createError({
        statusCode: err.status,
        message: err.message,
        data: { failKind: err.failKind, reqId },
      })
    }
    throw createError({
      statusCode: 502,
      message: '結案寫入失敗',
      data: { failKind: 'failed', reqId },
    })
  }

  /*
    FR-034／R3.10：面板開啟後才出現的他人結案。

    ⚠️ 這是**告知不是攔截**：紀錄已經寫入、也已經回 200，這裡只是多給一句話。
       MUST NOT 做成需要確認的攔截、MUST NOT 暗示會覆蓋對方 ——
       同一通對話多筆結案紀錄是正常的（憲法 5.3）。
    ⚠️ 面板開啟當下就存在的結案 MUST NOT 出現在這裡：客服在候選清單上已經看過一次了。
    ⚠️ 查詢失敗**不**讓已成功的寫入變成失敗 —— 退回空陣列（少一句提示），
       而不是把一次成功報成失敗。
  */
  let newClosuresSincePanelOpen: Array<{ recordId: string, operatorName: string, closedAt: string }> = []
  try {
    const rows = await listClosuresFor(client, boardId, ctx.id)
    newClosuresSincePanelOpen = closuresSincePanelOpen(rows, body.closureBaseline, result.recordId)
      .map(c => ({
        recordId: c.recordId,
        operatorName: c.reviewedBy ? operatorName(session.orgId, c.reviewedBy) ?? c.reviewedBy : '',
        closedAt: c.closedAt,
      }))
  }
  catch {
    console.warn(`[closure] req=${reqId} 寫入成功但基準線比對失敗，略過 FR-034 的提示`)
  }

  return {
    recordId: result.recordId,
    reviewedBy: summary.reviewedBy,
    reviewedAt: summary.reviewedAt,
    created: result.created,
    reqId,
    newClosuresSincePanelOpen,
  }
})
