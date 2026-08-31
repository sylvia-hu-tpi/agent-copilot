/**
 * 可拖曳調寬的側欄／面板寬度 —— 畫布 §8.1（左欄 220–400，預設 280；右欄 320–720，預設 420）。
 *
 * ⚠️ **存回 `localStorage` 的值要 clamp，不是「超出範圍就丟掉」。**
 *    先前左欄的範圍是 200–480，改成 220–400 之後，舊值 480 若被判定為無效
 *    會靜默退回預設的 280 —— 客服會發現自己調好的寬度「自己跑掉了」，
 *    而畫面上沒有任何線索說明原因。clamp 至少保留意圖（最寬 → 新的最寬）。
 *
 * ⚠️ **鍵盤必須能調**（憲法 8.2）。畫布只畫了滑鼠拖曳，但 5px 寬的把手對
 *    只用鍵盤的人等於不存在。`role="separator"` ＋ 方向鍵是 ARIA 的標準做法，
 *    因此把 `aria-valuenow/min/max` 一併由這裡算好給元件用。
 */

export interface PanelWidthOptions {
  /** `localStorage` 的鍵 */
  key: string
  def: number
  min: number
  max: number
  /**
   * 把手在被調整的欄位**右側**時為 `false`（左側欄：滑鼠往右 → 變寬）；
   * 在**左側**時為 `true`（右欄：滑鼠往左 → 變寬）。方向寫反不會報錯，
   * 只會讓拖曳感覺「反過來」。
   */
  invert?: boolean
}

/** 鍵盤單次調整的步進（px）。Shift 時放大到 10 倍 */
const STEP = 8

export function usePanelWidth(opts: PanelWidthOptions) {
  const { key, def, min, max, invert = false } = opts

  const width = ref(def)
  const dragging = ref(false)

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))

  function restore(): void {
    try {
      const raw = Number(localStorage.getItem(key))
      if (Number.isFinite(raw) && raw > 0) width.value = clamp(raw)
    }
    catch {
      // 隱私模式下讀不到就用預設值，不影響功能
    }
  }

  function persist(): void {
    try {
      localStorage.setItem(key, String(width.value))
    }
    catch { /* 存不下來不影響本次操作 */ }
  }

  function startDrag(e: PointerEvent): void {
    dragging.value = true
    const startX = e.clientX
    const startWidth = width.value

    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX
      width.value = clamp(startWidth + (invert ? -delta : delta))
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

  /** 方向鍵調整 —— 「變寬／變窄」以**視覺方向**為準，故右欄的左右鍵語意相反 */
  function onKeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? STEP * 10 : STEP
    let delta = 0
    if (e.key === 'ArrowLeft') delta = -step
    else if (e.key === 'ArrowRight') delta = step
    else if (e.key === 'Home') { width.value = min; persist(); e.preventDefault(); return }
    else if (e.key === 'End') { width.value = max; persist(); e.preventDefault(); return }
    else return

    e.preventDefault()
    width.value = clamp(width.value + (invert ? -delta : delta))
    persist()
  }

  return { width, dragging, min, max, restore, persist, startDrag, onKeydown }
}
