/**
 * 情緒面板（摘要卡與情緒 Sparkline）的資料契約 —— specs/001-sentiment-panel/data-model.md。
 *
 * ⚠️ 本檔的型別供前後端共用，經 SSE `summary.updated`／`sentiment.updated` 事件傳遞
 *    （見 shared/types/events.ts）。AI 直接輸出的欄位（ConversationSummary 全部欄位、
 *    SentimentPoint.score/label/drivers）在進入這裡之前 MUST 已通過 Zod 驗證
 *    （憲法 4.2，見 server/services/ai/schemas.ts）。
 */

import type { Message } from './conversation.js'
import type { KnowledgeHit } from './knowledge.js'

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

// ── 建議卡（specs/002-suggestion-knowledge-search/data-model.md §1.1）───

export interface SuggestionCard {
  id: string
  /** 必須來自本次 knowledgeHits 集合，經白名單後驗；無引用時為 null（FR-004） */
  sopId: string | null
  /** 清理過的知識庫來源標題；sopId 為 null 時亦為 null（見 research.md #2） */
  sopTitle: string | null
  /** 可直接送出的回覆全文（繁中、客服語氣） */
  text: string
  /** 0–100；無真實依據時為 null，UI 留空不顯示，不得估算填充（憲法 4.4） */
  confidence: number | null
  /** 為何建議這句，供客服判斷，不隨「一鍵帶入」帶入 Composer */
  rationale: string
  tone: 'apologetic' | 'informative' | 'retention' | 'closing' | 'escalating'
  /** 需客服補上的實際資料，如「工單編號」；缺乏資料時 MUST NOT 推測填入（憲法 4.5） */
  requiresData: string[]
  /**
   * 這張卡是否已被同事或 AI 的後續回覆搶先說掉（FR-015、US4）。
   * `null` = 尚未評估過重複性（例如卡片剛產生）；有值時代表已完成一次重複性判定。
   */
  supersededBy: { kind: 'agent' | 'ai', messageId: string } | null
}

export interface SuggestionBlock {
  status: AnalysisBlockStatus
  retryAttempt?: number
  firstFailureAt?: string
  /**
   * 依生成順序排列。張數上限 3–5 張（ARCHITECTURE §14.6）於**生成階段**落實
   * （prompt 明示上限，FR-001），此欄位不做事後截斷——截掉的卡片已經付出過 AI 呼叫成本。
   */
  cards: SuggestionCard[]
  /**
   * 本次生成所依據的知識庫檢索「發生了什麼」（憲法 6.2 v3.0.1 要求的可稽核證據）。
   *
   * ⚠️ 這裡**必須是兩個欄位**，不能只留一個計數：
   *   - `ran: false`              → 根本沒查（憲法 6.2 禁止的情形，正常路徑不該出現）
   *   - `ran: true,  hitCount: 0` → 查了但 0 命中，或呼叫失敗後以空集合續行（FR-004 允許的誠實降級）
   *   - `ran: true,  hitCount: n` → 有命中；模型仍可能判斷全部無關而不引用
   */
  knowledgeSearch: { ran: boolean, hitCount: number }
  updatedAt: string
}

// ── AIProvider 介面（docs/ARCHITECTURE.md §8.2b）───────────────────────

export interface AIProvider {
  summarize(input: { history: Message[], previousSummary?: ConversationSummary }): Promise<ConversationSummary>
  analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]>
  /** knowledgeHits 由呼叫端先查好傳入，agent 只能從其中選 sopId（§11.6①的流程） */
  suggest(input: {
    history: Message[]
    knowledgeHits: KnowledgeHit[]
    /** Hybrid 模式下 AI 也在自動回覆（FR-016），prompt 需知悉並以補位性質為優先 */
    aiReplies: boolean
  }): Promise<SuggestionCard[]>
}
