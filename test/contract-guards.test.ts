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

/**
 * ⚠️ **註解與字串字面值都要先剝掉。**
 *
 * 本檔多數守衛掃的是「某個名字有沒有出現在程式碼裡」，而這個 repo 的風格是**在註解裡
 * 大量說明為什麼不能用某個東西**：`conversations.search()` 有的寫在註解、有的寫在錯誤
 * 訊息的字串裡（`business-unit.ts:59` 就是後者）；`copilot-analysis.ts` 的檔頭更直接
 * 列了一張表點名 `stateLocks`／`suggestionTails` 這些它**不該碰**的狀態。
 * 純字串比對會把這些說明本身當成違規 —— 守衛永遠紅，最後被關掉，等於沒有守衛。
 *
 * ⚠️ 這個剝除是近似的（不處理跨行字串裡的引號之類的邊界），對這些守衛足夠：
 *    誤判方向是「漏抓」而不是「誤抓」，而漏抓會在 code review 補上，
 *    誤抓則會讓整條守衛失去可信度。
 *
 * ⚠️ **已知盲點：樣板字串內的程式碼會連同 `${}` 一起被抹掉。** 本 repo 確實在寫
 *    `` `${conversationId}:${block}` ``，因此 `` log(`${suggestionTails.size}`) `` 這種
 *    違反抓不到。方向仍是漏抓不是誤抓，故不修；但**不要以為它是完備的**。
 */
const stripNonCode = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')

/**
 * **只剝註解，保留字串。** 給「掃 import 路徑」的守衛用。
 *
 * ⚠️ **MUST NOT 對 import 路徑用 `stripNonCode`** —— 它連單引號字串一起抹掉，
 *    而 import 路徑正是單引號字串，抹完 `from '../x.js'` 變成 `from ''`，
 *    比對式永遠不命中、守衛靜默變成恆真。2026-09-02 一次審查建議就是這麼寫的，
 *    被「守衛本身是有效的」那條自檢當場擋下 —— 那條自檢的價值在此。
 *
 * 保留字串的代價：某個字串字面值剛好含有被禁的路徑時會誤判。比起「恆真」，
 * 誤判至少會被看見。
 */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

