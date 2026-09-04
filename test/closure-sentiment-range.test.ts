/**
 * SC-006b／FR-022a／FR-022b：**區間內**的情緒三數值，以及「留空」與「0 分」可區分。
 *
 * 兩件被驗的事在型別層完全合法、在畫面上看不出來：
 *   ① `trough` 取成整條時間軸的最低點（`stats.lowestScore`）—— 兩者都是 `number`。
 *      對服務過三次的客戶，會把上一輪最生氣的分數寫進這一份報告。
 *   ② 「評分點不齊」被寫成 `0` —— 報表會把「這段情緒不可信」讀成「客戶情緒是最低分」。
 *      實測未設定的 Number 回讀為 `null`（spike 29 的 006-E4），因此表達方式是
 *      **不送該欄位**，而不是送 0。
 */

import { describe, expect, it } from 'vitest'
import type {
  ClosureSummary,
  SentimentPoint,
  SentimentTimelineEntry,
} from '../shared/types/copilot.js'
import { sentimentRange } from '../server/services/closure/sentiment-range.js'
import { toFieldsById } from '../server/services/closure/board-repository.js'
import { CLOSURE_BOARD_FIELDS } from '../server/services/closure/board-schema.js'

const T = (h: number): string => new Date(Date.UTC(2026, 8, 1, h, 0, 0)).toISOString()

function point(h: number, score: number): SentimentPoint {
  return {
    kind: 'point',
    messageId: `m_${h}`,
    at: T(h),
    score,
    label: score >= 60 ? 'neutral' : score >= 40 ? 'concerned' : 'frustrated',
    drivers: [],
  }
}

/**
 * 一條**跨兩個區間**的時間軸。前一個區間（08:00–10:00）含全局最低分 12；
 * 本次區間（12:00 起）的最低是 41。
 * ⚠️ 兩者刻意差很多 —— 取錯時的斷言訊息才看得出是取錯了哪一個。
 */
const CROSS_PERIOD: SentimentTimelineEntry[] = [
  point(8, 70),
  point(9, 12), // ← 全局最低，屬於**上一次服務**
  point(10, 55),
  point(12, 64),
  point(13, 41), // ← 本次區間最低
  point(14, 78),
]

const GLOBAL_LOWEST = 12

describe('FR-022a：trough 是區間內的最低點，不是整條時間軸的最低點', () => {
  it('跨兩個區間時，trough 取本區間最小值且不等於全局最低', () => {
    const r = sentimentRange(CROSS_PERIOD, T(12))
    expect(r.trough).toBe(41)
    expect(r.trough).not.toBe(GLOBAL_LOWEST)
    expect(r.start).toBe(64)
    expect(r.end).toBe(78)
    expect(r.note).toBeNull()
  })

  it('區間涵蓋整條時間軸時，trough 才等於全局最低（反向確認取數沒有寫死）', () => {
    const r = sentimentRange(CROSS_PERIOD, T(8))
    expect(r.trough).toBe(GLOBAL_LOWEST)
  })

  it('純附件標記不參與計算 —— 它沒有分數', () => {
    const withMarker: SentimentTimelineEntry[] = [
      ...CROSS_PERIOD,
      { kind: 'attachment_only', messageId: 'm_att', at: T(13) },
    ]
    const r = sentimentRange(withMarker, T(12))
    expect(r.trough).toBe(41)
    expect(Number.isNaN(r.trough as number)).toBe(false)
  })
})

