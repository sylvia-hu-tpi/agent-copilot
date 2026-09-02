/**
 * CopilotSession 生命週期 —— docs/ARCHITECTURE.md §4.2 / §9.1。
 *
 * 一句話：**誰在看哪個對話，以及那個對話該不該被輪詢。**
 *
 * ── 兩層 refcount，不是一層 ─────────────────────────────────────
 * ⚠️ 這裡最容易寫錯的是「讓每個 SSE 連線各自訂閱 messageSource，並在回呼裡
 *    publish 到 EventBus」。那樣寫，N 個連線會產生 N 次 publish，
 *    而每個連線又都訂著同一個 topic —— 客服會收到 N 份一模一樣的訊息。
 *    症狀是「同一則訊息在畫面上出現三次」，且人越多越嚴重。
 *
 * 因此分成兩種訂閱：
 *
 *   ① **publisher**（每個對話恰好一份）：把輪詢結果 publish 到 EventBus。
 *      由本模組在 refcount 0→1 時建立、1→0 時拆掉。
 *   ② **watcher**（每個連線一份）：只負責把自己的 priority / joined 帶進
 *      messageSource 的頻率聚合（§9.2），回呼刻意是空的。
 *
 *   publisher 一律以最不積極的 priority 訂閱，才不會把頻率聚合結果拉高 ——
 *   它不是「有人在看」，只是一根管線。
 */

import { controlFromMode } from '../../shared/types/conversation.js'
import type { Message } from '../../shared/types/conversation.js'
import type { CopilotEvent } from '../../shared/types/events.js'
import type { Unsubscribe, WatchPriority } from '../sources/types.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic } from '../state/types.js'
import type { CopilotSession } from '../state/types.js'
import { checkSuggestionsSuperseded, scheduleIncremental } from './copilot-analysis.js'
import { useCopilotRuntime } from './copilot-runtime.js'
import { inferFromMessages } from './presence.js'
import {
  acquirePipeline,
  attachWatcher,
  detachWatcher,
  releasePipelineRef,
} from './session-registry.js'

// ⚠️ 計數本身（`session.watchers` 與 `pipeline.refs`）住在 `session-registry.ts`，不在本檔 ——
//    本檔 import `copilot-runtime.ts`，vitest／tsc 碰不得（理由見該檔檔頭）。FR-004 的等式
//    `watchers.length === pipeline.refs` 由 `test/connection-counting.test.ts` 對那個模組驗；
//    監控用的 `pipelineCount()` 也從那裡 import，本檔不再 re-export（單一出處）。

export interface WatchRequest {
  conversationId: string
  orgId: string
  operator: { id: string, name: string }
  /**
   * 這條 SSE 連線的 server 端識別（`stream.get.ts` 以 `crypto.randomUUID()` 產生）——
   * `session.watchers` 與 refcount 的單位（specs/005-m2-residual-defects research.md #1）。
   * ⚠️ MUST NOT 傳前端的 `clientId`：複製分頁會共用它。
   */
  connectionId: string
  priority: WatchPriority
  /** 已 JOIN 的對話輪詢較密（§9.2）—— 撞單風險只存在於已 JOIN 的對話 */
  joined: boolean
}

/**
 * 開始檢視一個對話。
 *
 * @returns 停止檢視的函式。**必須**在 SSE 連線關閉時呼叫 ——
 *          沒呼叫的話該對話會被永遠輪詢下去（憲法 6.1「訂閱數歸零即停止」）。
 *          只解除**這一條連線**的那一筆；同一位客服的其他分頁完全不受影響（FR-003、I-8）。
 */
export async function watchConversation(req: WatchRequest): Promise<Unsubscribe> {
  const { conversationId, orgId, operator, connectionId } = req
  const runtime = useCopilotRuntime(orgId)

  /**
   * ⚠️ `isResume` 的語意在 005 改變了（data-model.md §2）：現在是「這個對話在我 attach 之前
   *    已經有人在看」，不再區分那個人是不是自己 —— 同一位客服的第二個分頁由 `join` 變成 `resume`。
   *    `session.opened` 的 `reason` 目前無前端消費者，這裡只是如實反映連線計數。
   */
  const { isResume } = await attachWatcher(conversationId, { operatorId: operator.id, connectionId })

  // ① publisher：整個對話只有這一份（0→1 時才建立），priority 取最不積極值
  acquirePipeline(conversationId, () => runtime.messageSource.subscribe(
    conversationId,
    (messages) => {
      void onMessages(conversationId, orgId, operator.id, messages)
    },
    { priority: 'background', joined: false },
  ))

  // ② watcher：只帶頻率資訊，不做事
  const unsubscribeWatcher = runtime.messageSource.subscribe(
    conversationId,
    () => {},
    { priority: req.priority, joined: req.joined },
  )

  await publish(conversationTopic(conversationId), {
    type: 'session.opened',
    conversationId,
    reason: isResume ? 'resume' : 'join',
  })

  let done = false
  return () => {
    if (done) return
    done = true
    unsubscribeWatcher()
    void releasePipeline(conversationId, connectionId)
  }
}

