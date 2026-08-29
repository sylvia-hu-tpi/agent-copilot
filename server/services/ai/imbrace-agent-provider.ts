/**
 * 真的呼叫 iMBrace AI Agent 的 AIProvider 實作 —— docs/ARCHITECTURE.md §8.2b。
 *
 * ⚠️ 平台沒有 `response_format` 這種原生結構化輸出（`ai.complete`/`ai.embed` 皆 404，
 *    見 docs/SDK_FINDINGS.md），只能靠 prompt 要求模型輸出 JSON，再由這裡解析。
 *
 * ⚠️ **實測發現**（2026-08-27，`scripts/spike/15-copilot-agents.ts`）：模型幾乎每次都會
 *    在合法 JSON 後面多加一句自我總結（例如「我已完成摘要...」），即使 prompt 明確禁止。
 *    這不是隨機亂跑、是穩定出現的行為，逼 prompt 100% 守規矩不可靠——因此這裡的解析策略
 *    是「取 JSON.parse 錯誤回報的失敗位置，只保留該位置之前的合法 JSON 本體，忽略後面的
 *    任何文字」，而不是繼續在 prompt 上加壓。實測對摘要／情緒兩個 agent 各 9/9、3/3 次成功。
 *
 * ⚠️ 平台端的錯誤（agent 設定不完整、模型未開通等）不是用 HTTP 狀態碼回報，而是藏在
 *    200 回應的 SSE 事件裡（`{"errorText": "..."}`，見 scripts/spike/10-agent-retest.ts
 *    的實測）。這裡偵測到就直接視為失敗，交由 retry-policy 的 classifyFailure() 預設
 *    歸類為 permanent（未列舉的失敗一律不自動重試，FR-014）。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import type { Message } from '../../../shared/types/conversation.js'
import type {
  AIProvider,
  ConversationSummary,
  SentimentPoint,
  SuggestionCard,
} from '../../../shared/types/copilot.js'
import type { KnowledgeHit } from '../../../shared/types/knowledge.js'
import { AIOutputValidationError, AIProviderHttpError } from './retry-policy.js'

const SENDER_LABEL: Record<string, string> = {
  customer: '客戶',
  agent: '客服',
  ai: 'AI',
}

function transcriptLine(m: Message): string {
  return `[${SENDER_LABEL[m.sender.type] ?? '未知'}] ${m.text}`
}

function buildSummaryPrompt(input: { history: Message[], previousSummary?: ConversationSummary }): string {
  const transcript = input.history.map(transcriptLine).join('\n')
  if (input.previousSummary) {
    // FR-004：增量情境只送既有摘要 + 新訊息，不重送完整歷史
    return `這是既有摘要與新增的客戶發言（增量更新情境，只需反映新增訊息帶來的變化）：\n\n`
      + `既有摘要：${JSON.stringify(input.previousSummary)}\n\n`
      + `新增訊息：\n${transcript}`
  }
  return `請摘要以下客服對話：\n\n${transcript}`
}

function buildSentimentPrompt(messages: Message[]): string {
  const lines = messages.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
  return `請針對以下客戶發言，依序給出情緒判斷（陣列長度需與發言則數一致，共 ${messages.length} 則）：\n\n${lines}`
}

/**
 * ⚠️ 訊息內容一律取 `Message.text`，MUST NOT 讀 `caption`——後者是上傳時的原始檔名，
 *    客戶上傳時為空（憲法 6.5／FR-017）。`transcriptLine()` 本來就只讀 `m.text`，此處沿用。
 *
 * ⚠️ **匯出是為了讓 `scripts/spike/18-agent-model-latency.ts` 量到與正式路徑「同一份」
 *    prompt**，不是給其他 route 使用。摘要／情緒兩個 prompt 在該腳本裡是手抄複本（短、
 *    結構穩定），但建議卡的 prompt 長度本身就是被量的變數（004 FR-001 的 10 秒預算），
 *    手抄一旦漂移，量出來的數字就不再代表正式路徑。
 */
