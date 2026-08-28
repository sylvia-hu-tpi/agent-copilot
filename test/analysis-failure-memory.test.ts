/**
 * 失敗批次記憶 —— specs/003-analysis-trigger-policy 契約不變式 B（FR-005～FR-011）。
 *
 * > 同一個 `(區塊, 該批最後一則客戶訊息 id)` 失敗之後，MUST NOT 再被**自動**分析。
 * > 只有三件事能讓它再跑：客服手動重試（FR-008）、出現新的客戶發言而形成新的一批（FR-007）、
 * > 重新 JOIN 走冷啟動（FR-015）。
 *
 * ⚠️ 這條不變式壞掉時的症狀是「一切正常，只是故障期間的呼叫量不降反升」——
 *    而且只有在**真實故障**時才看得出來。因此下面每一項都直接數 AI 被呼叫幾次，
 *    不看狀態欄位（狀態是 error 不代表沒有在背後一直重跑，那正是 2026-08-27 的原始情境）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearFailedBatch,
  markFailedBatch,
  readFailedBatch,
  releaseFailedBatch,
  retryBlock,
  runColdStart,
  runIncremental,
} from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { AIProviderHttpError } from '../server/services/ai/retry-policy.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import type { CopilotAnalysisState } from '../server/state/types.js'
import type { Message } from '../shared/types/conversation.js'

let seq = 0

function customer(convId: string, text = '請問我的訂單呢'): Message {
  seq++
  return {
    id: `m_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - 1000 * seq).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text,
  }
}

function convId(label: string): string {
  return `conv-fbm-${label}-${Date.now()}-${seq}`
}

/** 恆失敗的情緒分析，並記錄被呼叫幾次。400 → permanent，不觸發 001 FR-014 的單輪重試 */
function alwaysFailingSentiment(): { calls: () => number } {
  let calls = 0
  setAIProvider(new MockAIProvider({
    sentimentFailure: () => {
      calls++
      return new AIProviderHttpError('boom', 400)
    },
  }))
  return { calls: () => calls }
}

async function stateOf(id: string): Promise<CopilotAnalysisState | null> {
  return useStateStore().getAnalysisState(id)
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
})

// ── 純存取函式（data-model.md §1）─────────────────────────────────────

describe('readFailedBatch / markFailedBatch / clearFailedBatch / releaseFailedBatch', () => {
  const base: CopilotAnalysisState = {
    conversationId: 'c1',
    summaryBlock: { status: 'empty', summary: null, updatedAt: '2026-08-28T00:00:00.000Z' },
    sentimentBlock: { status: 'empty', timeline: [], stats: { lowestScore: null, lowestAt: null }, updatedAt: '2026-08-28T00:00:00.000Z' },
    suggestionBlock: { status: 'empty', cards: [], knowledgeSearch: { ran: false, hitCount: 0 }, updatedAt: '2026-08-28T00:00:00.000Z' },
  }

  it('從未失敗過時回 null；三個區塊各自獨立', () => {
    const marked = markFailedBatch(base, 'sentiment', 'm_9')
    expect(readFailedBatch(marked, 'sentiment')?.lastMessageId).toBe('m_9')
    expect(readFailedBatch(marked, 'summary')).toBeNull()
    expect(readFailedBatch(marked, 'suggestions')).toBeNull()
  })

  it('同一批再次失敗 → count 遞增；換一批 → count 歸 1', () => {
    const once = markFailedBatch(base, 'summary', 'm_1')
    expect(readFailedBatch(once, 'summary')?.count).toBe(1)

    const twice = markFailedBatch(once, 'summary', 'm_1')
    expect(readFailedBatch(twice, 'summary')?.count).toBe(2)

    const other = markFailedBatch(twice, 'summary', 'm_2')
    expect(readFailedBatch(other, 'summary')).toMatchObject({ lastMessageId: 'm_2', count: 1 })
  })

  it('clearFailedBatch 只清指定區塊，其餘保留', () => {
    const both = markFailedBatch(markFailedBatch(base, 'summary', 'm_1'), 'sentiment', 'm_1')
    const cleared = clearFailedBatch(both, 'summary')
    expect(readFailedBatch(cleared, 'summary')).toBeNull()
    expect(readFailedBatch(cleared, 'sentiment')?.lastMessageId).toBe('m_1')
  })

  /**
   * ⚠️ 放行（`released`）而非刪除，是為了讓 `count` 保得住 ——
   *    `count` 唯一能超過 1 的路徑正是「手動重試也失敗」，刪掉整筆的話它永遠是 1，
   *    與自己的定義互相矛盾（見 FailedBatch.released 的說明）。
   */
  it('releaseFailedBatch 保留 count 但解除門檻；再次失敗時 count 遞增且重新擋住', () => {
    const failed = markFailedBatch(base, 'sentiment', 'm_1')
    const released = releaseFailedBatch(failed, 'sentiment')
    expect(readFailedBatch(released, 'sentiment')).toMatchObject({ count: 1, released: true })

    const again = markFailedBatch(released, 'sentiment', 'm_1')
    expect(readFailedBatch(again, 'sentiment')?.count).toBe(2)
    expect(readFailedBatch(again, 'sentiment')?.released).toBeUndefined()
  })

  it('releaseFailedBatch 對不存在的記憶是 no-op（不憑空建立一筆）', () => {
    expect(releaseFailedBatch(base, 'summary')).toBe(base)
    expect(readFailedBatch(releaseFailedBatch(base, 'summary'), 'summary')).toBeNull()
  })

  /**
   * FR-011：記憶隨 `CopilotAnalysisState` 一起消失，**不另有保存期限**。
   * 狀態過期（2 小時 sliding TTL）之後的觸發視同全新的一批，這是自癒的最後一道保險。
   */
  it('FR-011：狀態不存在時讀取回 null（沒有獨立於狀態之外的保存期限）', () => {
    expect(readFailedBatch(null, 'sentiment')).toBeNull()
  })
})

