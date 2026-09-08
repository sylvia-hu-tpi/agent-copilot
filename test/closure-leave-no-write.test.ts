/**
 * SC-006／FR-002：**「離開」不會寫入任何紀錄，也不會產生任何摘要。**
 *
 * ⚠️ 006 把 LEAVE 移到「寫入成功之後」（FR-033、research #16），
 *    因此 LEAVE 這條路徑上出現了一個以前不存在的風險：
 *    有人為了「順手把摘要留下來」而在 LEAVE 裡呼叫寫入。
 *    那件事不會報錯 —— 客服按下的是「離開」，畫面上什麼都沒變，
 *    但 CRM 多了一筆沒有人看過的紀錄。憲法第五條禁止的正是這個。
 *
 * ⚠️ 同時重跑 003 SC-002（離開後不再產生新分析）——
 *    006 改了 `closeConversation()`，而 003 的那條保證是靠
 *    「LEAVE 之後沒有人 JOIN」成立的。20 次全部成立才算過。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { clientForSession, leaveConversation } from '../server/services/imbrace.js'
import {
  cancelPendingAnalysis,
  runIncremental,
  setJoinedResolver,
} from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { MOCK_TCU_ID, startMockGateway, type MockGateway } from './mock-gateway.js'
import type { Message } from '../shared/types/conversation.js'

const ROUNDS = 20

let gateway: MockGateway | undefined

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  setJoinedResolver(null)
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
})

/** 數兩件事：結案摘要被產了幾次、一般分析被跑了幾次 */
function countingAI(): { closure: () => number, analysis: () => number } {
  let closure = 0
  let analysis = 0
  setAIProvider(new (class extends MockAIProvider {
    override async summarizeClosure(input: Parameters<MockAIProvider['summarizeClosure']>[0]) {
      closure++
      return super.summarizeClosure(input)
    }

    override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
      analysis++
      return super.analyzeSentiment(input)
    }
  })())
  return { closure: () => closure, analysis: () => analysis }
}

function customer(convId: string, n: number): Message {
  return {
    id: `m_leave_${n}`,
    conversationId: convId,
    at: new Date(Date.UTC(2026, 8, 3, 0, n, 0)).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text: '客戶說了一句話',
  }
}

describe('SC-006：LEAVE 20 次，Board 寫入 0 次、結案摘要產生 0 次', () => {
  it(`連續 ${ROUNDS} 次 LEAVE 都不碰 Board、不呼叫 summarizeClosure()`, async () => {
    gateway = await startMockGateway({ mode: 'manual' })
    const ai = countingAI()
    const client = clientForSession(
      { accessToken: 'acc_TESTTOKEN', organizationId: 'org_a' },
      { baseUrl: gateway.baseUrl },
    )

    for (let i = 0; i < ROUNDS; i++) {
      await leaveConversation(client, MOCK_TCU_ID)
    }

    // LEAVE 真的打出去了 —— 少了這條，下面三個 0 會是「什麼都沒發生」的 0
    expect(gateway.requests.filter(r => r.path.includes('_leave'))).toHaveLength(ROUNDS)

    expect(gateway.boardCallCount('create')).toBe(0)
    expect(gateway.boardCallCount('update')).toBe(0)
    // 連查詢都不該有 —— LEAVE 沒有任何理由碰結案紀錄
    expect(gateway.boardCallCount('search')).toBe(0)
    expect(gateway.boardItems()).toEqual([])
    expect(ai.closure()).toBe(0)
  })
})

describe('003 SC-002 重跑：LEAVE 之後不再產生新分析（20/20）', () => {
  it('20 次全部成立', async () => {
    const ai = countingAI()
    let held = 0

    for (let i = 0; i < ROUNDS; i++) {
      const convId = `conv-leave-${Date.now()}-${i}`
      // 客服已離開 —— 分析狀態可能還在（2 小時 sliding TTL），但沒有人 JOIN 了
      setJoinedResolver(() => false)
      cancelPendingAnalysis(convId)

      const before = ai.analysis()
      await runIncremental(convId, [customer(convId, i)], 'foreground', false)
      if (ai.analysis() === before) held++
    }

    expect(held).toBe(ROUNDS)
  })
})
