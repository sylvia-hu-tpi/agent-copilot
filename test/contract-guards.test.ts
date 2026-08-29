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

// ── specs/004-progressive-citations（research.md #8、data-model.md §4、contracts §3）──

describe('004 契約：檢索逾時只有一個數字', () => {
  const serverFiles = filesUnder(resolve(ROOT, 'server'), ['.ts'])

  it('掃描確實看得到 server/ 的檔案（否則這支守衛等於沒在驗）', () => {
    expect(serverFiles.length).toBeGreaterThan(0)
  })

  /**
   * `SUGGESTION_RETRIEVAL_TIMEOUT_MS`（8 秒）已於 004 刪除，建議卡路徑改與快查共用
   * `KNOWLEDGE_SEARCH_TIMEOUT_MS`（30 秒）。
   *
   * ⚠️ 守住的是「**不要再長回兩個數字**」：002 的教訓是兩個並存的逾時值會各自漂移，
   *    而漂移的症狀（建議卡永遠拿不到引用）不報錯、不影響型別、測試也全綠。
   *    留一個 `= KNOWLEDGE_SEARCH_TIMEOUT_MS` 的別名同樣不行 —— 別名日後照樣會被改成別的數字。
   */
  it('server/ 底下不存在 SUGGESTION_RETRIEVAL_TIMEOUT_MS', () => {
    const offenders = serverFiles.filter(f => readFileSync(f, 'utf8').includes('SUGGESTION_RETRIEVAL_TIMEOUT_MS'))
    expect(offenders.map(f => f.replace(ROOT, '.').replace(/\\/g, '/'))).toEqual([])
  })

  it('⚠️ 這支守衛本身是有效的 —— 對著含該字串的內容必須抓得出來', () => {
    expect('const SUGGESTION_RETRIEVAL_TIMEOUT_MS = 8_000'.includes('SUGGESTION_RETRIEVAL_TIMEOUT_MS')).toBe(true)
  })
})

describe('004 契約：尾巴是 server-only 的控制流狀態', () => {
  const sharedFiles = filesUnder(resolve(ROOT, 'shared'), ['.ts'])

  /**
   * `suggestionTails`／`citedLanded` 是第二段的世代與競態控制（data-model.md §4），
   * **不是分析結果**。一旦被搬進 `shared/`（＝進了 `SuggestionBlock` 之類的型別），
   * 就會隨 `publishBlock()` 送出的整個 block 流到瀏覽器 —— 對外契約被默默改掉，
   * 而 `npm run typecheck` 一聲不吭。理由與上方契約 1.1 的 `failedBatches` 完全相同。
   */
  it('shared/ 底下不存在 suggestionTails／citedLanded', () => {
    const offenders = sharedFiles.filter((f) => {
      const source = readFileSync(f, 'utf8')
      return source.includes('suggestionTails') || source.includes('citedLanded')
    })
    expect(offenders.map(f => f.replace(ROOT, '.').replace(/\\/g, '/'))).toEqual([])
  })

  it('⚠️ 這支守衛本身是有效的 —— 對著含該字串的內容必須抓得出來', () => {
    expect('interface X { citedLanded: boolean }'.includes('citedLanded')).toBe(true)
    expect('const suggestionTails = new Map()'.includes('suggestionTails')).toBe(true)
  })
})

describe('004 FR-008：程式主動更新 MUST NOT 碰 Composer 草稿', () => {
  const SOURCE_PATH = 'app/composables/useCopilotSession.ts'

  /**
   * 第二段整批換卡是**程式主動**的更新，而客服可能正在 Composer 裡改一鍵帶入的內容。
   * 這個 composable 只該覆蓋 `suggestions` ref；一旦它碰得到 `useDraft()`，
   * 「更新時 Composer 一字不變」就只剩下慣例在守，而違反它的症狀是客服打到一半的字被清掉 ——
   * 不報錯、不影響型別。
   *
   * ⚠️ 這是**靜態**守衛，不等於 SC-003 的行為驗證（見 004 contracts §3 的註記）。
   */
  it('useCopilotSession.ts 不得出現 useDraft', () => {
    const source = readFileSync(resolve(ROOT, SOURCE_PATH), 'utf8')
    expect(source).not.toContain('useDraft')
  })

  it('⚠️ 這支守衛本身是有效的 —— 檔案讀得到且對著含該字串的內容抓得出來', () => {
    const source = readFileSync(resolve(ROOT, SOURCE_PATH), 'utf8')
    expect(source.length).toBeGreaterThan(0)
    expect('const draft = useDraft(id)'.includes('useDraft')).toBe(true)
  })
})
