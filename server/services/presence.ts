/**
 * Presence 四來源合併 —— docs/ARCHITECTURE.md §10.2。
 *
 * | # | 來源 | 涵蓋 | 延遲 | 能否指出「是誰」 |
 * |---|---|---|---|---|
 * | ① | 自家 SSE 上報 | 只涵蓋我方使用者 | < 200ms | ✅ 可，高可信度 |
 * | ② | 訊息 `u_` 前綴反推 | 涵蓋官方介面的同事 | 一個輪詢週期 | ✅ 可，但只在對方發言後 |
 * | ③ | `mode ∈ {manual, hybrid}` | 所有「能送出訊息」的人 | 一個清單輪詢週期 | ❌ **只知道有人，不知是誰** |
 * | ④ | JOIN/LEAVE webhook | 全涵蓋 | 即時 | 待規格（M4） |
 *
 * ── 這個模組最容易寫錯的地方 ─────────────────────────────────────
 * ⚠️ **② 不可顯示成「正在檢視」。** 「曾經發言」不等於「現在還在」。
 *    誤導客服以為有人守著而實際沒人，比不顯示更糟 —— 所以 `source` 欄位
 *    不是除錯資訊，是 UI 的必要輸入，必須原樣傳到前端。
 *
 * ⚠️ **③ 塞不進 `PresenceEntry`。** 它沒有 operatorId 也沒有名字。
 *    硬塞就得捏造，因此它落在 `PresenceSnapshot.unidentifiedActor` 這個獨立欄位。
 *
 * ⚠️ **空狀態是常態，不是例外。** 單人使用時①為空、無人發言時②為空 ——
 *    PresenceBar 大多數時候會是空的，設計上要讓「無人／未知」看起來正常。
 */

import type {
  ConversationMode,
  Message,
  PresenceEntry,
  PresenceState,
} from '../../shared/types/conversation.js'
import { someoneElseCanSend } from '../../shared/types/conversation.js'
import type { PresenceSnapshot } from '../../shared/types/events.js'
import type { StateStore } from '../state/types.js'
import { operatorName } from './directory.js'

/**
 * ① 的存活時間。前端每 20 秒送一次心跳，這裡容忍漏一拍。
 *
 * ⚠️ 不可設得太長：客服直接關掉瀏覽器時不會有 LEAVE，只能靠 TTL 讓他消失。
 *    設成 5 分鐘的話，同事會看到一個「正在檢視」的幽靈，那正是 ② 被禁止顯示成
 *    「正在檢視」的同一個理由。
 */
export const PRESENCE_TTL_MS = 45_000

/** 前端心跳間隔（供前端 composable 共用同一個常數） */
export const PRESENCE_HEARTBEAT_MS = 20_000

/** ② 的反推窗口 —— §10.2「N 預設 10 分鐘，可設定」 */
export const MESSAGE_INFERENCE_WINDOW_MS = 10 * 60 * 1000

/**
 * ①：客服在 AgentCopilot 內開著這個對話。
 *
 * ⚠️ `joined` 必須每次都帶對的值。心跳會覆寫整筆條目，
 *    少帶就等於「客服一開始打字就變回沒 JOIN」（見 PresenceEntry.joined 的說明）。
 */
export async function reportViewing(
  store: StateStore,
  conversationId: string,
  operator: { id: string, name: string },
  state: PresenceState,
  joined: boolean,
): Promise<void> {
  await store.addPresence(
    conversationId,
    {
      operatorId: operator.id,
      operatorName: operator.name,
      state,
      joined,
      source: 'sse',
      at: new Date().toISOString(),
    },
    PRESENCE_TTL_MS,
  )
}

export async function clearViewing(
  store: StateStore,
  conversationId: string,
  operatorId: string,
): Promise<void> {
  await store.removePresence(conversationId, operatorId)
}

/**
 * ②：從新到的訊息反推「最近發言過的客服」。
 *
 * ⚠️ **不可覆蓋同一個人的 ① 條目。** ① 說「此刻開著這個對話」，② 只說「發言過」——
 *    後者覆蓋前者是資訊降級，畫面上會看到同事從「正在輸入…」退回「3 分鐘前回覆過」，
 *    而他其實還在打字。
 *
 * @param excludeOperatorId 自己。看到「我 1 分鐘前回覆過」沒有意義，也會擠掉真正該看的人。
 */
