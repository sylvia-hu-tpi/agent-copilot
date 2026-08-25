/**
 * 送出訊息 + **送出前的樂觀併發檢查** —— docs/ARCHITECTURE.md §10.4。
 *
 * ── 這是整套協同設計中唯一真正有效的一層 ─────────────────────────
 * Presence 會有盲區、JOIN 意圖廣播是勸告式的、平台根本沒有排他鎖。
 * 只有「按下送出的當下才比對版本錨點」這一層，能真正防止客戶收到重複回覆。
 * 它不需要任何平台端支援，M1 即可實作。
 *
 * ── 三個不照著寫就會失效的地方 ───────────────────────────────────
 * ⚠️ ① **必須以 `sender.type` 判斷，不可用 `direction`。**
 *      AI workflow 的自動回覆同樣是 outbound。以 direction 判斷會把 AI 回覆
 *      誤判為同事回覆，產生假警報 —— 而假警報比沒有警報更糟，
 *      客服學會忽略提示後，真正的撞單也會被一併略過。
 *
 * ⚠️ ② **AI 只在它會自動回覆時才是撞單對象。**
 *      Manual Mode 下 AI 不會送出，把它列入檢查就是製造假警報（§10.5 / §19.1 #12）。
 *
 * ⚠️ ③ **`baseMessageId` 是必填。** 前端沒帶就是 400，不是「跳過檢查」——
 *      靜默跳過會讓整層防線在某次前端重構後無聲失效，而症狀要等到
 *      客戶抱怨收到兩則一樣的回覆才會出現。
 */

import { z } from 'zod'
import type { Message } from '../../../shared/types/conversation.js'
import { controlFromMode, isWorkflowInternalMessage } from '../../../shared/types/conversation.js'
import type { CollisionReport } from '../../../shared/types/events.js'
import { loadConversationContext } from '../../services/conversation-context.js'
import { useCopilotRuntime } from '../../services/copilot-runtime.js'
import { sendTextMessage } from '../../services/imbrace.js'
import { advanceAnchor } from '../../services/session-manager.js'
import { operatorName } from '../../services/directory.js'
import { sameOperator } from '../../sources/mappers.js'
import { fetchSince } from '../../sources/message-fetch.js'
import { assertConversationId } from '../../utils/conversation-param.js'
import { imbraceClientFor } from '../../utils/imbrace-client.js'
import { requireActiveBffSession } from '../../utils/session.js'
import { readBodyAs } from '../../utils/validate.js'

const Body = z.object({
  conversationId: z.string().min(1),
  text: z.string().trim().min(1, '訊息不可為空').max(4000),
  /**
   * 版本錨點：帶入建議／開始組字時的 `lastMessageId`。
   * `null` 代表「當時這個對話還沒有任何訊息」—— 這與「不知道」是兩回事，
   * 所以型別是 nullable 而不是 optional。
   */
  baseMessageId: z.string().nullable(),
  /** 客服看過撞單提示後仍選擇送出 */
  force: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const { conversationId, text, baseMessageId, force } = await readBodyAs(event, Body)
  const convId = assertConversationId(conversationId)
  const session = await requireActiveBffSession(event)

  const client = imbraceClientFor(session)
  const ctx = await loadConversationContext(client, session.orgId, convId)
  if (!ctx) throw createError({ statusCode: 404, message: '找不到這個對話' })

  const control = controlFromMode(ctx.mode)

  // ── 平台端的唯讀狀態（§10.6）────────────────────────────────────
  // ⚠️ 前端也會停用 Composer，但後端仍必須擋 —— 只在前端 disable 的鎖不是鎖。
  if (!control.agentCanSend) {
    throw createError({
      statusCode: 409,
      message: '這個對話目前是 Automation Only（唯讀），任何人都無法送出訊息',
      data: { reason: 'automation_only', control },
    })
  }

  // ── 主管強制介入（§10.6）─────────────────────────────────────────
  // ⚠️ 強制力僅及於 AgentCopilot 內部，擋不住官方介面 —— UI 必須明示此邊界。
  if (control.lock && !sameOperator(control.lock.by, session.operatorId)) {
    throw createError({
      statusCode: 403,
      message: `${control.lock.name} 已強制介入此對話`,
      data: { reason: 'locked', control },
    })
  }

  // ── 樂觀併發檢查（§10.4）─────────────────────────────────────────
  if (!force) {
    const collision = await detectCollision({
      client,
      conversationId: convId,
      baseMessageId,
      operatorId: session.operatorId,
      aiIsCompetitor: control.aiReplies,
      orgId: session.orgId,
    })
    if (collision) {
      throw createError({
        statusCode: 409,
        message: collisionMessage(collision),
        data: { reason: 'collision', collision, control },
      })
    }
  }

  const sent = await sendTextMessage(client, convId, text)
  const sentId = typeof sent.id === 'string' ? sent.id : null

  // 把錨點推到最新，避免自己送的那則在下一輪被當成「新訊息」再 fan-out 一次
  if (sentId) await advanceAnchor(convId, sentId)
  // 不必等下一個輪詢週期：立刻拉，讓同事在 §18 M1 驗收的 4 秒內看到
  useCopilotRuntime(session.orgId).messageSource.poke(convId)

  return { conversationId: convId, messageId: sentId }
})

