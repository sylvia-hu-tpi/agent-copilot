/**
 * 09 — 08 掃描的追擊
 *
 * 08 掃出四條需要立刻追下去的線索：
 *   ① documentAi.process 回了 {success:true, job_id, status:"pending"}
 *      → /v3/ai/document/ 這條路由「收單了」。若 job 真的跑完，
 *        代表平台其實有一條可用的 LLM/VLM 推論通道，「AI 層全不可用」的結論要改寫。
 *   ② ai.listAiAgents() 回 0 筆，但 documentAi.listAgents() 回 27 筆
 *      → 兩條路徑取到的東西不同，要確認哪一條才看得到 agent 的檢索設定。
 *   ③ Conversation 有 mode / is_agent_joined 欄位（型別定義中沒有）
 *      → mode="automation" 極可能就是 H-1「單一對話的 AI 開關」。
 *   ④ file 訊息的 content 是 {name, media_id}，沒有 url
 *      → 附件內容目前根本取不到。SDK 全域搜尋 media 無任何端點。
 */

import { runProbe, env, isMain, businessUnitId, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

function transportOf(client: ImbraceClient) {
  return (client.messages as unknown as {
    http: { getFetch(): typeof fetch }
    base: string
  })
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 150)
}

function unwrap(r: unknown): unknown[] {
  if (Array.isArray(r)) return r
  const o = r as Record<string, unknown>
  for (const k of ['data', 'items', 'results', 'hits']) {
    if (Array.isArray(o?.[k])) return o[k] as unknown[]
  }
  return []
}

