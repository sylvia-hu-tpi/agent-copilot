/**
 * 引用稽核事件 —— specs/005-m2-residual-defects US3（FR-015／FR-015a／FR-016、SC-005），
 * contracts/citation-audit-event.md 就是本檔的規格。
 *
 * ⚠️ 「這次為什麼沒有引用」在畫面上與日誌上長得一模一樣：知識庫沒命中、模型沒引用、杜撰後被白名單
 *    擋下、模型回空、第二段失敗 —— 五者處置完全不同。這一組測試守的是「由事件的 outcome 即可判定，
 *    不需重跑分析、不需讀程式碼」。六值情境走的是**生產管線**（`runColdStart()` → 第二段尾巴），
 *    不是對純函式餵數字而已 —— 事件是不是真的在三條落定路徑上都發了，只有這樣驗得到。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { awaitSuggestionTail, runColdStart, runIncremental } from '../server/services/copilot-analysis.js'
import { setAIProvider } from '../server/services/ai/index.js'
import { MockAIProvider } from '../server/services/ai/mock-ai-provider.js'
import { AIProviderHttpError } from '../server/services/ai/retry-policy.js'
import { setKnowledgeProvider } from '../server/services/knowledge/index.js'
import { MockKnowledgeProvider } from '../server/services/knowledge/mock-knowledge-provider.js'
import { useStateStore } from '../server/state/index.js'
import {
  CITATION_AUDIT_EVENT,
  collapseSopId,
  configureCitationAuditForTests,
  deriveCitationOutcome,
  emitCitationAudit,
  INVALID_SOP_ID_MAX_LENGTH,
  onCitationAudit,
  parseCitationAuditLine,
  resetCitationAuditForTests,
  type CitationAuditEvent,
} from '../server/utils/citation-audit.js'
import type { Message } from '../shared/types/conversation.js'
import type { SuggestionCard } from '../shared/types/copilot.js'
import type { KnowledgeHit } from '../shared/types/knowledge.js'

let seq = 0
function customer(convId: string): Message {
  seq++
  return {
    id: `m_ca_${seq}`,
    conversationId: convId,
    at: new Date(Date.now() - 60_000 + seq * 1000).toISOString(),
    sender: { type: 'customer', id: 'con_1' },
    text: '電梯困人了，怎麼辦',
  }
}

function convId(label: string): string {
  return `conv-ca-${label}-${Date.now()}-${++seq}`
}

function card(sopId: string | null): SuggestionCard {
  return {
    id: `card-${Math.random()}`,
    sopId,
    sopTitle: sopId ? `標題-${sopId}` : null,
    text: '建議先安撫客戶',
    confidence: null,
    rationale: '理由',
    tone: 'apologetic',
    requiresData: [],
    supersededBy: null,
  }
}

/** 第一段（無命中）照常回一張卡；第二段（有命中）依情境回 */
function stage2AI(stage2: (hits: KnowledgeHit[]) => SuggestionCard[] | Error): void {
  setAIProvider(new (class extends MockAIProvider {
    override async suggest(input: { history: Message[], knowledgeHits: KnowledgeHit[], aiReplies: boolean }) {
      if (input.knowledgeHits.length === 0) return [card(null)]
      const out = stage2(input.knowledgeHits)
      if (out instanceof Error) throw out
      return out
    }
  })())
}

function collect(): { events: CitationAuditEvent[], lines: string[] } {
  const events: CitationAuditEvent[] = []
  const lines: string[] = []
  configureCitationAuditForTests({ file: null, stdout: l => lines.push(l), stderr: () => {} })
  onCitationAudit(e => events.push(e))
  return { events, lines }
}

async function coldStartAndSettle(id: string): Promise<void> {
  await runColdStart(id, [customer(id)], false)
  await awaitSuggestionTail(id)
}

beforeEach(() => {
  resetCitationAuditForTests()
  setKnowledgeProvider(new MockKnowledgeProvider())
})

afterEach(() => {
  resetCitationAuditForTests()
  setAIProvider(new MockAIProvider())
  setKnowledgeProvider(new MockKnowledgeProvider())
})

// ── T034：六值判定 ────────────────────────────────────────────────

