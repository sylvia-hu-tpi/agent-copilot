/**
 * 31 — `AgentCopilot_結案摘要_agent` 的結構可用性（**不是品質調校**）。
 *
 * ⚠️ 唯讀：只呼叫 AI Agent，不碰 Data Board、不寫任何對話資料。
 *
 * ── 這支要回答的唯一問題 ─────────────────────────────────────
 * `google.gemma-3-27b-it` 撐不撐得住結案摘要的輸出形狀：
 * 7 個欄位、其中 4 個是**只能從白名單挑**的受控詞彙、外加一個巢狀的 `followUps` 陣列。
 * 摘要 agent 現在的輸出比這個單純，所以「摘要 agent 能用」不蘊含「這個也能用」。
 *
 * ⚠️ **這支刻意不做模型比較與品質調校。** 現在調校得用手捏的假對話，
 *    等 `buildClosurePrompt()` 接上真正的涵蓋區間切分之後，調校結果就作廢了 ——
 *    而且會留下一組看起來有效、實際不可比的數字（`18-agent-model-latency.ts`
 *    的檔頭記錄過同一個陷阱）。模型比較等 US1 落地、有真實區間輸入時再做。
 *
 * ── 為什麼失敗要分三類，不能只數成功幾次 ──────────────────────
 * 沿用 16 號那一趟的教訓（見該檔註解）：把「SDK 逾時」與「JSON 解不開」記成同一種失敗，
 * findings 就會指向一個不存在的解析缺陷，而那是會讓人真的動手去改解析邏輯的假線索。
 * 這裡再多分一類 —— **格式對但受控詞彙挑錯**：那既不是傳輸問題也不是解析問題，
 * 是 prompt 或模型的問題，處置方式（換模型／加強 prompt）完全不同。
 *
 * 跑法：
 *   npm run spike:closure-agent
 */

import { runProbe, isMain, env, requireEnv, SkipProbe, type Finding } from './lib/harness.js'
import { clientForApiKey } from '../../server/services/imbrace.js'
import {
  buildClosurePrompt,
  extractLeadingJson,
} from '../../server/services/ai/imbrace-agent-provider.js'
import { AIOutputValidationError } from '../../server/services/ai/retry-policy.js'
import { CLOSURE_VOCABULARY } from '../../config/categories.js'
import type { Message } from '../../shared/types/conversation.js'

/**
 * 一段「已結束的服務」樣本 —— 刻意設計成四個受控詞彙欄位**都有明確正解**，
 * 這樣「挑錯」與「這段對話本來就模稜兩可」才分得開：
 *   category=發票補寄／resolution=resolved／actionsTaken 含「已建立工單」＋「已更新客戶資料」／
 *   sentimentOutcome=appeased（客戶由不滿轉為道謝）
 * ⚠️ 另含一個 followUps 的明確待辦（地址是否同步到帳單設定），用來驗規則 ③
 *    ——模型若補上對話裡沒有的「建議之後可以…」，就是憲法 4.5 的違反。
 */
const SAMPLE_HISTORY: Message[] = [
  { id: 'm1', conversationId: 'c1', at: '2026-09-02T01:00:00Z', sender: { type: 'customer' }, text: '我上週申請的電子發票到現在都還沒收到，這已經是第二次了' },
  { id: 'm2', conversationId: 'c1', at: '2026-09-02T01:01:00Z', sender: { type: 'ai' }, text: '您好，請提供發票期別，我為您查詢開立狀態。' },
  { id: 'm3', conversationId: 'c1', at: '2026-09-02T01:03:00Z', sender: { type: 'customer' }, text: '2026年7月的，我朋友同一天申請的早就收到了，你們是不是漏掉我' },
  { id: 'm4', conversationId: 'c1', at: '2026-09-02T01:06:00Z', sender: { type: 'agent' }, text: '您好，我是客服小林。查到您 7 月份的發票已於 08/19 開立，寄送地址是台北市信義區某某路 100 號，請問這是您目前的地址嗎？' },
  { id: 'm5', conversationId: 'c1', at: '2026-09-02T01:08:00Z', sender: { type: 'customer' }, text: '不是，我三月就搬家了，怎麼還是舊地址' },
  { id: 'm6', conversationId: 'c1', at: '2026-09-02T01:10:00Z', sender: { type: 'agent' }, text: '很抱歉造成您的困擾。請提供新地址，我立刻幫您更新資料並建立補寄工單。' },
  { id: 'm7', conversationId: 'c1', at: '2026-09-02T01:12:00Z', sender: { type: 'customer' }, text: '新北市板橋區某某街 5 號 3 樓' },
  { id: 'm8', conversationId: 'c1', at: '2026-09-02T01:15:00Z', sender: { type: 'agent' }, text: '已為您更新聯絡資料，補寄工單也建立好了，七個工作天內會寄達。另外帳單的寄送設定是分開的，我這邊看不到，會再請帳務同仁確認是否需要一併更新。' },
  { id: 'm9', conversationId: 'c1', at: '2026-09-02T01:16:00Z', sender: { type: 'customer' }, text: '好，那就麻煩你了，謝謝' },
]