describe('FR-022b：三個數值同時有值或同時為 null，且留空必附原因', () => {
  it('時間軸最早一點晚於區間起點 → 三者一起 null ＋ note 有值', () => {
    // 情緒時間軸是 2 小時 sliding TTL，長區間幾乎必然如此 —— 這是常態不是錯誤
    const r = sentimentRange(CROSS_PERIOD, T(6))
    expect(r).toMatchObject({ start: null, end: null, trough: null })
    expect(r.note).toBeTruthy()
    expect(r.note).toContain(T(8)) // 誠實說出實際涵蓋到哪裡
  })

  it('區間內完全沒有評分點 → 三者一起 null ＋ note 有值', () => {
    const r = sentimentRange(CROSS_PERIOD, T(20))
    expect(r).toMatchObject({ start: null, end: null, trough: null })
    expect(r.note).toBeTruthy()
  })

  it('完全沒有評分點的時間軸 → 三者一起 null ＋ note 有值', () => {
    const r = sentimentRange([], T(12))
    expect(r).toMatchObject({ start: null, end: null, trough: null })
    expect(r.note).toBeTruthy()
  })

  it('⚠️「部分有值」在任何輸入下都不可能出現（窮舉區間起點）', () => {
    // 每個小時當一次起點，含區間外、區間邊界、區間內
    for (let h = 0; h <= 24; h++) {
      const r = sentimentRange(CROSS_PERIOD, T(h))
      const filled = [r.start, r.end, r.trough].filter(v => v !== null).length
      expect(filled, `以 ${T(h)} 為起點時出現了「部分有值」`).toBeOneOf([0, 3])
      // note 與三數值是互斥的：有值 ⇔ 三者為 null
      expect(r.note === null, `以 ${T(h)} 為起點時 note 與數值不一致`).toBe(filled === 3)
    }
  })
})

describe('FR-022b：寫進 Board 時「留空」與「0 分」可區分', () => {
  const fieldIds = new Map(CLOSURE_BOARD_FIELDS.map(f => [f.name, `fid_${f.name}`]))

  const summaryWith = (over: Partial<ClosureSummary>): ClosureSummary => ({
    recordId: 'rec_1',
    draftId: 'draft_1',
    conversationId: 'conv_1',
    periodStart: T(12),
    periodMessageCount: 9,
    periodOrigin: 'closure',
    channel: 'line',
    contactId: 'con_1',
    operators: ['u_1'],
    joinedAt: T(12),
    closedAt: T(15),
    summary: '摘要',
    intent: '意圖',
    category: '發票補寄',
    resolution: 'resolved',
    actionsTaken: [],
    sentimentOutcome: 'appeased',
    sentimentStart: null,
    sentimentEnd: null,
    sentimentTrough: null,
    sentimentNote: null,
    citedSopIds: [],
    followUps: [],
    confidence: null,
    reviewedBy: 'u_1',
    reviewedAt: T(15),
    ...over,
  })

  it('null 的情緒欄位**不出現在 body 裡**（＝ Board 上留空）', () => {
    const body = toFieldsById(summaryWith({ sentimentNote: '評分點不齊' }), fieldIds)
    for (const name of ['sentiment_start', 'sentiment_end', 'sentiment_trough', 'confidence']) {
      expect(Object.hasOwn(body, `fid_${name}`), `${name} 不該出現在 body 裡`).toBe(false)
    }
    // 留空的原因反過來一定要在
    expect(body.fid_period_sentiment_note).toBe('評分點不齊')
  })

  it('0 分**出現在 body 裡**（留空與 0 因此可區分）', () => {
    const body = toFieldsById(
      summaryWith({ sentimentStart: 0, sentimentEnd: 0, sentimentTrough: 0, confidence: 0 }),
      fieldIds,
    )
    for (const name of ['sentiment_start', 'sentiment_end', 'sentiment_trough', 'confidence']) {
      expect(Object.hasOwn(body, `fid_${name}`), `${name} 是 0，MUST 送出`).toBe(true)
      expect(body[`fid_${name}`]).toBe(0)
    }
  })

  it('null 的 periodMessageCount 同樣不送（「超過 500 則」不是 0 則）', () => {
    const body = toFieldsById(summaryWith({ periodMessageCount: null }), fieldIds)
    expect(Object.hasOwn(body, 'fid_period_message_count')).toBe(false)

    const zero = toFieldsById(summaryWith({ periodMessageCount: 0 }), fieldIds)
    expect(zero.fid_period_message_count).toBe(0)
  })
})
