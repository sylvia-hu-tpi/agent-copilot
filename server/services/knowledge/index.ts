/**
 * KnowledgeProvider 的單一取得入口 —— 比照 server/services/ai/index.ts 的裝配模式。
 *
 * 缺憑證／agent id 時退回 MockKnowledgeProvider 並警告——僅供本機開發，非正式行為。
 *
 * ⚠️ 直接讀 `process.env`，不透過 `useRuntimeConfig()`：本檔會被 vitest 直接 import
 *    （非 Nitro 環境，`useRuntimeConfig` 不存在）。
 *
 * ⚠️ 實例掛在 globalThis 而非模組變數：dev 模式下 Nitro HMR 會重新載入模組，
 *    模組層級的單例會被重建。
 */

import type { Environment } from '@imbrace/sdk'
import type { KnowledgeProvider } from '../../../shared/types/knowledge.js'
import { clientForApiKey } from '../imbrace.js'
import { AgentKnowledgeProvider } from './agent-knowledge-provider.js'
import { MockKnowledgeProvider } from './mock-knowledge-provider.js'

const KEY = Symbol.for('agent-copilot.knowledge-provider')
type Global = typeof globalThis & { [KEY]?: KnowledgeProvider }

function envVar(nuxtKey: string, plainKey: string): string {
  return process.env[nuxtKey] || process.env[plainKey] || ''
}

function createProvider(): KnowledgeProvider {
  const apiKey = envVar('NUXT_IMBRACE_API_KEY', 'IMBRACE_API_KEY')
  const orgId = envVar('NUXT_IMBRACE_ORGANIZATION_ID', 'IMBRACE_ORGANIZATION_ID')
  const baseUrl = envVar('NUXT_IMBRACE_BASE_URL', 'IMBRACE_BASE_URL') || undefined
  const env = envVar('NUXT_PUBLIC_IMBRACE_ENV', 'IMBRACE_ENV') || 'stable'
  const knowledgeAgentId = envVar('NUXT_IMBRACE_KNOWLEDGE_AGENT_ID', 'IMBRACE_KNOWLEDGE_AGENT_ID')

  if (!apiKey || !orgId || !knowledgeAgentId) {
    console.warn(
      '[knowledge] 缺少 IMBRACE_API_KEY／IMBRACE_ORGANIZATION_ID／IMBRACE_KNOWLEDGE_AGENT_ID '
      + '其中之一，退回 MockKnowledgeProvider —— 僅供本機開發，正式環境不應出現這行警告。',
    )
    return new MockKnowledgeProvider()
  }

  const client = clientForApiKey(apiKey, {
    organizationId: orgId,
    baseUrl,
    env: env as Environment,
  })
  return new AgentKnowledgeProvider(client, knowledgeAgentId)
}

export function useKnowledgeProvider(): KnowledgeProvider {
  const g = globalThis as Global
  if (!g[KEY]) {
    g[KEY] = createProvider()
  }
  return g[KEY]
}

/** 測試用：注入自訂 provider（例如帶故障開關的 MockKnowledgeProvider），覆蓋掉全域單例 */
export function setKnowledgeProvider(provider: KnowledgeProvider): void {
  (globalThis as Global)[KEY] = provider
}
