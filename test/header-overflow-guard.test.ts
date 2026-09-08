/**
 * 中欄標題列**不得溢出到右欄**的守衛。
 *
 * 同一個 bug 發生過兩次，兩次都不會報錯、不會有型別錯誤，只會安靜地把按鈕
 * 畫在 Copilot 面板的背景上：
 *
 *   ① 2026-09-01　收合態（`HeaderCollapsed.vue`）—— 除了標題以外全是 `shrink-0`，
 *      中欄被左右兩欄擠窄時，收合／展開鈕溢出到右欄上面。
 *   ② 2026-09-07　展開態（`pages/c/[conversationId].vue`）—— 結案中的
 *      「取消結案 ＋ 結案中…」是整列最寬的一組按鈕，同樣溢出。
 *
 * ⚠️ **它不是 z-index 問題**（CSS 2.1 附錄 E 的繪製順序：溢出的 inline-level 內容
 *    天生蓋在後面兄弟的背景之上），往 z-index 調不會修好。
 *
 * ⚠️ **為什麼是掃描式而不是量版面**：這個 repo 的 `test/nuxt/` 不掛載元件，
 *    而就算掛了，jsdom 也沒有版面計算（`getBoundingClientRect()` 全回 0）——
 *    量不出「溢出」這件事。真正能守的是那幾個**缺一就會復發**的 class。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

describe('收合態（38px 單列）：資訊讓位，按鈕永不被裁', () => {
  const src = read('app/components/conversation/HeaderCollapsed.vue')

  it('資訊區同時具備 min-w-0／flex-1／overflow-hidden（三者缺一就會溢出）', () => {
    const info = src.match(/<div class="([^"]*flex-1[^"]*)">\s*\n\s*<h1/)?.[1]
    expect(info, '找不到資訊區的容器 —— 結構被改過，這條守衛要跟著改').toBeTruthy()
    expect(info!).toContain('min-w-0')
    expect(info!).toContain('overflow-hidden')
  })

  /**
   * ⚠️ 外層若也 `overflow-hidden`，裁切從右緣開始 —— 第一個被裁掉的就是展開鈕，
   *    客服會再也展不開這一列。保護必須掛在**資訊區**上，不是最外層。
   */
  it('最外層那一列 MUST NOT 自己 overflow-hidden', () => {
    const row = src.match(/class="ac-hdr-row[^"]*"/)?.[0]
    expect(row).toBeTruthy()
    expect(row!).not.toContain('overflow-hidden')
  })

  it('讓位用的是 container query，不是 @media（這一列的寬度不是視窗寬度）', () => {
    expect(src).toContain('container-type: inline-size')
    expect(src).toMatch(/@container \(max-width/)
    expect(src, '用 @media 等於拿視窗寬度猜中欄寬度，猜錯的方向就是這個 bug')
      .not.toMatch(/@media \(max-width/)
  })
})

describe('展開態：擠不下時按鈕整組換行，而不是溢出', () => {
  const src = read('app/pages/c/[conversationId].vue')
  const row = src.slice(src.indexOf('<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">'))
    .slice(0, 4000)

  it('標題列外層允許換行', () => {
    expect(row.startsWith('<div class="flex flex-wrap'), '標題列外層不再是 flex-wrap').toBe(true)
  })

  /**
   * ⚠️ `flex-1`（`flex:1 1 0%`）看起來等價，實際會讓這一項對「這行放不放得下」的
   *    貢獻變成 0 —— 於是**永遠不會觸發換行**，資訊區一路縮到 0 而按鈕照樣溢出。
   *    這正是最容易在某次「順手統一 class」時被改回去的一行。
   */
  it('資訊區是 flex-auto（不是 flex-1）＋ min-w-0 ＋ overflow-hidden', () => {
    const info = row.match(/<div class="([^"]*flex-auto[^"]*)">/)?.[1]
    expect(info, '資訊區不再是 flex-auto —— 換行條件會失效').toBeTruthy()
    expect(info!).toContain('min-w-0')
    expect(info!).toContain('overflow-hidden')
    expect(info!, 'flex-1 的 basis 為 0，永遠不會換行').not.toMatch(/\bflex-1\b/)
  })

  it('按鈕組 shrink-0 且靠右（換到第二行時仍與下方輔助說明對齊）', () => {
    const btns = row.match(/<div class="(ml-auto flex[^"]*)">/)?.[1]
    expect(btns, '找不到按鈕組的容器').toBeTruthy()
    expect(btns!).toContain('shrink-0')
    expect(btns!).toContain('justify-end')
  })
})
