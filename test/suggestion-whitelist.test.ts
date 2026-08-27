/**
 * 建議卡白名單後驗與 confidence 強制歸零 —— specs/002-suggestion-knowledge-search。
 *
 * FR-003、憲法 4.3：`sopId` 不在白名單者整卡捨棄（非僅清空欄位）。
 * FR-002、憲法 4.4：`knowledgeHits` 全數 `score === null` 時，`confidence` MUST 被覆寫為 `null`。
 */

import { describe, expect, it } from 'vitest'
import { forceNullConfidence, whitelistFilter } from '../server/services/copilot-analysis.js'
import type { SuggestionCard } from '../shared/types/copilot.js'
import type { KnowledgeHit } from '../shared/types/knowledge.js'

function hit(id: string, score: number | null = null): KnowledgeHit {
  return {
    id,
    title: `文件 ${id}`,
    snippet: '內容片段',
    score,
    updatedAt: null,
    sourceRef: { type: 'knowledge', ref: id },
  }
}

function card(overrides: Partial<SuggestionCard> = {}): SuggestionCard {
  return {
    id: `card-${Math.random()}`,
    sopId: null,
    sopTitle: null,
    text: '建議回覆內容',
    confidence: null,
    rationale: '理由',
    tone: 'informative',
    requiresData: [],
    supersededBy: null,
    ...overrides,
  }
}

describe('whitelistFilter()（FR-003、憲法 4.3）', () => {
  it('sopId 存在於本次 knowledgeHits 集合中時保留', () => {
    const cards = [card({ sopId: 'h1' })]
    expect(whitelistFilter(cards, [hit('h1'), hit('h2')])).toEqual(cards)
  })

  it('sopId 不在白名單中時整卡捨棄，不只清空欄位', () => {
    const cards = [card({ sopId: 'not-in-hits', text: '幻覺引用的內容' })]
    expect(whitelistFilter(cards, [hit('h1')])).toEqual([])
  })

  it('sopId 為 null 時一律保留（無引用是合法情境，FR-004）', () => {
    const cards = [card({ sopId: null })]
    expect(whitelistFilter(cards, [])).toEqual(cards)
  })

  it('全數因白名單捨棄後回傳空陣列', () => {
    const cards = [card({ sopId: 'x' }), card({ sopId: 'y' })]
    expect(whitelistFilter(cards, [hit('z')])).toEqual([])
  })

  it('部分卡片合法、部分捨棄時只保留合法的', () => {
    const legal = card({ sopId: 'h1', id: 'legal' })
    const illegal = card({ sopId: 'ghost', id: 'illegal' })
    const noRef = card({ sopId: null, id: 'no-ref' })
    expect(whitelistFilter([legal, illegal, noRef], [hit('h1')])).toEqual([legal, noRef])
  })
})

describe('forceNullConfidence()（FR-002、憲法 4.4）', () => {
  it('knowledgeHits 全數 score 為 null 時，模型自評的 confidence 一律覆寫為 null', () => {
    const cards = [card({ confidence: 87 })]
    const result = forceNullConfidence(cards, [hit('h1', null), hit('h2', null)])
    expect(result[0]!.confidence).toBeNull()
  })

  it('knowledgeHits 為空陣列時同樣強制歸零（沒有分數來源，等同全數為 null）', () => {
    const cards = [card({ confidence: 42 })]
    expect(forceNullConfidence(cards, [])[0]!.confidence).toBeNull()
  })

  it('knowledgeHits 存在非 null 分數時，不覆寫既有 confidence（未來 viki 路徑保留彈性）', () => {
    const cards = [card({ confidence: 55 })]
    const result = forceNullConfidence(cards, [hit('h1', 0.9)])
    expect(result[0]!.confidence).toBe(55)
  })

  it('不修改原陣列（純函式）', () => {
    const cards = [card({ confidence: 87 })]
    const result = forceNullConfidence(cards, [hit('h1', null)])
    expect(result).not.toBe(cards)
    expect(cards[0]!.confidence).toBe(87)
  })
})