describe('deriveCitationOutcome()：六值與判定順序（contracts §2）', () => {
  const base = { hitCount: 2, cardsReturned: 3, cardsKept: 3, citedKept: 2 }

  it('cited／not-cited／discarded／no-cards／failed／no-hits 各一組', () => {
    expect(deriveCitationOutcome(base)).toBe('cited')
    expect(deriveCitationOutcome({ ...base, citedKept: 0 })).toBe('not-cited')
    expect(deriveCitationOutcome({ ...base, cardsKept: 0, citedKept: 0 })).toBe('discarded')
    expect(deriveCitationOutcome({ ...base, cardsReturned: 0, cardsKept: 0, citedKept: 0 })).toBe('no-cards')
    expect(deriveCitationOutcome({ ...base, failed: true })).toBe('failed')
    expect(deriveCitationOutcome({ hitCount: 0, cardsReturned: 1, cardsKept: 1, citedKept: 0 })).toBe('no-hits')
  })

  it('hitCount === 0 一律 no-hits —— 沒有命中就沒有引用可談，失敗與回空也一樣', () => {
    expect(deriveCitationOutcome({ hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, failed: true })).toBe('no-hits')
    expect(deriveCitationOutcome({ hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0 })).toBe('no-hits')
  })

  it('有命中時 failed 優先於其他判定（失敗時卡數本來就是 0，不能被誤判成 no-cards）', () => {
    expect(deriveCitationOutcome({ hitCount: 1, cardsReturned: 0, cardsKept: 0, citedKept: 0, failed: true })).toBe('failed')
  })
})

describe('走生產管線：三條落定路徑都發事件，且 FR-016 的靜默行為未變', () => {
  it('discarded：第二段全數杜撰 sopId → 整卡捨棄，status 仍 ready、citation 落 none，事件記下杜撰字串', async () => {
    const { events } = collect()
    stage2AI(() => [card('fabricated-sop-id'), card('another-fake')])
    const id = convId('discarded')
    await coldStartAndSettle(id)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: CITATION_AUDIT_EVENT,
      conversationId: id,
      stage: 2,
      hitCount: 2,
      cardsReturned: 2,
      cardsKept: 0,
      invalidSopIds: ['fabricated-sop-id', 'another-fake'],
      outcome: 'discarded',
    })
    const block = (await useStateStore().getAnalysisState(id))!.suggestionBlock
    expect(block.status).toBe('ready') // 不轉 error
    expect(block.citation).toBe('none') // 靜默落 none
    expect(block.cards).toHaveLength(1) // 第一段的卡維持不動
    expect(block.retryAttempt).toBeUndefined() // 不閃「重試中」
  })

  it('no-cards：第二段回 0 張 → outcome no-cards，靜默 none', async () => {
    const { events } = collect()
    stage2AI(() => [])
    const id = convId('no-cards')
    await coldStartAndSettle(id)

    expect(events.map(e => e.outcome)).toEqual(['no-cards'])
    expect(events[0]).toMatchObject({ hitCount: 2, cardsReturned: 0, cardsKept: 0 })
    const block = (await useStateStore().getAnalysisState(id))!.suggestionBlock
    expect(block.status).toBe('ready')
    expect(block.citation).toBe('none')
  })

  it('failed：第二段呼叫失敗 → outcome failed，靜默 none、不轉 error、不重試', async () => {
    const { events } = collect()
    stage2AI(() => new AIProviderHttpError('boom', 500))
    const id = convId('failed')
    await coldStartAndSettle(id)

    expect(events.map(e => e.outcome)).toEqual(['failed'])
    expect(events[0]).toMatchObject({ hitCount: 2, cardsReturned: 0, cardsKept: 0, invalidSopIds: [] })
    const block = (await useStateStore().getAnalysisState(id))!.suggestionBlock
    expect(block.status).toBe('ready')
    expect(block.citation).toBe('none')
  })

  it('cited：第二段引用了命中的 id', async () => {
    const { events } = collect()
    stage2AI(hits => [card(hits[0]!.id), card(null)])
    const id = convId('cited')
    await coldStartAndSettle(id)

    expect(events.map(e => e.outcome)).toEqual(['cited'])
    expect(events[0]).toMatchObject({ cardsReturned: 2, cardsKept: 2, invalidSopIds: [] })
    expect((await useStateStore().getAnalysisState(id))!.suggestionBlock.citation).toBe('cited')
  })

  it('not-cited：命中了但模型全部填 null', async () => {
    const { events } = collect()
    stage2AI(() => [card(null), card(null)])
    const id = convId('not-cited')
    await coldStartAndSettle(id)

    expect(events.map(e => e.outcome)).toEqual(['not-cited'])
    expect(events[0]).toMatchObject({ hitCount: 2, cardsReturned: 2, cardsKept: 2 })
  })

  it('no-hits：知識庫本次未命中', async () => {
    const { events } = collect()
    setKnowledgeProvider({ async search() { return [] } })
    const id = convId('no-hits')
    await coldStartAndSettle(id)

    expect(events.map(e => e.outcome)).toEqual(['no-hits'])
    expect(events[0]).toMatchObject({ hitCount: 0, stage: 2 })
  })

  it('背景單段（stage 1）也發事件：命中且引用 → cited', async () => {
    const { events } = collect()
    stage2AI(hits => [card(hits[0]!.id)])
    const id = convId('single')
    await runColdStart(id, [customer(id)], false)
    await awaitSuggestionTail(id)
    events.length = 0

    await runIncremental(id, [customer(id)], 'background', false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ stage: 1, outcome: 'cited', hitCount: 2 })
  })

  it('混合：一張杜撰、一張合法 → 合法的留下，outcome cited，invalidSopIds 只記杜撰的那一個', async () => {
    const { events } = collect()
    stage2AI(hits => [card('fake-1'), card(hits[1]!.id)])
    const id = convId('mixed')
    await coldStartAndSettle(id)

    expect(events[0]).toMatchObject({ cardsReturned: 2, cardsKept: 1, invalidSopIds: ['fake-1'], outcome: 'cited' })
  })
})

