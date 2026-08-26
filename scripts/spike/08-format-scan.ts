/**
 * 08 — 資料格式與未探測端點掃描
 *
 * 為何還要再掃一次：06/07 掃的是「SDK 手寫 resource 的主要方法」，
 * 但 SDK 還有三塊完全沒碰過的表面，任何一塊可用都會改寫結論：
 *
 *   ① documentAi / chatAi.processDocument → POST /ai/v3/document/
 *      這是 VLM 路徑。若可用 = 平台其實有一條能跑的推論通道，
 *      而且順帶解決 H-2b（圖片 OCR／描述）。
 *   ② client.api.dataBoard.searchFiles / searchMultiBoard
 *      Knowledge Hub 檔案全文檢索 —— 04 只測了 searchFolders 與 listRagFiles，
 *      沒測「搜檔案內容」。這是「引用來源」的最後備案。
 *   ③ provider_id: "system"（org 預設 LLM）
 *      06/07 只測了兩個自訂 provider，兩個都壞。system 是第三個，沒測過。
 *
 * 另外補齊 UI 設計會議需要的資料格式盤點：
 *   Conversation / Contact / Message 的實際欄位聯集與值域分佈。
 *
 * ⚠️ 全部唯讀或無副作用（generateAiTags / processDocument 只做推論不寫資料）。
 */

import { runProbe, env, isMain, businessUnitId, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

// ── 工具 ────────────────────────────────────────────────────

/** 借用 SDK 內部 transport 打任意 URL，沿用其認證標頭 */
function transportOf(client: ImbraceClient) {
  return (client.messages as unknown as {
    http: { getFetch(): typeof fetch }
    base: string
  })
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160)
}

/** 把錯誤歸類成「端點不存在 / 無權限 / 參數錯（＝路由存在）/ 其他」 */
function classify(e: unknown): { icon: string; kind: string; msg: string } {
  const m = errText(e)
  if (/\b404\b|Not Found|Cannot (POST|GET)/i.test(m)) return { icon: '❌', kind: '端點不存在', msg: m }
  if (/\b401\b|Unauthorized|Auth failed/i.test(m)) return { icon: '🔒', kind: '無權限', msg: m }
  if (/\b(400|422)\b|Invalid|required|missing/i.test(m)) return { icon: '🟡', kind: '路由存在（參數不符）', msg: m }
  if (/\b5\d\d\b/.test(m)) return { icon: '💥', kind: '伺服器錯誤', msg: m }
  return { icon: '⚠️', kind: '其他', msg: m }
}

/** 欄位聯集 + 每個欄位的填充率與樣本值 */
function fieldProfile(rows: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r ?? {})) keys.add(k)
  return [...keys].sort().map((k) => {
    const vals = rows.map(r => r?.[k]).filter(v => v !== undefined && v !== null && v !== '')
    const fill = Math.round((vals.length / Math.max(rows.length, 1)) * 100)
    const t = typeof vals[0]
    const sample = Array.isArray(vals[0])
      ? `[${(vals[0] as unknown[]).length}]`
      : t === 'object' ? `{${Object.keys(vals[0] as object).slice(0, 4).join(',')}}`
      : String(vals[0] ?? '').slice(0, 40)
    return `${k} (${t}, 填充 ${fill}%) 例: ${sample}`
  })
}

/** 某欄位的值域分佈 */
function valueDist(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  return rows.reduce<Record<string, number>>((a, r) => {
    const v = String(r?.[key] ?? '(空)')
    a[v] = (a[v] ?? 0) + 1
    return a
  }, {})
}

function unwrap(r: unknown): unknown[] {
  if (Array.isArray(r)) return r
  const o = r as Record<string, unknown>
  for (const k of ['data', 'items', 'results', 'hits']) {
    if (Array.isArray(o?.[k])) return o[k] as unknown[]
  }
  if (Array.isArray((o?.message as Record<string, unknown>)?.hits)) {
    return ((o.message as Record<string, unknown>).hits) as unknown[]
  }
  return []
}

// ── 主體 ────────────────────────────────────────────────────

