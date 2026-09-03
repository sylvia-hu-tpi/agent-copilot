/**
 * 15 — 驗證使用者在 iMBrace 後台手動建立的兩個 Copilot agent
 *   （`AgentCopilot_摘要_agent`、`AgentCopilot_情緒評分_agent`）
 *
 * 目的：在真的動手把 MockAIProvider 換成 ImbraceAgentProvider 之前，
 * 先確認這兩個 agent 對我們實際會送的輸入格式，能不能穩定回傳符合
 * shared/types/copilot.ts 型別（去除系統自填欄位後）的 JSON——
 * 不能只信「4/4 次可 JSON.parse」這個通用測試的舊數字（那是拿「請回覆 OK」
 * 這種極簡任務測出來的，複雜度跟我們真正要的結構化摘要／情緒陣列不是同一回事）。
 *
 * ⚠️ 唯讀：只送 streamChat 問句，不寫任何對話資料。
 *
 * 跑法：
 *   npm run spike:copilot-agents
 */

import { z } from 'zod'
import { runProbe, isMain, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

const SUMMARY_AGENT_NAME = 'AgentCopilot_摘要_agent'
const SENTIMENT_AGENT_NAME = 'AgentCopilot_情緒評分_agent'

/** 送幾次同一組輸入，看輸出穩不穩定（不能只測一次就下結論） */
const RUNS_PER_CASE = 3

// ── AI 實際要輸出的形狀（拿掉 messageId／at／updatedAt／basedOnMessageId 這些
//    系統自己知道、不該讓 agent 猜的欄位——這些之後由 ImbraceAgentProvider 自己補回去）───

const AgentSummarySchema = z.object({
  intent: z.string().min(1),
  keyFacts: z.array(z.string()),
  attempted: z.array(z.string()),
  openIssues: z.array(z.string()),
  riskFlags: z.array(z.string()),
  advice: z.string().min(1),
})

const AgentSentimentPointSchema = z.object({
  score: z.number().min(0).max(100),
  label: z.enum(['calm', 'neutral', 'concerned', 'frustrated', 'angry']),
  drivers: z.array(z.string()),
})

async function findAgent(client: ImbraceClient, name: string): Promise<string | null> {
  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>
  const hit = raw.find(a => String(a.name) === name)
  return hit ? String(hit.id ?? hit._id ?? '') || null : null
}

async function chat(client: ImbraceClient, assistantId: string, prompt: string) {
  const t0 = Date.now()
  const res = await client.aiAgent.streamChat({
    assistant_id: assistantId,
    messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
  } as Parameters<typeof client.aiAgent.streamChat>[0])
  const raw = await res.text()
  const ms = Date.now() - t0

  const events = raw.split('\n')
    .filter(l => l.startsWith('data:'))
    .map((l) => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean) as Array<Record<string, unknown>>

  const text = events.filter(e => e.type === 'text-delta')
    .map(e => String(e.delta ?? '')).join('')

  return { raw, ms, text }
}

/** 容忍模型偶爾還是包了 ```json 標記，先剝掉再 parse */
function parseJson(text: string): { ok: true, value: unknown } | { ok: false, error: string } {
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return { ok: true, value: JSON.parse(cleaned) }
  }
  catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * `JSON.parse` 在「合法 JSON 後面還有多餘字元」時，錯誤訊息會標出確切的失敗位置——
 * 用它把 JSON 本體跟「多出來的尾巴」切開，方便診斷模型到底多吐了什麼。
 */
function splitTrailingGarbage(text: string): { head: string, tail: string } | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const m = /position (\d+)/.exec((() => {
    try { JSON.parse(cleaned); return '' }
    catch (e) { return e instanceof Error ? e.message : String(e) }
  })())
  if (!m || !m[1]) return null
  const pos = Number(m[1])
  return { head: cleaned.slice(0, pos), tail: cleaned.slice(pos) }
}

