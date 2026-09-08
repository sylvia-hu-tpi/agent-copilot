/**
 * AIProvider 的單一取得入口 —— 比照 server/state/index.ts 的裝配模式。
 *
 * 2026-08-27：已換上 `ImbraceAgentProvider`（憲法 2.1、2.2 的裝配點只改這裡）。
 * 缺憑證／agent id 時退回 `MockAIProvider` 並警告——僅供本機開發，非正式行為。
 *
 * ⚠️ 直接讀 `process.env`，不透過 `useRuntimeConfig()`：本檔會被 vitest 直接 import
 *    （非 Nitro 環境，`useRuntimeConfig` 不存在），比照 `scripts/spike/lib/harness.ts`
 *    的讀法。`.env.local` 的憑證由 `nuxt.config.ts` 在啟動時橋接進 `NUXT_*`，
 *    兩種鍵名都要接受才能同時相容本機 dev（`.env.local`）與正式部署（直接給 `NUXT_*`）。
 *
 * ⚠️ 實例掛在 globalThis 而非模組變數：dev 模式下 Nitro HMR 會重新載入模組，
 *    模組層級的單例會被重建（比照 server/services/copilot-runtime.ts 的理由）。
 */

import type { Environment } from '@imbrace/sdk'
import { clientForApiKey } from '../imbrace.js'
import type { AIProvider } from '../../../shared/types/copilot.js'
import { ImbraceAgentProvider } from './imbrace-agent-provider.js'
import { MockAIProvider } from './mock-ai-provider.js'

const KEY = Symbol.for('agent-copilot.ai-provider')
type Global = typeof globalThis & { [KEY]?: AIProvider }

function envVar(nuxtKey: string, plainKey: string): string {
  return process.env[nuxtKey] || process.env[plainKey] || ''
}

function createProvider(): AIProvider {
  const apiKey = envVar('NUXT_IMBRACE_API_KEY', 'IMBRACE_API_KEY')
  const orgId = envVar('NUXT_IMBRACE_ORGANIZATION_ID', 'IMBRACE_ORGANIZATION_ID')
  const baseUrl = envVar('NUXT_IMBRACE_BASE_URL', 'IMBRACE_BASE_URL') || undefined
  const env = envVar('NUXT_PUBLIC_IMBRACE_ENV', 'IMBRACE_ENV') || 'stable'
  const summaryAgentId = envVar('NUXT_IMBRACE_SUMMARY_AGENT_ID', 'IMBRACE_SUMMARY_AGENT_ID')
  const sentimentAgentId = envVar('NUXT_IMBRACE_SENTIMENT_AGENT_ID', 'IMBRACE_SENTIMENT_AGENT_ID')
  const suggestionAgentId = envVar('NUXT_IMBRACE_SUGGESTION_AGENT_ID', 'IMBRACE_SUGGESTION_AGENT_ID')
  /*
    specs/006 的第五個 agent（結案摘要）。

    ⚠️ **刻意不加進下面那個「缺一即退回 Mock」的判定。** 加進去的話，
       還沒設定結案 agent 的環境會連摘要、情緒、建議卡一起退回假資料 ——
       壞的範圍要與缺的東西一致。缺這一支只讓結案摘要在按下時當場失敗
       （`ImbraceAgentProvider.summarizeClosure()` 拋錯 → route 回 502 → 面板顯示重試），
       那是看得見的壞掉；靜默退回 mock 會把一份固定的假摘要寫進正式 CRM。
  */
  const closureAgentId = envVar('NUXT_IMBRACE_CLOSURE_AGENT_ID', 'IMBRACE_CLOSURE_AGENT_ID')

  if (!apiKey || !orgId || !summaryAgentId || !sentimentAgentId || !suggestionAgentId) {
    console.warn(
      '[ai] 缺少 IMBRACE_API_KEY／IMBRACE_ORGANIZATION_ID／IMBRACE_SUMMARY_AGENT_ID／'
      + 'IMBRACE_SENTIMENT_AGENT_ID／IMBRACE_SUGGESTION_AGENT_ID 其中之一，退回 MockAIProvider —— '
      + '僅供本機開發，正式環境不應出現這行警告。',
    )
    // ⚠️ smoke:realtime（specs/002-suggestion-knowledge-search T045）用來注入建議卡
    // 生成故障，驗證訊息流與 Composer 不受影響（憲法 3.2）。只在已經退回 Mock 的路徑上生效，
    // 不影響任何正式環境行為。
    return new MockAIProvider({
      suggestFailure: process.env.AC_SMOKE_FORCE_SUGGEST_FAILURE
        ? () => new Error('smoke 測試注入的建議卡生成故障')
        : undefined,
    })
  }

  const client = clientForApiKey(apiKey, {
    organizationId: orgId,
    baseUrl,
    env: env as Environment,
  })
  return new ImbraceAgentProvider(
    client,
    summaryAgentId,
    sentimentAgentId,
    suggestionAgentId,
    closureAgentId || null,
  )
}

export function useAIProvider(): AIProvider {
  const g = globalThis as Global
  if (!g[KEY]) {
    g[KEY] = createProvider()
  }
  return g[KEY]
}

/** 測試用：注入自訂 provider（例如帶故障開關的 MockAIProvider），覆蓋掉全域單例 */
export function setAIProvider(provider: AIProvider): void {
  (globalThis as Global)[KEY] = provider
}
