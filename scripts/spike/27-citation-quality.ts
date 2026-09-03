/**
 * 27 — 建議卡杜撰引用率的可重複量測（specs/005-m2-residual-defects FR-017、SC-006）
 *
 * 量什麼：對**固定一組真實對話**跑生產路徑的冷啟動（`runColdStart()` → 第二段尾巴），
 * 收集生產路徑上發出的 `suggestion.citation.audited` 事件（`server/utils/citation-audit.ts`），聚合出
 *   - **整體杜撰率** ＝ `invalidSopIds.length > 0` 的事件數 ÷ 有命中且模型有回卡的事件數
 *     （`hitCount > 0` 且 `outcome ∉ { no-cards, failed }`，contracts §5）
 *   - **逐對話分布** ＝ 依對話分組的同一比率 —— 已知線索是杜撰有明顯的對話相依性
 *     （某段對話三次量測全數含杜撰、另兩段一次都沒有），MUST 從這裡查起
 *
 * ── 口徑（FR-017，MUST 照做，否則不構成 SC-006 的通過）────────────────
 *   **固定 15 段對話 × 3 輪 ＝ 45 次帶命中的生成**，輪次間輪換對話順序，同一時段連續跑完。
 *   每段對話固定 3 個樣本，是「逐對話分布」看得出集中性的最小條件。單輪數字不算。
 *   ⚠️ 這裡**不套用** FR-018a 的「每檔位」—— 杜撰率沒有「檔位」這個維度。
 *
 * ── 基線 MUST 在改 prompt 之前取（research.md #13）─────────────────────
 *   `buildSuggestionPrompt()` 是刻意與 18 號共用的同一份，改動會同時改變量測用的 prompt。
 *   沒有先取基線就失去「改動前後可比較」這個 SC-006 的判準。用 `--label baseline`／`--label after`
 *   把兩次結果分開存。
 *
 * ── 為什麼直接讀生產路徑的事件、不自己重組 ────────────────────────────
 *   事件在生產路徑上發出，量測腳本跑的又是生產路徑，兩者天然是同一份資料 —— 這正是 FR-015
 *   「證據 MUST 落在生產路徑」換來的直接好處。自行重組兩段流程只會量到另一件事
 *   （18／20／21 號都寫過同一個理由）。連帶代價是每段對話也會跑摘要與情緒，那正是真實 JOIN 的成本。
 *
 * ⚠️ **量測前先跑 `npm run spike:agent-prompts`**（§11）：建議卡 agent 的 system prompt 不在本 repo，
 *    被改掉不會有 commit。量測數字是間接證據，快照 diff 是直接證據。
 * ⚠️ **唯讀**：只 GET 對話與訊息、在本機記憶體跑分析。不 JOIN、不送訊息、不切換 mode。
 * ⚠️ **輸出不含任何訊息或卡片文字**（憲法 1.5）：事件本身就只有數字與識別碼（超長者已雜湊）。
 *
 * 用法：
 *   npm run spike:citation-quality -- --inspect "標題A" … "標題O"        # 只解析目標，不呼叫 AI
 *   npm run spike:citation-quality -- --label baseline "標題A" … "標題O"   # 改 prompt 前
 *   npm run spike:citation-quality -- --label after    "標題A" … "標題O"   # 改 prompt 後
 *   選項：--rounds 3（預設 3）、--note "平台降級時段"（FR-020：量測結果 MUST 標註時段）
 *   都不給目標時退回 `.env.local` 的 SPIKE_CITATION_CONVERSATION_IDS（逗號分隔，建議正好 15 段），
 *   再退回 SPIKE_CONVERSATION_IDS。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { env, isMain, loadEnv, makeClient, OUT_DIR, ROOT, SkipProbe } from './lib/harness.js'
import { fallbackInputs, resolveTargets, type Target } from './21-progressive-citations.js'
import { awaitSuggestionTail, runColdStart } from '../../server/services/copilot-analysis.js'
import { fetchLatest } from '../../server/sources/message-fetch.js'
import { onCitationAudit, type CitationAuditEvent, type CitationOutcome } from '../../server/utils/citation-audit.js'

/** FR-017 的固定口徑 */
const REQUIRED_CONVERSATIONS = 15
const DEFAULT_ROUNDS = 3

interface Sample {
  conversationId: string
  title: string
  round: number
  /** 第幾個被跑（輪換順序的證據） */
  position: number
  customerMessageCount: number
  elapsedMs: number
  /** 這一次冷啟動落定的事件；沒有（例如沒有客戶發言）時為 null */
  event: CitationAuditEvent | null
  error?: string
}

interface ConversationStats {
  conversationId: string
  title: string
  samples: number
  /** 有命中且模型有回卡 —— 杜撰率的分母 */
  withHits: number
  fabricated: number
  rate: number | null
  outcomes: CitationOutcome[]
  /** 杜撰字串的形狀（只記形狀，不記值）：id-like ＝ 像識別碼的字串；hashed ＝ 超長被雜湊；other */
  invalidShapes: Array<'id-like' | 'hashed' | 'other'>
}

