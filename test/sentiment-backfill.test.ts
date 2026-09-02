/**
 * 恢復後補算 —— specs/005-m2-residual-defects US2（FR-007～FR-012、SC-003／SC-004）。
 *
 * ⚠️ 「恢復不補算」不會報錯：客服看到的是一條中間斷掉的情緒走勢，而畫面上沒有任何東西告訴他
 *    那段是缺的、不是「客戶那段時間情緒平穩」。下面每一條都直接數 AI 收到了**哪些** messageId、
 *    歷史被撈了幾次、錨點是什麼 —— 看狀態欄位看不出這些。
 *
 * ⚠️ 兩條最容易寫錯的設計，各有一條測試守著：
 *    ① 抓取錨點是 `timeline[0]`（不是 `lastCoveredMessageId()` 高水位）—— 「中段缺口」那條。
 *       缺口 MUST 造在中段且其後另有成功批次把高水位推過缺口；造在尾端時，錯用高水位的實作也會通過。
 *    ② 左界是 `timeline[0]`（不是對話的第一則訊息）—— 「左界」那條。
 *       寫成「全量歷史 − 已涵蓋」的後果是長對話每輪補一點、永遠補不完，每次客戶發言都多打 3 批 AI。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  retryBlock,
  runColdStart,
  runIncremental,
  SENTIMENT_BACKFILL_MAX_MESSAGES,
  SENTIMENT_CHUNK_SIZE,
  setHistoryResolver,
  setJoinedResolver,
} from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { AIProviderHttpError } from '../server/services/ai/retry-policy.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import type { CopilotAnalysisState } from '../server/state/types.js'
import type { Message } from '../shared/types/conversation.js'
import type { KnowledgeHit } from '../shared/types/knowledge.js'

// ── 訊息工廠：依序號給遞增的時間，缺口與新發言才排得出先後 ────────────

const BASE = Date.parse('2026-09-02T10:00:00.000Z')

function customer(convId: string, n: number): Message {
  return {
    id: `m_${n}`,
    conversationId: convId,
    at: new Date(BASE + n * 1_000).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text: `客戶第 ${n} 句`,
  }
}

function range(convId: string, from: number, to: number): Message[] {
  const out: Message[] = []
  for (let n = from; n <= to; n++) out.push(customer(convId, n))
  return out
}

let seq = 0
function convId(label: string): string {
  return `conv-bf-${label}-${Date.now()}-${++seq}`
}

// ── 可觀測的 AI：記下每一次呼叫收到的 messageId ─────────────────────

interface Probe {
  /** 依呼叫順序，每次呼叫收到的 messageId */
  calls: string[][]
  /** 攤平 */
  seen: () => string[]
  summaryInputs: string[][]
  suggestInputs: string[][]
}

/**
 * @param failWhen 收到含這些 id 的批次時拋 400（permanent，不觸發 001 FR-014 的單輪重試）。
 *   回傳 `Error` 的那一次仍算一次 AI 呼叫（記進 `calls`），與真實環境同一種計數方式。
 */
function probeAI(opts: { failWhen?: (ids: string[]) => boolean, delayMs?: number } = {}): Probe {
  const probe: Probe = {
    calls: [],
    seen: () => probe.calls.flat(),
    summaryInputs: [],
    suggestInputs: [],
  }
  setAIProvider(new (class extends MockAIProvider {
    override async analyzeSentiment(input: { messages: Message[] }) {
      const ids = input.messages.map(m => m.id)
      probe.calls.push(ids)
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (opts.failWhen?.(ids)) throw new AIProviderHttpError('injected', 400)
      return super.analyzeSentiment(input)
    }

    override async summarize(input: Parameters<MockAIProvider['summarize']>[0]) {
      probe.summaryInputs.push(input.history.map(m => m.id))
      return super.summarize(input)
    }

    override async suggest(input: { history: Message[], knowledgeHits: KnowledgeHit[], aiReplies: boolean }) {
      probe.suggestInputs.push(input.history.map(m => m.id))
      return super.suggest(input)
    }
  })())
  return probe
}

