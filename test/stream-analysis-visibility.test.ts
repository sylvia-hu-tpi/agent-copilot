/**
 * 未 JOIN 的連線收不到分析事件 —— specs/003-analysis-trigger-policy
 * 契約不變式 C、FR-003、FR-016a、SC-006。
 *
 * > 客服未 JOIN 某對話時：右側面板 MUST 不存在，且伺服器 MUST NOT 把該對話的三個分析事件
 * > 送給這條連線。**中欄所需的其餘事件 MUST 不受影響。**
 *
 * ⚠️ **「送給這條連線」有兩條路徑，兩條都要擋**：
 *   ① 即時推播 → `forward()`
 *   ② **連線建立時的分析快照** → `sendAnalysisSnapshotAndResume()` 裡的 `send()`，
 *      **不經 `forward()`**
 *
 *   ② 最容易漏。漏掉的症狀：未接手的客服一連上線就收到完整三個 Block ——
 *   畫面上雖然沒有面板，資料已經在他的瀏覽器裡，SC-006 在伺服器端這一層並不成立。
 *   FR-003 補上「僅限已 JOIN」限定語就是為此。
 *
 * ⚠️ 只在前端不渲染是不夠的：分析結果仍會持續推到這條連線並更新前端 store，
 *    重新 JOIN 或切換對話時可能閃出一份「不知何時來的」舊內容 —— 極難重現、極難追查。
 */

import { describe, expect, it, vi } from 'vitest'
import { createWatchRegistry, shouldForwardToConnection } from '../server/utils/stream-control.js'
import {
  awaitSuggestionTail,
  hasSuggestionTail,
  recoverColdStart,
  runColdStart,
  settleOrphanedPendingCitation,
} from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import type { CopilotEvent } from '../shared/types/events.js'
import type { Message } from '../shared/types/conversation.js'

const ANALYSIS_EVENTS: Array<CopilotEvent['type']> = [
  'summary.updated',
  'sentiment.updated',
  'suggestion.updated',
]

/**
 * ⚠️ **這份清單就是契約表格本身**（不變式 C）。多擋一個都會出事：
 *    `stream.heartbeat` 被擋掉會讓中間 proxy 在 60 秒無資料時直接切斷連線，
 *    症狀是「放著不動一分鐘後就再也收不到訊息」。
 */
const MUST_ALWAYS_FORWARD: Array<CopilotEvent['type']> = [
  'messages.appended',
  'presence.updated',
  'control.updated',
  'conversation.updated',
  'session.opened',
  'session.closed',
  'stream.heartbeat',
]

describe('不變式 C ①：即時推播的過濾範圍（forward()）', () => {
  it('未 JOIN → 三個分析事件全部被擋', () => {
    for (const type of ANALYSIS_EVENTS) {
      expect(shouldForwardToConnection(type, false)).toBe(false)
    }
  })

  it('已 JOIN → 三個分析事件照送', () => {
    for (const type of ANALYSIS_EVENTS) {
      expect(shouldForwardToConnection(type, true)).toBe(true)
    }
  })

  it('其餘事件一律照送，與 JOIN 無關 —— 中欄一切照常（US2 AC#3）', () => {
    for (const type of MUST_ALWAYS_FORWARD) {
      expect(shouldForwardToConnection(type, false)).toBe(true)
      expect(shouldForwardToConnection(type, true)).toBe(true)
    }
  })

  it('過濾範圍**恰為**三個分析事件，一個不多一個不少', () => {
    const blocked = [...ANALYSIS_EVENTS, ...MUST_ALWAYS_FORWARD]
      .filter(type => !shouldForwardToConnection(type, false))
    expect(blocked.sort()).toEqual([...ANALYSIS_EVENTS].sort())
  })
})

/**
 * 不變式 C ②：連線建立時的分析快照。
 *
 * ⚠️ `stream.get.ts` 用了 Nitro auto-import，vitest 無法直接 import 它。
 *    這裡用一支結構相同的 `attach()`（門檻條件寫在同一個位置）驗證組合行為；
 *    真實那條路徑由 `npm run smoke:realtime` 涵蓋（T044）。
 */
