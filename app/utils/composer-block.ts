/**
 * Composer 為什麼不能送出 —— docs/ARCHITECTURE.md §10.6 / 憲法 7.1。
 *
 * ── 為何值得抽成純函式 ───────────────────────────────────────────
 * 「有沒有被擋下」很好測，「**擋下的理由對不對**」不好測 —— 而後者才是這段
 * 邏輯的價值所在。M1 手動驗收時抓到的正是這個：判斷順序寫反，
 * 未 JOIN 的對話被顯示成「全自動（唯讀）模式，任何人都無法送出訊息」，
 * 而實際上客服只要按一下「加入對話」就能送。
 *
 * **告訴客服錯的理由，比不告訴他更糟** —— 他會照著錯的理由去做錯的事
 * （跑去找主管改模式，而不是按加入）。
 */

import type { ConversationControl } from '#shared/types/conversation'
import { sameOperatorId } from './operator-id'

export type ComposerBlock =
  /** 主管強制介入 —— 全系統唯一的真鎖 */
  | { key: 'locked', name: string }
  /** 尚未加入這個對話 */
  | { key: 'notJoined' }
  /** 平台端唯讀（Automation Only）—— 所有人都送不出去 */
  | { key: 'automation' }
  | null

/**
 * ⚠️ **順序有意義，不可調換。**
 *
 * 1. `locked` 最優先 —— 它是唯一「按加入也沒用」的情況。
 * 2. `notJoined` 必須排在 `automation` **之前**。
 *    `controlFromMode(null).agentCanSend` 是 `false`，但那是「還沒加入」的
 *    **結果**，不是「對話被設成唯讀」的證據。兩個原因被同一個布林值蓋掉，
 *    先檢查哪一個就顯示哪一個 —— 順序寫反的代價是永遠顯示錯的那一個。
 * 3. `automation` 只在「已加入但仍不能送」時才成立，那才真的是唯讀模式。
 */
export function composerBlockReason(input: {
  control: ConversationControl | null
  viewerJoined: boolean
  myOperatorId?: string
}): ComposerBlock {
  const { control, viewerJoined, myOperatorId } = input

  // ⚠️ 鎖是「我以外的人」上的才擋我。主管自己鎖了對話仍然要能回覆 ——
  //    後端 messages/index.post.ts 就是這樣判的，前後端不一致會讓主管
  //    看到 Composer 停用、卻在強制送出時成功，那比停用更令人困惑。
  if (control?.lock && !sameOperatorId(control.lock.by, myOperatorId)) {
    return { key: 'locked', name: control.lock.name }
  }

  if (!viewerJoined) return { key: 'notJoined' }

  if (control && !control.agentCanSend) return { key: 'automation' }

  return null
}
