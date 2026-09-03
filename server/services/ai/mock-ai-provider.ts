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
  SentimentNarrative,
  SentimentPoint,
  SuggestionCard,
} from '../../../shared/types/copilot.js'
import type { Message } from '../../../shared/types/conversation.js'
import type { KnowledgeHit } from '../../../shared/types/knowledge.js'

export interface MockAIProviderOptions {
  /** 每次呼叫前的延遲（ms）—— 測試用，模擬 AI 呼叫的執行時間 */
  summarizeDelayMs?: number
  sentimentDelayMs?: number
  narrateDelayMs?: number
  suggestDelayMs?: number
  /** 每次呼叫時執行；回傳 Error 即拋出該錯誤，回傳 null 表示這次不失敗 */
  summarizeFailure?: () => Error | null
  sentimentFailure?: () => Error | null
  /** ⚠️ 走勢摘要失敗 MUST NOT 讓情緒區塊轉 error —— 這個開關就是用來守住那條線的 */
  narrateFailure?: () => Error | null
  suggestFailure?: () => Error | null
  /** 回傳不符合 Zod schema 的輸出（空字串 intent／超出範圍的 score），測試驗證失敗路徑用 */
  invalidSummaryOutput?: boolean
  invalidSentimentOutput?: boolean
  /** 只給 trend、不給 advice —— schema 應該擋下來（見 SentimentNarrativeSchema） */
  invalidNarrativeOutput?: boolean
  invalidSuggestOutput?: boolean
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
      // 畫布 2a「對話摘要」的正文與主題標籤（2026-09-01）——
      // 兩者在 schema 是選填，mock 一律給值，讓本機開發看得到完整版面
      narrative: input.previousSummary?.narrative
        ?? '客戶詢問訂單相關問題，已確認訂單狀態，尚待確認客戶的具體訴求細節。',
      topics: input.previousSummary?.topics ?? ['訂單查詢'],
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

  async narrateSentiment(input: {
    points: Array<Pick<SentimentPoint, 'score' | 'label' | 'drivers'>>
  }): Promise<SentimentNarrative> {
    if (this.opts.narrateDelayMs) await sleep(this.opts.narrateDelayMs)

    const failure = this.opts.narrateFailure?.()
    if (failure) throw failure

    if (this.opts.invalidNarrativeOutput) {
      // 只有 trend、沒有 advice —— schema 的 advice.min(1) 應該擋下來
      return { trend: '情緒大致平穩' } as unknown as SentimentNarrative
    }

    return {
      trend: `近 ${input.points.length} 輪情緒大致平穩，無明顯惡化`,
      advice: '建議維持目前的說明節奏，並在下一則回覆給出明確時間點',
    }
  }

  async suggest(input: {
    history: Message[]
    knowledgeHits: KnowledgeHit[]
    aiReplies: boolean
  }): Promise<SuggestionCard[]> {
    if (this.opts.suggestDelayMs) await sleep(this.opts.suggestDelayMs)

    const failure = this.opts.suggestFailure?.()
    if (failure) throw failure

    if (this.opts.invalidSuggestOutput) {
      // text 為空字串 —— schema 驗證要求 min(1)，測試用的格式外輸出
      return [{ text: '' }] as unknown as SuggestionCard[]
    }

    const hit = input.knowledgeHits[0]
    return [
      {
        id: `mock-suggestion-${input.history.length}`,
        sopId: hit?.id ?? null,
        sopTitle: hit?.title ?? null,
        text: '建議先向客戶致歉，並確認目前的處理進度',
        confidence: null,
        rationale: '客戶語氣顯示不滿，建議先安撫再處理',
        tone: 'apologetic' as const,
        requiresData: [],
        supersededBy: null,
      },
    ]
  }
}