export const probe08 = () => runProbe('08', '資料格式與未探測端點掃描', async (p, client) => {
  const bu = await businessUnitId(client)
  const orgId = env('IMBRACE_ORGANIZATION_ID')
  const report: string[] = []
  const log = (s: string) => { console.log(s); report.push(s) }

  // ══ A. 未探測的 AI 推論路徑 ═══════════════════════════════
  log('\n── A. 未探測的 AI 推論路徑 ──────────────────────')

  const aiProbes: Array<[string, string, () => Promise<unknown>]> = [
    ['chatAi.listDocumentModels', 'GET /ai/v3/providers',
      () => client.chatAi.listDocumentModels()],
    ['documentAi.listAgents', 'GET /v3/ai/assistant_apps',
      () => client.documentAi.listAgents()],
    ['chatAi.processDocument ⭐', 'POST /ai/v3/document/（VLM 推論路徑）',
      () => client.chatAi.processDocument({
        modelName: 'gpt-4o',
        url: 'https://example.com/nonexistent.pdf',
        organizationId: orgId,
      })],
    ['documentAi.process ⭐', 'POST /v3/ai/document/',
      () => client.documentAi.process({
        url: 'https://example.com/nonexistent.pdf',
        organizationId: orgId,
        modelName: 'gpt-4o',
      })],
    ['boards.generateAiTags', 'POST /data-board/ai-tags（輕量推論）',
      () => client.boards.generateAiTags({ text: '客戶反映設備故障，情緒不佳' })],
    ['predict.predict', 'POST /predict/',
      () => client.predict.predict({ text: '測試' })],
    ['ai.listGuardrails', 'GET /v3/ai/guardrails',
      () => client.ai.listGuardrails()],
    ['ai.listGuardrailProviders', 'GET /v3/ai/guardrail-providers',
      () => client.ai.listGuardrailProviders()],
  ]

  const aiRows: string[] = []
  for (const [name, route, call] of aiProbes) {
    try {
      const r = await call()
      const n = unwrap(r).length
      const detail = n > 0 ? `${n} 筆` : JSON.stringify(r).slice(0, 90)
      log(`  ✅ ${name.padEnd(28)} ${detail}`)
      aiRows.push(`| \`${name}\` | ${route} | ✅ | ${detail.replace(/\|/g, '\\|')} |`)
    } catch (e) {
      const c = classify(e)
      log(`  ${c.icon} ${name.padEnd(28)} ${c.kind}：${c.msg.slice(0, 80)}`)
      aiRows.push(`| \`${name}\` | ${route} | ${c.icon} ${c.kind} | ${c.msg.slice(0, 80).replace(/\|/g, '\\|')} |`)
    }
  }
  p.fixture('A-ai-endpoints', aiRows, true)

  // ── A2. provider_id: "system" 是否存在且可用 ──────────────
  log('\n── A2. system provider（org 預設 LLM）────────────')
  try {
    const withSystem = await client.ai.listProviders({ includeSystem: true })
    const sys = withSystem.find(pr => pr.provider_id === 'system' || pr._id === null)
    const modelNames = (sys?.models ?? []).map(m => m.name)
    log(`  providers（含 system）：${withSystem.length} 個`)
    log(`  system entry：${sys ? '✅ 存在' : '❌ 不存在'}，模型 ${modelNames.length} 個`)
    if (modelNames.length) log(`    ${modelNames.slice(0, 10).join(', ')}`)
    p.fixture('A2-system-provider', { exists: !!sys, models: modelNames }, true)
    p.record({
      question: '0-1b', claim: 'org 預設（system）LLM provider 是否可用',
      verdict: modelNames.length > 0 ? 'partial' : 'no',
      evidence: sys
        ? `system entry 存在，可選模型 ${modelNames.length} 個：${modelNames.slice(0, 5).join(', ') || '（空）'}`
        : `listProviders({includeSystem:true}) 未回傳 system entry`,
      impact: modelNames.length > 0
        ? '⭐ 尚有第三條路：以 provider_id="system" 建 agent，可繞開兩個壞掉的自訂 provider。'
        : 'system provider 也沒有可用模型 —— 三個 provider 全滅，確認為組織層級的 AI 設定缺失。',
    })
  } catch (e) {
    log(`  ⚠️ ${errText(e)}`)
  }

  // ══ B. 知識檢索的未測路徑 ════════════════════════════════
  log('\n── B. 知識檢索的未測路徑 ────────────────────────')

  // B1. Knowledge Hub 檔案全文檢索（04 沒測過）
  try {
    const files = await client.api.dataBoard.searchFiles({ q: '流程', limit: 5 })
    const hits = unwrap(files)
    const sample = hits[0] as Record<string, unknown> | undefined
    const scoreKey = sample && Object.keys(sample).find(k => /score|rank/i.test(k))
    log(`  ✅ api.dataBoard.searchFiles  ${hits.length} 筆`)
    if (sample) log(`     欄位：${Object.keys(sample).slice(0, 14).join(', ')}`)
    log(`     分數欄位：${scoreKey ?? '❌ 無'}`)
    p.fixture('B1-searchFiles', hits)
    p.record({
      question: 'C-2c', claim: 'Knowledge Hub 檔案全文檢索（searchFiles）能否作為引用來源',
      verdict: hits.length > 0 ? (scoreKey ? 'yes' : 'partial') : 'no',
      evidence: `q="流程" 回 ${hits.length} 筆；分數欄位=${scoreKey ?? '無'}；`
        + `欄位=${sample ? Object.keys(sample).slice(0, 8).join(',') : '（無結果）'}`,
      impact: hits.length === 0
        ? '此端點查不到內容 → 不能作為引用來源。'
        : scoreKey
          ? '⭐ 有 ID 有分數 → 建議卡的「SOP 引用 + 信心度」可用此端點實作，方案 A 復活。'
          : '🟡 有 ID 無分數 → 可做 sopId 白名單（憲法 4.3可執行），但信心度需改由其他方式估算。'
            + '注意：這是「檔案層級」而非「chunk 層級」，引用粒度會粗到整份文件。',
    })
  } catch (e) {
    const c = classify(e)
    log(`  ${c.icon} api.dataBoard.searchFiles  ${c.kind}：${c.msg.slice(0, 90)}`)
    p.record({
      question: 'C-2c', claim: 'Knowledge Hub 檔案全文檢索（searchFiles）',
      verdict: 'no', evidence: `${c.kind}：${c.msg}`,
    })
  }

  // B2. 跨 board 檢索
  try {
    const boards = await client.boards.list()
    const ids = (boards?.data ?? []).slice(0, 3).map(b => (b as { id?: string; _id?: string }).id
      ?? (b as { _id?: string })._id).filter(Boolean) as string[]
    const multi = await client.api.dataBoard.searchMultiBoard({
      body: { queries: ids.map(id => ({ indexUid: id, q: '流程', limit: 3 })) },
    })
    log(`  ✅ api.dataBoard.searchMultiBoard  ${JSON.stringify(multi).slice(0, 120)}`)
    p.fixture('B2-searchMultiBoard', multi)
  } catch (e) {
    const c = classify(e)
    log(`  ${c.icon} api.dataBoard.searchMultiBoard  ${c.kind}：${c.msg.slice(0, 90)}`)
  }

  // B3. boards.search 帶 showRankingScore（SDK 未公開，走 raw）
  try {
    const boards = await client.boards.list()
    const b0 = (boards?.data ?? [])[0] as { id?: string; _id?: string } | undefined
    const boardId = env('SPIKE_BOARD_ID') || b0?.id || b0?._id
    if (!boardId) throw new Error('無可用 board')

    const t = transportOf(client)
    const dbBase = t.base.replace(/\/[^/]*$/, '') // 粗略推導；失敗時下方會回報
    const url = `${dbBase}/data-board/search/${boardId}`
    const r = await t.http.getFetch()(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '流程', limit: 3, showRankingScore: true }),
    })
    const body = await r.text()
    const hits = unwrap(JSON.parse(body || '{}')) as Array<Record<string, unknown>>
    const hasScore = hits.some(h => Object.keys(h).some(k => /rankingscore/i.test(k)))
    log(`  boards.search + showRankingScore → HTTP ${r.status}，${hits.length} 筆，`
      + `_rankingScore=${hasScore ? '✅ 有' : '❌ 無'}`)
    p.fixture('B3-ranking-score', { status: r.status, hasScore, sample: hits[0] ?? null })
    p.record({
      question: 'C-2d', claim: 'Meilisearch showRankingScore 是否被後端透傳',
      verdict: hasScore ? 'yes' : 'no',
      evidence: `HTTP ${r.status}，${hits.length} 筆，${hasScore ? '含 _rankingScore' : '無 _rankingScore 欄位'}`,
      impact: hasScore
        ? '⭐ 可取得相關度分數 → 建議卡的信心度有真實依據。'
        : '後端未透傳 showRankingScore → 信心度無法來自檢索分數。',
    })
  } catch (e) {
    log(`  ⚠️ showRankingScore 測試失敗：${errText(e)}`)
  }

  // ══ C. AI Agent 的檢索設定（0-3 的前提）══════════════════
  log('\n── C. AI Agent 的知識庫與檢索設定 ───────────────')
  try {
    const agents = (await client.ai.listAiAgents()).data ?? []
    const withKnowledge = agents.filter(a =>
      (a.board_ids?.length ?? 0) > 0 || (a.folder_ids?.length ?? 0) > 0
      || (a.knowledge_hubs?.length ?? 0) > 0 || !!a.selected_board_id)

    log(`  agent 總數 ${agents.length}，掛知識庫者 ${withKnowledge.length}`)

    const detail = withKnowledge.slice(0, 5).map(a => ({
      name: a.name,
      provider_id: a.provider_id,
      model_id: a.model_id,
      board_ids: a.board_ids?.length ?? 0,
      folder_ids: a.folder_ids?.length ?? 0,
      knowledge_hubs: a.knowledge_hubs?.length ?? 0,
      top_k: a.top_k,
      top_k_relevant_results: a.top_k_relevant_results,
      guardrail_id: a.guardrail_id ? '有' : '無',
      temperature: a.temperature,
      streaming: a.streaming,
    }))
    for (const d of detail) log(`    ${JSON.stringify(d)}`)

    const hasTopK = withKnowledge.some(a =>
      a.top_k != null || a.top_k_relevant_results != null)

    p.fixture('C-agents-with-knowledge', detail, true)
    p.record({
      question: '0-3f', claim: 'agent 設定中是否存在「檢索筆數」參數（暗示平台內部有排序檢索）',
      verdict: hasTopK ? 'yes' : 'partial',
      evidence: `${withKnowledge.length}/${agents.length} 個 agent 掛了知識庫；`
        + `top_k / top_k_relevant_results 欄位${hasTopK ? '有實際值' : '存在於型別但未設定'}`,
      impact: '⭐ 這是向 iMBrace 提問的有力論據：平台內部一定做了「取前 K 筆相關結果」，'
        + '代表帶分數的檢索是存在的，只是沒有對外端點。'
        + '問題應改為「能否把這層開放出來」，而非「有沒有這個能力」。',
    })

    // provider_id 的分佈 —— 看有沒有 agent 用 system
    const provDist = valueDist(agents as unknown as Array<Record<string, unknown>>, 'provider_id')
    log(`  provider_id 分佈：${JSON.stringify(provDist)}`)
    p.fixture('C-provider-dist', provDist, true)
  } catch (e) {
    log(`  ⚠️ ${errText(e)}`)
  }

  // ══ D. 資料格式盤點（UI 設計會議用）══════════════════════
  log('\n── D. 資料格式盤點 ──────────────────────────────')

  // D1. Conversation
  try {
    const res = await client.conversations.search({ businessUnitId: bu, q: '', limit: 100 })
    const rows = unwrap(res) as Array<Record<string, unknown>>
    log(`  Conversation ${rows.length} 筆`)
    for (const line of fieldProfile(rows)) log(`    ${line}`)
    log(`    status 值域：${JSON.stringify(valueDist(rows, 'status'))}`)
    log(`    channel_type 值域：${JSON.stringify(valueDist(rows, 'channel_type'))}`)
    const withUsers = rows.filter(r => Array.isArray(r.users) && (r.users as unknown[]).length > 0)
    log(`    users[] 非空：${withUsers.length}/${rows.length} 筆`)
    p.fixture('D1-conversation-shape', {
      count: rows.length,
      fields: fieldProfile(rows),
      status: valueDist(rows, 'status'),
      channelType: valueDist(rows, 'channel_type'),
      usersNonEmpty: `${withUsers.length}/${rows.length}`,
    }, true)
    p.record({
      question: 'UI-1', claim: '對話列表（左欄）實際可用的欄位與值域',
      verdict: 'yes',
      evidence: `${rows.length} 筆；status=${Object.keys(valueDist(rows, 'status')).join('/')}；`
        + `channel_type=${Object.keys(valueDist(rows, 'channel_type')).join('/')}；`
        + `users[] 非空 ${withUsers.length}/${rows.length}`,
      impact: 'UI 左欄能顯示什麼由此決定。若無「未讀數／最後訊息摘要／標籤／等待時長」欄位，'
        + '這些都得由我方自行計算或改設計。',
    })
  } catch (e) {
    log(`  ⚠️ Conversation：${errText(e)}`)
  }

  // D2. Contact
  try {
    const res = await (client.contacts as unknown as { list(p?: unknown): Promise<unknown> })
      .list({ limit: 50 })
    const rows = unwrap(res) as Array<Record<string, unknown>>
    log(`  Contact ${rows.length} 筆`)
    for (const line of fieldProfile(rows)) log(`    ${line}`)
    p.fixture('D2-contact-shape', { count: rows.length, fields: fieldProfile(rows) }, true)
    p.record({
      question: 'UI-2', claim: '客戶資料卡（右欄）實際可用的欄位',
      verdict: 'yes',
      evidence: `${rows.length} 筆，欄位聯集 ${fieldProfile(rows).length} 個`,
      impact: '右欄「客戶資訊」區塊能顯示什麼由此決定。',
    })
  } catch (e) {
    log(`  ⚠️ Contact：${errText(e)}`)
  }

  // D3. 訊息型別分佈（跨多個對話）
  try {
    const convRes = await client.conversations.search({ businessUnitId: bu, q: '', limit: 30 })
    const convs = unwrap(convRes) as Array<{ id: string }>
    const t = transportOf(client)

    const typeDist: Record<string, number> = {}
    const fromPrefix: Record<string, number> = {}
    const samples: Array<Record<string, unknown>> = []
    let scanned = 0

    for (const c of convs.slice(0, 20)) {
      const url = new URL(`${t.base}/v1/conversation_messages`)
      url.searchParams.set('conversation_id', c.id)
      url.searchParams.set('limit', '100')
      const r = await t.http.getFetch()(url, { method: 'GET' })
      if (!r.ok) continue
      const msgs = unwrap(await r.json()) as Array<Record<string, unknown>>
      scanned += msgs.length
      for (const m of msgs) {
        const ty = String(m.type ?? '?')
        typeDist[ty] = (typeDist[ty] ?? 0) + 1
        const pre = String(m.from ?? '').split('_')[0] ?? '?'
        fromPrefix[pre] = (fromPrefix[pre] ?? 0) + 1
        if (ty !== 'text' && ty !== 'quick_reply' && samples.length < 8) samples.push(m)
      }
    }

    log(`  掃 ${convs.slice(0, 20).length} 個對話、${scanned} 則訊息`)
    log(`    type 分佈：${JSON.stringify(typeDist)}`)
    log(`    from 前綴分佈：${JSON.stringify(fromPrefix)}`)
    log(`    非文字訊息樣本：${samples.length} 則`)
    if (samples[0]) log(`    附件欄位：${JSON.stringify(samples[0])}`.slice(0, 300))
    p.fixture('D3-message-types', { scanned, typeDist, fromPrefix, samples })

    // 附件 URL 是否需授權／有時效
    const withUrl = samples.find(m => (m.content as { url?: string })?.url)
    if (withUrl) {
      const u = (withUrl.content as { url: string }).url
      const bare = await fetch(u, { method: 'HEAD' }).catch(() => null)
      log(`    附件 URL 無認證存取：HTTP ${bare?.status ?? '失敗'}`
        + `（content-type: ${bare?.headers.get('content-type') ?? '?'}）`)
      p.record({
        question: 'H-2d', claim: '附件 URL 是否可無認證直接存取',
        verdict: bare?.ok ? 'yes' : 'no',
        evidence: `HEAD ${u.slice(0, 60)}… → HTTP ${bare?.status ?? '失敗'}`,
        impact: bare?.ok
          ? '可直接把 URL 交給外部 vision/STT 服務 —— 但也代表 URL 外洩即等於資料外洩，需納入風險評估。'
          : '需帶認證標頭才能取檔 → 自建 STT/vision 必須由後端代理下載後再送出。',
      })
    }

    p.record({
      question: 'H-2', claim: '語音／圖片訊息在真實資料中的佔比與載體',
      verdict: Object.keys(typeDist).some(k => k !== 'text' && k !== 'quick_reply') ? 'partial' : 'no',
      evidence: `${scanned} 則訊息的型別分佈：${JSON.stringify(typeDist)}`,
      impact: Object.keys(typeDist).length <= 2
        ? '⚠️ 現有資料幾乎全為純文字 —— H-2 的工作量估算沒有真實樣本可依據，'
          + '必須向 iMBrace 索取含圖片／語音的測試對話，否則 M2 估點是猜的。'
        : '有非文字樣本，可據此確認平台是否已文字化（見 D3 fixture 的 samples 欄位）。',
    })
  } catch (e) {
    log(`  ⚠️ 訊息掃描：${errText(e)}`)
  }

  // D4. Data Board 欄位型別（D-1）
  try {
    const boards = await client.boards.list()
    const b0 = (boards?.data ?? [])[0] as { id?: string; _id?: string; name?: string } | undefined
    const boardId = b0?.id ?? b0?._id
    if (boardId) {
      const full = await client.boards.get(boardId) as unknown as Record<string, unknown>
      const fields = (full.fields ?? []) as Array<Record<string, unknown>>
      const typeDist = valueDist(fields, 'type')
      log(`  Board「${b0?.name}」欄位 ${fields.length} 個，型別：${JSON.stringify(typeDist)}`)
      log(`    board 本身欄位：${Object.keys(full).slice(0, 20).join(', ')}`)
      const uniqueFlag = fields.some(f => f.is_unique_identifier === true)
      p.fixture('D4-board-schema', { name: b0?.name, fieldTypes: typeDist, fields }, false)
      p.record({
        question: 'D-1/D-2', claim: 'Data Board 支援的欄位型別與唯一鍵',
        verdict: 'yes',
        evidence: `型別分佈=${JSON.stringify(typeDist)}；is_unique_identifier ${uniqueFlag ? '有被使用' : '未見使用'}`,
        impact: uniqueFlag
          ? '✅ 有唯一鍵機制 → 結案摘要可用 conversation_id 做冪等寫入。'
          : '🟡 現有 board 未使用 is_unique_identifier，需實測建立時帶此旗標是否生效；'
            + '否則冪等寫入只能靠「先 search 再決定 create/update」，並發下有競態。',
      })
    }
  } catch (e) {
    log(`  ⚠️ Board schema：${errText(e)}`)
  }

  // D5. Rate limit 標頭（G-2）
  try {
    const t = transportOf(client)
    const url = new URL(`${t.base}/v1/conversation_messages`)
    url.searchParams.set('conversation_id', env('SPIKE_CONVERSATION_ID'))
    url.searchParams.set('limit', '1')
    const r = await t.http.getFetch()(url, { method: 'GET' })
    const hdrs: Record<string, string> = {}
    r.headers.forEach((v, k) => {
      if (/ratelimit|retry-after|x-request|x-quota/i.test(k)) hdrs[k] = v
    })
    log(`  Rate limit 標頭：${Object.keys(hdrs).length ? JSON.stringify(hdrs) : '❌ 回應中無任何 rate limit 標頭'}`)
    p.record({
      question: 'G-2', claim: 'API 回應是否揭露 rate limit 資訊',
      verdict: Object.keys(hdrs).length ? 'yes' : 'no',
      evidence: Object.keys(hdrs).length ? JSON.stringify(hdrs) : '無 X-RateLimit-* / Retry-After 標頭',
      impact: Object.keys(hdrs).length
        ? '可據此自動調節輪詢頻率。'
        : '❗ 無法從回應自我調節 → 輪詢頻率只能靠對方口頭給的數字，'
          + '且撞到上限時我方無從預警。必須在會議上要求書面 rate limit 規格。',
    })
  } catch (e) {
    log(`  ⚠️ Rate limit：${errText(e)}`)
  }

  // ══ E. H-1 的線索：workflow / channel automation ═════════
  log('\n── E. AI 自動回覆的控制點（H-1）─────────────────')
  const wfProbes: Array<[string, () => Promise<unknown>]> = [
    ['workflows.listChannelAutomation', () => client.workflows.listChannelAutomation()],
    ['workflows.listFlows', () => client.workflows.listFlows({ limit: 10 })],
    ['api.channel.listChannelAutomationWorkflows',
      () => client.api.channel.listChannelAutomationWorkflows()],
  ]
  for (const [name, call] of wfProbes) {
    try {
      const r = await call()
      const n = unwrap(r).length
      log(`  ✅ ${name.padEnd(42)} ${n} 筆`)
      p.fixture(`E-${name.replace(/\W/g, '-')}`, r)
    } catch (e) {
      const c = classify(e)
      log(`  ${c.icon} ${name.padEnd(42)} ${c.kind}：${c.msg.slice(0, 70)}`)
    }
  }

  p.fixture('report', report, true)
})

if (isMain(import.meta.url)) {
  probe08().then((f: Finding[]) => process.exit(0))
}
