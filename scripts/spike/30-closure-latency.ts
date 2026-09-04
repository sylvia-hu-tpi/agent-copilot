/**
 * 30 — 結案三段時間預算量測（`specs/006-closure-handoff-summary` research #24）。
 *
 * 量三段，各 n=5，分短（≤ 10 則）／中（≈ 50 則）／長（≥ 200 則）三種涵蓋區間：
 *   ① `scopes`  —— 結案紀錄查詢 ＋ 則數掃描
 *   ② `draft`   —— 快照取數 ＋ AI 產生
 *   ③ `commit`  —— 三步冪等寫入
 *
 * ⚠️⚠️ **這是容量規劃參考，MUST NOT 回頭變成 SC-004 的驗收門檻**（research #20）。
 *
 *      SC-004 已於 2026-09-03 由「N 秒內完成」改寫成「等待期間 100% 誠實」，
 *      理由是**摘要產生的耗時由涵蓋區間長度決定，訂任何秒數都是錯的口徑**。
 *      把這裡量到的中位數搬去當門檻，等於把那個裁示原地推翻 ——
 *      而推翻的方式是「我們有數據了」，聽起來還很有道理。
 *
 *      ⚠️ 寫入路徑（③）不同：它的工作量固定為三次 Board 呼叫，**本來就有** 30 秒
 *      硬逾時（FR-032a），那個數字不是從這裡量出來的，也不該因為這裡量到
 *      「實測只要 300ms」就調小 —— 門檻是留給壞掉的那一天用的。
 *
 * ⚠️⚠️ **`commit` 段會寫入正式 CRM。** 因此：
 *        ① 不帶 `--yes` 只量 ①②（唯讀），③ 整段跳過
 *        ② 帶 `--yes` 時，寫入前印出計畫
 *        ③ 寫入的結案紀錄 `summary` 一律以「spike 30 量測用，可刪除」開頭，
 *           讓事後在 Board 上一眼認得出來該刪哪幾筆
 *      執行前 MUST 讓使用者知情（`CLAUDE.md` 環境章節）。
 *
 * 跑法：
 *   npm run spike:closure-latency              # 只量 scopes 與 draft（唯讀）
 *   npm run spike:closure-latency -- --yes     # 連 commit 一起量（會寫入正式 CRM）
 */

import { isMain, requireEnv, runProbe, SkipProbe, type Finding, type Probe } from './lib/harness.js'
import { clientForApiKey } from '../../server/services/imbrace.js'
import type { ImbraceClient } from '@imbrace/sdk'
import { CLOSURE_VOCABULARY } from '../../config/categories.js'
import {
  countByCandidate,
  fetchPeriodMessages,
  messagePageFetcher,
} from '../../server/services/closure/period.js'
import {
  commitClosure,
  listClosuresFor,
} from '../../server/services/closure/board-repository.js'
import { buildClosurePrompt } from '../../server/services/ai/imbrace-agent-provider.js'
import type { ClosureSummary } from '../../shared/types/copilot.js'
import { fetchLatest } from '../../server/sources/message-fetch.js'

const CONFIRMED = process.argv.includes('--yes')
const RUNS = 5

/** ⚠️ 這個前綴讓事後在 Board 上一眼認得出哪幾筆是量測產生的 */
const SPIKE_SUMMARY_PREFIX = 'spike 30 量測用，可刪除'

/** 三種涵蓋區間的目標則數 —— 由「往回數 N 則」推出 `periodStart` */
const BUCKETS = [
  { label: '短區間', targetMessages: 10 },
  { label: '中區間', targetMessages: 50 },
  { label: '長區間', targetMessages: 200 },
] as const

interface Sample { bucket: string, stage: 'scopes' | 'draft' | 'commit', ms: number, note?: string }

