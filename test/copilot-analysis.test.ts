/**
 * 摘要／情緒分析管線 —— specs/001-sentiment-panel。
 *
 * US1（T012）：冷啟動輸入涵蓋完整歷史、無客戶發言時維持 empty、Zod 驗證失敗轉 error、
 *              analyzing 事件先於 AI 呼叫 resolve 前發布。
 * US2（T018）：增量分析輸入僅含 patch（不含完整歷史）、debounce 聚合、
 *              ready → analyzing 保留舊內容、isSentimentAlerting() 遲滯規則。
 * US3（T022）：兩區塊獨立成敗、analyzing → retrying → error 狀態轉移、
 *              手動重試（retryBlock）只影響指定區塊。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lastCoveredMessageId,
  newCustomerMessagesSince,
  retryBlock,
  runColdStart,
  runIncremental,
  scheduleIncremental,
} from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { AIProviderHttpError } from '../server/services/ai/retry-policy.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { useEventBus, useStateStore } from '../server/state/index.js'
import { conversationTopic } from '../server/state/types.js'
import { isSentimentAlerting } from '../shared/types/copilot.js'
import type { CopilotEvent } from '../shared/types/events.js'
import type { ConversationSummary } from '../shared/types/copilot.js'
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

function agentText(convId: string, text: string, minutesAgo = 1): Message {
  seq++
  return {
    id: `m_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sender: { type: 'agent', id: 'u_1' },
    text,
  }
}

function convId(label: string): string {
  return `conv-${label}-${Date.now()}-${seq}`
}

/** 收集某對話 topic 上 publish 出來的事件 */
function collect(id: string): CopilotEvent[] {
  const events: CopilotEvent[] = []
  useEventBus().subscribe(conversationTopic(id), payload => events.push(payload as CopilotEvent))
  return events
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
  vi.useRealTimers()
})

// ── US1：冷啟動 ───────────────────────────────────────────────────────

describe('runColdStart()（US1）', () => {
  it('送給 AIProvider 的輸入涵蓋完整對話歷史', async () => {
    let historySeen: Message[] | undefined
    let sentimentMessagesSeen: Message[] | undefined
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: { history: Message[] }) {
        historySeen = input.history
        return super.summarize(input)
      }

      override async analyzeSentiment(input: { messages: Message[] }) {
        sentimentMessagesSeen = input.messages
        return super.analyzeSentiment(input)
      }
    })())

    const id = convId('cold')
    const history = [
      customerText(id, '你好', 10),
      agentText(id, '您好，有什麼可以幫忙', 9),
      customerText(id, '我的訂單還沒到', 8),
    ]
    await runColdStart(id, history)

    expect(historySeen).toEqual(history)
    expect(sentimentMessagesSeen).toEqual(history.filter(m => m.sender.type === 'customer'))
  })

  it('客戶尚無任何發言時，兩區塊維持 empty，不呼叫 AI（FR-009）', async () => {
    let called = false
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        called = true
        return super.summarize(input)
      }
    })())

    const id = convId('empty')
    await runColdStart(id, [agentText(id, '歡迎光臨', 1)])

    expect(called).toBe(false)
    const state = await useStateStore().getAnalysisState(id)
    expect(state?.summaryBlock.status).toBe('empty')
    expect(state?.sentimentBlock.status).toBe('empty')
  })

  it('AI 輸出格式不符 Zod schema 時，該次分析轉為 error（憲法 4.2）', async () => {
    setAIProvider(new MockAIProvider({ invalidSummaryOutput: true, invalidSentimentOutput: true }))

    const id = convId('invalid')
    await runColdStart(id, [customerText(id, '你好')])

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.summaryBlock.status).toBe('error')
    expect(state?.summaryBlock.summary).toBeNull()
    expect(state?.sentimentBlock.status).toBe('error')
  })

  it('analyzing 事件在 AIProvider 呼叫 resolve 之前已發布（FR-011、SC-001）', async () => {
    let resolveSummarize: (() => void) | undefined
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        await new Promise<void>((resolve) => { resolveSummarize = resolve })
        return super.summarize(input)
      }
    })())

    const id = convId('analyzing-order')
    const events = collect(id)

    const promise = runColdStart(id, [customerText(id, '你好')])

    // 讓 runColdStart 內部跑到「卡在 summarize() 的 await」那一步
    await vi.waitFor(() => expect(resolveSummarize).toBeDefined())

    // 此時 AI 呼叫尚未 resolve，但 analyzing 事件必須已經發布
    const analyzingEvent = events.find(e => e.type === 'summary.updated' && e.summary.status === 'analyzing')
    expect(analyzingEvent).toBeDefined()

    resolveSummarize?.()
    await promise
  })
})

