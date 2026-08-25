/**
 * SSE 推播 —— docs/ARCHITECTURE.md §9.5。
 *
 * 一條連線同時承擔三件事：
 *   ① 訂閱組織層級事件（側欄的對話清單變動）
 *   ② 依控制通道動態訂閱／退訂個別對話（見 utils/stream-control.ts）
 *   ③ 把自己的憑證登記給背景輪詢借用（見 services/credentials.ts）
 *
 * ⚠️ **③ 的取消登記必須確實執行**，否則客服關掉分頁後，
 *    輪詢仍會用他的 token 繼續打 API —— 那不只浪費，稽核上也說不通。
 *    因此 `onClosed` 裡的清理是這支路由最重要的一段。
 *
 * ⚠️ **心跳不可省略。** 中間的 proxy 常在 60 秒無資料時直接切斷連線，
 *    而症狀會是「放著不動一分鐘後就再也收不到訊息」——
 *    前端雖然會自動重連，但每次重連都要重跑一輪對帳，白白付出成本。
 */

import { controlFromMode } from '../../shared/types/conversation.js'
import type { CopilotEvent } from '../../shared/types/events.js'
import { STREAM_HEARTBEAT_MS } from '../../shared/types/events.js'
import { useCopilotRuntime } from '../services/copilot-runtime.js'
import { registerCredential } from '../services/credentials.js'
import { snapshotOf } from '../services/presence.js'
import { watchConversation } from '../services/session-manager.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic, organizationTopic } from '../state/types.js'
import type { Unsubscribe } from '../state/types.js'
import { assertConversationId } from '../utils/conversation-param.js'
import { requireActiveBffSession } from '../utils/session.js'
import { isStreamControl, streamControlTopic } from '../utils/stream-control.js'

export default defineEventHandler(async (event) => {
  const session = await requireActiveBffSession(event)
  const clientId = String(getQuery(event).clientId ?? '')
  if (!clientId) throw createError({ statusCode: 400, message: '缺少 clientId' })

  const bus = useEventBus()
  const store = useStateStore()
  const runtime = useCopilotRuntime(session.orgId)
  const stream = createEventStream(event)

  let seq = 0
  const send = async (evt: CopilotEvent): Promise<void> => {
    await stream.push({ id: String(++seq), data: JSON.stringify(evt) })
  }

  /**
   * ⚠️ 事件處理必須排隊。
   *
   * EventBus 的 handler 是同步的，但 presence 重算要讀 store（async）。
   * 直接 `void handle(evt)` 的話，兩個事件的非同步段會交錯 ——
   * 後到的 presence 快照可能先送出去，畫面上的同事會閃一下又跳回舊狀態。
   */
  let tail: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void>): void => {
    tail = tail.then(fn).catch(err =>
      console.error('[stream] 事件處理失敗:', err instanceof Error ? err.message : String(err)),
    )
  }

  const cleanups: Unsubscribe[] = []
  /** conversationId → 該對話的清理（退訂 topic + 解除 watcher） */
  const watched = new Map<string, Unsubscribe>()

  // ── ③ 借憑證給背景輪詢（唯讀）─────────────────────────────────
  cleanups.push(registerCredential({
    operatorId: session.operatorId,
    orgId: session.orgId,
    accessToken: session.accessToken,
  }))

  // ── ① 組織層級：側欄清單的變動 ────────────────────────────────
  cleanups.push(bus.subscribe(organizationTopic(session.orgId), (payload) => {
    enqueue(() => send(payload as CopilotEvent))
  }))

  // ── ② 控制通道：動態訂閱個別對話 ──────────────────────────────
  cleanups.push(bus.subscribe(
    streamControlTopic(session.operatorId, clientId),
    (payload) => {
      if (!isStreamControl(payload)) return
      enqueue(async () => {
        const convId = assertConversationId(payload.conversationId)
        if (payload.kind === 'unwatch') {
          watched.get(convId)?.()
          watched.delete(convId)
          return
        }
        if (watched.has(convId)) return
        watched.set(convId, await attach(convId, payload.priority, payload.joined))
      })
    },
  ))

  /**
   * 開始監看一個對話：訂閱 topic + 登記 watcher（後者才會啟動輪詢）。
   *
   * ⚠️ 順序是「先訂 topic 再 watch」：反過來的話，watch 觸發的首次拉取
   *    可能在 topic 訂閱建立前就 publish 完畢，客服會漏掉第一批訊息。
   */
  async function attach(
    conversationId: string,
    priority: 'foreground' | 'background',
    joined: boolean,
  ): Promise<Unsubscribe> {
    const offTopic = bus.subscribe(conversationTopic(conversationId), (payload) => {
      enqueue(() => forward(conversationId, payload as CopilotEvent))
    })

    const offWatch = await watchConversation({
      conversationId,
      orgId: session.orgId,
      operator: { id: session.operatorId, name: session.operatorName },
      priority,
      joined,
    })

    // 立刻送一次目前狀態，不必等下一次變動
    const mode = runtime.listPoller.latest(conversationId)?.mode ?? null
    await send({
      type: 'control.updated',
      conversationId,
      control: controlFromMode(mode),
    })
    await forward(conversationId, {
      type: 'presence.updated',
      conversationId,
      presence: await snapshotOf(store, conversationId, { mode }),
    })

    return () => {
      offTopic()
      offWatch()
    }
  }

  /**
   * 送出前依「收訊者自己的身分」重算 presence。
   *
   * ⚠️ publish 端算的是廣播版本（不排除任何人）。直接轉發的話，
   *    客服會在 PresenceBar 上看到自己 —— 而 PresenceBar 要回答的是「還有誰」。
   */
  async function forward(conversationId: string, evt: CopilotEvent): Promise<void> {
    if (evt.type !== 'presence.updated') return send(evt)

    const personal = await snapshotOf(store, conversationId, {
      mode: evt.presence.mode,
      excludeOperatorId: session.operatorId,
    })
    return send({ type: 'presence.updated', conversationId, presence: personal })
  }

  const heartbeat = setInterval(() => {
    enqueue(() => send({ type: 'stream.heartbeat', at: new Date().toISOString() }))
  }, STREAM_HEARTBEAT_MS)
  heartbeat.unref?.()

  stream.onClosed(async () => {
    clearInterval(heartbeat)
    for (const off of watched.values()) off()
    watched.clear()
    for (const off of cleanups) off()
    await stream.close()
  })

  return stream.send()
})
