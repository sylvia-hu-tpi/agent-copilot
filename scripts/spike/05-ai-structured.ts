/**
 * 05 — AI 能力（E-1 / E-2）🔴 P0
 *
 * 憲法第 4 條要求「AI 輸出必須經 Zod 驗證後才進入系統」，§11.7 更要求
 * 「全部使用 structured output / tool use，絕不解析自由文字」。
 *
 * 靜態分析已知（@imbrace/sdk@1.4.0）：
 *   CompletionInput = { model, messages, temperature, maxTokens, metadata, stream }
 *   ❌ 沒有 response_format、沒有 tools、沒有 tool_choice
 *   → SDK 層面不支援 structured output。但模型清單有 is_toolCall_available 旗標，
 *     代表底層模型支援 —— 值得測試額外欄位能否 passthrough 到後端。
 *
 *   MessageSuggestionResponse = { suggestions: string[] }
 *   ❌ 沒有信心度、沒有 SOP 引用 → demo 的「SOP 3.2 · 信心度 92%」做不到
 */

import { z } from 'zod'
import { runProbe, env, isMain, type Finding } from './lib/harness.js'

const TestSchema = z.object({
  intent: z.string(),
  sentiment: z.number().min(0).max(100),
  tags: z.array(z.string()),
})

const PROMPT = '客戶說：「我已經重開機三次了還是連不上，到底要我等多久？」'
  + '請只回傳 JSON，格式為 {"intent": string, "sentiment": number 0-100, "tags": string[]}，不要有其他文字。'