// ── T035：PII 型別守與長度收斂 ──────────────────────────────────────

describe('PII（憲法 1.5）：型別守 ＋ invalidSopIds 的機械式收斂', () => {
  it('text／title／snippet 在型別上塞不進事件（@ts-expect-error：少了守衛 tsc 會在這裡紅）', () => {
    const ok: CitationAuditEvent = {
      event: CITATION_AUDIT_EVENT, at: '', conversationId: 'c', anchor: null, stage: 2,
      hitCount: 0, cardsReturned: 0, cardsKept: 0, invalidSopIds: [], outcome: 'no-hits',
    }
    // @ts-expect-error text 標成 never
    const withText: CitationAuditEvent = { ...ok, text: '客戶說的話' }
    // @ts-expect-error title 標成 never
    const withTitle: CitationAuditEvent = { ...ok, title: '知識庫標題' }
    // @ts-expect-error snippet 標成 never
    const withSnippet: CitationAuditEvent = { ...ok, snippet: '片段' }
    expect([withText, withTitle, withSnippet]).toHaveLength(3)
  })

  it('invalidSopIds 有被保留（它是 FR-017 歸因的原料，不是 PII）', () => {
    const { events } = collect()
    emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 1, cardsReturned: 1, cardsKept: 0, citedKept: 0, invalidSopIds: ['looks-like-an-id-123'] })
    expect(events[0]?.invalidSopIds).toEqual(['looks-like-an-id-123'])
  })

  it('長度收斂：≤64 原樣保留、>64 改記 sha256:<前16碼>+<原長度>，且原字串不出現在輸出裡', () => {
    const short = 'x'.repeat(INVALID_SOP_ID_MAX_LENGTH)
    const long = '客戶整段客訴文字被模型塞進 sopId 欄位'.repeat(5)
    expect(long.length).toBeGreaterThan(INVALID_SOP_ID_MAX_LENGTH)
    expect(collapseSopId(short)).toBe(short)
    expect(collapseSopId(long)).toMatch(new RegExp(`^sha256:[0-9a-f]{16}\\+${long.length}$`))

    const { events, lines } = collect()
    emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 1, cardsReturned: 2, cardsKept: 0, citedKept: 0, invalidSopIds: [short, long] })
    expect(events[0]?.invalidSopIds[0]).toBe(short)
    expect(lines.join('')).not.toContain(long)
    expect(lines.join('')).toContain('sha256:')
  })

  it('同一個超長字串收斂後仍相等（判得出重複出現），不同字串不相等', () => {
    const a = 'a'.repeat(100)
    const b = 'b'.repeat(100)
    expect(collapseSopId(a)).toBe(collapseSopId(a))
    expect(collapseSopId(a)).not.toBe(collapseSopId(b))
  })
})

