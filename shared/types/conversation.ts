/**
 * AgentCopilot 的領域型別（前後端共用）。
 *
 * ⚠️ 這是「我們的」型別，不是 iMBrace SDK 的型別。
 * SDK 的 `ConversationMessage` 形狀與此不同，兩者之間的轉換一律走
 * `server/sources/mappers.ts` —— 這是防腐層（anti-corruption layer）。
 *
 * 對應 docs/ARCHITECTURE.md §11.4。
 */

/** ⚠️ 撞單防護（§10.4）與對話分段（§14.1.2）皆依賴此欄位 */
export type SenderType = 'customer' | 'ai' | 'agent' | 'unknown'

export interface Attachment {
  id: string
  kind: 'image' | 'audio' | 'video' | 'file'
  filename: string
  url?: string
  /** 語音時長（秒） */
  durationSec?: number
  /** 平台端或我方產生的文字化內容（STT 轉錄 / 圖片描述 / OCR） */
  transcript?: string
  /** transcript 的來源，供成本控制與品質判斷 */
  transcriptSource?: 'platform' | 'ours' | 'none'
}

export interface Message {
  id: string
  conversationId: string
  at: string
  sender: {
    type: SenderType
    /** agent 時為 operatorId；customer 時為 contactId */
    id?: string
    name?: string
  }
  /** 統一的可分析文字：原文、語音轉錄、或圖片描述 */
  text: string
  attachments?: Attachment[]
}

export interface Operator {
  id: string
  name: string
}

/**
 * 對話的服務模式 —— 對應官方介面 Composer 上方的下拉選單（§10.6）。
 *
 * ⚠️ 這是**對話層級的共用狀態**，不是每位客服各自的偏好。
 *    任一位客服切換，其他所有人（含我方）都會跟著改變。
 */
export type ConversationMode = 'manual' | 'hybrid' | 'automation'

export interface Conversation {
  /** 對話 id（裸 UUID）。訊息查詢用這個 */
  id: string
  /**
   * team_conversation 記錄的 id（`tcu_` 前綴）。
   *
   * ⚠️ JOIN / LEAVE / 切換 mode **都必須用這個**，不能用 `id`（§10.6）。
   * ⚠️ 只有 `conversations.get()` 會回傳，**清單 payload 沒有** ——
   *    因此從對話列表要 JOIN 之前，必須先取一次詳情。
   */
  teamConversationId?: string
  channel: string
  contactId: string
  status: string
  name: string
  /**
   * `null` 代表從未 JOIN。
   * ⚠️ `automation` 有歧義：可能沒人，也可能有人但選了 Automation Only（唯讀）。
   *    判定「是否有他人可能送出訊息」請用 `manual | hybrid`，見 §10.2。
   */
  mode?: ConversationMode | null
  /** 當前在此對話中的 operator 清單 —— presence 與 JOIN/LEAVE 推斷的依據 */
  operators: Operator[]
  updatedAt: string
}

/** §10.6 —— 兩個正交維度，不可建模成三種模式列舉 */
export interface ConversationControl {
  aiMode: 'collab' | 'human_only'
  lock: null | {
    by: string
    name: string
    at: string
  }
}

// ── Presence（docs/ARCHITECTURE.md §10.2）───────────────────────────────

export type PresenceState = 'viewing' | 'composing' | 'joined'

/**
 * ⚠️ `source` 不是除錯欄位，是 UI 的必要輸入。
 *
 * §10.2：`sse` 代表「此刻確實開著這個對話」，`message` 只代表「N 分鐘前發言過」。
 * 把後者顯示成「正在檢視」會讓客服以為有人守著而實際沒人 —— 比不顯示更糟。
 * 三來源的涵蓋範圍與可信度不同，PresenceBar 必須據此分開呈現。
 */
export type PresenceSource =
  /** ① 自家 SSE 上報 —— 只涵蓋我方使用者，延遲 < 200ms，可信度高 */
  | 'sse'
  /** ② 訊息 `u_` 前綴反推 —— 涵蓋官方介面的同事，僅代表「曾經發言」 */
  | 'message'
  /** ③ JOIN/LEAVE webhook —— 全涵蓋，待規格（M4） */
  | 'webhook'

export interface PresenceEntry {
  operatorId: string
  operatorName: string
  state: PresenceState
  source: PresenceSource
  /** 此狀態的發生時間（ISO8601）。source 為 `message` 時即該則訊息的時間 */
  at: string
}
