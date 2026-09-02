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
import { AIOutputValidationError } from '../../server/services/ai/retry-policy.js'
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
  // 本 probe 只驗證 summarize()／analyzeSentiment()，suggestionAgentId 非必要——
  // 缺少時傳空字串即可（suggest() 未在本 probe 被呼叫）
  const provider = new ImbraceAgentProvider(client, summaryAgentId, sentimentAgentId, env('IMBRACE_SUGGESTION_AGENT_ID') ?? '')

  let summaryOk = 0
  let sentimentOk = 0

  /**
   * ⚠️ **失敗必須分成「格式」與「傳輸」兩類，不能只數成功幾次。**
   *
   * 2026-09-01 那一趟的教訓：3 次裡有 1 次是 SDK 端 30 秒逾時（見 out/16-provider-runs.json
   * 的 run 2），本腳本卻把它跟「JSON 解不開」記成同一種失敗，於是 findings 的 impact 寫著
   * 「回頭檢查 extractLeadingJson() 是否還有沒堵到的模型輸出樣式」—— 一個根本不存在的缺陷，
   * 而且是會讓人真的動手去改解析邏輯的那種假線索。同一趟 `narrative`／`topics` 也被連坐
   * 算成 2/3，又讓人懷疑後台 prompt 沒生效；實際上兩次真的回來的摘要都帶著這兩個欄位。
   *
   * §11.5 記的是「量測工具與正式路徑要共用程式碼」，這裡是同一個病的另一面：
   * 程式碼共用了，但**歸因**錯了，一樣會憑空製造出不存在的缺陷。
   */
  let summaryFormatFail = 0
  let summaryTransportFail = 0
  let sentimentFormatFail = 0
  let sentimentTransportFail = 0

  /** `AIOutputValidationError` 涵蓋 JSON 抽取失敗與 Zod 驗證失敗；其餘（逾時、HTTP）一律算傳輸層 */
  const isFormatFailure = (e: unknown): boolean => e instanceof AIOutputValidationError

  /**
   * `narrative`／`topics` 有幾次真的回來了（2026-09-01 新增）。
   *
   * ⚠️ **這兩個計數不能省，也不能靠 `summaryOk` 代表。** 兩個欄位在 schema 是
   *    「驗不過就轉 `undefined`，不拋錯」（見 `schemas.ts` 的說明）—— 那是為了不讓
   *    repo 外的後台設定有本事把摘要區塊整塊打成 error。代價是**後台 prompt 沒生效時，
   *    `summarize()` 一樣會 3/3 通過**，從既有的證據完全看不出來。
   *    這正是本專案一再防的失敗模式：安靜地少一段內容，而所有檢查都是綠的。
   */
  let narrativeOk = 0
  let topicsOk = 0
  const results: Array<Record<string, unknown>> = []

  for (let run = 1; run <= RUNS; run++) {
    try {
      const summary = await provider.summarize({ history: SAMPLE_HISTORY })
      const validated = parseConversationSummary(summary)
      summaryOk++
      if (validated.narrative) narrativeOk++
      if (validated.topics?.length) topicsOk++
      console.log(`  第 ${run} 次 summarize() ✅ intent=「${validated.intent}」riskFlags=${JSON.stringify(validated.riskFlags)}`)
      console.log(`         narrative=${validated.narrative ? `「${validated.narrative}」` : '❌ 缺席'}`)
      console.log(`         topics=${validated.topics?.length ? JSON.stringify(validated.topics) : '❌ 缺席'}`)
      results.push({
        run,
        task: 'summarize',
        ok: true,
        intent: validated.intent,
        riskFlags: validated.riskFlags,
        narrative: validated.narrative ?? null,
        topics: validated.topics ?? null,
      })
    }
    catch (e) {
      const kind = isFormatFailure(e) ? 'format' : 'transport'
      if (kind === 'format') summaryFormatFail++
      else summaryTransportFail++
      console.log(`  第 ${run} 次 summarize() ❌ [${kind}] ${e instanceof Error ? e.message : String(e)}`)
      results.push({ run, task: 'summarize', ok: false, failure: kind, error: e instanceof Error ? e.message : String(e) })
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
      const kind = isFormatFailure(e) ? 'format' : 'transport'
      if (kind === 'format') sentimentFormatFail++
      else sentimentTransportFail++
      console.log(`  第 ${run} 次 analyzeSentiment() ❌ [${kind}] ${e instanceof Error ? e.message : String(e)}`)
      results.push({ run, task: 'analyzeSentiment', ok: false, failure: kind, error: e instanceof Error ? e.message : String(e) })
    }
  }

  p.fixture('provider-runs', results, true)

  /*
    ⚠️ 這一條與上面的 e2e 是**兩個獨立的問題**，不可合併成一條 ——
       「輸出解得開、驗得過」與「後台 prompt 有沒有生效」會各自失敗，
       合成一條的話後者失敗時會被前者的綠燈蓋掉。
  */
  p.record({
    question: 'copilot-summary-narrative',
    claim: '後台的 `AgentCopilot_摘要_agent` 有回傳 `narrative` 與 `topics`（畫布 2a「對話摘要」需要）',
    verdict: narrativeOk === RUNS && topicsOk === RUNS
      ? 'yes'
      : (narrativeOk > 0 || topicsOk > 0) ? 'partial' : 'no',
    /*
      ⚠️ 分母是 `summaryOk`（真的回來的次數）而不是 `RUNS`。沒回來的那幾次**無從得知**
         後台有沒有生成這兩個欄位，把它算成「缺席」等於拿一個傳輸問題去指控 prompt 設定。
    */
    evidence: summaryOk === 0
      ? `無法判定：${RUNS} 次 summarize() 全部沒有回傳（傳輸 ${summaryTransportFail} 次、格式 ${summaryFormatFail} 次）`
      : `narrative ${narrativeOk}/${summaryOk}、topics ${topicsOk}/${summaryOk}`
        + `（分母為實際回傳的次數，另有 ${RUNS - summaryOk} 次未回傳不計入）`,
    impact: summaryOk === 0
      ? '本趟無法判定 —— 先排除傳輸失敗再重跑，MUST NOT 據此去調整後台 prompt。'
      : narrativeOk === summaryOk && topicsOk === summaryOk
        ? undefined
        : '⚠️ 缺席時 UI 會退回以 `intent` 當正文、不顯示主題標籤 —— **畫面不會報錯**，'
          + '只是安靜地少一段內容。請確認後台 system prompt 是否已更新（見 ARCHITECTURE §11.5）',
  })

  const formatFail = summaryFormatFail + sentimentFormatFail
  const transportFail = summaryTransportFail + sentimentTransportFail

  p.record({
    question: 'copilot-provider-e2e',
    claim: 'ImbraceAgentProvider（含 JSON 抽取與欄位組裝）能否穩定產出通過正式 Zod schema 的結果',
    verdict: summaryOk === RUNS && sentimentOk === RUNS ? 'yes' : (summaryOk > 0 || sentimentOk > 0) ? 'partial' : 'no',
    evidence: `summarize() ${summaryOk}/${RUNS}、analyzeSentiment() ${sentimentOk}/${RUNS}`
      + (formatFail + transportFail > 0 ? `（失敗分類：格式 ${formatFail} 次、傳輸 ${transportFail} 次）` : ''),
    impact: summaryOk === RUNS && sentimentOk === RUNS
      ? '可以正式取代 MockAIProvider。'
      : formatFail > 0
        ? `有 ${formatFail} 次是格式失敗（JSON 抽取或 Zod 驗證）—— 回頭檢查 extractLeadingJson() `
          + '是否還有沒堵到的模型輸出樣式，並把新樣式補進 test/ai-json-extraction.test.ts 釘住。'
        : `失敗 ${transportFail} 次全部在傳輸層（逾時／HTTP），與解析邏輯無關 —— 重跑即可，`
          + '**MUST NOT 據此去改 extractLeadingJson()**（那正是 2026-09-01 差點發生的事）。',
  })
})

if (isMain(import.meta.url)) {
  probe16().then((f: Finding[]) => process.exit(0))
}
