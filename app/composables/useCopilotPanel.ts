/**
 * 右欄 Copilot 面板的可見性與收合偏好 —— specs/003-analysis-trigger-policy
 * FR-016、FR-016a、FR-017、FR-017a、FR-017b。
 *
 * ── 可見性：一個布林的衍生，沒有新實體 ──────────────────────────
 * ```
 * 面板是否呈現 ⟺ viewerJoined === true
 * ```
 * 就這一條。
 *
 * ⚠️ **MUST NOT 用「三個 Block 是否為 empty」推出可見性。** JOIN 之後、首次分析完成之前
 *    三個 Block 都是 `empty`，但那時面板 MUST 已經在（客服要看到「分析中」的骨架）。
 *    用內容判斷會讓面板在 JOIN 後晚一拍才出現。
 *
 * ⚠️ 也**不參考 presence** —— 「有沒有別人 JOIN」與「我的面板要不要出現」是兩個問題，
 *    本規格刻意讓後者只取決於前者。
 *
 * ── 收合：與 JOIN 正交 ────────────────────────────────────────
 * ⚠️ 收合是**純視覺狀態**（FR-017b）：切換它 MUST NOT 送出任何請求、MUST NOT 改動 `joined`，
 *    也 MUST NOT 影響分析排程。收起面板不等於離開對話。
 *
 * ⚠️ 偏好以**每個對話**為粒度（FR-017a）：客服對不同對話的依賴程度不同，
 *    一份全域偏好會讓「上一個對話收起來了，下一個也跟著收起來」，而那不是他的意思。
 *    未存過時預設**展開** —— JOIN 的目的就是要用面板。
 */

const PREFIX = 'ac.copilotCollapsed.'

function keyOf(conversationId: string): string {
  return `${PREFIX}${conversationId}`
}

/**
 * ⚠️ 每一次存取都要 try/catch：隱私模式、儲存空間已滿、使用者停用網站資料時
 *    `localStorage` 會直接丟例外（比照 `useDraft()`）。讀不到就用預設值，不影響功能。
 */
function safeRead(conversationId: string): boolean {
  try {
    return localStorage.getItem(keyOf(conversationId)) === '1'
  }
  catch {
    return false
  }
}

function safeWrite(conversationId: string, collapsed: boolean): void {
  try {
    localStorage.setItem(keyOf(conversationId), collapsed ? '1' : '0')
  }
  catch {
    // 存不下來就算了 —— 這一輪的收合狀態仍然有效，只是下次開啟不會記得
  }
}

/**
 * 進入結案時保存的五塊狀態（`docs/DESIGN_TOKENS.md` §7.4「五塊的來回」）。
 *
 * ⚠️ **刻意不持久化**（與上面的 `collapsed` 不同）：它跟著結案狀態同生共死。
 *    存進 `localStorage` 的話，重新整理後結案已經被取消（FR-040），
 *    卻還留著一份「結案時的收合組合」等著被還原 —— 那份資料再也沒有主人。
 */
export interface PanelSavedLayout {
  /** 進入結案前各區塊的展開組合（由 page 提供，key 為區塊 id） */
  open: Record<string, boolean>
  scroll: number
}

export function useCopilotPanel(
  conversationId: Ref<string>,
  viewerJoined: Ref<boolean>,
  /** `true` ＝ 這個對話正在結案（由 `useClosureStore().isClosing()` 提供） */
  closing?: Ref<boolean>,
) {
  const collapsed = ref(false)

  /** FR-016：未 JOIN → 整欄不存在。MUST NOT 用變灰／空狀態／骨架代替 */
  const visible = computed(() => viewerJoined.value)

  /**
   * 面板的兩種版面（`docs/DESIGN_TOKENS.md` §7.4）。
   *
   * `closing`：第 6 區塊**置頂**展開可編輯，其餘五塊全部收合成單行。
   * ⚠️ **不在畫面上解釋「為什麼其他區塊收合了」** —— 收合與還原是可預期的模式切換，
   *    不需要每次結案都說明一次（畫布 2b 的裁示）。
   */
  const variant = computed<'expanded' | 'closing'>(() =>
    (closing?.value ? 'closing' : 'expanded'))

  /**
   * 進入結案前的五塊狀態。⚠️ **取消結案與寫入成功都原樣還原** ——
   * 結案成功後接著按「離開」會關掉整個面板，下次接手時打開的必須是乾淨的原狀。
   */
  const saved = ref<PanelSavedLayout | null>(null)

  /** 結案面板本身一律從頂端開始捲（畫布逐字：`scrollTop = 0`） */
  const scrollTop = ref(0)

  watch(variant, (next, prev) => {
    if (next === 'closing' && prev !== 'closing') {
      saved.value = { open: {}, scroll: scrollTop.value }
      scrollTop.value = 0
    }
    else if (next === 'expanded' && prev === 'closing') {
      scrollTop.value = saved.value?.scroll ?? 0
      saved.value = null
    }
  })

  // 切換對話時重讀該對話自己的偏好（未存過 → 展開）
  watch(conversationId, (id) => {
    collapsed.value = id ? safeRead(id) : false
  }, { immediate: true })

  watch(collapsed, (value) => {
    if (!conversationId.value) return
    safeWrite(conversationId.value, value)
  })

  /**
   * ⚠️ 只翻一個 ref。這裡 MUST NOT 出現任何 `$fetch`／presence 心跳／分析相關呼叫 ——
   *    收合與 JOIN 正交（FR-017b），加進去就會讓「收起面板」變成「悄悄離開對話」。
   */
  function toggle(): void {
    collapsed.value = !collapsed.value
  }

  /** 由 page 在進入結案前把各區塊的展開組合交進來（見 `PanelSavedLayout`） */
  function rememberOpenState(open: Record<string, boolean>): void {
    if (saved.value) saved.value = { ...saved.value, open }
  }

  return { visible, collapsed, toggle, variant, saved, scrollTop, rememberOpenState }
}
