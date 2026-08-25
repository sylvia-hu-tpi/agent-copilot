/**
 * AI workflow 內部訊息的判別 —— §10.4 撞單防護的正確性。
 *
 * ⚠️ 這是 M1 手動驗收時從真實資料發現的：同一個 workflow 會在同一個對話裡
 *    送出兩種東西，而**平台完全無法區分**（同一個 from、同樣 type、欄位一致）：
 *
 *      pub_486c5cab…  抱歉造成您使用上的不便，請協助確認…       ← 真的回給客戶
 *      pub_486c5cab…  {"category":"DEV-001","confidence":"high"}  ← 內部分類
 *      pub_486c5cab…  {"route": "T1"}                            ← 內部路由
 *
 *    把內部訊息當成「AI 已回覆客戶」會在 Hybrid 模式下產生假警報，
 *    而**假警報比沒有警報更糟** —— 客服學會忽略提示後，真正的撞單也會被略過。
 */

import { describe, expect, it } from 'vitest'
import { isWorkflowInternalMessage } from '../shared/types/conversation.js'
import type { Message, SenderType } from '../shared/types/conversation.js'

function msg(text: string, type: SenderType = 'ai'): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    at: '2026-08-25T00:00:00.000Z',
    sender: { type, id: type === 'ai' ? 'pub_bot' : 'u_someone' },
    text,
  }
}

describe('內部訊息（實測到的真實樣本）', () => {
  it.each([
    '{"route": "T1"}',
    '{"category":"DEV-001","confidence":"high"}',
    '  {"route":"T2"}  ',
    '["a","b"]',
  ])('%s → 判定為內部訊息', (text) => {
    expect(isWorkflowInternalMessage(msg(text))).toBe(true)
  })
})

describe('真正回給客戶的 AI 訊息不可被誤判', () => {
  it.each([
    '抱歉造成您使用上的不便，請協助確認寬頻上網使用的數據機燈號是否正常',
    '您好，我幫您查詢一下',
    '',
  ])('%s → 不是內部訊息', (text) => {
    expect(isWorkflowInternalMessage(msg(text))).toBe(false)
  })

  it('以 { 開頭但不是合法 JSON 的普通文字不算內部訊息', () => {
    // 客戶問「{...} 是什麼意思？」時 AI 可能照著複述
    expect(isWorkflowInternalMessage(msg('{這不是 JSON'))).toBe(false)
    expect(isWorkflowInternalMessage(msg('{ 請問這個符號代表什麼 }'))).toBe(false)
  })

  it('純數字或字串形式的 JSON 不算 —— 只有物件／陣列才是結構化內部資料', () => {
    expect(isWorkflowInternalMessage(msg('123'))).toBe(false)
    expect(isWorkflowInternalMessage(msg('"hello"'))).toBe(false)
  })
})

describe('只對 AI 訊息生效', () => {
  it('⚠️ 客服送出的 JSON 不可被當成內部訊息 —— 那會讓真正的撞單被漏掉', () => {
    expect(isWorkflowInternalMessage(msg('{"route":"T1"}', 'agent'))).toBe(false)
  })

  it('客戶送出的 JSON 同樣不受影響', () => {
    expect(isWorkflowInternalMessage(msg('{"a":1}', 'customer'))).toBe(false)
  })

  it('未知來源一律不判定為內部 —— 寧可漏判也不可誤判（§10.4）', () => {
    expect(isWorkflowInternalMessage(msg('{"a":1}', 'unknown'))).toBe(false)
  })
})
