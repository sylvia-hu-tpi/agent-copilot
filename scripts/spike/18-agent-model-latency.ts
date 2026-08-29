/**
 * 18 — 單一 agent 的延遲與輸出合規量測（換模型時的 A／B 工具）
 *
 * 為什麼需要它：`15-copilot-agents.ts` 一次量摘要＋情緒共 12 次呼叫，換一次模型就要等
 * 好幾分鐘（摘要曾出現 42.9 秒的離群值）。要比較多個候選模型時，需要一支只打單一 agent、
 * 樣本數可調的工具。這個需求已經出現兩次——2026-08-27 知識庫 agent 選模型時、
 * 以及 2026-08-28 情緒 agent 逾時時。
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
 *   npm run spike:agent-latency -- suggestion 5        # 建議卡・第一段（不帶知識庫命中）
 *   npm run spike:agent-latency -- suggestion-kb 5     # 建議卡・第二段（帶 3 筆命中）
 */

import { z } from 'zod'
import { makeClient, loadEnv, isMain, OUT_DIR } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSuggestionPrompt, extractLeadingJson } from '../../server/services/ai/imbrace-agent-provider.js'
import type { Message } from '../../shared/types/conversation.js'
import type { KnowledgeHit } from '../../shared/types/knowledge.js'

/**
 * 建議卡的量測輸入 —— 刻意比摘要／情緒那兩筆長。
 *
 * 004 FR-001 要的是「第一段在 002 SC-001 的 10 秒時限內完成」，而建議卡 prompt 的長度
 * 本身就是被量的變數（完整逐字稿 ＋ 規則 ＋ 欄位清單），用三兩句的迷你對話量出來的數字
 * 會低估正式路徑。這裡用一段有升溫、有嘗試步驟、有待補資料的真實形狀對話。
 */
const SUGGESTION_HISTORY: Message[] = [
  { text: '你好，我想問一下網路的問題', type: 'customer' },
  { text: '您好，請問是完全無法連線，還是時斷時續呢？', type: 'agent' },
  { text: '網路好像有點不穩定，看影片一直轉圈圈', type: 'customer' },
  { text: '請協助確認數據機燈號是否正常，並嘗試斷電重啟約 30 秒。', type: 'ai' },
  { text: '已經重開機三次了都沒解決', type: 'customer' },
  { text: '了解，我這邊先幫您查詢線路狀態，請稍候。', type: 'agent' },
  { text: '到底要修到什麼時候，已經影響到我上班了', type: 'customer' },
  { text: '這個月的費用可以退嗎？不然我考慮換一家', type: 'customer' },
].map((m, i) => ({
  id: `msg-${i + 1}`,
  conversationId: 'spike-conversation',
  at: new Date(Date.UTC(2026, 7, 29, 2, i)).toISOString(),
  sender: { type: m.type as Message['sender']['type'] },
  text: m.text,
}))

/**
 * ⚠️ `id` 是白名單後驗（憲法 4.3）的比對基準——`check()` 會拿模型回傳的 `sopId` 跟這裡
 *    的 id 集合核對。若模型自行編造 id，那就是「快而錯」的典型，只看延遲看不出來。
 */
const SUGGESTION_HITS: KnowledgeHit[] = [
  {
    id: 'kb-001',
    title: '寬頻連線不穩定排除流程',
    snippet: '若用戶回報連線時斷時續，請依序確認：① 數據機 LOS 燈是否恆亮 ② 分接盒接頭是否鬆脫 '
      + '③ 若重啟三次仍未改善，開立線路檢測工單並告知用戶檢測時段為 24 小時內。',
    score: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    sourceRef: { type: 'knowledge', ref: '寬頻連線不穩定排除流程' },
  },
  {
    id: 'kb-002',
    title: '障礙期間費用減免申請',
    snippet: '經檢測確認為線路障礙且連續影響達 24 小時以上者，可申請按日比例減免當月月租費，'
      + '需由客服代為填寫減免申請單並附上工單編號。',
    score: null,
    updatedAt: '2026-05-14T00:00:00.000Z',
    sourceRef: { type: 'knowledge', ref: '障礙期間費用減免申請' },
  },
  {
    id: 'kb-003',
    title: '用戶表達解約意向的挽留話術',
    snippet: '用戶提及「換一家」「不續約」時，先完整同理其損失，再說明目前正在進行的處理進度與時程，'
      + '最後才提供補償方案，避免一開口就談優惠而顯得敷衍。',
    score: null,
    updatedAt: '2026-07-20T00:00:00.000Z',
    sourceRef: { type: 'knowledge', ref: '用戶表達解約意向的挽留話術' },
  },
]

