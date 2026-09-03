/**
 * `extractLeadingJson()` —— 平台沒有原生結構化輸出，所有 AI 產物都要從一段
 * 自由文字裡把 JSON 挖出來，這個函式是整條 AI 路徑的單一咽喉點
 * （`summarize`／`analyzeSentiment`／`narrateSentiment`／`suggest` 全部經過它）。
 *
 * ⚠️ **這個檔案存在的理由：它守的是「模型輸出樣式漂移」這個 repo 外的變數。**
 *    ARCHITECTURE §11.5 的容錯策略是拿 2026-08-27 的實測樣式訂的，而模型換版、
 *    後台 system prompt 被改，都會產生新的髒樣式 —— 那不會有型別錯誤，只會讓
 *    分析安靜地轉 error。在此之前這個函式**零測試覆蓋**，唯一的驗證是需要打
 *    正式環境的 spike（15／16），無法在 `npm test` 裡把關。
 *
 * 因此下列每個樣式都是**實測看過的真實輸出形態**，不是想像出來的邊界：
 * 開場白見 `scripts/spike/out/18-agent-latency-summary-*.json`（`Okay, I will...`），
 * 自我總結見 `ImbraceAgentProvider` 檔頭的 2026-08-27 實測註記。
 */

import { describe, expect, it } from 'vitest'
import { extractLeadingJson } from '../server/services/ai/imbrace-agent-provider.js'
import { AIOutputValidationError } from '../server/services/ai/retry-policy.js'

const OBJECT_BODY = '{"intent":"反映網路斷線問題","riskFlags":["repeat_contact"]}'
const ARRAY_BODY = '[{"score":-0.6,"label":"frustrated"},{"score":-0.4,"label":"frustrated"}]'

describe('乾淨輸出：沒有雜訊時原樣解析', () => {
  it('物件（summarize／narrateSentiment 的形狀）', () => {
    expect(extractLeadingJson(OBJECT_BODY)).toEqual({
      intent: '反映網路斷線問題',
      riskFlags: ['repeat_contact'],
    })
  })

  it('陣列（analyzeSentiment／suggest 的形狀）', () => {
    const parsed = extractLeadingJson(ARRAY_BODY) as unknown[]
    expect(parsed).toHaveLength(2)
  })

  it('前後空白與換行不影響', () => {
    expect(extractLeadingJson(`\n\n  ${OBJECT_BODY}  \n`)).toMatchObject({ intent: '反映網路斷線問題' })
  })
})

describe('開場白：JSON 前面多一段話（實測穩定出現，prompt 禁不掉）', () => {
  it('英文開場白 —— 18-agent-model-latency 實測到的形態', () => {
    const text = `Okay, I will summarize the conversation as requested.\n\n${OBJECT_BODY}`
    expect(extractLeadingJson(text)).toMatchObject({ intent: '反映網路斷線問題' })
  })

  it('中文開場白', () => {
    expect(extractLeadingJson(`好的，以下是本次對話的摘要：\n${OBJECT_BODY}`))
      .toMatchObject({ intent: '反映網路斷線問題' })
  })

  it('陣列輸出同樣要能切掉開場白', () => {
    const parsed = extractLeadingJson(`以下是每則訊息的情緒評分：\n${ARRAY_BODY}`) as unknown[]
    expect(parsed).toHaveLength(2)
  })
})

describe('自我總結：JSON 後面多一段話', () => {
  it('中文自我總結 —— 2026-08-27 實測「幾乎每次都會出現」', () => {
    expect(extractLeadingJson(`${OBJECT_BODY}\n\n我已完成摘要，請確認是否需要調整。`))
      .toMatchObject({ intent: '反映網路斷線問題' })
  })

  it('陣列後面的自我總結', () => {
    const parsed = extractLeadingJson(`${ARRAY_BODY}\n以上為兩則訊息的評分結果。`) as unknown[]
    expect(parsed).toHaveLength(2)
  })

  it('後綴自己就含合法 JSON 片段時，只取最前面那一份', () => {
    const text = `${OBJECT_BODY}\n補充：另一種寫法是 {"intent":"其他"}`
    expect(extractLeadingJson(text)).toMatchObject({ intent: '反映網路斷線問題' })
  })
})

describe('開場白與自我總結同時出現（最常見的真實形態）', () => {
  it('前後都要切掉', () => {
    const text = `Okay, I will summarize.\n\n${OBJECT_BODY}\n\n我已完成摘要。`
    expect(extractLeadingJson(text)).toMatchObject({ intent: '反映網路斷線問題' })
  })
})

describe('Markdown code fence', () => {
  it('```json 圍起來的輸出', () => {
    expect(extractLeadingJson('```json\n' + OBJECT_BODY + '\n```'))
      .toMatchObject({ intent: '反映網路斷線問題' })
  })

  it('無語言標記的 ``` fence', () => {
    expect(extractLeadingJson('```\n' + ARRAY_BODY + '\n```')).toHaveLength(2)
  })

  it('fence ＋ 開場白 ＋ 自我總結三者並存', () => {
    const text = `好的，以下是摘要：\n\n\`\`\`json\n${OBJECT_BODY}\n\`\`\`\n\n以上，請確認。`
    expect(extractLeadingJson(text)).toMatchObject({ intent: '反映網路斷線問題' })
  })
})

describe('真的解不開時必須拋 AIOutputValidationError（而不是回傳半成品）', () => {
  /*
    ⚠️ 錯誤型別本身是介面：retry-policy 的 classifyFailure() 靠它把「輸出格式不對」
       歸成可重試，與 permanent 的平台錯誤分流。改成別的 Error 會靜默改變重試行為。
  */
  it('整段都是純文字，沒有任何 JSON', () => {
    expect(() => extractLeadingJson('抱歉，我無法處理這個請求。'))
      .toThrow(AIOutputValidationError)
  })

  it('空字串', () => {
    expect(() => extractLeadingJson('')).toThrow(AIOutputValidationError)
  })

  it('JSON 被截斷（模型輸出中途停住）', () => {
    expect(() => extractLeadingJson('{"intent":"反映網路斷線問題","riskFlags":['))
      .toThrow(AIOutputValidationError)
  })

  it('鍵沒有引號的類 JSON（模型偶爾會輸出 JS 物件字面值）', () => {
    expect(() => extractLeadingJson('{intent: "反映網路斷線問題"}'))
      .toThrow(AIOutputValidationError)
  })
})

describe('已知限制：開場白裡若含 `{` 或 `[`，切點會落錯', () => {
  /*
    ⚠️ 這個 it 釘住的是**現況行為，不是期望行為**。切點取「文字中第一個 `{`／`[`」，
       因此開場白若自己提到括號（例如複述輸出格式），JSON 本體就會連同開場白殘骸
       一起解析失敗。目前沒有實測看過這個形態，故不改演算法（改成「配對掃描」會
       讓一個已驗證穩定的函式承擔新風險）。若日後真的遇到，這裡就是起點。
  */
  it('開場白含 `{` 時解析失敗', () => {
    const text = `我會輸出 {intent, advice} 這些欄位：\n${OBJECT_BODY}`
    expect(() => extractLeadingJson(text)).toThrow(AIOutputValidationError)
  })
})