describe('不變式 C ②：連線建立時的分析快照', () => {
  interface Sent { type: string }

  /** `stream.get.ts` 的 `attach()` 中與分析可見性有關的那一段 */
  function makeAttach(sent: Sent[], resumed: string[]) {
    return async (conversationId: string, _priority: 'foreground' | 'background', joined: boolean) => {
      // 這兩件事對所有連線都做 —— 中欄需要，與 JOIN 無關
      sent.push({ type: 'control.updated' })
      sent.push({ type: 'presence.updated' })

      // ⚠️ 未 JOIN 時**整段跳過**（連 runIncremental() 的補跑一併跳過）
      if (joined) {
        sent.push({ type: 'summary.updated' })
        sent.push({ type: 'sentiment.updated' })
        sent.push({ type: 'suggestion.updated' })
        resumed.push(conversationId)
      }
      return () => {}
    }
  }

  it('未 JOIN 的連線 attach 當下：三個 Block 一個都不送，也不觸發補跑', async () => {
    const sent: Sent[] = []
    const resumed: string[] = []
    const watchers = createWatchRegistry(makeAttach(sent, resumed))

    await watchers.watch('conv_x', 'foreground', false)

    expect(sent.map(s => s.type)).toEqual(['control.updated', 'presence.updated'])
    // ⚠️ 補跑也要跳過 —— 它會呼叫 AI，未 JOIN 的對話不該為此付出任何成本
    expect(resumed).toEqual([])
  })

  it('已 JOIN 的連線照舊立即收到快照（001 FR-010 不得退步，FR-003）', async () => {
    const sent: Sent[] = []
    const resumed: string[] = []
    const watchers = createWatchRegistry(makeAttach(sent, resumed))

    await watchers.watch('conv_x', 'foreground', true)

    expect(sent.map(s => s.type)).toEqual([
      'control.updated',
      'presence.updated',
      'summary.updated',
      'sentiment.updated',
      'suggestion.updated',
    ])
    expect(resumed).toEqual(['conv_x'])
  })

  it('JOIN 之後的第一次 watch 會補送快照 —— 面板一出現就有內容', async () => {
    const sent: Sent[] = []
    const resumed: string[] = []
    const watchers = createWatchRegistry(makeAttach(sent, resumed))

    await watchers.watch('conv_x', 'foreground', false)
    sent.length = 0

    // 按下接手 → joined 由 false 變 true → 真實變化 → 重新 attach
    await watchers.watch('conv_x', 'foreground', true)

    expect(sent.map(s => s.type)).toContain('summary.updated')
    expect(resumed).toEqual(['conv_x'])
  })
})

describe('兩條路徑都擋才算數（只擋一條等於沒擋）', () => {
  /**
   * 這一項是整份契約的關鍵：快照走 `send()`、**不經 `forward()`**。
   * 只在 `forward()` 加過濾，未接手的客服仍會在連線當下拿到完整三個 Block。
   */
  it('只有 forward() 過濾、快照沒擋 → 未 JOIN 的連線仍會收到三個 Block（反例）', async () => {
    const sent: Array<CopilotEvent['type']> = []
    // ⚠️ 刻意寫成「忘了擋快照」的版本，用來證明這支測試抓得出那個漏洞
    const watchers = createWatchRegistry(async () => {
      for (const type of ANALYSIS_EVENTS) sent.push(type)
      return () => {}
    })

    await watchers.watch('conv_x', 'foreground', false)

    // forward() 的過濾對這條路徑完全無效 —— 事件根本沒經過它
    const survived = sent.filter(type => !shouldForwardToConnection(type, false))
    expect(survived).toHaveLength(3)
  })

  it('心跳不重新 attach，因此也不會重複送快照（不變式 A ✕ C 的交互作用）', async () => {
    const attach = vi.fn(async () => () => {})
    const watchers = createWatchRegistry(attach)

    await watchers.watch('conv_x', 'foreground', true)
    for (let i = 0; i < 10; i++) await watchers.watch('conv_x', 'foreground', true)

    expect(attach).toHaveBeenCalledTimes(1)
  })
})

/**
 * 契約 §4（004）：重連快照對 `citation: 'pending'` 的補正。
 *
 * ⚠️ `'pending'` 的意思是「第二段還在跑」，而尾巴是**執行期**狀態（`suggestionTails`），
 *    程序重啟就消失；`CopilotAnalysisState` 卻有 2 小時 sliding TTL 會活下來。
 *    重啟後那個 `'pending'` 沒有任何路徑會再落定它 —— 客服永遠看到「檢索中」，
 *    而 `status` 是 `ready`、卡片可用，**沒有任何錯誤跡象**。
 *
 * ⚠️ 修正 MUST 放在快照路徑，不是 `forward()`：快照走 `send()`、不經即時推播那條路，
 *    放錯地方對快照完全無效（003 踩過同一個陷阱，見本檔開頭）。
 */
