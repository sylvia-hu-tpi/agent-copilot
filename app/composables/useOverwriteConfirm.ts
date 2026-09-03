/**
 * 一鍵帶入／插入為回覆覆蓋非空白草稿前的確認 —— FR-018、憲法 8.4。
 *
 * research.md #11：這是本功能第一次出現「非使用者手動輸入、而是程式主動要覆蓋草稿」的
 * 操作，之前的摘要／情緒面板都是唯讀展示。不使用瀏覽器原生 `confirm()`——後者無法鍵盤
 * 導覽測試，也不符合憲法 8.2 的一致互動慣例，改用輕量 inline 確認 UI（呼叫端渲染）。
 *
 * 供 `SuggestionCard.vue` 的「一鍵帶入」與（US2）`KnowledgeSearch.vue` 的「插入為回覆」
 * 共用同一份確認流程——由頁面層建立單一實例並包裝草稿寫入。
 */

import { ref, type Ref } from 'vue'

export function useOverwriteConfirm(draftText: Ref<string>, onApply: (text: string) => void) {
  /** 非 null 時代表正等待客服確認是否覆蓋既有草稿 */
  const pending = ref<string | null>(null)

  function request(text: string): void {
    if (draftText.value.trim()) {
      pending.value = text
    }
    else {
      onApply(text)
    }
  }

  function confirm(): void {
    if (pending.value === null) return
    onApply(pending.value)
    pending.value = null
  }

  function cancel(): void {
    pending.value = null
  }

  return { pending, request, confirm, cancel }
}
