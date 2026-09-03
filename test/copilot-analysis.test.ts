/**
 * 摘要／情緒／建議卡分析管線 —— specs/001-sentiment-panel、specs/002-suggestion-knowledge-search。
 *
 * US1（T012）：冷啟動輸入涵蓋完整歷史、無客戶發言時維持 empty、Zod 驗證失敗轉 error、
 *              analyzing 事件先於 AI 呼叫 resolve 前發布。
 * US2（T018）：增量分析輸入僅含 patch（不含完整歷史）、debounce 聚合、
 *              ready → analyzing 保留舊內容、isSentimentAlerting() 遲滯規則。
 * US3（T022）：兩區塊獨立成敗、analyzing → retrying → error 狀態轉移、
 *              手動重試（retryBlock）只影響指定區塊。
 * US1（specs/002-suggestion-knowledge-search T026）：建議卡併入冷啟動 Promise.all()、
 *              knowledgeSearch 可稽核證據、單卡驗證失敗容錯、白名單全數捨棄仍為 ready。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  awaitSuggestionTail,
  cancelPendingAnalysis,
  checkSuggestionsSuperseded,
  hasSuggestionTail,
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
import { KNOWLEDGE_SEARCH_TIMEOUT_MS } from '../server/services/knowledge/agent-knowledge-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useEventBus, useStateStore } from '../server/state/index.js'
import { conversationTopic } from '../server/state/types.js'
import { isSentimentAlerting } from '../shared/types/copilot.js'
import type { CopilotEvent } from '../shared/types/events.js'
import type { ConversationSummary, SentimentPoint, SuggestionCard } from '../shared/types/copilot.js'
import type { Message } from '../shared/types/conversation.js'
import type { KnowledgeHit, KnowledgeProvider } from '../shared/types/knowledge.js'

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
  setKnowledgeProvider(new MockKnowledgeProvider())
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
    await runColdStart(id, history, false)

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
    await runColdStart(id, [agentText(id, '歡迎光臨', 1)], false)

    expect(called).toBe(false)
    const state = await useStateStore().getAnalysisState(id)
    expect(state?.summaryBlock.status).toBe('empty')
    expect(state?.sentimentBlock.status).toBe('empty')
  })

  it('AI 輸出格式不符 Zod schema 時，該次分析轉為 error（憲法 4.2）', async () => {
    setAIProvider(new MockAIProvider({ invalidSummaryOutput: true, invalidSentimentOutput: true }))

    const id = convId('invalid')
    await runColdStart(id, [customerText(id, '你好')], false)

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

    const promise = runColdStart(id, [customerText(id, '你好')], false)

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
    await runColdStart(id, [customerText(id, '第一句', 10)], false)
    const stateAfterCold = await useStateStore().getAnalysisState(id)
    expect(stateAfterCold?.summaryBlock.status).toBe('ready')

    const newMsg = customerText(id, '第二句', 1)
    await runIncremental(id, [newMsg], "foreground", false)

    expect(historySeen).toEqual([newMsg])
    expect(previousSummarySeen).toEqual(stateAfterCold?.summaryBlock.summary)
  })

  it('ready → analyzing 轉移時保留舊內容，不清空（data-model.md 呈現規則）', async () => {
    const id = convId('keep-old')
    await runColdStart(id, [customerText(id, '第一句', 10)], false)
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
    const promise = runIncremental(id, [customerText(id, '第二句', 1)], "foreground", false)
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
    await runColdStart(id, [customerText(id, '第一句', 10)], false)
    callCount = 0 // 只計算 debounce 之後的呼叫

    const m1 = customerText(id, 'A', 2)
    const m2 = customerText(id, 'B', 1)
    scheduleIncremental(id, [m1], "foreground", false)
    scheduleIncremental(id, [m2], "foreground", false)

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
    await runColdStart(id, [customerText(id, '你好')], false)

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
    const promise = runColdStart(id, [customerText(id, '你好')], false)
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
    await runColdStart(id, history, false)

    const failed = await useStateStore().getAnalysisState(id)
    expect(failed?.sentimentBlock.status).toBe('error')
    const summaryBeforeRetry = failed?.summaryBlock.summary

    setAIProvider(new MockAIProvider())
    await retryBlock(id, 'sentiment', history, false)

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
    await runColdStart(id, history, false)

    const state = await useStateStore().getAnalysisState(id)
    expect(lastCoveredMessageId(state!)).toBe(history[1]!.id)
  })

  it('尚無任何資料時回傳 null', () => {
    const empty = { conversationId: 'x', summaryBlock: { status: 'empty' as const, summary: null, updatedAt: '' }, sentimentBlock: { status: 'empty' as const, timeline: [], stats: { lowestScore: null, lowestAt: null }, narrative: null, updatedAt: '' }, suggestionBlock: { status: 'empty' as const, cards: [], knowledgeSearch: { ran: false, hitCount: 0 }, citation: 'none' as const, basedOnMessageId: null, provenance: { stage: 1 as const, stage1RetryAttempt: 0 }, updatedAt: '' } }
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
    await runIncremental(id, [customerText(id, '客戶在對話仍未 JOIN 時發言')], "foreground", false)

    expect(called).toBe(false)
    expect(await useStateStore().getAnalysisState(id)).toBeNull()
  })

  it('已 runColdStart()（已 JOIN）過的對話，runIncremental() 正常運作', async () => {
    const id = convId('already-joined')
    await runColdStart(id, [customerText(id, '第一句', 10)], false)

    const before = await useStateStore().getAnalysisState(id)
    expect(before?.summaryBlock.status).toBe('ready')

    await runIncremental(id, [customerText(id, '第二句', 1)], "foreground", false)

    const after = await useStateStore().getAnalysisState(id)
    expect(after?.sentimentBlock.timeline).toHaveLength(2)
  })
})

describe('迴歸：newCustomerMessagesSince() 對已涵蓋的訊息去重（T010c）', () => {
  it('fetchSince() 因錨點被擠出視窗而回傳整批時，已涵蓋的訊息 MUST 被濾掉', async () => {
    const id = convId('anchor-evicted')
    const covered = customerText(id, '已經分析過的訊息', 10)
    await runColdStart(id, [covered], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.timeline).toHaveLength(1)

    // 模擬 fetchSince() 錨點失效、回傳整批（含已涵蓋的 covered 訊息本身）
    const result = newCustomerMessagesSince(state!, [covered])
    expect(result).toEqual([])
  })

  it('整批中混雜真正的新訊息時，只留下尚未涵蓋的部分', async () => {
    const id = convId('anchor-evicted-mixed')
    const covered = customerText(id, '已經分析過的訊息', 10)
    await runColdStart(id, [covered], false)
    const state = await useStateStore().getAnalysisState(id)

    const freshMsg = customerText(id, '真正的新訊息', 1)
    const result = newCustomerMessagesSince(state!, [covered, freshMsg])
    expect(result).toEqual([freshMsg])
  })

  it('過濾同時排除非客戶訊息（防禦性——理論上 fetchSince 就可能混雜 agent/ai 訊息）', async () => {
    const id = convId('anchor-evicted-agent')
    const covered = customerText(id, '已經分析過的訊息', 10)
    await runColdStart(id, [covered], false)
    const state = await useStateStore().getAnalysisState(id)

    const agentMsg = agentText(id, '客服的回覆', 1)
    const result = newCustomerMessagesSince(state!, [agentMsg])
    expect(result).toEqual([])
  })
})

describe('迴歸：情緒分析依 SENTIMENT_CHUNK_SIZE 分批呼叫（2026-08-27，真實環境回報）', () => {
  // 真實對話 16 則客戶發言，單次呼叫（不分批）實測延遲 12.7～29.9 秒，
  // 遠超 FR-014 的 15 秒單次逾時——改成每批固定則數各自呼叫，見 copilot-analysis.ts
  // SENTIMENT_CHUNK_SIZE 常數上方的說明。
  // ⚠️ 2026-09-01 起這些呼叫是**有上限的並行**（SENTIMENT_CONCURRENCY），不再依序。
  //    因此本節的斷言 MUST NOT 依賴呼叫先後順序——那會變成在測排程時序，
  //    一改並行度就紅，而它要守的其實是「切幾批、每批多大、失敗怎麼收」。

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
    await runColdStart(id, history, false)

    // 排序後比對：驗的是「切成 6 + 3 兩批」，不是哪一批先送出（見本 describe 開頭的說明）
    expect([...callSizes].sort((a, b) => b - a)).toEqual([6, 3])
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
        // 最先進來的那一次成功，其餘全部持續失敗。
        // ⚠️ 刻意不寫成「第一批成功、第二批失敗」——並行之後哪一批先進來不保證，
        //    但「有一批成功、另一批怎麼重試都失敗」這個情境本身與順序無關。
        if (call > 1) throw new AIProviderHttpError('boom', 500)
        return super.analyzeSentiment(input)
      }
    })())

    const id = convId('chunked-partial-fail')
    const history = Array.from({ length: 9 }, (_, i) => customerText(id, `第 ${i + 1} 句`, 20 - i))

    vi.useFakeTimers()
    const promise = runColdStart(id, history, false)
    await vi.runAllTimersAsync()
    await promise
    vi.useRealTimers()

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.status).toBe('error')
    // 第一批已成功的 8 個點不落地——寧可整批視為失敗、之後手動重試整批重來，
    // 也不留一份只算了一半的殘缺 timeline（見 copilot-analysis.ts 的設計取捨說明）
    expect(state?.sentimentBlock.timeline).toHaveLength(0)
  })

  /*
    ⚠️ 以下兩條守的是 2026-09-01「依序 → 有上限的並行」那次改動的兩個性質。
       兩者都**不會報錯、型別也全過**：並行度被改回 1 只是變慢，上限被拿掉只是偶爾多幾條
       並發，失敗後不停止派工只是多花錢 —— 沒有測試就沒有東西守得住。
  */

  it('批次並行送出，但同時在飛的數量不超過上限', async () => {
    let inFlight = 0
    let peak = 0
    setAIProvider(new (class extends MockAIProvider {
      constructor() {
        // 給每次呼叫一段真實延遲，否則批次之間不會有重疊，量不到並行度
        super({ sentimentDelayMs: 20 })
      }

      override async analyzeSentiment(input: { messages: Message[] }) {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          return await super.analyzeSentiment(input)
        }
        finally {
          inFlight--
        }
      }
    })())

    const id = convId('chunked-concurrency')
    // 30 則客戶發言 → 5 批（SENTIMENT_CHUNK_SIZE = 6），足以讓上限真的被踩到
    const history = Array.from({ length: 30 }, (_, i) => customerText(id, `第 ${i + 1} 句`, 40 - i))
    await runColdStart(id, history, false)

    // ⚠️ 這裡刻意寫死 3 而不是 import 常數：調整並行度時本行 MUST 跟著紅，
    //    強迫改動者看到 copilot-analysis.ts 上方那句「MUST 重跑實測看單次延遲與失敗率」。
    expect(peak).toBe(3)
    // peak === 3 同時證明了兩件事：真的有並行（不是 1），且沒有一次全開（不是 5）
    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.status).toBe('ready')
    expect(state?.sentimentBlock.timeline).toHaveLength(30)
  })

  it('有一批失敗後，尚未開始的批次 MUST NOT 再送出（失敗時的呼叫量不因並行而膨脹）', async () => {
    const firstTexts: string[] = []
    setAIProvider(new (class extends MockAIProvider {
      // 回傳型別要顯式標注：函式只會 throw，推導出來是 Promise<void> 而對不上介面
      override async analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]> {
        firstTexts.push(input.messages[0]!.text)
        throw new AIProviderHttpError('boom', 500)
      }
    })())

    const id = convId('chunked-fail-fast')
    const history = Array.from({ length: 30 }, (_, i) => customerText(id, `第 ${i + 1} 句`, 40 - i))

    vi.useFakeTimers()
    const promise = runColdStart(id, history, false)
    await vi.runAllTimersAsync()
    await promise
    vi.useRealTimers()

    // 5 批的開頭分別是第 1／7／13／19／25 句。上限 3 代表最多只有前三批被派出去，
    // 第一個失敗落地後就不再取新工作 —— 第 4、5 批因此完全沒有被呼叫過。
    expect(firstTexts).not.toContain('第 19 句')
    expect(firstTexts).not.toContain('第 25 句')

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.status).toBe('error')
  })
})

