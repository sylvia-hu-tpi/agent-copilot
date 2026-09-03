/**
 * 建議卡的引用標示與「已更新」提示 —— specs/004-progressive-citations FR-002、FR-007、契約 §3。
 *
 * ⚠️ 這裡驗的是**轉移推導**：伺服器送的是「現在的狀態」，而「剛剛換過」是消費端的概念。
 *    做成事件旗標的話，重連快照送同一份狀態時也會帶著它，客服一連上線就看到
 *    「已更新為有 SOP 依據的版本」——而什麼都沒發生（case ③ 就是在守這件事）。
 *
 * ⚠️ 與 `copilot-retry-all.test.ts` 同樣必須放在 `test/nuxt/`（它載入 `app/composables/`），
 *    理由見 `tsconfig.scripts.json` 檔尾的警告。
 */

import { computed, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SuggestionBlock, SuggestionCard } from '../../shared/types/copilot'
import type { CopilotEvent } from '../../shared/types/events'

const ROOT = resolve(import.meta.dirname, '../..')

let useCopilotSession: typeof import('../../app/composables/useCopilotSession.js')['useCopilotSession']
let handlers: Array<(evt: CopilotEvent) => void>

beforeEach(async () => {
  handlers = []
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({}))
  vi.stubGlobal('onMounted', (fn: () => void) => fn())
  vi.stubGlobal('onBeforeUnmount', () => {})
  vi.stubGlobal('useStreamStore', () => ({
    connect: () => {},
    on: (fn: (evt: CopilotEvent) => void) => {
      handlers.push(fn)
      return () => {}
    },
  }))

  ;({ useCopilotSession } = await import('../../app/composables/useCopilotSession.js'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const CARD: SuggestionCard = {
  id: 'card-1',
  sopId: null,
  sopTitle: null,
  text: '建議先向客戶致歉',
  confidence: null,
  rationale: 'r',
  tone: 'apologetic',
  requiresData: [],
  supersededBy: null,
}

function block(overrides: Partial<SuggestionBlock> = {}): SuggestionBlock {
  return {
    status: 'ready',
    cards: [CARD],
    knowledgeSearch: { ran: true, hitCount: 0 },
    citation: 'none',
    basedOnMessageId: 'm_1',
    provenance: { stage: 1, stage1RetryAttempt: 0 },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function emit(conversationId: string, suggestion: SuggestionBlock): void {
  for (const fn of handlers) fn({ type: 'suggestion.updated', conversationId, suggestion })
}

describe('FR-007：pending → cited 的轉移才觸發提示', () => {
  it('① ready/pending（有卡）→ ready/cited → suggestionCitedAt 有值', () => {
    const session = useCopilotSession(ref('c1'))

    emit('c1', block({ citation: 'pending' }))
    expect(session.suggestionCitedAt.value).toBeNull()

    emit('c1', block({ citation: 'cited', knowledgeSearch: { ran: true, hitCount: 2 } }))
    expect(session.suggestionCitedAt.value).not.toBeNull()
  })

  it('③ 首個事件就是 ready/cited（重連快照）→ MUST NOT 觸發', () => {
    const session = useCopilotSession(ref('c1'))

    // 快照前 `prev` 是空 block（`cards.length === 0`）——這正是排除快照的判準
    emit('c1', block({ citation: 'cited' }))
    expect(session.suggestionCitedAt.value).toBeNull()
  })

  it('④ cited 之後收到新一批的 analyzing → 立即清除', () => {
    const session = useCopilotSession(ref('c1'))

    emit('c1', block({ citation: 'pending' }))
    emit('c1', block({ citation: 'cited' }))
    expect(session.suggestionCitedAt.value).not.toBeNull()

    emit('c1', block({ status: 'analyzing', citation: 'cited' }))
    expect(session.suggestionCitedAt.value).toBeNull()
  })

  it('新一輪的第二段又在跑（citation 回到 pending）→ 同樣清除', () => {
    const session = useCopilotSession(ref('c1'))

    emit('c1', block({ citation: 'pending' }))
    emit('c1', block({ citation: 'cited' }))
    emit('c1', block({ citation: 'pending' }))

    expect(session.suggestionCitedAt.value).toBeNull()
  })

  it('cited → cited（同一批又被推了一次）MUST NOT 重複觸發', () => {
    const session = useCopilotSession(ref('c1'))

    emit('c1', block({ citation: 'pending' }))
    emit('c1', block({ citation: 'cited' }))
    const first = session.suggestionCitedAt.value

    emit('c1', block({ citation: 'cited' }))
    expect(session.suggestionCitedAt.value).toBe(first)
  })

  it('別的對話的事件一律忽略', () => {
    const session = useCopilotSession(ref('c1'))

    emit('c1', block({ citation: 'pending' }))
    emit('c2', block({ citation: 'cited' }))

    expect(session.suggestionCitedAt.value).toBeNull()
    expect(session.suggestions.value.citation).toBe('pending')
  })
})

/**
 * ⑤ 與 ② 走原始碼掃描而非掛載渲染：`SuggestionList.vue`／`SuggestionCard.vue` 都依賴
 * Nuxt 的自動 import（`UIcon`、`useI18n`），在這個測試環境掛載它們要造一整套 stub，
 * 換來的仍只是「字串有沒有出現」等級的斷言。畫面本身的驗收在 quickstart 的手動場景。
 */
describe('FR-002／FR-007：元件確實用到了對應的文案與可及性屬性', () => {
  const list = readFileSync(resolve(ROOT, 'app/components/copilot/SuggestionList.vue'), 'utf8')
  const card = readFileSync(resolve(ROOT, 'app/components/copilot/SuggestionCard.vue'), 'utf8')

  it('⑤ 列表標頭用 citationPending 文案，卡片來源列在 pending 時用 noKnowledgeRefPending', () => {
    expect(list).toContain('copilot.suggestion.citationPending')
    expect(card).toContain('copilot.suggestion.noKnowledgeRefPending')
    // 既有文案不得被取代 —— 「未」與「尚未」是兩種不同的事實（憲法 8.5）
    expect(card).toContain('copilot.suggestion.noKnowledgeRef')
  })

  it('② 提示列 5 秒後自動淡出，且 citedAt 變回 null 時立即隱藏', () => {
    expect(list).toContain('CITED_CUE_MS = 5_000')
    // prop 變化時先 clearTimeout 再依新值決定 —— 少了這一步，舊計時器會把新提示提前關掉
    expect(list).toContain('clearTimeout(cueTimer)')
  })

  it('提示是圖示＋文字且為 role="status"（憲法 8.1、契約 §3）', () => {
    expect(list).toContain('copilot.suggestion.citedUpdated')
    expect(list).toContain('role="status"')
    expect(list).toContain('aria-live="polite"')
    expect(list).toContain('i-lucide-book-check')
  })

  /**
   * ⚠️ 命題不變、機制改了（2026-09-01）：先前靠常駐按鈕的 `disabled` 表達「現在不能重試」，
   *    現在畫布 2a 讓它在非 error 時**不存在**。對本測試要守的事情來說後者更強 ——
   *    第二段引用還在 pending 時 `status` 是 `ready`，按鈕根本不會被渲染出來。
   */
  it('重試按鈕的可按條件不變 —— pending 期間 MUST NOT 出現可按的重試（FR-024）', () => {
    expect(list).toContain(`v-if="block.status === 'error'"`)
    expect(list).not.toContain(`:disabled="block.status !== 'error'"`)
  })
})
