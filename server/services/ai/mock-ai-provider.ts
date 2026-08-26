/**
 * AIProvider 的 mock 實作 —— docs/ARCHITECTURE.md §8.2b「M2 UI 先行完成用」。
 *
 * 回傳固定樣本資料，讓面板狀態機（分析中／重試中／就緒／錯誤／空狀態）的正確性
 * 完全獨立於真實 AI 呼叫驗證。測試用的失敗／延遲／格式外輸出開關見 `MockAIProviderOptions`
 * ——`ImbraceAgentProvider`（真實串接）不在本功能範圍內（specs/001-sentiment-panel/research.md #4）。
 */

import type {
  AIProvider,
  ConversationSummary,
  SentimentPoint,
} from '../../../shared/types/copilot.js'
import type { Message } from '../../../shared/types/conversation.js'

export interface MockAIProviderOptions {
  /** 每次呼叫前的延遲（ms）—— 測試用，模擬 AI 呼叫的執行時間 */
  summarizeDelayMs?: number
  sentimentDelayMs?: number
  /** 每次呼叫時執行；回傳 Error 即拋出該錯誤，回傳 null 表示這次不失敗 */
  summarizeFailure?: () => Error | null
  sentimentFailure?: () => Error | null
  /** 回傳不符合 Zod schema 的輸出（空字串 intent／超出範圍的 score），測試驗證失敗路徑用 */
  invalidSummaryOutput?: boolean
  invalidSentimentOutput?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class MockAIProvider implements AIProvider {
  constructor(private readonly opts: MockAIProviderOptions = {}) {}

  async summarize(input: {
    history: Message[]
    previousSummary?: ConversationSummary
  }): Promise<ConversationSummary> {
    if (this.opts.summarizeDelayMs) await sleep(this.opts.summarizeDelayMs)

    const failure = this.opts.summarizeFailure?.()
    if (failure) throw failure

    if (this.opts.invalidSummaryOutput) {
      // intent 為空字串 —— data-model.md「驗證規則」：空字串視同分析失敗
      return { intent: '' } as unknown as ConversationSummary
    }

    const last = input.history[input.history.length - 1]
    return {
      intent: input.previousSummary?.intent ?? '客戶詢問訂單相關問題',
      keyFacts: [...(input.previousSummary?.keyFacts ?? []), ...(last ? [`最新訊息：${last.id}`] : [])],
      attempted: input.previousSummary?.attempted ?? [],
      openIssues: input.previousSummary?.openIssues ?? ['尚待確認客戶需求細節'],
      riskFlags: input.previousSummary?.riskFlags ?? [],
      advice: '建議先確認客戶的具體訴求，再提供對應方案',
      updatedAt: new Date().toISOString(),
      basedOnMessageId: last?.id ?? input.previousSummary?.basedOnMessageId ?? '',
    }
  }

  async analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]> {
    if (this.opts.sentimentDelayMs) await sleep(this.opts.sentimentDelayMs)

    const failure = this.opts.sentimentFailure?.()
    if (failure) throw failure

    if (this.opts.invalidSentimentOutput) {
      // score 超出 0–100 範圍 —— 測試用的格式外輸出
      return [{ score: 150 }] as unknown as SentimentPoint[]
    }

    return input.messages.map(m => ({
      kind: 'point' as const,
      messageId: m.id,
      at: m.at,
      score: 70,
      label: 'neutral' as const,
      drivers: [],
    }))
  }
}
