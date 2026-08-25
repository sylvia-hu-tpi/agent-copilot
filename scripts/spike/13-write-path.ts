/**
 * M1 開工前的最後一組實測：**寫入路徑與識別碼**。
 *
 * M1 的後端有四個假設是照 SDK「編譯後的 JS」反推的，型別層完全答不了。
 * 這四個之中任何一個錯掉，症狀都是「按了沒反應」或「送不出去」而非明確報錯 ——
 * 正是本專案最貴的那類 bug。
 *
 *  ① `getByConversationId()` 能否從對話 id 反查到 `tcu_` id
 *     → 錯了的話 JOIN / LEAVE / 切換 mode 整條路死掉
 *  ② 詳情 payload 是否真的帶 `mode` / `is_joined` / `users[]`
 *     → 錯了的話 presence ③ 與 Composer 可用性判斷失準
 *  ③ 清單 payload 是否真的帶 `last_message_at` / `updated_at`
 *     → 錯了的話 §9.3.1 的第一層輪詢偵測不到任何變動
 *  ④ 訊息是否真的「由新到舊」排序
 *     → 錯了的話 `fetchLatest()` 的反轉會讓整個訊息流顛倒
 *
 * ── ⑤ 送訊息的欄位名：零投遞探測 ─────────────────────────────
 * `messages.send()` 的型別**完全沒有宣告對話識別碼**，但端點不可能不需要。
 * 直接送一則真訊息去驗，等於在正式環境對真實客戶發話 —— 不可接受。
 *
 * 因此這裡改用**不存在的 UUID**：
 *   - 回「找不到對話」→ 欄位名對了
 *   - 回「缺少 conversation_id」→ 欄位名錯了，換一個
 * 兩種結果都不會有任何訊息被投遞給任何人。
 *
 * ⚠️ 這支 probe 唯一會產生副作用的情況，是平台把不存在的 conversation_id
 *    當成「建立新對話」處理。已知的端點語意沒有這個行為，但若回應顯示
 *    建立了東西，**必須立刻回報並人工清理**（見 assertNoCreation）。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import {
  businessUnitId,
  env,
  isMain,
  Probe,
  requireEnv,
  runProbe,
  writeReport,
  type Finding,
} from './lib/harness.js'
import {
  createSenderResolver,
  normalizeConversationId,
  toConversation,
  toMessage,
  unwrapPaged,
} from '../../server/sources/mappers.js'
import { getConversationDetail } from '../../server/services/imbrace.js'
import { rawList } from '../../server/sources/message-fetch.js'

/** 保證不存在的對話 id —— 全零 UUID */
const NONEXISTENT = 'conv_00000000-0000-0000-0000-000000000000'

const pick = (o: unknown, k: string): unknown =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined

export async function run(): Promise<Finding[]> {
  return runProbe('13', '寫入路徑與識別碼', async (p, client) => {
    const convId = requireEnv('SPIKE_CONVERSATION_ID')

    await probeDetail(p, client, convId)
    await probeList(p, client, convId)
    await probeOrdering(p, client, convId)
    await probeSendFieldName(p, client)
  })
}

// ── ①② 詳情：tcu id / mode / is_joined / users[] ────────────────────────

async function probeDetail(p: Probe, client: ImbraceClient, convId: string): Promise<void> {
  const raw = await getConversationDetail(client, convId)
  if (!raw) {
    p.record({
      question: 'M1-1',
      claim: 'getByConversationId() 可從對話 id 反查詳情',
      verdict: 'no',
      evidence: '回傳空 —— 反查不到',
      impact: '⚠️ JOIN / LEAVE / 切換 mode 全部無法運作，loadConversationContext() 需改寫',
    })
    return
  }

  p.fixture('conversation-detail', raw)

  const rawId = pick(raw, 'id')
  const rawUnderscoreId = pick(raw, '_id')
  const tcu = [rawId, rawUnderscoreId].find(
    v => typeof v === 'string' && v.startsWith('tcu_'),
  )

  p.record({
    question: 'M1-1',
    claim: '詳情 payload 帶得出 tcu_ 開頭的 team_conversation id',
    verdict: tcu ? 'yes' : 'no',
    evidence: tcu
      ? `id=${String(rawId).slice(0, 12)}…、_id=${String(rawUnderscoreId).slice(0, 12)}…，其中 ${String(tcu).slice(0, 12)}… 是 tcu_`
      : `id=${JSON.stringify(rawId)}、_id=${JSON.stringify(rawUnderscoreId)} —— 都不是 tcu_`,
    impact: tcu
      ? undefined
      : '⚠️ requireTeamConversationId() 會一律丟 502，JOIN 按鈕等於壞的',
  })

  // 經過防腐層之後，識別碼有沒有對齊
  const conv = toConversation(raw as never)
  const aligned = conv.id === normalizeConversationId(convId)
  p.record({
    question: 'M1-1b',
    claim: 'toConversation() 產出的 id 與查詢用的對話 id 是同一把鍵（§9.3）',
    verdict: aligned ? 'yes' : 'no',
    evidence: `輸入 ${convId} → 正規化 ${normalizeConversationId(convId)}；mapper 產出 ${conv.id}`,
    impact: aligned
      ? undefined
      : '⚠️ CopilotSession / presence / EventBus topic 會用到兩把不同的鍵，症狀是「訊息進來了但面板沒反應」',
  })

  const mode = pick(raw, 'mode')
  const isJoined = pick(raw, 'is_joined')
  const users = pick(raw, 'users')
  p.record({
    question: 'M1-2',
    claim: '詳情 payload 帶 mode / is_joined / users[]',
    verdict: mode !== undefined && isJoined !== undefined ? 'yes' : 'partial',
    evidence: `mode=${JSON.stringify(mode)}、is_joined=${JSON.stringify(isJoined)}、`
      + `users=${Array.isArray(users) ? `${users.length} 人` : JSON.stringify(users)}`,
    impact: isJoined === undefined
      ? '⚠️ presence 來源 ③ 少了 viewerJoined 這個條件，客服 JOIN 後會看到「有同事正在處理」的假警報'
      : undefined,
  })
}

