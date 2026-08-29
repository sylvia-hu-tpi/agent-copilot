/**
 * 20 — 知識庫檢索延遲（004 第二段的端到端前提）
 *
 * 為什麼需要它：`agent-knowledge-provider.ts` 的兩個逾時常數都是實測校準的，但那組數字
 * （最快 13.0、最慢 24.9 秒）來自 2026-08-27 的 `spike:contract`，**取樣散在三個不同模型
 * 的 agent、每個只有三四次**，且其中 `qwen3-32b` 的樣本已因知識庫 agent 被人改過模型而
 * 失效（見 `docs/ARCHITECTURE.md` §8.2b 的模型表警告）。
 *
 * 004 的第二段是「檢索完成後再生成帶引用的卡」，端到端 = 檢索 + 生成。生成端已用 n=15
 * 量清楚（中位約 11.4 秒），**檢索端卻還停在一組來源可疑的舊數字上**，於是整個第二段的
 * 端到端只能說「大約 24～36 秒」。這支腳本補上檢索端。
 *
 * ⚠️ **走生產路徑的 `AgentKnowledgeProvider.search()`，不自行組呼叫。** prompt 形狀、
 *    RAG 輸出解析、逾時包裝都與正式路徑同一份程式碼，否則量到的是另一件事
 *    （比照 18 號匯出 `buildSuggestionPrompt()` 的同一個理由）。
 *
 * ⚠️ **逾時上限刻意放寬到 60 秒**，不是沿用生產的 30 秒。生產逾時會把「慢」記成「失敗」，
 *    而我們要量的正是尾巴有多長 —— 被 30 秒截斷就永遠看不到真實分布。
 *
 * ⚠️ **本腳本同時回答一個規格問題**：`SUGGESTION_RETRIEVAL_TIMEOUT_MS`（目前 8 秒）
 *    在真實環境下命中率是多少？若為 0%，代表建議卡在現行設定下**永遠**拿不到引用，
 *    那正是 004 存在的理由，需要有數字支撐而不是靠推論。
 *
 * 用法：
 *   npm run spike:knowledge-latency          # 預設 12 次
 *   npm run spike:knowledge-latency -- 20    # 20 次
 */

import { makeClient, loadEnv, isMain, OUT_DIR } from './lib/harness.js'
import { AgentKnowledgeProvider } from '../../server/services/knowledge/agent-knowledge-provider.js'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 與 18 號 `suggestion-kb` 同一段對話的客戶發言，串接方式比照
 * `copilot-analysis.ts`（只取客戶側 `m.text`，換行串接）—— 數字才可跨腳本比較。
 */
const QUERY = [
  '你好，我想問一下網路的問題',
  '網路好像有點不穩定，看影片一直轉圈圈',
  '已經重開機三次了都沒解決',
  '到底要修到什麼時候，已經影響到我上班了',
  '這個月的費用可以退嗎？不然我考慮換一家',
].join('\n')

/** 生產的建議卡檢索逾時（`agent-knowledge-provider.ts`），本腳本用來計算命中率 */
const SUGGESTION_TIMEOUT_MS = 8_000
/** 生產的快查逾時，同上 */
const QUICK_SEARCH_TIMEOUT_MS = 30_000
/** 量測用的放寬上限 —— 要看見尾巴，不能被生產逾時截斷 */
const PROBE_TIMEOUT_MS = 60_000

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

async function main(): Promise<void> {
  loadEnv()
  const runs = Number(process.argv[2] ?? 12)
  const agentId = process.env.IMBRACE_KNOWLEDGE_AGENT_ID?.trim()
    || process.env.NUXT_IMBRACE_KNOWLEDGE_AGENT_ID?.trim()
    || ''
  if (!agentId) {
    console.error('缺少 IMBRACE_KNOWLEDGE_AGENT_ID（見 .env.example）')
    process.exit(1)
  }

  const client = makeClient()

  // ⚠️ model_id 一律由 API 讀取，MUST NOT 靠人工記錄（§8.2b 的規則，2026-08-28 的產物）
  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>
  const hit = raw.find(a => String(a.id ?? a._id ?? '') === agentId)
  const modelId = String(hit?.model_id ?? '(未提供)')
  const agentName = String(hit?.name ?? '(未知)')

  const provider = new AgentKnowledgeProvider(client, agentId)

  console.log(`\n── 20 知識庫檢索延遲 ────────────────────────────────────`)
  console.log(`   agent：${agentName}（${agentId}）`)
  console.log(`   模型：${modelId}   ← 由 API 讀取，不是人工記錄`)
  console.log(`   樣本：${runs} 次   量測逾時上限：${PROBE_TIMEOUT_MS / 1000} 秒（刻意放寬，要看見尾巴）\n`)

  const results: Array<{ run: number, ms: number, hits: number, ok: boolean, note: string }> = []

  for (let run = 1; run <= runs; run++) {
    const t0 = Date.now()
    try {
      const hits = await provider.search(QUERY, { topK: 5, timeoutMs: PROBE_TIMEOUT_MS })
      const ms = Date.now() - t0
      // ⚠️ 空集合不是錯誤（FR-004 允許以空集合續行），但對第二段而言等同於沒有引用可用，
      //    因此獨立計數 —— 只看延遲會漏掉「很快回來但什麼都沒查到」。
      const titles = hits.slice(0, 3).map(h => h.title).join('｜')
      console.log(`   第 ${run} 次（${ms}ms）${hits.length > 0 ? '✅' : '⚠️ '} ${hits.length} 筆${titles ? `  ${titles}` : '（空集合）'}`)
      results.push({ run, ms, hits: hits.length, ok: hits.length > 0, note: titles })
    }
    catch (e) {
      const ms = Date.now() - t0
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`   第 ${run} 次（${ms}ms）💥 ${msg}`)
      results.push({ run, ms, hits: 0, ok: false, note: `失敗：${msg}` })
    }
  }

  const sorted = results.map(r => r.ms).sort((a, b) => a - b)
  const withHits = results.filter(r => r.ok).length
  const under8 = results.filter(r => r.ms <= SUGGESTION_TIMEOUT_MS).length
  const under30 = results.filter(r => r.ms <= QUICK_SEARCH_TIMEOUT_MS).length

  console.log(`\n── 結果 ──────────────────────────────────────────────────`)
  console.log(`   有命中    ${withHits}/${runs}`)
  console.log(`   最快      ${sorted[0]}ms`)
  console.log(`   中位數    ${percentile(sorted, 0.5)}ms`)
  console.log(`   p90       ${percentile(sorted, 0.9)}ms`)
  console.log(`   最慢      ${sorted[sorted.length - 1]}ms`)
  console.log(`\n   ⏱ 8 秒內（建議卡現行逾時）  ${under8}/${runs}`
    + `${under8 === 0 ? '  ⛔ 建議卡在現行設定下永遠拿不到引用' : ''}`)
  console.log(`   ⏱ 30 秒內（快查現行逾時）   ${under30}/${runs}`
    + `${under30 < runs ? '  ⚠️ 快查會逾時' : ''}`)

  const slug = modelId.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  const file = resolve(OUT_DIR, `20-knowledge-latency-${slug}.json`)
  writeFileSync(file, JSON.stringify({
    agentName, agentId, modelId, runs, query: QUERY, results,
  }, null, 2), 'utf8')
  console.log(`\n   📁 ${file}\n`)
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('\n💥', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
