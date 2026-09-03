/**
 * Provider 介面定義 —— docs/ARCHITECTURE.md §8.1、憲法第二條。
 *
 * 這些介面存在的唯一目的：**讓 iMBrace 的 webhook 規格未定不會阻塞 M1**。
 * M1 全部走輪詢實作，M4 規格到位後換成 webhook 實作，上層邏輯一行不動。
 *
 * ⚠️ 憲法 2.2：若替換實作需要改動 SessionManager 或任何 API 路由，
 *    代表邊界劃錯了，應先修邊界而不是改上層。
 */

import type {
  Conversation,
  ConversationMode,
  Message,
} from '../../shared/types/conversation.js'

export type Unsubscribe = () => void

// ── 對話層級的變動事件（§9.3.1 第一層清單輪詢）──────────────────────────

/**
 * 一次清單輪詢比對出的變動。
 *
 * ⚠️ 這**不是** §8.1 原本設想的 `JoinEvent`。原設計是靠比對 `users[]` 推斷誰 JOIN 了，
 *    但 §10.2 二次實測確認 `users[]` 是團隊名冊而非對話參與者 ——
 *    **清單輪詢無論如何都答不出「是誰」**，只答得出「有沒有人能送出訊息」。
 *    硬要維持 JoinEvent 的形狀，就得捏造一個 operator，那是 §10.2 明文禁止的。
 *    真正的 operator 清單要等 M4 的 webhook（見 IMBRACE_QUESTIONS 的 payload 要求）。
 */
export interface ConversationChange {
  conversationId: string
  /** 變動後的完整快照 */
  conversation: Conversation
  /** `last_message_at` 跳動 → 該對話有新訊息 */
  hasNewMessages: boolean
  /** `mode` 改變 → Composer 可用性與 presence ③ 都要跟著更新 */
  modeChanged: boolean
  previousMode: ConversationMode | null
  /** 首次見到這個對話（第一輪快照）—— 不應觸發「有新訊息」的通知音效之類 */
  isFirstSight: boolean
}

/**
 * JOIN / LEAVE 事件來源（§8.1）。
 *
 * M1 只有「我方客服在 AgentCopilot 內按下 JOIN」這條本地快路徑會產生事件；
 * M4 的 `WebhookEventSource` 會產生第二條路徑，兩者以 §7.3 的規則去重。
 */
export interface JoinEvent {
  eventId: string
  type: 'join' | 'leave'
  conversationId: string
  operator: { id: string, name: string }
  channel: string
  /** 該對話當前的完整 operator 清單（若來源提供）—— 輪詢來源永遠沒有 */
  currentOperators?: Array<{ id: string, name: string }>
  occurredAt: string
}

export interface ConversationEventSource {
  start(): Promise<void>
  stop(): Promise<void>
  on(evt: 'join' | 'leave', handler: (e: JoinEvent) => void): Unsubscribe
}

// ── 訊息來源（§8.1）──────────────────────────────────────────────────────

export type WatchPriority = 'foreground' | 'background'

export interface SubscribeOptions {
  priority?: WatchPriority
  /** 已 JOIN 的對話輪詢較密（§9.2）—— 因為撞單風險只存在於已 JOIN 的對話 */
  joined?: boolean
}

/**
 * 訊息來源。
 *
 * ⚠️ **共享訂閱是硬性要求**（憲法 6.1）：以 conversationId 為鍵做 refcount，
 *    三位客服檢視同一對話只能輪詢一次，訂閱數歸零即停止。
 *    寫成「每個 SSE 連線各自輪詢」會讓 API 呼叫量乘上檢視人數。
 */
export interface MessageSource {
  subscribe(
    conversationId: string,
    onNew: (messages: Message[]) => void,
    opts?: SubscribeOptions,
  ): Unsubscribe

  /** 立即拉取一次（手動重新整理、送出前撞單檢查、SSE 重連後對帳） */
  fetchSince(conversationId: string, sinceMessageId?: string | null): Promise<Message[]>

  /** 外部訊號說「這個對話有新東西了」（§9.3.1 第一層通知第二層），立刻拉一次 */
  poke(conversationId: string): void

  /**
   * 該對話目前對任一位客服而言是否為前景（specs/002-suggestion-knowledge-search/research.md #9）。
   * 對話目前無任何訂閱者時回傳 `'background'`（安全預設）。
   */
  getPriority(conversationId: string): WatchPriority

  /**
   * 該對話目前是否**仍有任何人 JOIN**（specs/003-analysis-trigger-policy 決策 3）。
   *
   * 與 `getPriority()` 完全對稱：同一份訂閱者聚合的另一個欄位、同樣的安全預設約定。
   * 目前無任何訂閱者時回傳 `false`（安全預設）。
   *
   * ⚠️ **它只答得出「我方系統內」的 JOIN。** 同事若直接在 iMBrace 官方介面 JOIN，
   *    我方的訂閱者清單裡沒有他，此方法回傳 `false`
   *    （docs/ARCHITECTURE.md §10.2：平台回傳的 `users[]` 是團隊名冊而非對話參與者）。
   *    這是既有的平台能力缺口，M4 的 webhook payload 到位前無解，
   *    **MUST NOT** 在實作端用猜測填補。
   */
  isJoined(conversationId: string): boolean
}