export async function inferFromMessages(
  store: StateStore,
  conversationId: string,
  messages: Message[],
  opts: { orgId: string, excludeOperatorId?: string },
): Promise<void> {
  const cutoff = Date.now() - MESSAGE_INFERENCE_WINDOW_MS
  const existing = new Map(
    (await store.listPresence(conversationId)).map(e => [e.operatorId, e]),
  )

  // 同一人多則訊息時只留最新的一則
  const latestByOperator = new Map<string, Message>()
  for (const m of messages) {
    if (m.sender.type !== 'agent') continue
    const id = m.sender.id
    if (!id || id === opts.excludeOperatorId) continue
    if (new Date(m.at).getTime() < cutoff) continue

    const prev = latestByOperator.get(id)
    if (!prev || new Date(m.at).getTime() > new Date(prev.at).getTime()) {
      latestByOperator.set(id, m)
    }
  }

  for (const [id, m] of latestByOperator) {
    if (existing.get(id)?.source === 'sse') continue

    await store.addPresence(
      conversationId,
      {
        operatorId: id,
        // ⚠️ 查不到名字時**留白**，不可編一個 —— 見 directory.ts
        operatorName: m.sender.name ?? operatorName(opts.orgId, id) ?? '',
        // ⚠️ 不可寫成 'viewing'：「曾經發言」不等於「現在還在」（§10.2）
        state: 'joined',
        // ⚠️ 也不可推論成 joined=true：他發言時確實有送出權，但那是過去式，
        //    而這個欄位餵的是「現在能不能送」的判斷。
        joined: false,
        source: 'message',
        at: m.at,
      },
      MESSAGE_INFERENCE_WINDOW_MS,
    )
  }
}

/**
 * 合併出給前端的快照。
 *
 * @param excludeOperatorId 把自己排除掉 —— PresenceBar 顯示的是「還有誰」。
 * @param viewerJoined 檢視者自己有沒有 JOIN 這個對話。⚠️ 見下方 `unidentifiedActor` 的說明。
 */
export async function snapshotOf(
  store: StateStore,
  conversationId: string,
  opts: {
    mode: ConversationMode | null
    excludeOperatorId?: string
    viewerJoined?: boolean
  },
): Promise<PresenceSnapshot> {
  const entries = await store.listPresence(conversationId)
  const operators = entries
    .filter(e => e.operatorId !== opts.excludeOperatorId)
    // ① 排在 ② 前面：可信度高的先顯示
    .sort((a, b) => sourceRank(a) - sourceRank(b) || b.at.localeCompare(a.at))

  // 沒有明講時，從檢視者自己的 presence 條目推 —— JOIN 路由會把它設成 joined
  const viewerJoined = opts.viewerJoined
    ?? entries.some(e => e.operatorId === opts.excludeOperatorId && e.joined)

  return {
    operators,
    unidentifiedActor: hasUnidentifiedActor(opts.mode, {
      viewerJoined,
      namedCount: operators.length,
    }),
    mode: opts.mode,
  }
}

/**
 * ③ 的判定 —— **這裡有一個很容易寫成假警報的地方**。
 *
 * `mode` 是對話層級的共用狀態：**我自己按下 JOIN，mode 就會變成 `manual`**。
 * 因此「mode ∈ {manual, hybrid}」單獨看不能推出「有別人」——
 * 少了 `viewerJoined` 這個條件的話，每位客服 JOIN 之後都會立刻看到
 * 「有同事正在處理」，而那個同事就是他自己。
 *
 * 假警報比沒有警報更糟（§10.4）：客服學會忽略提示後，真正的撞單也會被一併略過。
 *
 * ⚠️ 代價要誠實標示：**我 JOIN 之後，來源 ③ 就失明了** ——
 *    我方的 `manual` 會把同事的 `manual` 蓋掉，兩者無法區分。
 *    這個缺口由 §10.4 的送出前檢查兜底，那一層本來就是真正有效的防線。
 */
export function hasUnidentifiedActor(
  mode: ConversationMode | null | undefined,
  ctx: { viewerJoined: boolean, namedCount: number },
): boolean {
  if (!someoneElseCanSend(mode)) return false
  // 我自己就是 mode 的成因 —— 這個訊號此刻不帶任何「別人」的資訊
  if (ctx.viewerJoined) return false
  // 已經知道是誰了，再說一次「有無法確認身分的人」會被讀成「另外還有人」
  return ctx.namedCount === 0
}

function sourceRank(e: PresenceEntry): number {
  return e.source === 'sse' ? 0 : e.source === 'webhook' ? 1 : 2
}
