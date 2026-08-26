/**
 * 12 — Presence 與變更偵測的即時觀測（互動式）
 *
 * 一次回答兩個 M1 開工前必須確定的問題：
 *
 *  ① §10.2：除了「自家 SSE 上報」，平台端還有沒有可靠的 presence 來源？
 *     候選：conversations.get() 的 is_joined / is_agent_joined / is_presence / users[]
 *     —— 需要有人實際在官方介面 JOIN / LEAVE 才驗得出來。
 *
 *  ② §9.3：對話清單的 last_message_at / updated_at 會不會在新訊息進來時即時更新？
 *     若會，輪詢可改成「一次清單輪詢 → 只對變動的對話抓訊息」，
 *     成本量級與現行「每個活躍對話各自輪詢」完全不同。
 *
 * 用法：
 *   npm run spike:presence              # 觀測 SPIKE_CONVERSATION_ID，預設 180 秒
 *   npm run spike:presence -- <convId> <秒數>
 *
 * 觀測期間請在 iMBrace 官方介面對該對話依序操作，每步之間停 10 秒：
 *   JOIN → 送一則訊息 → LEAVE
 */

import { makeClient, loadEnv, env, businessUnitId, OUT_DIR } from './lib/harness.js'
import { rawList } from '../../server/sources/message-fetch.js'
import { normalizeConversationId, unwrapPaged } from '../../server/sources/mappers.js'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const POLL_MS = 2000

/** 一次快照裡我們關心的欄位。刻意不存訊息內容（憲法 1.5） */
interface Snapshot {
  at: string
  /** conversations.get() */
  isJoined?: boolean
  isAgentJoined?: boolean
  isPresence?: boolean
  mode?: string
  status?: string
  userCount?: number
  userIds?: string[]
  getUpdatedAt?: string
  /** conversations.search() 的清單 payload */
  listLastMessageAt?: string
  listUpdatedAt?: string
  listIsAgentJoined?: boolean
  /** 訊息端點 */
  newestMessageId?: string
  newestMessageAt?: string
}

type Raw = Record<string, unknown>

function pick(o: Raw | undefined, k: string): unknown {
  return o?.[k]
}

async function snapshot(
  client: ReturnType<typeof makeClient>,
  buId: string,
  bare: string,
): Promise<Snapshot> {
  const snap: Snapshot = { at: new Date().toISOString() }

  // ① 詳情（users[] 與三個布林只有這裡才有）
  try {
    const got = await client.conversations.get(bare) as unknown as Raw
    snap.isJoined = pick(got, 'is_joined') as boolean | undefined
    snap.isAgentJoined = pick(got, 'is_agent_joined') as boolean | undefined
    snap.isPresence = pick(got, 'is_presence') as boolean | undefined
    snap.mode = pick(got, 'mode') as string | undefined
    snap.status = pick(got, 'status') as string | undefined
    snap.getUpdatedAt = pick(got, 'updated_at') as string | undefined
    const users = (pick(got, 'users') ?? []) as Array<Raw>
    snap.userCount = users.length
    snap.userIds = users.map(u => String(u.id)).sort()
  }
  catch { /* 保持 undefined，時間軸上會看得出來 */ }

  // ② 清單 payload（§9.3 的關鍵：能不能只靠一次清單輪詢就知道誰變了）
  try {
    const res = await client.conversations.search({ businessUnitId: buId, q: '', limit: 100 })
    const hit = unwrapPaged<Raw>(res).find(c => normalizeConversationId(String(c.id)) === bare)
    snap.listLastMessageAt = pick(hit, 'last_message_at') as string | undefined
    snap.listUpdatedAt = pick(hit, 'updated_at') as string | undefined
    snap.listIsAgentJoined = pick(hit, 'is_agent_joined') as boolean | undefined
  }
  catch { /* 同上 */ }

  // ③ 最新一則訊息（對照組：真正有新訊息的時間點）
  try {
    const msgs = await rawList(client, { conversation_id: bare, limit: '1' })
    snap.newestMessageId = msgs[0]?.id
    snap.newestMessageAt = msgs[0]?.created_at
  }
  catch { /* 同上 */ }

  return snap
}

