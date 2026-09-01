/**
 * 對話摘要的 `narrative`／`topics` 兩個選填欄位 —— 2026-09-01 為對齊畫布 2a
 * 「對話摘要」新增（`docs/DESIGN_TOKENS.md` §7.2）。
 *
 * ⚠️ **這個檔案守的核心命題只有一句：這兩個欄位怎麼壞都不能把整份摘要打掉。**
 *    它們由 iMBrace 後台的 `AgentCopilot_摘要_agent` 產生，那份 system prompt
 *    **不在這個 repo 裡** —— 後台還沒更新、被改回舊版、或某一次回了奇怪的值，
 *    都不該讓摘要區塊轉 error。`intent`／`advice` 才是「沒有就等於分析失敗」的欄位。
 */

import { describe, expect, it } from 'vitest'
import { parseConversationSummary } from '../server/services/ai/schemas.js'
import { SUMMARY_TOPIC_MAX_COUNT, SUMMARY_TOPIC_MAX_LENGTH } from '../shared/types/copilot.js'

/** 除了受測欄位以外都合法的最小輸入 */
function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: '客戶詢問電子發票補寄',
    keyFacts: [],
    attempted: [],
    openIssues: [],
    riskFlags: [],
    advice: '先致歉再給明確時效',
    updatedAt: '2026-09-01T06:20:11.000Z',
    basedOnMessageId: 'msg_1',
    ...extra,
  }
}

describe('narrative：缺值、空值、型別不對都不得使整份摘要失敗', () => {
  it('後台還沒更新（欄位不存在）時仍通過，narrative 為 undefined', () => {
    const parsed = parseConversationSummary(base())
    expect(parsed.narrative).toBeUndefined()
    expect(parsed.intent).toBe('客戶詢問電子發票補寄')
  })

  it('空字串／全空白視同缺值，而不是驗證失敗', () => {
    expect(parseConversationSummary(base({ narrative: '' })).narrative).toBeUndefined()
    expect(parseConversationSummary(base({ narrative: '   \n ' })).narrative).toBeUndefined()
  })

  it('型別不對（數字／物件）也只是視同缺值', () => {
    expect(parseConversationSummary(base({ narrative: 42 })).narrative).toBeUndefined()
    expect(parseConversationSummary(base({ narrative: { text: 'x' } })).narrative).toBeUndefined()
  })

  it('有值時去掉頭尾空白後原樣保留', () => {
    const parsed = parseConversationSummary(base({ narrative: '  客戶反映發票未收到。  ' }))
    expect(parsed.narrative).toBe('客戶反映發票未收到。')
  })
})

describe('topics：在防腐層正規化，UI 拿到的一定可以直接畫', () => {
  it('缺值或不是陣列時為 undefined，不拋錯', () => {
    expect(parseConversationSummary(base()).topics).toBeUndefined()
    expect(parseConversationSummary(base({ topics: '發票未收到' })).topics).toBeUndefined()
    expect(parseConversationSummary(base({ topics: null })).topics).toBeUndefined()
  })

  it('去頭尾空白、丟掉空字串與非字串元素、去重', () => {
    const parsed = parseConversationSummary(base({
      topics: ['  發票未收到 ', '', '發票未收到', 123, null, '地址確認'],
    }))
    expect(parsed.topics).toEqual(['發票未收到', '地址確認'])
  })

  it(`最多留 ${SUMMARY_TOPIC_MAX_COUNT} 個 —— 多的丟掉，不讓 pill 列擠爆卡片`, () => {
    const many = Array.from({ length: SUMMARY_TOPIC_MAX_COUNT + 3 }, (_, i) => `主題${i}`)
    expect(parseConversationSummary(base({ topics: many })).topics).toHaveLength(SUMMARY_TOPIC_MAX_COUNT)
  })

  it('過長者**截斷而非丟棄** —— 講太長的標籤仍然帶著資訊', () => {
    const long = '一'.repeat(SUMMARY_TOPIC_MAX_LENGTH + 10)
    const parsed = parseConversationSummary(base({ topics: [long] }))
    expect(parsed.topics).toEqual(['一'.repeat(SUMMARY_TOPIC_MAX_LENGTH)])
  })

  it('全部被過濾光時為 undefined，而不是空陣列 —— 兩者在 UI 的 v-if 上等價，但語意是「沒有」', () => {
    expect(parseConversationSummary(base({ topics: ['', '   ', 7] })).topics).toBeUndefined()
  })
})

describe('對照組：intent／advice 仍然是「沒有就等於失敗」', () => {
  it('intent 為空字串時整份摘要驗不過', () => {
    expect(() => parseConversationSummary(base({ intent: '' }))).toThrow()
  })

  it('advice 為空字串時整份摘要驗不過', () => {
    expect(() => parseConversationSummary(base({ advice: '' }))).toThrow()
  })
})