/** repo 相對路徑，一律正斜線 —— Windows 上 `readdirSync` 給的是反斜線 */
const toRel = (full: string): string => full.replace(ROOT, '').split('\\').join('/').replace(/^\//, '')

/**
 * 分析管線的成員檔案（2026-09-02 拆檔）—— **由檔案自己的 `@analysis-pipeline` 標記認定，
 * MUST NOT 用檔名 regex，更 MUST NOT 寫死清單。**
 *
 * ⚠️ 這是第二版。第一版用 `/(copilot-analysis|analysis-[a-z-]+)\.ts|blocks\//` 判定，
 *    當天就被實測打穿：`analysis-stage2.ts`（合法 kebab、只是帶數字）與 `analysisSentiment.ts`
 *    各自帶著一行違規的 `import ... copilot-runtime.js`，**守衛全綠、零訊號**。
 *    原因是「涵蓋現有檔案」那條斷言只在清單**變長**時紅，漏掉的檔案根本不進清單。
 *    也就是說檔名法把「忘了加清單」這個失效，換成了「取錯檔名」這個一模一樣的失效。
 *
 * ⚠️ 標記法的價值在**失效方向**：忘了加標記的新管線檔不會靜靜溜過去 —— 它自己的
 *    `import ... analysis-state.js` 會立刻被下方第二條守衛判成「管線外值 import」而紅。
 */
const PIPELINE_MARKER = /^\s*(?:\*|\/\/)\s*@analysis-pipeline\b/m

const PIPELINE_FILES = filesUnder(resolve(ROOT, 'server'), ['.ts'])
  .filter(f => PIPELINE_MARKER.test(readFileSync(f, 'utf8')))
  .map(toRel)
  .sort()

/** 管線內部檔＝管線成員扣掉 barrel。對外介面只從 barrel 出去 */
const BARREL = 'server/services/copilot-analysis.ts'

/**
 * 「內部檔」的比對式**由 `PIPELINE_FILES` 推導，不另外寫一條 regex**。
 *
 * ⚠️ 第一版是手寫的 `blocks\/[a-z-]+`，與成員判定式的涵蓋範圍**不對稱** ——
 *    實測 `blocks/sentiment/index.ts` 與 `blocks/sentiment2.ts` 會落進最糟的組合：
 *    **算成員（豁免外部 import 檢查）、卻不算內部檔（沒有人保護）**，
 *    於是任何 route 都能直接 import 它們、繞過 `runBlockDeduped()` 的去重與失敗批次記憶。
 *    兩份清單只要是各自維護的就會漂移，所以這裡改成同一份的衍生物。
 */
const internalSpecifiers = (): string[] => PIPELINE_FILES
  .filter(rel => rel !== BARREL)
  .map(rel => rel.replace(/^server\/services\//, '').replace(/\.ts$/, ''))

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
    const offenders = sharedFiles.filter(f => stripNonCode(readFileSync(f, 'utf8')).includes('failedBatches'))
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

  /**
   * ⚠️ **掃的是整條管線的每一個檔案，不是只有 `copilot-analysis.ts`。**
   *
   * 2026-09-02 拆檔前這條守衛寫死單一路徑。拆檔後若不一起放大，它只剩下守那個 barrel，
   * 而真正可能違反的 `blocks/suggestion.ts` 沒有人守 ——
   * 守衛本身變成靜默失效的那一類東西，正是它要防的形態。
   *
   * ⚠️ **清單用推導的，MUST NOT 寫死路徑。** 寫死的話，第三刀切出 `blocks/sentiment.ts`
   *    時只要忘了加進來，那個檔案就沒有人守 —— 而「忘了加」不會有任何訊號。
   *    推導的代價是要維護一條 regex，收益是新檔自動入列。
   *
   * 相對路徑依檔案深度而異（`./copilot-runtime.js` 與 `../copilot-runtime.js`），
   * 因此比對的是結尾而非完整字串。
   */
  it('掛著標記的管線成員就是現有這四個（漏掉標記或多標了都會紅）', () => {
    expect(PIPELINE_FILES).toEqual([
      'server/services/analysis-dedupe.ts',
      'server/services/analysis-state.ts',
      'server/services/blocks/suggestion.ts',
      'server/services/copilot-analysis.ts',
    ])
  })

  /**
   * ⚠️ **`import()` 也要抓。** 只抓 `from '...'` 的話，撞到相依方向問題時最自然的
   *    第一個反應（「改成 `await import()` 打破循環」）正好可以繞過守衛 ——
   *    而那恰恰是這條守衛存在的情境。動態 import 一樣會把模組拉進 TypeScript program，
   *    `tsconfig.scripts.json` 照樣整份紅，守衛宣稱防的後果原封不動。
   *
   * ⚠️ 先剝註解再比對：這四個檔案的檔頭**正在大量討論這條禁令**，只要有人為了說清楚
   *    而寫出一行完整的 import 範例，守衛就會紅，而症狀（「我明明沒 import」）很難
   *    第一時間對上原因。
   *
   * ⚠️ 用的是 `stripComments` **不是** `stripNonCode` —— 後者連字串一起剝，
   *    而 import 路徑正是字串，剝完守衛會恆真（理由詳見 `stripComments` 的說明）。
   */
  // ⚠️ 兩個容易寫漏的細節，兩個都被下面那條自檢當場擋下過：
  //    ① `from\s+` 的 `\s+` 不能省 —— 少了 `from` 與引號之間的空白，整條守衛恆假。
  //    ② 單雙引號都要收 —— 本 repo 慣例是單引號，但守衛 MUST NOT 靜默依賴 lint 設定，
  //       否則哪天有人（或某個 codegen）寫成雙引號，守衛就安靜地放行。
  const RUNTIME_IMPORT = /(?:from\s+|import\s*\(\s*)['"][^'"]*copilot-runtime\.js['"]/

  it('整條分析管線 MUST NOT 反向 import copilot-runtime.ts（否則 typecheck 會整份紅）', () => {
    const offenders = PIPELINE_FILES.filter(rel =>
      RUNTIME_IMPORT.test(stripComments(readFileSync(resolve(ROOT, rel), 'utf8'))),
    )
    expect(offenders).toEqual([])
  })

  it('⚠️ 這支守衛本身是有效的 —— 靜態／相對深度／動態都抓得到，且不被註解騙', () => {
    expect(RUNTIME_IMPORT.test(stripComments("import { x } from './copilot-runtime.js'"))).toBe(true)
    expect(RUNTIME_IMPORT.test(stripComments("import { x } from '../copilot-runtime.js'"))).toBe(true)
    expect(RUNTIME_IMPORT.test(stripComments("const p = () => import('../copilot-runtime.js')"))).toBe(true)
    expect(RUNTIME_IMPORT.test(stripComments('import { x } from "../copilot-runtime.js"'))).toBe(true)
    expect(RUNTIME_IMPORT.test(stripComments('import { x } from "../copilot-runtime.js"'))).toBe(true)
    expect(RUNTIME_IMPORT.test(stripComments("// 反例：import { x } from './copilot-runtime.js'"))).toBe(false)
  })
})

// ── 拆檔後的切線（2026-09-02）────────────────────────────────────────

describe('分析管線：每一份執行期狀態只由擁有它的檔案碰', () => {
  /**
   * 這是 2026-09-02 把 `copilot-analysis.ts` 拆成四個檔案時**唯一**的切線依據，
   * 也是判斷「新程式碼該放哪個檔案」的判準：它要碰哪一份 Map，就寫在那個檔案裡。
   *
   * ⚠️ 守它的理由是這一類違反**全部安靜**：跨檔案摸別人的 Map 會繞過該 Map 的
   *    不變式（`stateLocks` 的寫入序列化、`suggestionTails` 的世代計數、
   *    `analysisInFlight` 的去重），而症狀分別是「剛寫入的欄位被舊快照復原」、
   *    「舊尾巴的結果覆蓋新結果」、「同一區塊同時跑兩份分析」——
   *    沒有一項會報錯、讓型別變紅，或讓測試自己變黃。
   *
   * ⚠️ 檔頭的說明會提到別人的 Map（那張表就是在講這件事），因此比對前先剝掉
   *    註解與字串（見 `stripNonCode`）。
   */
  const OWNERSHIP: Array<{ state: string, owner: string }> = [
    { state: 'stateLocks', owner: 'server/services/analysis-state.ts' },
    { state: 'analysisInFlight', owner: 'server/services/analysis-dedupe.ts' },
    { state: 'analysisRerunPending', owner: 'server/services/analysis-dedupe.ts' },
    { state: 'suggestionTails', owner: 'server/services/blocks/suggestion.ts' },
    { state: 'suggestionTailDone', owner: 'server/services/blocks/suggestion.ts' },
    { state: 'coldStartRecoveries', owner: 'server/services/copilot-analysis.ts' },
    { state: 'backgroundInFlight', owner: 'server/services/copilot-analysis.ts' },
    { state: 'debounceTimers', owner: 'server/services/copilot-analysis.ts' },
  ]

  const serverFiles = filesUnder(resolve(ROOT, 'server'), ['.ts'])

  it('掃描確實看得到 server/ 的檔案（否則這支守衛等於沒在驗）', () => {
    expect(serverFiles.length).toBeGreaterThan(0)
  })

  it.each(OWNERSHIP)('$state 只出現在 $owner 的程式碼裡', ({ state, owner }) => {
    const offenders = serverFiles
      .map(f => ({ rel: toRel(f), source: readFileSync(f, 'utf8') }))
      .filter(({ rel, source }) => rel !== owner && new RegExp(`\\b${state}\\b`).test(stripNonCode(source)))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  /**
   * ⚠️ **這一條 MUST 逐項驗，MUST NOT 只抽驗一個。**
   *
   * 上面那組斷言問的是「除了擁有者以外還有誰碰」。若某個名字**全 repo 都不存在**
   * （被改名、或第三刀搬走時忘了同步 `OWNERSHIP`），它會回 `[]` 而通過 ——
   * 從此那份狀態完全沒有人守，而這正是本 describe 宣稱要防的靜默失效形態。
   * 只抽驗一份的話，另外七份仍暴露在這個洞裡。
   */
  it.each(OWNERSHIP)('$owner 內確實有 $state（否則上面那條是在驗一個不存在的名字）', ({ state, owner }) => {
    const source = stripNonCode(readFileSync(resolve(ROOT, owner), 'utf8'))
    expect(new RegExp(`\\b${state}\\b`).test(source)).toBe(true)
  })

  /**
   * ⚠️ **表本身也要由程式碼推導出來核對一次。**
   *
   * 上面兩條合起來只守得住「表上的名字」：一條問「還有誰碰」，一條問「擁有者裡還在不在」。
   * **兩條都不會在「新增了第九份狀態卻忘了寫進表」時紅** —— 那份狀態從此完全沒有人守，
   * 而這正是本 describe 宣稱要防的失效形態。
   *
   * 這個洞是 2026-09-02 拆檔時「把寫死清單改成推導」只做了一半留下的：檔案清單改了，
   * 狀態清單沒改，而支持那次改動的論證（寫死的話忘了加不會有訊號）逐字適用於這張表。
   *
   * 表**刻意保留字面值**而不是直接用推導結果 —— 那些 `state`／`owner` 旁邊的註解
   * 記著每一份狀態的不變式，是推導產不出來的。這裡只負責讓兩者對不上時會紅。
   */
  it('推導出來的模組層狀態清單與 OWNERSHIP 逐項相符（新增第九份而忘了登記會紅）', () => {
    const DECL = /^(?:const|let) (\w+)(?::[^=\n]+)? = new (?:Map|Set|WeakMap|WeakSet)\b/gm
    const derived = PIPELINE_FILES.flatMap(rel =>
      [...stripNonCode(readFileSync(resolve(ROOT, rel), 'utf8')).matchAll(DECL)]
        .map(m => `${m[1]} @ ${rel}`),
    ).sort()
    expect(derived).toEqual(OWNERSHIP.map(o => `${o.state} @ ${o.owner}`).sort())
  })

  it('⚠️ 剝除本身是有效的 —— 抓得到真用法，且不會被註解或字串騙', () => {
    expect(/\bstateLocks\b/.test(stripNonCode('const x = stateLocks.get(id)'))).toBe(true)
    expect(/\bsuggestionTails\b/.test(stripNonCode('import { suggestionTails } from "./x.js"'))).toBe(true)
    expect(/\bstateLocks\b/.test(stripNonCode('// 見 stateLocks 的說明'))).toBe(false)
    expect(/\bstateLocks\b/.test(stripNonCode('/* | `stateLocks` | */'))).toBe(false)
  })
})

// ── 管線內部檔案不得被管線外「值 import」（2026-09-02 拆檔）──────────────

describe('分析管線的對外介面只有 copilot-analysis.ts 一個出口', () => {
  /**
   * 拆檔把 `beginAnalyzing()`／`finishBlockError()`／`publishBlock()`／`updateAnalysisState()`
   * 這一整套三態轉移的驅動面從 module-private 變成跨檔案可見。拆檔前「三態只由管線內部驅動」
   * 是**語法保證**，拆檔後只剩檔頭一段註解 —— 這條守衛把它變回機械保證。
   *
   * ⚠️ **失效情境**：某支 route 為了省事直接 `import { beginAnalyzing } from '.../analysis-state.js'`，
   *    繞過 `runBlockDeduped()` 的去重與失敗批次記憶檢查 → 同一區塊同時跑兩份分析，
   *    或在被記憶擋下的狀態上多打一輪 AI。typecheck 全過、測試全綠，只有帳單與 SC-001 會知道。
   *
   * ⚠️ **純型別 import 不算違反**（執行期被抹除，拿不到任何函式）：`server/state/types.ts`
   *    的 `import type { AnalysisBlock }` 是正確用法，因此比對式排除 `import type`。
   */
  const alt = internalSpecifiers().map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const INTERNAL = new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['"][^'"]*(?:${alt})\\.js['"]`)
  const TYPE_ONLY = new RegExp(`import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['"][^'"]*(?:${alt})\\.js['"]`, 'g')

  it('內部檔清單確實推導自管線成員（推導壞掉時這裡會先紅）', () => {
    expect(internalSpecifiers().sort()).toEqual(['analysis-dedupe', 'analysis-state', 'blocks/suggestion'])
  })

  it('server/ 底下只有管線成員可以值 import 管線內部檔案', () => {
    const offenders = filesUnder(resolve(ROOT, 'server'), ['.ts'])
      .map(f => ({ rel: toRel(f), source: readFileSync(f, 'utf8') }))
      .filter(({ rel }) => !PIPELINE_FILES.includes(rel))
      .filter(({ source }) => INTERNAL.test(stripComments(source).replace(TYPE_ONLY, '')))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  /**
   * ⚠️ 已知誤判：`import { type AnalysisBlock } from '...'`（行內 `type` 修飾）會被判成
   *    值 import。那是純型別、TS 會抹除，屬誤判 —— 但方向是「看得見」不是「恆真」，
   *    排查一次即可，比放寬比對式冒恆真的險划算。改用 `import type { ... }` 即可通過。
   */
  it('⚠️ 這支守衛本身是有效的 —— 值／動態 import 抓得到，import type 放行', () => {
    const check = (s: string): boolean => INTERNAL.test(stripComments(s).replace(TYPE_ONLY, ''))
    expect(check("import { beginAnalyzing } from '../../services/analysis-state.js'")).toBe(true)
    expect(check("import { analyzeSuggestions } from './blocks/suggestion.js'")).toBe(true)
    expect(check("const p = () => import('../services/analysis-dedupe.js')")).toBe(true)
    expect(check('import { x } from "../services/analysis-state.js"')).toBe(true)
    expect(check("import type { AnalysisBlock } from '../services/analysis-state.js'")).toBe(false)
    expect(check('import { x } from "../services/analysis-state.js"')).toBe(true)
    expect(check("// 別 import { x } from '../services/analysis-state.js'")).toBe(false)
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
    const offenders = serverFiles.filter(f => stripNonCode(readFileSync(f, 'utf8')).includes('SUGGESTION_RETRIEVAL_TIMEOUT_MS'))
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
      const source = stripNonCode(readFileSync(f, 'utf8'))
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

describe('對話清單查詢 MUST 走防腐層（skip → offset）', () => {
  /**
   * SDK 宣告的分頁參數是 `skip`，平台實際吃的是 `offset`；傳 `skip` 會回 200
   * 並原封送回**第一頁**。症狀是「載入更多按下去沒反應」，不是任何一種錯誤 ——
   * 沒有 400、沒有例外、沒有型別問題。2026-08-29 由 `npm run spike:list-order` 定位。
   *
   * 因此繞道關在 `server/services/imbrace.ts` 的 `searchConversations()`，
   * 其他地方一律不得直接呼叫 SDK 的 `conversations.search()` ——
   * 直接呼叫會讓分頁再次靜默失效，而且這次沒有任何訊號提醒。
   */
  const ALLOWED = 'server/services/imbrace.ts'
  // ⚠️ 可選鏈也要抓（`conversations?.search(`）—— 那是很可能被寫出來的形狀，
  //    而它繞過守衛之後的症狀與直接呼叫完全相同：分頁靜默停在第一頁。
  const CALL = /\bconversations\s*\??\.\s*search\s*\(/

  it('server/ 底下只有防腐層可以呼叫 client.conversations.search()', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.name.endsWith('.ts')) continue
        const rel = full.replace(ROOT, '').split('\\').join('/').replace(/^\//, '')
        if (rel === ALLOWED) continue
        if (CALL.test(stripNonCode(readFileSync(full, 'utf8')))) offenders.push(rel)
      }
    }
    walk(resolve(ROOT, 'server'))
    expect(offenders).toEqual([])
  })

  it('防腐層本身送出的是 offset，不是 skip', () => {
    const source = readFileSync(resolve(ROOT, ALLOWED), 'utf8')
    expect(source).toContain("url.searchParams.set('offset'")
    expect(source).not.toContain("url.searchParams.set('skip'")
  })

  it('⚠️ 這支守衛本身是有效的 —— 抓得到真呼叫，且不會被註解或字串騙', () => {
    expect(CALL.test(stripNonCode('await client.conversations.search({})'))).toBe(true)
    expect(CALL.test(stripNonCode('// 見 conversations.search() 的說明'))).toBe(false)
    expect(CALL.test(stripNonCode('/* conversations.search() 已被防腐層取代 */'))).toBe(false)
    // business-unit.ts:59 就是這一種 —— 錯誤訊息的字串裡提到它
    expect(CALL.test(stripNonCode("throw new Error('無法組出 conversations.search() 的查詢範圍')"))).toBe(false)
  })
})
