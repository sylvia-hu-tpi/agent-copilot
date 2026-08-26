/**
 * AIProvider 的單一取得入口 —— 比照 server/state/index.ts 的裝配模式。
 *
 * M2 僅接 MockAIProvider（docs/ARCHITECTURE.md §8.2b）；未來換
 * `ImbraceAgentProvider`／`VikiAIProvider` 只需改動本檔的分派邏輯（憲法 2.1、2.2）。
 *
 * ⚠️ 實例掛在 globalThis 而非模組變數：dev 模式下 Nitro HMR 會重新載入模組，
 *    模組層級的單例會被重建（比照 server/services/copilot-runtime.ts 的理由）。
 */

import type { AIProvider } from '../../../shared/types/copilot.js'
import { MockAIProvider } from './mock-ai-provider.js'

const KEY = Symbol.for('agent-copilot.ai-provider')
type Global = typeof globalThis & { [KEY]?: AIProvider }

export function useAIProvider(): AIProvider {
  const g = globalThis as Global
  if (!g[KEY]) {
    // M2：後續換 ImbraceAgentProvider 時只改這裡
    g[KEY] = new MockAIProvider()
  }
  return g[KEY]
}

/** 測試用：注入自訂 provider（例如帶故障開關的 MockAIProvider），覆蓋掉全域單例 */
export function setAIProvider(provider: AIProvider): void {
  (globalThis as Global)[KEY] = provider
}