// ── US1：建議卡（specs/002-suggestion-knowledge-search T026）─────────────

function knowledgeHit(id: string): KnowledgeHit {
  return { id, title: `文件-${id}`, snippet: '片段內容', score: null, updatedAt: null, sourceRef: { type: 'knowledge', ref: id } }
}

describe('analyzeSuggestions()（US1，specs/002-suggestion-knowledge-search）', () => {
  it('冷啟動的 Promise.all() 含 analyzeSuggestions()，建議卡與摘要／情緒併行產生', async () => {
    const id = convId('suggestion-cold')
    await runColdStart(id, [customerText(id, '我的訂單還沒到')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('ready')
    expect(state?.suggestionBlock.cards.length).toBeGreaterThan(0)
  })

  it('knowledgeHits 為空時，建議卡仍以 sopId: null 產生（不因空檢索而不產生建議卡，FR-004）', async () => {
    setKnowledgeProvider({ search: async () => [] })

    const id = convId('suggestion-empty-hits')
    await runColdStart(id, [customerText(id, '我的訂單還沒到')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('ready')
    expect(state!.suggestionBlock.cards.every(c => c.sopId === null)).toBe(true)
    expect(state?.suggestionBlock.knowledgeSearch).toEqual({ ran: true, hitCount: 0 })
  })

  it('單張卡片 schema 驗證失敗時，僅該卡被跳過、其餘卡片仍然 ready', async () => {
    setAIProvider(new (class extends MockAIProvider {
      override async suggest(input: Parameters<MockAIProvider['suggest']>[0]): Promise<SuggestionCard[]> {
        const [valid] = await super.suggest(input)
        // 第二張缺必要欄位（text 為空字串），schema 驗證應使其被跳過而非整批失敗
        return [valid!, { text: '' } as unknown as SuggestionCard]
      }
    })())

    const id = convId('suggestion-partial-invalid')
    await runColdStart(id, [customerText(id, '我要退貨')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('ready')
    expect(state?.suggestionBlock.cards).toHaveLength(1)
  })

  it('全數因白名單捨棄後 status 仍為 ready（非 error）、cards 為空陣列', async () => {
    setKnowledgeProvider({ search: async () => [knowledgeHit('real-hit')] })
    setAIProvider(new (class extends MockAIProvider {
      override async suggest(): Promise<SuggestionCard[]> {
        return [{
          id: 'c1',
          sopId: 'ghost-not-in-hits',
          sopTitle: '幻覺標題',
          text: '幻覺內容',
          confidence: null,
          rationale: 'r',
          tone: 'informative',
          requiresData: [],
          supersededBy: null,
        }]
      }
    })())

    const id = convId('suggestion-all-whitelisted-out')
    await runColdStart(id, [customerText(id, '你好')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('ready')
    expect(state?.suggestionBlock.cards).toEqual([])
  })

  it('knowledgeSearch.ran 在每一條成功路徑上皆為 true（憲法 6.2 v3.0.1 可稽核證據）', async () => {
    const id = convId('suggestion-ran-true')
    await runColdStart(id, [customerText(id, '你好')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.knowledgeSearch.ran).toBe(true)
  })

  it('查詢字串只由 Message.text 組成（FR-017、憲法 6.5：不得讀取任何非文字欄位）', async () => {
    let querySeen: string | undefined
    setKnowledgeProvider({
      search: async (query: string) => {
        querySeen = query
        return []
      },
    })

    const id = convId('suggestion-text-only')
    const msg = customerText(id, '這是客戶的原始文字')
    await runColdStart(id, [msg], false)

    expect(querySeen).toBe('這是客戶的原始文字')
  })

  it('檢索 MUST 帶 KNOWLEDGE_SEARCH_TIMEOUT_MS —— 004 起建議卡與快查共用同一個逾時值', async () => {
    // ⚠️ **2026-08-29（004 FR-003）**：本項原本斷言的是 8 秒的 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`，
    //    理由是保護「先檢索再生成」的串行路徑；而實測檢索最快 9.4 秒，那個上限等於
    //    建議卡永遠拿不到引用。兩段式讓檢索不再擋在生成前面，因此改為共用 30 秒。
    //    這個斷言存在的唯一理由，是「悄悄改回另一個數字」不會報錯也不會有型別問題。
    let optsSeen: { topK?: number, fileId?: string, timeoutMs?: number } | undefined
    setKnowledgeProvider({
      search: async (_query: string, opts?: { topK?: number, fileId?: string, timeoutMs?: number }) => {
        optsSeen = opts
        return []
      },
    })

    const id = convId('suggestion-retrieval-timeout')
    await runColdStart(id, [customerText(id, '請問流程')], false)

    expect(optsSeen?.timeoutMs).toBe(KNOWLEDGE_SEARCH_TIMEOUT_MS)
  })
})

// ── US3：故障隔離（specs/002-suggestion-knowledge-search T043）─────────────

describe('建議卡故障隔離（US3）', () => {
  it('AIProvider.suggest() 失敗時僅 suggestionBlock 轉 error，summaryBlock／sentimentBlock 不受影響', async () => {
    setAIProvider(new (class extends MockAIProvider {
      override async suggest(): Promise<SuggestionCard[]> {
        throw new AIProviderHttpError('boom', 400)
      }
    })())

    const id = convId('suggestion-isolate-from-others')
    await runColdStart(id, [customerText(id, '你好')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('error')
    expect(state?.summaryBlock.status).toBe('ready')
    expect(state?.sentimentBlock.status).toBe('ready')
  })

  it('反之：摘要／情緒失敗不影響建議卡（三區塊互相獨立）', async () => {
    setAIProvider(new MockAIProvider({
      summarizeFailure: () => new AIProviderHttpError('boom', 400),
      sentimentFailure: () => new AIProviderHttpError('boom', 400),
    }))

    const id = convId('suggestion-unaffected-by-others')
    await runColdStart(id, [customerText(id, '你好')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.summaryBlock.status).toBe('error')
    expect(state?.sentimentBlock.status).toBe('error')
    expect(state?.suggestionBlock.status).toBe('ready')
  })

  it('KnowledgeProvider.search() 失敗時，建議卡不整塊轉 error，改以空 knowledgeHits 續行生成通用建議（FR-004）', async () => {
    setKnowledgeProvider({
      search: async () => { throw new Error('知識庫服務暫時不可用') },
    })

    const id = convId('suggestion-knowledge-fail-degrade')
    await runColdStart(id, [customerText(id, '你好')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('ready')
    expect(state?.suggestionBlock.cards.length).toBeGreaterThan(0)
    // 憲法 6.2 v3.0.1：檢索確實跑過（送出呼叫），只是失敗了——ran 仍為 true，hitCount 為 0
    expect(state?.suggestionBlock.knowledgeSearch).toEqual({ ran: true, hitCount: 0 })
  })

  it('故障開關彼此獨立：只開 searchFailure 時，MockAIProvider.suggest() 本身仍成功', async () => {
    let suggestCalled = false
    setAIProvider(new (class extends MockAIProvider {
      override async suggest(input: Parameters<MockAIProvider['suggest']>[0]): Promise<SuggestionCard[]> {
        suggestCalled = true
        return super.suggest(input)
      }
    })())
    setKnowledgeProvider({
      search: async () => { throw new Error('知識庫故障') },
    })

    const id = convId('fault-switches-independent')
    await runColdStart(id, [customerText(id, '你好')], false)

    expect(suggestCalled).toBe(true)
    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('ready')
  })

  it('故障開關彼此獨立：suggestFailure／summarizeFailure／sentimentFailure 各自只影響自己的區塊', async () => {
    setAIProvider(new MockAIProvider({
      suggestFailure: () => new AIProviderHttpError('boom', 400),
    }))

    const id = convId('suggest-failure-isolated')
    await runColdStart(id, [customerText(id, '你好')], false)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.suggestionBlock.status).toBe('error')
    expect(state?.summaryBlock.status).toBe('ready')
    expect(state?.sentimentBlock.status).toBe('ready')
  })
})

// ── US4：背景並行與 debounce（specs/002-suggestion-knowledge-search T046-T048、T060）──

describe('背景並行與 debounce（US4）', () => {
  it('priority: background 時 runIncremental() 跳過 analyzeSummary()，但仍執行情緒與建議卡分析（FR-019、FR-020）', async () => {
    let summarizeCalled = false
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        summarizeCalled = true
        return super.summarize(input)
      }
    })())

    const id = convId('background-skip-summary')
    await runColdStart(id, [customerText(id, '第一句', 10)], false)
    summarizeCalled = false // 只計算冷啟動之後的呼叫

    await runIncremental(id, [customerText(id, '背景新發言', 1)], 'background', false)

    expect(summarizeCalled).toBe(false)
    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.timeline.length).toBeGreaterThan(1)
    expect(state?.suggestionBlock.status).toBe('ready')
  })

  it('scheduleIncremental() 對背景優先度使用明顯更長的 BACKGROUND_DEBOUNCE_MS（8 秒 vs 前景 1 秒）', async () => {
    vi.useFakeTimers()
    let callCount = 0
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
        callCount++
        return super.analyzeSentiment(input)
      }
    })())

    const id = convId('background-debounce-length')
    await runColdStart(id, [customerText(id, '第一句', 10)], false)
    callCount = 0

    scheduleIncremental(id, [customerText(id, '背景訊息', 1)], 'background', false)

    await vi.advanceTimersByTimeAsync(1_000) // 前景的 1 秒到了，背景 MUST NOT 提前觸發
    expect(callCount).toBe(0)

    await vi.advanceTimersByTimeAsync(7_000) // 累計 8 秒，背景 debounce 才到期
    expect(callCount).toBe(1)
    vi.useRealTimers()
  })

  it('BACKGROUND_CONCURRENCY_LIMIT 滿載時，超額對話不執行分析、不顯示為錯誤（僅重排 debounce）', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => convId(`bg-limit-${i}`))
    for (const id of ids) await runColdStart(id, [customerText(id, '第一句', 10)], false)

    let callCount = 0
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
        callCount++
        await gate
        return super.analyzeSentiment(input)
      }
    })())

    // 佔滿 10 個名額（BACKGROUND_CONCURRENCY_LIMIT = 10）——皆卡在 gate 上，模擬進行中
    const first10 = ids.slice(0, 10)
    const inFlight = first10.map(id => runIncremental(id, [customerText(id, '背景訊息', 1)], 'background', false))
    await vi.waitFor(() => expect(callCount).toBe(10))

    // 第 11 個對話：名額已滿，MUST NOT 執行（不呼叫 AI、不轉 error，只是重排 debounce）
    const eleventh = ids[10]!
    await runIncremental(eleventh, [customerText(eleventh, '第 11 個背景訊息', 1)], 'background', false)

    expect(callCount).toBe(10)
    const state = await useStateStore().getAnalysisState(eleventh)
    expect(state?.sentimentBlock.status).not.toBe('error')

    releaseGate?.()
    await Promise.all(inFlight)
  })

  /**
   * 名額登記 MUST 是 refcount —— 同一個對話兩份背景分析重疊時，先結束的那份
   * **MUST NOT** 把名額整個還掉（2026-09-03 迴歸）。
   *
   * ⚠️ 這條路是設計上刻意存在的：上方門檻的 `&& !backgroundInFlight.has(conversationId)`
   *    放行「本對話已佔名額」的第二份（debounce 計時器與 `stream.get.ts` 重連的
   *    `void runIncremental()` 會對同一個對話同時進來）。而第二份的
   *    `runBlockDeduped()` 遇到同鍵在飛時是**立即 return**（登記成 rerun 就走），
   *    所以它**先結束** —— 用 `Set` 時它的 `finally` 會把還在飛的第一份的名額一併還掉。
   *
   * ⚠️ 後果是上限被悄悄突破：沒有錯誤、沒有型別警告，只是背景同時打出去的 AI 呼叫
   *    比 `BACKGROUND_CONCURRENCY_LIMIT` 承諾的多。憲法 6.2 的成本節流從這裡漏掉。
   */
  it('同對話兩份背景分析重疊：先結束的那份 MUST NOT 釋出名額（refcount，非 Set）', async () => {
    const busy = Array.from({ length: 9 }, (_, i) => convId(`bg-rc-busy-${i}`))
    const dual = convId('bg-rc-dual')
    const extra = convId('bg-rc-extra')
    for (const id of [...busy, dual, extra]) await runColdStart(id, [customerText(id, '第一句', 10)], false)

    let callCount = 0
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
        callCount++
        await gate
        return super.analyzeSentiment(input)
      }
    })())

    // 9 個對話各佔一格，皆卡在 gate 上
    const inFlight = busy.map(id => runIncremental(id, [customerText(id, '背景訊息', 1)], 'background', false))
    await vi.waitFor(() => expect(callCount).toBe(9))

    // 第 10 格：dual 的第一份，同樣卡在 gate 上 —— 此刻名額剛好滿（9 + 1 = 10）
    const dualFirst = runIncremental(dual, [customerText(dual, '第一批', 1)], 'background', false)
    await vi.waitFor(() => expect(callCount).toBe(10))

    /**
     * dual 的第二份：門檻放行（本對話已佔名額），但它的 runBlockDeduped() 立即 return，
     * 因此**先於第一份結束**。這一 await 正是缺陷的觸發點。
     */
    await runIncremental(dual, [customerText(dual, '第二批', 2)], 'background', false)
    expect(callCount).toBe(10) // 第二份沒有自己打 AI（被合併成 rerun）

    /**
     * 此刻仍有 10 個對話在飛（9 個 busy ＋ dual 的第一份），名額 MUST 仍是滿的。
     * 用 `Set` 時 dual 的第二份已經把 dual 那一格還掉 → 這裡會被放行 → callCount 變 11。
     */
    void runIncremental(extra, [customerText(extra, '第 11 個對話', 1)], 'background', false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(callCount).toBe(10)

    // 被擋下時會重排一次背景 debounce（8 秒）——清掉，不要留計時器給後面的測試
    cancelPendingAnalysis(extra)
    releaseGate?.()
    await Promise.all([...inFlight, dualFirst])
  })
})

