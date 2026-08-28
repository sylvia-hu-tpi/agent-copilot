/**
 * SC-001 的自動化版本 —— specs/003-analysis-trigger-policy。
 *
 * > AI 完全不可用且對話無新發言時，10 分鐘內分析嘗試不超過 1 輪
 * > （對照 2026-08-27 真實環境的現況：約 30 輪、逾 600 次呼叫）。
 *
 * 這裡把那一晚的情境**整條**接起來重現：恆失敗的 AI ＋ 已 JOIN 的對話 ＋ 每 20 秒一次的
 * presence 心跳（30 次 ≈ 10 分鐘），然後數 AI 到底被呼叫幾次。
 *
 * ⚠️ **兩道防線分開驗，缺一不可**：
 *   ① 心跳去重（不變式 A）——心跳根本不該走到 `attach()`。
 *   ② 失敗批次記憶（不變式 B）——**即使**有別的路徑硬是觸發了 attach（重連、切前景／背景），
 *      同一批也不會再被自動分析。
 *   只有 ① 的話，任何一條沒想到的 attach 路徑都會讓出血重新開始；
 *   只有 ② 的話，每次心跳仍然白跑一趟快照與補跑判斷。
 *
 * ⚠️ 不使用真實計時：心跳以直接呼叫 `watch()` 模擬。時間本身不是這條規則的一部分，
 *    「每 20 秒一次」只是心跳的頻率 —— 驗的是「相同參數的第 N 次 watch 沒有副作用」。
 *
 * ⚠️ 為何不透過 `test/mock-gateway.ts`：本規格的故障注入點是 **AIProvider**（`setAIProvider()`
 *    注入），不是 iMBrace gateway；而真實 HTTP／SSE 那一層由 `npm run smoke:realtime`
 *    涵蓋（T044）。在這裡多起一個假 gateway 只會多一層與待驗規則無關的機件。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createWatchRegistry } from '../server/utils/stream-control.js'
import {
  newCustomerMessagesSince,
  runColdStart,
  runIncremental,
} from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { AIProviderHttpError } from '../server/services/ai/retry-policy.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import type { Message } from '../shared/types/conversation.js'

/** 每 20 秒一次的 presence 心跳，10 分鐘 = 30 次 */
const HEARTBEATS_IN_TEN_MINUTES = 30

let seq = 0

