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
import {
  cancelPendingAnalysis,
  catchUpSummaryIfStale,
  hasSuggestionTail,
  lastCoveredMessageId,
  newCustomerMessagesSince,
  runIncremental,
  settleOrphanedPendingCitation,
} from '../services/copilot-analysis.js'
import { useCopilotRuntime } from '../services/copilot-runtime.js'
import { registerCredential } from '../services/credentials.js'
import { snapshotOf } from '../services/presence.js'
import { watchConversation } from '../services/session-manager.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic, organizationTopic } from '../state/types.js'
import type { Unsubscribe } from '../state/types.js'
import { assertConversationId } from '../utils/conversation-param.js'
import { requireActiveBffSession } from '../utils/session.js'
import {
  createWatchRegistry,
  isStreamControl,
  shouldForwardToConnection,
  streamControlTopic,
} from '../utils/stream-control.js'

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
  /**
   * 這條連線目前監看中的對話。
   * ⚠️ 註冊表本身抽在 `utils/stream-control.ts`，那裡才有單元測試守著
   *    「重連復原」與「優先度升級」兩條規則（test/stream-reconnect-background.test.ts）。
   */
  const watchers = createWatchRegistry(attach)

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
          watchers.unwatch(convId)
          return
        }
        // ⚠️ research.md #8 決策 3：即使已在監看中，優先度可能改變（例如客服切回
        //    這個背景對話變成前景）——不可因為「已經在監看中」就直接略過，
        //    否則第二次 watch 訊息永遠更新不到優先度。`watchers.watch()` 一律先解除
        //    舊訂閱再以新優先度重新 attach()。
        await watchers.watch(convId, payload.priority, payload.joined)
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

    // ⚠️ **這條連線對這個對話有沒有 JOIN**（specs/003-analysis-trigger-policy 不變式 C）。
    //    下面兩段補跑與快照都以它為門檻。用 `joined` 參數而非 `watchers.isJoined()`：
    //    兩者此刻必然相同（註冊表在 attach 之前就寫入了），但參數才是這一次 attach 的真相。
    const viewerJoined = joined

    // 情緒面板重連快照 + 補跑（specs/001-sentiment-panel FR-010，T010c）——
    // ⚠️ 純 SSE 推播只在狀態變動時發事件；若離開期間沒有新客戶發言就不會有任何事件，
    //    重新連線的前端會永遠拿不到已保留的結果，因此必須像 control.updated 一樣主動送一次快照。
    //
    // ⚠️ **未 JOIN 時整段跳過**（FR-003、FR-016a）：快照走的是 `send()`、**不經 `forward()`**，
    //    因此 `forward()` 裡的過濾對它完全無效。漏掉的症狀是「未接手的客服一連上線就收到
    //    完整三個 Block」—— 畫面上雖然沒有面板，資料已經在他的瀏覽器裡，SC-006 在伺服器端不成立。
    if (viewerJoined) {
      void sendAnalysisSnapshotAndResume(conversationId, priority, controlFromMode(mode).aiReplies)
    }

    // US4 AC#5：客服重新聚焦（切回前景）背景對話時，摘要才補跑（FR-020、research.md #10）——
    // 與上面的重連快照並列呼叫，不是同一件事：快照送的是「已有的結果」，這裡補的是
    // 「背景期間被跳過、還沒生成」的摘要。
    // ⚠️ 同樣受 JOIN 門檻約束（003 FR-004 已補上「限已 JOIN」限定語）——它也是一條會呼叫 AI 的路徑。
    if (priority === 'foreground' && viewerJoined) {
      void runtime.messageSource.fetchSince(conversationId)
        .then(history => catchUpSummaryIfStale(conversationId, history))
        .catch(err => console.error(`[stream] ${conversationId} 摘要補跑失敗:`, err instanceof Error ? err.message : String(err)))
    }

    // FR-013 的清理層：這一次 watch 帶著 `joined: false` 抵達（客服按下離開／結案時，
    // 前端會**立刻**補送一次 `beat('viewing')`，一個往返內就到，SC-002 的 5 秒門檻有餘裕），
    // 就把還沒觸發的 debounce 排程清掉，不留一個空轉的計時器。
    //
    // ⚠️ 判斷用 `messageSource.isJoined()`（對話層級聚合）而非本次的 `joined`：
    //    同事仍 JOIN 時我的離開 MUST NOT 停掉整個對話的分析（FR-014）。
    // ⚠️ 選在這一層而不是 `leave.post.ts`：後者維持「一行未動」（憲法七的檢核前提），
    //    `server/sources/` 也不必反向相依 `server/services/`。
    if (!runtime.messageSource.isJoined(conversationId)) cancelPendingAnalysis(conversationId)

    return () => {
      offTopic()
      offWatch()
    }
  }

  /**
   * FR-010：客服切回對話時立即看到已保留的摘要／情緒結果，並補跑一次以納入
   * 離開期間累積的客戶發言。⚠️ 快照失敗（含補跑判斷本身）不得影響這條 SSE 連線的
   * 其餘功能（憲法 3.2）——僅記錄，不拋出。
   */
  async function sendAnalysisSnapshotAndResume(
    conversationId: string,
    priority: 'foreground' | 'background',
    aiReplies: boolean,
  ): Promise<void> {
    try {
      let analysisState = await store.getAnalysisState(conversationId)
      if (!analysisState) return

      /**
       * ⚠️ **004 契約 §4**：`citation: 'pending'` 代表「第二段還在跑」，而尾巴是**執行期**
       * 狀態（`suggestionTails`），程序重啟就消失。重啟後這個 `'pending'` 沒有任何路徑會
       * 再落定它——客服會永遠看到「檢索中」，而 `status` 是 `ready`、卡片可用，
       * 沒有任何錯誤跡象。有尾巴在跑時照送 `'pending'`，尾巴落地會再推一次。
       *
       * ⚠️ 這個修正 MUST 放在**這裡**（快照路徑），不是 `forward()`：快照走 `send()`、
       *    不經那條即時推播路徑，放錯地方對快照完全無效（003 踩過同一個陷阱）。
       */
      if (analysisState.suggestionBlock.citation === 'pending' && !hasSuggestionTail(conversationId)) {
        analysisState = await settleOrphanedPendingCitation(conversationId)
      }

      await send({ type: 'summary.updated', conversationId, summary: analysisState.summaryBlock })
      await send({ type: 'sentiment.updated', conversationId, sentiment: analysisState.sentimentBlock })
      await send({ type: 'suggestion.updated', conversationId, suggestion: analysisState.suggestionBlock })

      const since = await runtime.messageSource.fetchSince(conversationId, lastCoveredMessageId(analysisState))
      // ⚠️ fetchSince() 的「找不到錨點時回傳整批」約定要求呼叫端自行去重，
      // 見 newCustomerMessagesSince() 的說明
      const newCustomerMessages = newCustomerMessagesSince(analysisState, since)
      if (newCustomerMessages.length > 0) {
        void runIncremental(conversationId, newCustomerMessages, priority, aiReplies)
      }
    }
    catch (err) {
      console.error(`[stream] ${conversationId} 情緒面板重連快照失敗:`, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 送出前依「收訊者自己的身分」重算 presence。
   *
   * ⚠️ publish 端算的是廣播版本（不排除任何人）。直接轉發的話，
   *    客服會在 PresenceBar 上看到自己 —— 而 PresenceBar 要回答的是「還有誰」。
   */
  async function forward(conversationId: string, evt: CopilotEvent): Promise<void> {
    // ⚠️ 面板可見 ⟺ 該客服已 JOIN（specs/003-analysis-trigger-policy 不變式 C、FR-016a）。
    //    未 JOIN 時面板整欄不存在，這三個事件沒有消費者 —— 送過去只會在背景更新一份
    //    看不見的 store，重新 JOIN 或切換對話時閃出一份「不知何時來的」舊內容。
    //
    // ⚠️ **過濾範圍恰為這三個**。`messages.appended`／`presence.updated`／`control.updated`／
    //    `conversation.updated`／`session.*`／`stream.heartbeat` 服務的是中欄與連線本身，
    //    與 JOIN 無關（US2 AC#3 明文要求中欄一切照常）；
    //    尤其 `stream.heartbeat` 過濾掉會直接讓連線被中間 proxy 切斷。
    //    完整清單以 contracts/analysis-trigger-contract.md 不變式 C 的表格為準。
    //
    // ⚠️ 判斷資料取自 `WatchRegistration.joined`（`watchers.isJoined()`）——
    //    那是「這條連線對這個對話有沒有 JOIN」的**唯一**真相來源，
    //    MUST NOT 另立第二份記錄（兩份必然不同步，症狀極難追查）。
    //
    // ⚠️ 這裡擋的只是**即時推播**。連線建立時的分析快照走 `send()`、不經本函式，
    //    在 `attach()` 裡另外擋（見該處）—— 只擋一條等於沒擋。
    if (!shouldForwardToConnection(evt.type, watchers.isJoined(conversationId))) return

    if (evt.type !== 'presence.updated') return send(evt)

    const personal = await snapshotOf(store, conversationId, {
      mode: evt.presence.mode,
      excludeOperatorId: session.operatorId,
    })
    return send({ type: 'presence.updated', conversationId, presence: personal })
  }

  // ⚠️ **根因已定位（2026-08-27）**：h3 的 `EventStream` 從不呼叫 `res.flushHeaders()`——
  // Node 的預設行為是「回應標頭與第一個 write() 一起送上線路」，在那之前 client 端的
  // `fetch()` 連 headers 都收不到。一條「目前沒有任何已 JOIN 對話」的全新連線
  // （例如客服只是 viewing、從未 JOIN）在建立當下沒有任何事件要送，於是完全卡住，
  // 直到下一次 `STREAM_HEARTBEAT_MS`（25 秒）心跳送出第一個位元組才解凍——
  // 曾誤判是下面這段 T056 背景 watch 復原迴圈的邏輯競態（見 git 歷史 646a3cb 的長篇排查
  // 記錄），但逐行加時間戳記追蹤後證實無關：停用這段迴圈、單純開一條未 JOIN 任何對話的
  // 連線一樣會卡住。T056 只是「意外治好」了已 JOIN 客服的這條連線（因為它讓連線一開始
  // 就有東西可送），因而讓從未 JOIN、只是 viewing 的另一位客服（`test/realtime-http.ts`
  // 的 browser-b）成為第一個踩到既有缺陷的案例。修法：連線建立時無條件送一次心跳，
  // 強制立即 flush，不必等待任何對話相關事件。
  enqueue(() => send({ type: 'stream.heartbeat', at: new Date().toISOString() }))

  // 第零步：連線建立（含重連、含瀏覽器重新整理後的全新連線）時，復原此客服所有已 JOIN
  // 對話的背景 watch（research.md #8 決策 4）——沒有這一步，只有「當下正在看」的那個對話
  // 會在新連線建立後被重新 attach()，其餘已 JOIN 但背景的對話會在斷線的當下悄悄停止分析。
  //
  // ⚠️ MUST 經由 `enqueue()`（不可 `await` 阻擋在 `return stream.send()` 之前，也不可自己另開
  // 一條不經 enqueue 的 fire-and-forget 分支）：
  //   ① 提前呼叫會讓這次連線的 handshake 卡住（`attach()` 內部呼叫 `send()`／`stream.push()`，
  //      但連線要等 `stream.send()` 真正被呼叫後才開始送資料給 client；已用 vitest 級的
  //      smoke 手動重現過）。
  //   ② 若走獨立的 fire-and-forget（不經 enqueue），會跟稍後客服自己送出的第一次 presence
  //      心跳（觸發同一個 convId 的 attach()）產生競態：兩者都可能通過 `watched.has()` 檢查、
  //      各自建立一份訂閱，其中一份會變成孤兒（`watched` 只留得住最後寫入的那份 cleanup）。
  //      經 `enqueue()` 排進同一條佇列，可確保這裡永遠先跑完，客服的第一次心跳才不會撞期。
  //      ⚠️ 2026-08-28 起 `watch()` 只在 `{priority, joined}` 真的改變時才解舊建新
  //      （specs/003-analysis-trigger-policy 不變式 A）—— 上面的競態因此更不可能發生，
  //      但 `enqueue()` 仍是必要的：`restoreJoined()` 與第一次心跳的**先後**才是這裡要保證的東西。
  enqueue(() => watchers.restoreJoined(() => store.listJoinedConversations(session.operatorId)))

  const heartbeat = setInterval(() => {
    enqueue(() => send({ type: 'stream.heartbeat', at: new Date().toISOString() }))
  }, STREAM_HEARTBEAT_MS)
  heartbeat.unref?.()

  stream.onClosed(async () => {
    clearInterval(heartbeat)
    watchers.closeAll()
    for (const off of cleanups) off()
    await stream.close()
  })

  return stream.send()
})
