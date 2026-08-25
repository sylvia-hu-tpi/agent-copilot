/**
 * 取得「操作一個對話所需的全部識別碼與狀態」。
 *
 * ── 為何 M1 需要這一支 ───────────────────────────────────────────
 * §10.6 ②：**`tcu_` id 只有詳情 API 會回，清單 payload 沒有。**
 * 所以「從對話列表按 JOIN」必須先取一次詳情才拿得到識別碼 ——
 * 這是 M1 實作對話列表時就要預先安排的一次額外請求。
 *
 * 既然一定要打這一趟，就把同一趟能拿到的東西一次取齊：
 *   - `tcu_` id      → JOIN / LEAVE / 切換 mode 都要用（傳錯會靜默不作用）
 *   - `mode`         → Composer 可用性與 presence ③
 *   - `is_joined`    → **我自己**有沒有 JOIN（見下方說明）
 *   - `users[]`      → 只當姓名對照表用（見 directory.ts）
 *
 * ⚠️ `is_joined` 是「我的視角」（以該客服的 token 查詢），**看不到同事**。
 *    §10.2 的實測表把它標成 🟡 正是這個原因。但用來回答「我自己 JOIN 了沒」
 *    它是正確且唯一的來源 —— 而那正是 presence ③ 判定不可或缺的條件
 *    （見 `presence.hasUnidentifiedActor()`）。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import type { Conversation } from '../../shared/types/conversation.js'
import { getConversationDetail } from './imbrace.js'
import { normalizeConversationId, toConversation } from '../sources/mappers.js'
import { rememberOperators } from './directory.js'

export interface ConversationContext extends Conversation {
  /** ⚠️ 「**我**有沒有 JOIN」，不是「有沒有人 JOIN」 */
  viewerJoined: boolean
}

export async function loadConversationContext(
  client: ImbraceClient,
  orgId: string,
  conversationId: string,
): Promise<ConversationContext | null> {
  const raw = await getConversationDetail(client, conversationId)
  if (!raw) return null

  // ⚠️ 兩段 cast 是刻意的：詳情 API 回的物件比 SDK 的 Conversation 型別多出
  //    conversation_id / mode / is_joined 等未宣告欄位，形狀上並不重疊。
  //    髒東西集中在防腐層吸收，上層只看得到乾淨的領域型別。
  const conv = toConversation(raw as unknown as Parameters<typeof toConversation>[0])

  // ⚠️ 詳情 API 回的 id 是 tcu_，而 toConversation 只在 raw.id 以 tcu_ 開頭時才填它。
  //    這裡不做第二套推導 —— 若哪天平台改了形狀，要在 mappers 一處修正。
  if (!conv.teamConversationId) {
    const fallback = raw._id ?? raw.id
    if (typeof fallback === 'string' && fallback.startsWith('tcu_')) {
      conv.teamConversationId = fallback
    }
  }

  // 團隊名冊只拿來查名字（§10.2 / directory.ts）
  rememberOperators(orgId, conv.operators)

  return {
    ...conv,
    id: normalizeConversationId(conv.id),
    viewerJoined: raw.is_joined === true,
  }
}

/**
 * 沒有 `tcu_` id 就無法 JOIN / LEAVE / 切換 mode。
 *
 * ⚠️ 這種情況要當場報錯而不是靜默略過：平台對錯誤或缺少的識別碼
 *    可能只是不作用，症狀會是「按了 JOIN 但沒反應」，而那極難追查。
 */
export function requireTeamConversationId(ctx: ConversationContext): string {
  if (!ctx.teamConversationId) {
    throw createError({
      statusCode: 502,
      message:
        `對話 ${ctx.id} 的詳情中找不到 team_conversation id（tcu_ 開頭）——`
        + 'JOIN / LEAVE / 切換模式都需要它（見 §10.6）',
    })
  }
  return ctx.teamConversationId
}
