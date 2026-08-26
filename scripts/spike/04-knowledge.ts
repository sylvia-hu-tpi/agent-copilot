/**
 * 04 — 知識庫檢索（C-1 / C-2）🔴 P0
 *
 * 建議卡上「SOP 3.2 · 信心度 92%」必須有能回傳「條目 ID + 相關度分數」的檢索 API，
 * 否則憲法 4.3（sopId 必須經白名單後驗）無法執行，模型會杜撰 SOP 編號。
 *
 * 靜態分析已知（@imbrace/sdk@1.4.0）：
 *   ✅ boards.search(boardId, {q, filter, limit}) —— Meilisearch 相容，關鍵字檢索
 *   ✅ ai.embed({model, input[]}) —— 可自行產生向量
 *   ✅ aiAgent.processEmbedding({fileId}) —— 建立 embedding
 *   ❌ 找不到「查詢 embedding」的 API —— RAG 的最後一哩路缺失
 * 也就是說 §12.2 規劃的 BoardsRagProvider 少了檢索那一步。本 probe 確認替代路徑。
 */

import { runProbe, env, isMain, SkipProbe, type Finding } from './lib/harness.js'

export const probe04 = () => runProbe('04', 'C-1/C-2 知識庫檢索', async (p, client) => {
  // ── ① Meilisearch 關鍵字檢索是否帶分數與 ID ──────────
  const boardId = env('SPIKE_BOARD_ID')
  if (boardId) {
    const res = await client.boards.search(boardId, { q: '流程', limit: 5 })
    const hits = (res as any)?.message?.hits ?? (res as any)?.hits ?? []
    const sample = hits[0]
    const scoreKey = sample && Object.keys(sample).find(k => /score|rank/i.test(k))

    console.log(`     boards.search 回傳 ${hits.length} 筆`)
    if (sample) console.log(`     欄位：${Object.keys(sample).slice(0, 12).join(', ')}`)
    p.fixture('board-search', hits)

    p.record({
      question: 'C-2a', claim: 'boards.search 能否回傳條目 ID 與相關度分數',
      verdict: sample ? (scoreKey ? 'yes' : 'partial') : 'unknown',
      evidence: sample
        ? `hits 含 id=${'_id' in sample || 'id' in sample ? '✅' : '❌'}、分數欄位=${scoreKey ?? '❌ 無'}`
        : '查無結果，無法判斷欄位結構',
      impact: scoreKey
        ? '✅ 可用關鍵字檢索建立 sopId 白名單，憲法 4.3可執行。'
        : '🟡 有 ID 無分數 → SuggestionCard.confidence 不能用檢索分數，'
          + '§11.6 的 confidence = f(檢索分數, 模型自評, 上下文完整度) 公式缺一項。'
          + 'Meilisearch 需在查詢時帶 showRankingScore:true，SDK 未公開此參數，需用 raw 呼叫。',
    })
  } else {
    p.record({
      question: 'C-2a', claim: 'boards.search 檢索能力',
      verdict: 'unknown',
      evidence: '未設定 SPIKE_BOARD_ID',
      impact: '建議先在平台建一個 SOP board 並填入數筆測試資料再重跑。',
    })
  }

  // ── ② 是否存在語意檢索 API ───────────────────────────
  const knowledgeApis: Array<[string, () => Promise<unknown>]> = [
    ['platform.listKnowledge', () => client.platform.listKnowledge()],
    ['aiAgent.listEmbeddingFiles', () => client.aiAgent.listEmbeddingFiles()],
    ['boards.searchFolders', () => client.boards.searchFolders({})],
    ['ai.listRagFiles', () => client.ai.listRagFiles()],
  ]

  const available: string[] = []
  for (const [name, call] of knowledgeApis) {
    try {
      const r = await call()
      const n = Array.isArray(r) ? r.length
        : Array.isArray((r as any)?.data) ? (r as any).data.length : '?'
      available.push(`${name}(${n})`)
      console.log(`     ✅ ${name} 可用，${n} 筆`)
    } catch (e) {
      console.log(`     ❌ ${name}：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  p.record({
    question: 'C-1', claim: 'SDK 是否有 Knowledge/DocIQ 的語意搜尋 API',
    verdict: 'no',
    evidence: `靜態分析 @imbrace/sdk@1.4.0 全部 .d.ts：只有 processEmbedding（建立）、`
      + `listEmbeddingFiles（列檔），沒有任何 query/retrieve/semanticSearch。`
      + `實測可用的知識相關端點：${available.join(', ') || '無'}`,
    impact: '❗ §12.2 規劃的「uploadFile → processEmbedding → 語意檢索」缺最後一步。'
      + '三條替代路徑：'
      + '(a) boards.search 關鍵字檢索 —— 有 ID、可做白名單，但非語意，同義詞會漏；'
      + '(b) 自建向量檢索 —— ai.embed() 已公開，SOP 量小（數百條）可直接在記憶體/Redis 算 cosine，'
      + '完全可控且能自訂分數，建議採此路；'
      + '(c) 掛 Knowledge Hub 給 AI Agent 再問它 —— 回傳自由文字，沒有條目 ID 與分數，'
      + '無法滿足憲法 4.3，不建議。',
  })

  // ── ③ ai.embed 是否真的可用（路徑 b 的前提）──────────
  try {
    const model = env('SPIKE_AI_MODEL') || 'text-embedding-3-small'
    const emb = await client.ai.embed({ model, input: ['測試向量'] })
    const dim = emb?.data?.[0]?.embedding?.length ?? 0
    console.log(`     ✅ ai.embed 可用，維度 ${dim}`)
    p.record({
      question: 'C-2b', claim: 'ai.embed() 能否用於自建向量檢索',
      verdict: dim > 0 ? 'yes' : 'partial',
      evidence: `model=${model} 回傳 ${dim} 維向量`,
      impact: '✅ 自建 RAG 路徑成立：SOP 數量級小，離線建索引 + 記憶體 cosine 即可，'
        + '且分數完全自控，SuggestionCard.confidence 的校準公式可完整實作。',
    })
  } catch (e) {
    p.record({
      question: 'C-2b', claim: 'ai.embed() 能否用於自建向量檢索',
      verdict: 'no',
      evidence: `失敗：${e instanceof Error ? e.message : String(e)}（可能需指定正確的 model）`,
      impact: '若 embed 不可用，自建 RAG 需改用外部 embedding 服務 —— '
        + '對話內容出境的合規問題（風險 #9）範圍擴大。',
    })
  }
})

if (isMain(import.meta.url)) {
  probe04().then((f: Finding[]) => process.exit(0))
}
