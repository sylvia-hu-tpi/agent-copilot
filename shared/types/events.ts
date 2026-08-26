/**
 * SSE 事件契約（前後端共用）—— docs/ARCHITECTURE.md §9.5。
 *
 * ⚠️ 命名慣例：`名詞.動詞過去式`（憲法附錄 A）。
 *
 * ⚠️ 每則事件都帶 `id`（單調遞增），但**斷線補齊不靠它**。
 *    見本檔結尾「為何不做事件重播緩衝」。
 */

import type {
  ConversationControl,
  ConversationMode,
  Message,
  PresenceEntry,
} from './conversation.js'
import type { SentimentBlock, SummaryBlock } from './copilot.js'

/**
 * Presence 快照 —— ⚠️ 不是單純的 `PresenceEntry[]`。
 *
 * §10.2 的四個來源中，③（`mode ∈ {manual, hybrid}`）**只知道「有人能送出訊息」，
 * 不知道是誰**，塞不進以 operatorId 為鍵的 `PresenceEntry`。
 * 硬塞會逼 UI 捏造一個假名字，而那正是 §10.2 明文禁止的事。
 *
 * 因此把「具名的人」與「有沒有匿名的可送出者」分成兩個欄位，
 * 讓 UI 得以誠實呈現三種不同可信度的狀態。
 */
export interface PresenceSnapshot {
  /** ①自家 SSE（正在檢視／輸入）與 ②訊息 `u_` 反推（N 分鐘前發言過）—— 皆具名 */
  operators: PresenceEntry[]
  /**
   * ③ `mode ∈ {manual, hybrid}` —— 有人能送出訊息，但**無法指名**。
   *
   * ⚠️ 為 false 時**不代表沒人在看**：`automation` 對「真的沒人」與
   *    「有人但選了 Automation Only（唯讀）」無法區分（§10.2）。
   *    UI 文案只能停在「沒有偵測到其他人」，不可寫成「目前沒有其他人在看」。
   */
  unidentifiedActor: boolean
  /** 產生 ③ 的原始依據，供 UI 決定文案與除錯 */
  mode: ConversationMode | null
}

/**
 * 撞單偵測結果 —— §10.4，刻意阻斷使用者的封閉集合之一（憲法 3.3①）。
 *
 * ⚠️ `kind` 必須以 `sender.type` 判定，不可用 `direction`：
 *    AI workflow 的自動回覆同樣是 outbound，用 direction 判會產生假警報，
 *    而假警報比沒有警報更糟。
 */
export interface CollisionReport {
  /**
   * `unverified` = 檢查本身失敗（取數錯誤），**不是**「沒有撞單」。
   *
   * ⚠️ 這個值必須存在。少了它，取數失敗時只剩兩條路：靜默放行（讓唯一有效的
   *    防線在網路抖動時無聲消失）或直接擋死（違反憲法 3.2）。
   *    第三條路是把不確定性誠實交還給客服，而那需要一個能表達「不確定」的值。
   */
  kind: 'agent' | 'ai' | 'unverified'
  /** 版本錨點之後、由他人送出的訊息 */
  messages: Message[]
  /** 最新的 messageId —— 客服選擇「仍要送出」時用它當新的錨點 */
  latestMessageId: string | null
}

/** M1 已實作的事件；M2 新增 summary/sentiment（specs/001-sentiment-panel）。M3 的 suggestions 屆時再加。 */
export type CopilotEvent =
  | { type: 'session.opened', conversationId: string, reason: 'join' | 'resume' }
  | { type: 'session.closed', conversationId: string, reason: 'leave' | 'resolved' }
  | { type: 'messages.appended', conversationId: string, messages: Message[] }
  | { type: 'presence.updated', conversationId: string, presence: PresenceSnapshot }
  | { type: 'control.updated', conversationId: string, control: ConversationControl }
  | { type: 'conversation.updated', conversationId: string, lastMessageAt?: string }
  /**
   * 摘要卡整塊覆蓋式更新（specs/001-sentiment-panel/contracts/copilot-sse-events.md）。
   * ⚠️ 前端 MUST 整塊覆蓋既有顯示狀態，不做 partial merge —— 是否保留舊內容由 status 語意決定。
   */
  | { type: 'summary.updated', conversationId: string, summary: SummaryBlock }
  /** 情緒 sparkline 整塊覆蓋式更新；timeline 攜帶全量（非 patch），見同一份契約文件 */
  | { type: 'sentiment.updated', conversationId: string, sentiment: SentimentBlock }
  /** 心跳。⚠️ 不可省略：中間的 proxy 常在 60s 無資料時直接切斷連線 */
  | { type: 'stream.heartbeat', at: string }

/** SSE 傳輸包裝 —— `id` 供除錯與排序，不作為補齊依據（見檔尾說明） */
export interface CopilotEventEnvelope {
  id: string
  event: CopilotEvent
}

/**
 * ⚠️ 為何不做事件重播緩衝（`Last-Event-ID` → 重送漏掉的事件）
 *
 * 那需要一份「已送出事件」的儲存。放在單一副本的記憶體裡，M4 上多副本後
 * 重連到別的副本就補不到 —— 而那正是「偶爾少一則訊息」這類最難追查的 bug。
 *
 * 本專案改採**對帳式補齊**：前端重連後以自己的 `lastMessageId` 打
 * `GET /api/messages?conversationId=…&since=…` 重新對帳。
 * 這與 §9.4「webhook 上線後仍要保留對帳輪詢」是同一個原則 ——
 * 真相一律回源頭取，不依賴傳輸層的可靠性假設。
 */
export const STREAM_HEARTBEAT_MS = 25_000
