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
  SentimentNarrative,
  SentimentPoint,
  SuggestionCard,
} from '../../../shared/types/copilot.js'
import type { KnowledgeHit } from '../../../shared/types/knowledge.js'
import { AIOutputValidationError, AIProviderHttpError } from './retry-policy.js'

/**
 * 三個 agent 的共用語言指令 —— **每一個會產出自由文字的 prompt 都要帶上**。
 *
 * ⚠️ **這是必要但不充分的一半。** 2026-08-31 使用者在真實環境回報：情緒區塊的走勢摘要
 *    會不定量出現簡體字。原先的 prompt 已經寫了「繁體中文」，模型還是會漂 ——
 *    真正可靠的槓桿是 **iMBrace 後台那三個 agent 的 system prompt**（離模型更近、每次呼叫都生效）。
 *    這裡加強只是把我方掌握得到的那一半做滿。
 *
 * ⚠️ **MUST NOT 在程式碼裡做簡轉繁。** 簡繁不是一對一：「后／後」「干／乾／幹」「发／發／髮」
 *    「里／裡」「只／隻」「面／麵」都要看語境。字元表換出來的是**看起來對、實際是別的字**，
 *    而那正是本專案一再防的失敗模式（安靜地做錯事）。少數簡體字是瑕疵，換錯字是錯誤。
 */
const LANGUAGE_RULE
  = '【語言】全部輸出必須使用**台灣繁體中文（zh-TW）**的字形與用語，'
    + '禁止出現任何簡體字。若不確定某個字的繁體寫法，改用其他詞語表達。'

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
      + `新增訊息：\n${transcript}\n\n`
      + LANGUAGE_RULE
  }
  return `請摘要以下客服對話：\n\n${transcript}\n\n` + LANGUAGE_RULE
}

/**
 * 走勢文字摘要的 prompt。
 *
 * ⚠️ **只送評分結果，不送訊息原文**（見 `AIProvider.narrateSentiment` 的說明）。
 *    走勢與建議可以從 score／label／drivers 推出來，重送一次全部訊息只是把同一批
 *    個資再送一趟，prompt 也長好幾倍。
 * ⚠️ prompt 明寫「trend 不要寫建議、advice 一定要寫」——`SentimentNarrativeSchema`
 *    雖然會擋下缺 advice 的輸出，但擋下來的代價是整次呼叫作廢，先在 prompt 講清楚比較便宜。
 */
function buildSentimentNarrativePrompt(
  points: Array<Pick<SentimentPoint, 'score' | 'label' | 'drivers'>>,
): string {
  const lines = points
    .map((p, i) => `第 ${i + 1} 輪：score ${p.score}／${p.label}${p.drivers.length ? `／${p.drivers.join('、')}` : ''}`)
    .join('\n')
  return '以下是同一位客戶最近幾輪發言的情緒評分（score 0–100，越低越負面）：\n\n'
    + `${lines}\n\n`
    + '請輸出 JSON 物件 `{"trend": "...", "advice": "..."}`，兩個欄位都必填、皆為繁體中文：\n'
    + '- `trend`：一到兩句，只描述觀察到的走勢變化（哪幾輪上升／下降、有沒有轉折），**不要寫建議**。\n'
    + '- `advice`：一句，告訴客服**下一則回覆該怎麼說**（語氣與該給的內容），以「建議」開頭。\n\n'
    + LANGUAGE_RULE
}

/**
 * ⚠️ **2026-09-01：這裡曾經有一個「【前情】」區塊**（把前一批尾端的評分帶進來，
 *    讓模型校準刻度），**已移除**。它是在後台 system prompt 只改了一半的中間狀態下加的：
 *    當時 prompt 剛要求「判斷要看同批前後文」卻還沒給絕對分數帶，模型於是拿同批其他訊息
 *    當相對基準，同一則訊息換個批次差到 25 分。補上分數帶與界線規則之後那個相對性消失，
 *    前情就量不到效益了（n=5：不帶 3.6 分、帶 3.9 分，差距在雜訊內）。
 *    詳見 `ARCHITECTURE.md` §8.2b。**不要因為「批次之間沒有上下文」這個直覺把它加回來** ——
 *    那個洞是由 prompt 的絕對標準補的，不是由這裡補的。
 */
