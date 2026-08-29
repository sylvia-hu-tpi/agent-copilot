/**
 * 21 — 建議卡兩段式的端到端量測（004 T032：SC-001／SC-002 的驗收證據）
 *
 * 量什麼：對真實對話跑**生產路徑**的冷啟動分析，記錄
 *   - 第一段落地（`citation: 'pending'`）的毫秒數 → 004 SC-001（p90 ≤ 20 秒）
 *   - 第二段落定（`'cited'`／`'none'`）的毫秒數 → 契約 §2 的 50 秒上限
 *   - 多段對話中最終取得 `'cited'` 的比例 → 004 SC-002（知識庫有內容時 ≥ 90%）
 *
 * ⚠️ **走生產路徑的 `runColdStart()`，不自行組裝兩段流程**（比照 18／20 號的同一個理由）：
 *    世代、尾巴、白名單、`confidence` 歸零、FR-005 的檢索備忘都與正式路徑同一份程式碼，
 *    自行重組只會量到另一件事。連帶代價是每段對話也會跑摘要與情緒（各自的 AI 呼叫）——
 *    那正是真實 JOIN 的成本，刻意不省。
 *
 * ⚠️ **輸出不含任何訊息或卡片文字**（憲法 1.5）：只有毫秒數、命中數、卡片張數與狀態。
 *
 * ── 三種模式 ────────────────────────────────────────────────────
 *
 *   npm run spike:progressive -- --inspect "標題A" "標題B"
 *       **完全唯讀、不呼叫任何 AI**。把標題解析成對話 id，印出現況（status／mode／訊息數）
 *       與「`--join` 會做什麼」。動任何寫入之前**先跑這個**。
 *
 *   npm run spike:progressive -- "標題A" "標題B"
 *       唯讀量測：只 GET 對話與訊息，在本機記憶體跑分析。**不 JOIN、不寫入正式環境。**
 *       起點是「分析啟動」而非「客服按下 JOIN」，兩者差一次讀訊息的往返（另記 `fetchMs`）。
 *
 *   npm run spike:progressive -- --join "標題A" "標題B"
 *       ⚠️ **會對正式環境寫入**：走 T032 要求的真 JOIN 流程 —— 真的 JOIN、量測它觸發的
 *       冷啟動、再 LEAVE。起點就是 JOIN 送出的那一刻，與 SC-001 的定義完全對齊。
 *
 * ⚠️⚠️ **`--join` 的不可逆副作用，動手前必須知道**（§10.2）：
 *    `mode` 是**對話層級的共用狀態**，不是本地偏好。JOIN 會 `null → manual`，
 *    LEAVE 會 `manual → automation` —— 也就是說**跑完之後對話停在 `automation`，
 *    不保證回到原本的值**。原本是 `null` 的對話會就此變成「AI 可自動回覆」。
 *    因此本腳本：
 *      ① `mode ∈ {manual, hybrid}` 的對話**一律拒絕**——那代表有人正在處理它（§10.2 ③），
 *         JOIN 進去等於介入同事的現場；
 *      ② 每一段都印出 JOIN 前後的 `mode`，讓變動有紀錄可查；
 *      ③ 無論成功失敗都在 `finally` 裡 LEAVE。
 *
 * 目標對話可以給**標題**（會用 `conversations.search()` 解析，需唯一命中）或直接給 id；
 * 都不給時退回 `.env.local` 的 `SPIKE_CONVERSATION_IDS`（逗號分隔）／`SPIKE_CONVERSATION_ID`。
 */

import type { ImbraceClient, Conversation as SdkConversation } from '@imbrace/sdk'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { businessUnitId, env, isMain, loadEnv, makeClient, OUT_DIR, ROOT, SkipProbe } from './lib/harness.js'
import { normalizeConversationId, toConversation, unwrapPaged } from '../../server/sources/mappers.js'
import { fetchLatest } from '../../server/sources/message-fetch.js'
import { getConversationDetail, joinConversation, leaveConversation } from '../../server/services/imbrace.js'
import { awaitSuggestionTail, runColdStart } from '../../server/services/copilot-analysis.js'
import { useEventBus, useStateStore } from '../../server/state/index.js'
import { conversationTopic } from '../../server/state/types.js'
import { controlFromMode } from '../../shared/types/conversation.js'
import type { ConversationMode } from '../../shared/types/conversation.js'
import type { CopilotEvent } from '../../shared/types/events.js'

