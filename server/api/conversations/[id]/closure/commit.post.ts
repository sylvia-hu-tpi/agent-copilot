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
import { CLOSURE_PERIOD_ORIGINS } from '../../../../../shared/types/copilot.js'
import type { ClosureCommitResponse } from '../../../../../shared/types/copilot.js'
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
import { readBodyAs } from '../../../../utils/validate.js'

/**
 * ⚠️ 受控詞彙一律由 `config/categories.ts` 建 `z.enum`，**MUST NOT 在這裡再抄一份**
 *    字面聯集（憲法 4.6）。抄一份的那一刻，設定檔就從「唯一來源」退化成副本，
 *    而分岔的症狀是「新增的分類永遠送不進去」，且不會報錯。
 * ⚠️ 空字串是合法值：模型挑不到、客服也沒補時該欄位就是留空（FR-015）。
 *
 * ⚠️ **不要為了消 TS 錯誤而加 `as unknown as readonly [string, ...string[]]`**
 *    （2026-09-08 移除四處）。zod 3.25 直接吃 `as const` 的唯讀 tuple
 *    （`ai/schemas.ts` 的 `z.enum(SENTIMENT_LABELS)` 一直都這樣寫）。
 *    那四個轉型會把推斷型別放寬成 `string`，於是 `resolution`／`sentimentOutcome`
 *    又各得補一個 `as ClosureSummary[...]` 把它斷言回來 —— 而那是**未經檢查**的斷言：
 *    `config/categories.ts` 與 `ClosureSummary` 哪天分岔，typecheck 仍然全綠。
 *    拿掉轉型後，字面聯集一路從設定檔流到 `ClosureSummary`。
 */
const enumOrEmpty = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.literal('')])

const Body = z.object({
  // `draft.post.ts` 以 `crypto.randomUUID()` 產生，合法來源只有那一處；
  // 形狀不對的直接 400，不讓任意字串走進冪等查詢當鍵
  draftId: z.string().uuid(),
  periodStart: z.string().datetime({ offset: true }),
  periodOrigin: z.enum(CLOSURE_PERIOD_ORIGINS),
  periodMessageCount: z.number().int().nonnegative().nullable(),
  /**
   * 區間內第一則客戶文字發言的時間 —— 情緒涵蓋判定的比較對象。
   *
   * ⚠️ 與 `periodMessageCount` 一樣是**本次快照的事實**，由 `draft` 端算好、前端原樣帶回。
   *    本檔不得 import 任何取數模組（契約 R3.3、守衛 G1），因此無法自己重算。
   */
  periodFirstCustomerAt: z.string().datetime({ offset: true }).nullable(),
  summary: z.string().min(1),
  intent: z.string().min(1),
  category: enumOrEmpty(CATEGORIES),
  resolution: enumOrEmpty(RESOLUTIONS),
  actionsTaken: z.array(z.enum(ACTIONS_TAKEN)),
  sentimentOutcome: enumOrEmpty(SENTIMENT_OUTCOMES),
  citedSopIds: z.array(z.string()),
  followUps: z.array(z.object({
    action: z.string().min(1),
    owner: z.string().optional(),
    dueHint: z.string().optional(),
  })),
  baselineAt: z.string().datetime({ offset: true }),
  closureBaseline: z.array(z.string()),
})

// ⚠️ 回傳型別 MUST 標註 —— 理由同 `scopes.post.ts`
export default defineEventHandler(async (event): Promise<ClosureCommitResponse> => {
  // ⚠️ FR-035a／R3.14：**請求進入時**就產生，MUST NOT 只在出錯時產生 ——
  //    那樣看不到出錯之前的兩步，而 B8 要判斷的正是那兩步。
  const reqId = crypto.randomUUID().slice(0, 8)

  const conversationId = conversationIdParam(event)
  const session = await requireActiveBffSession(event)
  const boardId = requireClosureBoardId()

  /*
    ⚠️ 走共用的 `readBodyAs()` 並把 `reqId`／`failKind` 交給它（FR-035a、R3.14）——
       自己 safeParse 的那版少了欄位名，客服只會看到「寫入失敗、可直接重試」，
       而重試送的是一模一樣的 body，永遠一樣失敗。最常見的觸發是
       「按了新增後續事項但沒填內容」，畫面上沒有任何地方指得出那一列。
       前端另有停用寫入鍵的守門（`ClosureBlock.vue`），這裡是第二道。
  */
  const body = await readBodyAs(event, Body, { data: { reqId, failKind: 'failed' } })

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, conversationId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話', data: { reqId } })

  const store = useStateStore()
  // ⚠️ 兩筆讀取互不相依 —— 併行。記憶體 store 下只差兩個 microtask，
  //    但 M4 換 Redis 後每次寫入都要付兩次跨機往返，而這條路徑有 30 秒硬上界在算時間。
  const [analysis, copilotSession] = await Promise.all([
    store.getAnalysisState(ctx.id),
    store.getCopilotSession(ctx.id),
  ])
  // ⚠️ 與 `draft.post.ts` **共用同一支** `computeReadonlyFields()`（R3.7）——
  //    在這裡另寫一份的話，客服看到的與寫進 CRM 的會分岔，兩份都不報錯
  const readonly = computeReadonlyFields({
    ctx,
    analysis,
    session: copilotSession,
    periodStart: body.periodStart,
    firstCustomerAt: body.periodFirstCustomerAt,
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
    // ── 以下八項由 server 重算，body 帶來的一律忽略（R3.7）；`confidence` 是第九項 ──
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
    // ⚠️ 這裡不需要 `as` —— `enumOrEmpty()` 沒有轉型後，字面聯集直接對得上（見 Body 上方說明）
    resolution: body.resolution,
    actionsTaken: body.actionsTaken,
    sentimentOutcome: body.sentimentOutcome,
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
    /*
      ⚠️ 回的是**這次寫入實際用的值**（`session.operatorId`／`now`），不是
         `summary.reviewedBy`／`summary.reviewedAt`。兩者內容相同，但後者的型別是
         `string | null`（`ClosureSummary` 允許「未經人審」的紀錄留空，憲法 5.2），
         而這支端點的回應永遠有值 —— 用後者會逼呼叫端處理一個不可能發生的 null。
    */
    reviewedBy: session.operatorId,
    reviewedAt: now,
    created: result.created,
    reqId,
    newClosuresSincePanelOpen,
  }
})