// ── ③ 清單：last_message_at / updated_at ───────────────────────────────

async function probeList(p: Probe, client: ImbraceClient, convId: string): Promise<void> {
  const bu = await businessUnitId(client)
  const res = await client.conversations.search({ businessUnitId: bu, q: '', limit: 100 })
  const rawItems = unwrapPaged<Record<string, unknown>>(res)

  const withLastMessageAt = rawItems.filter(c => c.last_message_at).length
  const withUpdatedAt = rawItems.filter(c => c.updated_at).length
  const withMode = rawItems.filter(c => c.mode).length

  p.record({
    question: 'M1-3',
    claim: '清單 payload 帶 last_message_at / updated_at / mode（§9.3.1 第一層的全部依據）',
    verdict: withLastMessageAt > 0 && withUpdatedAt > 0 ? 'yes' : 'no',
    evidence: `${rawItems.length} 筆中：last_message_at ${withLastMessageAt} 筆`
      + `（${pct(withLastMessageAt, rawItems.length)}）、updated_at ${withUpdatedAt} 筆、mode ${withMode} 筆`,
    impact: withLastMessageAt < rawItems.length
      ? `⚠️ 有 ${rawItems.length - withLastMessageAt} 筆偵測不到新訊息，必須由第二層跑滿 §9.2 頻率兜底`
      : undefined,
  })

  // 我方 mapper 是否真的取得到（型別上這幾個欄位都沒宣告，全靠 cast）
  const mapped = rawItems.map(c => toConversation(c as never))
  const mappedWithLast = mapped.filter(c => c.lastMessageAt).length
  p.record({
    question: 'M1-3b',
    claim: 'toConversation() 真的把 last_message_at 對應到 lastMessageAt',
    verdict: mappedWithLast === withLastMessageAt ? 'yes' : 'no',
    evidence: `原始 ${withLastMessageAt} 筆 → mapper 後 ${mappedWithLast} 筆`,
    impact: mappedWithLast === withLastMessageAt
      ? undefined
      : '⚠️ 防腐層漏接欄位 —— 第一層輪詢會永遠認為「沒有變動」，且完全不報錯',
  })

  p.fixture('list-sample', rawItems.slice(0, 3))

  const target = mapped.find(c => c.id === normalizeConversationId(convId))
  p.record({
    question: 'M1-3c',
    claim: '探測目標對話出現在清單中，且 id 與詳情對得起來',
    verdict: target ? 'yes' : 'no',
    evidence: target
      ? `mode=${target.mode}、lastMessageAt=${target.lastMessageAt ?? '(無)'}`
      : `清單 ${mapped.length} 筆中找不到 ${normalizeConversationId(convId)}`,
    impact: target
      ? undefined
      : '⚠️ 第一層輪詢涵蓋不到這個對話 —— 可能是清單有分頁上限（LIST_PAGE_SIZE=100）',
  })
}

// ── ④ 訊息排序 ─────────────────────────────────────────────────────────