/** 004 SC-001：第一批卡 90% 在 20 秒內（002 SC-001 的建議卡門檻，2026-08-29 由 10 秒修訂） */
const SC001_BUDGET_MS = 20_000
/** 契約 §2 的第二段上限：30 秒檢索 ＋ 20 秒生成 */
const STAGE2_BUDGET_MS = 50_000
/** 004 SC-002：知識庫有內容時 ≥ 90% 最終取得引用 */
const SC002_CITED_RATIO = 0.9

/** JOIN 的模式：與官方介面、與我方 `join.post.ts` 的預設一致（§10.5） */
const JOIN_MODE = 'manual' as const

interface Target {
  /** 使用者給的原始字串（標題或 id），用於報告 */
  input: string
  conversationId: string
  title: string
  status?: string
  mode: ConversationMode | null
  teamConversationId?: string
}

interface Sample {
  conversationId: string
  title: string
  /** 'join' = 真的 JOIN 過；'readonly' = 只讀不寫 */
  method: 'join' | 'readonly'
  modeBefore: ConversationMode | null
  modeAfter?: ConversationMode | null
  /** 讀取訊息的往返時間。唯讀模式下 SC-001 若要從 JOIN 起算，把它加上去 */
  fetchMs: number
  messageCount: number
  customerMessageCount: number
  /** 第一段落地（`citation: 'pending'`）距起點的毫秒數；沒有 pending 時為 null */
  pendingMs: number | null
  /** 第二段落定（cited／none）的毫秒數 */
  settledMs: number | null
  finalCitation: 'pending' | 'cited' | 'none' | null
  finalStatus: string | null
  hitCount: number | null
  cardCount: number | null
  provenance: { stage: 1 | 2, stage1RetryAttempt: number } | null
  /** `status/citation` 的完整序列 —— 契約 §2 的那張表就是照這個形狀寫的 */
  sequence: string[]
  error?: string
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

function looksLikeConversationId(s: string): boolean {
  return /^conv_/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// ── 目標解析（標題 → id）────────────────────────────────────────

/**
 * 用標題找對話。⚠️ 必須**唯一命中**才接受 —— 標題重複時猜錯的代價是對錯誤的對話 JOIN，
 * 那是對真實客戶對話的寫入，不可以靠運氣。
 */
async function resolveByTitle(client: ImbraceClient, buId: string, title: string): Promise<Target> {
  const res = await client.conversations.search({ businessUnitId: buId, q: title, limit: 50, skip: 0 })
  const items = unwrapPaged<SdkConversation>(res).map(toConversation)
  const exact = items.filter(c => c.name === title)
  const partial = items.filter(c => (c.name ?? '').includes(title))
  const hits = exact.length > 0 ? exact : partial

  if (hits.length === 0) throw new SkipProbe(`找不到標題含「${title}」的對話`)
  if (hits.length > 1) {
    const list = hits.slice(0, 5).map(c => `「${c.name}」(${c.id})`).join('、')
    throw new SkipProbe(`標題「${title}」命中 ${hits.length} 段，無法判斷是哪一段：${list}`)
  }

  const c = hits[0]!
  return { input: title, conversationId: c.id, title: c.name ?? '(無標題)', status: c.status, mode: c.mode ?? null }
}

/** 補上詳情才有的欄位（`tcu_` id 與最新的 mode）—— JOIN／LEAVE 一定要 `tcu_` id（§10.6 ①） */
async function enrich(client: ImbraceClient, target: Target): Promise<Target> {
  const raw = await getConversationDetail(client, target.conversationId)
  if (!raw) return target
  const conv = toConversation(raw as unknown as Parameters<typeof toConversation>[0])
  // ⚠️ 與 `loadConversationContext()` 同一段推導：詳情的 id 是 tcu_，而 mapper 只在
  //    `raw.id` 以 tcu_ 開頭時才填 —— 這裡不另立第二套推導邏輯。
  let tcu = conv.teamConversationId
  if (!tcu) {
    const fallback = (raw as { _id?: unknown, id?: unknown })._id ?? (raw as { id?: unknown }).id
    if (typeof fallback === 'string' && fallback.startsWith('tcu_')) tcu = fallback
  }
  return {
    ...target,
    title: conv.name ?? target.title,
    status: conv.status ?? target.status,
    mode: conv.mode ?? target.mode,
    teamConversationId: tcu,
  }
}

async function resolveTargets(client: ImbraceClient, inputs: string[]): Promise<Target[]> {
  const buId = await businessUnitId(client)
  const out: Target[] = []
  for (const input of inputs) {
    const base = looksLikeConversationId(input)
      ? { input, conversationId: normalizeConversationId(input), title: '(待查)', mode: null as ConversationMode | null }
      : await resolveByTitle(client, buId, input)
    out.push(await enrich(client, base))
  }
  return out
}

// ── 量測 ────────────────────────────────────────────────────────

/** 訂閱事件匯流排，把 `suggestion.updated` 的時序記下來 */
function watchSuggestions(conversationId: string, startedAt: () => number) {
  const sequence: string[] = []
  let pendingMs: number | null = null
  let settledMs: number | null = null

  const off = useEventBus().subscribe(conversationTopic(conversationId), (payload) => {
    const evt = payload as CopilotEvent
    if (evt.type !== 'suggestion.updated') return
    const block = evt.suggestion
    sequence.push(`${block.status}/${block.citation}`)
    if (block.status !== 'ready') return
    if (block.citation === 'pending' && pendingMs === null) pendingMs = Date.now() - startedAt()
    if (block.citation !== 'pending' && settledMs === null) settledMs = Date.now() - startedAt()
  })

  return { off, sequence, read: () => ({ pendingMs, settledMs }) }
}

async function finishSample(
  conversationId: string,
  base: Omit<Sample, 'pendingMs' | 'settledMs' | 'finalCitation' | 'finalStatus' | 'hitCount' | 'cardCount' | 'provenance' | 'sequence'>,
  watcher: ReturnType<typeof watchSuggestions>,
): Promise<Sample> {
  const { pendingMs, settledMs } = watcher.read()
  const block = (await useStateStore().getAnalysisState(conversationId))?.suggestionBlock ?? null
  return {
    ...base,
    pendingMs,
    settledMs,
    finalCitation: block?.citation ?? null,
    finalStatus: block?.status ?? null,
    hitCount: block?.knowledgeSearch.hitCount ?? null,
    cardCount: block?.cards.length ?? null,
    provenance: block?.provenance ?? null,
    sequence: watcher.sequence,
  }
}

/** 唯讀：只 GET，不 JOIN。起點是「分析啟動」 */
async function measureReadOnly(client: ImbraceClient, target: Target): Promise<Sample> {
  const fetchStart = Date.now()
  const history = await fetchLatest(client, target.conversationId)
  const fetchMs = Date.now() - fetchStart

  const customerCount = history.filter(m => m.sender.type === 'customer').length
  const base = {
    conversationId: target.conversationId,
    title: target.title,
    method: 'readonly' as const,
    modeBefore: target.mode,
    fetchMs,
    messageCount: history.length,
    customerMessageCount: customerCount,
  }
  if (customerCount === 0) {
    return { ...base, pendingMs: null, settledMs: null, finalCitation: null, finalStatus: null, hitCount: null, cardCount: null, provenance: null, sequence: [], error: '沒有任何客戶發言，分析會維持 empty（FR-009）' }
  }

  let startedAt = Date.now()
  const watcher = watchSuggestions(target.conversationId, () => startedAt)
  try {
    startedAt = Date.now()
    await runColdStart(target.conversationId, history, false)
    await awaitSuggestionTail(target.conversationId)
  }
  finally {
    watcher.off()
  }
  return finishSample(target.conversationId, base, watcher)
}

/**
 * T032 的嚴格路徑：**真的 JOIN**，量它觸發的冷啟動，再 LEAVE。
 *
 * ⚠️ 這裡刻意重現 `server/api/conversations/[id]/join.post.ts` 的 `triggerColdStartIfNeeded()`
 *    ——`fetchLatest()` → `runColdStart()`，`aiReplies` 一律由 `controlFromMode()` 推導
 *    （002 FR-016 的地雷，兩段都要帶）。差別只在少了 HTTP 與 presence 那幾層，
 *    它們不參與本腳本要量的兩段時序。
 */
async function measureWithJoin(client: ImbraceClient, target: Target): Promise<Sample> {
  const base = {
    conversationId: target.conversationId,
    title: target.title,
    method: 'join' as const,
    modeBefore: target.mode,
    fetchMs: 0,
    messageCount: 0,
    customerMessageCount: 0,
  }
  const empty = { pendingMs: null, settledMs: null, finalCitation: null, finalStatus: null, hitCount: null, cardCount: null, provenance: null, sequence: [] }

  if (!target.teamConversationId) {
    return { ...base, ...empty, error: '詳情裡沒有 tcu_ id，JOIN／LEAVE 都做不了（§10.6 ①）' }
  }
  // ⚠️ 護欄①：mode 為 manual／hybrid 代表「有人能送出訊息」＝有人正在處理（§10.2 ③）。
  //    JOIN 進去是介入同事的現場，一律拒絕。
  if (target.mode === 'manual' || target.mode === 'hybrid') {
    return { ...base, ...empty, error: `mode 為 ${target.mode} —— 代表有人正在處理這段對話，拒絕 JOIN（§10.2）` }
  }

  let startedAt = Date.now()
  const watcher = watchSuggestions(target.conversationId, () => startedAt)
  let joined = false

  try {
    // ⚠️ 起點就是 JOIN 送出的那一刻 —— SC-001 的「JOIN 後 20 秒」就是從這裡算起
    startedAt = Date.now()
    await joinConversation(client, target.teamConversationId, JOIN_MODE)
    joined = true

    const fetchStart = Date.now()
    const history = await fetchLatest(client, target.conversationId)
    base.fetchMs = Date.now() - fetchStart
    base.messageCount = history.length
    base.customerMessageCount = history.filter(m => m.sender.type === 'customer').length

    if (base.customerMessageCount === 0) {
      return { ...base, ...empty, error: '沒有任何客戶發言，分析會維持 empty（FR-009）' }
    }

    await runColdStart(target.conversationId, history, controlFromMode(JOIN_MODE).aiReplies)
    await awaitSuggestionTail(target.conversationId)
  }
  finally {
    watcher.off()
    if (joined) {
      // ⚠️ 無論成功失敗都要離開。LEAVE 會把 mode 帶到 `automation`，**不保證回到原值**
      try {
        await leaveConversation(client, target.teamConversationId)
      }
      catch (err) {
        console.log(`     ⚠️ LEAVE 失敗，這段對話可能仍停在 ${JOIN_MODE}，請手動確認：`
          + (err instanceof Error ? err.message : String(err)))
      }
    }
  }

  const sample = await finishSample(target.conversationId, base, watcher)
  const after = await enrich(client, target).catch(() => target)
  return { ...sample, modeAfter: after.mode }
}

// ── 主流程 ──────────────────────────────────────────────────────

function parseArgs(argv: string[]): { mode: 'inspect' | 'readonly' | 'join', inputs: string[] } {
  const flags = argv.filter(a => a.startsWith('--'))
  const inputs = argv.filter(a => !a.startsWith('--'))
  const mode = flags.includes('--join') ? 'join' : flags.includes('--inspect') ? 'inspect' : 'readonly'
  return { mode, inputs }
}

function fallbackInputs(): string[] {
  const raw = env('SPIKE_CONVERSATION_IDS') || env('SPIKE_CONVERSATION_ID')
  if (!raw) {
    throw new SkipProbe(
      '請以參數給對話標題或 id（例：npm run spike:progressive -- --inspect "標題A" "標題B"），'
      + '或在 .env.local 設定 SPIKE_CONVERSATION_IDS（逗號分隔，SC-002 的比例建議 10 段）',
    )
  }
  return [...new Set(raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean))]
}

async function main(): Promise<void> {
  loadEnv()
  const { mode, inputs } = parseArgs(process.argv.slice(2))
  const targetInputs = inputs.length > 0 ? inputs : fallbackInputs()
  const client = makeClient()

  console.log(`\n── 21 建議卡兩段式端到端量測（004 T032）${'─'.repeat(20)}`)
  console.log(`   環境 ${env('IMBRACE_ENV', 'stable')}｜目標 ${targetInputs.length} 段｜模式 ${mode}`)
  console.log(mode === 'join'
    ? '   ⚠️ **會對正式環境寫入**：真的 JOIN → 量測 → LEAVE。LEAVE 後 mode 會停在 automation，不保證回到原值。'
    : '   唯讀：只 GET，不 JOIN、不送訊息、不切換 mode。')
  console.log('')

  const targets = await resolveTargets(client, targetInputs)

  // ── --inspect：完全唯讀，一次 AI 都不呼叫 ────────────────────
  if (mode === 'inspect') {
    console.log('  現況（尚未做任何事）：\n')
    for (const t of targets) {
      const blocked = t.mode === 'manual' || t.mode === 'hybrid'
      const noTcu = !t.teamConversationId
      console.log(`  ${blocked || noTcu ? '⛔' : '✅'} 「${t.title}」`)
      console.log(`     id=${t.conversationId}`)
      console.log(`     status=${t.status ?? '?'}｜mode=${t.mode ?? 'null'}｜tcu=${t.teamConversationId ? '有' : '**無**'}`)
      if (blocked) console.log('     ⛔ mode 顯示有人正在處理這段對話，--join 會拒絕它（§10.2）')
      if (noTcu) console.log('     ⛔ 沒有 tcu_ id，JOIN／LEAVE 做不了（§10.6 ①）')
      if (!blocked && !noTcu) console.log(`     --join 會做：JOIN(mode=${JOIN_MODE}) → 冷啟動分析 → LEAVE（結束後 mode 會是 automation）`)
      console.log('')
    }
    console.log('  下一步：確認無誤後加上 --join 實際執行，或不加旗標跑唯讀量測。\n')
    return
  }

  const samples: Sample[] = []
  for (const [i, target] of targets.entries()) {
    process.stdout.write(`  [${i + 1}/${targets.length}] 「${target.title}」 … `)
    try {
      const sample = mode === 'join'
        ? await measureWithJoin(client, target)
        : await measureReadOnly(client, target)
      samples.push(sample)
      if (sample.error) {
        console.log(`⏭  ${sample.error}`)
      }
      else {
        console.log(
          `${sample.finalCitation === 'cited' ? '✅ cited' : `🟡 ${sample.finalCitation}`}`
          + `｜第一段 ${sample.pendingMs ?? '—'}ms｜落定 ${sample.settledMs ?? '—'}ms`
          + `｜命中 ${sample.hitCount}｜卡 ${sample.cardCount} 張`
          + (sample.modeAfter !== undefined ? `｜mode ${sample.modeBefore ?? 'null'} → ${sample.modeAfter ?? 'null'}` : '')
          + `\n        序列：${sample.sequence.join(' → ')}`,
        )
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`💥 ${msg}`)
      samples.push({
        conversationId: target.conversationId,
        title: target.title,
        method: mode === 'join' ? 'join' : 'readonly',
        modeBefore: target.mode,
        fetchMs: 0,
        messageCount: 0,
        customerMessageCount: 0,
        pendingMs: null,
        settledMs: null,
        finalCitation: null,
        finalStatus: null,
        hitCount: null,
        cardCount: null,
        provenance: null,
        sequence: [],
        error: msg,
      })
    }
  }

  // ── 彙總 ────────────────────────────────────────────────────
  const usable = samples.filter(s => !s.error)
  const pendings = usable.map(s => s.pendingMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const settles = usable.map(s => s.settledMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  // ⚠️ SC-002 的分母只算「知識庫真的有命中」的那些：0 命中時落成 'none' 是正確行為，
  //    把它算進分母等於在量知識庫的涵蓋率，不是在量本規格。
  const withHits = usable.filter(s => (s.hitCount ?? 0) > 0)
  const cited = withHits.filter(s => s.finalCitation === 'cited')

  const summary = {
    at: new Date().toISOString(),
    env: env('IMBRACE_ENV', 'stable'),
    method: mode,
    conversations: samples.length,
    usable: usable.length,
    stage1: {
      n: pendings.length,
      medianMs: percentile(pendings, 0.5),
      p90Ms: percentile(pendings, 0.9),
      maxMs: pendings[pendings.length - 1] ?? 0,
      withinBudget: pendings.filter(v => v <= SC001_BUDGET_MS).length,
      budgetMs: SC001_BUDGET_MS,
      pass: pendings.length > 0 && percentile(pendings, 0.9) <= SC001_BUDGET_MS,
    },
    stage2: {
      n: settles.length,
      medianMs: percentile(settles, 0.5),
      p90Ms: percentile(settles, 0.9),
      maxMs: settles[settles.length - 1] ?? 0,
      budgetMs: STAGE2_BUDGET_MS,
      pass: settles.length > 0 && (settles[settles.length - 1] ?? 0) <= STAGE2_BUDGET_MS,
    },
    sc002: {
      withHits: withHits.length,
      cited: cited.length,
      ratio: withHits.length > 0 ? cited.length / withHits.length : null,
      threshold: SC002_CITED_RATIO,
      pass: withHits.length > 0 && cited.length / withHits.length >= SC002_CITED_RATIO,
    },
    samples,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const jsonFile = resolve(OUT_DIR, '21-progressive-citations.json')
  writeFileSync(jsonFile, JSON.stringify(summary, null, 2), 'utf8')

  console.log(`\n── 彙總 ${'─'.repeat(45)}`)
  console.log(`  第一段（SC-001，p90 ≤ ${SC001_BUDGET_MS / 1000} 秒）：`
    + `n=${summary.stage1.n} 中位 ${summary.stage1.medianMs}ms p90 ${summary.stage1.p90Ms}ms 最慢 ${summary.stage1.maxMs}ms`
    + ` → ${summary.stage1.pass ? '✅ 通過' : '❌ 未達'}`)
  console.log(`  第二段落定（契約 §2，≤ ${STAGE2_BUDGET_MS / 1000} 秒）：`
    + `n=${summary.stage2.n} 中位 ${summary.stage2.medianMs}ms p90 ${summary.stage2.p90Ms}ms 最慢 ${summary.stage2.maxMs}ms`
    + ` → ${summary.stage2.pass ? '✅ 通過' : '❌ 未達'}`)
  console.log(`  引用比例（SC-002，≥ ${SC002_CITED_RATIO * 100}%）：`
    + `${summary.sc002.cited}/${summary.sc002.withHits} 段有命中的對話取得 cited`
    + ` → ${summary.sc002.pass ? '✅ 通過' : summary.sc002.withHits === 0 ? '❓ 無有效樣本（沒有任何一段命中知識庫）' : '❌ 未達'}`)
  console.log(`\n  📁 ${jsonFile.replace(ROOT, '.')}`)

  if (mode === 'join') {
    const changed = samples.filter(s => s.modeAfter !== undefined && s.modeAfter !== s.modeBefore)
    if (changed.length > 0) {
      console.log(`\n  ⚠️ 下列對話的 mode 已改變（JOIN → LEAVE 的必然結果，見檔頭警告）：`)
      for (const s of changed) console.log(`     「${s.title}」 ${s.modeBefore ?? 'null'} → ${s.modeAfter ?? 'null'}`)
    }
  }

  if (!summary.sc002.pass && summary.sc002.withHits > 0) {
    console.log('\n  ⚠️ SC-002 未達且有有效樣本 —— 依 tasks.md T032，若失敗原因是第二段 20 秒逾時，'
      + '回到 T011 重議 SUGGESTION_STAGE2_CALL_TIMEOUT_MS。'
      + '判讀方式：看 samples 裡 hitCount > 0 卻落成 none 的那幾筆的 settledMs 是否貼著 30+20 秒。')
  }
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
