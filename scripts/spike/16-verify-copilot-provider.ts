/**
 * 16 — 驗證 ImbraceAgentProvider 本身（跟 15 不同：15 測的是 agent 原始輸出，
 * 這裡測的是我們自己寫的 provider 程式碼——JSON 抽取、欄位組裝——輸出能否通過
 * server/services/ai/schemas.ts 的正式 Zod 驗證）。
 *
 * 用途：換了 agent 設定、調過 prompt、或改過 extractLeadingJson() 的解析邏輯後，
 * 重跑本 probe 確認整條路徑（agent 呼叫 → JSON 抽取 → 欄位組裝 → Zod 驗證）沒有壞掉。
 *
 * ⚠️ 唯讀：只呼叫 AI Agent，不寫任何對話資料。
 *
 * 跑法：
 *   npm run spike:verify-provider
 */

import { runProbe, isMain, type Finding } from './lib/harness.js'
import { clientForApiKey } from '../../server/services/imbrace.js'
import { ImbraceAgentProvider } from '../../server/services/ai/imbrace-agent-provider.js'
import { parseConversationSummary, parseSentimentPoints } from '../../server/services/ai/schemas.js'
import type { Message } from '../../shared/types/conversation.js'
import { env, requireEnv, SkipProbe } from './lib/harness.js'

const SAMPLE_HISTORY: Message[] = [
  { id: 'm1', conversationId: 'c1', at: '2026-08-27T00:00:00Z', sender: { type: 'customer' }, text: '網路斷了，已經第三次跟你們反應了' },
  { id: 'm2', conversationId: 'c1', at: '2026-08-27T00:01:00Z', sender: { type: 'ai' }, text: '請協助確認數據機燈號是否正常。' },
  { id: 'm3', conversationId: 'c1', at: '2026-08-27T00:02:00Z', sender: { type: 'customer' }, text: '燈都是綠色的，還是沒有網路，真的很扯' },
]

const RUNS = 3

export const probe16 = () => runProbe('16', 'ImbraceAgentProvider 端到端驗證', async (p) => {
  const summaryAgentId = env('IMBRACE_SUMMARY_AGENT_ID')
  const sentimentAgentId = env('IMBRACE_SENTIMENT_AGENT_ID')
  if (!summaryAgentId || !sentimentAgentId) {
    throw new SkipProbe('缺少 IMBRACE_SUMMARY_AGENT_ID／IMBRACE_SENTIMENT_AGENT_ID（見 .env.local）')
  }

  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: 'stable',
  })
  const provider = new ImbraceAgentProvider(client, summaryAgentId, sentimentAgentId)

  let summaryOk = 0
  let sentimentOk = 0
  const results: Array<Record<string, unknown>> = []

  for (let run = 1; run <= RUNS; run++) {
    try {
      const summary = await provider.summarize({ history: SAMPLE_HISTORY })
      const validated = parseConversationSummary(summary)
      summaryOk++
      console.log(`  第 ${run} 次 summarize() ✅ intent=「${validated.intent}」riskFlags=${JSON.stringify(validated.riskFlags)}`)
      results.push({ run, task: 'summarize', ok: true, intent: validated.intent, riskFlags: validated.riskFlags })
    }
    catch (e) {
      console.log(`  第 ${run} 次 summarize() ❌ ${e instanceof Error ? e.message : String(e)}`)
      results.push({ run, task: 'summarize', ok: false, error: e instanceof Error ? e.message : String(e) })
    }

    try {
      const customerMessages = SAMPLE_HISTORY.filter(m => m.sender.type === 'customer')
      const points = await provider.analyzeSentiment({ messages: customerMessages })
      const validated = parseSentimentPoints(points)
      sentimentOk++
      console.log(`  第 ${run} 次 analyzeSentiment() ✅ labels=${validated.map(v => v.label).join(',')}`)
      results.push({ run, task: 'analyzeSentiment', ok: true, labels: validated.map(v => v.label) })
    }
    catch (e) {
      console.log(`  第 ${run} 次 analyzeSentiment() ❌ ${e instanceof Error ? e.message : String(e)}`)
      results.push({ run, task: 'analyzeSentiment', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  p.fixture('provider-runs', results, true)

  p.record({
    question: 'copilot-provider-e2e',
    claim: 'ImbraceAgentProvider（含 JSON 抽取與欄位組裝）能否穩定產出通過正式 Zod schema 的結果',
    verdict: summaryOk === RUNS && sentimentOk === RUNS ? 'yes' : (summaryOk > 0 || sentimentOk > 0) ? 'partial' : 'no',
    evidence: `summarize() ${summaryOk}/${RUNS}、analyzeSentiment() ${sentimentOk}/${RUNS}`,
    impact: summaryOk === RUNS && sentimentOk === RUNS
      ? '可以正式取代 MockAIProvider。'
      : '需要回頭檢查 extractLeadingJson() 是否還有沒堵到的模型輸出樣式，重跑本 probe 直到穩定。',
  })
})

if (isMain(import.meta.url)) {
  probe16().then((f: Finding[]) => process.exit(0))
}
