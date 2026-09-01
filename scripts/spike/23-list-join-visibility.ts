/**
 * 對話**清單** payload 對「誰在這個對話裡」到底知道多少。
 *
 * 起因：畫布 2026-09-01 版的左欄列項第二行有三態 presence
 * （「你在此對話中」／「無客服在此」／「`{email}` 在此」），而我方當時只做得出一態。
 * 使用者另外希望**標出所有自己 JOIN 過的對話**。
 *
 * ✅ **本次實測的結論已經落地**：「你在此對話中」做出來了（`server/services/viewer-joined.ts`），
 *    「無客服在此」與「`{email}` 在此」確認做不到。設計見 ARCHITECTURE §10.2.1／§10.2.1a。
 *
 * ── 2026-09-01 實測結論（結果見 `out/23-*.json`，摘要見 ARCHITECTURE §10.2.1）──
 *
 *  ⓪ **沒有「只列出我 JOIN 的」端點**。SDK 註解寫著 view 有 all／joined／yours，
 *     但 `getViewsCount()` 實際回的是 **status** 分組（`{active, open}`），
 *     `list({type})` 四種型別全回 0 筆。可用的清單端點只有 `search({ businessUnitId })`。
 *
 *  ① **`is_agent_joined` 不能用來判斷「現在有沒有人」**。它是單向黏著的：
 *     LEAVE 之後仍維持 `true`（16 筆之中沒有任何一筆是 `false`），代表「**曾經**有人 JOIN 過」。
 *     因此畫布的「無客服在此」**做不出來** —— 這與 spike 12 的結論同向，兩次獨立實測一致。
 *
 *  ② **清單完全沒有 `is_joined`**（16 筆之中 0 筆）。「標出我 JOIN 過的每一則」
 *     只能對候選對話逐筆查詳情，或退回伺服器端的記憶體記錄
 *     （後者重啟／HMR 後歸零，也記不到同事在 iMBrace 官方介面按的 JOIN）。
 *
 * ⚠️ 結論已寫進正典，**這支腳本留著是為了日後能重測**（平台改版時第一個要重跑的就是它）。
 *
 * ⚠️⚠️ **這支 probe 會對 `SPIKE_CONVERSATION_ID` 做真實的 JOIN 與 LEAVE。**
 *   `IMBRACE_ENV=stable` 是**正式環境**，操作的是真實客戶對話。因此：
 *
 *   - 必須明確指定 `SPIKE_JOIN_WRITE=1` 才會跑寫入段，否則只跑唯讀觀察並回報 `unknown`
 *   - **一律以「還原成呼叫前的狀態」為終點**（`finally`），因此順序依對話**當下**的狀態決定：
 *       呼叫前已 JOIN（`is_joined:true`）→ **先 LEAVE 觀察、再 JOIN 回原本的 mode**
 *       呼叫前未 JOIN                    → **先 JOIN 觀察、再 LEAVE**
 *     ⚠️ 順序不可寫死。對一個已經 `mode:manual` 的對話「先 JOIN 再 LEAVE」，
 *     終點會是 `automation` —— 等於把一則有人在處理的對話丟回 AI 自動回覆，
 *     而那正是 §10.6 說的「切換會影響所有人」。
 *   - ⚠️ **不會送出任何訊息**，客戶端不會看到任何東西；但 JOIN／LEAVE 會出現在
 *     平台的對話紀錄裡，且**兩次呼叫之間有約一秒的空窗**，該對話會短暫落在另一個 mode。
 *     若這一秒內客戶剛好發話，AI 的行為會與平常不同 ——
 *     **挑一個目前沒有客戶正在對話的對象，並讓使用者知情**
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
import { normalizeConversationId, unwrapPaged } from '../../server/sources/mappers.js'
import {
  getConversationDetail,
  joinConversation,
  leaveConversation,
} from '../../server/services/imbrace.js'

const pick = (o: unknown, k: string): unknown =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined

/** 這次關心的三個欄位 —— 清單與詳情都取同一組，才比得出「誰有誰沒有」 */
interface JoinShape {
  mode: unknown
  isJoined: unknown
  isAgentJoined: unknown
}

function shapeOf(raw: unknown): JoinShape {
  return {
    mode: pick(raw, 'mode'),
    isJoined: pick(raw, 'is_joined'),
    isAgentJoined: pick(raw, 'is_agent_joined'),
  }
}