const RUNS = 8

/** 只出現在簡體中文的常用字（取樣，與 provider 的偵測同一個目的） */
const SIMPLIFIED_RE = /[这么后单据发国将来门问题实际维护应该边间]/

interface RunResult {
  run: number
  ms: number
  outcome: 'ok' | 'vocabMiss' | 'formatFail' | 'transportFail'
  missingFields?: string[]
  vocabMisses?: string[]
  simplified?: boolean
  followUpCount?: number
  summaryLen?: number
  error?: string
}

const REQUIRED_FIELDS = [
  'summary', 'intent', 'category', 'resolution',
  'actionsTaken', 'sentimentOutcome', 'followUps',
] as const

export const probe31 = () => runProbe('31', '結案摘要 agent 的結構可用性', async (p) => {
  const agentId = env('IMBRACE_CLOSURE_AGENT_ID')
  if (!agentId) {
    throw new SkipProbe('缺少 IMBRACE_CLOSURE_AGENT_ID —— 需先在 iMBrace 後台建立 AgentCopilot_結案摘要_agent（見 .env.example）')
  }

  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: 'stable',
  })

  const prompt = buildClosurePrompt({
    history: SAMPLE_HISTORY,
    vocabulary: CLOSURE_VOCABULARY,
  })

  const results: RunResult[] = []

  for (let run = 1; run <= RUNS; run++) {
    const started = Date.now()
    let raw: string
    try {
      const res = await client.aiAgent.streamChat({
        assistant_id: agentId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      } as Parameters<typeof client.aiAgent.streamChat>[0])
      const body = await res.text()
      const events = body.split('\n')
        .filter(l => l.startsWith('data:'))
        .map((l) => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
        .filter(Boolean) as Array<Record<string, unknown>>

      const errText = events.find(e => typeof e.errorText === 'string')?.errorText as string | undefined
      if (errText) throw new AIOutputValidationError(`AI Agent 回報錯誤：${errText}`)

      raw = events.filter(e => e.type === 'text-delta').map(e => String(e.delta ?? '')).join('')
      if (!raw.trim()) throw new AIOutputValidationError('回應為空，無文字輸出')
    }
    catch (err) {
      const ms = Date.now() - started
      const isFormat = err instanceof AIOutputValidationError
      results.push({
        run, ms,
        outcome: isFormat ? 'formatFail' : 'transportFail',
        error: err instanceof Error ? err.message : String(err),
      })
      console.log(`     run ${run}: ${isFormat ? '格式' : '傳輸'}失敗（${ms}ms）`)
      continue
    }

    const ms = Date.now() - started

    // ── 解析 ────────────────────────────────────────────────
    let parsed: Record<string, unknown>
    try {
      parsed = extractLeadingJson(raw) as Record<string, unknown>
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new AIOutputValidationError('輸出不是 JSON 物件')
      }
    }
    catch (err) {
      results.push({ run, ms, outcome: 'formatFail', error: err instanceof Error ? err.message : String(err) })
      console.log(`     run ${run}: 格式失敗（${ms}ms）`)
      continue
    }

    const missingFields = REQUIRED_FIELDS.filter(f => parsed[f] === undefined)

    // ── 受控詞彙後驗（＝ server 端會做的那一份）────────────────
    //
    // ⚠️ 空字串／空陣列**不算挑錯** —— prompt 明講「挑不到就留白」，
    //    那是正確行為（憲法 4.5、FR-020a）。這裡只抓「給了一個不在白名單裡的值」。
    const vocabMisses: string[] = []
    const check = (field: string, value: unknown, list: readonly string[]): void => {
      if (value === '' || value === undefined || value === null) return
      if (!list.includes(String(value))) vocabMisses.push(`${field}="${String(value)}"`)
    }
    check('category', parsed.category, CLOSURE_VOCABULARY.categories)
    check('resolution', parsed.resolution, CLOSURE_VOCABULARY.resolutions)
    check('sentimentOutcome', parsed.sentimentOutcome, CLOSURE_VOCABULARY.sentimentOutcomes)
    if (Array.isArray(parsed.actionsTaken)) {
      for (const a of parsed.actionsTaken) {
        if (!CLOSURE_VOCABULARY.actionsTaken.includes(String(a) as never)) {
          vocabMisses.push(`actionsTaken[]="${String(a)}"`)
        }
      }
    }
    else if (parsed.actionsTaken !== undefined) {
      vocabMisses.push('actionsTaken 不是陣列')
    }

    const followUps = Array.isArray(parsed.followUps) ? parsed.followUps : []
    const simplified = SIMPLIFIED_RE.test(raw)

    const outcome: RunResult['outcome']
      = missingFields.length > 0 ? 'formatFail'
        : vocabMisses.length > 0 ? 'vocabMiss'
          : 'ok'

    results.push({
      run, ms, outcome,
      missingFields: missingFields.length ? [...missingFields] : undefined,
      vocabMisses: vocabMisses.length ? vocabMisses : undefined,
      simplified,
      followUpCount: followUps.length,
      summaryLen: typeof parsed.summary === 'string' ? parsed.summary.length : 0,
    })
    console.log(`     run ${run}: ${outcome}（${ms}ms，summary ${typeof parsed.summary === 'string' ? parsed.summary.length : 0} 字，followUps ${followUps.length}）`)
  }

  // ── 統計 ────────────────────────────────────────────────
  const ok = results.filter(r => r.outcome === 'ok').length
  const vocabMiss = results.filter(r => r.outcome === 'vocabMiss').length
  const formatFail = results.filter(r => r.outcome === 'formatFail').length
  const transportFail = results.filter(r => r.outcome === 'transportFail').length
  const simplifiedCount = results.filter(r => r.simplified).length
  const latencies = results.filter(r => r.outcome !== 'transportFail').map(r => r.ms).sort((a, b) => a - b)
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0
  const max = latencies.length ? latencies[latencies.length - 1] : 0
  const summaryLens = results.filter(r => r.summaryLen).map(r => r.summaryLen!)
  const avgLen = summaryLens.length ? Math.round(summaryLens.reduce((a, b) => a + b, 0) / summaryLens.length) : 0

  p.fixture('closure-agent-runs', { agentIdPresent: true, runs: results }, true)

  p.record({
    question: '006-A',
    claim: '結案摘要 agent 能穩定產出 7 個欄位的 JSON',
    verdict: formatFail === 0 && transportFail === 0 ? 'yes' : formatFail + transportFail <= 1 ? 'partial' : 'no',
    evidence: `n=${RUNS}：完全合格 ${ok}、受控詞彙挑錯 ${vocabMiss}、格式失敗 ${formatFail}、傳輸失敗 ${transportFail}。`
      + `summary 平均 ${avgLen} 字（prompt 要求 120–250）。`,
    impact: formatFail + transportFail === 0
      ? '模型撐得住這個輸出形狀，維持 google.gemma-3-27b-it，不需換模型。'
      : '⚠️ 形狀撐不住。先看 out/31-closure-agent-runs.json 的 missingFields 是集中在哪一欄 —— '
        + '若集中在 followUps（唯一的巢狀結構），優先考慮把它攤平成字串陣列；'
        + '若是分散的欄位遺漏，才是模型容量問題，換 model_id 重跑本支。',
  })

  p.record({
    question: '006-B',
    claim: '受控詞彙的白名單命中率',
    verdict: vocabMiss === 0 ? 'yes' : vocabMiss <= 1 ? 'partial' : 'no',
    evidence: vocabMiss === 0
      ? `n=${RUNS} 全數命中白名單（或正確留白）。`
      : `n=${RUNS} 有 ${vocabMiss} 次挑了白名單外的值：`
        + results.filter(r => r.vocabMisses).flatMap(r => r.vocabMisses!).join('、'),
    impact: vocabMiss === 0
      ? '憲法 4.6 的後端後驗仍 MUST 保留（prompt 不是保證），但實務上不會經常把欄位打空。'
      : '⚠️ 挑錯的那一欄在面板上會是空的、要客服自己選 —— 功能正確但體驗差。'
        + '若集中在 category（值域最大的一欄），考慮在 prompt 裡替每個分類補一句適用情境。',
  })

  p.record({
    question: '006-C',
    claim: '結案摘要的單次呼叫延遲（SC-004 的其中一段）',
    verdict: 'unknown',
    evidence: `中位數 ${median}ms、最慢 ${max}ms（n=${latencies.length}，不含傳輸失敗）。`,
    impact: `SC-004 的預算是「按下結案 → 看見草稿 ≤ 10 秒 p90」，本段之外還有候選查詢與則數掃描。`
      + `⚠️ 這個數字是**單段**，不是 SC-004 本身 —— SC-004 要等三段都接起來才量得了（spike 30）。`,
  })

  if (simplifiedCount > 0) {
    p.record({
      question: '006-D',
      claim: '結案摘要輸出出現簡體字',
      verdict: 'no',
      evidence: `n=${RUNS} 有 ${simplifiedCount} 次命中簡體字偵測。`,
      impact: '⚠️ 與情緒走勢摘要 2026-08-31 那次同一個形狀：user prompt 的語言規則不夠，'
        + '真正的槓桿在後台 agent 的 system prompt。MUST 回後台加強，'
        + 'MUST NOT 在程式碼裡做簡轉繁（憲法：換出來的是看起來對、實際是別的字）。',
    })
  }
})

if (isMain(import.meta.url)) {
  void probe31().then((f: Finding[]) => {
    const bad = f.filter(x => x.verdict === 'no').length
    process.exit(bad > 0 ? 1 : 0)
  })
}