function customer(convId: string, text: string): Message {
  seq++
  return {
    id: `m_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - 1000 * (1000 - seq)).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text,
  }
}

/**
 * AI 端點恆回錯誤。
 *
 * ⚠️ 用 400（permanent）而非 500（transient）**是刻意的**：500 會走完 001 FR-014 的
 *    單輪重試預算（1s→4s 退避、最長 40 秒），三個區塊加起來讓這支測試變成分鐘級。
 *    本規格處理的是「**那一輪用盡之後**的政策」，FR-014 本身一行未動，
 *    退避與預算由 test/ai-retry-policy.test.ts 涵蓋。這裡數的是「跑了幾輪」，
 *    一輪內部重試幾次不影響任何一條斷言。
 */
function brokenAI(): { calls: () => number } {
  let calls = 0
  const fail = (): Error => {
    calls++
    return new AIProviderHttpError('bad request', 400)
  }
  setAIProvider(new MockAIProvider({
    summarizeFailure: fail,
    sentimentFailure: fail,
    suggestFailure: fail,
  }))
  return { calls: () => calls }
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
})

describe('SC-001：AI 全故障 ＋ 無新發言時，10 分鐘內分析嘗試不超過 1 輪', () => {
  it('30 次心跳（≈10 分鐘）之後，AI 呼叫次數與第 1 輪結束時完全相同', async () => {
    const id = `conv-sc001-${Date.now()}`
    const history = [customer(id, '我的訂單一直沒出貨'), customer(id, '可以幫我查一下嗎')]
    const ai = brokenAI()

    // 這條 SSE 連線的監看註冊表，attach 走的是 stream.get.ts 的那條路徑（見下）
    let attachCount = 0
    const watchers = createWatchRegistry(async (conversationId, priority, joined) => {
      attachCount++
      await resumeLikeStreamAttach(conversationId, priority, joined, history)
      return () => {}
    })

    // ① 客服按下 JOIN → 冷啟動一輪（三個區塊各一次，全部失敗）
    await runColdStart(id, history, false)
    await watchers.watch(id, 'foreground', true)

    const afterFirstRound = ai.calls()
    expect(afterFirstRound).toBeGreaterThan(0)
    expect(attachCount).toBe(1)

    // ② 客服把畫面放著不動 10 分鐘 —— 每 20 秒一次、參數完全相同的心跳
    for (let i = 0; i < HEARTBEATS_IN_TEN_MINUTES; i++) {
      await watchers.watch(id, 'foreground', true)
    }

    // 防線①：心跳連 attach 都沒走到
    expect(attachCount).toBe(1)
    // 呼叫量完全沒有增加 —— 這一句就是 SC-001
    expect(ai.calls()).toBe(afterFirstRound)

    const state = await useStateStore().getAnalysisState(id)
    expect(state?.summaryBlock.status).toBe('error')
    expect(state?.sentimentBlock.status).toBe('error')
    expect(state?.suggestionBlock.status).toBe('error')
  })

  it('防線②：就算 30 次 attach 全部真的跑了（切前景／切背景交替），呼叫量一樣不增加', async () => {
    const id = `conv-sc001-attach-${Date.now()}`
    const history = [customer(id, '請問退款進度')]
    const ai = brokenAI()

    let attachCount = 0
    const watchers = createWatchRegistry(async (conversationId, priority, joined) => {
      attachCount++
      await resumeLikeStreamAttach(conversationId, priority, joined, history)
      return () => {}
    })

    await runColdStart(id, history, false)
    const afterFirstRound = ai.calls()

    // ⚠️ 交替 foreground／background —— 每一次都是「真實變化」，因此每一次都會 attach。
    //    這模擬的是客服反覆切換分頁，或任何我們還沒想到的 attach 路徑。
    for (let i = 0; i < HEARTBEATS_IN_TEN_MINUTES; i++) {
      await watchers.watch(id, i % 2 === 0 ? 'background' : 'foreground', true)
    }

    expect(attachCount).toBe(HEARTBEATS_IN_TEN_MINUTES)
    // attach 真的跑了 30 次，但失敗批次記憶讓每一次都在呼叫 AI 之前就 return
    expect(ai.calls()).toBe(afterFirstRound)
  })

  it('對照組：客戶說了新的一句話 → 才會（也應該）再跑一輪（FR-007 自癒）', async () => {
    const id = `conv-sc001-heal-${Date.now()}`
    const history = [customer(id, '我要取消訂單')]
    const ai = brokenAI()

    await runColdStart(id, history, false)
    const afterFirstRound = ai.calls()

    for (let i = 0; i < HEARTBEATS_IN_TEN_MINUTES; i++) {
      await runIncremental(id, history, 'foreground', false)
    }
    expect(ai.calls()).toBe(afterFirstRound)

    // 客戶再說一句 → 新的一批 → 再試一輪。這正是「不做自動退避重試」能夠成立的前提。
    history.push(customer(id, '有人在嗎'))
    await runIncremental(id, history, 'foreground', false)
    expect(ai.calls()).toBeGreaterThan(afterFirstRound)
  })
})

/**
 * `server/api/stream.get.ts` 的 `attach()` 中與分析有關的那一段：
 * 送快照 → 挑出尚未涵蓋的客戶發言 → 補跑（`sendAnalysisSnapshotAndResume()`）。
 *
 * ⚠️ 這段刻意「照抄行為」而不是 import：`stream.get.ts` 用了 Nitro auto-import，
 *    vitest 無法直接載入它（比照 test/stream-reconnect-background.test.ts 的既有慣例）。
 *    真實那一條路徑由 `npm run smoke:realtime` 涵蓋。
 *
 * ⚠️ 分析失敗時 `sentimentBlock.timeline` **不推進** —— 因此每次 attach 都會判定
 *    「這些客戶發言尚未涵蓋」而補跑。那正是 2026-08-27 缺陷鏈的最後一環，
 *    也是為什麼光靠「補跑判斷」擋不住出血、必須有失敗批次記憶。
 */
async function resumeLikeStreamAttach(
  conversationId: string,
  priority: 'foreground' | 'background',
  joined: boolean,
  history: Message[],
): Promise<void> {
  if (!joined) return
  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state) return
  const unseen = newCustomerMessagesSince(state, history)
  if (unseen.length > 0) await runIncremental(conversationId, unseen, priority, false)
}
