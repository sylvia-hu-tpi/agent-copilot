/**
 * 「全部重試」—— specs/003-analysis-trigger-policy FR-018、FR-019、契約 1.2。
 *
 * ⚠️ **MUST NOT** 併進 `copilot-panel-collapse.test.ts` —— 檔名與內容不符，日後找不到。
 *
 * ⚠️ 與該檔同樣必須放在 `test/nuxt/`（它載入 `app/composables/`），
 *    理由見 `tsconfig.scripts.json` 檔尾的警告。
 */

import { computed, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SentimentBlock, SuggestionBlock, SummaryBlock } from '../../shared/types/copilot'

const ROOT = resolve(import.meta.dirname, '../..')

const fetchMock = vi.fn()

let useCopilotSession: typeof import('../../app/composables/useCopilotSession.js')['useCopilotSession']

beforeEach(async () => {
  fetchMock.mockReset().mockResolvedValue({})
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('onMounted', () => {})
  vi.stubGlobal('onBeforeUnmount', () => {})
  vi.stubGlobal('useStreamStore', () => ({ connect: () => {}, on: () => () => {} }))

  ;({ useCopilotSession } = await import('../../app/composables/useCopilotSession.js'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

type Session = ReturnType<typeof useCopilotSession>

/** 直接把三個區塊擺成想要的狀態 —— 這幾條規則只跟 `status` 有關 */
function withStatuses(
  session: Session,
  statuses: { summary: SummaryBlock['status'], sentiment: SentimentBlock['status'], suggestions: SuggestionBlock['status'] },
): void {
  session.summary.value = { ...session.summary.value, status: statuses.summary }
  session.sentiment.value = { ...session.sentiment.value, status: statuses.sentiment }
  session.suggestions.value = { ...session.suggestions.value, status: statuses.suggestions }
}

/** 這一輪送出的 retry 請求分別針對哪些區塊 */
function requestedBlocks(): string[] {
  return fetchMock.mock.calls.map(([, init]) => (init as { body: { block: string } }).body.block)
}

describe('FR-018：只對 error 的區塊發出請求', () => {
  it('三個都是 error → 三個都重試', async () => {
    const session = useCopilotSession(ref('c1'))
    withStatuses(session, { summary: 'error', sentiment: 'error', suggestions: 'error' })

    await session.retryAll()

    expect(requestedBlocks().sort()).toEqual(['sentiment', 'suggestions', 'summary'])
  })

  /**
   * ⚠️ **已成功的區塊 MUST NOT 被重跑。** 送過去只會拿到 409（端點在非 error 狀態時就是這樣回），
   *    等於白打一趟；更重要的是客服會看到已經好了的區塊莫名其妙又轉成「分析中」。
   */
  it('只有其中一個是 error → 只重試那一個', async () => {
    const session = useCopilotSession(ref('c1'))
    withStatuses(session, { summary: 'ready', sentiment: 'error', suggestions: 'ready' })

    await session.retryAll()

    expect(requestedBlocks()).toEqual(['sentiment'])
  })

  it('沒有任何 error → 一個請求都不送', async () => {
    const session = useCopilotSession(ref('c1'))
    withStatuses(session, { summary: 'ready', sentiment: 'analyzing', suggestions: 'empty' })

    await session.retryAll()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('analyzing／retrying／empty 都不算 error，不會被掃進來', async () => {
    const session = useCopilotSession(ref('c1'))
    withStatuses(session, { summary: 'analyzing', sentiment: 'retrying', suggestions: 'empty' })

    await session.retryAll()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('FR-019：按鈕的可按條件', () => {
  it('hasError 為「三個區塊之中有沒有 error」', () => {
    const session = useCopilotSession(ref('c1'))

    withStatuses(session, { summary: 'ready', sentiment: 'ready', suggestions: 'ready' })
    expect(session.hasError.value).toBe(false)

    withStatuses(session, { summary: 'ready', sentiment: 'ready', suggestions: 'error' })
    expect(session.hasError.value).toBe(true)
  })

  /**
   * 「全部重試」**只在有區塊失敗時才出現**（畫布 2a 的 `sc-if anyError`，
   * 2026-09-01 使用者裁定改回畫布做法）。
   *
   * ⚠️ 先前這裡守的是相反的規則（常駐但 `disabled` ＋ `aria-disabled`，理由是憲法 8.1
   *    「不可按狀態不得只靠降低對比度表達」）。改判的理由：憲法 8.1 管的是
   *    **已經在畫面上的控制項**，而這顆按鈕本身就是「現在有東西壞了」的訊號 ——
   *    常駐會讓那個訊號永遠亮著而失去意義。沒有失敗區塊時它沒有任何語意，
   *    讓它不存在比讓它灰著更誠實。
   *
   * ⚠️ 因此 `disabled` MUST NOT 回來：一旦它常駐，這個訊號就失效了。
   */
  it('只在 hasError 時渲染，且沒有常駐的 disabled 版本（2026-09-01 改判）', () => {
    const source = readFileSync(resolve(ROOT, 'app/components/copilot/PanelHeader.vue'), 'utf8')
    const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
    expect(template).toContain('v-if="hasError"')
    expect(template).not.toContain(':disabled="!hasError"')
    expect(template).not.toContain(':aria-disabled="!hasError"')
  })

  it('兩個按鈕都是原生 <button>，因此可鍵盤操作（憲法 8.2）', () => {
    const source = readFileSync(resolve(ROOT, 'app/components/copilot/PanelHeader.vue'), 'utf8')
    const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
    expect(template.match(/<button/g) ?? []).toHaveLength(2)
    // 可點的東西不可以是 <div>／<span> —— 那些拿不到焦點，鍵盤使用者永遠按不到
    expect(template).not.toMatch(/<(div|span)[^>]*@click/)
  })
})

describe('契約 1.2：不新增端點、不讓 block 接受陣列', () => {
  it('打的是既有的單區塊端點，body 是單一 block 字串', async () => {
    const session = useCopilotSession(ref('c1'))
    withStatuses(session, { summary: 'error', sentiment: 'error', suggestions: 'ready' })

    await session.retryAll()

    for (const [path, init] of fetchMock.mock.calls) {
      expect(path).toBe('/api/conversations/c1/copilot/retry')
      const body = (init as { method: string, body: { block: unknown } })
      expect(body.method).toBe('POST')
      expect(typeof body.body.block).toBe('string')
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('程式碼裡不存在 retry-all 端點（註解不算 —— 那裡正是在寫「不准新增」）', () => {
    const source = readFileSync(resolve(ROOT, 'app/composables/useCopilotSession.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toContain('retry-all')
    expect(source).toContain('/copilot/retry')
  })
})

/**
 * FR-019 的另一半 —— **各區塊自身的重試按鈕未被加上任何互鎖邏輯**。
 *
 * 按下「全部重試」後，區塊自己的 `disabled` 條件 MUST 仍然只看 `status`，
 * 不看「全部重試是否在進行中」。既有的「僅 error 可按」規則已經足夠：
 * 區塊一轉 `analyzing`，按鈕就自然失效了。
 *
 * ⚠️ 這一項也順帶守住「**刻意不做樂觀 disable**」（research.md 決策 7）：
 *    往返期間按鈕仍可按是預期行為，重複按下由 FR-009 的同區塊併發去重吸收。
 */
/**
 * FR-019：各區塊的重試入口只看自己的 `block.status`。
 *
 * ⚠️ **2026-09-01 改判了「怎麼表達不可用」，但「不互鎖」這個命題沒變。**
 *    先前的規則是「常駐但 `disabled`」（CHK033），現在畫布 2a 的三個區塊在
 *    非 error 時**根本沒有這顆按鈕** —— 與同日對 header「全部重試」的裁示同一個理由：
 *    按鈕本身就是「這一塊壞了」的訊號，常駐會讓訊號永遠亮著而失去意義。
 *    ⚠️ `:disabled="block.status !== 'error'"` MUST NOT 回來。
 *
 * ⚠️ 這裡守的**真正命題**是「條件只引用自己的 `block.status`」——
 *    一旦哪天有人把「全部重試進行中」之類的共用旗標混進條件，一塊失敗就會連坐其他塊，
 *    而那不會有型別錯誤，畫面上也只是按鈕少出現一顆，幾乎不可能在 review 時被看見。
 */
describe('FR-019：各區塊的重試按鈕沒有互鎖', () => {
  const BLOCK_COMPONENTS = ['SummaryCard.vue', 'SentimentGauge.vue', 'SuggestionList.vue']

  it.each(BLOCK_COMPONENTS)('%s 的重試入口只在自己 error 時出現，且不吃共用旗標', (file) => {
    const source = readFileSync(resolve(ROOT, 'app/components/copilot', file), 'utf8')
    expect(source).toContain(`v-if="block.status === 'error'"`)
    expect(source).not.toContain(`:disabled="block.status !== 'error'"`)
    // 沒有任何「全部重試進行中」之類的旗標混進來
    expect(source).not.toMatch(/retryAll|retryingAll|allRetrying/)
  })
})
