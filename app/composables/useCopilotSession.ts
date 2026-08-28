/**
 * 情緒面板（摘要卡與情緒 sparkline）—— specs/001-sentiment-panel。
 *
 * 純消費 SSE：訂閱 `useStreamStore()` 解析出的 `summary.updated`／`sentiment.updated`，
 * 過濾 `conversationId` 相符者，暴露 reactive 的區塊狀態。整塊覆蓋既有顯示狀態，
 * 不做 partial merge（contracts/copilot-sse-events.md「消費端保證」）。
 */

import type { CopilotEvent } from '#shared/types/events'
import type { SentimentBlock, SuggestionBlock, SummaryBlock } from '#shared/types/copilot'

function emptySummaryBlock(): SummaryBlock {
  return { status: 'empty', summary: null, updatedAt: new Date().toISOString() }
}

function emptySentimentBlock(): SentimentBlock {
  return {
    status: 'empty',
    timeline: [],
    stats: { lowestScore: null, lowestAt: null },
    updatedAt: new Date().toISOString(),
  }
}

/**
 * `knowledgeSearch: { ran: false, hitCount: 0 }`——尚未查過，`ran` 為 `false` 在此是正確的：
 * 憲法 6.2 管的是「生成建議卡時不得略過檢索」，不是「初始狀態」（specs/002-suggestion-knowledge-search）。
 */
function emptySuggestionBlock(): SuggestionBlock {
  return {
    status: 'empty',
    cards: [],
    knowledgeSearch: { ran: false, hitCount: 0 },
    updatedAt: new Date().toISOString(),
  }
}

export function useCopilotSession(conversationId: Ref<string>) {
  const stream = useStreamStore()

  const summary = ref<SummaryBlock>(emptySummaryBlock())
  const sentiment = ref<SentimentBlock>(emptySentimentBlock())
  const suggestions = ref<SuggestionBlock>(emptySuggestionBlock())
  const retrying = ref<Partial<Record<'summary' | 'sentiment' | 'suggestions', boolean>>>({})

  function handle(evt: CopilotEvent): void {
    if (!('conversationId' in evt) || evt.conversationId !== conversationId.value) return

    switch (evt.type) {
      case 'summary.updated':
        summary.value = evt.summary
        break
      case 'sentiment.updated':
        sentiment.value = evt.sentiment
        break
      case 'suggestion.updated':
        suggestions.value = evt.suggestion
        break
    }
  }

  /**
   * FR-008：手動重試單一區塊。202 代表已接受，結果透過上面的 SSE 事件送達 ——
   * 這裡不等待分析完成，只負責觸發（contracts/copilot-retry-api.md）。
   */
  async function retry(block: 'summary' | 'sentiment' | 'suggestions'): Promise<void> {
    if (retrying.value[block]) return
    retrying.value[block] = true
    try {
      await $fetch(`/api/conversations/${conversationId.value}/copilot/retry`, {
        method: 'POST',
        body: { block },
      })
    }
    catch {
      // 409（非 error 狀態時重複觸發）與網路錯誤都不需要特別處理——
      // 畫面本身的 status 已經是真相來源，重試按鈕的 disabled 狀態會自然反映
    }
    finally {
      retrying.value[block] = false
    }
  }

  /** 三個區塊之中有沒有處於 error 的 —— 「全部重試」的可按條件（FR-019） */
  const hasError = computed(() =>
    summary.value.status === 'error'
    || sentiment.value.status === 'error'
    || suggestions.value.status === 'error',
  )

  /**
   * FR-018：一次重試所有失敗的區塊。
   *
   * ⚠️ **對每個 `error` 區塊各發一次既有的單區塊端點**（契約 1.2）——
   *    MUST NOT 新增 `POST /copilot/retry-all`，也 MUST NOT 讓 `block` 接受陣列。
   *    三個並行的 POST 對 BFF 是可忽略的負載，而合併端點會多一份請求形狀要維護與測試
   *    （spec.md Assumptions 已定案：改契約的代價大於收益）。
   *
   * ⚠️ **已成功的區塊 MUST NOT 被重跑** —— 只挑 `status === 'error'` 的。
   *    非 error 的區塊送過去會拿到 409，等於白打一趟。
   */
  async function retryAll(): Promise<void> {
    const failed = ([
      ['summary', summary.value.status],
      ['sentiment', sentiment.value.status],
      ['suggestions', suggestions.value.status],
    ] as const).filter(([, status]) => status === 'error').map(([block]) => block)

    await Promise.all(failed.map(block => retry(block)))
  }

  let offStream: (() => void) | undefined

  onMounted(() => {
    stream.connect()
    offStream = stream.on(handle)
  })

  onBeforeUnmount(() => offStream?.())

  // 切換對話：畫面回到未知狀態，等下一個 SSE 事件（含重連快照，FR-010）填入
  watch(conversationId, () => {
    summary.value = emptySummaryBlock()
    sentiment.value = emptySentimentBlock()
    suggestions.value = emptySuggestionBlock()
  })

  return { summary, sentiment, suggestions, hasError, retry, retryAll }
}
