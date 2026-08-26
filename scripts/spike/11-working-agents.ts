/**
 * 11 — 可用 agent 的實際輸出契約
 *
 * 10 推翻了「27 個 agent 全部不可用」：實際有 11 個跑得動，其中 5 個掛了知識庫。
 * 於是先前判定「做不到」的三件事必須重測，因為它們決定能否只用 iMBrace：
 *
 *   0-3a/b  回答中有沒有引用來源？是結構化欄位還是只能靠 prompt 塞進文字？
 *   0-3c    有沒有相關度分數？（決定介面上的「信心度 92%」留不留）
 *   0-3d    能不能穩定回傳 JSON？（憲法 4.2：AI 輸出必須經 Zod 驗證）
 *   延遲     建議卡要等多久才出得來？（決定 UI 是否需要 skeleton／漸進顯示）
 *
 * ⚠️ 唯讀：只送問句，不寫任何資料。
 */

import { runProbe, isMain, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

/** 完整收下 SSE，保留所有事件型別 —— 引用來源若存在，很可能藏在非 text-delta 的事件裡 */
async function chat(client: ImbraceClient, assistantId: string, prompt: string) {
  const t0 = Date.now()
  const res = await client.aiAgent.streamChat({
    assistant_id: assistantId,
    messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
  } as Parameters<typeof client.aiAgent.streamChat>[0])
  const raw = await res.text()
  const ms = Date.now() - t0

  const events = raw.split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean) as Array<Record<string, unknown>>

  const eventTypes = [...new Set(events.map(e => String(e.type ?? '?')))]
  const text = events.filter(e => e.type === 'text-delta')
    .map(e => String(e.delta ?? '')).join('')

  return { raw, events, eventTypes, text, ms }
}

/** 引用來源可能出現的形式 —— 事件型別、事件欄位、或文字裡的檔名 */
function findCitationSignals(raw: string, events: Array<Record<string, unknown>>) {
  const eventLevel = events.filter(e =>
    /source|citation|reference|retriev|document|annotation|tool/i.test(String(e.type ?? '')))
  const fieldLevel = new Set<string>()
  const walk = (o: unknown, path = '') => {
    if (!o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/source|citation|reference|chunk|score|file_id|filename|url/i.test(k)) {
        fieldLevel.add(`${path}${k}`)
      }
      if (v && typeof v === 'object') walk(v, `${path}${k}.`)
    }
  }
  events.forEach(e => walk(e))
  const textLevel = [...raw.matchAll(/[\w一-鿿-]+\.(pdf|docx?|xlsx?|txt|md|pptx?)/gi)].map(m => m[0])
  return { eventLevel, fieldLevel: [...fieldLevel], textLevel: [...new Set(textLevel)] }
}