function buildSentimentPrompt(messages: Message[]): string {
  const lines = messages.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
  return `請針對以下客戶發言，依序給出情緒判斷（陣列長度需與發言則數一致，共 ${messages.length} 則）：\n\n${lines}\n\n`
    + LANGUAGE_RULE
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
    + 'requiresData（字串陣列）。\n\n'
    + LANGUAGE_RULE
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
      /*
        ⚠️ `narrative`／`topics` 是 2026-09-01 為對齊畫布「對話摘要」新增的欄位，
           由後台 `AgentCopilot_摘要_agent` 的 system prompt 產生。
           後台尚未更新時它們是 `undefined`，schema 標為 `.optional()` 讓這種情況
           **正常通過**而非整份摘要失敗 —— 一個 repo 外的設定不該有本事把功能打掉。
      */
      narrative: parsed.narrative,
      topics: parsed.topics,
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

  async narrateSentiment(input: {
    points: Array<Pick<SentimentPoint, 'score' | 'label' | 'drivers'>>
  }): Promise<SentimentNarrative> {
    const text = await this.callAgent(this.sentimentAgentId, buildSentimentNarrativePrompt(input.points))
    // 格式驗證交給呼叫端的 parseSentimentNarrative()（憲法 4.2），這裡只負責取回原樣輸出
    return extractLeadingJson(text) as SentimentNarrative
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
   *
   * ⚠️ 這裡是**唯一**一個所有 agent 輸出都會經過的地方，簡體字偵測因此放在這裡 ——
   *    放在各自的 parse 裡會漏掉沒有結構化欄位的輸出，也會變成三份要同步的程式碼。
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

    warnIfSimplified(assistantId, text)
    return text
  }
}

/**
 * 只出現在簡體中文的常用字（取樣本，不求完整）。
 *
 * ⚠️ 這些字**在繁體中文裡不會出現**，因此不會誤判 —— 刻意不收「后」「干」「里」這類
 *    兩邊都存在、只是語意分工不同的字。寧可漏報，不可誤報：這個偵測的用途是
 *    「agent 的 system prompt 改了之後有沒有生效」，誤報會讓那個訊號失去意義。
 */
/**
 * 只出現在**簡體**中文的常用字（取樣，不求完整）。
 *
 * ⚠️ **寧可漏報，不可誤報。** 這個偵測的用途是回答「iMBrace 後台那三個 agent 的
 *    system prompt 改了之後還有沒有簡體字」—— 一旦會誤報，那個訊號就沒有意義了。
 *    因此刻意**排除兩邊都存在**的字：
 *      · `划`（繁體有「划船」「划算」）
 *      · `予`（繁體有「給予」「予以」）
 *      · `后`／`干`／`里`／`只`／`面`（繁簡分工不同，不是簡體專有）
 *    表中每一個字在正體中文裡都不存在對應寫法，因此命中即為簡體。
 *    ⚠️ 刻意收滿「訁」部（说／语／议／讲／谈／记／详／评／询／话…）—— 客服語彙大量落在這一部
 *    （語氣、建議、說明、詳細、評估、諮詢），而簡化後的「讠」在正體中文完全不存在，
 *    是精度與召回都最好的一組。也刻意**排除 `据`**：正體的「拮据」就是這個字。
 */
const SIMPLIFIED_ONLY = new RegExp('[' + '这为们说时过让还应该请问题实现认识开关车马鸟门东买卖学习进国图书报纸经济产业运动员场处备复杂难级绪续统计确转换给点线议语论讲谈记设详诉评询话谢课试调读训许证轮软较间闻简单双变华汉与万抚' + ']', 'g')

/**
 * ⚠️ **只警告，不修改輸出**（見 `LANGUAGE_RULE`：程式碼裡做簡轉繁會換出錯的字）。
 * ⚠️ **不記錄任何內容**（憲法 1.5）—— 只記 agent id 與命中處數，那足以回答
 *    「後台的 system prompt 改了之後還有沒有」，而那正是這一行存在的唯一目的。
 */
function warnIfSimplified(assistantId: string, text: string): void {
  const hits = text.match(SIMPLIFIED_ONLY)
  if (!hits) return
  console.warn(
    `[ai] agent ${assistantId} 的輸出含簡體字（命中 ${hits.length} 處）——`
    + ' prompt 已要求繁體，請確認該 agent 後台的 system prompt 是否也有相同指示',
  )
}