function fmt(s: JoinShape): string {
  return `mode=${JSON.stringify(s.mode)}、is_joined=${JSON.stringify(s.isJoined)}、`
    + `is_agent_joined=${JSON.stringify(s.isAgentJoined)}`
}

export async function run(): Promise<Finding[]> {
  return runProbe('23', '清單 payload 對「誰在對話裡」知道多少', async (p, client) => {
    const convId = requireEnv('SPIKE_CONVERSATION_ID')

    const listShapes = await probeListFields(p, client)
    await probeJoinedView(p, client)
    await probeDetailVsList(p, client, convId, listShapes)
    await probeJoinTransition(p, client, convId)
  })
}

// ── ⓪ 有沒有「只列出我 JOIN 的」這種端點 ─────────────────────────────

/**
 * SDK 的 `getViewsCount()` 註解寫著「Count conversations per view (**all/joined/yours**)」，
 * `list()` 也有一個未說明的 `type?: string` —— 若這條路走得通，
 * 「標出我 JOIN 的每一則」就是一次呼叫的事，完全不必逐筆查詳情。
 *
 * ⚠️ 這是**否定結果也要留下**的那種探測：不記錄的話，下一個人看到同一段 SDK 註解
 *    會再提案一次、再花一次時間。
 */
async function probeJoinedView(p: Probe, client: ImbraceClient): Promise<void> {
  let counts: Record<string, unknown> = {}
  try {
    counts = await client.conversations.getViewsCount() as Record<string, unknown>
  }
  catch (e) {
    counts = { error: e instanceof Error ? e.message : String(e) }
  }

  const keys = Object.keys(counts)
  const hasJoinedView = keys.includes('joined') || keys.includes('yours')

  const listByType: Record<string, number | string> = {}
  for (const type of ['all', 'joined', 'yours']) {
    try {
      const res = await client.conversations.list({ type, limit: 100 })
      listByType[type] = unwrapPaged<Record<string, unknown>>(res).length
    }
    catch (e) {
      listByType[type] = e instanceof Error ? e.message : String(e)
    }
  }

  p.fixture('views', { getViewsCount: counts, listByType })

  p.record({
    question: 'D-23f',
    claim: '平台有「只列出我 JOIN 的對話」的 view／參數（SDK 註解暗示 all／joined／yours）',
    verdict: hasJoinedView ? 'yes' : 'no',
    evidence: `getViewsCount() 回 ${JSON.stringify(counts)}（是 **status** 分組，不是 all／joined／yours）；`
      + `list({type}) 各型別的筆數 = ${JSON.stringify(listByType)}`,
    impact: hasJoinedView
      ? '✅ 一次呼叫即可拿到「我 JOIN 的對話」'
      : '⚠️ SDK 那句註解與實際 API 不符（又一例，見 §「SDK 型別與實際 API 不一致」）。'
        + '`list()` 四種 type 全回 0 筆 —— 可用的清單端點只有 `search({ businessUnitId })`。'
        + '「標出我 JOIN 的每一則」只能逐筆查詳情取 `is_joined`',
  })
}

// ── ② 清單有哪些欄位、填充率多少 ──────────────────────────────────────