function stats(values: number[]): { n: number, median: number, min: number, max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return {
    n: sorted.length,
    median: sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[mid]!
        : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number, value: T }> {
  const t0 = Date.now()
  const value = await fn()
  return { ms: Date.now() - t0, value }
}

export const probe30 = () => runProbe('30', '結案三段時間預算', async (p) => {
  const boardId = requireEnv('IMBRACE_CLOSURE_BOARD_ID')
  const conversationId = requireEnv('IMBRACE_SPIKE_CONVERSATION_ID')
  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: 'stable',
  })

  if (CONFIRMED) {
    console.log('\n  ⚠️ `--yes` 已帶：`commit` 段會在**正式 CRM** 寫入結案紀錄。')
    console.log(`     board=${boardId} conversation=${conversationId}`)
    console.log(`     每筆的 summary 以「${SPIKE_SUMMARY_PREFIX}」開頭，量完請自行刪除。\n`)
  }
  else {
    console.log('\n  🔍 未帶 --yes：只量 scopes 與 draft（唯讀），commit 段跳過。\n')
  }

  const samples: Sample[] = []

  // 往回抓一批訊息，用它們的時間戳推出三種涵蓋區間的起點
  const recent = await fetchLatest(client, conversationId, { limit: 200 })
  if (recent.length === 0) throw new SkipProbe(`對話 ${conversationId} 沒有訊息，量不出區間`)

  for (const bucket of BUCKETS) {
    const idx = Math.max(0, recent.length - bucket.targetMessages)
    const periodStart = recent[idx]!.at
    console.log(`  ── ${bucket.label}（目標 ${bucket.targetMessages} 則，起點 ${periodStart}）`)

    for (let run = 0; run < RUNS; run++) {
      // ① scopes：結案紀錄查詢 ＋ 則數掃描
      const scopes = await timed(async () => {
        const closures = await listClosuresFor(client, boardId, conversationId)
        const starts = [...closures.slice(0, 5).map(c => c.closedAt), recent[0]!.at]
        return countByCandidate(messagePageFetcher(client, conversationId), starts)
      })
      samples.push({ bucket: bucket.label, stage: 'scopes', ms: scopes.ms })

      // ② draft：快照取數（AI 的部分見下方說明）
      const draft = await timed(async () => {
        const history = await fetchPeriodMessages(client, conversationId, periodStart)
        /*
          ⚠️ 只組 prompt、**不真的呼叫 agent**：這支 spike 的 client 是 API-key client，
             而 `summarizeClosure()` 的 agent 呼叫已由 `spike:closure-agent`（31）量過
             （短區間中位數 9.4 秒，n=8）。在這裡再打一次只是重複付錢，
             而且會讓「取數」與「AI」兩段的時間混在同一個數字裡 —— 那正是要分開量的東西。
        */
        const prompt = buildClosurePrompt({ history, vocabulary: CLOSURE_VOCABULARY })
        return { messages: history.length, promptChars: prompt.length }
      })
      samples.push({
        bucket: bucket.label,
        stage: 'draft',
        ms: draft.ms,
        note: `快照 ${draft.value.messages} 則、prompt ${draft.value.promptChars} 字（不含 agent 呼叫，見 31）`,
      })

      // ③ commit：三步冪等寫入
      if (CONFIRMED) {
        const write = await timed(() => commitClosure(
          client,
          boardId,
          spikeSummary(conversationId, periodStart, draft.value.messages, bucket.label, run),
          { reqId: `spike30-${bucket.label}-${run}` },
        ))
        samples.push({ bucket: bucket.label, stage: 'commit', ms: write.ms, note: write.value.recordId })
      }
    }
  }

  p.fixture('samples', samples, true)
  report(p, samples)
})

function spikeSummary(
  conversationId: string,
  periodStart: string,
  messageCount: number,
  bucket: string,
  run: number,
): ClosureSummary {
  const now = new Date().toISOString()
  return {
    recordId: '',
    // ⚠️ 每次都用新的 draftId —— 冪等會讓同一個 id 走 update，那量到的是另一條路徑
    draftId: `spike30-${bucket}-${run}-${Date.now()}`,
    conversationId,
    periodStart,
    periodMessageCount: messageCount,
    periodOrigin: 'custom',
    channel: '',
    contactId: '',
    operators: [],
    joinedAt: periodStart,
    closedAt: now,
    summary: `${SPIKE_SUMMARY_PREFIX} —— ${bucket} 第 ${run + 1} 次，涵蓋 ${messageCount} 則。`,
    intent: SPIKE_SUMMARY_PREFIX,
    category: '',
    resolution: '',
    actionsTaken: [],
    sentimentOutcome: '',
    sentimentStart: null,
    sentimentEnd: null,
    sentimentTrough: null,
    sentimentNote: 'spike 量測，未計算情緒',
    citedSopIds: [],
    followUps: [],
    confidence: null,
    // ⚠️ 留空 ＝ 未經人審（憲法 5.2）。量測產生的紀錄本來就沒有人審過，
    //    填一個人名會讓稽核軌跡指向一個沒做過這件事的人
    reviewedBy: null,
    reviewedAt: null,
  }
}

function report(p: Probe, samples: Sample[]): void {
  const lines: string[] = []
  for (const bucket of BUCKETS) {
    for (const stage of ['scopes', 'draft', 'commit'] as const) {
      const values = samples.filter(s => s.bucket === bucket.label && s.stage === stage).map(s => s.ms)
      if (values.length === 0) continue
      const st = stats(values)
      lines.push(`${bucket.label}/${stage}: n=${st.n} 中位數 ${st.median}ms（${st.min}–${st.max}ms）`)
    }
  }
  lines.forEach(l => console.log(`     ${l}`))

  p.record({
    question: '006-L1',
    claim: '結案三段時間預算（容量規劃參考）',
    verdict: samples.length > 0 ? 'yes' : 'unknown',
    evidence: lines.join('；') || '沒有取得任何樣本',
    impact: '⚠️ **這些數字 MUST NOT 變成 SC-004 的驗收門檻**（research #20）——'
      + '摘要產生的耗時由涵蓋區間長度決定，訂任何秒數都是錯的口徑，'
      + '而 SC-004 已於 2026-09-03 改寫成「等待期間 100% 誠實」。'
      + '寫入路徑的 30 秒硬逾時（FR-032a）不是從這裡量出來的，也不該因為'
      + '「實測只要幾百毫秒」而調小 —— 門檻是留給壞掉的那一天用的。',
  })
}

if (isMain(import.meta.url)) {
  void probe30().then((f: Finding[]) => {
    const bad = f.filter(x => x.verdict === 'no').length
    process.exit(bad > 0 ? 1 : 0)
  })
}

// ⚠️ `ImbraceClient` 只在型別註解裡出現，明寫一次避免 lint 誤判為未使用
export type ClosureLatencyClient = ImbraceClient