export const probe05 = () => runProbe('05', 'E-1/E-2 AI 能力', async (p, client) => {
  // ── ① 可用模型 ───────────────────────────────────────
  let model = env('SPIKE_AI_MODEL')
  let toolCapable = false
  try {
    const res = await client.ai.getLlmModels()
    const models = res?.data ?? []
    console.log(`     可用模型 ${models.length} 個：${models.slice(0, 5).map(m => m.name).join(', ')}`)
    p.fixture('models', models, true)
    const withTools = models.filter(m => m.is_toolCall_available)
    const withVision = models.filter(m => m.is_vision_available)
    toolCapable = withTools.length > 0
    model ||= (withTools[0]?.name ?? models[0]?.name ?? '')

    p.record({
      question: 'E-2a', claim: '平台提供哪些模型、是否支援 tool call 與 vision',
      verdict: models.length > 0 ? 'yes' : 'no',
      evidence: `${models.length} 個模型；支援 toolCall ${withTools.length} 個、vision ${withVision.length} 個`,
      impact: withVision.length > 0
        ? `✅ 有 vision 模型（${withVision[0]?.name}）—— H-2 若確認平台未做圖片描述，`
          + '可用平台內建 vision 自建，對話內容不出境（緩解風險 #9）。'
        : '❌ 無 vision 模型 → 圖片理解必須走外部服務，合規問題浮現。',
    })
  } catch (e) {
    p.record({
      question: 'E-2a', claim: '可用模型清單',
      verdict: 'unknown',
      evidence: `getLlmModels 失敗：${e instanceof Error ? e.message : String(e)}`,
    })
  }

  if (!model) { console.log('     ⏭ 無可用模型，略過後續'); return }

  // ── ② structured output：SDK 型別外的欄位能否 passthrough ──
  const attempts: Array<[string, Record<string, unknown>]> = [
    ['baseline（純 prompt 要求 JSON）', {}],
    ['response_format: json_object', { response_format: { type: 'json_object' } }],
    ['tools（function calling）', {
      tools: [{
        type: 'function',
        function: {
          name: 'report', description: '回報分析結果',
          parameters: {
            type: 'object',
            properties: {
              intent: { type: 'string' },
              sentiment: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['intent', 'sentiment', 'tags'],
          },
        },
      }],
      tool_choice: 'required',
    }],
  ]

  const outcomes: string[] = []
  for (const [label, extra] of attempts) {
    try {
      const res = await client.ai.complete({
        model,
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 0.2,
        ...extra,
      } as any)

      const content = res?.choices?.[0]?.message?.content ?? ''
      const toolCall = (res?.choices?.[0]?.message as any)?.tool_calls?.[0]
      const payload = toolCall?.function?.arguments ?? content

      let ok = false
      try { ok = TestSchema.safeParse(JSON.parse(payload)).success } catch { ok = false }

      outcomes.push(`${label}: ${ok ? '✅ Zod 通過' : '❌ 非合法 JSON'}${toolCall ? '（走 tool_calls）' : ''}`)
      console.log(`     ${ok ? '✅' : '❌'} ${label}`)
    } catch (e) {
      outcomes.push(`${label}: 💥 ${e instanceof Error ? e.message : String(e)}`)
      console.log(`     💥 ${label}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  p.fixture('structured-attempts', outcomes, true)

  const anyStructured = outcomes.some(o => o.includes('✅') && !o.startsWith('baseline'))
  const baselineOk = outcomes[0]?.includes('✅') ?? false

  p.record({
    question: 'E-2b', claim: 'ai.complete() 是否支援 structured output / tool use',
    verdict: anyStructured ? 'yes' : baselineOk ? 'partial' : 'no',
    evidence: outcomes.join(' ｜ '),
    impact: anyStructured
      ? '✅ 額外欄位可 passthrough，憲法第 4 條可照設計實作（SDK 型別需自行擴充）。'
      : baselineOk
        ? '🟡 只能靠 prompt 要求 JSON + Zod 驗證 + 失敗重試。'
          + '需在 AI pipeline 加上「重試 2 次仍失敗則降級」的機制（§15.2 已有對應降級策略）。'
          + '預估額外成本：每次分析多 ~5% 失敗率，M2 +1~2 人日處理。'
        : '❗ 平台 AI 無法產出穩定結構化輸出 → 建議改為直接呼叫外部 LLM（可用 structured output），'
          + '但須先解決風險 #9 的對話內容出境合規問題。這是架構層級的分岔，應儘早決定。',
  })

  // ── ③ messageSuggestion 的實際回傳 ────────────────────
  try {
    const sug = await client.messageSuggestion.getSuggestions({ message: PROMPT })
    const keys = Object.keys(sug ?? {})
    console.log(`     messageSuggestion 回傳欄位：${keys.join(', ')}，${sug?.suggestions?.length ?? 0} 則建議`)
    p.fixture('message-suggestion', sug)

    const hasConfidence = keys.some(k => /confidence|score/i.test(k))
    const hasSource = keys.some(k => /source|sop|reference|citation/i.test(k))

    p.record({
      question: 'E-1', claim: 'messageSuggestion 是否附帶信心度與 SOP 引用',
      verdict: hasConfidence && hasSource ? 'yes' : (hasConfidence || hasSource) ? 'partial' : 'no',
      evidence: `回傳欄位 [${keys.join(', ')}]；信心度=${hasConfidence ? '有' : '無'}、來源引用=${hasSource ? '有' : '無'}`,
      impact: hasConfidence || hasSource ? undefined
        : '❗ 只回傳 string[]。demo 畫面上的「SOP 3.2 · 信心度 92%」無法由平台內建能力產生 → '
          + '§2 決策摘要中「建議回覆先用 messageSuggestion」的規劃需修正：'
          + 'messageSuggestion 只能當作低品質 fallback，主線必須走「自建檢索 + 自訂 prompt」。'
          + '這會讓 M2 的建議卡從「接 API」變成「完整自建」，工作量顯著增加。',
    })
  } catch (e) {
    p.record({
      question: 'E-1', claim: 'messageSuggestion 可用性',
      verdict: 'unknown',
      evidence: `失敗：${e instanceof Error ? e.message : String(e)}`,
    })
  }
})

if (isMain(import.meta.url)) {
  probe05().then((f: Finding[]) => process.exit(0))
}