// ── FR-009：同區塊併發去重（specs/003-analysis-trigger-policy T014）────────

/**
 * 「不做樂觀 disable」（research.md 決策 7）的對價就在這裡：面板狀態一律由伺服器推播驅動，
 * 客服在往返期間重複按下按鈕是**預期行為**，由這一層吸收。
 *
 * ⚠️ 合併語意是「至少再跑一次最新的」——旗標而非佇列。累積 N 次觸發就跑 N 次沒有意義：
 *    分析的輸入是當下的狀態，不是被合併掉的那些事件。
 */
describe('FR-009：同一 (對話, 區塊) 的併發觸發合併為一次 rerun', () => {
  it('同區塊連續觸發三次 → 只執行兩次（當次 + 一次合併的 rerun）', async () => {
    const id = convId('dedupe')
    await runColdStart(id, [customerText(id, '第一句', 10)], false)

    let calls = 0
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
        calls++
        await gate
        return super.analyzeSentiment(input)
      }
    })())

    // 三次觸發，每次都是新的一批（最後一則不同）——確保被擋下的不是失敗批次記憶
    const batches = [
      [customerText(id, '併發 1', 9)],
      [customerText(id, '併發 2', 8)],
      [customerText(id, '併發 3', 7)],
    ]
    const running = batches.map(b => runIncremental(id, b, 'foreground', false))

    await vi.waitFor(() => expect(calls).toBe(1))
    releaseGate?.()
    await Promise.all(running)

    // 第一次進行中，第二、三次被合併成「跑完後再跑一次」
    expect(calls).toBe(2)
  })

  it('rerun 那一次仍會過失敗批次記憶檢查 —— 錯誤狀態上 MUST NOT 多出一輪呼叫', async () => {
    const id = convId('dedupe-failed')
    const batch = [customerText(id, '會失敗的一批', 10)]

    let calls = 0
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    setAIProvider(new (class extends MockAIProvider {
      override async analyzeSentiment(): Promise<never> {
        calls++
        await gate
        throw new AIProviderHttpError('boom', 400)
      }
    })())

    // ⚠️ 刻意不 await —— 這一次會卡在 gate 上，正是要製造「進行中」的窗口
    const cold = runColdStart(id, batch, false)
    await vi.waitFor(() => expect(calls).toBe(1))

    // 期間再觸發同一批兩次 → 合併成一次 rerun
    const merged = [
      runIncremental(id, batch, 'foreground', false),
      runIncremental(id, batch, 'foreground', false),
    ]

    releaseGate?.()
    await Promise.all([cold, ...merged])

    // rerun 重新讀了失敗批次記憶，發現這一批剛剛才失敗過 → 直接 return，不再呼叫 AI。
    // 若少了這道檢查，這裡會是 2 —— SC-001 的「不超過 1 輪」當場被打破。
    expect(calls).toBe(1)
    const state = await useStateStore().getAnalysisState(id)
    expect(state?.sentimentBlock.status).toBe('error')
  })

  it('去重粒度是「對話 ＋ 區塊」，MUST NOT 是「對話」—— 三個區塊仍然並行', async () => {
    const id = convId('dedupe-granularity')
    await runColdStart(id, [customerText(id, '第一句', 10)], false)

    const started: string[] = []
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        started.push('summary')
        await gate
        return super.summarize(input)
      }

      override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
        started.push('sentiment')
        await gate
        return super.analyzeSentiment(input)
      }

      override async suggest(input: Parameters<MockAIProvider['suggest']>[0]) {
        started.push('suggestions')
        await gate
        return super.suggest(input)
      }
    })())

    const running = runIncremental(id, [customerText(id, '新的一句', 5)], 'foreground', false)
    // 三個區塊 MUST 同時在飛 —— 用對話粒度去重會把它們串成序列，
    // 直接拖慢 002 SC-001 的 3 秒／10 秒門檻
    //
    // ⚠️ 斷言的是**相異區塊**，不是呼叫次數（2026-08-29，004）：前景建議卡改成兩段式後，
    //    同一輪會有第一段與第二段兩次 `suggest()`，`started` 裡本來就會有兩筆 'suggestions'。
    //    呼叫次數的上限由 `describe('兩段式（004 US1）')` 的 ⑨ 直接斷言，不歸這一項管。
    await vi.waitFor(() => expect([...new Set(started)].sort()).toEqual(['sentiment', 'suggestions', 'summary']))

    releaseGate?.()
    await running
  })
})