async function probeOrdering(p: Probe, client: ImbraceClient, convId: string): Promise<void> {
  const raw = await rawList(client, { conversation_id: convId, limit: '10' })
  if (raw.length < 2) {
    p.record({
      question: 'M1-4',
      claim: '訊息由新到舊排序',
      verdict: 'unknown',
      evidence: `只取回 ${raw.length} 則，不足以判斷排序`,
    })
    return
  }

  const resolveSender = createSenderResolver()
  const times = raw.map(m => new Date(toMessage(m, resolveSender).at).getTime())
  const newestFirst = times.every((t, i) => i === 0 || times[i - 1]! >= t)
  const oldestFirst = times.every((t, i) => i === 0 || times[i - 1]! <= t)

  p.record({
    question: 'M1-4',
    claim: '訊息預設由新到舊排序 —— limit=N 直接就是最新 N 則',
    verdict: newestFirst ? 'yes' : 'no',
    evidence: newestFirst
      ? `${raw.length} 則全部遞減：${new Date(times[0]!).toISOString()} → ${new Date(times.at(-1)!).toISOString()}`
      : oldestFirst
        ? '⚠️ 實際是由舊到新（遞增）—— fetchLatest() 的 .reverse() 會把順序弄反'
        : '⚠️ 未依時間排序，limit=N 取到的不保證是最新 N 則',
    impact: newestFirst
      ? undefined
      : '⚠️ fetchLatest() 必須改：目前無條件 .reverse()，在此排序下會產出錯誤順序的訊息流',
  })

  p.fixture('messages-sample', raw.slice(0, 3))
}

// ── ⑤ 送訊息的欄位名（零投遞）───────────────────────────────────────────

interface SendAttempt {
  label: string
  body: Record<string, unknown>
}

interface SendOutcome {
  label: string
  outcome: string
  created: boolean
}

/**
 * ⚠️ 每一次嘗試都用不存在的對話 id，或完全不帶 id。
 *    **沒有任何一種組合會把訊息送到真實對話**。
 */
async function probeSendFieldName(p: Probe, client: ImbraceClient): Promise<void> {
  const text = `[AgentCopilot spike ${new Date().toISOString()}] 這是一次不會被投遞的欄位名探測`

  const attempts: SendAttempt[] = [
    { label: '不帶任何對話識別碼（對照組）', body: { type: 'text', text } },
    { label: 'conversation_id（帶 conv_ 前綴）', body: { type: 'text', text, conversation_id: NONEXISTENT } },
    { label: 'conversation_id（裸 UUID）', body: { type: 'text', text, conversation_id: NONEXISTENT.slice(5) } },
  ]

  const results: SendOutcome[] = []
  for (const attempt of attempts) {
    const outcome = await trySend(client, attempt.body)
    results.push({ label: attempt.label, ...outcome })
    console.log(`     · ${attempt.label} → ${outcome.outcome}`)
  }

  p.fixture('send-field-probe', results, true)

  const [control, prefixed, bare] = results as [SendOutcome, SendOutcome, SendOutcome]

  // 判定：對照組與帶欄位組的錯誤訊息若不同，代表欄位確實被讀取
  const fieldRecognised
    = control.outcome !== prefixed.outcome || control.outcome !== bare.outcome

  p.record({
    question: 'H-6',
    claim: 'messages.send() 以 conversation_id 指定目標對話（SDK 型別未宣告）',
    verdict: fieldRecognised ? 'partial' : 'unknown',
    evidence: results.map(r => `${r.label}：${r.outcome}`).join('｜'),
    impact: fieldRecognised
      ? 'sendTextMessage() 的欄位名可依此定案。⚠️ 仍未驗證成功送出後回傳物件的 id 形狀'
      : '⚠️ 三種寫法錯誤訊息相同，無法從失敗反推欄位名 —— 需向 iMBrace 索取送訊息的請求規格（H-6）',
  })

  assertNoCreation(p, results)
}

async function trySend(
  client: ImbraceClient,
  body: Record<string, unknown>,
): Promise<{ outcome: string, created: boolean }> {
  try {
    const res = await client.messages.send(body as never) as unknown as Record<string, unknown>
    // ⚠️ 成功是最壞的結果 —— 代表平台對不存在的 id 做了某種寬容處理
    return {
      outcome: `⚠️ 回 200：${JSON.stringify(res).slice(0, 200)}`,
      created: typeof res?.id === 'string',
    }
  }
  catch (err) {
    return {
      outcome: err instanceof Error ? err.message.slice(0, 200) : String(err),
      created: false,
    }
  }
}

/**
 * 這支 probe 的安全前提是「不存在的對話 id 不會建立任何東西」。
 * 若前提被推翻，必須當場大聲說出來 —— 靜默通過等於在正式環境留下垃圾資料。
 */
function assertNoCreation(p: Probe, results: SendOutcome[]): void {
  const created = results.filter(r => r.created)
  if (created.length === 0) return

  p.record({
    question: 'H-6-safety',
    claim: '不存在的 conversation_id 不會建立任何東西',
    verdict: 'no',
    evidence: `⚠️ 以下嘗試回傳了帶 id 的物件：${created.map(c => c.label).join('、')}`,
    impact: '🚨 正式環境可能已產生孤兒訊息／對話，請立即人工檢查並清理，'
      + '並在修正前不要重跑本 probe',
  })
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 100)}%`
}

if (isMain(import.meta.url)) {
  const findings = await run()
  console.log(`\n📄 ${writeReport(findings)}`)
  console.log(`\n環境：${env('IMBRACE_ENV', 'stable')}\n`)
}