/** 分母：有命中且模型有回卡（contracts §5）—— 沒回卡或呼叫失敗時談不上「有沒有杜撰」 */
function countsTowardRate(e: CitationAuditEvent): boolean {
  return e.hitCount > 0 && e.outcome !== 'no-cards' && e.outcome !== 'failed'
}

function shapeOf(id: string): 'id-like' | 'hashed' | 'other' {
  if (id.startsWith('sha256:')) return 'hashed'
  return /^[\w-]{8,}$/.test(id) ? 'id-like' : 'other'
}

/** 輪次間輪換對話順序：第 r 輪從第 (r−1)·⌈n/rounds⌉ 個開始 */
function rotate<T>(items: T[], round: number, rounds: number): T[] {
  if (items.length === 0) return items
  const step = Math.ceil(items.length / rounds)
  const offset = ((round - 1) * step) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

async function measure(client: ImbraceClient, target: Target, round: number, position: number): Promise<Sample> {
  // 第 2 輪起換一個狀態鍵：沿用同一個鍵會讓 FR-005 的檢索備忘生效而跳過檢索（21 號的同一個理由）
  const stateKey = round === 1 ? target.conversationId : `${target.conversationId}#r${round}`
  const history = await fetchLatest(client, target.conversationId)
  const customerMessageCount = history.filter(m => m.sender.type === 'customer').length
  const base = { conversationId: target.conversationId, title: target.title, round, position, customerMessageCount }
  if (customerMessageCount === 0) {
    return { ...base, elapsedMs: 0, event: null, error: '沒有任何客戶發言，分析會維持 empty（FR-009）' }
  }

  const events: CitationAuditEvent[] = []
  const off = onCitationAudit((e) => {
    if (e.conversationId === stateKey) events.push(e)
  })
  const t0 = Date.now()
  try {
    await runColdStart(stateKey, history, false)
    await awaitSuggestionTail(stateKey)
  }
  finally {
    off()
  }
  // 事件裡的 conversationId 是狀態鍵；報表要的是真實對話 id，這裡換回去
  const event = events[events.length - 1] ?? null
  return {
    ...base,
    elapsedMs: Date.now() - t0,
    event: event ? { ...event, conversationId: target.conversationId } : null,
    error: event ? undefined : '冷啟動結束但沒有收到任何稽核事件（三條落定路徑都沒發？）',
  }
}

function parseArgs(argv: string[]): { inspect: boolean, label: string, rounds: number, note: string, inputs: string[] } {
  const consumed = new Set<number>()
  const valueOf = (flag: string, fallback: string): string => {
    const at = argv.indexOf(flag)
    if (at < 0) return fallback
    consumed.add(at + 1)
    return argv[at + 1] ?? fallback
  }
  const label = valueOf('--label', 'unlabeled')
  const rounds = Math.max(1, Number(valueOf('--rounds', String(DEFAULT_ROUNDS))) || DEFAULT_ROUNDS)
  const note = valueOf('--note', '')
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i))
  return { inspect: argv.includes('--inspect'), label, rounds, note, inputs }
}

function citationFallbackInputs(): string[] {
  const raw = env('SPIKE_CITATION_CONVERSATION_IDS')
  if (raw) return [...new Set(raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean))]
  return fallbackInputs()
}

