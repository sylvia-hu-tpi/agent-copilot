/**
 * 07 — 能力邊界：API Key vs 使用者 Access Token
 *
 * 要回答的問題：
 *   06 掃描出「所有 AI 推論與檢索端點皆不可用」，但那是用 api_ key 測的。
 *   這究竟是「這個部署沒有這些能力」，還是「API Key 這條認證路徑無權使用」？
 *
 * 兩者的後果天差地別：
 *   前者 → iMBrace 無法支撐 demo 右欄，必須外接 viki 或自建
 *   後者 → 改用客服的 acc_ token 即可，成本最低的方案成立
 *
 * ⚠️ 全部唯讀。
 */

import { runProbe, env, isMain, SkipProbe, type Finding } from './lib/harness.js'
import { clientForApiKey, clientForSession } from '../../server/services/imbrace.js'
import type { ImbraceClient, Environment } from '@imbrace/sdk'

interface Check {
  /** 是否為 demo 右欄的關鍵依賴 */
  critical: boolean
  need: string
  call: string
  run: (c: ImbraceClient) => Promise<unknown>
}

const CHECKS: Check[] = [
  { critical: true, need: '自由格式推論（摘要／情緒／結案）', call: 'ai.complete',
    run: c => c.ai.complete({
      model: 'anthropic.claude-opus-5',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
    }) },
  { critical: true, need: '向量化（自建語意檢索的前提）', call: 'ai.embed',
    run: c => c.ai.embed({ model: 'amazon.titan-embed-text-v2:0', input: ['測試'] }) },
  { critical: true, need: '平台內建建議回覆', call: 'messageSuggestion.getSuggestions',
    run: c => c.messageSuggestion.getSuggestions({ message: 'ping' }) },
  { critical: true, need: 'AI Agent 推論（唯一疑似可用的推論路徑）', call: 'aiAgent.streamChat',
    run: async c => {
      const res = await c.aiAgent.streamChat({
        assistant_id: '3fdba48d-c033-4259-975b-51b09a914b67',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'ping' }] }],
      } as Parameters<typeof c.aiAgent.streamChat>[0])
      const text = await res.text()
      const err = text.match(/"errorText":"([^"]+)"/)
      if (err) throw new Error(err[1]!)
      return text.slice(0, 80)
    } },

  { critical: false, need: '角色判定（主管強制介入）', call: 'organizations.list',
    run: c => c.organizations.list() },
  { critical: false, need: 'AI provider 設定（含金鑰是否被遮罩）', call: 'ai.listProviders',
    run: async c => {
      const ps = await c.ai.listProviders() as Array<{ name?: string; config?: unknown }>
      const masked = JSON.stringify(ps).includes('•')
      return `${ps.length} 個 provider，金鑰${masked ? '被遮罩 ⚠️' : '未遮罩'}`
    } },
  { critical: false, need: '對話列表（對照組，應兩者皆可）', call: 'conversations.getViewsCount',
    run: c => c.conversations.getViewsCount() },
]

function classify(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  if (m.includes('404') || m.includes('Not Found')) return '❌ 端點不存在'
  if (m.includes('401') || m.includes('Unauthorized')) return '🔒 無權限'
  if (m.includes('403')) return '🔒 禁止'
  if (m.includes('500')) return '💥 伺服器錯誤'
  return '⚠️ ' + m.slice(0, 50)
}

export const probe07 = () => runProbe('07', 'API Key vs Access Token 能力邊界', async (p) => {
  const e = env('IMBRACE_ENV', 'stable') as Environment
  const orgId = env('IMBRACE_ORGANIZATION_ID')
  const apiKey = env('IMBRACE_API_KEY')
  const token = env('IMBRACE_ACCESS_TOKEN')

  if (!apiKey || !token) {
    throw new SkipProbe(
      '需同時設定 IMBRACE_API_KEY 與 IMBRACE_ACCESS_TOKEN 才能比對。'
      + '先跑 npm run spike:auth -- <otp> 取得 access token。',
    )
  }

  const clients: Array<[string, ImbraceClient]> = [
    ['API Key', clientForApiKey(apiKey, { organizationId: orgId, env: e })],
    ['Access Token', clientForSession({ accessToken: token, organizationId: orgId }, { env: e })],
  ]

  console.log(`\n  ${'能力'.padEnd(34)}${'API Key'.padEnd(18)}Access Token`)
  console.log('  ' + '─'.repeat(74))

  const results: Array<{ need: string; critical: boolean; byCred: Record<string, string> }> = []

  for (const check of CHECKS) {
    const byCred: Record<string, string> = {}
    for (const [label, client] of clients) {
      try {
        const r = await check.run(client)
        byCred[label] = '✅ ' + (typeof r === 'string' ? r.slice(0, 40) : 'ok')
      } catch (err) {
        byCred[label] = classify(err)
      }
    }
    results.push({ need: check.need, critical: check.critical, byCred })
    const mark = check.critical ? '⭐' : '  '
    console.log(`  ${mark}${check.need.padEnd(32)}${byCred['API Key']!.padEnd(18)}${byCred['Access Token']}`)
  }

  p.fixture('auth-boundary', results, true)

  // ── 判定 ────────────────────────────────────────────
  const criticals = results.filter(r => r.critical)
  const tokenUnlocks = criticals.filter(r =>
    !r.byCred['API Key']!.startsWith('✅') && r.byCred['Access Token']!.startsWith('✅'))
  const bothFail = criticals.filter(r =>
    !r.byCred['API Key']!.startsWith('✅') && !r.byCred['Access Token']!.startsWith('✅'))

  p.record({
    question: 'ARCH-2',
    claim: 'AI 能力不可用，是部署缺失還是憑證權限問題',
    verdict: tokenUnlocks.length > 0 ? 'partial' : bothFail.length === criticals.length ? 'no' : 'yes',
    evidence: `${criticals.length} 項關鍵能力中，`
      + `換用 access token 後解鎖 ${tokenUnlocks.length} 項、兩者皆不可用 ${bothFail.length} 項`,
    impact: tokenUnlocks.length > 0
      ? `✅ 部分能力屬憑證權限問題 —— 解鎖項目：${tokenUnlocks.map(r => r.need).join('、')}。`
        + '正式架構本就規劃以客服個人 token 執行（§7.3），因此可直接採用，不需外接系統。'
      : bothFail.length === criticals.length
        ? '❌ 兩種憑證皆不可用 → 確認為「此部署未提供這些能力」，非權限問題。'
          + 'demo 右欄（摘要／情緒／建議卡／知識庫快查）無法純靠 iMBrace 實現，'
          + '需外接 viki 或在 BFF 自建 AI 層。此結論應轉為對 iMBrace 的正式確認事項。'
        : '結果混合，需逐項判讀。',
  })
})

if (isMain(import.meta.url)) {
  probe07().then((f: Finding[]) => process.exit(0))
}
