/**
 * 情緒面板（摘要卡與情緒 Sparkline）的資料契約 —— specs/001-sentiment-panel/data-model.md。
 *
 * ⚠️ 本檔的型別供前後端共用，經 SSE `summary.updated`／`sentiment.updated` 事件傳遞
 *    （見 shared/types/events.ts）。AI 直接輸出的欄位（ConversationSummary 全部欄位、
 *    SentimentPoint.score/label/drivers）在進入這裡之前 MUST 已通過 Zod 驗證
 *    （憲法 4.2，見 server/services/ai/schemas.ts）。
 */

import type { Message } from './conversation.js'

// ── 區塊狀態 ──────────────────────────────────────────────────────────

export type AnalysisBlockStatus =
  | 'empty'      // 尚無可供分析內容（FR-009）—— 例如剛 JOIN 且客戶尚無發言
  | 'analyzing'  // 首次分析進行中（FR-011）
  | 'retrying'   // 暫時性失敗後自動重試中，附帶重試次數（FR-014）
  | 'ready'      // 該區塊本身已完成（另一區塊可能仍在 analyzing —— 區塊層級漸進呈現，FR-011）
  | 'error'      // 自動重試用盡或非暫時性失敗，等待手動重試（FR-006、FR-008）

// ── 摘要卡 ────────────────────────────────────────────────────────────

/** 沿用 docs/ARCHITECTURE.md §11.5 已定案的形狀，原樣落地 */
export interface ConversationSummary {
  intent: string
  keyFacts: string[]
  attempted: string[]
  openIssues: string[]
  riskFlags: Array<'churn' | 'escalation' | 'compliance' | 'vip' | 'repeat_contact'>
  advice: string
  updatedAt: string
  /** 版本錨點，用於增量與快取（§11.3） */
  basedOnMessageId: string
}

export interface SummaryBlock {
  status: AnalysisBlockStatus
  /** status === 'retrying' 時的當前次數（1 或 2），對應 FR-014「重試中 (1/2)」 */
  retryAttempt?: number
  /**
   * 本輪失敗序列的首次失敗時間戳（ISO8601），僅 status ∈ {retrying, error} 時有值，
   * 成功或未曾失敗時為 undefined。供前端／測試驗證 FR-014 的 40 秒預算是否過期
   * （now - firstFailureAt），不需自行推算或另外存底（CHK036）。
   */
  firstFailureAt?: string
  /** status 為 empty/analyzing（首次）/error（從未成功過）時可能為 null */
  summary: ConversationSummary | null
  /** ISO8601，本次區塊狀態變化的時間 */
  updatedAt: string
}

// ── 情緒時間軸 ────────────────────────────────────────────────────────

/** 每「一輪含文字的客戶發言」產生一點 */
export interface SentimentPoint {
  kind: 'point'
  messageId: string
  at: string
  /** 0–100，越低越負面 */
  score: number
  label: 'calm' | 'neutral' | 'concerned' | 'frustrated' | 'angry'
  /** ⚠️ 屬客戶對話個資，不得進日誌（憲法 1.5） */
  drivers: string[]
}

/** 純附件（無文字）客戶發言的中性標記（FR-002、FR-012），不參與 sparkline 折線與示警判定 */
export interface SentimentMarker {
  kind: 'attachment_only'
  messageId: string
  at: string
}

export type SentimentTimelineEntry = SentimentPoint | SentimentMarker

export interface SentimentBlock {
  status: AnalysisBlockStatus
  retryAttempt?: number
  /** 同 SummaryBlock.firstFailureAt，語意與用途相同（CHK036） */
  firstFailureAt?: string
  /** 全量時間軸（含分數點與純附件標記），依時間排序。前端自行取最近 50 點繪 sparkline（FR-015） */
  timeline: SentimentTimelineEntry[]
  /** 依全量 timeline 算出的統計值，不受「僅繪最近 50 點」影響（FR-015） */
  stats: { lowestScore: number | null, lowestAt: string | null }
  updatedAt: string
}

// ── 示警判定（衍生邏輯，非獨立實體）────────────────────────────────────

/** 單點是否落入示警等級 —— 僅供「這一點本身」的判斷，不是面板目前的示警狀態 */
export function isSentimentAlert(label: SentimentPoint['label']): boolean {
  return label === 'frustrated' || label === 'angry'
}

/**
 * 面板「目前」是否應顯示示警 —— 具遲滯（hysteresis）的解除規則（FR-003 2026-08-26 修訂）。
 *
 * ⚠️ 不能只看最新一點：客戶連續多則挫折/生氣發言中，若只因最後一則語氣稍微和緩
 * 就判定「已解除」，會在客戶其實仍在氣頭上時告訴客服「沒事了」—— 假訊號比沒有示警更糟。
 * 觸發沿用 isSentimentAlert()（單點達挫折/生氣即觸發）；解除則要求回升到「擔憂」以下
 * （calm／neutral），「擔憂」本身仍視為尚未脫離風險的中繼區間、持續示警。
 *
 * 純函式，僅讀 timeline（全量，不受最近 50 點顯示上限影響），不需要額外的持久化狀態 ——
 * 從最新一點往回找，先遇到 calm／neutral 即代表已解除，先遇到 frustrated／angry 則仍在示警中。
 */
export function isSentimentAlerting(timeline: SentimentTimelineEntry[]): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i]
    if (!entry || entry.kind !== 'point') continue // SentimentMarker 不參與判定（FR-012）
    if (entry.label === 'frustrated' || entry.label === 'angry') return true
    if (entry.label === 'calm' || entry.label === 'neutral') return false
    // label === 'concerned'：中繼區間，尚未解除，繼續往回找
  }
  return false
}

// ── AIProvider 介面（docs/ARCHITECTURE.md §8.2b）───────────────────────

/**
 * ⚠️ `suggest` 不在本功能範圍內（建議卡屬後續功能），介面上刻意省略——
 *    等該功能落地時再擴充，不要為了「介面完整」預先加上用不到的方法。
 */
export interface AIProvider {
  summarize(input: { history: Message[], previousSummary?: ConversationSummary }): Promise<ConversationSummary>
  analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]>
}