// ── T036：落點與降級（FR-015、FR-015a）─────────────────────────────

describe('落點：標準輸出是完整集合，額外落點只是拷貝', () => {
  it('每一筆都寫到 stdout 一行 NDJSON，且解析得回來', () => {
    const { lines } = collect()
    emitCitationAudit({ conversationId: 'c', anchor: 'm1', stage: 2, hitCount: 2, cardsReturned: 1, cardsKept: 1, citedKept: 1, invalidSopIds: [] })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith('\n')).toBe(true)
    const parsed = parseCitationAuditLine(lines[0]!.trim())
    expect(parsed).toMatchObject({ event: CITATION_AUDIT_EVENT, outcome: 'cited', anchor: 'm1' })
    expect(parseCitationAuditLine('{"event":"other"}')).toBeNull()
    expect(parseCitationAuditLine('not json')).toBeNull()
  })

  it('額外落點開啟時：檔案裡是同一行的拷貝，stdout 仍然完整', () => {
    const dir = mkdtempSync(join(tmpdir(), 'citation-audit-'))
    const file = join(dir, 'nested', 'audit.jsonl')
    const lines: string[] = []
    const errors: string[] = []
    configureCitationAuditForTests({ file, stdout: l => lines.push(l), stderr: l => errors.push(l) })

    emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, invalidSopIds: [] })
    emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 1, cardsReturned: 1, cardsKept: 1, citedKept: 1, invalidSopIds: [] })

    expect(lines).toHaveLength(2)
    expect(readFileSync(file, 'utf8')).toBe(lines.join(''))
    expect(errors).toEqual([])
  })

  it('FR-015a：開檔失敗 → 不拋出、不中止、stdout 仍完整、stderr 留一行可辨識的原因', () => {
    const dir = mkdtempSync(join(tmpdir(), 'citation-audit-'))
    const blocker = join(dir, 'a-regular-file')
    writeFileSync(blocker, 'x') // 把「目錄」的位置放一個檔案 → mkdir 必失敗
    const file = join(blocker, 'audit.jsonl')
    const lines: string[] = []
    const errors: string[] = []
    configureCitationAuditForTests({ file, stdout: l => lines.push(l), stderr: l => errors.push(l) })

    expect(() => {
      emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, invalidSopIds: [] })
      emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, invalidSopIds: [] })
    }).not.toThrow()

    expect(lines).toHaveLength(2) // 標準輸出的事件仍完整
    expect(errors).toHaveLength(1) // 只留一行，不是每筆都吼
    expect(errors[0]).toMatch(/citation-audit/)
    expect(errors[0]).toMatch(/開檔失敗/)
  })

  it('相對路徑一律拒絕（容器裡 WORKDIR 屬 root 卻跑非 root 的坑）：降級並留一行', () => {
    const lines: string[] = []
    const errors: string[] = []
    configureCitationAuditForTests({ file: 'logs/audit.jsonl', stdout: l => lines.push(l), stderr: l => errors.push(l) })
    emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, invalidSopIds: [] })
    expect(lines).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/絕對路徑/)
  })

  it('預設不啟用額外落點：沒有設定時只寫 stdout、不碰檔案系統、stderr 安靜', () => {
    const lines: string[] = []
    const errors: string[] = []
    configureCitationAuditForTests({ file: null, stdout: l => lines.push(l), stderr: l => errors.push(l) })
    emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, invalidSopIds: [] })
    expect(lines).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('訂閱者拋錯不影響其他訂閱者，也不影響呼叫端（憲法 3.2）', () => {
    collect()
    const seen: string[] = []
    onCitationAudit(() => { throw new Error('壞掉的訂閱者') })
    onCitationAudit(e => seen.push(e.outcome))
    expect(() => emitCitationAudit({ conversationId: 'c', anchor: null, stage: 2, hitCount: 0, cardsReturned: 0, cardsKept: 0, citedKept: 0, invalidSopIds: [] })).not.toThrow()
    expect(seen).toEqual(['no-hits'])
  })
})
