/**
 * 01 — 訊息發送者身分能否區分（H-3）🔴 P0
 *
 * 為何最重要：撞單防護（§10.4）是整套協同設計中唯一真正有效的一層，
 * 而它必須能區分「同事回覆」與「AI 自動回覆」。若無法區分，
 * 假警報會讓客服學會忽略提示，防護形同虛設 —— 產品核心價值直接歸零。
 *
 * 靜態分析已知：ConversationMessage.from 是單一 string，沒有 type 判別欄位。
 * 本 probe 驗證能否靠 conversation.contact_id / users[] 反推。
 */

import { runProbe, requireEnv, isMain, type Finding } from './lib/harness.js'
import { createSenderResolver, toMessage, toConversation } from '../../server/sources/mappers.js'
import { tryStrategies } from '../../server/sources/message-fetch.js'
import type { SenderType } from '../../shared/types/conversation.js'

export const probe01 = () => runProbe('01', 'H-3 發送者身分區分', async (p, client) => {
  const convId = requireEnv('SPIKE_CONVERSATION_ID')

  const rawConv = await client.conversations.getByConversationId(convId)
  const conv = toConversation(rawConv)
  p.fixture('conversation', rawConv)

  console.log(`     對話「${conv.name}」 contactId=${conv.contactId} operators=${conv.operators.length}`)

  const results = await tryStrategies(client, convId)
  const best = results.filter(r => r.messages.length > 0).sort((a, b) => b.precision - a.precision)[0]
  if (!best) throw new Error('三種策略都取不到訊息 —— 先確認 SPIKE_CONVERSATION_ID 正確')

  // ── 核心：用防腐層 mapper 跑真實資料 ──────────────────
  const unresolved: string[] = []
  const resolve = createSenderResolver(rawConv, from => unresolved.push(from))
  const messages = best.messages.map(m => toMessage(m, resolve))

  const dist = messages.reduce<Record<SenderType, number>>(
    (acc, m) => { acc[m.sender.type] = (acc[m.sender.type] ?? 0) + 1; return acc },
    { customer: 0, ai: 0, agent: 0, unknown: 0 },
  )
  const distinctFrom = new Set(best.messages.map(m => m.from))
  const unresolvedDistinct = new Set(unresolved)

  console.log(`     from 的相異值 ${distinctFrom.size} 個：${[...distinctFrom].slice(0, 5).join(', ')}${distinctFrom.size > 5 ? '…' : ''}`)
  console.log(`     判別結果：customer=${dist.customer} agent=${dist.agent} ai/未歸類=${dist.ai}`)

  p.fixture('messages-mapped', messages)
  p.fixture('from-values', {
    distinct: [...distinctFrom],
    contactId: conv.contactId,
    operatorIds: conv.operators.map(o => o.id),
    unresolved: [...unresolvedDistinct],
  }, true)

  // ── 判定 ────────────────────────────────────────────
  const canSplitCustomer = dist.customer > 0
  const canSplitAgent = dist.agent > 0
  const aiIsGuess = unresolvedDistinct.size > 0

  p.record({
    question: 'H-3',
    claim: '能否區分 customer / agent / ai 三種發送者',
    verdict: canSplitCustomer && canSplitAgent && !aiIsGuess ? 'yes'
      : canSplitCustomer && canSplitAgent ? 'partial' : 'no',
    evidence:
      `from 相異值 ${distinctFrom.size} 個；` +
      `對照 contact_id 命中 ${dist.customer} 則、對照 users[] 命中 ${dist.agent} 則、` +
      `無法歸類 ${unresolvedDistinct.size} 種來源（推定為 AI）`,
    impact: aiIsGuess
      ? `「AI 訊息」目前只能用排除法推定 —— 若無法歸類的來源中混有「已離開對話的客服」，`
        + `撞單檢查會把同事誤判成 AI。需向 iMBrace 確認 from 的值域，或改用 removeTeamMember 後仍保留歷史 users 的方式補強。`
      : `三種發送者可穩定區分，§10.4 樂觀併發檢查可照設計實作。`,
  })

  p.record({
    question: 'H-3b',
    claim: '真人客服訊息是否帶 operator id',
    verdict: canSplitAgent ? 'yes' : 'unknown',
    evidence: canSplitAgent
      ? `${dist.agent} 則訊息的 from 命中 conversation.users[]，可取得 operatorId 與姓名`
      : '此對話沒有真人客服訊息，無法驗證 —— 請換一個已有客服回覆的對話重跑',
    impact: canSplitAgent ? undefined
      : '未驗證。撞單檢查需要 sender.id !== me.operatorId，這是必要條件。',
  })
})

if (isMain(import.meta.url)) {
  probe01().then((f: Finding[]) => process.exit(f.some(x => x.verdict === 'no') ? 1 : 0))
}