const SUMMARY_CASES = [
  {
    label: '合約到期／解約詢問',
    prompt: '請摘要以下客服對話：\n\n'
      + '[客戶] 我的合約好像快到期了，到期後要怎麼辦？\n'
      + '[AI] 一般而言，您的合約到期後，原本的方案仍可延續原有的優惠，收視與上網服務不會中斷。如果您想了解更優惠的續約方案，需先由客服專員為您進行身分驗證。\n'
      + '[客戶] 那如果我想解約呢？違約金怎麼算？\n'
      + '[AI] 解約需依照合約剩餘月份計算違約金，詳細金額需要客服專員為您查詢。',
  },
  {
    label: '一般帳務詢問（無風險）',
    prompt: '請摘要以下客服對話：\n\n'
      + '[客戶] 請問這個月的帳單什麼時候會出來？\n'
      + '[AI] 您好，帳單通常於每月 5 號產生，可於官網會員中心查詢。\n'
      + '[客戶] 好的謝謝',
  },
  {
    label: '重複故障未解決（情緒升溫）',
    prompt: '請摘要以下客服對話：\n\n'
      + '[客戶] 網路斷了\n'
      + '[AI] 請協助確認數據機燈號是否正常，並嘗試斷電重啟。\n'
      + '[客戶] 網路斷了\n'
      + '[AI] 請協助確認數據機燈號是否正常，並嘗試斷電重啟。\n'
      + '[客戶] 沒有網路\n'
      + '[AI] 請協助確認數據機燈號是否正常，並嘗試斷電重啟。\n'
      + '[客戶] 網路斷了，已經第五次跟你們反應了，到底要修到什麼時候？',
  },
] as const

const SENTIMENT_CASE = {
  label: '5 則客戶發言，情緒漸次升溫再趨緩',
  count: 5,
  prompt: '請針對以下客戶發言，依序給出情緒判斷（陣列長度需與發言則數一致，共 5 則）：\n\n'
    + '1. 你好，我想問一下網路的問題\n'
    + '2. 網路好像有點不穩定\n'
    + '3. 已經重開機三次了都沒解決\n'
    + '4. 到底要修到什麼時候，已經影響到我上班了\n'
    + '5. 好，那我再等等看',
}