// ── 不變式 B：每批訊息、每個區塊，最多自動嘗試一輪 ─────────────────────

describe('不變式 B：同一批在同一區塊失敗後不再自動分析（FR-005、FR-006）', () => {
  it('失敗一次之後，同一批再被觸發幾次都不再呼叫 AI', async () => {
    const id = convId('block')
    const history = [customer(id), customer(id)]
    const ai = alwaysFailingSentiment()

    await runColdStart(id, history, false)
    expect(ai.calls()).toBe(1)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('error')
    expect(readFailedBatch(await stateOf(id), 'sentiment')?.lastMessageId).toBe(history[1]!.id)

    // ⚠️ 連續 5 次 —— 一次不夠：若有人把「清除記憶」寫進 `beginAnalyzing()`
    //    （data-model.md §1 明列的反例），第二次仍會被擋、第三次就會放行。
    for (let i = 0; i < 5; i++) await runIncremental(id, history, 'foreground', false)

    expect(ai.calls()).toBe(1)
    // 記憶本身也沒有被沖掉（count 不因被擋下的觸發而遞增 —— 那些根本沒有失敗）
    expect(readFailedBatch(await stateOf(id), 'sentiment')).toMatchObject({ count: 1 })
  })

  it('記憶只擋自己那個區塊 —— 其他區塊照常分析（三區塊互相獨立）', async () => {
    const id = convId('scope')
    const history = [customer(id)]
    alwaysFailingSentiment()

    await runColdStart(id, history, false)
    const state = await stateOf(id)
    expect(state?.sentimentBlock.status).toBe('error')
    expect(state?.summaryBlock.status).toBe('ready')
    expect(readFailedBatch(state, 'summary')).toBeNull()
  })
})