export const probe11 = () => runProbe('11', '可用 agent 的輸出契約', async (p, client) => {
  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>

  // 10 實測可用、且掛了知識庫的 agent
  const WORKING_WITH_KNOWLEDGE = ['宏泰企業', '宏宏企業', 'TBC_T1_障礙排除判斷_Agent']
  const targets = raw
    .filter(a => WORKING_WITH_KNOWLEDGE.includes(String(a.name)))
    .map(a => ({
      id: String(a.id ?? a._id),
      name: String(a.name),
      model: String(a.model_id),
      folders: (a.folder_ids as unknown[])?.length ?? 0,
      boards: (a.board_ids as unknown[])?.length ?? 0,
    }))

  console.log(`\n  受測 agent：${targets.map(t => `${t.name}(folders=${t.folders},boards=${t.boards})`).join('、')}\n`)

  const summary: Array<Record<string, unknown>> = []

  for (const a of targets) {
    console.log(`\n  ══ ${a.name} ── ${a.model} ══════════════════`)

    // ── ① 知識庫問答：引用來源存在嗎 ──────────────────
    try {
      const q = '請說明你知識庫裡的服務流程，並在回答最後列出你參考了哪些文件或章節。'
      const r = await chat(client, a.id, q)
      const cite = findCitationSignals(r.raw, r.events)

      console.log(`  ① 知識庫問答（${r.ms}ms，${r.text.length} 字）`)
      console.log(`     事件型別：${r.eventTypes.join(', ')}`)
      console.log(`     引用訊號 — 事件層：${cite.eventLevel.length} 個`
        + `｜欄位層：${cite.fieldLevel.join(', ') || '無'}`
        + `｜文字層檔名：${cite.textLevel.join(', ') || '無'}`)
      console.log(`     回答節錄：${r.text.replace(/\s+/g, ' ').slice(0, 200)}`)

      p.fixture(`${a.name}-knowledge-raw`, {
        prompt: q, ms: r.ms, eventTypes: r.eventTypes,
        citation: cite, text: r.text, events: r.events.slice(0, 40),
      })

      summary.push({
        agent: a.name, task: '知識庫問答', ms: r.ms, chars: r.text.length,
        eventTypes: r.eventTypes,
        citationEvent: cite.eventLevel.length,
        citationField: cite.fieldLevel,
        citationText: cite.textLevel,
      })
    } catch (e) {
      console.log(`  ① 失敗：${e instanceof Error ? e.message : String(e)}`)
    }

    // ── ② 結構化輸出：JSON 穩定嗎 ─────────────────────
    try {
      const q = '只輸出 JSON，不要任何其他文字或程式碼區塊標記。'
        + '格式：{"sentiment":"positive|neutral|negative","score":0-100,"summary":"一句話"}。'
        + '請分析這句話：「等了快一小時還是沒人理我，這什麼服務品質？」'
      const r = await chat(client, a.id, q)
      const cleaned = r.text.replace(/```json|```/g, '').trim()
      let parsed: unknown = null
      let parseErr = ''
      try { parsed = JSON.parse(cleaned) } catch (e) { parseErr = String(e).slice(0, 60) }

      console.log(`  ② 結構化輸出（${r.ms}ms）：${parsed ? '✅ 可直接 JSON.parse' : `❌ ${parseErr}`}`)
      console.log(`     原始輸出：${r.text.replace(/\s+/g, ' ').slice(0, 160)}`)

      summary.push({
        agent: a.name, task: 'JSON 輸出', ms: r.ms,
        parseable: !!parsed, output: r.text.slice(0, 200),
      })
    } catch (e) {
      console.log(`  ② 失敗：${e instanceof Error ? e.message : String(e)}`)
    }

    // ── ③ 摘要任務：實際延遲 ──────────────────────────
    try {
      const q = '請用 40 字內摘要以下客服對話：'
        + '客戶：我的網路從昨天下午就一直斷線。客服：了解，請問您有重開機過嗎？'
        + '客戶：重開三次了都沒用，我明天要在家上班很急。客服：我幫您查一下線路狀態。'
      const r = await chat(client, a.id, q)
      console.log(`  ③ 摘要任務（${r.ms}ms）：${r.text.replace(/\s+/g, ' ').slice(0, 120)}`)
      summary.push({ agent: a.name, task: '摘要', ms: r.ms, output: r.text.slice(0, 150) })
    } catch (e) {
      console.log(`  ③ 失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  p.fixture('summary', summary)

  // ── 收斂結論 ───────────────────────────────────────
  const knowledgeRuns = summary.filter(s => s.task === '知識庫問答')
  const anyEventCitation = knowledgeRuns.some(s => (s.citationEvent as number) > 0)
  const anyFieldCitation = knowledgeRuns.some(s => (s.citationField as string[]).length > 0)
  const anyTextCitation = knowledgeRuns.some(s => (s.citationText as string[]).length > 0)
  const jsonRuns = summary.filter(s => s.task === 'JSON 輸出')
  const jsonOk = jsonRuns.filter(s => s.parseable).length

  const latencies = summary.map(s => s.ms as number).filter(Boolean)
  const p50 = latencies.sort((x, y) => x - y)[Math.floor(latencies.length / 2)] ?? 0
  const max = Math.max(...latencies, 0)

  p.record({
    question: '0-3a/b/c', claim: 'agent 回答是否附帶可驗證的引用來源',
    verdict: anyEventCitation || anyFieldCitation ? 'yes' : anyTextCitation ? 'partial' : 'no',
    evidence: `事件層引用=${anyEventCitation ? '有' : '無'}；`
      + `結構化欄位=${anyFieldCitation ? '有' : '無'}；`
      + `文字中出現檔名=${anyTextCitation ? '有' : '無'}`,
    impact: anyEventCitation || anyFieldCitation
      ? '⭐ 可取得結構化引用 → 建議卡的「SOP 來源」可實作，憲法 4.3白名單後驗成立。'
      : anyTextCitation
        ? '🟡 只能靠 prompt 要模型把來源寫進文字 —— 可解析但不可信（模型會杜撰檔名）。'
          + '若要上線，必須用平台的 RAG 檔案清單做白名單後驗，濾掉查無此檔的引用。'
        : '❌ 回答中完全沒有來源資訊 → 介面上的「SOP 3.2」無法誠實標示，'
          + '應改為「僅顯示建議內容，不標來源」，或改由我方自建檢索。',
  })

  p.record({
    question: '0-3d', claim: 'agent 能否穩定回傳可解析的 JSON',
    verdict: jsonOk === jsonRuns.length && jsonRuns.length > 0 ? 'yes'
      : jsonOk > 0 ? 'partial' : 'no',
    evidence: `${jsonOk}/${jsonRuns.length} 次可直接 JSON.parse（response_format 欄位在 27 個 agent 上皆為 null）`,
    impact: jsonOk === jsonRuns.length
      ? '✅ prompt 層可達成 JSON 輸出 → 摘要／情緒可用，但仍需 Zod 驗證 + 重試（無平台層保證）。'
      : '需要自建「解析失敗就重試、重試仍失敗就降級」的管線 —— 這是 §11 的必要工項，不可省。',
  })

  p.record({
    question: 'UI-3', claim: 'AI 回應延遲對 UI 設計的影響',
    verdict: 'yes',
    evidence: `${latencies.length} 次呼叫，中位數 ${p50}ms、最慢 ${max}ms`,
    impact: max > 3000
      ? `最慢 ${(max / 1000).toFixed(1)} 秒 → 右欄 Copilot 面板必須用漸進顯示：`
        + '先出骨架，摘要／情緒／建議卡各自獨立載入，不能等全部算完才渲染。'
      : '延遲可接受，但仍建議串流顯示。',
  })
})

if (isMain(import.meta.url)) {
  probe11().then((f: Finding[]) => process.exit(0))
}
