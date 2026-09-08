/**
 * 25 — 五個 iMBrace agent 的 system prompt 快照與漂移偵測。
 *
 * ⚠️ **這支不是 probe，是守門員。** 其他 spike 問的是「平台會怎樣」，這支問的是
 *    「後台的設定被人改了嗎」——它沒有 findings，只有「一致」或「不一致」。
 *
 * ── 為什麼需要它 ──────────────────────────────────────────────
 * 每個 agent 的 `personality_role`／`core_task`／`model_id` 都在 iMBrace 後台，
 * **不在版本控制裡**。被改掉不會有任何 commit 看得出來，也不會有型別錯誤，
 * 只會安靜地改變摘要的形狀、情緒的刻度、建議卡的引用規則。
 *
 * 2026-09-02 的實例說明代價：情緒 24-B 的批次偏離由 3.6 分升到 11.7 分，
 * 當下無從判斷是「後台 prompt 被改壞」還是「模型本來就這樣」，於是花了三分鐘重跑
 * spike 24，還把一段錯誤的推測寫進了正典文件。真正需要的其實是 `git diff` ——
 * 而那需要先有一份可 diff 的東西。這支就是在建立那份東西。
 *
 * ── 單向流程，MUST NOT 反過來 ──────────────────────────────────
 * 後台是唯一能寫入的地方，`docs/AGENT_PROMPTS.md` 只是它的快照：
 *
 *     改後台 → npm run spike:agent-prompts -- --write → git commit（寫清楚為什麼改）
 *
 * ⚠️ 改那份 md **不會**改變任何 agent 的行為。把它當成設定檔去編輯，就是本專案
 *    最貴的那類 bug：看起來改了，實際上什麼都沒發生。
 *
 * ── 比對方式 ─────────────────────────────────────────────────
 * 刻意**不解析**既有檔案，而是把線上的值重新 render 成完整檔案，再與磁碟上的字串
 * 逐字元比對。少一個 parser 就少一個「格式沒對上而誤報／漏報」的來源。
 *
 * 跑法：
 *   npm run spike:agent-prompts             # 比對，不一致則印出差異並以 1 離開
 *   npm run spike:agent-prompts -- --write  # 以線上現況更新快照
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnv, env, requireEnv, ROOT } from './lib/harness.js'
import { clientForApiKey } from '../../server/services/imbrace.js'

const SNAPSHOT = resolve(ROOT, 'docs/AGENT_PROMPTS.md')

/**
 * agent 的固定順序 —— 順序寫死是為了讓 render 結果穩定，
 * 否則平台清單順序一變，整份檔案就會出現與內容無關的假 diff。
 *
 * ⚠️ **新增 agent 時 MUST 加進這份清單。** 漏加不會有任何錯誤 ——
 *    那個 agent 的 prompt 會變成唯一一個沒有快照保護的，被改掉時只能靠
 *    量測數字反推（`CLAUDE.md` 第四顆地雷記錄過那次的代價：三分鐘重跑 spike，
 *    還把錯誤推測寫進了正典文件）。
 */
const AGENTS = [
  { key: 'summary', envKey: 'IMBRACE_SUMMARY_AGENT_ID', use: '對話摘要（`summarize()`）' },
  { key: 'sentiment', envKey: 'IMBRACE_SENTIMENT_AGENT_ID', use: '情緒評分與走勢摘要（`analyzeSentiment()`／`narrateSentiment()`，兩者共用同一個 agent）' },
  { key: 'suggestion', envKey: 'IMBRACE_SUGGESTION_AGENT_ID', use: '建議回覆卡（`suggest()`）' },
  { key: 'knowledge', envKey: 'IMBRACE_KNOWLEDGE_AGENT_ID', use: '知識庫檢索（`AgentKnowledgeProvider`）' },
  { key: 'closure', envKey: 'IMBRACE_CLOSURE_AGENT_ID', use: '結案摘要（`summarizeClosure()`，specs/006-closure-handoff-summary）' },
] as const

interface AgentSnapshot {
  key: string
  envKey: string
  use: string
  name: string
  modelId: string
  personality: string
  coreTask: string
}

/**
 * 圍欄用五個反引號 —— prompt 本身可能含 ``` 或 ````（例如示範 JSON 區塊）。
 * render 前會斷言內容不含這個圍欄，含了就直接失敗，而不是產出一份壞掉的檔案。
 */
const FENCE = '`````'

