/**
 * 情緒面板（摘要卡與情緒 sparkline）—— specs/001-sentiment-panel。
 *
 * 純消費 SSE：訂閱 `useStreamStore()` 解析出的 `summary.updated`／`sentiment.updated`，
 * 過濾 `conversationId` 相符者，暴露 reactive 的區塊狀態。整塊覆蓋既有顯示狀態，
 * 不做 partial merge（contracts/copilot-sse-events.md「消費端保證」）。
 */

import type { CopilotEvent } from '#shared/types/events'
import type { SentimentBlock, SummaryBlock } from '#shared/types/copilot'

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

export function useCopilotSession(conversationId: Ref<string>) {
  const stream = useStreamStore()

  const summary = ref<SummaryBlock>(emptySummaryBlock())
  const sentiment = ref<SentimentBlock>(emptySentimentBlock())
  const retrying = ref<Partial<Record<'summary' | 'sentiment', boolean>>>({})

  function handle(evt: CopilotEvent): void {
    if (!('conversationId' in evt) || evt.conversationId !== conversationId.value) return

    switch (evt.type) {
      case 'summary.updated':
        summary.value = evt.summary
        break
      case 'sentiment.updated':
        sentiment.value = evt.sentiment
        break
    }
  }

  /**
   * FR-008：手動重試單一區塊。202 代表已接受，結果透過上面的 SSE 事件送達 ——
   * 這裡不等待分析完成，只負責觸發（contracts/copilot-retry-api.md）。
   */
  async function retry(block: 'summary' | 'sentiment'): Promise<void> {
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
  })

  return { summary, sentiment, retry }
}