// ── 004 US1：建議卡的漸進式知識庫引用 ──────────────────────────────────
//
// 本節守的是**兩段之間的交錯順序與覆蓋規則**（誰先落地、誰不得蓋誰、呼叫幾次）。
// 這些全是「靜默失效」型：順序錯了畫面看起來還是有卡，只是引用悄悄消失或成本悄悄翻倍。
//
// ⚠️ 一律用假時鐘控制交錯。真實時鐘下第一段與檢索誰先回來是機率問題，
//    而本規格最貴的兩個 bug（FR-003a 的兩條收斂規則）正好只在特定順序下才出現。

/** 測試用知識庫 provider：延遲、命中內容、是否拋錯都由呼叫端指定，並記錄呼叫次數 */
class StubKnowledgeProvider implements KnowledgeProvider {
  calls = 0
  /** 檢索回來的那一刻，事件序列已經有幾則 —— 用來斷言「pending 早於檢索完成」 */
  eventCountAtResolve = -1

  constructor(private readonly plan: {
    hits?: KnowledgeHit[]
    delayMs?: number
    fail?: boolean
    events?: CopilotEvent[]
  } = {}) {}

  async search(): Promise<KnowledgeHit[]> {
    this.calls++
    if (this.plan.delayMs) await new Promise(resolve => setTimeout(resolve, this.plan.delayMs))
    this.eventCountAtResolve = this.plan.events?.length ?? -1
    if (this.plan.fail) throw new Error('模擬檢索失敗／逾時')
    return this.plan.hits ?? []
  }
}

