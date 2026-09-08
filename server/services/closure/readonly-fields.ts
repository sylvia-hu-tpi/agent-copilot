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
import type { CopilotAnalysisState, CopilotSession } from '../../state/types.js'
import { operatorName } from '../directory.js'
import { sentimentRange } from './sentiment-range.js'

export interface ReadonlyFieldsInput {
  /*
    ⚠️ **刻意只收 `channel` 與 `contactId` 這兩個欄位，而不是整個 `ConversationContext`。**

       本檔的檔頭與 `serviceOperators()` 都寫著「MUST NOT 用 `ctx.operators`」——
       那是**團隊名冊**不是對話參與者（§10.2）。把型別收窄之後，那條規則
       從「一句註解」變成 `tsc` 會擋下來的事：這裡根本看不到 `operators`。

    ⚠️ 順帶解掉一個型別層的相依：`conversation-context.ts` 用了 Nitro 的
       auto-import（`createError`），只要本檔 `import type` 它，
       `tsconfig.scripts.json` 底下的測試就沒辦法 import 本檔
       （那份設定沒有 Nitro 的全域宣告，會報 `Cannot find name 'createError'`）。
       改成結構型別後，呼叫端照樣傳整個 ctx，而本檔可以被單元測試直接驗。
  */
  ctx: { channel: string, contactId: string }
  /** `null` ＝ 這個對話還沒有分析狀態（剛 JOIN、客戶尚無發言）—— 情緒三數值一起留空 */
  analysis: CopilotAnalysisState | null
  /** `null` ＝ process 重啟後 session 已不在記憶體 —— `joinedAt` 退回 `periodStart` */
  session: CopilotSession | null
  periodStart: string
  /**
   * 區間內第一則客戶文字發言的時間（`ClosurePeriod.firstCustomerAt`）——
   * 情緒涵蓋判定的比較對象，理由見 `sentiment-range.ts` 檔頭。
   *
   * ⚠️ `commit` 端點自己算不出它（守衛 G1 禁止 import 取數模組），
   *    因此由 `draft` 端算好、經 request body 原樣帶回，比照 `periodMessageCount`。
   */
  firstCustomerAt: string | null
  /** 發起這次結案的客服 —— 一定算在 `operators` 裡 */
  operatorId: string
  /**
   * **發起這次結案的客服自己的顯示名**（`session.operatorName`）。
   *
   * ⚠️⚠️ **MUST 由 session 傳進來，MUST NOT 去名冊查**（2026-09-08 修，手動驗收抓到）。
   *      `server/services/directory.ts` 的名冊只裝得下
   *      `conversations.get()` 的 `users[]`（團隊名冊）—— **登入者自己不保證在裡面**，
   *      而且從來沒有任何路徑把自己寫進去（JOIN 走的是 presence 的
   *      `reportViewing({ id, name })`，不是 `rememberOperators()`）。
   *      於是「參與的客服」對**每一個人**都退回原始 `u_` id ——
   *      而那個退回路徑本身是對的（查不到就不編名字），所以不會報錯、也沒有紅燈。
   *
   * ⚠️ 我方對「登入的是誰」是有權威答案的，繞去問一份快取只可能失去資訊。
   *    這與 presence 的既有做法一致：`join.post.ts` 同樣是把
   *    `{ id: session.operatorId, name: session.operatorName }` 直接交出去。
   */
  operatorLabel: string | undefined
  /** 查**其他人**的顯示名用（`server/services/directory.ts` 的名冊是 org 層級的） */
  orgId: string
  /** 模型自陳的把握度；無真實依據時為 null（憲法 4.4） */
  confidence: number | null
}

export function computeReadonlyFields(input: ReadonlyFieldsInput): ClosureDraftReadonly {
  const { ctx, analysis, session, periodStart, operatorId } = input

  const range = sentimentRange(
    analysis?.sentimentBlock.timeline ?? [],
    periodStart,
    input.firstCustomerAt,
  )

  /*
    ⚠️ `operators`（id）與 `operatorLabels`（顯示名）**由同一個陣列產生**，
       因此兩者必然等長、必然對位。分兩處各算一次的話，只要其中一邊多濾掉一個人，
       畫面上第二位同事的名字就會掛到第三位頭上 —— 而那不會報錯。
  */
  const operators = serviceOperators(session, operatorId)

  return {
    operators,
    /*
      ⚠️ 查不到就回**原本的 id**（`?? id`），比照 `commit.post.ts` 對
         `newClosuresSincePanelOpen` 的既有做法。MUST NOT 編一個名字、
         也 MUST NOT 留空 —— 留空會讓「有這個人但查不到名字」看起來像「沒有這個人」。
    */
    operatorLabels: operators.map(id => labelFor(id, input)),
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
 * 一個客服 id 在畫面上該顯示什麼。
 *
 * 三層，優先序不可調換：
 *   ① **就是登入者自己** → 用 session 的顯示名（我方對這件事有權威答案）
 *   ② 其他人 → 查團隊名冊（`conversations.get()` 的 `users[]`，實測 `display_name` 全是 email）
 *   ③ 查不到 → **回原本的 id**，MUST NOT 留空、MUST NOT 編一個名字：
 *      「知道有這個人但不知道他叫什麼」與「沒有這個人」在畫面上必須不同（§10.2）
 *
 * ⚠️ ①MUST 排在 ②之前。名冊裡即使有自己那一筆，答案也相同；
 *    但名冊**沒有**自己那一筆是常態，而 ① 在那種情況下仍然答得出來。
 *
 * ⚠️ **同事（`watchers`）目前只有 ②③ 可用**，因此名冊沒收錄的同事仍會顯示 id。
 *    要一併解掉的話，來源是 presence 條目（`reportViewing()` 存過 `operatorName`），
 *    但那要把 store 傳進本函式並改成 async —— 尚未做，不要在這裡偷偷補一個猜出來的名字。
 */
function labelFor(id: string, input: ReadonlyFieldsInput): string {
  if (id === input.operatorId && input.operatorLabel) return input.operatorLabel
  return operatorName(input.orgId, id) ?? id
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