export const probe09 = () => runProbe('09', '08 掃描的追擊', async (p, client) => {
  const bu = await businessUnitId(client)
  const orgId = env('IMBRACE_ORGANIZATION_ID')
  const t = transportOf(client)
  /** gateway 根 —— t.base 形如 https://.../channel-service */
  const gw = t.base.replace(/\/[^/]+$/, '')
  const log = (s: string) => console.log(s)

  // ══ ① documentAi job 是否真的會跑完 ══════════════════════
  log('\n── ① /v3/ai/document/ 這條推論通道是否真的能跑 ──')
  try {
    const job = await client.documentAi.process({
      url: 'https://example.com/nonexistent.pdf',
      organizationId: orgId,
      modelName: 'gpt-4o',
    }) as unknown as Record<string, unknown>
    log(`  送單回應：${JSON.stringify(job).slice(0, 200)}`)
    const jobId = String(job.job_id ?? '')

    // 找 job 狀態端點
    const candidates = [
      `${gw}/ai/v3/document/${jobId}`,
      `${gw}/ai/v3/document/status/${jobId}`,
      `${gw}/ai/v3/document/job/${jobId}`,
      `${gw}/ai/v3/jobs/${jobId}`,
    ]
    for (const url of candidates) {
      try {
        const r = await t.http.getFetch()(url, { method: 'GET' })
        const body = (await r.text()).slice(0, 200)
        log(`  GET ${url.replace(gw, '')} → ${r.status} ${body}`)
        if (r.ok) p.fixture('doc-job-status', { url, status: r.status, body }, true)
      } catch (e) {
        log(`  GET ${url.replace(gw, '')} → ${errText(e)}`)
      }
    }

    p.record({
      question: '0-2b', claim: '/v3/ai/document/（Document AI）是否為一條可用的推論通道',
      verdict: 'partial',
      evidence: `POST 回 ${JSON.stringify(job).slice(0, 120)} —— 路由存在且會收單（非 404），`
        + `但 SDK 未提供 job 狀態查詢端點，無法確認實際是否跑完。`,
      impact: '⭐ 這推翻了「AI 層完全沒有路由」的說法：/v3/ai/document/ 是活的。'
        + '必須向 iMBrace 確認：(a) job 結果怎麼取回？(b) 它用的是哪個 provider —— '
        + '若與壞掉的兩個 Bedrock provider 相同，則同樣跑不出結果；'
        + '(c) 能否被當成通用 VLM/LLM 來用（例如丟對話文字要它回 JSON），還是只吃文件。',
    })
  } catch (e) {
    log(`  ⚠️ ${errText(e)}`)
  }

  // ══ ② agent 清單的兩條路徑 ══════════════════════════════
  log('\n── ② agent 清單：哪條路徑看得到檢索設定 ──────────')
  const agentPaths: Array<[string, () => Promise<unknown>]> = [
    ['ai.listAiAgents', () => client.ai.listAiAgents()],
    ['ai.listAgents', () => client.ai.listAgents()],
    ['ai.listAiAgentsV2', () => client.ai.listAiAgentsV2()],
    ['chatAi.listAiAgents', () => client.chatAi.listAiAgents()],
    ['documentAi.listAgents', () => client.documentAi.listAgents()],
  ]
  let bestAgents: Array<Record<string, unknown>> = []
  for (const [name, call] of agentPaths) {
    try {
      const r = await call()
      const rows = (Array.isArray(r) ? r : unwrap(r)) as Array<Record<string, unknown>>
      log(`  ${rows.length ? '✅' : '⚪'} ${name.padEnd(24)} ${rows.length} 筆`)
      if (rows.length > bestAgents.length) bestAgents = rows
    } catch (e) {
      log(`  ❌ ${name.padEnd(24)} ${errText(e).slice(0, 70)}`)
    }
  }

  if (bestAgents.length) {
    const keys = new Set<string>()
    for (const a of bestAgents) for (const k of Object.keys(a)) keys.add(k)
    log(`  agent 欄位聯集（${keys.size} 個）：${[...keys].sort().join(', ')}`)

    const retrievalKeys = [...keys].filter(k => /top_k|board_id|folder|knowledge|rag|file|guardrail|instruction|core_task|temperature/i.test(k))
    log(`  ⭐ 檢索／設定相關欄位：${retrievalKeys.join(', ')}`)

    const withKnowledge = bestAgents.filter(a =>
      (a.board_ids as unknown[])?.length || (a.folder_ids as unknown[])?.length
      || (a.knowledge_hubs as unknown[])?.length || a.selected_board_id)

    const detail = withKnowledge.slice(0, 6).map(a => ({
      name: a.name,
      provider_id: a.provider_id, model_id: a.model_id,
      board_ids: (a.board_ids as unknown[])?.length ?? 0,
      folder_ids: (a.folder_ids as unknown[])?.length ?? 0,
      knowledge_hubs: (a.knowledge_hubs as unknown[])?.length ?? 0,
      top_k: a.top_k, top_k_relevant_results: a.top_k_relevant_results,
      guardrail_id: a.guardrail_id ? '有' : '無',
    }))
    for (const d of detail) log(`    ${JSON.stringify(d)}`)

    const providerDist = bestAgents.reduce<Record<string, number>>((acc, a) => {
      const k = String(a.provider_id ?? '(未設定)')
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {})
    log(`  provider_id 分佈：${JSON.stringify(providerDist)}`)

    p.fixture('agents', { total: bestAgents.length, keys: [...keys].sort(), withKnowledge: detail, providerDist }, true)
    p.record({
      question: '0-3f', claim: 'agent 設定是否暴露「檢索筆數」等內部檢索參數',
      verdict: retrievalKeys.some(k => /top_k/i.test(k)) ? 'yes' : 'partial',
      evidence: `${bestAgents.length} 個 agent；掛知識庫者 ${withKnowledge.length} 個；`
        + `檢索相關欄位：${retrievalKeys.join(', ') || '無'}`,
      impact: '若 agent 設定裡有 top_k / top_k_relevant_results，代表平台內部確實做了'
        + '「取前 K 筆相關結果」—— 帶分數的檢索是存在的，只是沒有對外端點。'
        + '會議上的提問應改為「能否把這層開放出來（或在回應中附上引用）」，'
        + '而不是「有沒有這個能力」。',
    })
  }

  // ══ ③ Conversation.mode —— H-1 的候選開關 ═══════════════
  log('\n── ③ Conversation.mode：AI 開關的候選 ────────────')
  try {
    const res = await client.conversations.search({ businessUnitId: bu, q: '', limit: 100 })
    const rows = unwrap(res) as Array<Record<string, unknown>>
    const modeDist = rows.reduce<Record<string, number>>((a, r) => {
      const k = String(r.mode ?? '(未設定)'); a[k] = (a[k] ?? 0) + 1; return a
    }, {})
    const joinedDist = rows.reduce<Record<string, number>>((a, r) => {
      const k = String(r.is_agent_joined ?? '(未設定)'); a[k] = (a[k] ?? 0) + 1; return a
    }, {})
    log(`  mode 值域：${JSON.stringify(modeDist)}`)
    log(`  is_agent_joined 值域：${JSON.stringify(joinedDist)}`)

    // 交叉比對：mode 與 is_agent_joined 的關係
    const cross = rows.map(r => `${r.mode ?? '-'}/${r.is_agent_joined ?? '-'}`)
      .reduce<Record<string, number>>((a, k) => { a[k] = (a[k] ?? 0) + 1; return a }, {})
    log(`  mode/is_agent_joined 交叉：${JSON.stringify(cross)}`)

    // 單筆詳情是否有更多欄位
    const one = rows[0]
    if (one?.id) {
      const full = await client.conversations.getByConversationId(String(one.id)) as unknown as Record<string, unknown>
      const listKeys = new Set(Object.keys(one))
      const extra = Object.keys(full).filter(k => !listKeys.has(k))
      log(`  getByConversationId 額外欄位：${extra.join(', ') || '（無）'}`)
      log(`  詳情 users[]：${JSON.stringify(full.users)?.slice(0, 120)}`)
      p.fixture('conversation-detail', full)
    }

    p.fixture('conversation-mode', { modeDist, joinedDist, cross }, true)
    p.record({
      question: 'H-1b', claim: 'Conversation 上是否有可切換 AI 自動回覆的狀態欄位',
      verdict: Object.keys(modeDist).length > 1 ? 'yes' : 'partial',
      evidence: `mode 值域=${JSON.stringify(modeDist)}；is_agent_joined=${JSON.stringify(joinedDist)}；`
        + `（兩者皆不在 SDK 的 Conversation 型別定義中）`,
      impact: '⭐ mode 很可能就是 H-1 要的開關。但 SDK 的 conversations.updateStatus() 只收 status，'
        + '沒有 updateMode()。需向 iMBrace 確認：mode 的完整值域、'
        + '以及有沒有 API 可以改它（改不了的話，「切換全真人模式」就只能靠關掉整個 channel automation）。',
    })
  } catch (e) {
    log(`  ⚠️ ${errText(e)}`)
  }

  // ══ ④ 附件內容取得：media_id 有沒有解法 ═════════════════
  log('\n── ④ 附件（media_id）能不能取到內容 ──────────────')
  const mediaId = '627819648955711817' // 08 掃到的實際 LINE media id
  const mediaTries = [
    `${t.base}/v1/media/${mediaId}`,
    `${t.base}/v1/conversation_messages/media/${mediaId}`,
    `${gw}/files/v1/media/${mediaId}`,
    `${gw}/v1/backend/media/${mediaId}`,
  ]
  let mediaOk = false
  for (const url of mediaTries) {
    try {
      const r = await t.http.getFetch()(url, { method: 'GET' })
      log(`  GET ${url.replace(gw, '')} → ${r.status} ${r.headers.get('content-type') ?? ''}`)
      if (r.ok) mediaOk = true
    } catch (e) {
      log(`  GET ${url.replace(gw, '')} → ${errText(e).slice(0, 60)}`)
    }
  }
  p.record({
    question: 'H-2e', claim: '附件（type=file）的實際內容能否透過 API 取得',
    verdict: mediaOk ? 'partial' : 'no',
    evidence: `file 訊息的 content 是 {name, media_id}，沒有 url；`
      + `SDK 全域搜尋「media」無任何端點；試打 ${mediaTries.length} 條猜測路徑`
      + `${mediaOk ? '有一條可用' : '全部失敗'}`,
    impact: mediaOk ? '有路徑可取檔，需確認正式端點名稱。'
      : '❗ 這是新的阻塞點：附件內容目前完全取不到 —— '
        + '不只是「平台沒幫我們做 OCR」，而是連原始檔案都拿不到，我方自建 vision/STT 也無米可炊。'
        + '必須向 iMBrace 索取 media_id → 檔案內容的端點。',
  })

  // ══ ⑤ 知識庫 chunk 是否可見 ═════════════════════════════
  log('\n── ⑤ RAG 檔案的 chunk 是否可見（引用粒度）────────')
  try {
    const files = await client.ai.listRagFiles()
    const rows = unwrap(files) as Array<Record<string, unknown>>
    log(`  RAG 檔案 ${rows.length} 筆`)
    if (rows[0]) {
      log(`  欄位：${Object.keys(rows[0]).join(', ')}`)
      const fid = String(rows[0]._id ?? rows[0].id ?? '')
      for (const [name, call] of [
        ['ai.getRagFile', () => client.ai.getRagFile(fid)],
        ['aiAgent.getEmbeddingFile', () => client.aiAgent.getEmbeddingFile(fid)],
        ['aiAgent.previewEmbeddingFile', () => client.aiAgent.previewEmbeddingFile({ file_id: fid })],
      ] as Array<[string, () => Promise<unknown>]>) {
        try {
          const r = await call()
          const s = JSON.stringify(r)
          const hasChunks = /chunk|segment|passage|content/i.test(s)
          log(`  ✅ ${name.padEnd(28)} ${s.length} bytes，含 chunk 字樣：${hasChunks ? '✅' : '❌'}`)
          p.fixture(`rag-${name.replace(/\W/g, '-')}`, r)
        } catch (e) {
          log(`  ❌ ${name.padEnd(28)} ${errText(e).slice(0, 70)}`)
        }
      }
    }
  } catch (e) {
    log(`  ⚠️ ${errText(e)}`)
  }

  // ══ ⑥ Data Board 欄位型別（08 解包錯誤，重測）═══════════
  log('\n── ⑥ Data Board 欄位型別 ─────────────────────────')
  try {
    const boards = await client.boards.list()
    const list = (boards?.data ?? []) as unknown as Array<Record<string, unknown>>
    const typeDist: Record<string, number> = {}
    let uniqueSeen = 0
    let inspected = 0
    for (const b of list.slice(0, 5)) {
      const id = String(b.id ?? b._id ?? '')
      if (!id) continue
      const full = await client.boards.get(id) as unknown as Record<string, unknown>
      const inner = (full.data ?? full) as Record<string, unknown>
      const fields = (inner.fields ?? []) as Array<Record<string, unknown>>
      inspected++
      for (const f of fields) {
        const ty = String(f.type ?? '?')
        typeDist[ty] = (typeDist[ty] ?? 0) + 1
        if (f.is_unique_identifier === true) uniqueSeen++
      }
    }
    log(`  掃 ${inspected} 個 board，欄位型別分佈：${JSON.stringify(typeDist)}`)
    log(`  is_unique_identifier=true 的欄位：${uniqueSeen} 個`)
    p.fixture('board-field-types', { inspected, typeDist, uniqueSeen }, true)
    p.record({
      question: 'D-1/D-2', claim: 'Data Board 實際使用的欄位型別與唯一鍵',
      verdict: Object.keys(typeDist).length ? 'yes' : 'unknown',
      evidence: `${inspected} 個 board：${JSON.stringify(typeDist)}；`
        + `唯一鍵欄位 ${uniqueSeen} 個`,
      impact: uniqueSeen > 0
        ? '✅ is_unique_identifier 有實際被使用 → 結案摘要可用 conversation_id 做冪等寫入。'
        : '🟡 現有 board 沒有任何欄位設 is_unique_identifier —— '
          + '冪等寫入只能「先 search 再 create/update」，並發下有競態，需在會議上決定可接受度。',
    })
  } catch (e) {
    log(`  ⚠️ ${errText(e)}`)
  }
})

if (isMain(import.meta.url)) {
  probe09().then((f: Finding[]) => process.exit(0))
}