const STUB_HITS: KnowledgeHit[] = [
  {
    id: 'sop-1',
    title: '退貨處理 SOP',
    snippet: '七日內可辦理退貨',
    score: null,
    updatedAt: null,
    sourceRef: { type: 'knowledge', ref: 'sop-1' },
  },
]

/**
 * 測試用 AIProvider：以 `knowledgeHits` 是否為空分辨兩段。
 *
 * ⚠️ 這個判別式只在測試裡成立（第一段恆為空集合）；正式路徑分辨兩段靠的是 `provenance.stage`。
 */
class StageAIProvider extends MockAIProvider {
  suggestCalls = 0
  hitsSeen: KnowledgeHit[][] = []
  aiRepliesSeen: boolean[] = []

  constructor(private readonly plan: {
    delayMs?: (isStage2: boolean) => number
    failure?: (ctx: { call: number, isStage2: boolean }) => Error | null
    cards?: (ctx: { isStage2: boolean, hits: KnowledgeHit[] }) => SuggestionCard[] | undefined
  } = {}) {
    super()
  }

  override async suggest(input: Parameters<MockAIProvider['suggest']>[0]): Promise<SuggestionCard[]> {
    this.suggestCalls++
    const call = this.suggestCalls
    const isStage2 = input.knowledgeHits.length > 0
    this.hitsSeen.push(input.knowledgeHits)
    this.aiRepliesSeen.push(input.aiReplies)

    const delay = this.plan.delayMs?.(isStage2)
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))

    const failure = this.plan.failure?.({ call, isStage2 })
    if (failure) throw failure

    return this.plan.cards?.({ isStage2, hits: input.knowledgeHits }) ?? super.suggest(input)
  }
}

/** 只取建議卡事件，壓成 status/citation 序列 —— 契約 §2 的那張表就是照這個形狀寫的 */
function suggestionSeq(events: CopilotEvent[]): string[] {
  return events
    .filter(e => e.type === 'suggestion.updated')
    .map(e => `${e.suggestion.status}/${e.suggestion.citation}`)
}

function suggestionEvents(events: CopilotEvent[]) {
  return events.filter(e => e.type === 'suggestion.updated').map(e => e.suggestion)
}

async function suggestionState(id: string) {
  return (await useStateStore().getAnalysisState(id))!.suggestionBlock
}

