/**
 * 分析管線的 JOIN 界線 —— specs/003-analysis-trigger-policy FR-012～FR-014、SC-002。
 *
 * ⚠️ **修正前的門檻寫的是「分析狀態存不存在」，那回答的不是同一個問題。**
 *    `CopilotAnalysisState` 有 2 小時 sliding TTL，LEAVE 不會清掉它 ——
 *    於是客服按下離開之後，分析每 20 秒繼續跑一輪，畫面上什麼都看不到，也不會報錯。
 *
 * ⚠️ 兩層（決策 4），缺一不可：
 *   ① **保證層**：`runIncremental()` 在 debounce **觸發的當下**檢查 JOIN 狀態。
 *   ② **清理層**：`cancelPendingAnalysis()` 清掉還沒觸發的計時器。
 *   只做 ② 會漏掉「背景名額滿時 `runIncremental()` 自己重新 `scheduleIncremental()`」那條路
 *   （那是清理之後才排的）；只做 ① 行為正確但留著一個空轉的計時器。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingAnalysis,
  runColdStart,
  runIncremental,
  scheduleIncremental,
  setJoinedResolver,
} from '../server/services/copilot-analysis.js'
import { PollingMessageSource } from '../server/sources/polling-message-source.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { MemoryStateStore } from '../server/state/memory-store.js'
import { useStateStore } from '../server/state/index.js'
import type { Message } from '../shared/types/conversation.js'

let seq = 0

function customer(convId: string, text = '客戶說了一句話'): Message {
  seq++
  return {
    id: `m_jb_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - 1000 * (1000 - seq)).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text,
  }
}

function convId(label: string): string {
  return `conv-jb-${label}-${Date.now()}-${seq}`
}

/** 數 AI 被呼叫幾次 —— 「分析有沒有真的跑」只能這樣驗，看狀態欄位看不出來 */
function countingAI(): { calls: () => number } {
  let calls = 0
  setAIProvider(new (class extends MockAIProvider {
    override async analyzeSentiment(input: Parameters<MockAIProvider['analyzeSentiment']>[0]) {
      calls++
      return super.analyzeSentiment(input)
    }
  })())
  return { calls: () => calls }
}

afterEach(() => {
  setJoinedResolver(null)
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
  vi.useRealTimers()
})

describe('FR-012：runIncremental() 的門檻是「還有沒有人 JOIN」', () => {
  it('未 JOIN 時不執行 —— 即使分析狀態仍然存在（那正是修正前的漏洞）', async () => {
    const id = convId('left')
    const history = [customer(id)]
    const ai = countingAI()

    await runColdStart(id, history, false)
    const afterJoin = ai.calls()
    expect(afterJoin).toBeGreaterThan(0)

    // 客服按下離開 —— 分析狀態還在（2 小時 sliding TTL），但沒有人 JOIN 了
    setJoinedResolver(() => false)
    await runIncremental(id, [customer(id)], 'foreground', false)

    expect(ai.calls()).toBe(afterJoin)
    // ⚠️ 狀態本身刻意不清 —— 重新 JOIN 時要看得到（001 FR-010）
    expect(await useStateStore().getAnalysisState(id)).not.toBeNull()
  })

  it('已 JOIN 時照常執行', async () => {
    const id = convId('joined')
    const ai = countingAI()

    await runColdStart(id, [customer(id)], false)
    const afterJoin = ai.calls()

    setJoinedResolver(() => true)
    await runIncremental(id, [customer(id)], 'foreground', false)

    expect(ai.calls()).toBeGreaterThan(afterJoin)
  })

  it('背景優先度同樣受門檻約束（憲法 6.2 保護的是「背景但仍 JOIN」的對話，不是已離開的）', async () => {
    const id = convId('bg')
    const ai = countingAI()

    await runColdStart(id, [customer(id)], false)
    const afterJoin = ai.calls()

    setJoinedResolver(() => false)
    await runIncremental(id, [customer(id)], 'background', false)

    expect(ai.calls()).toBe(afterJoin)
  })
})

/**
 * FR-014 —— 「同事仍 JOIN 時，我的 LEAVE 不停止分析」。
 *
 * 這條之所以不需要任何額外邏輯，是因為判斷資料取自 `PollingMessageSource.aggregateState()`，
 * 它天生是**對話層級**的（跑過該對話所有訂閱者）。這裡直接對那份聚合驗。
 */
describe('FR-014：兩位客服其一離開後，對話層級聚合仍為 true', () => {
  it('A 離開、B 仍在 → isJoined 為 true；B 也離開 → false', async () => {
    const store = new MemoryStateStore({ autoSweep: false })
    const source = new PollingMessageSource({
      fetchLatest: async () => [],
      store,
      isListCovered: () => false,
    })
    const id = 'conv-two-agents'

    const offA = source.subscribe(id, () => {}, { joined: true })
    const offB = source.subscribe(id, () => {}, { joined: true })
    expect(source.isJoined(id)).toBe(true)

    offA()
    expect(source.isJoined(id)).toBe(true)

    offB()
    expect(source.isJoined(id)).toBe(false)

    await source.dispose()
    store.dispose()
  })
})

describe('FR-013：cancelPendingAnalysis() 清除等待中的 debounce 排程', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('排程之後呼叫 → 計時器到期時什麼都不會發生', async () => {
    const id = convId('cancel')
    const ai = countingAI()
    await runColdStart(id, [customer(id)], false)
    const afterJoin = ai.calls()

    scheduleIncremental(id, [customer(id)], 'foreground', false)
    cancelPendingAnalysis(id)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(ai.calls()).toBe(afterJoin)
  })

  it('沒有等待中的排程時是 no-op，不拋錯', () => {
    expect(() => cancelPendingAnalysis('never-scheduled')).not.toThrow()
  })

  /**
   * ⚠️ 清理層擋不住的那條路：`runIncremental()` 在背景名額滿時會**自己**重新
   *    `scheduleIncremental()`。那是清理之後才排的計時器，只有保證層（觸發當下再檢查一次）
   *    擋得住。這裡驗的正是「即使排程真的觸發了，也不會呼叫 AI」。
   */
  it('保證層：排程照常觸發，但觸發當下已無人 JOIN → 不呼叫 AI', async () => {
    const id = convId('gate-at-fire')
    const ai = countingAI()
    await runColdStart(id, [customer(id)], false)
    const afterJoin = ai.calls()

    scheduleIncremental(id, [customer(id)], 'foreground', false)
    // 刻意**不**呼叫 cancelPendingAnalysis —— 只有保證層在守
    setJoinedResolver(() => false)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(ai.calls()).toBe(afterJoin)
  })
})
