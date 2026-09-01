/**
 * AI 輸出的 Zod 驗證（憲法 4.2）—— specs/001-sentiment-panel/data-model.md「驗證規則」。
 *
 * ⚠️ `riskFlags` 僅接受列舉內的值，模型輸出列舉外字串時該筆 flag 直接丟棄
 *    （不得讓整份摘要因單一欄位格式錯誤而全部失敗）—— 因此用 `.transform()` 過濾而非
 *    讓整個物件驗證失敗，與 `intent`／`advice` 空字串視同失敗（轉 error）的處理方式不同。
 */

import { z } from 'zod'
import type { ConversationSummary, SentimentNarrative, SentimentPoint, SuggestionCard } from '../../../shared/types/copilot.js'
import { SUMMARY_TOPIC_MAX_COUNT, SUMMARY_TOPIC_MAX_LENGTH } from '../../../shared/types/copilot.js'
import { AIOutputValidationError } from './retry-policy.js'

const RISK_FLAGS = ['churn', 'escalation', 'compliance', 'vip', 'repeat_contact'] as const
const SENTIMENT_LABELS = ['calm', 'neutral', 'concerned', 'frustrated', 'angry'] as const
const SUGGESTION_TONES = ['apologetic', 'informative', 'retention', 'closing', 'escalating'] as const

/**
 * 主題標籤的正規化 —— 去頭尾空白、丟空字串、去重、截斷過長者、限制張數。
 *
 * ⚠️ 全部在這裡做完，UI 拿到的一定是可以直接畫的東西。放到 UI 去截會有兩個問題：
 *    ① 每個顯示的地方都要記得截一次；② 存進 state 的仍是沒截過的值，
 *    日後任何新的顯示點都會再破一次版。
 * ⚠️ **超長者截斷而非丟棄**：一個講太長的標籤仍然帶著資訊，丟掉是損失；
 *    這與 `riskFlags` 不同 —— 那裡列舉外的值是**錯的值**，留著會顯示不存在的風險。
 */
function normalizeTopics(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const t = item.trim().slice(0, SUMMARY_TOPIC_MAX_LENGTH)
    if (t && !out.includes(t)) out.push(t)
    if (out.length === SUMMARY_TOPIC_MAX_COUNT) break
  }
  return out.length > 0 ? out : undefined
}

