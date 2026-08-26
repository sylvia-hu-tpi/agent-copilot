/**
 * AI 輸出的 Zod 驗證（憲法 4.2）—— specs/001-sentiment-panel/data-model.md「驗證規則」。
 *
 * ⚠️ `riskFlags` 僅接受列舉內的值，模型輸出列舉外字串時該筆 flag 直接丟棄
 *    （不得讓整份摘要因單一欄位格式錯誤而全部失敗）—— 因此用 `.transform()` 過濾而非
 *    讓整個物件驗證失敗，與 `intent`／`advice` 空字串視同失敗（轉 error）的處理方式不同。
 */

import { z } from 'zod'
import type { ConversationSummary, SentimentPoint } from '../../../shared/types/copilot.js'
import { AIOutputValidationError } from './retry-policy.js'

const RISK_FLAGS = ['churn', 'escalation', 'compliance', 'vip', 'repeat_contact'] as const
const SENTIMENT_LABELS = ['calm', 'neutral', 'concerned', 'frustrated', 'angry'] as const

export const ConversationSummarySchema = z.object({
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