/**
 * 模擬 `messageSource.fetchSince()` 的既有約定：回傳錨點**之後**的訊息；錨點為 `null` 或找不到時
 * **回傳整批**（最近 50 則視窗），由呼叫端自行去重。
 */
function historyResolver(all: () => Message[]) {
  const calls: Array<{ conversationId: string, since: string | null }> = []
  setHistoryResolver(async (conversationId, since) => {
    calls.push({ conversationId, since })
    const window = all().slice(-50)
    const idx = since ? window.findIndex(m => m.id === since) : -1
    return idx >= 0 ? window.slice(idx + 1) : window
  })
  return { calls }
}

async function stateOf(id: string): Promise<CopilotAnalysisState | null> {
  return useStateStore().getAnalysisState(id)
}

function timelineIds(state: CopilotAnalysisState | null): string[] {
  return (state?.sentimentBlock.timeline ?? []).map(e => e.messageId).sort(byNumber)
}

const byNumber = (a: string, b: string): number => Number(a.slice(2)) - Number(b.slice(2))
const ids = (messages: Message[]): string[] => messages.map(m => m.id).sort(byNumber)

/**
 * 直接造出「中段缺口 ＋ 高水位已越過缺口」的狀態：A（已涵蓋）、B（缺口）、C（已涵蓋）。
 * 這是 US2 描述的真實形狀 —— B 那批失敗後客戶又說了 C，C 自癒成功，高水位停在 C 的尾端。
 */
async function seedMiddleGap(id: string, a: Message[], c: Message[]): Promise<void> {
  await runColdStart(id, [...a, ...c], false)
  await useStateStore().setAnalysisState({ ...(await stateOf(id))!, sentimentGap: true }, 60_000)
}

afterEach(() => {
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
  setHistoryResolver(null)
  setJoinedResolver(null)
  vi.useRealTimers()
})

// ── T027／T021：旗標由失敗設起、由新發言帶動補齊 ─────────────────────

describe('sentimentGap 的生命週期（data-model §3）', () => {
  it('情緒批次失敗 → sentimentGap 為 true；手動重試成功 → false（成功即清，不另判涵蓋）', async () => {
    const id = convId('flag')
    const history = range(id, 1, 6)
    let broken = true
    probeAI({ failWhen: () => broken })

    await runColdStart(id, history, false)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('error')
    expect((await stateOf(id))?.sentimentGap).toBe(true)

    broken = false
    await retryBlock(id, 'sentiment', history, false)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('ready')
    expect((await stateOf(id))?.sentimentGap).toBe(false)
  })

  it('冷啟動成功 → false（重新 JOIN 走完整視窗）', async () => {
    const id = convId('cold-clear')
    probeAI()
    await runColdStart(id, range(id, 1, 3), false)
    await useStateStore().setAnalysisState({ ...(await stateOf(id))!, sentimentGap: true }, 60_000)

    await runColdStart(id, range(id, 1, 3), false)
    expect((await stateOf(id))?.sentimentGap).toBe(false)
  })
})