export const ConversationSummarySchema = z.object({
  /*
    ⚠️ `narrative`／`topics` **必須維持選填，而且不得因為值長得不對就讓整份摘要失敗**。
       兩者由 iMBrace 後台的 `AgentCopilot_摘要_agent` 產生，那份 system prompt
       **不在這個 repo 裡** —— 後台還沒更新、被改回舊版、或某一次回了空字串／不是陣列的
       `topics`，都不該把整塊摘要打成 error。一個 repo 外的設定不該有本事把功能打掉。

       因此這兩個欄位一律走 `z.unknown().transform()`：**驗不過的值轉成 `undefined`，
       不拋錯**。這與 `intent`／`advice` 用 `.min(1)`（空字串視同分析失敗）刻意不同 ——
       那兩個是摘要的主體，沒有它們這份摘要本來就沒有意義。
       缺值時 UI 退回以 `intent` 當正文（見 `SummaryCard.vue`）。
  */
  narrative: z.unknown().transform(v => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  topics: z.unknown().transform(normalizeTopics),
  intent: z.string().min(1),
  keyFacts: z.array(z.string()),
  attempted: z.array(z.string()),
  openIssues: z.array(z.string()),
  // 列舉外的字串直接丟棄，不使整份摘要失敗（data-model.md 驗證規則）
  riskFlags: z.array(z.string()).transform(
    values => values.filter((v): v is ConversationSummary['riskFlags'][number] =>
      (RISK_FLAGS as readonly string[]).includes(v)),
  ),
  advice: z.string().min(1),
  updatedAt: z.string(),
  basedOnMessageId: z.string(),
})

export const SentimentPointSchema = z.object({
  messageId: z.string(),
  at: z.string(),
  score: z.number().min(0).max(100),
  label: z.enum(SENTIMENT_LABELS),
  drivers: z.array(z.string()),
})

/**
 * 走勢文字摘要（畫布 2a）。
 *
 * ⚠️ **`advice` 用 `.min(1)` 強制存在**：只給 `trend` 的輸出直接驗不過。
 *    折線圖已經表達了走勢，這一段的價值全在建議 —— 讓「只給前半」安靜地通過，
 *    等於花了一次 AI 呼叫換來一句廢話（見 `SentimentNarrative` 的說明）。
 */
export const SentimentNarrativeSchema = z.object({
  trend: z.string().min(1),
  advice: z.string().min(1),
})

/** @throws {AIOutputValidationError} 未通過驗證時 */
export function parseSentimentNarrative(raw: unknown): SentimentNarrative {
  const result = SentimentNarrativeSchema.safeParse(raw)
  if (!result.success) {
    throw new AIOutputValidationError(`情緒走勢摘要未通過 schema 驗證：${result.error.issues.length} 項問題`)
  }
  return result.data
}

/**
 * @throws {AIOutputValidationError} 未通過驗證時 —— 由 withRetry() 的 classifyFailure()
 *         歸類為 permanent，不自動重試（FR-014）。
 */
export function parseConversationSummary(raw: unknown): ConversationSummary {
  const result = ConversationSummarySchema.safeParse(raw)
  if (!result.success) {
    throw new AIOutputValidationError(`摘要輸出未通過 schema 驗證：${result.error.issues.length} 項問題`)
  }
  return result.data
}

/** @throws {AIOutputValidationError} 未通過驗證時 */
export function parseSentimentPoints(raw: unknown[]): SentimentPoint[] {
  return raw.map((item) => {
    const result = SentimentPointSchema.safeParse(item)
    if (!result.success) {
      throw new AIOutputValidationError(`情緒評分點未通過 schema 驗證：${result.error.issues.length} 項問題`)
    }
    return { kind: 'point', ...result.data }
  })
}

/**
 * 建議卡 —— specs/002-suggestion-knowledge-search/data-model.md「驗證規則」。
 *
 * ⚠️ 這裡只管「格式對不對」。`sopId` 是否真的存在於本次 `knowledgeHits` 集合裡是
 *    另一層業務白名單檢查（憲法 4.3），刻意不放進這個 schema——
 *    `knowledgeHits` 是呼叫當下的動態上下文，硬塞進 schema 會讓 schema 定義依賴呼叫時的參數
 *    （見 server/services/copilot-analysis.ts::whitelistFilter()，research.md #6）。
 *
 * ⚠️ `tone` 是必要展示欄位（不像 `riskFlags` 可安全省略），列舉外一律視為該卡驗證失敗。
 */
export const SuggestionCardSchema = z.object({
  id: z.string().min(1),
  sopId: z.string().nullable(),
  sopTitle: z.string().nullable(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(100).nullable(),
  rationale: z.string(),
  tone: z.enum(SUGGESTION_TONES),
  requiresData: z.array(z.string()),
  supersededBy: z.object({
    kind: z.enum(['agent', 'ai']),
    messageId: z.string(),
  }).nullable(),
})

/**
 * 單張卡片驗證失敗即跳過，不使整批失敗（比照既有 `riskFlags` 的容錯精神）。
 *
 * @throws {AIOutputValidationError} 整批皆非陣列時
 */
export function parseSuggestionCards(raw: unknown): SuggestionCard[] {
  if (!Array.isArray(raw)) {
    throw new AIOutputValidationError('建議卡輸出不是陣列')
  }
  const cards: SuggestionCard[] = []
  for (const item of raw) {
    const result = SuggestionCardSchema.safeParse(item)
    if (result.success) cards.push(result.data)
  }
  return cards
}