// ── US2：增量更新 ─────────────────────────────────────────────────────

describe('runIncremental()（US2）', () => {
  it('模型輸入僅含既有摘要與新增客戶訊息，MUST NOT 含完整歷史（FR-004）', async () => {
    let historySeen: Message[] | undefined
    let previousSummarySeen: ConversationSummary | undefined
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: { history: Message[], previousSummary?: ConversationSummary }) {
        historySeen = input.history
        previousSummarySeen = input.previousSummary
        return super.summarize(input)
      }
    })())

    const id = convId('incremental')
    await runColdStart(id, [customerText(id, '第一句', 10)])
    const stateAfterCold = await useStateStore().getAnalysisState(id)
    expect(stateAfterCold?.summaryBlock.status).toBe('ready')

    const newMsg = customerText(id, '第二句', 1)
    await runIncremental(id, [newMsg])

    expect(historySeen).toEqual([newMsg])
    expect(previousSummarySeen).toEqual(stateAfterCold?.summaryBlock.summary)
  })

  it('ready → analyzing 轉移時保留舊內容，不清空（data-model.md 呈現規則）', async () => {
    const id = convId('keep-old')
    await runColdStart(id, [customerText(id, '第一句', 10)])
    const before = await useStateStore().getAnalysisState(id)
    expect(before?.summaryBlock.summary).not.toBeNull()

    let resolveSummarize: (() => void) | undefined
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        await new Promise<void>((resolve) => { resolveSummarize = resolve })
        return super.summarize(input)
      }
    })())

    const events = collect(id)
    const promise = runIncremental(id, [customerText(id, '第二句', 1)])
    await vi.waitFor(() => expect(resolveSummarize).toBeDefined())

    const analyzingEvent = events.find(e => e.type === 'summary.updated' && e.summary.status === 'analyzing')
    expect(analyzingEvent?.type === 'summary.updated' && analyzingEvent.summary.summary).toEqual(before?.summaryBlock.summary)

    resolveSummarize?.()
    await promise
  })
})

describe('scheduleIncremental()（US2，§11.1 debounce）', () => {
  it('1 秒內多筆客戶發言合併為單次 runIncremental() 呼叫', async () => {
    vi.useFakeTimers()
    let callCount = 0
    let lastMessages: Message[] = []
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: { history: Message[] }) {
        callCount++
        lastMessages = input.history
        return super.summarize(input)
      }
    })())

    const id = convId('debounce')
    await runColdStart(id, [customerText(id, '第一句', 10)])
    callCount = 0 // 只計算 debounce 之後的呼叫

    const m1 = customerText(id, 'A', 2)
    const m2 = customerText(id, 'B', 1)
    scheduleIncremental(id, [m1])
    scheduleIncremental(id, [m2])

    await vi.advanceTimersByTimeAsync(1_100)

    expect(callCount).toBe(1)
    expect(lastMessages).toEqual([m1, m2])
    vi.useRealTimers()
  })
})

describe('isSentimentAlerting() 遲滯規則（FR-003 2026-08-26 修訂）', () => {
  function point(label: 'calm' | 'neutral' | 'concerned' | 'frustrated' | 'angry', id: string) {
    return { kind: 'point' as const, messageId: id, at: id, score: 50, label, drivers: [] }
  }

  it('[...,frustrated] → true', () => {
    expect(isSentimentAlerting([point('calm', '1'), point('frustrated', '2')])).toBe(true)
  })

  it('[...,frustrated,neutral] → false（回到擔憂以下即解除）', () => {
    expect(isSentimentAlerting([point('frustrated', '1'), point('neutral', '2')])).toBe(false)
  })

  it('[...,frustrated,concerned] → 仍為 true（擔憂是中繼風險區間，未解除）', () => {
    expect(isSentimentAlerting([point('frustrated', '1'), point('concerned', '2')])).toBe(true)
  })
})

// ── US3：故障隔離與手動重試 ────────────────────────────────────────────