describe('主線（SC-003）：中段若干批失敗 → 新發言觸發恢復 → 時間軸無中斷區間', () => {
  /**
   * ⚠️ 缺口 MUST 造在**中段**且其後另有成功批次把高水位推過缺口（必讀 5a）。
   *    A＝m_1～m_6 已涵蓋、B＝m_7～m_12 缺口、C＝m_13～m_18 已涵蓋（高水位 m_18 在缺口之後）。
   *    錯用 `lastCoveredMessageId()`（m_18）當錨點的實作只撈得到 m_19 以後，B 永遠補不到。
   */
  it('缺口在中段：以 timeline[0] 為錨點撈歷史，補齊 B，且不重送 A／C', async () => {
    const id = convId('middle')
    const A = range(id, 1, 6)
    const B = range(id, 7, 12)
    const C = range(id, 13, 18)
    const D = [customer(id, 19)]
    const all = [...A, ...B, ...C, ...D]

    probeAI()
    await seedMiddleGap(id, A, C)
    expect(timelineIds(await stateOf(id))).toEqual(ids([...A, ...C]))

    const probe = probeAI()
    const history = historyResolver(() => all)
    await runIncremental(id, D, 'foreground', false)

    // 錨點：時間軸的第一個點（m_1），不是高水位（m_18）
    expect(history.calls).toEqual([{ conversationId: id, since: 'm_1' }])
    // AI 收到的正好是缺口 ∪ 新發言，A／C 一則都沒重送
    expect(probe.seen().sort(byNumber)).toEqual(ids([...B, ...D]))
    // 時間軸涵蓋全部客戶發言，沒有中斷區間
    const state = await stateOf(id)
    expect(timelineIds(state)).toEqual(ids(all))
    expect(state?.sentimentBlock.status).toBe('ready')
    expect(state?.sentimentGap).toBe(false)
  })

  it('自然路徑：失敗 → 自癒 → 補齊（旗標由 finishBlockError 設起，不是測試手動塞的）', async () => {
    const id = convId('natural')
    const A = range(id, 1, 6)
    const B = range(id, 7, 12)
    const all = [...A, ...B]
    let broken = false
    const probe = probeAI({ failWhen: () => broken })
    const history = historyResolver(() => all)

    await runColdStart(id, A, false)
    broken = true
    await runIncremental(id, B, 'foreground', false)
    expect((await stateOf(id))?.sentimentGap).toBe(true)
    expect(history.calls).toHaveLength(0) // 失敗那一輪沒有旗標，不撈歷史

    broken = false
    const D = [customer(id, 13)]
    all.push(...D)
    await runIncremental(id, D, 'foreground', false)

    expect(probe.seen().filter(x => ids(B).includes(x)).length).toBeGreaterThan(0)
    expect(timelineIds(await stateOf(id))).toEqual(ids(all))
    expect((await stateOf(id))?.sentimentGap).toBe(false)
  })
})

// ── T022：左界 ──────────────────────────────────────────────────────

describe('左界（research.md #8）：不回頭補 timeline[0] 之前的訊息', () => {
  it('對話長度超過 50 則、冷啟動只涵蓋最近 50 則 → 補算只補時間軸起點之後的缺口', async () => {
    const id = convId('left-bound')
    const older = range(id, 1, 30) // 冷啟動視窗之前，刻意不看
    const windowA = range(id, 31, 50)
    const gap = range(id, 51, 56)
    const windowC = range(id, 57, 80)
    const D = [customer(id, 81)]

    probeAI()
    await seedMiddleGap(id, windowA, windowC)

    const probe = probeAI()
    // 這裡的解析器故意把「整段歷史」都給得出來 —— 左界必須由錨點守住，不能靠解析器少給
    const history = historyResolver(() => [...older, ...windowA, ...gap, ...windowC, ...D].slice(-80))
    setHistoryResolver(async (_c, since) => {
      history.calls.push({ conversationId: _c, since })
      const full = [...older, ...windowA, ...gap, ...windowC, ...D]
      const idx = since ? full.findIndex(m => m.id === since) : -1
      return idx >= 0 ? full.slice(idx + 1) : full
    })

    await runIncremental(id, D, 'foreground', false)

    expect(history.calls[0]?.since).toBe('m_31')
    const sent = probe.seen()
    expect(sent.some(x => ids(older).includes(x))).toBe(false)
    expect(sent.sort(byNumber)).toEqual(ids([...gap, ...D]))
  })
})

// ── T022a：空 timeline（冷啟動情緒整批失敗）──────────────────────────

describe('空 timeline（spec FR-008）：錨點為 null、整個視窗算缺口', () => {
  it('冷啟動情緒整批失敗 → 新發言觸發 → 以 null 錨點撈整批、補齊全部', async () => {
    const id = convId('empty-tl')
    const A = range(id, 1, 10)
    const all = [...A]
    let broken = true
    const probe = probeAI({ failWhen: () => broken })
    const history = historyResolver(() => all)

    await runColdStart(id, A, false)
    expect((await stateOf(id))?.sentimentBlock.timeline).toEqual([])
    expect((await stateOf(id))?.sentimentGap).toBe(true)

    broken = false
    probe.calls.length = 0
    const D = [customer(id, 11)]
    all.push(...D)
    await runIncremental(id, D, 'foreground', false)

    expect(history.calls).toEqual([{ conversationId: id, since: null }])
    expect(probe.seen().sort(byNumber)).toEqual(ids(all))
    expect(timelineIds(await stateOf(id))).toEqual(ids(all))
    expect((await stateOf(id))?.sentimentGap).toBe(false)
  })
})

