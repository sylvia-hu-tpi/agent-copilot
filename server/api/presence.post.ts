/**
 * Presence 上報（來源 ①）—— docs/ARCHITECTURE.md §10.2。
 *
 * 前端每 20 秒送一次心跳，server 端 TTL 45 秒（容忍漏一拍）。
 *
 * ⚠️ **為何用心跳而不是「進入時上報、離開時清除」**：
 *    客服直接關掉瀏覽器、電腦休眠、網路斷掉的時候不會有「離開」這個請求。
 *    沒有 TTL 的話，同事會在畫面上看到一個永遠「正在檢視」的幽靈 ——
 *    而那正是 §10.2 禁止把「曾經發言」顯示成「正在檢視」的同一個理由：
 *    **讓客服以為有人守著而實際沒人，比不顯示更糟。**
 *
 * ⚠️ 這支同時承擔「回報分頁是否在前景」的任務，因為第一層清單輪詢的頻率
 *    依此決定（§9.2「瀏覽器分頁 hidden 全部降至 30s 以上」）。
 */

import { z } from 'zod'
import { setCredentialActivity } from '../services/credentials.js'
import { useCopilotRuntime } from '../services/copilot-runtime.js'
import { clearViewing, reportViewing, snapshotOf } from '../services/presence.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic } from '../state/types.js'
import { resolvePresenceControl, streamControlTopic, type StreamControl } from '../utils/stream-control.js'
import { assertConversationId } from '../utils/conversation-param.js'
import { requireActiveBffSession } from '../utils/session.js'
import { readBodyAs } from '../utils/validate.js'

const Body = z.object({
  conversationId: z.string().min(1),
  /** `away` = 明確離開這個對話（切走 / 關閉分頁的 beforeunload） */
  state: z.enum(['viewing', 'composing', 'joined', 'away']),
  /** ⚠️ 與 state 正交，見 PresenceEntry.joined。心跳每次都要帶對 */
  joined: z.boolean().default(false),
  /** 分頁是否在前景 —— 決定輪詢頻率 */
  visible: z.boolean().default(true),
  /**
   * 這個瀏覽器分頁的 SSE 連線 id。
   *
   * ⚠️ 為何需要它：同一位客服可能開兩個分頁看不同對話。少了它，
   *    控制訊息會廣播給該客服的**所有**連線，讓 A 分頁去訂閱 B 分頁的對話 ——
   *    多收事件本身無害（前端會依 conversationId 過濾），
   *    但會讓「訂閱數歸零即停止輪詢」這條約束失準。
   */
  clientId: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { conversationId, state, joined, visible, clientId } = await readBodyAs(event, Body)
  const convId = assertConversationId(conversationId)
  const session = await requireActiveBffSession(event)

  const store = useStateStore()
  const bus = useEventBus()

  // ⚠️ 帶 `clientId` 定址、更新該分頁**全部**命中的登記（specs/005-m2-residual-defects research.md #2）——
  //    舊簽章以客服身分整筆覆寫：兩個分頁一前景一背景時後送者贏，第一層清單輪詢在 3 秒與 30 秒之間跳。
  setCredentialActivity(session.orgId, session.operatorId, clientId, visible ? 'foreground' : 'background')

  if (state === 'away') {
    await clearViewing(store, convId, session.operatorId)
  }
  else {
    await reportViewing(
      store,
      convId,
      { id: session.operatorId, name: session.operatorName },
      state,
      joined,
    )
  }

  // 告訴自己那條 SSE 連線要（不要）訂閱這個對話。
  // ⚠️ 這是「開啟對話 → 立刻收得到訊息」的唯一途徑：SSE 連線建立時還不知道
  //    客服接下來會看哪個對話，而等下一次心跳（20 秒）才訂閱太慢。
  //
  // ⚠️ specs/002-suggestion-knowledge-search／contracts/presence-watch-control.md
  //    （憲法 v3.0.0 修訂動機的程式碼根因）：`state === 'away'` **不再**無條件等於
  //    unwatch。客服切走但仍 JOIN 著的對話，Copilot 管線 MUST 繼續以 background
  //    優先度運作——只有真的沒 JOIN（或已 LEAVE）才該 unwatch。
  //    presence-viewing（上面的 clearViewing／reportViewing）與這裡的訂閱存續是兩件事：
  //    前者回答「有沒有人在看」，後者回答「背景分析要不要繼續跑」，故意不共用同一個判斷。
  const { kind, priority } = resolvePresenceControl(state, joined, visible)

  await bus.publish(streamControlTopic(session.operatorId, clientId), {
    kind,
    conversationId: convId,
    priority,
    joined,
  } satisfies StreamControl)

  // ⚠️ 廣播版本不排除任何人、也不帶 viewerJoined —— 每個 SSE 連線收到後
  //    會依自己的身分重算（見 stream.get.ts）。
  const mode = useCopilotRuntime(session.orgId).listPoller.latest(convId)?.mode ?? null
  await useEventBus().publish(conversationTopic(convId), {
    type: 'presence.updated',
    conversationId: convId,
    presence: await snapshotOf(store, convId, { mode }),
  })

  return { ok: true }
})