describe('故障隔離與重試（US3）', () => {
  it('摘要失敗不影響情緒區塊，反之亦然', async () => {
    setAIProvider(new MockAIProvider({
      summarizeFailure: () => new AIProviderHttpError('boom', 400),
    }))

    const id = convId('isolate')
    await runColdStart(id, [customerText(id, '你好')])

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.summaryBlock.status).toBe('error')
    expect(state?.sentimentBlock.status).toBe('ready')
  })

  it('狀態依序轉移 analyzing → retrying → error（暫時性失敗，重試用盡）', async () => {
    setAIProvider(new MockAIProvider({
      summarizeFailure: () => new AIProviderHttpError('server error', 500),
    }))

    const id = convId('retrying-seq')
    const events = collect(id)

    vi.useFakeTimers()
    const promise = runColdStart(id, [customerText(id, '你好')])
    await vi.runAllTimersAsync()
    await promise
    vi.useRealTimers()

    const statuses = events
      .filter(e => e.type === 'summary.updated')
      .map(e => e.type === 'summary.updated' && e.summary.status)

    expect(statuses[0]).toBe('analyzing')
    expect(statuses).toContain('retrying')
    expect(statuses[statuses.length - 1]).toBe('error')
  })

  it('retryBlock() 手動重試只重跑指定區塊，不影響另一區塊已顯示內容（FR-008）', async () => {
    setAIProvider(new MockAIProvider({
      sentimentFailure: () => new AIProviderHttpError('unauthorized', 401),
    }))

    const id = convId('manual-retry')
    const history = [customerText(id, '你好')]
    await runColdStart(id, history)

    const failed = await useStateStore().getAnalysisState(id)
    expect(failed?.sentimentBlock.status).toBe('error')
    const summaryBeforeRetry = failed?.summaryBlock.summary

    setAIProvider(new MockAIProvider())
    await retryBlock(id, 'sentiment', history)

    const recovered = await useStateStore().getAnalysisState(id)
    expect(recovered?.sentimentBlock.status).toBe('ready')
    // 摘要區塊完全不受手動重試情緒區塊影響
    expect(recovered?.summaryBlock.summary).toEqual(summaryBeforeRetry)
  })
})

describe('lastCoveredMessageId()（T010c 重連快照的補跑判斷依據）', () => {
  it('回傳 timeline 最後一筆的 messageId', async () => {
    const id = convId('covered')
    const history = [customerText(id, '第一句', 10), customerText(id, '第二句', 1)]
    await runColdStart(id, history)

    const state = await useStateStore().getAnalysisState(id)
    expect(lastCoveredMessageId(state!)).toBe(history[1]!.id)
  })

  it('尚無任何資料時回傳 null', () => {
    const empty = { conversationId: 'x', summaryBlock: { status: 'empty' as const, summary: null, updatedAt: '' }, sentimentBlock: { status: 'empty' as const, timeline: [], stats: { lowestScore: null, lowestAt: null }, updatedAt: '' } }
    expect(lastCoveredMessageId(empty)).toBeNull()
  })
})

// ── 迴歸測試（2026-08-26，真實環境回報）──────────────────────────────────
//
// 症狀：使用者從未 JOIN 過的對話，摘要卡就已經顯示分析結果；JOIN 之後畫面完全沒反應；
// 「已知事實」欄位裡同一則訊息 id 重複出現多次。追查後是兩個獨立成因：
//   ① session-manager.ts 的 onMessages() 對任何被 SSE 檢視的對話都會觸發（不限 JOIN），
//      runIncremental() 卻會用 ensureState() 悄悄建立分析狀態，等於未 JOIN 也在分析。
//   ② T010c 重連快照的 fetchSince() 在錨點被擠出最近 50 則視窗時回傳整批，
//      未去重就直接送進 runIncremental()，把已經處理過的訊息當成新的重複分析。

describe('迴歸：未 JOIN 的對話不得被 runIncremental() 悄悄分析', () => {
  it('從未 runColdStart() 過的對話（無 CopilotAnalysisState），runIncremental() 為 no-op', async () => {
    let called = false
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        called = true
        return super.summarize(input)
      }
    })())

    const id = convId('never-joined')
    await runIncremental(id, [customerText(id, '客戶在對話仍未 JOIN 時發言')])

    expect(called).toBe(false)
    expect(await useStateStore().getAnalysisState(id)).toBeNull()
  })

  it('已 runColdStart()（已 JOIN）過的對話，runIncremental() 正常運作', async () => {
    const id = convId('already-joined')
    await runColdStart(id, [customerText(id, '第一句', 10)])

    const before = await useStateStore().getAnalysisState(id)
    expect(before?.summaryBlock.status).toBe('ready')

    await runIncremental(id, [customerText(id, '第二句', 1)])

    const after = await useStateStore().getAnalysisState(id)
    expect(after?.sentimentBlock.timeline).toHaveLength(2)
  })
})

