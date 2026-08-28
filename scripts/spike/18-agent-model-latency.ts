/**
 * 18 — 單一 agent 的延遲與輸出合規量測（換模型時的 A／B 工具）
 *
 * 為什麼需要它：`15-copilot-agents.ts` 一次量摘要＋情緒共 12 次呼叫，換一次模型就要等
 * 好幾分鐘（摘要曾出現 42.9 秒的離群值）。要比較多個候選模型時，需要一支只打單一 agent、
 * 樣本數可調的工具。這個需求已經出現兩次——知識庫 agent 選模型時（見
 * `specs/003-analysis-trigger-policy/HANDOFF.md`）、以及 2026-08-28 情緒 agent 逾時時。
 *
 * ⚠️ **延遲的最慢值比中位數重要。** 2026-08-28 實測：情緒 agent 中位數 10.2 秒但門檻是
 *    15 秒，而摘要 agent 中位數 8.25 秒、最慢 42.9 秒——逾時是被尖峰打死的，不是被中位數。
 *    因此預設樣本數比 15 號的 3 次高，單看三個點看不出尾巴。
 *
 * ⚠️ **快而錯比慢而對更危險。** 延遲降下來但標籤全錯是更糟的結果，而且不報錯。
 *    因此本腳本一律印出 labels 序列供人工判讀，不只印延遲。
 *
 * 用法：
 *   npm run spike:agent-latency                        # 預設情緒 agent，5 次
 *   npm run spike:agent-latency -- sentiment 8         # 情緒 agent，8 次
 *   npm run spike:agent-latency -- summary 5           # 摘要 agent
 */

