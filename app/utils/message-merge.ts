/**
 * 訊息合併 —— docs/ARCHITECTURE.md §9.4。
 *
 * ── 為何值得抽成純函式 ───────────────────────────────────────────
 * `messages.appended` **不等於「有新訊息」**。`PollingMessageSource.sliceNew()`
 * 在首次拉取（`lastMessageId === null`）與錨點失效時一律回傳**整批**
 * （寧可重送也不可漏送），而 `session-manager.ts` 的 fan-out 明文
 * 「MUST NOT 一起濾」—— 去重責任本來就在前端。
 *
 * 訊息列表早就依 id 去重了，漏掉的是**「這次到底有沒有新東西」這個答案**：
 * 它沒有被算出來，於是任何一次整批重送都會被判成
 * 「對話有新內容，建議重新產生」（`ClosureSession.stale`，FR-044）。
 *
 * ⚠️ **這個缺陷客服抓不到規律**（2026-09-07 回報）：觸發它的是「切走再切回」
 *    這個動作 —— 分頁可見性改變 → 心跳帶著新的 `priority` 抵達控制通道 →
 *    `createWatchRegistry().watch()` 判定為真實變化 → 舊訂閱解除、pipeline
 *    refcount 歸零被拆掉 → 重建後 `entry.lastMessageId` 回到 `null` →
 *    下一次輪詢把整段歷史當成新訊息推上來。**對話本身什麼都沒發生。**
 *    盯著畫面不動時心跳參數不變、`watch()` 提前 return，於是又完全正常。
 *
 * 抽出來的理由同 `composer-block.ts`：「有沒有合併進去」很好驗，
 * 「**有沒有新東西**」不會 —— 而後者才是過期標記的唯一依據。
 * `useConversationView.ts` 掛著 `onMounted`／`watch`，vitest 無法直接跑它，
 * 這條規則否則沒有測試守得住。
 */

import type { Message } from '#shared/types/conversation'

export interface MessageMergeResult {
  /** 依 id 去重、依時間排序後的完整列表 */
  messages: Message[]
  /**
   * 這次**真正新增**的則數（依 id 計）。
   *
   * ⚠️ `0` 代表整批都是已知訊息（重送）—— 此時 MUST NOT 標記結案草稿過期。
   * ⚠️ 既有 id 被同 id 的新版本覆蓋時 **不算新增**：那是同一則訊息，不是新內容。
   */
  added: number
}

/**
 * 把 `incoming` 併入 `current`，並如實回報有幾則是新的。
 *
 * ⚠️ 排序 MUST 保留 —— 平台回傳的順序不保證，而中欄是時間軸。
 */
export function mergeMessages(current: Message[], incoming: Message[]): MessageMergeResult {
  if (incoming.length === 0) return { messages: current, added: 0 }

  const byId = new Map(current.map(m => [m.id, m]))
  const before = byId.size
  for (const m of incoming) byId.set(m.id, m)

  return {
    messages: [...byId.values()].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
    ),
    added: byId.size - before,
  }
}
