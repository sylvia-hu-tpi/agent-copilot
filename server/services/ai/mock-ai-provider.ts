/**
 * AIProvider 的 mock 實作 —— docs/ARCHITECTURE.md §8.2b「M2 UI 先行完成用」。
 *
 * 回傳固定樣本資料，讓面板狀態機（分析中／重試中／就緒／錯誤／空狀態）的正確性
 * 完全獨立於真實 AI 呼叫驗證。測試用的失敗／延遲／格式外輸出開關見 `MockAIProviderOptions`
 * ——`ImbraceAgentProvider`（真實串接）不在本功能範圍內（specs/001-sentiment-panel/research.md #4）。
 */

import type {
  AIProvider,
  ClosureDraftAiPart,
  ClosureVocabulary,
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
  /**
   * 結案摘要（specs/006）。⚠️ `closureDelayMs` **不是**效能旋鈕 ——
   * SC-004 的「等待期間 100% 誠實」要把它拉長，才驗得到「完成前 status 從未是 ready」。
   */
  closureDelayMs?: number
  closureFailure?: () => Error | null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()) }
    if (signal?.aborted) { clearTimeout(timer); reject(abortError()); return }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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

  /**
   * 結案摘要（specs/006-closure-handoff-summary）。
   *
   * ⚠️ **US1～US3 的整條路徑（面板、編輯、冪等、四種失敗形態）靠這一支驗收** ——
   *    真正的第五個 agent 只影響摘要內容品質，不影響任何一條狀態機路徑。
   *    因此這裡回的必須是**固定但合法**的值：受控詞彙一律取 `vocabulary` 的第一個，
   *    MUST NOT 回白名單外的值（那會讓 mock 路徑與真 provider 走不同的後驗分支）。
   */
  async summarizeClosure(input: {
    history: Message[]
    vocabulary: ClosureVocabulary
    knowledgeHits: KnowledgeHit[]
    signal?: AbortSignal
  }): Promise<ClosureDraftAiPart> {
    // ⚠️ 延遲期間也要能被取消 —— 契約 R2.9 要求「取消 MUST 真的中止在途呼叫」，
    //    只在延遲**之後**檢查 signal 的話，SC-004 的取消測試會等滿整段延遲才生效，
    //    而那與「只是把畫面關掉」在測試上分不出來。
    if (this.opts.closureDelayMs) await sleep(this.opts.closureDelayMs, input.signal)
    throwIfAborted(input.signal)

    const failure = this.opts.closureFailure?.()
    if (failure) throw failure

    const first = <T>(list: readonly T[]): T | undefined => list[0]
    const last = input.history[input.history.length - 1]

    return {
      summary: `客戶就本次議題來訊，已完成說明與後續安排（mock；本區間共 ${input.history.length} 則訊息${
        last ? `，最後一則 ${last.id}` : ''
      }）。`,
      intent: '客戶詢問訂單相關問題',
      category: first(input.vocabulary.categories) ?? '',
      resolution: (first(input.vocabulary.resolutions) ?? '') as ClosureDraftAiPart['resolution'],
      actionsTaken: input.vocabulary.actionsTaken.slice(0, 1) as string[],
      sentimentOutcome: (first(input.vocabulary.sentimentOutcomes) ?? '') as ClosureDraftAiPart['sentimentOutcome'],
      // 前兩筆命中 —— 白名單後驗（憲法 4.3）在真 provider 與 mock 都會跑到，
      // 取命中集合內的值才驗得到「有引用時不被丟棄」那一半
      citedSopIds: input.knowledgeHits.slice(0, 2).map(h => h.id),
      followUps: [],
      confidence: null,
    }
  }
}

/**
 * ⚠️ `AbortError` 的 `name` 逐字是 `'AbortError'` —— 上層（`draft.post.ts`）以它
 *    分辨「客服取消了」與「AI 真的失敗了」。改成別的名字不會有型別錯誤，
 *    只會讓取消被記成一次失敗並回 502，而客服已經不在看了。
 */
function abortError(): Error {
  const err = new Error('結案摘要產生已取消')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

