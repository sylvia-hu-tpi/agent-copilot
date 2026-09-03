/**
 * catchUpSummaryIfStale() —— specs/002-suggestion-knowledge-search/research.md #10、US4 AC#5。
 *
 * 背景期間 `runIncremental()` 一律跳過 `analyzeSummary()`（FR-020），客服重新聚焦時
 * 才由這支函式補跑。比對基準是 `summaryBlock.summary.basedOnMessageId`——與情緒時間軸的
 * `lastCoveredMessageId()` 是不同的錨點，兩者在背景期間會不同步。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { catchUpSummaryIfStale, runColdStart } from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import type { Message } from '../shared/types/conversation.js'

let seq = 0
function customerText(convId: string, text: string, minutesAgo = 1): Message {
  seq++
  return {
    id: `m_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text,
  }
}

function convId(label: string): string {
  return `conv-${label}-${Date.now()}-${seq}`
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
})

describe('catchUpSummaryIfStale()', () => {
  it('history 中沒有尚未涵蓋的客戶發言時為 no-op（summaryBlock 完全不變）', async () => {
    const id = convId('no-new')
    const history = [customerText(id, '第一句', 10)]
    await runColdStart(id, history, false)

    const before = await useStateStore().getAnalysisState(id)
    expect(before?.summaryBlock.status).toBe('ready')

    // 傳入同一批（沒有比 basedOnMessageId 更新的客戶發言）
    await catchUpSummaryIfStale(id, history)

    const after = await useStateStore().getAnalysisState(id)
    expect(after?.summaryBlock.updatedAt).toBe(before?.summaryBlock.updatedAt)
    expect(after?.summaryBlock.summary).toEqual(before?.summaryBlock.summary)
  })

  it('有新客戶發言時補跑摘要，結果反映新內容（basedOnMessageId 前進）', async () => {
    const id = convId('has-new')
    const first = customerText(id, '第一句', 10)
    await runColdStart(id, [first], false)

    const before = await useStateStore().getAnalysisState(id)
    const anchorBefore = before?.summaryBlock.summary?.basedOnMessageId
    expect(anchorBefore).toBe(first.id)

    // 模擬背景期間累積的新客戶發言（summary 從未見過，但已存在於 fetchSince 的結果裡）
    const second = customerText(id, '背景期間客戶又問了問題', 1)
    await catchUpSummaryIfStale(id, [first, second])

    const after = await useStateStore().getAnalysisState(id)
    expect(after?.summaryBlock.status).toBe('ready')
    expect(after?.summaryBlock.summary?.basedOnMessageId).toBe(second.id)
  })

  it('尚無任何 CopilotAnalysisState（從未 JOIN 過）時為 no-op，不建立新狀態', async () => {
    const id = convId('never-joined')
    const msg = customerText(id, '不該觸發任何分析', 1)

    await catchUpSummaryIfStale(id, [msg])

    expect(await useStateStore().getAnalysisState(id)).toBeNull()
  })

  it('history 中只有 agent／ai 訊息、沒有客戶發言時為 no-op', async () => {
    const id = convId('no-customer-messages')
    const first = customerText(id, '第一句', 10)
    await runColdStart(id, [first], false)
    const before = await useStateStore().getAnalysisState(id)

    const agentMsg: Message = {
      id: 'm_agent_1',
      conversationId: id,
      at: new Date().toISOString(),
      sender: { type: 'agent', id: 'u_1' },
      text: '同事的回覆',
    }
    await catchUpSummaryIfStale(id, [first, agentMsg])

    const after = await useStateStore().getAnalysisState(id)
    expect(after?.summaryBlock.updatedAt).toBe(before?.summaryBlock.updatedAt)
  })
})
