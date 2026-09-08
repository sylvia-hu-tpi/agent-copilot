/**
 * 面板可見性與收合偏好 —— specs/003-analysis-trigger-policy FR-016、FR-017、FR-017a、FR-017b，
 * 外加憲法 8.4（面板消失 MUST NOT 帶走 Composer 草稿）。
 *
 * ⚠️ **本檔必須放在 `test/nuxt/`**，不是 tasks.md 寫的 `test/`：它直接載入
 *    `app/composables/useCopilotPanel.ts`，而 `tsconfig.scripts.json`（管 `test/` 的那份）
 *    是 Node 環境、沒有 DOM 也沒有 auto-import 宣告，放在 `test/` 底下 `npm run typecheck`
 *    必紅。`test/nuxt/` 是 Nuxt 預留的目錄，已列在 `.nuxt/tsconfig.app.json` 的 include 裡，
 *    由 `nuxt typecheck` 以**真正的** auto-import 與 DOM 型別檢查
 *    （比照 `test/nuxt/stream-store.test.ts` 的既有慣例與 `tsconfig.scripts.json` 檔尾的警告）。
 */

import { computed, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const PAGE = resolve(ROOT, 'app/pages/c/[conversationId].vue')
const COMPOSABLE = resolve(ROOT, 'app/composables/useCopilotPanel.ts')

/**
 * 只留程式碼，去掉註解 —— 下面幾項驗的是「這個檔案有沒有做某件事」，
 * 而註解裡本來就會把「MUST NOT 做的事」寫出來，不去掉就會自己咬自己。
 */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const fetchMock = vi.fn()

let useCopilotPanel: typeof import('../../app/composables/useCopilotPanel.js')['useCopilotPanel']
let storage: Map<string, string>

beforeEach(async () => {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('$fetch', fetchMock)
  fetchMock.mockReset()

  ;({ useCopilotPanel } = await import('../../app/composables/useCopilotPanel.js'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FR-016：可見性 ⟺ viewerJoined', () => {
  it('未 JOIN → 不可見；JOIN → 可見', () => {
    const joined = ref(false)
    const panel = useCopilotPanel(ref('c1'), joined)

    expect(panel.visible.value).toBe(false)
    joined.value = true
    expect(panel.visible.value).toBe(true)
  })

  /**
   * ⚠️ **MUST NOT 由「三個 Block 是否為 empty」推出可見性。**
   *    JOIN 之後、首次分析完成之前三個 Block 都是 `empty`，但那時面板 MUST 已經在
   *    （客服要看到「分析中」的骨架）。用內容判斷會讓面板晚一拍才出現。
   *
   *    這裡的驗法是：`useCopilotPanel()` 的簽章根本拿不到任何 Block ——
   *    拿不到就寫不出那種判斷。
   */
  it('可見性只吃 viewerJoined —— composable 完全接觸不到區塊內容', () => {
    /*
      ⚠️ 2026-09-04（specs/006）由 2 改為 3：新增第三個參數 `closing`
         —— 「這個對話是否正在結案」的布林 ref，決定面板走 `expanded` 還是
         `closing` 版面（`docs/DESIGN_TOKENS.md` §7.4）。
         **它不是區塊內容**，因此這條守衛要防的事（用 Block 是否 empty 推可見性）
         一點都沒有被放寬 —— 真正在守的是下面那個禁字掃描。
    */
    expect(useCopilotPanel.length).toBe(3)
    const source = codeOnly(COMPOSABLE)
    for (const forbidden of ['summary', 'sentiment', 'suggestion', 'status', 'Block']) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('JOIN 之後立刻可見，不必等任何分析結果', () => {
    const joined = ref(true)
    const panel = useCopilotPanel(ref('c1'), joined)
    expect(panel.visible.value).toBe(true)
  })
})

describe('FR-017a：收合偏好 per 對話，鍵為 ac.copilotCollapsed.{conversationId}', () => {
  it('未存過時預設展開（JOIN 的目的就是要用面板）', () => {
    const panel = useCopilotPanel(ref('c1'), ref(true))
    expect(panel.collapsed.value).toBe(false)
  })

  it('收合後以正確的鍵寫入 localStorage', async () => {
    const panel = useCopilotPanel(ref('c1'), ref(true))
    panel.toggle()
    await Promise.resolve()

    expect(storage.get('ac.copilotCollapsed.c1')).toBe('1')
  })

  it('重新整理（重新建立 composable）後偏好仍在', () => {
    storage.set('ac.copilotCollapsed.c1', '1')
    const panel = useCopilotPanel(ref('c1'), ref(true))
    expect(panel.collapsed.value).toBe(true)
  })

  /**
   * ⚠️ 粒度是**每個對話**：客服對不同對話的依賴程度不同。一份全域偏好會讓
   *    「上一個對話收起來了，下一個也跟著收起來」，而那不是他的意思。
   */
  it('切換對話時重讀該對話自己的偏好，不沿用上一個對話的', async () => {
    storage.set('ac.copilotCollapsed.c1', '1')
    const id = ref('c1')
    const panel = useCopilotPanel(id, ref(true))
    expect(panel.collapsed.value).toBe(true)

    id.value = 'c2' // c2 從未存過 → 展開
    await Promise.resolve()
    expect(panel.collapsed.value).toBe(false)

    id.value = 'c1'
    await Promise.resolve()
    expect(panel.collapsed.value).toBe(true)
  })

  it('localStorage 讀寫拋例外（隱私模式）時降級為預設值，不讓面板崩掉', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
    })
    const panel = useCopilotPanel(ref('c1'), ref(true))
    expect(panel.collapsed.value).toBe(false)
    expect(() => panel.toggle()).not.toThrow()
  })
})

describe('FR-017b：收合是純視覺狀態，與 JOIN 正交', () => {
  it('切換收合 MUST NOT 送出任何請求', async () => {
    const panel = useCopilotPanel(ref('c1'), ref(true))
    panel.toggle()
    panel.toggle()
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('切換收合 MUST NOT 改動 viewerJoined（收起面板 ≠ 離開對話）', () => {
    const joined = ref(true)
    const panel = useCopilotPanel(ref('c1'), joined)

    panel.toggle()
    expect(joined.value).toBe(true)
    expect(panel.visible.value).toBe(true)
  })

  /**
   * ⚠️ 分析排程完全不經過這個 composable —— 它連 import 都沒有。
   *    這是「收合不影響分析」最直接的證據：沒有路徑可以影響它。
   */
  it('composable 完全沒有對外的路徑 —— 沒有 import、沒有 $fetch、沒有心跳', () => {
    const source = codeOnly(COMPOSABLE)
    expect(source).not.toMatch(/^import /m)
    expect(source).not.toContain('$fetch')
    expect(source).not.toContain('beat(')
  })
})

/**
 * 憲法 8.4：**草稿絕不遺失** —— specs/003-analysis-trigger-policy T034。
 *
 * ⚠️ 這裡 MUST 是**自動化斷言而非人工目視**：草稿遺失只在特定卸載路徑下發生
 *    （面板隱藏連帶重建了包住 Composer 的元件），人工驗一次不代表下次改版還成立。
 *
 * ⚠️ 專案沒有 `@vue/test-utils`，無法掛載元件實測卸載行為。因此改為驗**版面結構**：
 *    只要 `ConversationComposer` 不在面板可見性 `v-if` 的子樹裡，面板出現／消失
 *    在結構上就碰不到它。這正是那條失效路徑的成因，因此是有效的守衛而非近似。
 */
describe('憲法 8.4：面板消失 MUST NOT 帶走 Composer 草稿', () => {
  /** 取出面板那個 `<template v-if="…panel.visible…">` 到對應 `</template>` 的整段 */
  function panelSubtree(source: string): string {
    const start = source.indexOf('<template v-if="conversationId && panel.visible.value">')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('</template>', start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('ConversationComposer 不在面板的 v-if 子樹裡', () => {
    const source = readFileSync(PAGE, 'utf8')
    expect(source).toContain('<ConversationComposer')
    expect(panelSubtree(source)).not.toContain('ConversationComposer')
  })

  it('面板的 v-if 也不包住中欄的訊息流與 presence（US2 AC#3：中欄完全不受影響）', () => {
    const subtree = panelSubtree(readFileSync(PAGE, 'utf8'))
    for (const mustStayOutside of [
      'ConversationMessageList',
      'ConversationPresenceBar',
      'ConversationModeSelect',
      'ConversationSidebar',
    ]) {
      expect(subtree).not.toContain(mustStayOutside)
    }
  })

  it('⚠️ 這支守衛本身是有效的 —— 子樹擷取真的抓得到面板的內容', () => {
    // 擷取邏輯壞掉（例如回空字串）時，上面兩項會永遠通過而毫無價值
    const subtree = panelSubtree(readFileSync(PAGE, 'utf8'))
    expect(subtree).toContain('CopilotSummaryCard')
    expect(subtree).toContain('CopilotPanelHeader')
  })
})