/**
 * 目前的 CopilotSession。
 *
 * ⚠️ **匯出後從未被呼叫**（docs/ARCHITECTURE.md §18）。
 * `CopilotSession.lastMessageId` 不是撞單檢查的版本錨點（那是前端的
 * `baseMessageId`，見 server/api/messages/index.post.ts），也不是 §9.3
 * 輪詢去重的比對基準（那是 `PollingMessageSource` 自己的 `entry.lastMessageId`）。
 * M2 若要開始依賴這個欄位，先讀該章節。
 */
export async function copilotSessionOf(conversationId: string): Promise<CopilotSession | null> {
  return useStateStore().getCopilotSession(conversationId)
}

/**
 * 送出訊息後把錨點往前推。
 *
 * ⚠️ 不做這件事的話，自己剛送出的那則會在下一輪輪詢時被當成「新訊息」再 fan-out 一次，
 *    而 §10.4 的撞單檢查是以 `sender.id !== me` 過濾，不會誤判成撞單 ——
 *    但畫面上會看到自己的訊息閃一下重新插入。
 */
export async function advanceAnchor(conversationId: string, lastMessageId: string): Promise<void> {
  const store = useStateStore()
  const session = await store.getCopilotSession(conversationId)
  if (!session) return
  await store.setCopilotSession({ ...session, lastMessageId, updatedAt: Date.now() })
}

// ── 內部 ────────────────────────────────────────────────────────────────

/**
 * 一條連線關閉（或主動 unwatch）時的清理：`watchers` 與 refcount 各減這一筆（I-4 在完成後成立）。
 *
 * ⚠️ 這是「關掉分頁」那條路。「主動離開對話」走 `leave.post.ts` → `removeJoinedConversation()`
 *    ＋ 廣播 `control.updated`，**完全不經這裡**（research.md #6）—— 兩條路 MUST NOT 統一：
 *    離開是關於「這個人」的決定（該客服所有分頁一起消失，003 T032a），關線只是少了一條連線。
 *    `test/contract-guards.test.ts` 守著 `leave.post.ts` 不得出現 `releasePipeline`／`connectionId`。
 */
async function releasePipeline(conversationId: string, connectionId: string): Promise<void> {
  await detachWatcher(conversationId, connectionId)

  if (releasePipelineRef(conversationId) !== 'closed') return

  await publish(conversationTopic(conversationId), {
    type: 'session.closed',
    conversationId,
    reason: 'leave',
  })
}

/**
 * 輪詢拿到新訊息時的唯一入口。
 *
 * 順序有意義：先更新錨點，再算 presence，最後才推播 ——
 * 反過來的話，前端可能在 presence 還沒更新前就收到訊息，
 * PresenceBar 會晚一拍才出現「李小華 剛剛回覆過」。
 */
async function onMessages(
  conversationId: string,
  orgId: string,
  viewerOperatorId: string,
  messages: Message[],
): Promise<void> {
  if (messages.length === 0) return
  const store = useStateStore()

  const last = messages[messages.length - 1]
  if (last) await advanceAnchor(conversationId, last.id)

  // ② presence：訊息 `u_` 前綴反推（§10.2 來源 ②）
  //
  // ⚠️ 這裡排除的是「建立 pipeline 的那位客服」，不一定等於每個收訊者自己。
  //    正確的排除在 SSE 送出前依收訊者身分重算（server/api/stream.get.ts）。
  await inferFromMessages(store, conversationId, messages, {
    orgId,
    excludeOperatorId: viewerOperatorId,
  })

  // 情緒／建議卡增量觸發（specs/001-sentiment-panel FR-004、FR-005；
  // specs/002-suggestion-knowledge-search T019、T021）——
  // ⚠️ 只有客戶發言才觸發重新分析；客服自己送出的訊息 MUST NOT 觸發（FR-005）。
  //    debounce（1 秒聚合）由 scheduleIncremental() 內部處理，這裡只負責過濾。
  const customerMessages = messages.filter(m => m.sender.type === 'customer')
  if (customerMessages.length > 0) {
    // ⚠️ 兩者刻意在同一處一次算齊：priority 取自 messageSource（§9.2 聚合規則同一份），
    //    aiReplies MUST 一律以 controlFromMode() 推導，MUST NOT 寫成 mode === 'hybrid'
    //    （FR-016，§10.2／§10.6 記錄過的靜默失效地雷）。
    const runtime = useCopilotRuntime(orgId)
    const priority = runtime.messageSource.getPriority(conversationId)
    const aiReplies = controlFromMode(runtime.listPoller.latest(conversationId)?.mode).aiReplies
    scheduleIncremental(conversationId, customerMessages, priority, aiReplies)
  }

  // FR-015：同事回覆或 AI 自動回覆抵達時，檢查既有建議卡是否已被搶答（US4 AC#2）
  void checkSuggestionsSuperseded(conversationId, messages)

  await publish(conversationTopic(conversationId), {
    type: 'messages.appended',
    conversationId,
    messages,
  })
}

async function publish(topic: string, event: CopilotEvent): Promise<void> {
  await useEventBus().publish(topic, event)
}
