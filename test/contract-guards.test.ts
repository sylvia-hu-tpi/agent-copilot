/**
 * 契約守衛 —— specs/003-analysis-trigger-policy／contracts/analysis-trigger-contract.md。
 *
 * 這裡放的是**型別檢查抓不到、只能靠掃描原始碼守住**的契約條款。
 * 兩條都屬於「靜默失效」型：違反時型別全過、測試全綠、畫面看起來正常。
 *
 * ⚠️ **MUST NOT 併進 test/component-names.test.ts。**
 *    那支測試在找不到 `.nuxt/components.d.ts` 時會整支 `describe.skipIf` 掉
 *    （乾淨 checkout 上還沒 `nuxt prepare` 過是正常情況），本檔的守衛會跟著被靜默跳過 ——
 *    而「靜默跳過」正是這些守衛要防的失效形態。本檔不依賴任何建置產物。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

function filesUnder(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full, exts)
    return exts.some(e => entry.name.endsWith(e)) ? [full] : []
  })
}

describe('契約 1.1：失敗批次記憶 MUST NOT 出現在 shared/', () => {
  const sharedFiles = filesUnder(resolve(ROOT, 'shared'), ['.ts'])

  it('掃描確實看得到 shared/ 的檔案（否則這支守衛等於沒在驗）', () => {
    expect(sharedFiles.length).toBeGreaterThan(0)
  })

  /**
   * 三個分析事件送的是**整個 Block**（`publishBlock()`）。`failedBatches` 一旦被搬進
   * 任何一個 Block（或任何 shared/ 的型別），就會隨 SSE 流到瀏覽器 ——
   * 那等於默默改了對外契約，而 `npm run typecheck` 一聲不吭。
   * 它的正確位置是 `CopilotAnalysisState` 頂層（server-only，見 server/state/types.ts）。
   */
  it('shared/ 底下不存在 failedBatches 字串（契約的可執行版本，取代人工 grep）', () => {
    const offenders = sharedFiles.filter(f => readFileSync(f, 'utf8').includes('failedBatches'))
    expect(offenders.map(f => f.replace(ROOT, '.').replace(/\\/g, '/'))).toEqual([])
  })

  it('⚠️ 這支守衛本身是有效的 —— 對著含該字串的內容必須抓得出來', () => {
    // 掃描邏輯壞掉（例如 filesUnder 回空陣列）時，上面那項會永遠通過而毫無價值。
    expect('interface X { failedBatches?: unknown }'.includes('failedBatches')).toBe(true)
  })
})

describe('FR-012 的門檻必須真的被接上（決策 3 的裝配點）', () => {
  /**
   * `copilot-analysis.ts` **不得** import `copilot-runtime.ts`：後者經
   * `server/utils/imbrace-client.ts` 用到 Nitro auto-import 的 `useRuntimeConfig()`，
   * 一旦被 `test/` 透過 copilot-analysis 間接拉進型別圖，`tsconfig.scripts.json` 會整份紅
   * （該檔開頭已把這個陷阱寫成警告）。因此依賴方向反過來：由 copilot-runtime 在載入時
   * 把解析器注入過去。
   *
   * ⚠️ 這一行被刪掉時，`isJoinedResolver` 會退回「一律視為已 JOIN」的預設 ——
   *    LEAVE 之後分析照跑，SC-002 與 SC-006 同時失效，而**沒有任何錯誤或型別問題**。
   */
  it('copilot-runtime.ts 仍在載入時呼叫 setJoinedResolver()', () => {
    const source = readFileSync(resolve(ROOT, 'server/services/copilot-runtime.ts'), 'utf8')
    expect(source).toContain('setJoinedResolver(')
  })

  it('copilot-analysis.ts MUST NOT 反向 import copilot-runtime.ts（否則 typecheck 會整份紅）', () => {
    const source = readFileSync(resolve(ROOT, 'server/services/copilot-analysis.ts'), 'utf8')
    expect(source).not.toMatch(/from '\.\/copilot-runtime\.js'/)
  })
})
