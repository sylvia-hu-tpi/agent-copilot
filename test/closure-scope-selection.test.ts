/**
 * SC-006a：涵蓋區間的候選推導與預設選擇，四個代表情境**各跑 5 次**。
 *
 * ⚠️ 這四個情境全部是「畫面上看起來很合理，但涵蓋的其實是錯的那一段」：
 *   ① 服務過多次的客戶 —— 預設若不指向最近一次結案，這份報告會涵蓋前幾輪服務
 *   ② 最上面的候選 0 則（剛結完案又被按一次）—— 預設選它會產出一份**空摘要**，
 *      而空摘要寫進 CRM 不會報錯
 *   ③ **反例測試**：跨夜的同一段服務 MUST NOT 被任何「時間間隔」規則切開 ——
 *      這條規則從未存在過，這個測試是防止有人日後「順手」加上它
 *   ④ 從未結案 —— MUST 明確落到 fallback（`defaultIndex === -1`），
 *      MUST NOT 回一個看起來像候選的東西
 *
 * ⚠️ 加測「超過 500 則」：`null` 與 `0` 在 `JSON.stringify` 之後必須仍然分得出來。
 *    混淆會讓長期客戶完全結不了案，而畫面上只會顯示一個灰掉的選項。
 *
 * ⚠️ 全部以記憶體 fixture 驗（訊息與結案紀錄皆是），`countByCandidate()` 吃的是
 *    注入的取數函式 —— 這四個情境要驗的是「候選推導與則數計算對不對」，
 *    不是「HTTP 通不通」。
 */

import { describe, expect, it } from 'vitest'
import {
  buildCandidates,
  countByCandidate,
  defaultIndex,
  type MessagePageFetcher,
  type ScopeCandidate,
} from '../server/services/closure/period.js'
import type { ClosureRecordRow } from '../server/services/closure/board-repository.js'

/** 每個情境跑幾次 —— SC-006a 逐字要求「四情境各 5 次」 */
const RUNS = 5

const iso = (d: string): string => new Date(`${d}Z`).toISOString()

function closure(closedAt: string, over: Partial<ClosureRecordRow> = {}): ClosureRecordRow {
  return {
    recordId: `rec_${closedAt}`,
    itemId: `bi_${closedAt}`,
    draftId: `draft_${closedAt}`,
    conversationId: 'conv_1',
    closedAt: iso(closedAt),
    category: '發票補寄',
    reviewedBy: 'u_1',
    createdAt: iso(closedAt),
    ...over,
  }
}

const resolveName = (id: string | null): string => (id === 'u_1' ? '林佩君' : '未知')

/** 以一組時間戳（由舊到新）造一個分頁取數函式 —— 形狀與 `messagePageFetcher()` 相同 */
function fixtureFetcher(allOldestFirst: string[]): MessagePageFetcher {
  return async (skip, limit) => {
    // 平台是由新到舊分頁；`fetchLatest()` 已把「該頁」反轉成由舊到新
    const newestFirst = [...allOldestFirst].reverse()
    return newestFirst.slice(skip, skip + limit).reverse()
  }
}

/** 每小時一則，共 n 則，最後一則落在 `endHourExclusive - 1` 點 */
function hourly(startISO: string, n: number): string[] {
  const t0 = Date.parse(startISO)
  return Array.from({ length: n }, (_, i) => new Date(t0 + i * 3_600_000).toISOString())
}

/** 把 `countByCandidate()` 的結果套回候選 —— 端點裡也是這樣接的 */
function withCounts(
  set: { candidates: ScopeCandidate[], fallback: ScopeCandidate },
  counts: Array<{ messageCount: number | null, truncated: boolean }>,
): { candidates: ScopeCandidate[], fallback: ScopeCandidate } {
  const all = [...set.candidates, set.fallback]
  all.forEach((c, i) => {
    c.messageCount = counts[i]!.messageCount
    c.truncated = counts[i]!.truncated
  })
  return set
}

describe('SC-006a ①：第 N 次服務 —— 預設指向最近一次結案，則數不含前幾輪', () => {
  for (let run = 0; run < RUNS; run++) {
    it(`第 ${run + 1} 次`, async () => {
      // 三次結案：8/01、8/15、9/01。訊息從 7/01 起每小時一則到 9/03
      const closures = [closure('2026-09-01T10:00:00'), closure('2026-08-15T10:00:00'), closure('2026-08-01T10:00:00')]
      const messages = hourly(iso('2026-08-30T00:00:00'), 100) // 9/03 04:00 為止
      const set = buildCandidates(closures, messages[0]!, resolveName)

      expect(set.candidates).toHaveLength(3)
      // R1.1：時間降冪
      expect(set.candidates.map(c => c.start)).toEqual([
        iso('2026-09-01T10:00:00'), iso('2026-08-15T10:00:00'), iso('2026-08-01T10:00:00'),
      ])
      expect(set.candidates[0]!.label).toMatchObject({ reviewedByName: '林佩君', category: '發票補寄' })

      const counts = await countByCandidate(
        fixtureFetcher(messages),
        [...set.candidates.map(c => c.start), set.fallback.start],
      )
      withCounts(set, counts)

      // 最近一次結案（9/01 10:00）之後的則數 —— 明顯少於 fallback 的全部
      const top = set.candidates[0]!.messageCount!
      expect(top).toBeGreaterThan(0)
      expect(top).toBeLessThan(set.fallback.messageCount!)
      expect(set.fallback.messageCount).toBe(messages.length)
      expect(defaultIndex(set.candidates)).toBe(0)
    })
  }
})

