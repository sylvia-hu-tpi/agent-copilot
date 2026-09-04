/**
 * SC-007 的自動化部分：`--verify` **同時**比對名稱、型別與選項（契約 B2／B3／B4）。
 *
 * ⚠️ 只比名稱的話，`sentiment_trough` 被建成 `ShortText` 一樣不會報錯 ——
 *    只會讓報表無法對它做數值統計，與少建一欄的後果同級。
 *
 * ⚠️ 這裡驗的是**純函式** `diffBoardFields()`：它是 setup 與 verify 兩個模式的
 *    共同判準，也是「手動移除任一欄位後 100% 指出缺漏」那條驗收的實際依據。
 *    對真實 Board 的那一半（T046）是人工驗收，需要在 stable 環境執行。
 */

import { describe, expect, it } from 'vitest'
import { diffBoardFields, isDiffClean } from '../scripts/setup-closure-board.js'
import {
  CLOSURE_BOARD_FIELDS,
  CLOSURE_BOARD_FIELD_COUNT,
} from '../server/services/closure/board-schema.js'
import type { BoardFieldInfo } from '../server/services/imbrace.js'

/**
 * 由欄位表造一份「Board 上實際長這樣」的 fixture。
 * ⚠️ 預設**帶上選項** —— 平台目前不回選項（見 `optionsUnreadable` 的測試），
 *    但比對邏輯本身必須在選項讀得到時是對的，否則平台哪天開始回選項就沒人發現它壞了。
 */
function actualFields(
  over: { omit?: string[], retype?: Record<string, string>, options?: Record<string, string[]>, dropOptions?: string[] } = {},
): BoardFieldInfo[] {
  const omit = new Set(over.omit ?? [])
  const dropOptions = new Set(over.dropOptions ?? [])
  return CLOSURE_BOARD_FIELDS
    .filter(f => !omit.has(f.name))
    .map(f => ({
      id: `fid_${f.name}`,
      name: f.name,
      type: over.retype?.[f.name] ?? f.type,
      options: dropOptions.has(f.name)
        ? undefined
        : over.options?.[f.name] ?? (f.options ? [...f.options] : undefined),
    }))
}

describe('B2：齊全時空差集、離開碼 0', () => {
  it('26 個欄位全部相符 → 四個桶都是空的', () => {
    const diff = diffBoardFields(actualFields())
    expect(diff.missing).toEqual([])
    expect(diff.typeMismatch).toEqual([])
    expect(diff.optionMismatch).toEqual([])
    expect(diff.optionsUnreadable).toEqual([])
    expect(isDiffClean(diff)).toBe(true)
  })

  it('欄位表本身就是 26 欄（契約 §2 的那張表）', () => {
    expect(CLOSURE_BOARD_FIELD_COUNT).toBe(26)
  })
})

describe('B2：缺欄位時 MUST 逐欄列出名稱與型別', () => {
  it('缺 period_origin／period_sentiment_note → missing 兩筆，各帶名稱與型別', () => {
    const diff = diffBoardFields(actualFields({ omit: ['period_origin', 'period_sentiment_note'] }))
    expect(diff.missing.map(f => f.name)).toEqual(['period_origin', 'period_sentiment_note'])
    expect(diff.missing.map(f => f.type)).toEqual(['SingleSelection', 'ShortText'])
    expect(isDiffClean(diff)).toBe(false)
  })

  it('⚠️ 手動移除**任一**欄位都被指出（SC-007 的「100%」逐欄窮舉）', () => {
    for (const target of CLOSURE_BOARD_FIELDS) {
      const diff = diffBoardFields(actualFields({ omit: [target.name] }))
      expect(diff.missing.map(f => f.name), `移除 ${target.name} 沒有被指出`).toEqual([target.name])
      expect(isDiffClean(diff)).toBe(false)
    }
  })
})

describe('B3：型別不符 MUST 被指出（欄位存在但不能做數值統計）', () => {
  it('sentiment_trough 被建成 ShortText → typeMismatch 列出實際與應為', () => {
    const diff = diffBoardFields(actualFields({ retype: { sentiment_trough: 'ShortText' } }))
    expect(diff.typeMismatch).toEqual([
      { name: 'sentiment_trough', actual: 'ShortText', expected: 'Number' },
    ])
    expect(diff.missing).toEqual([])
    expect(isDiffClean(diff)).toBe(false)
  })

  it('型別不符時不再比對選項 —— 先把型別修好（否則會多噴一堆噪音）', () => {
    const diff = diffBoardFields(actualFields({ retype: { category: 'ShortText' } }))
    expect(diff.typeMismatch.map(m => m.name)).toEqual(['category'])
    expect(diff.optionMismatch).toEqual([])
  })
})

describe('B4：受控詞彙的選項也 MUST 比對', () => {
  it('category 少一個選項 → optionMismatch 列出缺的值', () => {
    const withoutOne = CLOSURE_BOARD_FIELDS.find(f => f.name === 'category')!.options!
      .filter(o => o !== '退款進度')
    const diff = diffBoardFields(actualFields({ options: { category: [...withoutOne] } }))

    expect(diff.optionMismatch).toEqual([
      { name: 'category', missing: ['退款進度'], extra: [] },
    ])
    expect(isDiffClean(diff)).toBe(false)
  })

  it('Board 多出設定檔沒有的選項 → 列在 extra，⚠️ 只報不移除', () => {
    const plusOne = [
      ...CLOSURE_BOARD_FIELDS.find(f => f.name === 'category')!.options!,
      '營運手動加的分類',
    ]
    const diff = diffBoardFields(actualFields({ options: { category: plusOne } }))
    expect(diff.optionMismatch).toEqual([
      { name: 'category', missing: [], extra: ['營運手動加的分類'] },
    ])
  })
})

describe('⚠️ 「讀不到選項」與「選項不符」是兩件事', () => {
  it('平台不回選項時進 optionsUnreadable，且**不**計入不通過', () => {
    /*
      ⚠️ 2026-09-04 實測：`boards.get()` 對以 options 建立的 SingleSelection 欄位
         **不回任何選項欄位**（`scripts/spike/out/29-board-detail.json`）。
         把它報成「全部選項都缺」的話，`--verify` 會每次都非零離開，
         B2 的離開碼從此失去意義 —— 那比不檢查更糟。
    */
    const selectionFields = CLOSURE_BOARD_FIELDS.filter(f => f.options).map(f => f.name)
    const diff = diffBoardFields(actualFields({ dropOptions: selectionFields }))

    expect(diff.optionsUnreadable.sort()).toEqual([...selectionFields].sort())
    expect(diff.optionMismatch).toEqual([])
    expect(isDiffClean(diff), '讀不到選項不算不通過').toBe(true)
  })
})
