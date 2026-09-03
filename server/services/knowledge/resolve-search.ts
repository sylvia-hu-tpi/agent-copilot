/**
 * 知識庫快查端點的核心決策邏輯 —— specs/002-suggestion-knowledge-search/contracts/knowledge-search-api.md。
 *
 * ⚠️ 刻意獨立於 `knowledge-search.post.ts`（不依賴 Nitro auto-import／H3Event），
 *    比照 tsconfig.scripts.json 的既有慣例：一旦某檔案開始用 `defineEventHandler`，
 *    就不再能被 test/scripts 直接 import，需抽出純函式共用，否則 vitest 綠燈但
 *    `tsc -p tsconfig.scripts.json` 會因缺少 Nitro 環境的 ambient 型別宣告而報錯。
 */

import type { KnowledgeSearchResponse } from '../../../shared/types/knowledge.js'

/**
 * @param search 呼叫端已綁好 fileId／topK 的檢索函式；query 為空白時 MUST NOT 被呼叫（FR-008）
 */
export async function resolveKnowledgeSearch(
  query: string,
  search: () => Promise<KnowledgeSearchResponse['hits']>,
): Promise<KnowledgeSearchResponse> {
  // FR-008：空白或僅空白字元 → 「尚未查詢」，不是用戶端錯誤，也不呼叫 KnowledgeProvider
  if (!query.trim()) {
    return { hits: [] }
  }

  try {
    const hits = await search()
    return { hits }
  }
  catch (err) {
    // 憲法 3.1／3.2：這支端點 MUST NOT 回 5xx——逾時或拋錯一律降級為 degraded
    console.error('[knowledge-search] 檢索失敗，回傳 degraded:', err instanceof Error ? err.message : String(err))
    return { hits: [], degraded: true }
  }
}