describe('迴歸：newCustomerMessagesSince() 對已涵蓋的訊息去重（T010c）', () => {
  it('fetchSince() 因錨點被擠出視窗而回傳整批時，已涵蓋的訊息 MUST 被濾掉', async () => {
    const id = convId('anchor-evicted')
    const covered = customerText(id, '已經分析過的訊息', 10)
    await runColdStart(id, [covered])

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.timeline).toHaveLength(1)

    // 模擬 fetchSince() 錨點失效、回傳整批（含已涵蓋的 covered 訊息本身）
    const result = newCustomerMessagesSince(state!, [covered])
    expect(result).toEqual([])
  })

  it('整批中混雜真正的新訊息時，只留下尚未涵蓋的部分', async () => {
    const id = convId('anchor-evicted-mixed')
    const covered = customerText(id, '已經分析過的訊息', 10)
    await runColdStart(id, [covered])
    const state = await useStateStore().getAnalysisState(id)

    const freshMsg = customerText(id, '真正的新訊息', 1)
    const result = newCustomerMessagesSince(state!, [covered, freshMsg])
    expect(result).toEqual([freshMsg])
  })

  it('過濾同時排除非客戶訊息（防禦性——理論上 fetchSince 就可能混雜 agent/ai 訊息）', async () => {
    const id = convId('anchor-evicted-agent')
    const covered = customerText(id, '已經分析過的訊息', 10)
    await runColdStart(id, [covered])
    const state = await useStateStore().getAnalysisState(id)

    const agentMsg = agentText(id, '客服的回覆', 1)
    const result = newCustomerMessagesSince(state!, [agentMsg])
    expect(result).toEqual([])
  })
})

describe('迴歸：情緒分析依 SENTIMENT_CHUNK_SIZE 分批呼叫（2026-08-27，真實環境回報）', () => {
  // 真實對話 16 則客戶發言，單次呼叫（不分批）實測延遲 12.7～29.9 秒，
  // 遠超 FR-014 的 15 秒單次逾時——改成每批固定則數依序呼叫，見 copilot-analysis.ts
  // SENTIMENT_CHUNK_SIZE 常數上方的說明。

  it('客戶發言超過一批的則數時，AIProvider.analyzeSentiment() 被呼叫多次，每次都不超過批次大小', async () => {
    const callSizes: number[] = []
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: { messages: Message[] }) {
        callSizes.push(input.messages.length)
        return super.analyzeSentiment(input)
      }
    })())

    const id = convId('chunked')
    // 9 則客戶發言：預期分成 6 + 3 兩批（SENTIMENT_CHUNK_SIZE = 6）
    const history = Array.from({ length: 9 }, (_, i) => customerText(id, `第 ${i + 1} 句`, 20 - i))
    await runColdStart(id, history)

    expect(callSizes).toEqual([6, 3])
    expect(callSizes.every(n => n <= 6)).toBe(true)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.status).toBe('ready')
    // 兩批的結果要正確合併成同一份完整 timeline，不因為分批而漏掉或重複
    expect(state?.sentimentBlock.timeline).toHaveLength(9)
    expect(new Set(state?.sentimentBlock.timeline.map(e => e.messageId)).size).toBe(9)
  })

  it('其中一批持續失敗時，整個情緒區塊轉為 error（不落地部分批次的結果）', async () => {
    let call = 0
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: { messages: Message[] }) {
        call++
        // 第一批（6 則）成功，第二批（第 7～9 則）持續失敗
        if (call > 1) throw new AIProviderHttpError('boom', 500)
        return super.analyzeSentiment(input)
      }
    })())

    const id = convId('chunked-partial-fail')
    const history = Array.from({ length: 9 }, (_, i) => customerText(id, `第 ${i + 1} 句`, 20 - i))

    vi.useFakeTimers()
    const promise = runColdStart(id, history)
    await vi.runAllTimersAsync()
    await promise
    vi.useRealTimers()

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.status).toBe('error')
    // 第一批已成功的 8 個點不落地——寧可整批視為失敗、之後手動重試整批重來，
    // 也不留一份只算了一半的殘缺 timeline（見 copilot-analysis.ts 的設計取捨說明）
    expect(state?.sentimentBlock.timeline).toHaveLength(0)
  })
})
