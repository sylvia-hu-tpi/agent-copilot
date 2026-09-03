/**
 * 情緒走勢折線的**分帶上色** —— 線的顏色隨它所在的分數帶改變（畫布 2a，2026-09-01）。
 *
 * ── 為什麼需要一支專門的測試 ─────────────────────────────────────
 * 這一塊的三個關鍵決定全都**壞掉也不會報錯**：
 *
 *   ① `SENTIMENT_BANDS` 的順序與界線同時決定漸層的硬停點。倒過來排、或界線改成
 *      不連續，整張圖的顏色會上下顛倒或留下空白帶 —— 型別完全正確。
 *   ② `gradientUnits` 若退回預設的 `objectBoundingBox`，顏色會改成依折線**自己的外框**
 *      分佈（最高點永遠綠、最低點永遠紅），語意剛好相反；水平線的外框高度是 0，
 *      整條線會直接消失。畫面上仍然「有顏色」，只是意思全錯。
 *   ③ `stop-color` 若寫成 attribute（畫布逐字就是那樣），presentation attribute 不做
 *      `var()` 代換，無效值靜默退回黑色 —— 一條黑線，沒有任何錯誤訊息。
 *
 * ⚠️ 另外守住「示警不再染折線」：`strokeColor` 曾在示警時把**整條**線染成 `--warn`／
 *    `--danger`，那與分帶上色是兩套會打架的規則（示警有遲滯，最新一點已回到「擔憂」時
 *    仍持續示警，此時整條紅線與線的高度互相矛盾）。示警改由 pill 單獨承擔。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SENTIMENT_BANDS, sentimentBandOf } from '../shared/types/copilot.js'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = readFileSync(resolve(ROOT, 'app/components/copilot/SentimentGauge.vue'), 'utf8')

describe('分數帶（SENTIMENT_BANDS／sentimentBandOf）', () => {
  it('界線兩側各自落在正確的一級', () => {
    // 每一級的下界（含）與其下方一分（屬於下一級）
    expect(sentimentBandOf(100)).toBe('calm')
    expect(sentimentBandOf(80)).toBe('calm')
    expect(sentimentBandOf(79)).toBe('neutral')
    expect(sentimentBandOf(60)).toBe('neutral')
    expect(sentimentBandOf(59)).toBe('concerned')
    expect(sentimentBandOf(40)).toBe('concerned')
    expect(sentimentBandOf(39)).toBe('frustrated')
    expect(sentimentBandOf(20)).toBe('frustrated')
    expect(sentimentBandOf(19)).toBe('angry')
    expect(sentimentBandOf(0)).toBe('angry')
  })

  it('由高分到低分排列，且最低一級由 0 起算', () => {
    // ⚠️ 順序就是漸層 stop 的產生順序（見 SentimentGauge.vue 的 GRADIENT_STOPS）。
    //    倒過來排會讓整張圖的顏色上下顛倒，而且不會有型別錯誤。
    const mins = SENTIMENT_BANDS.map(b => b.min)
    expect(mins).toEqual([...mins].sort((a, b) => b - a))
    expect(mins.at(-1)).toBe(0) // 沒有這一條，0–19 分會落進沒有任何 stop 的空白帶
  })

  it('換算成漸層 offset 後嚴格遞增且落在 [0, 1]', () => {
    // offset 0 ＝ score 100（圖頂）、1 ＝ score 0（基準線）
    const offsets = SENTIMENT_BANDS.map(b => (100 - b.min) / 100)
    expect(offsets.at(-1)).toBe(1)
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!)
      expect(offsets[i]!).toBeLessThanOrEqual(1)
    }
  })
})

describe('SentimentGauge.vue 的漸層寫法', () => {
  it('gradientUnits 是 userSpaceOnUse', () => {
    expect(SOURCE).toContain('gradientUnits="userSpaceOnUse"')
  })

  it('stop-color 走 style，不寫成 attribute', () => {
    expect(SOURCE).toContain('stopColor')
    expect(SOURCE).not.toMatch(/<stop[^>]*\sstop-color=/)
  })

  it('折線與端點都吃同一個漸層，色票不另外抄一份', () => {
    // 折線 1 條 ＋ 端點圓點 2 個（lastPoint／singlePoint）
    expect(SOURCE.match(/url\(#\$\{gradId\}\)/g)?.length).toBe(3)
    // GRADIENT_STOPS 由 SCALE 推導 —— 量表 bar 就是這張圖的圖例，兩邊必須同色
    expect(SOURCE).toMatch(/GRADIENT_STOPS = [\s\S]{0,400}SCALE\.map/)
  })

  it('示警不再把整條折線染色', () => {
    // ⚠️ 註解裡提到 strokeColor 是允許的（記錄它為何退場），綁在 template 上則不行
    expect(SOURCE).not.toMatch(/:(?:stroke|fill)="strokeColor"/)
  })
})