// ── T023：上限（FR-009）────────────────────────────────────────────

describe('上限（FR-009）：每輪最多 18 則缺口訊息，新發言的批次不計入', () => {
  async function seedBigGap(id: string, gapSize: number) {
    const A = range(id, 1, 6)
    const gap = range(id, 7, 6 + gapSize)
    const C = range(id, 7 + gapSize, 12 + gapSize)
    probeAI()
    await seedMiddleGap(id, A, C)
    return { A, gap, C }
  }

  it('① 只有 1 則新發言：本輪送出的缺口恰好 18 則（時間最早的 18 則），呼叫次數 ≤ ⌈1/6⌉＋3', async () => {
    const id = convId('cap-1')
    const { gap, C } = await seedBigGap(id, 40)
    const D = [customer(id, C[C.length - 1]!.id === 'm_52' ? 53 : 999)]
    const all = [...range(id, 1, 6), ...gap, ...C, ...D]

    const probe = probeAI()
    historyResolver(() => all)
    await runIncremental(id, D, 'foreground', false)

    const sentGap = probe.seen().filter(x => ids(gap).includes(x)).sort(byNumber)
    expect(sentGap).toEqual(ids(gap.slice(0, SENTIMENT_BACKFILL_MAX_MESSAGES)))
    expect(probe.calls.length).toBeLessThanOrEqual(Math.ceil(1 / SENTIMENT_CHUNK_SIZE) + 3)
    expect((await stateOf(id))?.sentimentGap).toBe(true) // 還有剩，留給下一輪
  })

  it('② 另有 7 則新發言：缺口仍只送 18 則，總呼叫次數 ≤ ⌈7/6⌉＋3 ＝ 5', async () => {
    const id = convId('cap-7')
    const { gap, C } = await seedBigGap(id, 40)
    const last = Number(C[C.length - 1]!.id.slice(2))
    const D = range(id, last + 1, last + 7)
    const all = [...range(id, 1, 6), ...gap, ...C, ...D]

    const probe = probeAI()
    historyResolver(() => all)
    await runIncremental(id, D, 'foreground', false)

    const sentGap = probe.seen().filter(x => ids(gap).includes(x))
    expect(sentGap).toHaveLength(SENTIMENT_BACKFILL_MAX_MESSAGES)
    expect(probe.seen().filter(x => ids(D).includes(x))).toHaveLength(7)
    expect(probe.calls.length).toBeLessThanOrEqual(Math.ceil(7 / SENTIMENT_CHUNK_SIZE) + 3)
  })

  it('後續輪次由下一次自然觸發繼續補，MUST NOT 自行續排', async () => {
    const id = convId('cap-rounds')
    const { gap, C } = await seedBigGap(id, 40)
    const last = Number(C[C.length - 1]!.id.slice(2))
    const all = [...range(id, 1, 6), ...gap, ...C]

    const probe = probeAI()
    historyResolver(() => all)
    vi.useFakeTimers()

    const D1 = [customer(id, last + 1)]
    all.push(...D1)
    await runIncremental(id, D1, 'foreground', false)
    const afterFirst = probe.seen().length
    // 十分鐘內沒有新發言 → 一則都不會多送（不自行續排，003 SC-001）
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(probe.seen().length).toBe(afterFirst)

    const D2 = [customer(id, last + 2)]
    all.push(...D2)
    await runIncremental(id, D2, 'foreground', false)
    const D3 = [customer(id, last + 3)]
    all.push(...D3)
    await runIncremental(id, D3, 'foreground', false)

    // 40 則缺口 ＝ 18 ＋ 18 ＋ 4，三輪補完
    expect(probe.seen().filter(x => ids(gap).includes(x)).sort(byNumber)).toEqual(ids(gap))
    expect((await stateOf(id))?.sentimentGap).toBe(false)
    expect(timelineIds(await stateOf(id))).toEqual(ids(all))
  })
})