export function buildSuggestionPrompt(input: {
  history: Message[]
  knowledgeHits: KnowledgeHit[]
  aiReplies: boolean
}): string {
  const transcript = input.history.map(transcriptLine).join('\n')
  const hitsText = input.knowledgeHits.length > 0
    ? input.knowledgeHits.map(h => `- id: ${h.id}\n  標題：${h.title}\n  內容：${h.snippet}`).join('\n')
    : '（本次知識庫檢索無相關結果）'

  return `你是客服助理，請針對以下對話產生建議回覆卡（輸出 JSON 陣列）。\n\n`
    + `對話內容：\n${transcript}\n\n`
    + `知識庫檢索結果：\n${hitsText}\n\n`
    + (input.aiReplies
      ? '⚠️ 此對話目前為 Hybrid 模式，AI 也會自動回覆客戶，你的建議應以補位、避免與 AI 重複為優先。\n\n'
      : '')
    + '規則（務必遵守）：\n'
    + '① 最多產出 5 張卡\n'
    + '② sopId 只能是上方知識庫檢索結果列出的 id，若無合適引用請填 null，不得自行編造\n'
    + '③ 無法確認的具體資料（工單編號、金額、時間等）請填入 requiresData 陣列交由客服補上，不得寫入 text\n\n'
    + '每張卡片需包含欄位：sopId（字串或 null）、sopTitle（字串或 null）、text（回覆全文）、'
    + 'confidence（一律填 null）、rationale（建議理由）、'
    + 'tone（apologetic／informative／retention／closing／escalating 之一）、'
    + 'requiresData（字串陣列）。'
}

/**
 * 模型偶爾會在 JSON **前面**加一句開場白（如「Okay, I will...」），也可能在**後面**
 * 加一句自我總結（如「我已完成摘要...」）——兩種都實測遇過，且都是即使 prompt 明確禁止
 * 也還是會出現的穩定行為，逼 prompt 100% 守規矩不可靠。因此策略是：先找到文字中第一個
 * `{` 或 `[`（JSON 本體必然由此開始），從那裡切掉前面的開場白；再用 `JSON.parse` 的錯誤
 * 訊息回報的失敗位置，切掉後面多餘的文字。兩段都可能不存在，皆為 no-op。
 *
 * ⚠️ **匯出是為了讓 `scripts/spike/18-agent-model-latency.ts` 用同一份抽取邏輯判「合規」。**
 *    2026-08-29 的實例：該腳本原本自己抄了一份簡化版（少了「切掉開場白」這一步），
 *    於是把摘要 agent 判成 **0/15 不合規**——而它的輸出其實完全正常，正式路徑一直都解得開。
 *    量測工具比正式路徑嚴格，會憑空製造出不存在的缺陷；比正式路徑寬鬆，則會漏掉真的缺陷。
 *    兩種都不可接受，唯一的解法是共用同一份程式碼。
 */