async function probeListFields(
  p: Probe,
  client: ImbraceClient,
): Promise<Map<string, JoinShape>> {
  const bu = await businessUnitId(client)
  const res = await client.conversations.search({ businessUnitId: bu, q: '', limit: 100 })
  const rawItems = unwrapPaged<Record<string, unknown>>(res)

  const byId = new Map<string, JoinShape>()
  for (const item of rawItems) {
    const id = normalizeConversationId(
      String(pick(item, 'conversation_id') ?? pick(item, 'id') ?? ''),
    )
    if (id) byId.set(id, shapeOf(item))
  }

  const n = rawItems.length
  const withIsJoined = rawItems.filter(c => c.is_joined !== undefined).length
  const withAgentJoined = rawItems.filter(c => c.is_agent_joined !== undefined).length
  const agentJoinedTrue = rawItems.filter(c => c.is_agent_joined === true).length
  const agentJoinedFalse = rawItems.filter(c => c.is_agent_joined === false).length

  p.fixture('list-join-fields', rawItems.map(shapeOf))

  p.record({
    question: 'D-23a',
    claim: '對話清單 payload 帶得出 `is_joined`（我的視角）',
    verdict: withIsJoined > 0 ? 'yes' : 'no',
    evidence: `${n} 筆之中 ${withIsJoined} 筆有 is_joined`,
    impact: withIsJoined > 0
      ? '✅ 左欄可以直接標出「你在此對話中」，不必另開端點也不必依賴伺服器記憶體'
      : '⚠️ 「標出我 JOIN 過的所有對話」在清單這條路走不通 —— '
        + '只剩 ① 對每一列各打一次詳情（N 次 API，不可行）'
        + '或 ② 伺服器端的 listJoinedConversations()（重啟後歸零、記不到官方介面的 JOIN）',
  })

  p.record({
    question: 'D-23b',
    claim: '`is_agent_joined` 是三態（true／false／缺席）而非只有 true',
    verdict: agentJoinedFalse > 0 ? 'yes' : agentJoinedTrue > 0 ? 'partial' : 'unknown',
    evidence: `${n} 筆之中：有此欄 ${withAgentJoined} 筆（true ${agentJoinedTrue}、false ${agentJoinedFalse}），`
      + `缺席 ${n - withAgentJoined} 筆`,
    impact: agentJoinedFalse > 0
      ? '✅ 有明確的 false 值 —— 畫布的「無客服在此」有機會做得出來，且沒有 mode 的 automation 歧義'
      : '⚠️ 只看得到 true 與缺席，無法分辨「沒人」與「查不到」——'
        + '此時 MUST NOT 顯示「無客服在此」，那會在「有人但唯讀」時把同事抹掉',
  })

  return byId
}

// ── ① 同一則對話：清單與詳情說的是不是同一件事 ────────────────────────

async function probeDetailVsList(
  p: Probe,
  client: ImbraceClient,
  convId: string,
  listShapes: Map<string, JoinShape>,
): Promise<void> {
  const detail = await getConversationDetail(client, convId)
  const fromList = listShapes.get(normalizeConversationId(convId))

  if (!detail) {
    p.record({
      question: 'D-23c',
      claim: '同一則對話在清單與詳情的 join 欄位一致',
      verdict: 'unknown',
      evidence: `詳情查不到 ${convId}`,
    })
    return
  }

  const d = shapeOf(detail)
  p.fixture('detail-vs-list', { detail: d, list: fromList ?? null })

  p.record({
    question: 'D-23c',
    claim: '同一則對話在清單與詳情的 join 欄位一致',
    verdict: fromList
      ? (d.isAgentJoined === fromList.isAgentJoined && d.mode === fromList.mode ? 'yes' : 'no')
      : 'unknown',
    evidence: `詳情：${fmt(d)}\n    清單：${fromList ? fmt(fromList) : '（這一則不在前 100 筆清單裡）'}`,
    impact: '⚠️ 不一致的話，左欄與中欄會對同一則對話說出不同的狀態 —— '
      + '客服點進去會看到「換了一個對話」的錯覺，而那不會有任何型別錯誤',
  })
}

// ── ③ JOIN → LEAVE 前後，三個欄位怎麼動 ───────────────────────────────

