/**
 * 可拖曳調整的面板尺寸 —— 欄寬與**輸入框高度**共用同一套邏輯。
 *
 * 涵蓋：左欄寬（220–400，預設 280）、右欄寬（320–720，預設 420）、
 * 中欄輸入框高（72–320，預設 96）—— 畫布 §8.1 與 1c 的輸入框把手。
 *
 * ⚠️ **本檔原名 `usePanelWidth`，2026-09-01 因畫布新增「輸入框可拖曳調高」而一般化。**
 *    演算法（clamp／localStorage 還原／指標拖曳／鍵盤步進）與寬度完全相同，
 *    只差在讀 `clientX` 還是 `clientY`、以及方向鍵是左右還是上下。
 *    複製一份出來會讓「存回去要 clamp」這類已經踩過的坑各修一次 —— 而第二份多半不會修。
 *
 * ⚠️ **存回 `localStorage` 的值要 clamp，不是「超出範圍就丟掉」。**
 *    先前左欄的範圍是 200–480，改成 220–400 之後，舊值 480 若被判定為無效
 *    會靜默退回預設的 280 —— 客服會發現自己調好的寬度「自己跑掉了」，
 *    而畫面上沒有任何線索說明原因。clamp 至少保留意圖（最寬 → 新的最寬）。
 *
 * ⚠️ **鍵盤必須能調**（憲法 8.2）。畫布只畫了滑鼠拖曳，但 5px／6px 的把手對
 *    只用鍵盤的人等於不存在。`role="separator"` ＋ 方向鍵是 ARIA 的標準做法，
 *    因此把 `aria-valuenow/min/max` 一併由這裡算好給元件用。
 */

export interface PaneSizeOptions {
  /** `localStorage` 的鍵 */
  key: string
  def: number
  min: number
  max: number
  /**
   * 拖曳與方向鍵的軸向。`'x'` ＝ 欄寬（←／→）、`'y'` ＝ 高度（↑／↓）。
   * 預設 `'x'`，讓既有的兩個欄寬呼叫端不必改。
   */
  axis?: 'x' | 'y'
  /**
   * 把手在被調整的區塊**後方**時為 `false`（左側欄：滑鼠往右 → 變寬）；
   * 在**前方**時為 `true`（右欄：滑鼠往左 → 變寬；輸入框：滑鼠往上 → 變高）。
   * ⚠️ 方向寫反不會報錯，只會讓拖曳感覺「反過來」。
   */
  invert?: boolean
  /**
   * 鍵盤單次調整的步進（px），Shift 時放大到 4 倍。
   *
   * ⚠️ **欄寬與輸入框高度的步進不同，這不是疏漏**：畫布 1c 給欄寬 16／64、
   *    給輸入框高度 **12／48**。高度的可調範圍（72–320）比欄寬（320–720）窄得多，
   *    沿用 16 會讓一次按鍵跨掉可用範圍的 6%，調不到想要的高度。
   */
  step?: number
}

/** 欄寬的預設步進（px）—— 畫布 1c：←／→ 每次 16px、Shift 每次 64px（＝ ×4） */
const DEFAULT_STEP = 16

export function usePaneSize(opts: PaneSizeOptions) {
  const { key, def, min, max, axis = 'x', invert = false, step: baseStep = DEFAULT_STEP } = opts

  const size = ref(def)
  const dragging = ref(false)

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))

  function restore(): void {
    try {
      const raw = Number(localStorage.getItem(key))
      if (Number.isFinite(raw) && raw > 0) size.value = clamp(raw)
    }
    catch {
      // 隱私模式下讀不到就用預設值，不影響功能
    }
  }

  function persist(): void {
    try {
      localStorage.setItem(key, String(size.value))
    }
    catch { /* 存不下來不影響本次操作 */ }
  }

  function startDrag(e: PointerEvent): void {
    dragging.value = true
    const start = axis === 'y' ? e.clientY : e.clientX
    const startSize = size.value

    const move = (ev: PointerEvent) => {
      const delta = (axis === 'y' ? ev.clientY : ev.clientX) - start
      size.value = clamp(startSize + (invert ? -delta : delta))
    }
    const up = () => {
      dragging.value = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      persist()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * 方向鍵調整 —— 「變大／變小」以**視覺方向**為準，
   * 故右欄的左右鍵與輸入框的上下鍵語意都與 `invert` 相關。
   */
  function onKeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? baseStep * 4 : baseStep
    const dec = axis === 'y' ? 'ArrowUp' : 'ArrowLeft'
    const inc = axis === 'y' ? 'ArrowDown' : 'ArrowRight'
    let delta = 0
    if (e.key === dec) delta = -step
    else if (e.key === inc) delta = step
    else if (e.key === 'Home') { size.value = min; persist(); e.preventDefault(); return }
    else if (e.key === 'End') { size.value = max; persist(); e.preventDefault(); return }
    else return

    e.preventDefault()
    size.value = clamp(size.value + (invert ? -delta : delta))
    persist()
  }

  return { size, dragging, min, max, restore, persist, startDrag, onKeydown }
}