// ── T024：零成本（FR-012、S-1）───────────────────────────────────────

describe('零成本（FR-012）：無缺口時 AI 呼叫次數與取歷史次數皆與現況逐一相同', () => {
  it('sentimentGap 未設時：不取歷史，呼叫次數 ＝ ⌈新發言 ÷ 6⌉', async () => {
    const id = convId('zero')
    probeAI()
    await runColdStart(id, range(id, 1, 3), false)

    const probe = probeAI()
    const history = historyResolver(() => [])
    const D = range(id, 4, 10) // 7 則 → 2 批
    await runIncremental(id, D, 'foreground', false)

    expect(history.calls).toHaveLength(0)
    expect(probe.calls).toHaveLength(Math.ceil(D.length / SENTIMENT_CHUNK_SIZE))
    expect(probe.seen().sort(byNumber)).toEqual(ids(D))
  })

  it('手動重試成功之後：旗標已清，往後每一輪都不再撈歷史（T032a 漏了會每輪多一趟往返）', async () => {
    const id = convId('zero-after-retry')
    const A = range(id, 1, 6)
    let broken = true
    probeAI({ failWhen: () => broken })
    await runColdStart(id, A, false)
    expect((await stateOf(id))?.sentimentGap).toBe(true)

    broken = false
    await retryBlock(id, 'sentiment', A, false)

    const probe = probeAI()
    const history = historyResolver(() => A)
    await runIncremental(id, [customer(id, 7)], 'foreground', false)
    await runIncremental(id, [customer(id, 8)], 'foreground', false)

    expect(history.calls).toHaveLength(0)
    expect(probe.calls).toHaveLength(2)
  })

  it('背景優先度同樣零成本', async () => {
    const id = convId('zero-bg')
    probeAI()
    await runColdStart(id, range(id, 1, 3), false)
    const history = historyResolver(() => [])
    await runIncremental(id, [customer(id, 4)], 'background', false)
    expect(history.calls).toHaveLength(0)
  })
})

// ── T025：止血不退步（FR-010、SC-004 ↔ 003 SC-001）─────────────────────