describe('契約 §4：重連快照不得送出無人接手的 pending（004 T018）', () => {
  /** `sendAnalysisSnapshotAndResume()` 裡與 `citation` 有關的那一段 */
  async function snapshotSuggestion(conversationId: string) {
    let state = (await useStateStore().getAnalysisState(conversationId))!
    if (state.suggestionBlock.citation === 'pending' && !hasSuggestionTail(conversationId)) {
      state = await settleOrphanedPendingCitation(conversationId)
    }
    return state.suggestionBlock
  }

  it('pending 且無尾巴（程序重啟後的孤兒）→ 送出的是 none，且已寫回狀態', async () => {
    const id = `conv-orphan-pending-${Date.now()}`
    await useStateStore().setAnalysisState({
      conversationId: id,
      summaryBlock: { status: 'empty', summary: null, updatedAt: '' },
      sentimentBlock: { status: 'empty', timeline: [], stats: { lowestScore: null, lowestAt: null }, narrative: null, updatedAt: '' },
      suggestionBlock: {
        status: 'ready',
        cards: [],
        knowledgeSearch: { ran: true, hitCount: 0 },
        citation: 'pending',
        basedOnMessageId: 'm_1',
        provenance: { stage: 1, stage1RetryAttempt: 0 },
        updatedAt: '',
      },
    }, 60_000)

    expect(hasSuggestionTail(id)).toBe(false)
    expect((await snapshotSuggestion(id)).citation).toBe('none')

    // ⚠️ MUST 真的寫回：只在送出前改一份複本的話，下一次重連又會是 pending
    const persisted = await useStateStore().getAnalysisState(id)
    expect(persisted!.suggestionBlock.citation).toBe('none')
    // 卡片不動 —— 它們是第一段的真實產出，只是永遠不會有第二段了
    expect(persisted!.suggestionBlock.cards).toEqual([])
  })

  it('有尾巴在跑 → 照送 pending（尾巴落地時會再推一次）', async () => {
    vi.useFakeTimers()
    const id = `conv-live-pending-${Date.now()}`
    setKnowledgeProvider(new MockKnowledgeProvider({ searchDelayMs: 5_000 }))
    setAIProvider(new MockAIProvider())

    await runColdStart(id, [{
      id: 'm_live_1',
      conversationId: id,
      at: new Date().toISOString(),
      sender: { type: 'customer', id: 'con_1' },
      text: '我要退貨',
    }], false)

    expect(hasSuggestionTail(id)).toBe(true)
    expect((await snapshotSuggestion(id)).citation).toBe('pending')

    await vi.advanceTimersByTimeAsync(5_000)
    await awaitSuggestionTail(id)
    vi.useRealTimers()
  })
})

/**
 * 重啟復原：已 JOIN 但沒有 `CopilotAnalysisState` 的對話 MUST 補跑冷啟動。
 *
 * ⚠️ 這是 2026-08-28 真實環境撞到四次的缺陷：平台側的 JOIN 是持久的，而
 *    `CopilotAnalysisState` 隨程序消失。兩者不同步時，重連快照原本直接 `return`，
 *    於是**面板永遠空白、沒有日誌、不報錯**——唯一的復原方式是客服自己想到 LEAVE 再 JOIN。
 *    症狀完全沉默，因此非有測試不可。
 */
describe('重啟復原：已 JOIN 但狀態不存在時補跑冷啟動', () => {
  const customer = (id: string, convId: string): Message => ({
    id,
    conversationId: convId,
    at: new Date().toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text: '客戶：我要退貨',
  })

  it('沒有分析狀態 → 補跑冷啟動並建立狀態', async () => {
    const id = `conv-recover-${Date.now()}`
    setAIProvider(new MockAIProvider())
    setKnowledgeProvider(new MockKnowledgeProvider())

    expect(await useStateStore().getAnalysisState(id)).toBeNull()

    await recoverColdStart(id, [customer('m_r1', id)], false)
    await awaitSuggestionTail(id)

    const state = await useStateStore().getAnalysisState(id)
    expect(state).not.toBeNull()
    expect(state!.summaryBlock.status).toBe('ready')
    expect(state!.sentimentBlock.status).toBe('ready')
  })

  it('已經有分析狀態 → MUST NOT 再跑一次（不浪費 AI 呼叫）', async () => {
    const id = `conv-recover-existing-${Date.now()}`
    let summarizeCalls = 0
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        summarizeCalls++
        return super.summarize(input)
      }
    })())
    setKnowledgeProvider(new MockKnowledgeProvider())

    await recoverColdStart(id, [customer('m_r2', id)], false)
    await awaitSuggestionTail(id)
    const after = summarizeCalls
    expect(after).toBeGreaterThan(0)

    await recoverColdStart(id, [customer('m_r2', id)], false)
    expect(summarizeCalls).toBe(after)
  })

  it('同一對話的兩條連線同時復原 → 只跑一次（多分頁不會各付一次 AI 成本）', async () => {
    const id = `conv-recover-race-${Date.now()}`
    let summarizeCalls = 0
    setAIProvider(new (class extends MockAIProvider {
      override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
        summarizeCalls++
        return super.summarize(input)
      }
    })())
    setKnowledgeProvider(new MockKnowledgeProvider())

    const history = [customer('m_r3', id)]
    await Promise.all([
      recoverColdStart(id, history, false),
      recoverColdStart(id, history, false),
    ])
    await awaitSuggestionTail(id)

    expect(summarizeCalls).toBe(1)
  })
})