/**
 * 建議卡的合規判讀 —— 比照 `server/services/ai/schemas.ts` 的 `SuggestionCardSchema`，
 * 但**扣掉 `id` 與 `supersededBy`**：那兩欄是 provider 自己填的，不是模型的輸出
 * （見 `ImbraceAgentProvider.suggest()` 的註解），拿它們苛求模型會誤判成不合規。
 *
 * ⚠️ 除了 schema，這裡還多驗兩件 schema 管不到、但錯了會直接違憲的事：
 *    ① 卡數上限 5（002 FR-001／004 FR-012 要求在生成階段落實，不得事後截斷）
 *    ② `sopId` 必須落在本次餵進去的命中集合內（憲法 4.3 白名單後驗）——編造 id 是
 *       換模型時最容易悄悄劣化的一項。
 */
function makeSuggestionCheck(allowedSopIds: string[]) {
  const schema = z.array(z.object({
    sopId: z.string().nullable(),
    sopTitle: z.string().nullable(),
    text: z.string().min(1),
    confidence: z.number().min(0).max(100).nullable(),
    rationale: z.string(),
    tone: z.enum(['apologetic', 'informative', 'retention', 'closing', 'escalating']),
    requiresData: z.array(z.string()),
  })).min(1).max(5)

  return (v: unknown) => {
    const r = schema.safeParse(v)
    if (!r.success) {
      return { ok: false as const, note: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
    }
    const allowed = new Set(allowedSopIds)
    const fabricated = r.data.filter(c => c.sopId !== null && !allowed.has(c.sopId)).map(c => c.sopId)
    const note = `${r.data.length} 張  `
      + r.data.map(c => `${c.tone}[${c.sopId ?? '無引用'}]${c.requiresData.length > 0 ? `需補:${JSON.stringify(c.requiresData)}` : ''}`).join(' ')
    if (fabricated.length > 0) {
      return { ok: false as const, note: `⚠️ sopId 編造：${JSON.stringify(fabricated)}（憲法 4.3）  ${note}` }
    }
    return { ok: true as const, note }
  }
}

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
  /**
   * 004 FR-001 的第一段：**不等待知識庫檢索**就先產出一批無引用的卡。
   * 這一筆量的就是「10 秒預算夠不夠」——`knowledgeHits` 為空是真實情境，不是簡化。
   */
  'suggestion': {
    name: 'AgentCopilot_建議回覆_agent',
    prompt: buildSuggestionPrompt({ history: SUGGESTION_HISTORY, knowledgeHits: [], aiReplies: false }),
    check: makeSuggestionCheck([]),
  },
  /** 004 FR-001 的第二段（也是 002 現行的唯一路徑）：帶 3 筆命中，prompt 明顯更長 */
  'suggestion-kb': {
    name: 'AgentCopilot_建議回覆_agent',
    prompt: buildSuggestionPrompt({ history: SUGGESTION_HISTORY, knowledgeHits: SUGGESTION_HITS, aiReplies: false }),
    check: makeSuggestionCheck(SUGGESTION_HITS.map(h => h.id)),
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
 * ⚠️ **一律走正式路徑的 `extractLeadingJson()`，MUST NOT 自己抄一份簡化版。**
 *
 * 2026-08-29 的教訓：這裡原本自抄了一份，只做「去 code fence ＋ 依 JSON.parse 失敗位置
 * 截斷後綴」，**漏了「找第一個 `{`／`[` 切掉開場白」那一步**。於是摘要 agent 被判成
 * 0/15 不合規——而它的輸出一直都正常（`Okay, I will summarize...` 開場白後接合法 JSON，
 * 正式路徑解得開）。原本的註解甚至寫著「比照正式路徑」，但實作並沒有。
 *
 * **量測工具比正式路徑嚴格，會憑空製造出不存在的缺陷；比它寬鬆，會漏掉真的缺陷。**
 * 唯一可靠的做法是共用同一份程式碼，而不是靠註解宣稱兩邊一致。
 */
function extractJson(text: string): unknown | null {
  try {
    return extractLeadingJson(text)
  }
  catch {
    // 正式路徑會拋 AIOutputValidationError；量測只需要「解不開」這個事實
    return null
  }
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
  console.log(`   prompt：${spec.prompt.length} 字   ← 建議卡兩段的差別就在這個數字`)
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
  console.log(`   15 秒門檻 ${results.filter(r => r.ms > 15_000).length}/${runs} 次超過（003 FR-014 單次逾時）`)
  // ⚠️ 10 秒是 002 SC-001 的建議卡時限，也是 004 FR-001 第一段的預算上限。
  //    它比 15 秒門檻更早卡死人，所以兩個都要印——只看 15 秒會漏掉「沒逾時但太慢」。
  console.log(`   10 秒預算 ${results.filter(r => r.ms > 10_000).length}/${runs} 次超過（002 SC-001／004 FR-001）`)

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
