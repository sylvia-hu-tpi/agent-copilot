/**
 * 摘要在併發合併的 rerun 裡 MUST 用「當下」的摘要，不是觸發當下捕捉的那份 —— 2026-09-02 005 code review。
 *
 * ⚠️ `runBlockDeduped()` 的 rerun 跑的是最新那次觸發的閉包（specs/005 T026b 的修正）。摘要的增量輸入
 *    帶著 `previousSummary`，若在 `runIncremental()` 讀一次就捕捉進閉包，前一批落地後 rerun 會拿舊摘要
 *    ＋ 新訊息重算：前一批的事實從摘要裡消失、`basedOnMessageId` 跳過它們，畫面上一切正常。
 *    MockAIProvider 的 `summarize()` 會把 `previousSummary.keyFacts` 帶下去並附上「最新訊息：<id>」，
 *    因此兩批都落地時 keyFacts 必須同時含兩則 id —— 這條就是那個斷言。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runColdStart, runIncremental } from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import type { Message } from '../shared/types/conversation.js'

let seq = 0
function customer(convId: string, n: number): Message {
  return {
    id: `m_sr_${n}`,
    conversationId: convId,
    at: new Date(Date.parse('2026-09-02T10:00:00.000Z') + n * 1000).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text: `客戶第 ${n} 句`,
  }
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
})

describe('摘要 rerun 的 previousSummary 從 state 重讀', () => {
  it('第一批在飛時第二批抵達 → 兩批的事實都在最終摘要裡，basedOnMessageId 是第二批', async () => {
    const id = `conv-sr-${Date.now()}-${++seq}`
    await runColdStart(id, [customer(id, 0)], false)

    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let summarizeCalls = 0
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        summarizeCalls++
        if (summarizeCalls === 1) await gate // 第一批卡住，製造「在飛」的窗口
        return super.summarize(input)
      }
    })())

    const first = runIncremental(id, [customer(id, 1)], 'foreground', false)
    await vi.waitFor(() => expect(summarizeCalls).toBe(1))
    const second = runIncremental(id, [customer(id, 2)], 'foreground', false)
    releaseGate?.()
    await Promise.all([first, second])

    const summary = (await useStateStore().getAnalysisState(id))!.summaryBlock.summary!
    expect(summary.keyFacts).toContain('最新訊息：m_sr_1')
    expect(summary.keyFacts).toContain('最新訊息：m_sr_2')
    expect(summary.basedOnMessageId).toBe('m_sr_2')
  })
})
