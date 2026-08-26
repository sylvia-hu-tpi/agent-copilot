/**
 * 10 — AI Agent 逐一重測，依 provider 分組
 *
 * 為何要重測：09 發現 27 個 agent 分屬 5 種 provider 設定，其中
 *   provider_id="system"（org 預設 LLM）有 5 個 —— 這條路徑先前沒有單獨確認過。
 * 若任何一個 agent 跑得動，「AI 層完全不可用」就要改寫成
 *   「只有某條路徑可用」，整個架構結論會不同。
 *
 * 順便驗證 0-3d：agent 設定裡有 response_format 欄位，
 * 也就是說平台可能支援結構化輸出 —— 這是憲法 4.2的前提。
 *
 * ⚠️ 唯讀：streamChat 只送一個 ping，不寫任何資料。
 */

import { runProbe, isMain, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

interface AgentRow {
  id: string
  name: string
  provider_id: string
  model_id: string
  response_format: unknown
  hasKnowledge: boolean
}

async function ping(client: ImbraceClient, a: AgentRow): Promise<{ ok: boolean; detail: string }> {
  const res = await client.aiAgent.streamChat({
    assistant_id: a.id,
    messages: [{ role: 'user', parts: [{ type: 'text', text: '你好，請回覆「OK」兩個字。' }] }],
  } as Parameters<typeof client.aiAgent.streamChat>[0])

  const text = await res.text()
  const err = text.match(/"errorText":"([^"]+)"/)
  if (err) return { ok: false, detail: err[1]!.replace(/\s+/g, ' ').slice(0, 110) }

  const deltas = [...text.matchAll(/"delta":"([^"]*)"/g)].map(m => m[1]).join('')
  if (deltas.trim()) return { ok: true, detail: deltas.slice(0, 80) }
  return { ok: false, detail: `無 errorText 也無文字輸出：${text.replace(/\s+/g, ' ').slice(0, 110)}` }
}

export const probe10 = () => runProbe('10', 'AI Agent 逐一重測（依 provider 分組）', async (p, client) => {
  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>
  const agents: AgentRow[] = raw.map(a => ({
    id: String(a.id ?? a._id ?? ''),
    name: String(a.name ?? '(無名)'),
    provider_id: String(a.provider_id ?? '(未設定)'),
    model_id: String(a.model_id ?? '(未設定)'),
    response_format: a.response_format,
    hasKnowledge: !!((a.board_ids as unknown[])?.length || (a.folder_ids as unknown[])?.length
      || (a.knowledge_hubs as unknown[])?.length),
  })).filter(a => a.id)

  console.log(`\n  共 ${agents.length} 個 agent\n`)

  // response_format 的實際值 —— 0-3d 結構化輸出
  const rfDist = agents.reduce<Record<string, number>>((acc, a) => {
    const k = JSON.stringify(a.response_format) ?? 'undefined'
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})
  console.log(`  response_format 值域：${JSON.stringify(rfDist)}\n`)

  // 依 provider 分組，每組全測（組小）
  const byProvider = new Map<string, AgentRow[]>()
  for (const a of agents) {
    const k = `${a.provider_id} / ${a.model_id}`
    if (!byProvider.has(k)) byProvider.set(k, [])
    byProvider.get(k)!.push(a)
  }

  const results: Array<{ group: string; agent: string; ok: boolean; detail: string; knowledge: boolean }> = []

  for (const [group, list] of byProvider) {
    console.log(`  ── ${group}（${list.length} 個）`)
    for (const a of list) {
      let r: { ok: boolean; detail: string }
      try {
        r = await ping(client, a)
      } catch (e) {
        r = { ok: false, detail: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 110) }
      }
      console.log(`     ${r.ok ? '✅' : '❌'} ${a.name.padEnd(28)} ${a.hasKnowledge ? '[知識庫]' : '        '} ${r.detail}`)
      results.push({ group, agent: a.name, ok: r.ok, detail: r.detail, knowledge: a.hasKnowledge })
    }
  }

  const okCount = results.filter(r => r.ok).length
  const okWithKnowledge = results.filter(r => r.ok && r.knowledge)

  // 錯誤形態歸類
  const errKinds = results.filter(r => !r.ok).reduce<Record<string, number>>((acc, r) => {
    const k = /ByteString/.test(r.detail) ? '遮罩金鑰被當真值（平台 bug）'
      : /does not exist|do not have access/.test(r.detail) ? '模型未在 Bedrock 開通'
      : /missing model_id|provider_id configuration/.test(r.detail) ? 'agent 設定不完整'
      : /無 errorText/.test(r.detail) ? '無回應內容'
      : '其他'
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})

  console.log(`\n  可用 ${okCount}/${agents.length}`)
  console.log(`  錯誤形態：${JSON.stringify(errKinds)}`)

  p.fixture('agent-retest', { rfDist, results, errKinds }, true)

  p.record({
    question: '0-1', claim: '27 個 AI Agent 中是否有任何一個能實際完成推論',
    verdict: okCount > 0 ? 'partial' : 'no',
    evidence: `逐一送出 ping，可用 ${okCount}/${agents.length}；`
      + `錯誤形態分佈：${JSON.stringify(errKinds)}；`
      + `provider 分組 ${byProvider.size} 組（含 provider_id="system"）`,
    impact: okCount > 0
      ? `⭐ 結論要改寫：有 ${okCount} 個 agent 可用`
        + `（其中 ${okWithKnowledge.length} 個掛了知識庫）→ `
        + `「純 iMBrace」方案重新成立，重點改為確認引用來源與結構化輸出。`
      : '確認：三種 provider 設定（兩個自訂 Bedrock + system 預設）全數不可用，'
        + '且錯誤形態指向 iMBrace 端的設定／部署問題，非我方可解。',
  })

  p.record({
    question: '0-3d', claim: 'agent 是否支援結構化輸出（response_format）',
    verdict: Object.keys(rfDist).some(k => k !== 'undefined' && k !== 'null') ? 'partial' : 'unknown',
    evidence: `27 個 agent 的 response_format 值域：${JSON.stringify(rfDist)}`,
    impact: '欄位存在代表平台預留了結構化輸出的位置。'
      + '需向 iMBrace 確認可接受的值（json_object？json_schema？）與是否真的生效 —— '
      + '這決定憲法 4.2「AI 輸出必須經 Zod 驗證」能否用平台原生能力滿足，'
      + '而不是靠 prompt 拜託模型輸出 JSON 再自行重試。',
  })
})

if (isMain(import.meta.url)) {
  probe10().then((f: Finding[]) => process.exit(0))
}