describe('SC-006a ②：最上面的候選 0 則 —— 預設跳過它，但它仍留在清單上', () => {
  for (let run = 0; run < RUNS; run++) {
    it(`第 ${run + 1} 次`, async () => {
      // 剛結完案（9/03 12:00）之後沒有任何新訊息
      const closures = [closure('2026-09-03T12:00:00'), closure('2026-09-01T10:00:00')]
      const messages = hourly(iso('2026-09-01T00:00:00'), 40) // 9/02 15:00 為止

      const set = buildCandidates(closures, messages[0]!, resolveName)
      const counts = await countByCandidate(
        fixtureFetcher(messages),
        [...set.candidates.map(c => c.start), set.fallback.start],
      )
      withCounts(set, counts)

      expect(set.candidates[0]!.messageCount).toBe(0)
      expect(set.candidates[1]!.messageCount).toBeGreaterThan(0)
      // ⚠️ 跳過它，但**不是把它從清單刪掉** —— 客服要看得到「上次結到這裡」
      expect(defaultIndex(set.candidates)).toBe(1)
      expect(set.candidates).toHaveLength(2)
    })
  }
})

describe('SC-006a ③（反例）：跨夜的同一段服務 MUST NOT 被任何間隔規則切開', () => {
  for (let run = 0; run < RUNS; run++) {
    it(`第 ${run + 1} 次`, async () => {
      /*
        客戶昨天 17:35 發言、今天 10:15 才有人接 —— 中間空了近 17 小時。
        ⚠️ 這裡沒有結案紀錄，因此**只有 fallback 一個選項**，
           它必須涵蓋昨天那則。任何「間隔超過 N 小時就視為新的一段服務」的規則
           都會把昨天那則排除掉，而摘要看起來仍然完整 —— 少的是客戶的原始訴求。
      */
      const messages = [
        iso('2026-09-02T17:35:00'),
        iso('2026-09-03T10:15:00'),
        iso('2026-09-03T10:20:00'),
      ]
      const set = buildCandidates([], messages[0]!, resolveName)
      const counts = await countByCandidate(fixtureFetcher(messages), [set.fallback.start])
      set.fallback.messageCount = counts[0]!.messageCount
      set.fallback.truncated = counts[0]!.truncated

      expect(set.candidates).toEqual([])
      expect(set.fallback.start).toBe(messages[0])
      // 三則全在同一個區間內 —— 昨天那則沒有被切掉
      expect(set.fallback.messageCount).toBe(3)
    })
  }
})

describe('SC-006a ④：從未結案 —— candidates 空、defaultIndex 為 -1、fallback 仍在', () => {
  for (let run = 0; run < RUNS; run++) {
    it(`第 ${run + 1} 次`, async () => {
      const messages = hourly(iso('2026-03-06T09:12:00'), 12)
      const set = buildCandidates([], messages[0]!, resolveName)

      expect(set.candidates).toEqual([])
      expect(set.overflowCount).toBe(0)
      // ⚠️ MUST 是 -1，MUST NOT 是 0 —— 0 會指向一個不存在的候選
      expect(defaultIndex(set.candidates)).toBe(-1)
      expect(set.fallback).toMatchObject({ origin: 'first', start: messages[0] })
    })
  }
})

describe('R1.3：超過 500 則 → messageCount 為 null ＋ truncated，且序列化後不是 0', () => {
  it('數不完的候選是 null／true，且 JSON.stringify 之後仍然不是 0', async () => {
    const messages = hourly(iso('2026-01-01T00:00:00'), 800)
    const set = buildCandidates([], messages[0]!, resolveName)
    const counts = await countByCandidate(fixtureFetcher(messages), [set.fallback.start])
    set.fallback.messageCount = counts[0]!.messageCount
    set.fallback.truncated = counts[0]!.truncated

    expect(set.fallback.messageCount).toBeNull()
    expect(set.fallback.truncated).toBe(true)

    const wire = JSON.parse(JSON.stringify(set.fallback)) as ScopeCandidate
    expect(wire.messageCount).toBeNull()
    expect(wire.messageCount).not.toBe(0)
    expect(wire.truncated).toBe(true)
  })

  it('⚠️ 截斷是逐個候選的 —— 近期那個候選仍然給出精確則數', async () => {
    /*
      800 則歷史（每小時一則），最近一次結案在最後 3 則之前。
      掃到 500 則就停 —— 但那 500 則已經完整涵蓋了「最近一次結案之後」那一段，
      因此那一列 MUST 是精確數字，MUST NOT 因為整批被截斷就變成「超過 500 則」。
    */
    const messages = hourly(iso('2026-01-01T00:00:00'), 800)
    const recentClosureAt = messages[messages.length - 4]!
    const recent: ClosureRecordRow = {
      recordId: 'rec_recent', itemId: 'bi_recent', draftId: 'draft_recent',
      conversationId: 'conv_1', closedAt: recentClosureAt, category: '發票補寄',
      reviewedBy: 'u_1', createdAt: recentClosureAt,
    }
    const set = buildCandidates([recent], messages[0]!, resolveName)
    const counts = await countByCandidate(
      fixtureFetcher(messages),
      [...set.candidates.map(c => c.start), set.fallback.start],
    )

    expect(counts[0]).toEqual({ messageCount: 4, truncated: false })
    expect(counts[1]).toEqual({ messageCount: null, truncated: true })
  })
})