describe('止血（FR-010）：補算失敗 → 停在 error 等手動重試，MUST NOT 自行再排一輪', () => {
  it('補算那一輪失敗後，同一批再怎麼觸發都不再呼叫 AI；十分鐘內也不會自己多跑', async () => {
    const id = convId('bleed')
    const A = range(id, 1, 6)
    const B = range(id, 7, 12)
    const C = range(id, 13, 18)
    const D = [customer(id, 19)]
    const all = [...A, ...B, ...C, ...D]

    probeAI()
    await seedMiddleGap(id, A, C)

    const probe = probeAI({ failWhen: () => true })
    historyResolver(() => all)
    vi.useFakeTimers()

    await runIncremental(id, D, 'foreground', false)
    const state = await stateOf(id)
    expect(state?.sentimentBlock.status).toBe('error')
    expect(state?.sentimentGap).toBe(true)
    const calls = probe.calls.length
    expect(calls).toBeGreaterThan(0)

    for (let i = 0; i < 10; i++) await runIncremental(id, D, 'foreground', false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(probe.calls.length).toBe(calls)
    expect((await stateOf(id))?.sentimentBlock.status).toBe('error')
  })
})

// ── T026：只擴充情緒的輸入（S-4、research.md #11）────────────────────

describe('補算只擴充情緒的輸入：摘要與建議卡收到的仍只有這一批新發言', () => {
  it('缺口那幾則不會出現在 summarize()／suggest() 的輸入裡', async () => {
    const id = convId('scope')
    const A = range(id, 1, 6)
    const B = range(id, 7, 12)
    const C = range(id, 13, 18)
    const D = [customer(id, 19)]

    probeAI()
    await seedMiddleGap(id, A, C)

    const probe = probeAI()
    historyResolver(() => [...A, ...B, ...C, ...D])
    await runIncremental(id, D, 'foreground', false)

    expect(probe.seen().filter(x => ids(B).includes(x))).toHaveLength(B.length)
    for (const input of probe.summaryInputs) expect(input).toEqual(ids(D))
    for (const input of probe.suggestInputs) expect(input).toEqual(ids(D))
    expect(probe.summaryInputs.length + probe.suggestInputs.length).toBeGreaterThan(0)
  })
})

// ── T026a：LEAVE 優先（FR-011 ↔ 003 FR-012）─────────────────────────

describe('LEAVE 優先（FR-011）：客服已離開 → 不取歷史、不排入補算；已在飛的不中斷', () => {
  it('已離開：runIncremental() 連歷史都不撈', async () => {
    const id = convId('left')
    const A = range(id, 1, 6)
    probeAI()
    await seedMiddleGap(id, A, range(id, 13, 18))

    const probe = probeAI()
    const history = historyResolver(() => A)
    setJoinedResolver(() => false)
    await runIncremental(id, [customer(id, 19)], 'foreground', false)

    expect(history.calls).toHaveLength(0)
    expect(probe.calls).toHaveLength(0)
  })

  it('補算進行中發生 LEAVE：已在飛的那一輪跑完，之後不再排新的批次', async () => {
    const id = convId('left-inflight')
    const A = range(id, 1, 6)
    const B = range(id, 7, 12)
    const C = range(id, 13, 18)
    const D = [customer(id, 19)]
    const all = [...A, ...B, ...C, ...D]
    probeAI()
    await seedMiddleGap(id, A, C)

    const probe = probeAI({ delayMs: 20 })
    historyResolver(() => all)
    const inFlight = runIncremental(id, D, 'foreground', false)
    // ⚠️ 要等 AI 呼叫真的送出去才算「在飛」：runIncremental() 開頭就有 JOIN 門檻，
    //    同步翻 resolver 會讓它在第一個 await 之後直接退場 —— 那驗的是上一條，不是這一條
    await vi.waitFor(() => expect(probe.calls.length).toBeGreaterThan(0))
    setJoinedResolver(() => false) // 客服在補算途中按下離開
    await inFlight

    expect(timelineIds(await stateOf(id))).toEqual(ids(all)) // 已在飛的沒被中斷
    const after = probe.calls.length
    await runIncremental(id, [customer(id, 20)], 'foreground', false)
    expect(probe.calls.length).toBe(after) // 之後不再排
  })
})

// ── T026b：併發（spec Edge Case「補算與新發言同時發生」）────────────────

describe('併發：補算在飛時再來一批新發言 → 同一則只送進 AI 一次、涵蓋範圍不互相覆蓋', () => {
  it('兩批同時觸發：每一個 messageId 恰好被送一次，時間軸涵蓋缺口 ∪ 兩批新發言', async () => {
    const id = convId('concurrent')
    const A = range(id, 1, 6)
    const B = range(id, 7, 12)
    const C = range(id, 13, 18)
    const all = [...A, ...B, ...C]
    probeAI()
    await seedMiddleGap(id, A, C)

    const probe = probeAI({ delayMs: 30 })
    historyResolver(() => all)

    const D1 = [customer(id, 19)]
    const D2 = [customer(id, 20)]
    all.push(...D1, ...D2)
    await Promise.all([
      runIncremental(id, D1, 'foreground', false),
      runIncremental(id, D2, 'foreground', false),
    ])

    const sent = probe.seen()
    const counts = new Map<string, number>()
    for (const x of sent) counts.set(x, (counts.get(x) ?? 0) + 1)
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([x]) => x)
    expect(duplicated).toEqual([])
    expect(sent.sort(byNumber)).toEqual(ids([...B, ...D1, ...D2]))
    expect(timelineIds(await stateOf(id))).toEqual(ids(all))
    expect((await stateOf(id))?.sentimentGap).toBe(false)
  })
})
