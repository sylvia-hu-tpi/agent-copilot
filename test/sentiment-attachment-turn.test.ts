/**
 * 純附件（無文字）客戶發言的中性標記 —— specs/001-sentiment-panel FR-002、FR-012。
 *
 * 涵蓋：
 *   - 純附件輪 MUST NOT 產生 SentimentPoint
 *   - 純附件輪 MUST 產生 SentimentMarker，且出現在 timeline 中不消失
 *   - SentimentMarker 不參與 isSentimentAlerting() 的示警判定
 */

import { afterEach, describe, expect, it } from 'vitest'
import { runColdStart } from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { useStateStore } from '../server/state/index.js'
import { isSentimentAlerting } from '../shared/types/copilot.js'
import type { Message } from '../shared/types/conversation.js'

let seq = 0
function customerText(convId: string, text: string, minutesAgo: number): Message {
  seq++
  return {
    id: `m_text_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text,
  }
}

function customerAttachmentOnly(convId: string, minutesAgo: number): Message {
  seq++
  return {
    id: `m_attach_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text: '',
    attachments: [{ id: 'a1', kind: 'image', filename: 'photo.jpg' }],
  }
}

function agentText(convId: string, text: string, minutesAgo: number): Message {
  seq++
  return {
    id: `m_agent_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sender: { type: 'agent', id: 'u_1' },
    text,
  }
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
})

describe('純附件輪的中性標記（FR-002、FR-012）', () => {
  it('純附件輪 MUST NOT 產生分數點，MUST 產生 marker，且不消失於 timeline', async () => {
    setAIProvider(new MockAIProvider())
    const convId = `conv-attach-${Date.now()}`

    const textMsg = customerText(convId, '你好，我想問訂單狀態', 5)
    const attachMsg = customerAttachmentOnly(convId, 4)
    const agentMsg = agentText(convId, '好的，我幫您查詢', 3)

    await runColdStart(convId, [textMsg, attachMsg, agentMsg])

    const state = await useStateStore().getAnalysisState(convId)
    expect(state).not.toBeNull()

    const timeline = state!.sentimentBlock.timeline
    expect(timeline).toHaveLength(2)

    const point = timeline.find(e => e.messageId === textMsg.id)
    const marker = timeline.find(e => e.messageId === attachMsg.id)

    expect(point?.kind).toBe('point')
    expect(marker?.kind).toBe('attachment_only')
    // agent 的訊息完全不進 timeline —— 只有客戶發言會被評分或標記
    expect(timeline.some(e => e.messageId === agentMsg.id)).toBe(false)
  })

  it('純附件輪 MUST NOT 呼叫 AIProvider.analyzeSentiment（不送模型）', async () => {
    let calledWith: Message[] | undefined
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: { messages: Message[] }) {
        calledWith = input.messages
        return super.analyzeSentiment(input)
      }
    })())

    const convId = `conv-attach-only-${Date.now()}`
    const attachMsg = customerAttachmentOnly(convId, 1)
    await runColdStart(convId, [attachMsg])

    // 只有純附件輪、沒有任何含文字客戶發言時，analyzeSentiment 完全不會被呼叫
    expect(calledWith).toBeUndefined()

    const state = await useStateStore().getAnalysisState(convId)
    expect(state?.sentimentBlock.timeline).toHaveLength(1)
    expect(state?.sentimentBlock.timeline[0]?.kind).toBe('attachment_only')
  })
})

describe('isSentimentAlerting() —— SentimentMarker 不參與示警判定（FR-012）', () => {
  it('marker 混雜在 timeline 中不影響判定結果', () => {
    const timeline = [
      { kind: 'point' as const, messageId: '1', at: 't1', score: 80, label: 'calm' as const, drivers: [] },
      { kind: 'attachment_only' as const, messageId: '2', at: 't2' },
      { kind: 'point' as const, messageId: '3', at: 't3', score: 20, label: 'frustrated' as const, drivers: [] },
      { kind: 'attachment_only' as const, messageId: '4', at: 't4' },
    ]
    expect(isSentimentAlerting(timeline)).toBe(true)
  })

  it('全部都是 marker 時不示警（沒有任何評分點可判定）', () => {
    const timeline = [
      { kind: 'attachment_only' as const, messageId: '1', at: 't1' },
      { kind: 'attachment_only' as const, messageId: '2', at: 't2' },
    ]
    expect(isSentimentAlerting(timeline)).toBe(false)
  })
})