describe('兩段式（004 US1）', () => {
  it('① 正常序列 analyzing → ready/pending → ready/cited，且 pending 早於檢索完成', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-happy')
    const events = collect(id)
    const knowledge = new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 1_000, events })
    const ai = new StageAIProvider()
    setKnowledgeProvider(knowledge)
    setAIProvider(ai)

    const running = runColdStart(id, [customerText(id, '我要退貨')], true)
    await running
    // ⚠️ 第一段必須在檢索回來**之前**就已經發布 —— 這正是兩段式存在的理由（FR-001）
    const pendingIndex = events.findIndex(e => e.type === 'suggestion.updated' && e.suggestion.citation === 'pending')
    expect(pendingIndex).toBeGreaterThanOrEqual(0)

    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    expect(pendingIndex).toBeLessThan(knowledge.eventCountAtResolve)
    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/pending', 'ready/cited'])

    const block = await suggestionState(id)
    expect(block.citation).toBe('cited')
    expect(block.knowledgeSearch).toEqual({ ran: true, hitCount: 1 })
    expect(block.provenance).toEqual({ stage: 2, stage1RetryAttempt: 0 })
    expect(block.cards[0]?.sopId).toBe('sop-1')

    // 動工前必讀 #6：aiReplies 兩段都要帶，漏了 Hybrid 的補位提示會在第二段消失
    expect(ai.aiRepliesSeen).toEqual([true, true])
    // 第一段的白名單集合是空集合、第二段是第二段呼叫當下的 hits（data-model.md §7）
    expect(ai.hitsSeen[0]).toEqual([])
    expect(ai.hitsSeen[1]).toEqual(STUB_HITS)
  })

  it('② 檢索 0 筆 → ready/none，且 cards 與 pending 那則完全相同（FR-003）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-zero-hit')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: [], delayMs: 1_000 }))
    setAIProvider(new StageAIProvider())

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await running
    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/pending', 'ready/none'])
    const published = suggestionEvents(events)
    // 落定「未引用」時**一張卡都不動** —— 只有標示與 updatedAt 改變
    expect(published[2]!.cards).toEqual(published[1]!.cards)
    expect(published[2]!.knowledgeSearch).toEqual({ ran: true, hitCount: 0 })
  })

  it('③ 檢索拋錯／逾時 → 同 ②（誠實降級，不轉 error）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-search-fail')
    const events = collect(id)
    // ⚠️ Mock 不自行實作 timeoutMs，逾時與拋錯在這裡是同一條程式碼路徑（真實 provider 才會計時）
    setKnowledgeProvider(new StubKnowledgeProvider({ fail: true, delayMs: 1_000 }))
    setAIProvider(new StageAIProvider())

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await running
    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/pending', 'ready/none'])
    expect((await suggestionState(id)).status).toBe('ready')
  })

  it('④ 第二段失敗 → none、suggest() 恰 2 次、事件中無 retrying、狀態非 error（FR-003／FR-014）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-stage2-fail')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 1_000 }))
    const ai = new StageAIProvider({
      failure: ({ isStage2 }) => (isStage2 ? new AIProviderHttpError('server error', 500) : null),
    })
    setAIProvider(ai)

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await running
    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    // 500 是 transient —— 沒有 maxRetries: 0 的話這裡會是 4 次（FR-014 破功）
    expect(ai.suggestCalls).toBe(2)
    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/pending', 'ready/none'])
    // 第二段失敗是**靜默**的：MUST NOT 閃出「重試中」，也 MUST NOT 轉 error
    expect(events.some(e => e.type === 'suggestion.updated' && e.suggestion.status === 'retrying')).toBe(false)
    expect((await suggestionState(id)).status).toBe('ready')
    // hitCount 記真實命中數 —— 「有命中卻沒引用」在事後稽核時才分辨得出來
    expect((await suggestionState(id)).knowledgeSearch).toEqual({ ran: true, hitCount: 1 })
  })

  it('⑤ 第二段的卡 sopId 全不在 hits（模型杜撰引用）→ none 且 cards 維持第一段', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-whitelist-drop')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 1_000 }))
    setAIProvider(new StageAIProvider({
      cards: ({ isStage2 }) => (isStage2
        ? [{
            id: 'fabricated',
            sopId: 'sop-does-not-exist',
            sopTitle: '不存在的來源',
            text: '這張卡引用了不存在的 SOP',
            confidence: null,
            rationale: 'r',
            tone: 'informative' as const,
            requiresData: [],
            supersededBy: null,
          }]
        : undefined),
    }))

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await running
    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/pending', 'ready/none'])
    const published = suggestionEvents(events)
    expect(published[2]!.cards).toEqual(published[1]!.cards)
  })

  it('⑥ 新批次啟動後舊尾巴落地 → 一個字都不寫回（世代計數）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-generation')
    const first = customerText(id, '第一批', 10)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 5_000 }))
    setAIProvider(new StageAIProvider())

    await runColdStart(id, [first], false)
    const events = collect(id) // 從第二批才開始收，避免第一批的事件混入

    const second = customerText(id, '第二批', 1)
    const running = runIncremental(id, [second], 'foreground', false)
    await running
    await vi.advanceTimersByTimeAsync(5_000)
    await awaitSuggestionTail(id)

    // 新世代啟動後，舊世代的尾巴 MUST NOT 再發布任何**落地**結果。
    // ⚠️ 判準只看 `ready`／`error`：`analyzing` 那則會沿用上一輪的 `basedOnMessageId`
    //    （`beginAnalyzing()` 是 spread，保留舊卡與其標示是刻意的行為，見 data-model.md §2），
    //    把它一起算進來會誤判成「舊世代又寫了一次」。
    const landed = suggestionEvents(events).filter(b => b.status === 'ready' || b.status === 'error')
    expect(landed.length).toBeGreaterThan(0)
    expect(landed.every(b => b.basedOnMessageId === second.id)).toBe(true)
    expect((await suggestionState(id)).basedOnMessageId).toBe(second.id)
  })

  it('⑦ 第一段在退避中、第二段先落地 → ready/cited，第一段的重試被 abort（FR-006a）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-abort-stage1')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 100 }))
    const ai = new StageAIProvider({
      failure: ({ call }) => (call === 1 ? new AIProviderHttpError('server error', 500) : null),
    })
    setAIProvider(ai)

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await vi.advanceTimersByTimeAsync(2_000)
    await running
    await awaitSuggestionTail(id)

    // 第一段失敗一次進 1 秒退避 → 檢索在 100ms 回來且有命中 → abort 掉還沒送出的那次重試
    expect(ai.suggestCalls).toBe(2)
    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'retrying/none', 'ready/cited'])
    // 第一段從未發布，因此整條序列裡不該出現 pending
    expect(events.some(e => e.type === 'suggestion.updated' && e.suggestion.citation === 'pending')).toBe(false)
  })

  it('⑧ 第一段在飛時第二段落地，第一段後到 → MUST NOT 覆蓋（citedLanded）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-late-stage1')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 100 }))
    setAIProvider(new StageAIProvider({ delayMs: isStage2 => (isStage2 ? 0 : 3_000) }))

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await vi.advanceTimersByTimeAsync(5_000)
    await running
    await awaitSuggestionTail(id)

    // 第一段的呼叫已經送出去了（abort 擋不住在飛的呼叫），它回來時 MUST 認出第二段已落地
    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/cited'])
    expect((await suggestionState(id)).citation).toBe('cited')
  })

  it('⑨ 呼叫次數上限：第一段重試兩次後成功 ＋ 第二段 → suggest() 恰 4 次（FR-014／SC-005）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-call-budget')
    // 檢索故意慢到第一段整輪跑完 —— 否則第二段會提前 abort 掉第一段的重試
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 10_000 }))
    const ai = new StageAIProvider({
      failure: ({ call }) => (call <= 2 ? new AIProviderHttpError('server error', 500) : null),
    })
    setAIProvider(ai)

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await vi.advanceTimersByTimeAsync(20_000)
    await running
    await awaitSuggestionTail(id)

    // 1（首次）＋ 2（重試）＋ 1（第二段）＝ 4，這是前景每批的最壞值
    expect(ai.suggestCalls).toBe(4)
    const block = await suggestionState(id)
    expect(block.citation).toBe('cited')
    // 「這批訊息總共呼叫幾次」＝ 1 + n + 1，可從單一 block 讀出
    expect(block.provenance).toEqual({ stage: 2, stage1RetryAttempt: 2 })
  })

  it('⑩ 命中已在手：手動重試走單段，不再發檢索、無 pending（FR-005）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-hits-in-hand')
    const history = [customerText(id, '我要退貨')]
    const knowledge = new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 100 })
    const ai = new StageAIProvider()
    setKnowledgeProvider(knowledge)
    setAIProvider(ai)

    const running = runColdStart(id, history, false)
    await vi.advanceTimersByTimeAsync(200)
    await running
    await awaitSuggestionTail(id)
    const callsAfterRound1 = ai.suggestCalls

    const events = collect(id)
    const retry = retryBlock(id, 'suggestions', history, false)
    await vi.advanceTimersByTimeAsync(200)
    await retry
    await awaitSuggestionTail(id)

    // 同一批訊息、同一個 query —— 重查幾乎必然仍是同一批結果，卻要多花 9.4～20.1 秒
    expect(knowledge.calls).toBe(1)
    expect(ai.suggestCalls).toBe(callsAfterRound1 + 1)
    expect(suggestionSeq(events)).toEqual(['analyzing/cited', 'ready/cited'])
    expect(events.some(e => e.type === 'suggestion.updated' && e.suggestion.citation === 'pending')).toBe(false)
  })

  it('⑪ 第二段整批換卡前 MUST 重放搶答標記（FR-015、憲法 7.2）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-superseded')
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 1_000 }))
    setAIProvider(new StageAIProvider())

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await running // 第一段已落地
    expect((await suggestionState(id)).cards[0]?.supersededBy).toBeNull()

    // 尾巴飛行期間同事搶先回覆了同樣的內容
    const reply = agentText(id, '建議先向客戶致歉，並確認目前的處理進度')
    await checkSuggestionsSuperseded(id, [reply])
    expect((await suggestionState(id)).cards[0]?.supersededBy).toEqual({ kind: 'agent', messageId: reply.id })

    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    // 第二段換上的是**新的一批卡**；漏了重放，這張卡會以「未標記」復活，客服可能再回一次
    const block = await suggestionState(id)
    expect(block.citation).toBe('cited')
    expect(block.cards[0]?.supersededBy).toEqual({ kind: 'agent', messageId: reply.id })
  })

  it('⑫ LEAVE 取消尾巴：第二段不送出、登記一併移除（003 FR-013 的延伸）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-leave')
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 1_000 }))
    const ai = new StageAIProvider()
    setAIProvider(ai)

    // ⚠️ 本 case MUST **不**先排任何 debounce：cancelPendingAnalysis() 的兩步若寫在
    //    「有沒有 pending 排程」的早退之後，先排了 debounce 會讓早退不成立、bug 就漏掉。
    //    JOIN 冷啟動觸發的尾巴正是**沒有** debounce 排程的那一種。
    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await running
    const callsBeforeLeave = ai.suggestCalls

    cancelPendingAnalysis(id)
    expect(hasSuggestionTail(id)).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    expect(ai.suggestCalls).toBe(callsBeforeLeave)
    expect((await suggestionState(id)).citation).toBe('pending')
  })

  it('⑬ 兩段落地的卡數皆不超過上限（FR-012：MUST NOT 事後截斷，上限在生成階段落實）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-card-cap')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 100 }))
    setAIProvider(new StageAIProvider())

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await vi.advanceTimersByTimeAsync(200)
    await running
    await awaitSuggestionTail(id)

    // ⚠️ 只斷言上界：「3–5 張」的下界是 002 在**生成階段**（prompt）落實的既有約束，
    //    以 Mock 的固定回傳斷言 >= 3 等於在測 Mock，不是在測本規格。
    for (const block of suggestionEvents(events)) expect(block.cards.length).toBeLessThanOrEqual(5)
  })

  it('⑭ 檢索先回且 0 命中時，none MUST NOT 早於 pending（FR-003a ①）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-none-after-pending')
    const events = collect(id)
    // 檢索比第一段**快**——實測不罕見（檢索最快 9.4 秒 vs 第一段中位 9.2 秒），不是理論邊界
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: [], delayMs: 100 }))
    setAIProvider(new StageAIProvider({ delayMs: isStage2 => (isStage2 ? 0 : 3_000) }))

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await vi.advanceTimersByTimeAsync(5_000)
    await running
    await awaitSuggestionTail(id)

    // 不等第一段落定就寫 none 的話，第一段隨後落地會把標示寫回 pending，
    // 而該輪檢索已結束、沒有任何路徑再落定它 —— 客服永遠看到「檢索中」，且沒有錯誤跡象
    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/pending', 'ready/none'])
    expect((await suggestionState(id)).citation).toBe('none')
  })

  it('⑮ 第一段被取消且第二段又失敗 → MUST 收斂為 error（FR-003a ②）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-both-fail')
    const events = collect(id)
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 100 }))
    setAIProvider(new StageAIProvider({
      // 第一段第一次失敗進退避（隨後被第二段 abort）；第二段也失敗
      failure: ({ call, isStage2 }) => (call === 1 || isStage2 ? new AIProviderHttpError('server error', 500) : null),
    }))

    const running = runColdStart(id, [customerText(id, '我要退貨')], false)
    await vi.advanceTimersByTimeAsync(2_000)
    await running
    await awaitSuggestionTail(id)

    // 第一段從未發布、客服手上沒有卡：停在「重試中」是永久的謊，MUST 給錯誤狀態＋重試按鈕
    const seq = suggestionSeq(events)
    expect(seq[seq.length - 1]).toBe('error/none')
    expect((await suggestionState(id)).status).toBe('error')
    // MUST NOT 送出 cards 為空的 ready
    expect(events.some(e =>
      e.type === 'suggestion.updated' && e.suggestion.status === 'ready' && e.suggestion.cards.length === 0,
    )).toBe(false)
  })

  it('⑯ FR-005 的判準含 0 筆：備忘存在即成立，重試仍 MUST NOT 再發檢索', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-memo-zero')
    const history = [customerText(id, '我要退貨')]
    const knowledge = new StubKnowledgeProvider({ hits: [], delayMs: 100 })
    let stage1ShouldFail = true
    const ai = new StageAIProvider({
      failure: () => (stage1ShouldFail ? new AIProviderHttpError('bad request', 400) : null),
    })
    setKnowledgeProvider(knowledge)
    setAIProvider(ai)

    const running = runColdStart(id, history, false)
    await vi.advanceTimersByTimeAsync(200)
    await running
    await awaitSuggestionTail(id)
    expect((await suggestionState(id)).status).toBe('error')
    const callsAfterRound1 = ai.suggestCalls

    stage1ShouldFail = false
    const events = collect(id)
    const retry = retryBlock(id, 'suggestions', history, false)
    await vi.advanceTimersByTimeAsync(200)
    await retry
    await awaitSuggestionTail(id)

    // hits 為空陣列同樣算「命中已在手」：重查幾乎必然仍是 0 筆，卻要把重試整輪拖慢
    expect(knowledge.calls).toBe(1)
    expect(ai.suggestCalls).toBe(callsAfterRound1 + 1)
    expect(events.some(e => e.type === 'suggestion.updated' && e.suggestion.citation === 'pending')).toBe(false)
    const block = await suggestionState(id)
    expect(block.status).toBe('ready')
    expect(block.citation).toBe('none')
    // 重試確實重新生成了卡，不是 no-op
    expect(block.cards.length).toBeGreaterThan(0)
  })

  /**
   * ⑰ ⑯ 的反面 —— **檢索「失敗」MUST NOT 被當成「命中 0 筆」記進備忘**（2026-09-03 迴歸）。
   *
   * ⚠️ 這兩條測試是一對，改動 FR-005 判準時 MUST 一起看：
   *    ⑯ 說「真的 0 筆」要沿用備忘、不再檢索（省下 9.4～20.1 秒）；
   *    本條說「失敗」相反，MUST 重新檢索。分不出兩者的實作會讓一次短暫的知識庫故障
   *    把那批訊息的引用**永久**釘死在「沒有」—— 而狀態是 `ready`、`knowledgeSearch.ran`
   *    是 `true`、沒有任何錯誤，客服與日誌都看不出少了什麼。
   *
   * ⚠️ 判準的差別在於 2026-08-29 裁決的理由：「重查幾乎必然仍是 0 筆」對真的 0 筆成立，
   *    對失敗不成立（失敗的下一次很可能會成功）。憲法 6.2 v3.0.2 要求重新生成 MUST 建立在
   *    那次檢索的**真實結果**上，而失敗沒有結果。
   */
  it('⑰ 檢索失敗不寫備忘：手動重試 MUST 重新發檢索，並補回引用（憲法 6.2 v3.0.2）', async () => {
    vi.useFakeTimers()
    const id = convId('two-stage-memo-failed')
    const history = [customerText(id, '我要退貨')]
    // plan 物件刻意留在手上：第一輪檢索失敗，重試前改成會成功
    const plan = { hits: STUB_HITS, delayMs: 100, fail: true }
    const knowledge = new StubKnowledgeProvider(plan)
    let stage1ShouldFail = true
    const ai = new StageAIProvider({
      failure: () => (stage1ShouldFail ? new AIProviderHttpError('bad request', 400) : null),
    })
    setKnowledgeProvider(knowledge)
    setAIProvider(ai)

    const running = runColdStart(id, history, false)
    await vi.advanceTimersByTimeAsync(200)
    await running
    await awaitSuggestionTail(id)
    expect((await suggestionState(id)).status).toBe('error')
    expect(knowledge.calls).toBe(1)

    stage1ShouldFail = false
    plan.fail = false
    const retry = retryBlock(id, 'suggestions', history, false)
    await vi.advanceTimersByTimeAsync(200)
    await retry
    await awaitSuggestionTail(id)

    // ⚠️ 本條的重點：第二次檢索真的發出去了（⑯ 在這裡會是 1）
    expect(knowledge.calls).toBe(2)
    const block = await suggestionState(id)
    expect(block.status).toBe('ready')
    // 檢索恢復後拿得到命中 → 引用補得回來，而不是永久停在 'none'
    expect(block.citation).toBe('cited')
    expect(block.knowledgeSearch).toEqual({ ran: true, hitCount: STUB_HITS.length })
  })
})

