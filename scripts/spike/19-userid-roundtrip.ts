/**
 * 19 — `streamChat()` 的 `user_id` 往返成本（004 FR-001 的前置量測）
 *
 * 為什麼需要它：`ImbraceAgentProvider.callAgent()` 沒有傳 `user_id`，而 SDK 的
 * `streamChat()` 在該欄位缺席時會**先串行 await 一次** `POST /ai-agent/chat-client/auth/user`
 * 取 id，才打 `/v2/chat`（見 `node_modules/@imbrace/sdk/dist/resources/ai-agent.js`）。
 * 於是每一次摘要、每一次情緒批次、每一次建議卡都多付一趟往返去查同一個固定值。
 *
 * 2026-08-29 實測：建議卡第一段的 p90 是 10310ms，只超出 002 SC-001 的 10 秒門檻 310ms。
 * 這趟往返是目前唯一「不換模型、不改規格數字」就可能補上缺口的槓桿（模型已用 n=15
 * 的 A／B 排除，見 `docs/ARCHITECTURE.md` §8.2b）。
 *
 * ⚠️ **為什麼隔離量測，而不是 A／B 比端到端？** 因為端到端量不出來。第一段的
 *    σ ≈ 849ms，若真實差異約 300ms，n=15 兩組的差異標準誤 = 849×√(2/15) ≈ 310ms ——
 *    差異剛好等於一個標準誤，統計上不可分辨，要 n≈100+ 才有解析度（每組 15 分鐘以上）。
 *    而這趟往返是**串行且純加性**的固定成本，隔離量它就是省下來的量，精度高得多。
 *    下方仍附一組小樣本 A／B，但它的作用是**驗證正確性**（傳了會不會 400／輸出是否照常），
 *    不是拿來比延遲 —— 這點務必不要誤讀。
 *
 * ⚠️ **快取的前提是 id 真的固定。** 本腳本會核對多次取得的 id 是否一致；若不一致，
 *    「查一次快取起來」這個結論就不成立，MUST NOT 照做。
 *
 * 用法：
 *   npm run spike:userid              # 預設 auth 20 次、A／B 各 5 次
 *   npm run spike:userid -- 30 8      # auth 30 次、A／B 各 8 次
 */

import { makeClient, loadEnv, isMain, OUT_DIR } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 與 18 號的 `suggestion` 同一組輸入，數字才可跨腳本比較 */
const PROBE_PROMPT = '請針對以下客服對話產生建議回覆卡（輸出 JSON 陣列，最多 3 張，'
  + '每張含 text／tone／rationale 三個欄位）：\n\n'
  + '[客戶] 網路斷了，已經第五次跟你們反應了，到底要修到什麼時候？'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  // nearest-rank：p90 取第 ceil(0.9n) 個，與 18 號的判讀方式一致
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

interface Stats { n: number, min: number, median: number, p90: number, max: number, mean: number, sd: number }

function stats(ms: number[]): Stats {
  const s = [...ms].sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length)
  return {
    n: s.length,
    min: s[0]!,
    median: percentile(s, 0.5),
    p90: percentile(s, 0.9),
    max: s[s.length - 1]!,
    mean: Math.round(mean),
    sd: Math.round(sd),
  }
}

/**
 * ⚠️ 這裡刻意**複製 SDK 內部那一行的呼叫形狀**（`POST`、無 body、無 Content-Type），
 *    而不是用 `client.aiAgent.getChatClientUser()`（它會多送一個 JSON body）。
 *    量的必須是 `streamChat()` 實際付出的那一趟，不是形狀相近的另一趟。
 */
async function timeAuthCall(client: ImbraceClient): Promise<{ ms: number, id: string }> {
  // ⚠️ base 一律取 SDK resource 自己持有的那一份，MUST NOT 由 `IMBRACE_BASE_URL` 自行組——
  //    該環境變數可以是空的（SDK 依 `env` 帶預設值），自行組會得到壞掉的 URL。
  const agentRes = client.aiAgent as unknown as { http: { getFetch: () => typeof fetch }, base: string }
  const { http, base } = agentRes
  const t0 = Date.now()
  const res = await http.getFetch()(`${base}/chat-client/auth/user`, { method: 'POST' })
  const data = await res.json() as { id?: string }
  return { ms: Date.now() - t0, id: String(data.id ?? '') }
}