interface CollisionInput {
  client: ReturnType<typeof imbraceClientFor>
  conversationId: string
  baseMessageId: string | null
  operatorId: string
  aiIsCompetitor: boolean
  /** 供撞單提示把 `u_xxx` 換成人名 —— 見 nameSenders() */
  orgId: string
}

/**
 * @returns null 代表沒有撞單。
 *
 * ⚠️ 取數失敗時回報 `unverified` 而不是靜默放行，也不是直接擋死。
 *    靜默放行會讓「唯一真正有效的一層」在網路抖動時無聲消失；
 *    直接擋死則違反憲法 3.2（故障不得阻斷工作流程）。
 *    折衷是：**告訴客服「查不到，你自己確認」**，並保留一鍵送出。
 *    這是整支路由唯一會把不確定性交還給人的地方。
 */
async function detectCollision(input: CollisionInput): Promise<CollisionReport | null> {
  let since: Message[]
  try {
    since = await fetchSince(input.client, input.conversationId, input.baseMessageId)
  }
  catch {
    return { kind: 'unverified', messages: [], latestMessageId: input.baseMessageId }
  }

  // ⚠️ sameOperator 而非 ===：訊息的 from 帶 `u_` 前綴，登入回應的 user_id 不保證帶
  const byOtherAgent = since.filter(
    m => m.sender.type === 'agent' && !sameOperator(m.sender.id, input.operatorId),
  )
  if (byOtherAgent.length > 0) {
    return {
      kind: 'agent',
      messages: nameSenders(byOtherAgent, input.orgId),
      latestMessageId: since[since.length - 1]?.id ?? input.baseMessageId,
    }
  }

  // 協作模式（Hybrid）下 AI 也是撞單對象；Manual 下 AI 不會送，列入就是假警報
  if (input.aiIsCompetitor) {
    // ⚠️ 必須排除 workflow 的內部訊息（`{"route":"T1"}` 這類）。
    //    它們與真回覆同一個 from、同一個 type，但**客戶根本收不到** ——
    //    列入檢查會在客服組字期間跳出「AI 已經自動回覆」的假警報。
    //    見 isWorkflowInternalMessage() 的說明與 IMBRACE_QUESTIONS H-3c。
    const byAi = since.filter(m => m.sender.type === 'ai' && !isWorkflowInternalMessage(m))
    if (byAi.length > 0) {
      return {
        kind: 'ai',
        messages: byAi,
        latestMessageId: since[since.length - 1]?.id ?? input.baseMessageId,
      }
    }
  }

  return null
}

/**
 * 把 `u_xxx` 換成可讀的人名。
 *
 * ⚠️ 為什麼值得多這幾行：撞單提示寫「另一位同事已經回覆過」與
 *    「李小華已經回覆過」，對客服的價值完全不同 —— 後者他可以直接去問對方，
 *    前者只能自己猜。而名字我們**本來就查得到**（`loadConversationContext()`
 *    已把團隊名冊寫進 directory），不查等於白白丟掉手上的資訊。
 *
 * ⚠️ 查不到時維持 `undefined`，由前端顯示通稱 —— **不可自行編一個名字**。
 */
function nameSenders(messages: Message[], orgId: string): Message[] {
  return messages.map(m => (
    m.sender.name || !m.sender.id
      ? m
      : { ...m, sender: { ...m.sender, name: operatorName(orgId, m.sender.id) } }
  ))
}

function collisionMessage(collision: CollisionReport): string {
  if (collision.kind === 'unverified') {
    return '無法確認是否有人搶先回覆，請自行確認對話內容後再送出'
  }
  const latest = collision.messages[collision.messages.length - 1]
  const who = collision.kind === 'ai'
    ? 'AI'
    : latest?.sender.name || '另一位同事'
  return `${who} 已經回覆過客戶，你的內容可能重複`
}