const WATCHED: Array<[keyof Snapshot, string]> = [
  ['isJoined', 'get.is_joined'],
  ['isAgentJoined', 'get.is_agent_joined'],
  ['isPresence', 'get.is_presence'],
  ['mode', 'get.mode'],
  ['status', 'get.status'],
  ['userCount', 'get.users[].length'],
  ['getUpdatedAt', 'get.updated_at'],
  ['listLastMessageAt', 'list.last_message_at'],
  ['listUpdatedAt', 'list.updated_at'],
  ['listIsAgentJoined', 'list.is_agent_joined'],
  ['newestMessageId', 'messages 最新一則'],
]

function diff(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = []
  for (const [key, label] of WATCHED) {
    const a = prev[key]
    const b = next[key]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${label}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
    }
  }
  // users[] 成員異動（人數不變但換人時也要看得到）
  const before = new Set(prev.userIds ?? [])
  const after = new Set(next.userIds ?? [])
  const added = [...after].filter(id => !before.has(id))
  const removed = [...before].filter(id => !after.has(id))
  if (added.length) out.push(`get.users[] 新增: ${added.join(', ')}`)
  if (removed.length) out.push(`get.users[] 移除: ${removed.join(', ')}`)
  return out
}

function elapsed(startedAt: number): string {
  const s = Math.round((Date.now() - startedAt) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

async function main() {
  loadEnv()
  const client = makeClient()
  const buId = await businessUnitId(client)

  const bare = normalizeConversationId(process.argv[2]?.trim() || env('SPIKE_CONVERSATION_ID'))
  const seconds = Number(process.argv[3] ?? 180)

  if (!bare) {
    console.error('請提供對話 id，或在 .env.local 設定 SPIKE_CONVERSATION_ID')
    process.exit(1)
  }

  console.log(`\n── 12 Presence 與變更偵測即時觀測 ──────────────────────────`)
  console.log(`   對話：${bare}`)
  console.log(`   期間：${seconds} 秒，每 ${POLL_MS / 1000} 秒取樣一次`)
  console.log(`\n   請在 iMBrace 官方介面依序操作，每步之間停 10 秒：`)
  console.log(`     ① JOIN 這個對話`)
  console.log(`     ② 送一則訊息`)
  console.log(`     ③ LEAVE 這個對話`)
  console.log(`\n   任何欄位變動都會即時印在下面（沒變動就不印）。Ctrl+C 可提早結束。\n`)

  const startedAt = Date.now()
  const timeline: Array<{ t: string, changes: string[] }> = []
  let prev = await snapshot(client, buId, bare)

  console.log(`   [${elapsed(startedAt)}] 起始狀態`)
  for (const [key, label] of WATCHED) {
    console.log(`            ${label} = ${JSON.stringify(prev[key])}`)
  }
  console.log('')

  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS))
    const next = await snapshot(client, buId, bare)
    const changes = diff(prev, next)
    if (changes.length) {
      const t = elapsed(startedAt)
      console.log(`   [${t}] ${changes.length} 項變動`)
      for (const c of changes) console.log(`            ${c}`)
      console.log('')
      timeline.push({ t, changes })
    }
    prev = next
  }

  const file = resolve(OUT_DIR, '12-presence-timeline.json')
  writeFileSync(file, JSON.stringify({ conversationId: bare, seconds, timeline }, null, 2), 'utf8')

  console.log(`\n── 結束 ──────────────────────────────────────────────────`)
  console.log(`   共記錄 ${timeline.length} 個變動時點`)
  console.log(`   📁 ${file}`)
  if (timeline.length === 0) {
    console.log(`\n   ⚠️ 完全沒有偵測到變動。可能是：`)
    console.log(`      · 觀測期間沒有實際操作`)
    console.log(`      · 該對話不是你在官方介面操作的那一個（確認 id 相符）`)
  }
}

main().catch((e) => {
  console.error('\n💥', e instanceof Error ? e.message : e)
  process.exit(1)
})