import { z } from 'zod'
import { makeClient, loadEnv, isMain, OUT_DIR } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const AGENTS = {
  sentiment: {
    name: 'AgentCopilot_情緒評分_agent',
    /** 與 15 號同一組輸入，數字才可跨腳本比較 */
    prompt: '請針對以下客戶發言，依序給出情緒判斷（陣列長度需與發言則數一致，共 5 則）：\n\n'
      + '1. 你好，我想問一下網路的問題\n'
      + '2. 網路好像有點不穩定\n'
      + '3. 已經重開機三次了都沒解決\n'
      + '4. 到底要修到什麼時候，已經影響到我上班了\n'
      + '5. 好，那我再等等看',
    /** 情緒漸次升溫再趨緩——標籤序列應該跟著爬升再回落 */
    check: (v: unknown) => {
      const schema = z.array(z.object({
        score: z.number().min(0).max(100),
        label: z.enum(['calm', 'neutral', 'concerned', 'frustrated', 'angry']),
        drivers: z.array(z.string()),
      })).length(5)
      const r = schema.safeParse(v)
      if (!r.success) {
        return { ok: false as const, note: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
      }
      // ⚠️ drivers 是從客戶原話摘出的中文關鍵詞，會直接顯示在 UI 上，
      //    而 schema 只驗「是不是字串陣列」——內容品質只有人看得出來。
      //    換非中文為主的模型時，這一欄比 label 更容易悄悄劣化（2026-08-28）。
      return {
        ok: true as const,
        note: r.data.map(d => `${d.label}(${d.score}) ${JSON.stringify(d.drivers)}`).join('  '),
      }
    },
  },
  summary: {
    name: 'AgentCopilot_摘要_agent',
    prompt: '請摘要以下客服對話：\n\n'
      + '[客戶] 網路斷了\n'
      + '[AI] 請協助確認數據機燈號是否正常，並嘗試斷電重啟。\n'
      + '[客戶] 網路斷了，已經第五次跟你們反應了，到底要修到什麼時候？',
    check: (v: unknown) => {
      const schema = z.object({
        intent: z.string().min(1),
        keyFacts: z.array(z.string()),
        attempted: z.array(z.string()),
        openIssues: z.array(z.string()),
        riskFlags: z.array(z.string()),
        advice: z.string().min(1),
      })
      const r = schema.safeParse(v)
      return r.success
        ? { ok: true as const, note: `intent=「${r.data.intent}」riskFlags=${JSON.stringify(r.data.riskFlags)}` }
        : { ok: false as const, note: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
    },
  },
} as const

type AgentKey = keyof typeof AGENTS

/**
 * ⚠️ **`model_id` 一律由 API 讀取，MUST NOT 靠人工記錄。**
 *    2026-08-28 的實例：換模型後靠口頭記錄歸因，事後無法確定某一筆量測到底量的是哪個
 *    模型，整組比較結果因此作廢重測。`listAiAgents()` 的每個 agent 都帶 `model_id`
 *    （例：`openai.gpt-oss-20b-1:0`），欄位 `model` 則是用途分類（例：`rag`），不是模型。
 */
async function findAgent(
  client: ImbraceClient,
  name: string,
): Promise<{ id: string, modelId: string } | null> {
  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>
  const hit = raw.find(a => String(a.name) === name)
  if (!hit) return null
  const id = String(hit.id ?? hit._id ?? '')
  return id ? { id, modelId: String(hit.model_id ?? '(未提供)') } : null
}

/**
 * 模型常在合法 JSON 前後多吐開場白／結語（2026-08-28 實測：gemma-3-27b 每一次都會）。
 * 正式路徑用 `extractLeadingJson()` 容忍它，這裡比照，否則量到的是「模型話多不多」
 * 而不是「輸出合不合規」。
 */
function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  try { return JSON.parse(cleaned) }
  catch { /* 往下試截斷 */ }
  const m = /position (\d+)/.exec((() => {
    try { JSON.parse(cleaned); return '' }
    catch (e) { return e instanceof Error ? e.message : String(e) }
  })())
  if (!m?.[1]) return null
  try { return JSON.parse(cleaned.slice(0, Number(m[1]))) }
  catch { return null }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}

async function main(): Promise<void> {
  loadEnv()
  const key = (process.argv[2]?.trim() || 'sentiment') as AgentKey
  const runs = Number(process.argv[3] ?? 5)

  const spec = AGENTS[key]
  if (!spec) {
    console.error(`未知的 agent：${key}（可用：${Object.keys(AGENTS).join(', ')}）`)
    process.exit(1)
  }

  const client = makeClient()
  const agent = await findAgent(client, spec.name)
  if (!agent) {
    console.error(`找不到 agent：${spec.name}`)
    process.exit(1)
  }
  const agentId = agent.id

  console.log(`\n── 18 Agent 延遲與合規量測 ──────────────────────────────`)
  console.log(`   agent：${spec.name}（${agentId}）`)
  console.log(`   模型：${agent.modelId}   ← 由 API 讀取，不是人工記錄`)
  console.log(`   樣本：${runs} 次\n`)

  const results: Array<{ run: number, ms: number, ok: boolean, note: string }> = []

  for (let run = 1; run <= runs; run++) {
    const t0 = Date.now()
    let text = ''
    let failed = ''
    try {
      const res = await client.aiAgent.streamChat({
        assistant_id: agentId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: spec.prompt }] }],
      } as Parameters<typeof client.aiAgent.streamChat>[0])
      const raw = await res.text()
      text = raw.split('\n')
        .filter(l => l.startsWith('data:'))
        .map((l) => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
        .filter(Boolean)
        .filter((e: any) => e.type === 'text-delta')
        .map((e: any) => String(e.delta ?? '')).join('')
    }
    catch (e) {
      failed = e instanceof Error ? e.message : String(e)
    }
    const ms = Date.now() - t0

    if (failed) {
      console.log(`   第 ${run} 次（${ms}ms）💥 呼叫失敗：${failed}`)
      results.push({ run, ms, ok: false, note: `呼叫失敗：${failed}` })
      continue
    }

    const parsed = extractJson(text)
    if (parsed === null) {
      console.log(`   第 ${run} 次（${ms}ms）❌ 取不出 JSON`)
      results.push({ run, ms, ok: false, note: '取不出 JSON' })
      continue
    }

    const verdict = spec.check(parsed)
    console.log(`   第 ${run} 次（${ms}ms）${verdict.ok ? '✅' : '❌'} ${verdict.note}`)
    results.push({ run, ms, ok: verdict.ok, note: verdict.note })
  }

  const ok = results.filter(r => r.ok).length
  const sorted = results.map(r => r.ms).sort((a, b) => a - b)

  console.log(`\n── 結果 ──────────────────────────────────────────────────`)
  console.log(`   合規      ${ok}/${runs}`)
  console.log(`   最快      ${sorted[0]}ms`)
  console.log(`   中位數    ${percentile(sorted, 0.5)}ms`)
  console.log(`   最慢      ${sorted[sorted.length - 1]}ms   ← 逾時是被這個數字打死的`)
  console.log(`   15 秒門檻 ${results.filter(r => r.ms > 15_000).length}/${runs} 次超過（FR-014 單次逾時）`)

  // 檔名帶模型，換模型重跑不會互相覆寫，也不必靠人記哪個檔是哪個模型
  const slug = agent.modelId.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  const file = resolve(OUT_DIR, `18-agent-latency-${key}-${slug}.json`)
  writeFileSync(
    file,
    JSON.stringify({ agent: spec.name, modelId: agent.modelId, runs, results }, null, 2),
    'utf8',
  )
  console.log(`\n   📁 ${file}\n`)
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('\n💥', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
