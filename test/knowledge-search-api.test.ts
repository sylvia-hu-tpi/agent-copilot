/**
 * 知識庫自然語言快查端點 —— specs/002-suggestion-knowledge-search/contracts/knowledge-search-api.md。
 *
 * `resolveKnowledgeSearch()` 是從 route handler 抽出的核心決策邏輯（不依賴 H3Event），
 * 涵蓋：空白查詢不呼叫 provider、provider 拋錯（含逾時）降級為 degraded、正常命中原樣回傳。
 *
 * ⚠️ JOIN 門檻（FR-025，403）依賴 `requireActiveBffSession()`／cookie session，
 *    這部分需要真實 H3 環境，由 smoke 測試（test/realtime-http.ts）涵蓋，此處不重複。
 *
 * ⚠️ 這裡只 import `resolve-search.ts`（純函式，無 Nitro auto-import 依賴），不 import
 *    route handler 本身（`knowledge-search.post.ts` 使用 `defineEventHandler`）——
 *    比照 tsconfig.scripts.json 檔頭的既有慣例，避免 vitest 綠燈但 tsc 因缺少 Nitro
 *    環境的 ambient 型別宣告而報錯。
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveKnowledgeSearch } from '../server/services/knowledge/resolve-search.js'
import type { KnowledgeHit } from '../shared/types/knowledge.js'

function hit(id: string): KnowledgeHit {
  return { id, title: `文件-${id}`, snippet: '片段', score: null, updatedAt: null, sourceRef: { type: 'knowledge', ref: id } }
}

describe('resolveKnowledgeSearch()', () => {
  it('query 為空白字串時回傳 200 {hits:[]}，且不呼叫 search（FR-008）', async () => {
    const search = vi.fn(async () => [hit('h1')])
    const result = await resolveKnowledgeSearch('', search)

    expect(result).toEqual({ hits: [] })
    expect(search).not.toHaveBeenCalled()
  })

  it('query 僅含空白字元時同樣視為空白（不是「查無結果」）', async () => {
    const search = vi.fn(async () => [hit('h1')])
    const result = await resolveKnowledgeSearch('   ', search)

    expect(result).toEqual({ hits: [] })
    expect(search).not.toHaveBeenCalled()
  })

  it('正常命中時原樣回傳 hits，不帶 degraded 欄位', async () => {
    const hits = [hit('h1'), hit('h2')]
    const result = await resolveKnowledgeSearch('發票補寄要多久', async () => hits)

    expect(result).toEqual({ hits })
  })

  it('查無結果時回傳 hits:[]（與空白查詢的 {hits:[]} 同形狀，但呼叫端已呼叫過 search——FR-011 由前端依 hasQueried 區分）', async () => {
    const search = vi.fn(async () => [])
    const result = await resolveKnowledgeSearch('查不到的關鍵字', search)

    expect(result).toEqual({ hits: [] })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('search() 拋錯時回傳 200 {hits:[],degraded:true}，MUST NOT 讓例外往外拋（憲法 3.1／3.2）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const search = vi.fn(async () => { throw new Error('知識庫服務逾時') })

    const result = await resolveKnowledgeSearch('查詢字串', search)

    expect(result).toEqual({ hits: [], degraded: true })
  })

  it('search() 逾時（模擬 KNOWLEDGE_SEARCH_TIMEOUT_MS 逾時拋出的錯誤）同樣降級為 degraded，而非無限等待', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const search = vi.fn(async () => { throw new Error('知識庫檢索逾時（8000ms）') })

    const result = await resolveKnowledgeSearch('查詢字串', search)

    expect(result).toEqual({ hits: [], degraded: true })
  })
})