export function extractLeadingJson(text: string): unknown {
  const withoutFence = text.replace(/```json|```/g, '').trim()
  const start = withoutFence.search(/[[{]/)
  const cleaned = start > 0 ? withoutFence.slice(start) : withoutFence

  try {
    return JSON.parse(cleaned)
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const m = /position (\d+)/.exec(message)
    if (m?.[1]) {
      try {
        return JSON.parse(cleaned.slice(0, Number(m[1])))
      }
      catch {
        // 落到下面統一拋錯
      }
    }
    throw new AIOutputValidationError(`AI 輸出無法解析為 JSON：${message}`)
  }
}

export class ImbraceAgentProvider implements AIProvider {
  constructor(
    private readonly client: ImbraceClient,
    private readonly summaryAgentId: string,
    private readonly sentimentAgentId: string,
    private readonly suggestionAgentId: string,
  ) {}

  async summarize(input: {
    history: Message[]
    previousSummary?: ConversationSummary
  }): Promise<ConversationSummary> {
    const text = await this.callAgent(this.summaryAgentId, buildSummaryPrompt(input))
    const parsed = extractLeadingJson(text) as Record<string, unknown>
    const last = input.history[input.history.length - 1]

    return {
      intent: parsed.intent,
      keyFacts: parsed.keyFacts,
      attempted: parsed.attempted,
      openIssues: parsed.openIssues,
      riskFlags: parsed.riskFlags,
      advice: parsed.advice,
      updatedAt: new Date().toISOString(),
      basedOnMessageId: last?.id ?? input.previousSummary?.basedOnMessageId ?? '',
    } as ConversationSummary
  }

  async analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]> {
    if (input.messages.length === 0) return []

    const text = await this.callAgent(this.sentimentAgentId, buildSentimentPrompt(input.messages))
    const parsed = extractLeadingJson(text)

    if (!Array.isArray(parsed) || parsed.length !== input.messages.length) {
      throw new AIOutputValidationError(
        `情緒陣列長度不符：預期 ${input.messages.length}，實際 ${Array.isArray(parsed) ? parsed.length : '非陣列'}`,
      )
    }

    // messageId／at 是系統本來就知道的（見 shared/types/copilot.ts 的介面註解），
    // 不讓 agent 自己猜——依原始輸入順序把它們對回去，只信任模型給的 score/label/drivers。
    return input.messages.map((m, i) => {
      const item = parsed[i] as Record<string, unknown>
      return {
        kind: 'point' as const,
        messageId: m.id,
        at: m.at,
        score: item.score,
        label: item.label,
        drivers: item.drivers,
      } as SentimentPoint
    })
  }

  /**
   * ⚠️ `id` 由本層以 `crypto.randomUUID()` 產生，不信任模型輸出——模型沒有理由知道
   *    穩定唯一的 id，比照 `analyzeSentiment()` 不信任模型給的 `messageId`/`at` 同一原則。
   *    其餘欄位原樣帶出，交由呼叫端的 `parseSuggestionCards()`（憲法 4.2）與
   *    `whitelistFilter()`（憲法 4.3）驗證與後驗。
   */
  async suggest(input: {
    history: Message[]
    knowledgeHits: KnowledgeHit[]
    aiReplies: boolean
  }): Promise<SuggestionCard[]> {
    const text = await this.callAgent(this.suggestionAgentId, buildSuggestionPrompt(input))
    const parsed = extractLeadingJson(text)

    if (!Array.isArray(parsed)) {
      throw new AIOutputValidationError('建議卡輸出不是陣列')
    }

    return parsed.map((item) => {
      const raw = item as Record<string, unknown>
      return {
        id: crypto.randomUUID(),
        sopId: raw.sopId,
        sopTitle: raw.sopTitle,
        text: raw.text,
        confidence: raw.confidence,
        rationale: raw.rationale,
        tone: raw.tone,
        requiresData: raw.requiresData,
        supersededBy: null,
      } as SuggestionCard
    })
  }

  /**
   * @throws {AIProviderHttpError} 呼叫本身失敗且能判別 HTTP 狀態碼時
   * @throws {AIOutputValidationError} 200 回應但無文字輸出，或平台回報 errorText 時
   */
  private async callAgent(assistantId: string, prompt: string): Promise<string> {
    let res: { text: () => Promise<string> }
    try {
      res = await this.client.aiAgent.streamChat({
        assistant_id: assistantId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      } as Parameters<typeof this.client.aiAgent.streamChat>[0])
    }
    catch (err) {
      const status = (err as { status?: number, statusCode?: number })?.status
        ?? (err as { status?: number, statusCode?: number })?.statusCode
      if (typeof status === 'number') {
        throw new AIProviderHttpError(err instanceof Error ? err.message : String(err), status)
      }
      throw err
    }

    const raw = await res.text()
    const events = raw.split('\n')
      .filter(l => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
      .filter(Boolean) as Array<Record<string, unknown>>

    const errText = events.find(e => typeof e.errorText === 'string')?.errorText as string | undefined
    if (errText) {
      // 憲法 1.5：不得記錄訊息全文——這裡的 errText 是平台對「agent 設定」的錯誤描述，
      // 不含客戶對話內容，記錄是安全的，供除錯用。
      throw new AIOutputValidationError(`AI Agent 回報錯誤：${errText}`)
    }

    const text = events.filter(e => e.type === 'text-delta')
      .map(e => String(e.delta ?? '')).join('')

    if (!text.trim()) {
      throw new AIOutputValidationError('AI Agent 回應為空，無文字輸出')
    }
    return text
  }
}
