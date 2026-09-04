/**
 * 結案草稿的唯讀欄位 —— **`draft` 與 `commit` 兩支端點共用的同一段計算**
 * （契約 R3.7、FR-010a）。
 *
 * ⚠️⚠️ **這支存在的唯一理由是「只能有一份」。**
 *      契約 R3.7 要求 `commit` 端點把唯讀欄位**重新計算**、忽略 request body 帶來的值 ——
 *      而「重新計算」若在 commit 裡另寫一份，兩份遲早會分岔：
 *      客服在面板上看到的情緒區間是 A，寫進 CRM 的是 B，
 *      **兩份都合法、都不報錯**，而 SC-006b 的重算驗證會永遠對不起來。
 *
 * ⚠️ 只靠前端 `disabled` 是擋不住的（那是 UI 的禮貌，不是授權判斷）。
 *    唯讀欄位「真的唯讀」的實作方式就是這裡：**server 自己算，前端送什麼都不看**。
 */

import type { ClosureDraftReadonly } from '../../../shared/types/copilot.js'
import type { ConversationContext } from '../conversation-context.js'
import type { CopilotAnalysisState, CopilotSession } from '../../state/types.js'
import { sentimentRange } from './sentiment-range.js'

export interface ReadonlyFieldsInput {
  ctx: ConversationContext
  /** `null` ＝ 這個對話還沒有分析狀態（剛 JOIN、客戶尚無發言）—— 情緒三數值一起留空 */
  analysis: CopilotAnalysisState | null
  /** `null` ＝ process 重啟後 session 已不在記憶體 —— `joinedAt` 退回 `periodStart` */
  session: CopilotSession | null
  periodStart: string
  /** 發起這次結案的客服 —— 一定算在 `operators` 裡 */
  operatorId: string
  /** 模型自陳的把握度；無真實依據時為 null（憲法 4.4） */
  confidence: number | null
}

export function computeReadonlyFields(input: ReadonlyFieldsInput): ClosureDraftReadonly {
  const { ctx, analysis, session, periodStart, operatorId } = input

  const range = sentimentRange(analysis?.sentimentBlock.timeline ?? [], periodStart)

  return {
    operators: serviceOperators(session, operatorId),
    joinedAt: joinedAtOf(session, periodStart),
    // ⚠️ `closedAt` 一律由 **commit 端點**在寫入當下填（FR-013）。
    //    草稿階段它必須是 null —— 給一個「預計的結案時間」等於在紀錄上留下
    //    一個從未發生過的時間點，而那不會報錯。
    closedAt: null,
    sentimentStart: range.start,
    sentimentEnd: range.end,
    sentimentTrough: range.trough,
    sentimentNote: range.note,
    channel: ctx.channel,
    contactId: ctx.contactId,
    confidence: input.confidence,
  }
}

/**
 * 這段服務有哪些客服參與。
 *
 * ⚠️ **MUST NOT 用 `ctx.operators`** —— 那是**團隊名冊**不是對話參與者（§10.2 二次實測：
 *    兩個不同對話的 `users[]` 是同一批 14 人，含 Bot 與 observer）。
 *    拿它當參與者，每一份結案報告的 `operators` 都會是同一份全公司名單，
 *    而報表上看不出哪裡不對。
 *
 * ⚠️ 我方唯一知道的是「誰的連線正在看這個對話」（`CopilotSession.watchers`）。
 *    這是誠實但不完整的：process 重啟前就離開的同事不會在裡面。
 *    憲法 4.5 的精神是**寧可少，不可猜** —— 補上一份猜出來的名單比留白更糟。
 */
function serviceOperators(session: CopilotSession | null, operatorId: string): string[] {
  const ids = new Set<string>([operatorId])
  for (const w of session?.watchers ?? []) ids.add(w.operatorId)
  return [...ids]
}

/**
 * ⚠️ **平台沒有給我們「這位客服何時 JOIN」的時間戳**，`StateStore` 也沒有記
 *    （JOIN 紀錄是一個 Set，沒有時間；presence 的 `at` 每 20 秒被心跳刷新，
 *    那是「最後一次心跳」不是「加入時間」）。
 *
 *    現有資料裡最接近的是 `CopilotSession.createdAt` —— 這個對話的 Copilot session
 *    被建立的時刻，也就是**第一條連線開始檢視它**的時刻。
 *
 * ⚠️ 取不到時退回 `periodStart`（這段服務的起點），**MUST NOT 退回 `now`** ——
 *    `now` 會讓每一份重啟後產生的報告都寫著「剛剛才加入」，而那是編造的。
 *    退回區間起點至少是一個真實發生過、而且語意相近的時間。
 */
function joinedAtOf(session: CopilotSession | null, periodStart: string): string {
  return session ? new Date(session.createdAt).toISOString() : periodStart
}
