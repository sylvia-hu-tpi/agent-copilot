/**
 * Composer 草稿保存 —— 憲法 8.4：**草稿絕不遺失**。
 *
 * 送出失敗、斷線、重新整理都不得清空。客服打了一段話卻因為網路抖動而消失，
 * 是這類工具最容易失去信任的地方 —— 而且他多半會怪自己而不是回報。
 *
 * ⚠️ 只在「確定送出成功」之後才清除。撞單被攔截時**不可**清 ——
 *    那正是客服最需要那段文字的時刻（他要決定是改寫還是照送）。
 *
 * ⚠️ 以 conversationId 為鍵：同時處理多個對話時，草稿不可互相覆蓋。
 */

const PREFIX = 'ac.draft.'
/** 太舊的草稿沒有保留價值，只會累積 —— 7 天後清掉 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface StoredDraft {
  text: string
  at: number
}

function keyOf(conversationId: string): string {
  return `${PREFIX}${conversationId}`
}

/**
 * ⚠️ 每一次存取都要 try/catch：隱私模式、儲存空間已滿、
 *    使用者停用網站資料的情況下，`localStorage` 會直接丟例外。
 *    草稿存不下來是可接受的降級，但不能因此讓整個 Composer 崩掉。
 */
function safeRead(conversationId: string): string {
  try {
    const raw = localStorage.getItem(keyOf(conversationId))
    if (!raw) return ''
    const parsed = JSON.parse(raw) as StoredDraft
    if (Date.now() - parsed.at > MAX_AGE_MS) {
      localStorage.removeItem(keyOf(conversationId))
      return ''
    }
    return parsed.text ?? ''
  }
  catch {
    return ''
  }
}

function safeWrite(conversationId: string, text: string): void {
  try {
    if (!text) localStorage.removeItem(keyOf(conversationId))
    else localStorage.setItem(keyOf(conversationId), JSON.stringify({ text, at: Date.now() } satisfies StoredDraft))
  }
  catch {
    // 存不下來就算了 —— 記憶體中的 ref 仍然有值，這一輪工作不受影響
  }
}

export function useDraft(conversationId: Ref<string>) {
  const text = ref('')
  /** 有沒有真的寫進 localStorage —— UI 可據此決定要不要顯示「草稿已保存」 */
  const persisted = ref(false)

  // 切換對話時載入該對話自己的草稿
  watch(conversationId, (id) => {
    text.value = id ? safeRead(id) : ''
  }, { immediate: true })

  // ⚠️ 不 debounce：debounce 的空窗期正好涵蓋「使用者打完字立刻關掉分頁」這個
  //    最需要保住草稿的情境。寫入量很小（一個對話一筆），不值得為此冒險。
  watch(text, (value) => {
    if (!conversationId.value) return
    safeWrite(conversationId.value, value)
    persisted.value = value.length > 0
  })

  /** ⚠️ 只在確定送出成功後呼叫 */
  function clear(): void {
    text.value = ''
    persisted.value = false
  }

  return { text, persisted, clear }
}