function render(snaps: AgentSnapshot[]): string {
  const lines: string[] = [
    '# Agent system prompt 快照',
    '',
    '> ⚠️ **本檔是生成物，不是設定檔 —— 改它不會改變任何 agent 的行為。**',
    `> ${snaps.length} 個 agent 的真正設定在 iMBrace 後台，那裡才是唯一能寫入的地方。`,
    '> 這份快照存在的唯一理由是：後台的改動不會產生任何 commit，',
    '> 有了它才能用 `git diff` 看出「prompt 被動過」與「模型本來就這樣」的差別。',
    '>',
    '> 單向流程：**改後台 → `npm run spike:agent-prompts -- --write` → commit（寫清楚為什麼改）**。',
    '> 比對用 `npm run spike:agent-prompts`，不一致會以非零離開並印出差異。',
    '>',
    '> `instructions`（後台實際送給模型的完整 system prompt）= 固定外框 + Personality + Core Task，',
    '> 因此這裡只存後兩者 —— 外框由平台產生，不是我們能控制的內容。',
    '',
  ]

  for (const s of snaps) {
    lines.push(
      `## ${s.key} — \`${s.name}\``,
      '',
      `- 用途：${s.use}`,
      `- 環境變數：\`${s.envKey}\``,
      `- \`model_id\`：\`${s.modelId}\``,
      '',
      '### Personality',
      '',
      FENCE + 'text',
      s.personality,
      FENCE,
      '',
      '### Core Task',
      '',
      FENCE + 'text',
      s.coreTask,
      FENCE,
      '',
    )
  }

  return lines.join('\n')
}

/** 只在「已知不一致」時用來指出差在哪 —— 判定一致與否靠的是整份字串相等 */
function reportDiff(expected: string, actual: string): void {
  const e = expected.split('\n')
  const a = actual.split('\n')

  let head = 0
  while (head < e.length && head < a.length && e[head] === a[head]) head++

  let tail = 0
  while (
    tail < e.length - head && tail < a.length - head
    && e[e.length - 1 - tail] === a[a.length - 1 - tail]
  ) tail++

  const eMid = e.slice(head, e.length - tail)
  const aMid = a.slice(head, a.length - tail)
  const MAX = 40

  console.log(`\n  差異從第 ${head + 1} 行開始：\n`)
  aMid.slice(0, MAX).forEach(l => console.log(`  - ${l}`))
  if (aMid.length > MAX) console.log(`  - …（還有 ${aMid.length - MAX} 行）`)
  console.log()
  eMid.slice(0, MAX).forEach(l => console.log(`  + ${l}`))
  if (eMid.length > MAX) console.log(`  + …（還有 ${eMid.length - MAX} 行）`)
  console.log('\n  （`-` 是磁碟上的快照，`+` 是線上現況）')
}

async function main(): Promise<void> {
  loadEnv()
  const write = process.argv.includes('--write')

  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: 'stable',
  })

  const raw = await client.chatAi.listAiAgents() as unknown as Array<Record<string, unknown>>
  const snaps: AgentSnapshot[] = []

  for (const a of AGENTS) {
    const id = env(a.envKey)
    if (!id) {
      console.error(`💥 缺少 ${a.envKey}（見 .env.local）—— 少一個 agent 的快照就是少一塊守備範圍，不做部分比對`)
      process.exit(1)
    }
    const hit = raw.find(x => String(x.id ?? '') === id)
    if (!hit) {
      console.error(`💥 後台找不到 ${a.envKey} 指向的 agent（id=${id}）—— 它可能已被刪除或改了組織`)
      process.exit(1)
    }
    snaps.push({
      key: a.key,
      envKey: a.envKey,
      use: a.use,
      name: String(hit.name ?? ''),
      modelId: String(hit.model_id ?? ''),
      personality: String(hit.personality_role ?? '').trimEnd(),
      coreTask: String(hit.core_task ?? '').trimEnd(),
    })
  }

  for (const s of snaps) {
    if (s.personality.includes(FENCE) || s.coreTask.includes(FENCE)) {
      console.error(`💥 ${s.key} 的 prompt 含有 ${FENCE.length} 個反引號，會破壞快照格式 —— 請改用更長的圍欄`)
      process.exit(1)
    }
  }

  const expected = render(snaps)

  if (write) {
    writeFileSync(SNAPSHOT, expected, 'utf8')
    console.log(`✅ 已更新快照：docs/AGENT_PROMPTS.md（${snaps.length} 個 agent）`)
    snaps.forEach(s => console.log(`   • ${s.key} — ${s.name}（${s.modelId}）`))
    console.log(`\n⚠️ 記得 commit，並在 message 裡寫清楚後台改了什麼、為什麼改。`)
    return
  }

  if (!existsSync(SNAPSHOT)) {
    console.error('💥 快照不存在 —— 先跑 npm run spike:agent-prompts -- --write')
    process.exit(1)
  }

  const actual = readFileSync(SNAPSHOT, 'utf8')
  if (actual === expected) {
    console.log(`✅ ${snaps.length} 個 agent 的 system prompt 與 model 都與快照一致`)
    snaps.forEach(s => console.log(`   • ${s.key} — ${s.name}（${s.modelId}）`))
    return
  }

  console.error('❌ 後台設定與快照不一致 —— 有人改過 prompt 或換過模型')
  reportDiff(expected, actual)
  console.error('\n  確認改動是預期的之後，跑 npm run spike:agent-prompts -- --write 更新快照並 commit。')
  process.exit(1)
}

main().catch((err) => { console.error('\n💥', err); process.exit(1) })