// ── 004 US3：背景對話不走兩段式（FR-013）──────────────────────────────
//
// ⚠️ 前景與背景的**不一致是刻意的**：背景沒有人在等（002 SC-007 以「切回時已更新」為驗收），
//    第一段的產出沒有人會看到，而背景並行上限 10 個對話正是兩段式在背景省下的那筆呼叫。
//    這一節存在的理由，就是讓「順手把它改成一致」會立刻紅。

describe('背景對話（004 US3）', () => {
  it('① 背景走單段：analyzing → ready/cited，無 pending，suggest() 恰 1 次且在檢索完成之後', async () => {
    vi.useFakeTimers()
    const id = convId('background-single')
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 1_000 }))
    setAIProvider(new StageAIProvider())

    // 背景增量要有既有的分析狀態才會執行（未曾 JOIN 的對話一律略過）
    await runColdStart(id, [customerText(id, '第一批', 10)], false)
    await vi.advanceTimersByTimeAsync(1_000)
    await awaitSuggestionTail(id)

    const events = collect(id)
    const ai = new StageAIProvider()
    setAIProvider(ai)

    const running = runIncremental(id, [customerText(id, '背景期間的新問題', 1)], 'background', false)
    await vi.advanceTimersByTimeAsync(1_000)
    await running
    await awaitSuggestionTail(id)

    // 沒有第一段，就沒有那筆多出來的呼叫 —— FR-013 省下的正是它
    expect(ai.suggestCalls).toBe(1)
    // 唯一那次呼叫已經帶著命中結果，代表它發生在檢索完成之後
    expect(ai.hitsSeen[0]).toEqual(STUB_HITS)
    expect(suggestionSeq(events)).toEqual(['analyzing/cited', 'ready/cited'])
    expect(events.some(e => e.type === 'suggestion.updated' && e.suggestion.citation === 'pending')).toBe(false)
  })

  it('② 背景檢索 0 筆 → ready/none，provenance 為 { stage: 2, stage1RetryAttempt: 0 }', async () => {
    vi.useFakeTimers()
    const id = convId('background-zero-hit')
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: [], delayMs: 500 }))
    setAIProvider(new StageAIProvider())

    await runColdStart(id, [customerText(id, '第一批', 10)], false)
    await vi.advanceTimersByTimeAsync(500)
    await awaitSuggestionTail(id)

    const events = collect(id)
    const running = runIncremental(id, [customerText(id, '背景期間的新問題', 1)], 'background', false)
    await vi.advanceTimersByTimeAsync(500)
    await running
    await awaitSuggestionTail(id)

    expect(suggestionSeq(events)).toEqual(['analyzing/none', 'ready/none'])
    const block = await suggestionState(id)
    // 單段沒有第一段，`stage1RetryAttempt` 恆為 0（data-model.md §1）
    expect(block.provenance).toEqual({ stage: 2, stage1RetryAttempt: 0 })
    expect(block.knowledgeSearch).toEqual({ ran: true, hitCount: 0 })
  })

  it('③ 背景分析進行中，狀態仍帶著上一批卡片 —— 切回前景的快照不會是空白（002 SC-007）', async () => {
    vi.useFakeTimers()
    const id = convId('background-keeps-cards')
    setKnowledgeProvider(new StubKnowledgeProvider({ hits: STUB_HITS, delayMs: 3_000 }))
    setAIProvider(new StageAIProvider())

    await runColdStart(id, [customerText(id, '第一批', 10)], false)
    await vi.advanceTimersByTimeAsync(3_000)
    await awaitSuggestionTail(id)
    const before = await suggestionState(id)
    expect(before.cards.length).toBeGreaterThan(0)

    const running = runIncremental(id, [customerText(id, '背景期間的新問題', 1)], 'background', false)
    // 檢索還沒回來：這一刻正是客服切回前景、快照送出的時點
    await vi.advanceTimersByTimeAsync(100)

    const during = await suggestionState(id)
    expect(during.status).toBe('analyzing')
    // ⚠️ `beginAnalyzing()` 的 spread 保留舊卡與其 `citation` —— 兩者都是刻意的：
    //    保留下來的卡若來自上一輪第二段，確實有 SOP 依據，標成「未引用」是說錯話（SC-004）
    expect(during.cards).toEqual(before.cards)
    expect(during.citation).toBe(before.citation)

    await vi.advanceTimersByTimeAsync(3_000)
    await running
    await awaitSuggestionTail(id)
  })
})

