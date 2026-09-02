/**
 * 26 — 情緒並行度掃描（specs/005-m2-residual-defects FR-018／FR-018a／FR-019／FR-020、SC-007）
 *
 * 量什麼：對 3／4／5 三個 `SENTIMENT_CONCURRENCY` 檔位，各自量出**兩列**並陳
 *   - 情緒區塊的**總時間**分布（001 SC-005 的 15 秒 p90，未落地者計為未達）
 *   - 情緒**單次呼叫**的失敗率與破 15 秒率
 * 「總時間變短」與「失敗率上升」可能同時發生（並發讓平台側排隊而抬高單次延遲，單次破 15 秒
 * 就觸發重試、重試用盡整批轉 error），而畫面上只會看到偶發紅字。**只看一列會下錯決定**（FR-019）。
 *
 * ── 為什麼每個檔位一個子行程（research.md #19）──────────────────────
 * `SENTIMENT_CONCURRENCY` 是 module-level `const`、在模組載入時就綁定，**同一行程內無法切換**。
 * 唯一的替代是把它改成每次呼叫時讀的可變值 —— 那才是真的在生產路徑上開旋鈕。
 * 因此本腳本只負責**掃描與輪換**：對每個（輪次, 檔位）以 `SENTIMENT_CONCURRENCY=<tier>` 的環境
 * 另開一個子行程跑 21 號腳本（量測核心與資料格式都是它的，不另建一份 —— research.md #20），
 * 然後讀回它寫出的 JSON 聚合。
 *
 * ── 口徑（FR-018a，MUST 照做）────────────────────────────────────
 *   每檔位三輪、n=45（每輪每檔位 15 個樣本），輪次間**輪換檔位順序**（3,4,5／4,5,3／5,3,4），
 *   全部在同一個時段內連續跑完；**樣本 MUST NOT 並行取得** —— 並行度正是被量的變數，
 *   同時跑會抬高單次延遲、污染要量的東西。因此本量測沒有靠並行縮短時間的空間，實跑約 1 小時。
 *   單輪不足以支撐任何檔位結論：同一設定連續三輪量到 73%／93%／67%，單輪擺動 26 個百分點。
 *
 * ── 判準（FR-019，由 T050 的人做決定，本腳本只並陳）────────────────────
 *   採用新檔位的判準是「總時間改善**且**單次失敗率未上升」；只有總時間改善 MUST NOT 作為採用理由。
 *   ⚠️ 15 秒 p90 門檻在本規格期間維持不動（FR-020a）。
 *   ⚠️ 平台處於已知降級時段時結果 MUST 標註（`--note`），不得在降級樣本上下永久結論（FR-020）。
 *   ⚠️ 若決定採用新檔位，MUST 一併複查 FR-009 的「每輪 18 則」上限 —— 那個數字的理由是
 *      「對齊一波並行」，並行度一改理由就不再自動成立。
 *
 * ⚠️ **量測前先跑 `npm run spike:agent-prompts`**（§11）。
 * ⚠️ **唯讀**：子行程走 21 號的唯讀模式（只 GET，不 JOIN、不送訊息、不切換 mode）。
 *
 * 用法：
 *   npm run spike:sentiment-concurrency -- "標題A" … "標題O"
 *   選項：--tiers 3,4,5（預設）、--rounds 3（預設）、--per-round 15（每輪每檔位樣本數，預設）、
 *         --note "平台降級時段"、--dry-run（只印計畫，不開子行程）
 *   都不給目標時退回 `.env.local` 的 SPIKE_CONVERSATION_IDS。
 *   每個（輪次, 檔位）的樣本數 ＝ 目標數 × ⌈per-round ÷ 目標數⌉（例：4 段 → --repeat 4 → 16 個）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { env, isMain, loadEnv, OUT_DIR, ROOT, SkipProbe } from './lib/harness.js'
import { fallbackInputs } from './21-progressive-citations.js'

const DEFAULT_TIERS = [3, 4, 5]
const DEFAULT_ROUNDS = 3
const DEFAULT_PER_ROUND = 15
/** 001 SC-005 的情緒門檻（FR-020a：本規格期間 MUST NOT 放寬） */
const SENTIMENT_BUDGET_MS = 15_000
/** FR-014 的單次逾時 —— 單次破它就會觸發重試 */
const CALL_TIMEOUT_MS = 15_000

