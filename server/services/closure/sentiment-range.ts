/**
 * 涵蓋區間內的情緒三數值（specs/006-closure-handoff-summary FR-022、FR-022a、FR-022b）。
 *
 * ⚠️⚠️ **本檔 MUST NOT 出現 `lowestScore`**（契約守衛 G2 會掃）。
 *      `SentimentBlock.stats.lowestScore` 是**整條時間軸**的最低點，
 *      這裡要的是**本次涵蓋區間內**的最低點。兩者都是 `number`、都叫「最低分」、
 *      取錯不會有任何型別錯誤 —— 對一個服務過三次的客戶，取錯會把半年前那次
 *      最生氣的分數寫進今天這份結案報告，而報表上看不出來。
 *
 * ⚠️ **三個數值 MUST 同時有值或同時為 `null`**，MUST NOT 部分有值。
 *    「起點沒涵蓋到但終點有」看起來像是可以只留終點 —— 不行：
 *    `sentiment_start` 與 `sentiment_end` 的用途是**比較**（客戶從幾分變到幾分），
 *    只有一半的比較是誤導，而不是少一半的資訊。
 *
 * ⚠️ 情緒時間軸是 **2 小時 sliding TTL** 的（`CopilotAnalysisState`），
 *    因此「區間起點早於時間軸最早一點」是常態而非例外 —— 長區間幾乎必然如此。
 *    這條路徑要正常、要有說明文字，MUST NOT 當成錯誤。
 */

import type { SentimentTimelineEntry } from '../../../shared/types/copilot.js'

export interface SentimentRangeResult {
  start: number | null
  end: number | null
  trough: number | null
  /** 有值 ＝ 上面三個是 `null`，內容說明實際涵蓋到哪裡（寫進 Board 的 `period_sentiment_note`） */
  note: string | null
}

/** 三者一起留空時的共用出口 —— 讓「部分有值」在程式碼層面沒有形成的機會 */
function unavailable(note: string): SentimentRangeResult {
  return { start: null, end: null, trough: null, note }
}

/**
 * @param timeline `CopilotAnalysisState.sentimentBlock.timeline`（全量，含純附件標記）
 * @param periodStart 涵蓋區間的起點（ISO8601）
 */
export function sentimentRange(
  timeline: SentimentTimelineEntry[],
  periodStart: string,
): SentimentRangeResult {
  // ⚠️ 只有 `kind === 'point'` 參與。`attachment_only` 是純附件發言的中性標記，
  //    沒有分數（001 FR-002／FR-012）—— 把它算進來會讓 `NaN` 一路寫進 Board。
  const points = timeline.filter(e => e.kind === 'point')
  if (points.length === 0) {
    return unavailable('這段期間沒有任何情緒評分點（客戶未發言，或評分尚未產生）')
  }

  const startMs = Date.parse(periodStart)
  if (Number.isNaN(startMs)) {
    return unavailable(`區間起點無法解析（${periodStart}），情緒數值留空`)
  }

  // ⚠️ 比的是**整條時間軸最早一點**，不是區間內最早一點 —— 後者恆晚於 periodStart，
  //    那個比較永遠成立，等於這條保護從來不會生效。
  const earliest = points.reduce((a, b) => (Date.parse(a.at) <= Date.parse(b.at) ? a : b))
  if (Date.parse(earliest.at) > startMs) {
    return unavailable(
      `情緒評分僅涵蓋 ${earliest.at} 起，未涵蓋區間起點 ${periodStart}`,
    )
  }

  const inRange = points.filter(p => Date.parse(p.at) >= startMs)
  if (inRange.length === 0) {
    return unavailable(`區間起點 ${periodStart} 之後沒有任何情緒評分點`)
  }

  const sorted = [...inRange].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!

  return {
    start: first.score,
    end: last.score,
    // ⚠️ **只在 `inRange` 裡找**。這一行是 FR-022a 的全部內容。
    trough: inRange.reduce((min, p) => (p.score < min ? p.score : min), inRange[0]!.score),
    note: null,
  }
}
