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

/** 一頁的筆數 —— `/api/conversations` 的 `limit` 上限是 100 */
const PAGE_SIZE = 30

/**
 * 側欄最多載到幾筆 —— **刻意等於第一層背景輪詢的 `LIST_PAGE_SIZE`（100）**。
 *
 * ⚠️ 這個上限不是效能考量，是**誠實**考量。§9.3.1 的第一層輪詢目前刻意不分頁
 *    （`server/services/copilot-runtime.ts` 的 TODO），只涵蓋前 100 筆。
 *    載進超出這個範圍的對話，畫面上會有一列**永遠不更新時間戳、永遠不亮未讀**的對話——
 *    看起來像「這個對話很安靜」，實際是沒人在偵測它。那比看不到更糟。
 *
 * ⚠️ 兩個數字 MUST 一起改。改大這裡而沒改 `LIST_PAGE_SIZE`，上面那個症狀就會出現，
 *    而且不會報錯。
 */
const BACKGROUND_COVERAGE = 100

export const useConversationsStore = defineStore('conversations', () => {
  const items = ref<Conversation[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const query = ref('')

  /**
   * 有新訊息但使用者還沒看過的對話。
   *
   * ⚠️ **UI 只顯示圓點，不顯示則數**（2026-08-29 使用者裁定）：我方唯一的新訊息訊號是
   *    清單輪詢的 `last_message_at` 跳動，它在一次輪詢間隔（前景 3 秒）內不論來了幾則
   *    都只跳一次，數出來的是「批次數」不是「則數」。平台的清單 payload 既沒有未讀數
   *    也沒有訊息則數（`scripts/spike/out/13-list-sample.json` 實測 17 個欄位）。
   *    ⚠️ 仍用 `Map` 而非 `Set` 是為了保留這個計數 —— 平台日後若提供則數，
   *    UI 改回數字時不必再改一次 store；而現在多存一個數字的成本是零。
   */
  const unread = ref<Map<string, number>>(new Map())
  /** 平台回報的總數 —— 側欄底部「顯示 N / M」的 M。拿不到時為 null，UI 據此不顯示分母 */
  const total = ref<number | null>(null)
  /** 目前聚焦的對話 —— 它永遠不該有未讀徽記 */
  const activeId = ref<string | null>(null)

  /**
   * ⚠️ 依 `lastMessageAt` 排序，但**它的填充率只有 85%**（§9.3.1 實測）。
   *    沒有值的對話退回用 `updatedAt`，否則那 15% 會永遠沉在清單最底。
   */
  /** 側欄的篩選 chip：`status` 的計數。⚠️ 只數**已載入**的，不是組織總量 */
  const counts = computed(() => {
    const by = { all: items.value.length, active: 0, open: 0 }
    for (const c of items.value) {
      if (c.status === 'active') by.active++
      else if (c.status === 'open') by.open++
    }
    return by
  })

  /** 還有沒有下一頁 —— 拿不到 total 時以「這一頁滿了」推斷 */
  const hasMore = computed(() => {
    if (items.value.length >= BACKGROUND_COVERAGE) return false
    return total.value === null
      ? items.value.length > 0 && items.value.length % PAGE_SIZE === 0
      : items.value.length < total.value
  })

  /** 已經載到背景輪詢的涵蓋上限 —— UI 要說明為什麼不能再載，不能只是讓按鈕消失 */
  const atCoverageLimit = computed(() =>
    items.value.length >= BACKGROUND_COVERAGE
    && (total.value === null || total.value > items.value.length),
  )

  const sorted = computed(() => [...items.value].sort((a, b) =>
    new Date(b.lastMessageAt ?? b.updatedAt).getTime()
    - new Date(a.lastMessageAt ?? a.updatedAt).getTime(),
  ))

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await $fetch<{ items: Conversation[], total: number | null }>('/api/conversations', {
        query: { q: query.value, limit: PAGE_SIZE },
      })
      items.value = res.items
      total.value = res.total
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
    const next = new Map(unread.value)
    next.delete(id)
    unread.value = next
  }

  /**
   * 載入下一頁 —— 側欄底部的「載入更多對話…」。
   *
   * ⚠️ 用 `skip` 而非游標：`/api/conversations` 就是這樣開的（`limit`／`skip`）。
   *    ⚠️ 這一支與 §9.3.1 第一層**背景輪詢**的分頁是兩回事——那一層目前刻意不分頁
   *    （`copilot-runtime.ts` 的 TODO(M4)），所以超過首頁的對話不會被背景偵測到，
   *    在側欄上會安靜地不更新時間戳。這是已知限制，不是本函式的 bug。
   */
  async function loadMore(): Promise<void> {
    if (loading.value || !hasMore.value) return
    // 再保險一次：上限是「畫面上不得出現不會更新的列」的硬約束，不只是按鈕的顯示條件
    if (items.value.length >= BACKGROUND_COVERAGE) return
    loading.value = true
    try {
      const res = await $fetch<{ items: Conversation[], total: number | null }>('/api/conversations', {
        query: { q: query.value, limit: PAGE_SIZE, skip: items.value.length },
      })
      // 以 id 去重 —— 兩次請求之間清單可能重排，skip 分頁本來就會漏抓或重抓
      const seen = new Set(items.value.map(c => c.id))
      items.value = [...items.value, ...res.items.filter(c => !seen.has(c.id))]
      total.value = res.total
    }
    catch (err) {
      const e = err as { data?: { message?: string }, statusMessage?: string }
      error.value = e?.data?.message || e?.statusMessage || '讀取對話清單失敗'
    }
    finally {
      loading.value = false
    }
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
    const before = hit?.lastMessageAt
    if (hit && evt.lastMessageAt) hit.lastMessageAt = evt.lastMessageAt

    // ⚠️ 只有 `lastMessageAt` **真的變了**才算未讀。`conversation.updated` 也會在
    //    切 mode／JOIN／LEAVE 時發出，把那些也算進去會讓徽記數字憑空長大。
    const isNewMessage = Boolean(evt.lastMessageAt) && evt.lastMessageAt !== before
    if (isNewMessage && evt.conversationId !== activeId.value) {
      const next = new Map(unread.value)
      next.set(evt.conversationId, (next.get(evt.conversationId) ?? 0) + 1)
      unread.value = next
    }
  }

  return {
    items, sorted, loading, error, query, unread, activeId, total, hasMore, counts, atCoverageLimit,
    load, loadMore, setActive, markRead, apply,
  }
})
