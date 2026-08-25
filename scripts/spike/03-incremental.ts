/**
 * 03 — 訊息取數與 JOIN/LEAVE 推斷（B-2 / A-1 替代方案）
 *
 * 兩個問題：
 *  ① messages.list() 沒有 conversation_id 也沒有 since —— 那 §9 的整套輪詢策略
 *     （1.5 秒一次、增量拉取、共享訂閱）建立在什麼之上？先找出可行的取數方式。
 *  ② webhook 規格未定期間，能否靠輪詢 conversation.users[] 推斷 JOIN/LEAVE？
 *     若可行，PollingEventSource 成立，M1 不被 webhook 阻塞。
 */

import { runProbe, requireEnv, isMain, type Finding } from './lib/harness.js'
import { tryStrategies, rawList } from '../../server/sources/message-fetch.js'
import { toConversation, diffOperators, normalizeConversationId, unwrapPaged } from '../../server/sources/mappers.js'

export const probe03 = () => runProbe('03', 'B-2 增量取數與輪詢可行性', async (p, client) => {
  const convId = requireEnv('SPIKE_CONVERSATION_ID')

  // ── ① 取數策略 ────────────────────────────────────────
  const results = await tryStrategies(client, convId)
  results.forEach(r => console.log(`     ${r.strategy}: precision=${(r.precision * 100).toFixed(0)}% ${r.note}`))
  p.fixture('fetch-strategies', results.map(r => ({ ...r, messages: r.messages.length })), true)

  const viable = results.filter(r => r.precision >= 0.99 && r.messages.length > 0)
  const winner = viable.find(r => r.strategy === 'raw-conversation-id')
    ?? viable.find(r => r.strategy === 'sdk-q')
    ?? viable[0]

  p.record({
    question: 'B-2a', claim: 'messages 能否依 conversation 過濾',
    verdict: winner ? (winner.strategy === 'sdk-client-filter' ? 'partial' : 'yes') : 'no',
    evidence: winner
      ? `可行策略：${winner.strategy}（${winner.note}）`
      : `三種策略皆不可行：${results.map(r => `${r.strategy}=${r.note}`).join('; ')}`,
    impact: !winner
      ? '❗ 無法依對話取訊息 → §9 整套輪詢設計不成立，必須先向 iMBrace 取得正確用法。這會直接阻塞 M1。'
      : winner.strategy === 'sdk-client-filter'
        ? '❗ 只能全量取回再本地過濾 —— 1.5 秒輪詢會造成嚴重頻寬與 rate limit 壓力，'
          + '§9.2 的自適應頻率表必須整個重算，且共享訂閱的節省效果被抵銷。'
        : winner.strategy === 'raw-conversation-id'
          ? '✅ 後端支援 conversation_id，但 SDK 未公開此參數 —— '
            + 'PollingMessageSource 需保留 rawList() 這層薄封裝，並在 SDK 更新時移除。'
          : '✅ 可用 SDK 原生 list({q})。',
  })

  // ── ② since / 增量 ───────────────────────────────────
  let sinceWorks = false
  let sinceNote = '未測試'
  if (winner && winner.messages.length >= 2) {
    const sorted = [...winner.messages].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const pivot = sorted[Math.floor(sorted.length / 2)]!
    for (const param of ['since', 'after', 'since_id', 'from_created_at'] as const) {
      try {
        const got = await rawList(client, {
          conversation_id: convId,
          [param]: param.includes('id') || param === 'since' ? pivot.id : pivot.created_at,
          limit: '100',
        })
        if (got.length > 0 && got.length < sorted.length) {
          sinceWorks = true
          sinceNote = `?${param}= 有效：全量 ${sorted.length} 則 → 增量 ${got.length} 則`
          break
        }
        sinceNote = `?${param}= 無效（回傳 ${got.length} 則，與全量相同）`
      } catch (e) {
        sinceNote = `?${param}= 失敗：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
  console.log(`     增量拉取：${sinceNote}`)

  p.record({
    question: 'B-2b', claim: '是否支援 since 增量拉取',
    verdict: sinceWorks ? 'yes' : 'no',
    evidence: sinceNote,
    impact: sinceWorks
      ? '✅ §9.3 的增量拉取最佳化可實作。'
      : '❗ 不支援增量 → 每次輪詢都是全量。60 個活躍對話 × 1.5 秒的成本評估（§9.3 的 12 req/s）'
        + '需重估為「12 req/s × 每次全量 payload」。緩解方式：加大輪詢間隔、'
        + '用 limit + sort=desc 只取最新 N 則再本地比對 lastMessageId。',
  })

  // ── ③ PollingEventSource 可行性 ──────────────────────
  //
  // ⚠️ getByConversationId() 打的是 `?type=conversation_id&q=`，回的是**分頁容器**
  //    而非單一對話。初版直接把它丟給 toConversation()，靜默產生 id=undefined
  //    的空快照，讓 A-1alt 一直得到「0 人」的假結論。
  // ⚠️ 且它與 search() 吃的 id 形式不同 —— 兩種都試，把實際可行的那個記錄下來。
  async function snapshot(): Promise<{ conv: ReturnType<typeof toConversation> | null, via: string }> {
    for (const [label, id] of [
      ['帶 conv_ 前綴', `conv_${normalizeConversationId(convId)}`],
      ['裸 UUID', normalizeConversationId(convId)],
    ] as const) {
      const hit = unwrapPaged<Parameters<typeof toConversation>[0]>(
        await client.conversations.getByConversationId(id),
      )[0]
      if (hit) return { conv: toConversation(hit), via: `getByConversationId(${label})` }
    }
    // 退回以內部 id 直接取
    try {
      return {
        conv: toConversation(await client.conversations.get(normalizeConversationId(convId))),
        via: 'conversations.get(內部 id)',
      }
    }
    catch {
      return { conv: null, via: '兩種 id 形式與 get() 皆取不到' }
    }
  }

  const first = await snapshot()
  await new Promise(r => setTimeout(r, 1500))
  const second = await snapshot()
  const snap1 = first.conv
  const snap2 = second.conv
  const changes = snap1 && snap2 ? diffOperators(snap1, snap2) : []

  console.log(`     取得方式：${first.via}`)
  console.log(`     conversation.users[] = ${snap1?.operators.length ?? '取不到'} 人：${snap1?.operators.map(o => o.name).join(', ') || '(無)'}`)

  p.record({
    question: 'A-1alt', claim: 'webhook 未到位前，能否靠輪詢 users[] 推斷 JOIN/LEAVE',
    verdict: !snap1 ? 'unknown' : snap1.operators.length > 0 ? 'yes' : 'partial',
    evidence: !snap1
      ? `取不到對話快照（${first.via}）`
      : `${first.via} 回傳 users[]（${snap1.operators.length} 人，含 id 與 display_name）；`
        + `1.5 秒內偵測到 ${changes.length} 筆變化`,
    impact: snap1 && snap1.operators.length > 0
      ? '✅ 重要發現：SDK 已提供該對話的完整 operator 清單 —— '
        + 'A-1 要求 webhook 附帶 current_operators 的需求，在輪詢路徑下已可自行滿足。'
        + 'PollingEventSource + Presence 可完整實作，M1 不被 webhook 阻塞。'
        + '（webhook 到位後仍建議保留此對帳路徑，見 §9.4）'
      : '此對話目前無人 JOIN，無法驗證 —— 請在官方介面 JOIN 後重跑。',
  })

  p.fixture('operators-snapshot', { snap1, snap2, changes })
})

if (isMain(import.meta.url)) {
  probe03().then((f: Finding[]) => process.exit(0))
}