export const probe15 = () => runProbe('15', 'Copilot agent 輸出契約驗證', async (p, client) => {
  const summaryAgentId = await findAgent(client, SUMMARY_AGENT_NAME)
  const sentimentAgentId = await findAgent(client, SENTIMENT_AGENT_NAME)

  console.log(`\n  摘要 agent：${summaryAgentId ? `找到（${summaryAgentId}）` : '❌ 找不到，名稱是否為 ' + SUMMARY_AGENT_NAME}`)
  console.log(`  情緒 agent：${sentimentAgentId ? `找到（${sentimentAgentId}）` : '❌ 找不到，名稱是否為 ' + SENTIMENT_AGENT_NAME}\n`)

  // ── 摘要 agent ──────────────────────────────────────────────
  if (summaryAgentId) {
    const results: Array<{ case: string, run: number, ok: boolean, ms: number, detail: string, rawText?: string }> = []

    for (const c of SUMMARY_CASES) {
      console.log(`  ── 摘要案例：${c.label}`)
      for (let run = 1; run <= RUNS_PER_CASE; run++) {
        const r = await chat(client, summaryAgentId, c.prompt)
        let parsed = parseJson(r.text)
        if (!parsed.ok) {
          const split = splitTrailingGarbage(r.text)
          console.log(`     第 ${run} 次（${r.ms}ms）❌ JSON.parse 失敗：${parsed.error}`)
          if (split) {
            console.log(`        多出來的尾巴：${JSON.stringify(split.tail.slice(0, 200))}`)
            const recovered = parseJson(split.head)
            console.log(`        若只取 JSON 本體（忽略尾巴）：${recovered.ok ? '✅ 可以 parse' : '❌ 依然 parse 不了：' + recovered.error}`)
            if (recovered.ok) parsed = recovered
          }
          if (!parsed.ok) {
            results.push({ case: c.label, run, ok: false, ms: r.ms, detail: `parse failed: ${parsed.error}`, rawText: r.text })
            continue
          }
        }
        const zr = AgentSummarySchema.safeParse(parsed.value)
        if (!zr.success) {
          const issues = zr.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
          console.log(`     第 ${run} 次（${r.ms}ms）❌ 格式不符：${issues}`)
          results.push({ case: c.label, run, ok: false, ms: r.ms, detail: `schema: ${issues}` })
        }
        else {
          console.log(`     第 ${run} 次（${r.ms}ms）✅ intent=「${zr.data.intent}」riskFlags=${JSON.stringify(zr.data.riskFlags)}`)
          results.push({ case: c.label, run, ok: true, ms: r.ms, detail: JSON.stringify(zr.data) })
        }
      }
    }

    p.fixture('summary-agent-runs', results, true)
    const ok = results.filter(r => r.ok).length
    const latencies = results.map(r => r.ms)
    p.record({
      question: 'copilot-summary-agent',
      claim: `${SUMMARY_AGENT_NAME} 對真實輸入格式能否穩定輸出符合 schema 的 JSON`,
      verdict: ok === results.length ? 'yes' : ok > 0 ? 'partial' : 'no',
      evidence: `${ok}/${results.length} 次成功；延遲中位數 ${latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]}ms、最慢 ${Math.max(...latencies)}ms`,
      impact: ok === results.length
        ? '可以直接進入 ImbraceAgentProvider 的正式實作。'
        : '需要先回頭調 agent 的 Core Task／Preload Information，重跑本 probe 直到穩定，再動手寫正式程式碼。',
    })
  }
  else {
    p.record({
      question: 'copilot-summary-agent', claim: '找不到摘要 agent', verdict: 'unknown',
      evidence: `listAiAgents() 裡沒有名稱為 ${SUMMARY_AGENT_NAME} 的項目`,
    })
  }

  // ── 情緒 agent ──────────────────────────────────────────────
  if (sentimentAgentId) {
    const results: Array<{ run: number, ok: boolean, ms: number, detail: string, rawText?: string }> = []

    console.log(`\n  ── 情緒案例：${SENTIMENT_CASE.label}`)
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      const r = await chat(client, sentimentAgentId, SENTIMENT_CASE.prompt)
      let parsed = parseJson(r.text)
      if (!parsed.ok) {
        const split = splitTrailingGarbage(r.text)
        console.log(`     第 ${run} 次（${r.ms}ms）❌ JSON.parse 失敗：${parsed.error}`)
        if (split) {
          console.log(`        多出來的尾巴：${JSON.stringify(split.tail.slice(0, 200))}`)
          const recovered = parseJson(split.head)
          console.log(`        若只取 JSON 本體（忽略尾巴）：${recovered.ok ? '✅ 可以 parse' : '❌ 依然 parse 不了：' + recovered.error}`)
          if (recovered.ok) parsed = recovered
        }
        if (!parsed.ok) {
          results.push({ run, ok: false, ms: r.ms, detail: `parse failed: ${parsed.error}`, rawText: r.text })
          continue
        }
      }
      if (!Array.isArray(parsed.value) || parsed.value.length !== SENTIMENT_CASE.count) {
        console.log(`     第 ${run} 次（${r.ms}ms）❌ 陣列長度不對：預期 ${SENTIMENT_CASE.count}，實際 ${Array.isArray(parsed.value) ? parsed.value.length : '非陣列'}`)
        results.push({ run, ok: false, ms: r.ms, detail: 'length mismatch' })
        continue
      }
      const zr = z.array(AgentSentimentPointSchema).safeParse(parsed.value)
      if (!zr.success) {
        const issues = zr.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        console.log(`     第 ${run} 次（${r.ms}ms）❌ 格式不符：${issues}`)
        results.push({ run, ok: false, ms: r.ms, detail: `schema: ${issues}` })
      }
      else {
        console.log(`     第 ${run} 次（${r.ms}ms）✅ labels=${JSON.stringify(zr.data.map(d => d.label))}`)
        results.push({ run, ok: true, ms: r.ms, detail: JSON.stringify(zr.data) })
      }
    }

    p.fixture('sentiment-agent-runs', results, true)
    const ok = results.filter(r => r.ok).length
    const latencies = results.map(r => r.ms)
    p.record({
      question: 'copilot-sentiment-agent',
      claim: `${SENTIMENT_AGENT_NAME} 對真實輸入格式能否穩定輸出符合 schema、長度對齊的 JSON 陣列`,
      verdict: ok === results.length ? 'yes' : ok > 0 ? 'partial' : 'no',
      evidence: `${ok}/${results.length} 次成功；延遲中位數 ${latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]}ms、最慢 ${Math.max(...latencies)}ms`,
      impact: ok === results.length
        ? '可以直接進入 ImbraceAgentProvider 的正式實作。'
        : '需要先回頭調 agent 的 Core Task／Preload Information，重跑本 probe 直到穩定，再動手寫正式程式碼。',
    })
  }
  else {
    p.record({
      question: 'copilot-sentiment-agent', claim: '找不到情緒 agent', verdict: 'unknown',
      evidence: `listAiAgents() 裡沒有名稱為 ${SENTIMENT_AGENT_NAME} 的項目`,
    })
  }
})

if (isMain(import.meta.url)) {
  probe15().then((f: Finding[]) => process.exit(0))
}
