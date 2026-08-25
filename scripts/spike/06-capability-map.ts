/**
 * 06 — iMBrace 平台能力全景掃描
 *
 * 目的：不預設任何架構方向，先把「這個部署到底能做什麼」攤開來看。
 * 每一格都是實測結果，不是文件宣稱。
 *
 * ⚠️ 全部唯讀。清單中若出現任何會改動資料的端點，請直接刪除該列。
 */

import { runProbe, isMain, businessUnitId, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

type Area = '對話' | '訊息' | '聯絡人' | 'Data Board' | '知識庫' | 'AI' | '頻道/流程' | '組織/權限'

interface Capability {
  area: Area
  /** 對應 demo 的哪個功能，或哪一項架構需求 */
  need: string
  call: string
  run: (c: ImbraceClient, ctx: { bu: string }) => Promise<unknown>
}

const CAPABILITIES: Capability[] = [
  // ── 對話 ────────────────────────────────────────────
  { area: '對話', need: '對話列表（左欄）', call: 'conversations.search({businessUnitId})',
    run: (c, x) => c.conversations.search({ businessUnitId: x.bu, q: '', limit: 5 }) },
  { area: '對話', need: '對話詳情 + operator 清單（presence）', call: 'conversations.getByConversationId',
    run: (c) => c.conversations.getByConversationId(process.env.SPIKE_CONVERSATION_ID!.trim()) },
  { area: '對話', need: '未處理佇列', call: 'conversations.getOutstanding',
    run: (c, x) => c.conversations.getOutstanding({ businessUnitId: x.bu, limit: 5 }) },
  { area: '對話', need: '各檢視計數（側欄徽記）', call: 'conversations.getViewsCount',
    run: (c, x) => c.conversations.getViewsCount({ businessUnitId: x.bu }) },
  { area: '對話', need: '可邀請的同事（主管接管）', call: 'conversations.getInvitableUsers',
    run: (c) => c.conversations.getInvitableUsers(process.env.SPIKE_CONVERSATION_ID!.trim()) },

  // ── 訊息 ────────────────────────────────────────────
  { area: '訊息', need: '取單一對話訊息（中欄訊息流）', call: 'GET conversation_messages?conversation_id',
    run: (c) => rawMessages(c, { conversation_id: process.env.SPIKE_CONVERSATION_ID!.trim(), limit: '5' }) },
  { area: '訊息', need: '增量拉取（輪詢最佳化）', call: '?since / ?after',
    run: async (c) => {
      const all = await rawMessages(c, { conversation_id: process.env.SPIKE_CONVERSATION_ID!.trim(), limit: '50' }) as unknown[]
      const since = await rawMessages(c, { conversation_id: process.env.SPIKE_CONVERSATION_ID!.trim(), since: 'x', limit: '50' }) as unknown[]
      if (all.length === since.length) throw new Error(`since 被忽略（兩次都回 ${all.length} 則）`)
      return since
    } },

  // ── 聯絡人 ──────────────────────────────────────────
  { area: '聯絡人', need: '客戶資料（結案摘要關聯）', call: 'contacts.list',
    run: (c) => (c.contacts as { list(p?: unknown): Promise<unknown> }).list({ limit: 3 }) },

  // ── Data Board ──────────────────────────────────────
  { area: 'Data Board', need: '結案摘要寫入目標', call: 'boards.list',
    run: (c) => c.boards.list?.() ?? Promise.reject(new Error('無此方法')) },
  { area: 'Data Board', need: '結案摘要冪等查詢', call: 'boards.search',
    run: async (c) => {
      const bs = await (c.boards.list?.() as Promise<{ data?: Array<{ id: string }> }>)
      const id = bs?.data?.[0]?.id
      if (!id) throw new Error('無可用 board')
      return c.boards.search(id, { q: '', limit: 3 })
    } },

  // ── 知識庫 ──────────────────────────────────────────
  { area: '知識庫', need: 'SOP 來源：Knowledge Hub 資料夾', call: 'boards.searchFolders',
    run: (c) => c.boards.searchFolders({}) },
  { area: '知識庫', need: 'SOP 來源：已建索引的 RAG 檔案', call: 'ai.listRagFiles',
    run: (c) => c.ai.listRagFiles() },
  { area: '知識庫', need: '⭐ 語意檢索（建議卡的 SOP 引用）', call: 'ai.embed / 任何 retrieve API',
    run: (c) => c.ai.embed({ model: 'amazon.titan-embed-text-v2:0', input: ['測試'] }) },

  // ── AI ──────────────────────────────────────────────
  { area: 'AI', need: 'AI provider 設定', call: 'ai.listProviders',
    run: (c) => c.ai.listProviders() },
  { area: 'AI', need: '已設定的 AI Agent（含 TBC 系列）', call: 'ai.listAiAgents',
    run: (c) => c.ai.listAiAgents() },
  { area: 'AI', need: '⭐ 自由格式推論（摘要／情緒／建議）', call: 'ai.complete',
    run: (c) => c.ai.complete({ model: 'anthropic.claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }) },
  { area: 'AI', need: '⭐ 建議回覆（平台內建）', call: 'messageSuggestion.getSuggestions',
    run: (c) => c.messageSuggestion.getSuggestions({ message: 'test' }) },

  // ── 頻道 / 流程 ─────────────────────────────────────
  { area: '頻道/流程', need: '頻道設定（取 bu_id）', call: 'channel.list',
    run: (c) => (c.channel as { list(): Promise<unknown> }).list() },
  { area: '頻道/流程', need: '⭐ AI workflow（暫停單一對話 AI 的線索）', call: 'workflows.listFlows',
    run: (c) => c.workflows.listFlows() },
  { area: '頻道/流程', need: '頻道自動化（AI 是否自動回覆的設定處）', call: 'workflows.listChannelAutomation',
    run: (c) => c.workflows.listChannelAutomation() },

  // ── 組織 / 權限 ─────────────────────────────────────
  { area: '組織/權限', need: '目前使用者（含 org id）', call: 'account.getAccount',
    run: (c) => c.account.getAccount() },
  { area: '組織/權限', need: '⭐ 角色判定（主管強制介入）', call: 'organizations.list',
    run: (c) => c.organizations.list() },
]

/** 直接打 REST，帶 SDK 未公開的 conversation_id */
async function rawMessages(client: ImbraceClient, params: Record<string, string>) {
  const res = client.messages as unknown as { http: { getFetch(): typeof fetch }; base: string }
  const url = new URL(`${res.base}/v1/conversation_messages`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const r = await res.http.getFetch()(url, { method: 'GET' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json() as { data?: unknown[] }
  return j.data ?? []
}

function sizeOf(r: unknown): string {
  if (Array.isArray(r)) return `${r.length} 筆`
  const o = r as Record<string, unknown>
  if (Array.isArray(o?.data)) return `${(o.data as unknown[]).length} 筆`
  if (o && typeof o === 'object') return Object.keys(o).slice(0, 4).join(',')
  return String(r).slice(0, 30)
}

export const probe06 = () => runProbe('06', '平台能力全景掃描', async (p, client) => {
  const bu = await businessUnitId(client)
  const rows: string[] = []
  let ok = 0, fail = 0

  for (const cap of CAPABILITIES) {
    let status: string, detail: string
    try {
      const r = await cap.run(client, { bu })
      status = '✅'; detail = sizeOf(r); ok++
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      status = m.includes('404') || m.includes('Not Found') ? '❌ 端點不存在'
        : m.includes('401') ? '🔒 無權限'
        : m.includes('500') ? '💥 伺服器錯誤' : '⚠️'
      detail = m.replace(/\s+/g, ' ').slice(0, 70); fail++
    }
    const line = `| ${cap.area} | ${cap.need} | \`${cap.call}\` | ${status} | ${detail.replace(/\|/g, '\\|')} |`
    rows.push(line)
    console.log(`  ${status.padEnd(8)} ${cap.area.padEnd(10)} ${cap.need}`)
  }

  p.fixture('capability-matrix', rows, true)
  p.record({
    question: 'ARCH',
    claim: '平台能力全景',
    verdict: fail === 0 ? 'yes' : ok > fail ? 'partial' : 'no',
    evidence: `${CAPABILITIES.length} 項受測：可用 ${ok}、不可用 ${fail}`,
    impact: '完整矩陣見 scripts/spike/out/06-capability-matrix.json，'
      + '⭐ 標記者為 demo 功能的關鍵依賴。',
  })
})

if (isMain(import.meta.url)) {
  probe06().then((f: Finding[]) => process.exit(0))
}