async function main(): Promise<void> {
  loadEnv()
  const { inspect, label, rounds, note, inputs } = parseArgs(process.argv.slice(2))
  const targetInputs = inputs.length > 0 ? inputs : citationFallbackInputs()
  const client = makeClient()

  console.log(`\n── 27 建議卡杜撰引用率（005 FR-017／SC-006）${'─'.repeat(16)}`)
  console.log(`   環境 ${env('IMBRACE_ENV', 'stable')}｜目標 ${targetInputs.length} 段 × ${rounds} 輪 ＝ ${targetInputs.length * rounds} 個樣本｜標籤 ${label}`)
  console.log('   唯讀：只 GET，不 JOIN、不送訊息、不切換 mode。⚠️ 先跑過 npm run spike:agent-prompts 了嗎？')
  if (targetInputs.length !== REQUIRED_CONVERSATIONS || rounds !== DEFAULT_ROUNDS) {
    console.log(`   ⚠️ FR-017 的口徑是固定 ${REQUIRED_CONVERSATIONS} 段 × ${DEFAULT_ROUNDS} 輪；目前的設定**不構成 SC-006 的通過**，只能當探勘。`)
  }
  console.log('')

  const targets = await resolveTargets(client, targetInputs)

  if (inspect) {
    console.log('  目標（尚未呼叫任何 AI）：\n')
    for (const t of targets) console.log(`  • 「${t.title}」 id=${t.conversationId}｜status=${t.status ?? '?'}｜mode=${t.mode ?? 'null'}`)
    console.log('\n  下一步：加上 --label baseline 實際量測。\n')
    return
  }

  const startedAt = new Date().toISOString()
  const samples: Sample[] = []
  let position = 0
  for (let round = 1; round <= rounds; round++) {
    const order = rotate(targets, round, rounds)
    console.log(`  ── 第 ${round} 輪（順序從「${order[0]?.title ?? '—'}」開始）`)
    for (const target of order) {
      position++
      process.stdout.write(`  [${position}/${targets.length * rounds}] 「${target.title}」 … `)
      try {
        const sample = await measure(client, target, round, position)
        samples.push(sample)
        if (sample.error) {
          console.log(`⏭  ${sample.error}`)
          continue
        }
        const e = sample.event!
        console.log(`${e.outcome}｜命中 ${e.hitCount}｜回卡 ${e.cardsReturned}｜留 ${e.cardsKept}`
          + `${e.invalidSopIds.length ? `｜⚠️ 杜撰 ${e.invalidSopIds.length} 個` : ''}｜${sample.elapsedMs}ms`)
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`💥 ${msg}`)
        samples.push({ conversationId: target.conversationId, title: target.title, round, position, customerMessageCount: 0, elapsedMs: 0, event: null, error: msg })
      }
    }
  }
  const endedAt = new Date().toISOString()

  // ── 彙總 ──────────────────────────────────────────────────────
  const events = samples.map(s => s.event).filter((e): e is CitationAuditEvent => e !== null)
  const denominator = events.filter(countsTowardRate)
  const fabricated = denominator.filter(e => e.invalidSopIds.length > 0)

  const byConversation = new Map<string, ConversationStats>()
  for (const s of samples) {
    const stat = byConversation.get(s.conversationId) ?? {
      conversationId: s.conversationId, title: s.title, samples: 0, withHits: 0, fabricated: 0, rate: null, outcomes: [], invalidShapes: [],
    }
    stat.samples++
    if (s.event) {
      stat.outcomes.push(s.event.outcome)
      if (countsTowardRate(s.event)) {
        stat.withHits++
        if (s.event.invalidSopIds.length > 0) stat.fabricated++
        stat.invalidShapes.push(...s.event.invalidSopIds.map(shapeOf))
      }
    }
    stat.rate = stat.withHits > 0 ? stat.fabricated / stat.withHits : null
    byConversation.set(s.conversationId, stat)
  }
  const perConversation = [...byConversation.values()].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))

  const outcomeCounts: Record<string, number> = {}
  for (const e of events) outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] ?? 0) + 1

  const summary = {
    at: endedAt,
    startedAt,
    endedAt,
    label,
    /** FR-020：平台若處於已知降級時段 MUST 標註 —— 由 --note 帶入，空字串代表沒有人標 */
    note,
    env: env('IMBRACE_ENV', 'stable'),
    targets: targets.length,
    rounds,
    sampleCount: samples.length,
    /** 是否符合 FR-017 的口徑（15 × 3、且分母湊滿 45）—— 不符合時**不構成 SC-006 的通過** */
    meetsCriteria: targets.length === REQUIRED_CONVERSATIONS && rounds === DEFAULT_ROUNDS
      && denominator.length === REQUIRED_CONVERSATIONS * DEFAULT_ROUNDS,
    withHits: denominator.length,
    fabricated: fabricated.length,
    fabricationRate: denominator.length > 0 ? fabricated.length / denominator.length : null,
    outcomeCounts,
    perConversation,
    samples,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const payload = JSON.stringify(summary, null, 2)
  const latest = resolve(OUT_DIR, '27-citation-quality.json')
  const stamped = resolve(OUT_DIR, `27-citation-quality-${label}-${endedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(latest, payload, 'utf8')
  writeFileSync(stamped, payload, 'utf8')

  console.log(`\n── 彙總（${label}）${'─'.repeat(40)}`)
  console.log(`  時段：${startedAt} → ${endedAt}${note ? `｜備註：${note}` : ''}`)
  console.log(`  杜撰率：${fabricated.length}/${denominator.length} `
    + `= ${summary.fabricationRate === null ? '—' : `${(summary.fabricationRate * 100).toFixed(0)}%`}`
    + `（分母＝有命中且模型有回卡；outcome 分布：${Object.entries(outcomeCounts).map(([k, v]) => `${k} ${v}`).join('、') || '—'}）`)
  console.log(`  口徑：${summary.meetsCriteria ? '✅ 符合 FR-017（15 × 3，分母 45）' : `⚠️ 不符合 FR-017（目標 ${targets.length}、輪 ${rounds}、分母 ${denominator.length}）—— 不構成 SC-006 的通過`}`)
  console.log('  逐對話分布（由高到低）：')
  for (const c of perConversation) {
    console.log(`     ${c.rate === null ? '  —' : `${(c.rate * 100).toFixed(0).padStart(3)}%`} `
      + `${c.fabricated}/${c.withHits} 「${c.title}」 outcome=[${c.outcomes.join(',')}]`
      + `${c.invalidShapes.length ? ` 形狀=[${c.invalidShapes.join(',')}]` : ''}`)
  }
  console.log(`\n  📁 ${latest.replace(ROOT, '.')}（同時留存 ${stamped.replace(ROOT, '.')}）\n`)
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
