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

/**
 * 主題標籤的長度與數量上限（畫布 2a「對話摘要」的 pill 列）。
 *
 * ⚠️ `topics` 是**模型自由生成的字串**，不像 `riskFlags` 有列舉可擋。沒有上限的話
 *    模型回一句 30 字的話當標籤、或一次回十幾個，pill 列會擠爆整張卡 ——
 *    而那不會有任何型別錯誤。與 `riskFlags` 丟棄列舉外值同一個精神：
 *    **在防腐層擋掉，不讓它有機會影響版面**。
 */
export const SUMMARY_TOPIC_MAX_COUNT = 4
export const SUMMARY_TOPIC_MAX_LENGTH = 16

/** 沿用 docs/ARCHITECTURE.md §11.5 已定案的形狀，原樣落地 */
export interface ConversationSummary {
  /**
   * 摘要正文 —— 畫布 2a「對話摘要」的主體，一段可一口氣讀完的敘述。
   *
   * ⚠️ **選填，而且必須一直是選填。** 這個欄位由 iMBrace 後台的
   *    `AgentCopilot_摘要_agent` 產生，而那份 system prompt **不在這個 repo 裡** ——
   *    後台還沒更新、或日後被改回舊版時，這個欄位就會是 `undefined`。
   *    標成必填會讓整份摘要驗不過而整塊轉 error，等於一個 repo 外的設定就能把功能打掉。
   *    UI 在缺值時退回以 `intent` 當正文（見 `SummaryCard.vue`）。
   */
  narrative?: string
  /**
   * 主題標籤（畫布逐字示例：「發票未收到」「地址確認」）。
   *
   * ⚠️ 選填，理由同 `narrative`。⚠️ 與 `riskFlags` **不同維度**：這裡是「在談什麼」，
   *    那裡是「有什麼風險」，畫布把兩者畫成同一列但用不同色系的 pill。
   */
  topics?: string[]
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

/**
 * 情緒走勢的文字摘要（畫布 2a：「近 3 輪情緒持續上升；第 4 輪因客服說明後略有回落。
 * 建議先安撫語氣、再給明確時間點。」）。
 *
 * ⚠️ **兩個欄位是刻意分開的，不是一個字串。** 只有走勢描述那半的話它是一句廢話 ——
 *    「分數上升」旁邊就是折線圖。這個區塊之所以值得多一次 AI 呼叫，全在 `advice`：
 *    折線圖說不出「該怎麼辦」。拆成兩個欄位讓 schema 能強制模型兩者都給，
 *    只給前半的輸出會直接驗不過而不是安靜地降級成廢話。
 */
export interface SentimentNarrative {
  /** 走勢描述 —— 只講觀察到的變化，不含建議 */
  trend: string
  /** 行動建議 —— 客服下一句話該怎麼說 */
  advice: string
}

export interface SentimentBlock {
  status: AnalysisBlockStatus
  retryAttempt?: number
  /** 同 SummaryBlock.firstFailureAt，語意與用途相同（CHK036） */
  firstFailureAt?: string
  /** 全量時間軸（含分數點與純附件標記），依時間排序。前端自行取最近 50 點繪 sparkline（FR-015） */
  timeline: SentimentTimelineEntry[]
  /** 依全量 timeline 算出的統計值，不受「僅繪最近 50 點」影響（FR-015） */
  stats: { lowestScore: number | null, lowestAt: string | null }
  /**
   * 走勢文字摘要（畫布 2a）。`null` ＝ 尚未產出、產出失敗，或只有一個評分點（無走勢可談）。
   *
   * ⚠️ **這是次要內容：產不出來時 block 仍是 `ready`，MUST NOT 因此把整塊打成 `error`。**
   *    分數與示警才是這個區塊的主體，為了一段敘述把折線圖一起打掉是本末倒置。
   *
   * ⚠️ **新的評分點落地時 MUST 先歸零。** 敘述描述的是「當時那條時間軸」，
   *    多了幾點之後「近 3 輪持續上升」可能已經不成立 —— 留著舊敘述是在畫面上放一句
   *    可能已經錯了的斷言，而空白只是暫時沒有資訊。⚠️ 這是**必填**而非 optional：
   *    每一個建構 `SentimentBlock` 的地方都必須自己決定，不能靠預設值兜
   *    （`BlockShell.defaultOpen` 那次就是預設值安靜地做錯事）。
   */
  narrative: SentimentNarrative | null
  updatedAt: string
}

// ── 分數帶（`score` ↔ `label` 的對應區間）──────────────────────────────

/**
 * 情緒分數帶 —— **由高分到低分排列**，`min` 是該級的下界（含），上界是下一級的 `min`（不含）。
 *
 * ⚠️ **這不是前端自己訂的顯示規則，是情緒 agent 的 system prompt 裡就有的絕對標準。**
 *    那份 prompt 不在這個 repo 裡（`ARCHITECTURE.md` §11「agent 的 system prompt 也不在
 *    版本控制裡」），所以這裡是它在程式碼這一側的**唯一副本** —— 兩邊若要改必須一起改，
 *    否則折線的顏色會與 `label`（進而與量表上的強調、示警判定）安靜地錯開。
 *    實測一致性：`scripts/spike/out/24-findings.json` 的 24-D，18/18 個評分點的 `score`
 *    都落在其 `label` 的區間內。
 *
 * ⚠️ **排列順序有意義**：`SentimentGauge.vue` 依這個順序產生折線漸層的硬停點，
 *    倒過來排會讓整張圖的顏色上下顛倒，而且不會有任何型別錯誤。
 */
export const SENTIMENT_BANDS = [
  { label: 'calm', min: 80 },
  { label: 'neutral', min: 60 },
  { label: 'concerned', min: 40 },
  { label: 'frustrated', min: 20 },
  { label: 'angry', min: 0 },
] as const satisfies ReadonlyArray<{ label: SentimentPoint['label'], min: number }>

/**
 * 分數落在哪一個分數帶 —— 供「模型給的 `label` 與 `score` 是否自洽」這類檢查用。
 *
 * ⚠️ **UI 不該拿它去覆蓋模型給的 `label`。** 示警（`isSentimentAlerting()`）與量表上的
 *    強調都吃 `label`，折線的顏色吃 `score`；兩者由 prompt 的絕對標準保證一致，
 *    在這裡再算一次「正確的 label」只會多一個會與模型打架的來源。
 */
export function sentimentBandOf(score: number): SentimentPoint['label'] {
  for (const band of SENTIMENT_BANDS) {
    if (score >= band.min) return band.label
  }
  return 'angry' // score < 0（Zod 已擋掉，僅為窮盡回傳）
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

  /**
   * 知識庫引用狀態（specs/004-progressive-citations FR-002／FR-003）。與 `status` **正交**：
   *   - `'pending'` → 第一段已顯示，第二段仍在等檢索（最多 30 秒）＋生成（最多 20 秒）
   *   - `'cited'`   → 這批卡是**餵入命中結果**生成的（前景第二段，或背景／命中已在手的單段）。
   *                   個別卡片仍可能 `sopId` 為 null（模型判斷該卡不需引用），以卡片的
   *                   `sopTitle` 分辨，MUST NOT 以本欄位推斷單張卡有沒有來源
   *   - `'none'`    → 最終狀態：檢索無命中、失敗、逾時，或第二段失敗／全數遭白名單捨棄。
   *                   `cards` 維持第一段內容（FR-003）
   *
   * 初始（`empty`／首次 `analyzing`）為 `'none'` —— 尚無卡片時這個欄位沒有語意，取不會誤導的值。
   * ⚠️ `'none' → 'pending'` 是**禁止**的方向（FR-003a ①）：第二段落定「未引用」前必須等第一段
   *    落定，否則第一段隨後落地會把標示寫回 `'pending'`，而該輪已無路徑再落定它。
   */
  citation: 'pending' | 'cited' | 'none'

  /**
   * 這批卡依據到哪一則客戶訊息（`batchAnchor()`，與 `ConversationSummary.basedOnMessageId` 同語意）。
   *
   * ⚠️ **僅供稽核與 UI**；第二段的過期判定用執行期的世代計數（004 research.md #2），
   *    **MUST NOT** 拿這個欄位做控制 —— 手動重試會用同一個錨點再跑一次，
   *    錨點比對會放行舊尾巴覆蓋新結果，而且不會報錯。
   */
  basedOnMessageId: string | null

  /**
   * 004 FR-014／SC-005 的稽核證據：這批卡由哪一段產出、第一段自動重試了幾次。
   *   - 前景第一段落地：`{ stage: 1, stage1RetryAttempt: n }`
   *   - 前景第二段落地：`{ stage: 2, stage1RetryAttempt: n }`（沿用第一段的 n，讓
   *     「這批訊息總共呼叫幾次」＝ 1 + n + 1 可以從單一 block 讀出）
   *   - 背景／命中已在手的單段：`{ stage: 2, stage1RetryAttempt: 0 }`（沒有第一段）
   * 上限可驗證：前景每批最壞 1 + 2 + 1 = 4 次（004 FR-014）。
   */
  provenance: { stage: 1 | 2, stage1RetryAttempt: number }
}

// ── AIProvider 介面（docs/ARCHITECTURE.md §8.2b）───────────────────────

export interface AIProvider {
  summarize(input: { history: Message[], previousSummary?: ConversationSummary }): Promise<ConversationSummary>
  analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]>
  /**
   * 情緒走勢的文字摘要（畫布 2a）。
   *
   * ⚠️ **輸入是評分結果，不是訊息原文。** 走勢與建議可以從 score／label／drivers 推出來，
   *    重送一次全部訊息只是把同一批個資再送一趟、prompt 也長好幾倍（憲法 1.5 的精神）。
   * ⚠️ 呼叫端 MUST 容忍本方法失敗 —— 見 `SentimentBlock.narrative` 的說明。
   */
  narrateSentiment(input: {
    points: Array<Pick<SentimentPoint, 'score' | 'label' | 'drivers'>>
  }): Promise<SentimentNarrative>
  /** knowledgeHits 由呼叫端先查好傳入，agent 只能從其中選 sopId（§11.6①的流程） */
  suggest(input: {
    history: Message[]
    knowledgeHits: KnowledgeHit[]
    /** Hybrid 模式下 AI 也在自動回覆（FR-016），prompt 需知悉並以補位性質為優先 */
    aiReplies: boolean
  }): Promise<SuggestionCard[]>
}
