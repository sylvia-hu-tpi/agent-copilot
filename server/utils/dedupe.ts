/**
 * 事件去重 —— docs/ARCHITECTURE.md §4.3、憲法 7.3。
 *
 * ── 為什麼 M1 就要做 ─────────────────────────────────────────────
 * JOIN 有**兩條路徑**：
 *   ① 本地快路徑 —— 客服在 AgentCopilot 內按下 JOIN，我方當場就知道
 *   ② webhook   —— 平台事後推回同一個動作（M4）
 *
 * M4 才會有 ②，但去重必須現在做。理由：等到接上 webhook 那天再補，
 * 症狀會是「同事 JOIN 的提示跳兩次」，而那時要同時 debug 新接的 webhook
 * 與舊有的快路徑，成本高得多。現在做只要幾行，且 ② 接上時完全不用改。
 *
 * 鍵為 `conversationId + operatorId`，10 秒時間窗內視為同一事件。
 *
 * ⚠️ `StateStore.seen()` 的語意方向容易誤讀：
 *    **回傳 true 代表「先前已見過」= 這是重複事件，應丟棄**。
 */

import type { StateStore } from '../state/types.js'

/** §4.3 / 憲法 7.3 指定的時間窗 */
export const JOIN_DEDUPE_WINDOW_MS = 10_000

export type JoinEventKind = 'join' | 'leave'

/**
 * @returns true = 這是重複事件，呼叫端應直接 return
 */
export async function isDuplicateJoinEvent(
  store: StateStore,
  kind: JoinEventKind,
  conversationId: string,
  operatorId: string,
): Promise<boolean> {
  return store.seen(`${kind}:${conversationId}:${operatorId}`, JOIN_DEDUPE_WINDOW_MS)
}