// ── 情緒走勢文字摘要（D-19）─────────────────────────────────────────

describe('情緒走勢文字摘要（D-19）', () => {
  async function sentimentState(id: string) {
    const state = await useStateStore().getAnalysisState(id)
    if (!state) throw new Error('分析狀態不存在')
    return state.sentimentBlock
  }

  it('成功時 narrative 落地，且分數先於敘述發布（折線不等散文）', async () => {
    const id = convId('narrate-ok')
    const events = collect(id)

    await runColdStart(id, [
      customerText(id, '我的訂單還沒到', 10),
      customerText(id, '已經第三次問了', 5),
    ], false)

    const block = await sentimentState(id)
    expect(block.status).toBe('ready')
    expect(block.narrative?.trend).toBeTruthy()
    expect(block.narrative?.advice).toBeTruthy()

    // ⚠️ 這個順序本身就是驗收項：先出現一則 narrative 為 null 的 ready（分數已可看），
    //    才出現帶著 narrative 的第二則。反過來代表折線被散文擋住了。
    const ready = events.filter(
      (e): e is Extract<CopilotEvent, { type: 'sentiment.updated' }> =>
        e.type === 'sentiment.updated' && e.sentiment.status === 'ready',
    )
    expect(ready.length).toBeGreaterThanOrEqual(2)
    expect(ready[0]!.sentiment.narrative).toBeNull()
    expect(ready.at(-1)!.sentiment.narrative).not.toBeNull()
  })

  it('⚠️ 敘述失敗 MUST NOT 讓情緒區塊轉 error —— 分數與示警是主體', async () => {
    const id = convId('narrate-fail')
    setAIProvider(new MockAIProvider({
      narrateFailure: () => new Error('走勢摘要 agent 掛了'),
    }))

    await runColdStart(id, [
      customerText(id, '我的訂單還沒到', 10),
      customerText(id, '已經第三次問了', 5),
    ], false)

    const block = await sentimentState(id)
    expect(block.status).toBe('ready')
    expect(block.timeline.length).toBe(2)
    expect(block.narrative).toBeNull()
  })

  it('只給 trend、不給 advice 的輸出驗不過 —— 走勢那半自己是廢話', async () => {
    const id = convId('narrate-invalid')
    setAIProvider(new MockAIProvider({ invalidNarrativeOutput: true }))

    await runColdStart(id, [
      customerText(id, '我的訂單還沒到', 10),
      customerText(id, '已經第三次問了', 5),
    ], false)

    const block = await sentimentState(id)
    expect(block.status).toBe('ready')
    expect(block.narrative).toBeNull()
  })

  it('只有一個評分點時不呼叫模型（沒有走勢可談）', async () => {
    const id = convId('narrate-single')
    let narrateCalls = 0
    setAIProvider(new (class extends MockAIProvider {
      override async narrateSentiment(input: Parameters<MockAIProvider['narrateSentiment']>[0]) {
        narrateCalls++
        return super.narrateSentiment(input)
      }
    })())

    await runColdStart(id, [customerText(id, '我的訂單還沒到', 10)], false)

    expect(narrateCalls).toBe(0)
    expect((await sentimentState(id)).narrative).toBeNull()
  })
})