/** 21 號寫出的 JSON 裡本腳本用到的欄位 */
interface Spike21Output {
  at: string
  samples: Array<{
    conversationId: string
    title: string
    round: number
    customerMessageCount: number
    sentimentReadyMs: number | null
    sentimentChunks: number | null
    sentimentCalls?: Array<{ elapsedMs: number, ok: boolean, errorName?: string }>
    sentimentPeakInFlight?: number
    error?: string
  }>
}

interface Run {
  round: number
  tier: number
  order: number
  startedAt: string
  endedAt: string
  exitCode: number | null
  samples: Spike21Output['samples']
}

interface TierStats {
  tier: number
  runs: number
  /** 可用樣本數（有客戶發言、沒炸掉） */
  n: number
  /** 情緒區塊總時間：未落地（error）計為未達且進分母 */
  block: { landed: number, missing: number, medianMs: number | null, p90Ms: number | null, maxMs: number | null, withinBudget: number, passRate: number | null }
  /** 單次呼叫：失敗率與破逾時率是 FR-019 的第二列 */
  calls: { n: number, medianMs: number | null, p90Ms: number | null, maxMs: number | null, failed: number, failedRate: number | null, overTimeout: number, overTimeoutRate: number | null, peakInFlight: number }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null
}

function rotate<T>(items: T[], round: number): T[] {
  const offset = (round - 1) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function tsxCli(): string[] {
  const cli = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs')
  if (existsSync(cli)) return [process.execPath, cli]
  throw new SkipProbe('找不到 node_modules/tsx/dist/cli.mjs —— 請先 npm install')
}

function runTier(round: number, tier: number, order: number, targets: string[], repeat: number, dryRun: boolean): Run {
  const [bin, ...pre] = tsxCli()
  const args = [...pre, resolve(ROOT, 'scripts/spike/21-progressive-citations.ts'), '--repeat', String(repeat), ...targets]
  const startedAt = new Date().toISOString()
  console.log(`\n══ 第 ${round} 輪・第 ${order} 個檔位 ── SENTIMENT_CONCURRENCY=${tier}（${targets.length} 段 × ${repeat}）── ${startedAt}`)
  if (dryRun) {
    console.log(`   [dry-run] ${bin} ${args.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`)
    return { round, tier, order, startedAt, endedAt: startedAt, exitCode: 0, samples: [] }
  }

  const result = spawnSync(bin!, args, {
    cwd: ROOT,
    // ⚠️ 只有這一個地方可以設定 SENTIMENT_CONCURRENCY（test/contract-guards.test.ts 守著其他設定檔）
    env: { ...process.env, SENTIMENT_CONCURRENCY: String(tier) },
    stdio: 'inherit',
  })
  const endedAt = new Date().toISOString()

  const latest = resolve(OUT_DIR, '21-progressive-citations.json')
  let samples: Spike21Output['samples'] = []
  try {
    const parsed = JSON.parse(readFileSync(latest, 'utf8')) as Spike21Output
    // 子行程沒寫出新檔（例如整支略過）時，上一次的舊檔會留在那裡 —— 用時間戳擋掉
    if (Date.parse(parsed.at) >= Date.parse(startedAt)) samples = parsed.samples
    else console.log('   ⚠️ 21 號沒有寫出這一輪的結果（時間戳早於本輪開始），本輪不計')
  }
  catch (err) {
    console.log(`   ⚠️ 讀不到 21 號的輸出：${err instanceof Error ? err.message : String(err)}`)
  }
  return { round, tier, order, startedAt, endedAt, exitCode: result.status, samples }
}

function aggregate(tier: number, runs: Run[]): TierStats {
  const samples = runs.flatMap(r => r.samples).filter(s => !s.error)
  const landed = samples.map(s => s.sentimentReadyMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const n = samples.length
  // 第 90 百分位落在「已落地值 ++ 未落地(+∞)」這個長度 n 的序列上（與 21 號的 budgetStats 同一個定義）
  const p90Index = Math.ceil(0.9 * n) - 1
  const calls = samples.flatMap(s => s.sentimentCalls ?? [])
  const callMs = calls.map(c => c.elapsedMs).sort((a, b) => a - b)
  const failed = calls.filter(c => !c.ok).length
  const over = calls.filter(c => c.elapsedMs > CALL_TIMEOUT_MS).length
  const withinBudget = landed.filter(v => v <= SENTIMENT_BUDGET_MS).length
  return {
    tier,
    runs: runs.length,
    n,
    block: {
      landed: landed.length,
      missing: n - landed.length,
      medianMs: percentile(landed, 0.5),
      p90Ms: n > 0 && p90Index < landed.length ? landed[p90Index]! : null,
      maxMs: landed[landed.length - 1] ?? null,
      withinBudget,
      passRate: n > 0 ? withinBudget / n : null,
    },
    calls: {
      n: calls.length,
      medianMs: percentile(callMs, 0.5),
      p90Ms: percentile(callMs, 0.9),
      maxMs: callMs[callMs.length - 1] ?? null,
      failed,
      failedRate: calls.length > 0 ? failed / calls.length : null,
      overTimeout: over,
      overTimeoutRate: calls.length > 0 ? over / calls.length : null,
      peakInFlight: Math.max(0, ...samples.map(s => s.sentimentPeakInFlight ?? 0)),
    },
  }
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(0)}%`
}
function ms(v: number | null): string {
  return v === null ? '未落地' : `${v}ms`
}

function parseArgs(argv: string[]) {
  const consumed = new Set<number>()
  const valueOf = (flag: string, fallback: string): string => {
    const at = argv.indexOf(flag)
    if (at < 0) return fallback
    consumed.add(at + 1)
    return argv[at + 1] ?? fallback
  }
  const tiers = valueOf('--tiers', DEFAULT_TIERS.join(',')).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 1)
  const rounds = Math.max(1, Number(valueOf('--rounds', String(DEFAULT_ROUNDS))) || DEFAULT_ROUNDS)
  const perRound = Math.max(1, Number(valueOf('--per-round', String(DEFAULT_PER_ROUND))) || DEFAULT_PER_ROUND)
  const note = valueOf('--note', '')
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i))
  return { tiers: tiers.length > 0 ? tiers : DEFAULT_TIERS, rounds, perRound, note, dryRun: argv.includes('--dry-run'), inputs }
}

async function main(): Promise<void> {
  loadEnv()
  const { tiers, rounds, perRound, note, dryRun, inputs } = parseArgs(process.argv.slice(2))
  const targets = inputs.length > 0 ? inputs : fallbackInputs()
  const repeat = Math.max(1, Math.ceil(perRound / targets.length))
  const perTierN = rounds * targets.length * repeat

  console.log(`\n── 26 情緒並行度掃描（005 FR-018／SC-007）${'─'.repeat(22)}`)
  console.log(`   環境 ${env('IMBRACE_ENV', 'stable')}｜檔位 ${tiers.join('／')}｜${rounds} 輪，輪次間輪換檔位順序｜`
    + `每輪每檔位 ${targets.length} 段 × ${repeat} ＝ ${targets.length * repeat} 個樣本 → 每檔位 n=${perTierN}`)
  console.log('   序列執行、不並行取樣（並行度正是被量的變數）。⚠️ 先跑過 npm run spike:agent-prompts 了嗎？')
  if (perTierN < DEFAULT_ROUNDS * DEFAULT_PER_ROUND || rounds !== DEFAULT_ROUNDS) {
    console.log(`   ⚠️ FR-018a 的口徑是每檔位三輪、n=45；目前 n=${perTierN}、${rounds} 輪，**不足以支撐檔位結論**，只能當探勘。`)
  }
  if (note) console.log(`   備註（FR-020）：${note}`)

  const startedAt = new Date().toISOString()
  const runs: Run[] = []
  for (let round = 1; round <= rounds; round++) {
    const order = rotate(tiers, round)
    order.forEach((tier, i) => {
      runs.push(runTier(round, tier, i + 1, targets, repeat, dryRun))
    })
  }
  const endedAt = new Date().toISOString()

  const perTier = tiers.map(tier => aggregate(tier, runs.filter(r => r.tier === tier)))
  const baseline = perTier.find(t => t.tier === Math.min(...tiers)) ?? null

  const summary = {
    at: endedAt,
    startedAt,
    endedAt,
    /** FR-020：平台若處於已知降級時段 MUST 標註 —— 空字串代表沒有人標 */
    note,
    env: env('IMBRACE_ENV', 'stable'),
    tiers,
    rounds,
    perRound,
    targets: targets.length,
    repeat,
    /** 每檔位是否達 FR-018a 的口徑（三輪、n≥45）—— 不達時**不足以支撐決定**（SC-007） */
    meetsCriteria: rounds === DEFAULT_ROUNDS && perTier.every(t => t.n >= DEFAULT_ROUNDS * DEFAULT_PER_ROUND),
    budgetMs: SENTIMENT_BUDGET_MS,
    callTimeoutMs: CALL_TIMEOUT_MS,
    perTier,
    /**
     * FR-019 的**初步**判讀（相對於最低檔位）：只有「總時間改善且失敗率未上升」才標 candidate。
     * ⚠️ 這不是決定 —— 決定由 T050 的人做並寫進 docs/ARCHITECTURE.md，且 MUST 一併複查 FR-009 的 18 則。
     */
    reading: perTier.map(t => ({
      tier: t.tier,
      totalTimeImproved: baseline && t.tier !== baseline.tier && t.block.passRate !== null && baseline.block.passRate !== null
        ? t.block.passRate > baseline.block.passRate
        : null,
      failureRateNotUp: baseline && t.tier !== baseline.tier && t.calls.failedRate !== null && baseline.calls.failedRate !== null
        ? t.calls.failedRate <= baseline.calls.failedRate
        : null,
    })).map(r => ({ ...r, candidate: r.totalTimeImproved === true && r.failureRateNotUp === true })),
    runs: runs.map(r => ({ round: r.round, tier: r.tier, order: r.order, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, samples: r.samples.length })),
  }

  if (!dryRun) {
    mkdirSync(OUT_DIR, { recursive: true })
    const payload = JSON.stringify({ ...summary, rawRuns: runs }, null, 2)
    const latest = resolve(OUT_DIR, '26-sentiment-concurrency.json')
    const stamped = resolve(OUT_DIR, `26-sentiment-concurrency-${endedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(latest, payload, 'utf8')
    writeFileSync(stamped, payload, 'utf8')
    console.log(`\n  📁 ${latest.replace(ROOT, '.')}（同時留存 ${stamped.replace(ROOT, '.')}）`)
  }

  console.log(`\n── 彙總 ${'─'.repeat(50)}`)
  console.log(`  時段：${startedAt} → ${endedAt}${note ? `｜備註：${note}` : ''}`)
  console.log(`  口徑：${summary.meetsCriteria ? '✅ 每檔位三輪、n≥45（FR-018a）' : '⚠️ 未達 FR-018a 的口徑 —— 不足以支撐檔位結論'}`)
  console.log('')
  console.log('  檔位 │ n  │ 區塊總時間（001 SC-005，≥90% 在 15 秒內）                 │ 單次呼叫（FR-019 的第二列）')
  console.log('  ─────┼────┼──────────────────────────────────────────────────────────┼──────────────────────────────────────────')
  for (const t of perTier) {
    console.log(`  ${String(t.tier).padStart(3)}  │ ${String(t.n).padStart(2)} │ `
      + `${t.block.withinBudget}/${t.n} = ${pct(t.block.passRate).padStart(4)} 中位 ${ms(t.block.medianMs)} p90 ${ms(t.block.p90Ms)} 最慢 ${ms(t.block.maxMs)}`
      + `${t.block.missing ? `（${t.block.missing} 個未落地）` : ''}`.padEnd(58)
      + ` │ n=${t.calls.n} 失敗 ${t.calls.failed}（${pct(t.calls.failedRate)}）破 15 秒 ${t.calls.overTimeout}（${pct(t.calls.overTimeoutRate)}）`
      + ` 中位 ${ms(t.calls.medianMs)} p90 ${ms(t.calls.p90Ms)} 峰值並發 ${t.calls.peakInFlight}`)
  }
  console.log('')
  for (const r of summary.reading) {
    if (r.totalTimeImproved === null) continue
    console.log(`  檔位 ${r.tier} vs ${baseline?.tier}：總時間${r.totalTimeImproved ? '改善' : '未改善'}、失敗率${r.failureRateNotUp ? '未上升' : '**上升**'}`
      + ` → ${r.candidate ? '✅ 符合 FR-019 的採用判準（決定仍由人做，並複查 FR-009 的 18 則）' : '❌ 不採用（只有總時間變快不足以作為理由）'}`)
  }
  console.log('')
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof SkipProbe) {
      console.log(`\n⏭  略過：${err.message}\n`)
      process.exit(0)
    }
    console.error('\n💥', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
