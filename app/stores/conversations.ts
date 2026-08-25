/**
 * 側欄的對話清單 —— docs/ARCHITECTURE.md §14.2。
 *
 * 資料來自 `GET /api/conversations`（第一層清單輪詢的同一份資料），
 * 並靠 SSE 的 `conversation.updated` 即時更新排序與未讀徽記。
 *
 * ⚠️ **未讀徽記只在「不是目前聚焦的對話」時才亮。** 否則客服會在自己正在看的
 *    對話上看到「有新訊息」的紅點，而訊息就在他眼前 —— 那會很快讓他學會忽略徽記。
 */

import { defineStore } from 'pinia'
import type { Conversation } from '#shared/types/conversation'
import type { CopilotEvent } from '#shared/types/events'

export const useConversationsStore = defineStore('conversations', () => {
  const items = ref<Conversation[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const query = ref('')

  /** 有新訊息但使用者還沒看過的對話 */
  const unread = ref<Set<string>>(new Set())
  /** 目前聚焦的對話 —— 它永遠不該有未讀徽記 */
  const activeId = ref<string | null>(null)

  /**
   * ⚠️ 依 `lastMessageAt` 排序，但**它的填充率只有 85%**（§9.3.1 實測）。
   *    沒有值的對話退回用 `updatedAt`，否則那 15% 會永遠沉在清單最底。
   */
  const sorted = computed(() => [...items.value].sort((a, b) =>
    new Date(b.lastMessageAt ?? b.updatedAt).getTime()
    - new Date(a.lastMessageAt ?? a.updatedAt).getTime(),
  ))

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await $fetch<{ items: Conversation[] }>('/api/conversations', {
        query: { q: query.value },
      })
      items.value = res.items
    }
    catch (err) {
      const e = err as { data?: { message?: string }, statusMessage?: string }
      error.value = e?.data?.message || e?.statusMessage || '讀取對話清單失敗'
    }
    finally {
      loading.value = false
    }
  }

  function setActive(id: string | null): void {
    activeId.value = id
    if (id) markRead(id)
  }

  function markRead(id: string): void {
    if (!unread.value.has(id)) return
    const next = new Set(unread.value)
    next.delete(id)
    unread.value = next
  }

  /**
   * SSE 的 `conversation.updated`：更新時間戳並視情況點亮徽記。
   *
   * ⚠️ 只更新既有項目的時間戳，不整包重載清單 ——
   *    重載會讓側欄在客服正要點擊時整個重排，是很惱人的互動缺陷。
   *    新對話由下一次 `load()` 或使用者手動重整帶進來。
   */
  function apply(evt: CopilotEvent): void {
    if (evt.type !== 'conversation.updated') return

    const hit = items.value.find(c => c.id === evt.conversationId)
    if (hit && evt.lastMessageAt) hit.lastMessageAt = evt.lastMessageAt

    if (evt.conversationId !== activeId.value) {
      const next = new Set(unread.value)
      next.add(evt.conversationId)
      unread.value = next
    }
  }

  return {
    items, sorted, loading, error, query, unread, activeId,
    load, setActive, markRead, apply,
  }
})
