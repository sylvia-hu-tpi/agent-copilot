/**
 * 知識庫自然語言快查 —— specs/002-suggestion-knowledge-search/contracts/knowledge-search-api.md「前端契約」。
 *
 * 一次性 request/response，不經 SSE、不進 CopilotAnalysisState（research.md #7）——與建議卡
 * 是否已產生無關，客服可隨時查詢。
 *
 * ⚠️ 輸入 debounce 300ms；到期時若輸入為空白，MUST NOT 送出請求，且清除既有結果、回到
 *    「尚未輸入查詢」狀態（`hasQueried === false`）——這與「查無相關結果」是不同的空狀態。
 * ⚠️ 送出中若使用者又輸入新字元，不特別 abort 舊請求，但只採用最後一次的回應——
 *    用遞增的請求序號比對，避免競態下舊回應覆蓋新查詢的結果。
 */

import type { KnowledgeHit, KnowledgeSearchResponse } from '#shared/types/knowledge'

const DEBOUNCE_MS = 300

function messageOf(err: unknown): string {
  const e = err as { data?: { message?: string }, statusMessage?: string, message?: string }
  return e?.data?.message || e?.statusMessage || e?.message || '查詢失敗'
}

export function useKnowledgeSearch(conversationId: Ref<string>) {
  const query = ref('')
  const hits = ref<KnowledgeHit[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const notJoined = ref(false)
  const degraded = ref(false)
  /** 是否曾送出過非空白查詢——供 UI 區分「尚未輸入查詢」與「查無相關結果」 */
  const hasQueried = ref(false)

  let seq = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  async function runSearch(q: string, expandRef?: string): Promise<KnowledgeHit[]> {
    const mySeq = ++seq
    loading.value = true
    error.value = null
    notJoined.value = false
    try {
      const res = await $fetch<KnowledgeSearchResponse>(
        `/api/conversations/${conversationId.value}/knowledge-search`,
        { method: 'POST', body: { query: q, expandRef } },
      )
      if (mySeq !== seq) return [] // 競態：已有更新的查詢，這次回應作廢
      degraded.value = res.degraded ?? false
      return res.hits
    }
    catch (err) {
      if (mySeq !== seq) return []
      const statusCode = (err as { statusCode?: number })?.statusCode
      if (statusCode === 403) {
        notJoined.value = true
      }
      else {
        error.value = messageOf(err)
      }
      return []
    }
    finally {
      if (mySeq === seq) loading.value = false
    }
  }

  /** 立即查詢目前的 query（debounce 到期時內部呼叫，亦可由呼叫端主動觸發） */
  function search(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (!query.value.trim()) return
    hasQueried.value = true
    void runSearch(query.value).then((result) => { hits.value = result })
  }

  /** 「展開全文」：限定同一檔案重新查詢，回傳結果由呼叫端自行顯示，不覆蓋主要 hits 列表 */
  async function expand(sourceRef: string): Promise<KnowledgeHit[]> {
    return runSearch(query.value, sourceRef)
  }

  watch(query, (value) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (!value.trim()) {
      seq++ // 讓任何進行中的舊請求的回應作廢
      hits.value = []
      hasQueried.value = false
      loading.value = false
      error.value = null
      notJoined.value = false
      degraded.value = false
      return
    }
    debounceTimer = setTimeout(search, DEBOUNCE_MS)
  })

  return { query, hits, loading, error, notJoined, degraded, hasQueried, search, expand }
}
