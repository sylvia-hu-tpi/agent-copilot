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
import type { ClosureRecordRow } from '../server/services/closure/board-repository.js'
import { preserveSentimentOnUpdate, toFieldsById } from '../server/services/closure/board-repository.js'
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
    const r = sentimentRange(CROSS_PERIOD, T(12), T(12))
    expect(r.trough).toBe(41)
    expect(r.trough).not.toBe(GLOBAL_LOWEST)
    expect(r.start).toBe(64)
    expect(r.end).toBe(78)
    expect(r.note).toBeNull()
  })

  it('區間涵蓋整條時間軸時，trough 才等於全局最低（反向確認取數沒有寫死）', () => {
    const r = sentimentRange(CROSS_PERIOD, T(8), T(8))
    expect(r.trough).toBe(GLOBAL_LOWEST)
  })

  it('純附件標記不參與計算 —— 它沒有分數', () => {
    const withMarker: SentimentTimelineEntry[] = [
      ...CROSS_PERIOD,
      { kind: 'attachment_only', messageId: 'm_att', at: T(13) },
    ]
    const r = sentimentRange(withMarker, T(12), T(12))
    expect(r.trough).toBe(41)
    expect(Number.isNaN(r.trough as number)).toBe(false)
  })
})

describe('FR-022b：三個數值同時有值或同時為 null，且留空必附原因', () => {
  it('時間軸最早一點晚於**區間內第一則客戶發言** → 三者一起 null ＋ note 有值', () => {
    /*
      真正「評分不齊」的形狀：客戶在 06:00 就發過言（`firstCustomerAt`），
      但時間軸最早的評分點是 08:00 —— 中間那兩小時的發言沒有被評到
      （冷啟動只讀最新 50 則，或 2 小時 sliding TTL 已回收）。
      此時 08:00 的分數**不是**這段服務的起始情緒，三者 MUST 一起留空。
    */
    const r = sentimentRange(CROSS_PERIOD, T(6), T(6))
    expect(r).toMatchObject({ start: null, end: null, trough: null })
    expect(r.note).toBeTruthy()
    expect(r.note).toContain(T(8)) // 誠實說出實際涵蓋到哪裡
  })

  it('⚠️ 區間起點早於時間軸、但區間內第一則客戶發言有被評到 → 照樣給數值', () => {
    /*
      **2026-09-08 的回歸測試。** 這是回頭客的形狀，也是舊判準最常誤傷的一種：

        區間起點 = 上一次結案時間（06:00）
        客戶隔了一段時間才回來，這次第一則發言在 08:00 且有被評分
        → 06:00 到 08:00 之間根本沒有任何訊息，沒有任何評分「漏掉」

      舊判準拿時間軸最早的點（08:00）去比**區間起點**（06:00），必然判成「未涵蓋」，
      於是每一位回頭客的三個情緒欄都是空的 —— 而資料其實是完整的。
      ⚠️ 判準改回比 `periodStart` 的話，這條會紅。
    */
    const r = sentimentRange(CROSS_PERIOD, T(6), T(8))
    expect(r.note, '區間內第一則客戶發言已被評到，MUST NOT 判成未涵蓋').toBeNull()
    expect(r.start).toBe(70)
    expect(r.end).toBe(78)
    expect(r.trough).toBe(GLOBAL_LOWEST)
  })

  it('區間內完全沒有評分點 → 三者一起 null ＋ note 有值', () => {
    const r = sentimentRange(CROSS_PERIOD, T(20), null)
    expect(r).toMatchObject({ start: null, end: null, trough: null })
    expect(r.note).toBeTruthy()
  })

  it('完全沒有評分點的時間軸 → 三者一起 null ＋ note 有值', () => {
    const r = sentimentRange([], T(12), T(12))
    expect(r).toMatchObject({ start: null, end: null, trough: null })
    expect(r.note).toBeTruthy()
  })

  it('⚠️「部分有值」在任何輸入下都不可能出現（窮舉區間起點 × 三種 firstCustomerAt）', () => {
    /*
      三種 `firstCustomerAt` 各自代表一種真實情境：
        `null`  → 區間內客戶完全沒有文字發言
        `T(h)`  → 區間內第一則客戶發言就落在區間起點（一般情況）
        `T(8)`  → 客戶隔一段時間才回來（回頭客；起點之後才有第一則發言）
    */
    for (let h = 0; h <= 24; h++) {
      for (const firstCustomerAt of [null, T(h), T(8)]) {
        const r = sentimentRange(CROSS_PERIOD, T(h), firstCustomerAt)
        const label = `起點 ${T(h)}／firstCustomerAt ${firstCustomerAt}`
        const filled = [r.start, r.end, r.trough].filter(v => v !== null).length
        expect(filled, `${label} 時出現了「部分有值」`).toBeOneOf([0, 3])
        // note 與三數值是互斥的：有值 ⇔ 三者為 null
        expect(r.note === null, `${label} 時 note 與數值不一致`).toBe(filled === 3)
      }
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

  it('⚠️ 欄位齊全：填滿的 summary MUST 送出 CLOSURE_BOARD_FIELDS 的每一欄', () => {
    /*
      **`board-schema.ts` 檔頭自己警告的失效形態，2026-09-08 補上守衛。**

      `toFieldsById()` 內部的對照表是手寫的，而迴圈遇到對照表沒有的欄位是
      **靜默 `continue`** —— 與「這一欄的值是 null」完全分不出來。
      於是「在 board-schema 新增一欄但忘了加進對照表」的症狀是：
      寫入照樣 200、`npm run board:verify` 也過（它只比 schema），
      該欄在報表上永遠空白，而沒有任何錯誤訊息。
    */
    const full = summaryWith({
      periodMessageCount: 9,
      sentimentStart: 60,
      sentimentEnd: 80,
      sentimentTrough: 40,
      // ⚠️ 情緒有值時 note 必為 null（FR-022b），因此這一欄改由下面單獨驗
      sentimentNote: null,
      actionsTaken: ['已回覆'],
      citedSopIds: ['sop_1'],
      followUps: [{ action: '三日內回電' }],
      confidence: 55,
    })
    const body = toFieldsById(full, fieldIds)

    const missing = CLOSURE_BOARD_FIELDS
      .map(f => f.name)
      // 這一欄與三個情緒數值互斥，不可能同時有值
      .filter(name => name !== 'period_sentiment_note')
      .filter(name => !Object.hasOwn(body, `fid_${name}`))
    expect(missing, `這些欄位在 toFieldsById() 的對照表裡漏了：${missing.join('、')}`).toEqual([])

    // 反向：note 有值那一路也要送得出去
    const blanked = toFieldsById(summaryWith({ sentimentNote: '評分點不齊' }), fieldIds)
    expect(blanked.fid_period_sentiment_note).toBe('評分點不齊')
  })
})

describe('FR-022b：重試寫入 MUST NOT 留下「有數值又有說明」的自相矛盾列', () => {
  const row = (over: Partial<ClosureRecordRow> = {}): ClosureRecordRow => ({
    recordId: 'rec_1',
    itemId: 'bi_1',
    draftId: 'draft_1',
    conversationId: 'conv_1',
    closedAt: T(15),
    category: '發票補寄',
    reviewedBy: 'u_1',
    createdAt: T(15),
    sentimentStart: 35,
    sentimentEnd: 70,
    sentimentTrough: 20,
    ...over,
  })

  const summary = (over: Partial<ClosureSummary>): ClosureSummary => ({
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

  it('分析狀態過期後重試：沿用既有列的數值，並且不寫那句矛盾的說明', () => {
    /*
      ① 第一次寫入時分析狀態還在 → 35／70／20 進了 Board。
      ② 平台回應超過 30 秒硬逾時 → 客服看到「寫入失敗」，但紀錄其實已經建立。
      ③ 兩小時後重試 → `CopilotAnalysisState` 的 sliding TTL 已過期，重算是三個 null
         ＋ 一句「這段期間沒有任何情緒評分點」。
      ④ `toFieldsById()` 不送 null、平台又是部分更新 → 沒有這道保護的話，
         Board 上會同時有 35／70／20 和一句說沒有評分點的說明。
    */
    const merged = preserveSentimentOnUpdate(
      summary({ sentimentNote: '這段期間沒有任何情緒評分點（客戶未發言，或評分尚未產生）' }),
      row(),
    )
    expect(merged.sentimentStart).toBe(35)
    expect(merged.sentimentEnd).toBe(70)
    expect(merged.sentimentTrough).toBe(20)
    expect(merged.sentimentNote, '有數值就 MUST NOT 同時有說明').toBeNull()
  })

  it('這次算得出數值時，一律以這次的為準（MUST NOT 被既有列蓋回去）', () => {
    const merged = preserveSentimentOnUpdate(
      summary({ sentimentStart: 10, sentimentEnd: 20, sentimentTrough: 5 }),
      row(),
    )
    expect([merged.sentimentStart, merged.sentimentEnd, merged.sentimentTrough]).toEqual([10, 20, 5])
  })

  it('既有列也沒有數值時，原樣保留這次的說明（沒有東西可沿用）', () => {
    const merged = preserveSentimentOnUpdate(
      summary({ sentimentNote: '評分點不齊' }),
      row({ sentimentStart: null, sentimentEnd: null, sentimentTrough: null }),
    )
    expect(merged.sentimentStart).toBeNull()
    expect(merged.sentimentNote).toBe('評分點不齊')
  })

  it('⚠️ 0 分是有效值，MUST NOT 被當成「沒有資料」而沿用舊值', () => {
    const merged = preserveSentimentOnUpdate(
      summary({ sentimentStart: 0, sentimentEnd: 0, sentimentTrough: 0 }),
      row(),
    )
    expect([merged.sentimentStart, merged.sentimentEnd, merged.sentimentTrough]).toEqual([0, 0, 0])
  })
})
