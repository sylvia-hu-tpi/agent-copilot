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
import type { CopilotEvent } from '../shared/types/events.js'

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