async function timeStreamChat(
  client: ImbraceClient,
  assistantId: string,
  userId?: string,
): Promise<{ ms: number, ok: boolean, note: string }> {
  const t0 = Date.now()
  try {
    const res = await client.aiAgent.streamChat({
      assistant_id: assistantId,
      messages: [{ role: 'user', parts: [{ type: 'text', text: PROBE_PROMPT }] }],
      ...(userId ? { user_id: userId } : {}),
    })
    const raw = await res.text()
    const events = raw.split('\n')
      .filter(l => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
      .filter(Boolean) as Array<Record<string, unknown>>
    const errText = events.find(e => typeof e.errorText === 'string')?.errorText
    if (errText) return { ms: Date.now() - t0, ok: false, note: `平台回報：${String(errText)}` }
    const text = events.filter(e => e.type === 'text-delta').map(e => String(e.delta ?? '')).join('')
    return {
      ms: Date.now() - t0,
      ok: text.trim().length > 0,
      note: text.trim() ? `輸出 ${text.trim().length} 字` : '⚠️ 無文字輸出',
    }
  }
  catch (e) {
    return { ms: Date.now() - t0, ok: false, note: `💥 ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function findAgent(client: ImbraceClient, name: string): Promise<string | null> {
  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>
  const hit = raw.find(a => String(a.name) === name)
  return hit ? String(hit.id ?? hit._id ?? '') : null
}

async function main(): Promise<void> {
  loadEnv()
  const authRuns = Number(process.argv[2] ?? 20)
  const abRuns = Number(process.argv[3] ?? 5)
  const client = makeClient()

  console.log(`\n── 19 user_id 往返成本 ──────────────────────────────────`)

  // ── ① 隔離量測：auth 往返本身 ──────────────────────────
  console.log(`\n① POST /ai-agent/chat-client/auth/user（${authRuns} 次）`)
  const authMs: number[] = []
  const ids = new Set<string>()
  for (let i = 1; i <= authRuns; i++) {
    const r = await timeAuthCall(client)
    authMs.push(r.ms)
    ids.add(r.id)
    process.stdout.write(`   ${r.ms}ms${i % 10 === 0 ? '\n' : ''}`)
  }
  const a = stats(authMs)
  console.log(`\n   n=${a.n}  最快 ${a.min}ms  中位 ${a.median}ms  p90 ${a.p90}ms  最慢 ${a.max}ms  平均 ${a.mean}ms  σ ${a.sd}ms`)

  // ⚠️ id 不固定的話，「查一次快取起來」的結論不成立
  const idStable = ids.size === 1
  console.log(`   id 穩定性：${idStable ? `✅ ${authRuns} 次皆為同一個 id` : `❌ 出現 ${ids.size} 個不同的 id —— 不可快取`}`)

  // ── ② 正確性驗證（不是延遲比較，見檔頭警告） ──────────
  const agentId = await findAgent(client, 'AgentCopilot_建議回覆_agent')
  const ab: { without: Array<{ ms: number, ok: boolean, note: string }>, with_: Array<{ ms: number, ok: boolean, note: string }> } = { without: [], with_: [] }

  if (!agentId) {
    console.log(`\n② ⚠️ 找不到 AgentCopilot_建議回覆_agent，跳過正確性驗證`)
  }
  else {
    const userId = [...ids][0]!
    console.log(`\n② 傳入 user_id 的正確性驗證（各 ${abRuns} 次，交錯執行）`)
    for (let i = 1; i <= abRuns; i++) {
      // 交錯並每輪對調順序，避免把平台漂移全算到其中一組頭上
      const first = i % 2 === 1
      const r1 = await timeStreamChat(client, agentId, first ? undefined : userId)
      const r2 = await timeStreamChat(client, agentId, first ? userId : undefined)
      ab.without.push(first ? r1 : r2)
      ab.with_.push(first ? r2 : r1)
      console.log(`   第 ${i} 輪  不傳 ${(first ? r1 : r2).ms}ms ${(first ? r1 : r2).ok ? '✅' : '❌'}   `
        + `傳 ${(first ? r2 : r1).ms}ms ${(first ? r2 : r1).ok ? '✅' : '❌'} ${(first ? r2 : r1).note}`)
    }
    const okWith = ab.with_.filter(r => r.ok).length
    console.log(`\n   傳入 user_id 後仍正常輸出：${okWith}/${abRuns}`
      + `${okWith === abRuns ? ' ✅ 傳入不影響結果' : ' ⛔ 傳入會破壞呼叫，MUST NOT 採用'}`)
    console.log(`   （延遲欄位僅供參考，n 太小不足以比較 —— 見檔頭警告）`)
  }

  console.log(`\n── 結論 ──────────────────────────────────────────────────`)
  console.log(`   每次 AI 呼叫可省下的固定成本 ≈ 中位 ${a.median}ms（p90 ${a.p90}ms）`)
  console.log(`   建議卡第一段 p90 為 10310ms、門檻 10000ms —— 缺口 310ms`)
  console.log(`   ${a.median >= 310 ? '✅ 中位數即足以補上缺口' : '⚠️ 單靠這一項不足以補上缺口'}\n`)

  const file = resolve(OUT_DIR, '19-userid-roundtrip.json')
  writeFileSync(file, JSON.stringify({
    authRuns, auth: a, authMs, idStable, idCount: ids.size, ab,
  }, null, 2), 'utf8')
  console.log(`   📁 ${file}\n`)
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('\n💥', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