describe('不變式 B 的三個放行條件', () => {
  it('FR-008：retryBlock() 放行記憶 → 再次呼叫 AI', async () => {
    const id = convId('retry')
    const history = [customer(id)]
    const ai = alwaysFailingSentiment()

    await runColdStart(id, history, false)
    expect(ai.calls()).toBe(1)

    await retryBlock(id, 'sentiment', history, false)
    expect(ai.calls()).toBe(2)
    // 又失敗了 → 同一批的 count 遞增，且再次被記住
    expect(readFailedBatch(await stateOf(id), 'sentiment')).toMatchObject({
      lastMessageId: history[0]!.id,
      count: 2,
    })

    // 重試後仍然擋得住自動觸發（記憶已重新寫入）
    await runIncremental(id, history, 'foreground', false)
    expect(ai.calls()).toBe(2)
  })

  it('FR-015：runColdStart()（重新 JOIN）放行三個區塊的記憶 → 再次呼叫 AI', async () => {
    const id = convId('cold')
    const history = [customer(id)]
    const ai = alwaysFailingSentiment()

    await runColdStart(id, history, false)
    expect(ai.calls()).toBe(1)

    await runColdStart(id, history, false)
    expect(ai.calls()).toBe(2)
  })

  /**
   * FR-007 的自癒路徑 —— 這是 FR-010（不加第二層自動退避重試）能夠成立的唯一前提。
   * 完整的 US3 路徑（含服務恢復後回到 ready）見下方 US3 一節。
   */
  it('FR-007：出現新的客戶發言（批次的最後一則改變）→ 自動再試一次', async () => {
    const id = convId('heal')
    const first = [customer(id)]
    const ai = alwaysFailingSentiment()

    await runColdStart(id, first, false)
    expect(ai.calls()).toBe(1)

    await runIncremental(id, first, 'foreground', false)
    expect(ai.calls()).toBe(1)

    // 客戶又說了一句 → 該批的最後一則變了 → 不再是同一批
    const next = [...first, customer(id)]
    await runIncremental(id, next, 'foreground', false)
    expect(ai.calls()).toBe(2)
    expect(readFailedBatch(await stateOf(id), 'sentiment')?.lastMessageId).toBe(next[1]!.id)
  })
})

describe('分析成功時記憶被清除（隱含規則）', () => {
  it('失敗 → 手動重試 → 這次成功 → 記憶消失', async () => {
    const id = convId('success')
    const history = [customer(id)]
    let failNext = true
    setAIProvider(new MockAIProvider({
      sentimentFailure: () => (failNext ? new AIProviderHttpError('boom', 400) : null),
    }))

    await runColdStart(id, history, false)
    expect(readFailedBatch(await stateOf(id), 'sentiment')?.lastMessageId).toBe(history[0]!.id)

    failNext = false
    await retryBlock(id, 'sentiment', history, false)

    const state = await stateOf(id)
    expect(state?.sentimentBlock.status).toBe('ready')
    expect(readFailedBatch(state, 'sentiment')).toBeNull()
  })
})

// ── US3：服務恢復後的自癒（FR-007、SC-003）────────────────────────────

describe('US3：客戶再次發言時自動恢復（T035）', () => {
  it('故障 → 失敗 → 解除故障 → 新客戶發言 → 自動回到 ready，全程零手動操作', async () => {
    const id = convId('us3')
    const first = [customer(id)]
    let broken = true
    let calls = 0
    setAIProvider(new MockAIProvider({
      sentimentFailure: () => {
        calls++
        return broken ? new AIProviderHttpError('boom', 400) : null
      },
    }))

    await runColdStart(id, first, false)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('error')
    expect(calls).toBe(1)

    // 服務恢復（客服完全沒有動作）
    broken = false

    // 沒有新發言時仍然不重跑 —— FR-010：不做自動退避重試
    await runIncremental(id, first, 'foreground', false)
    expect(calls).toBe(1)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('error')

    // 客戶再說一句話 → 自動再試一次 → 恢復
    const next = [...first, customer(id)]
    await runIncremental(id, next, 'foreground', false)

    const state = await stateOf(id)
    expect(calls).toBe(2)
    expect(state?.sentimentBlock.status).toBe('ready')
    expect(readFailedBatch(state, 'sentiment')).toBeNull()
  })

  it('服務仍未恢復時，新發言最多再換來一輪，MUST NOT 進入週期性重跑（US3 AC#2）', async () => {
    const id = convId('us3-still-broken')
    const history = [customer(id)]
    const ai = alwaysFailingSentiment()

    await runColdStart(id, history, false)
    expect(ai.calls()).toBe(1)

    // 新發言 → 新的一批 → 再試一輪
    history.push(customer(id))
    await runIncremental(id, history, 'foreground', false)
    expect(ai.calls()).toBe(2)

    // 又回到錯誤狀態，而且就停在那裡 —— 之後怎麼觸發都不再跑
    for (let i = 0; i < 10; i++) await runIncremental(id, history, 'foreground', false)
    expect(ai.calls()).toBe(2)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('error')
  })
})