async function probeJoinTransition(
  p: Probe,
  client: ImbraceClient,
  convId: string,
): Promise<void> {
  if (env('SPIKE_JOIN_WRITE') !== '1') {
    p.record({
      question: 'D-23d',
      claim: 'LEAVE 之後 `is_agent_joined` 會轉為 false',
      verdict: 'unknown',
      evidence: '未設 SPIKE_JOIN_WRITE=1，略過寫入段',
      impact: '⚠️ 這一題沒有答案之前，MUST NOT 依 `is_agent_joined` 顯示「無客服在此」——'
        + 'LEAVE 後若它仍是 true，畫面會永遠說「有客服在此」而實際沒人',
    })
    return
  }

  const before = await getConversationDetail(client, convId)
  const tcu = [pick(before, 'id'), pick(before, '_id')].find(
    v => typeof v === 'string' && v.startsWith('tcu_'),
  ) as string | undefined

  if (!tcu) {
    p.record({
      question: 'D-23d',
      claim: 'LEAVE 之後 `is_agent_joined` 會轉為 false',
      verdict: 'unknown',
      evidence: '詳情裡找不到 tcu_ id，無法 JOIN／LEAVE',
    })
    return
  }

  const beforeShape = shapeOf(before)
  /**
   * ⚠️ **順序由「呼叫前是不是已經 JOIN」決定，不可寫死。**
   *
   * 兩種順序都各做一次 JOIN 與一次 LEAVE、都觀察得到同樣的轉移，
   * 差別只在**終點**：對一個已經 `mode:manual` 的對話「先 JOIN 再 LEAVE」，
   * 終點是 `automation` —— 等於把一則有人在處理的對話丟回 AI 自動回覆。
   * 反過來「先 LEAVE 再 JOIN 回原本的 mode」，終點與呼叫前完全相同。
   */
  const startedJoined = beforeShape.isJoined === true
  const restoreMode = beforeShape.mode === 'hybrid' ? 'hybrid' : 'manual'

  let afterJoin: JoinShape | null = null
  let afterLeave: JoinShape | null = null

  if (startedJoined) {
    try {
      await leaveConversation(client, tcu)
      afterLeave = shapeOf(await getConversationDetail(client, convId))
    }
    finally {
      // ⚠️ 還原：JOIN 回呼叫前的 mode。這一步 MUST 在 finally 裡 ——
      //    上面任何一步拋錯都不能讓對話停在 automation。
      await joinConversation(client, tcu, restoreMode)
      afterJoin = shapeOf(await getConversationDetail(client, convId))
    }
  }
  else {
    try {
      await joinConversation(client, tcu, 'manual')
      afterJoin = shapeOf(await getConversationDetail(client, convId))
    }
    finally {
      await leaveConversation(client, tcu)
      afterLeave = shapeOf(await getConversationDetail(client, convId))
    }
  }

  /** 呼叫結束後的實際狀態 —— 依順序不同，最後一次觀察的是不同的那一個 */
  const finalShape = startedJoined ? afterJoin : afterLeave

  p.fixture('join-transition', {
    startedJoined,
    order: startedJoined ? 'leave → join(restore)' : 'join → leave(restore)',
    before: beforeShape,
    afterJoin,
    afterLeave,
  })

  p.record({
    question: 'D-23-order',
    claim: '寫入段的順序依對話當下狀態決定，終點一律是呼叫前的狀態',
    verdict: 'yes',
    evidence: `呼叫前 is_joined=${JSON.stringify(beforeShape.isJoined)} → 採用「`
      + `${startedJoined ? 'LEAVE 觀察 → JOIN 回原 mode' : 'JOIN 觀察 → LEAVE'}」`,
  })

  p.record({
    question: 'D-23d',
    claim: 'LEAVE 之後 `is_agent_joined` 會轉為 false（而不是停留在 true）',
    verdict: afterLeave?.isAgentJoined === true ? 'no' : afterLeave?.isAgentJoined === false ? 'yes' : 'partial',
    evidence: `JOIN 前：${fmt(beforeShape)}\n    JOIN 後：${afterJoin ? fmt(afterJoin) : '—'}`
      + `\n    LEAVE 後：${afterLeave ? fmt(afterLeave) : '—'}`,
    impact: afterLeave?.isAgentJoined === false
      ? '✅ `is_agent_joined` 可用來判定「目前有沒有客服在此」，沒有 mode 的 automation 歧義'
      : '⚠️ LEAVE 後仍為 true —— 它代表的是「曾經有人 JOIN 過」而非「現在有人」，'
        + 'MUST NOT 拿來顯示「無客服在此」',
  })

  p.record({
    question: 'D-23e',
    claim: 'JOIN 後詳情的 `is_joined` 立刻反映「我在裡面」',
    verdict: afterJoin?.isJoined === true ? 'yes' : 'no',
    evidence: `JOIN 後 is_joined=${JSON.stringify(afterJoin?.isJoined)}`,
    impact: '這是 `isViewerJoined()` 的權威來源（見 conversation-context.ts）',
  })

  const restored = beforeShape.mode === finalShape?.mode
    && beforeShape.isJoined === finalShape?.isJoined
  p.record({
    question: 'D-23-safety',
    claim: 'probe 結束後對話已還原成呼叫前的狀態（mode 與 is_joined 都相同）',
    verdict: restored ? 'yes' : 'no',
    evidence: `呼叫前：${fmt(beforeShape)}\n    結束後：${finalShape ? fmt(finalShape) : '—'}`,
    impact: restored
      ? undefined
      : '🚨 這是正式環境的真實對話 —— 請人工把 mode 與 JOIN 狀態改回呼叫前的值，'
        + '並在修正前不要重跑本 probe',
  })
}

if (isMain(import.meta.url)) {
  const findings = await run()
  console.log(`\n📄 ${writeReport(findings)}`)
  console.log(`\n環境：${env('IMBRACE_ENV', 'stable')}\n`)
}
