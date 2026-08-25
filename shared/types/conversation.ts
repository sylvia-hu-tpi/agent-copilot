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
  /**
   * ⚠️ 這是**團隊名冊**，不是「這個對話的參與者」（§10.2 二次實測）。
   *
   * 兩個不同對話的 `users[]` 實測為同一批 14 人，含 Bot 與 observer。
   * **不可作為 presence 來源**，也不可用來反推訊息發送者 ——
   * 前者會把整個團隊標成「正在檢視」，後者會把同事誤判為 AI。
   * 清單 payload 中此欄為 `null`，只有 `conversations.get()` 才有值。
   */
  operators: Operator[]
  /**
   * 最後一則訊息的時間 —— §9.3.1 第一層輪詢的變動偵測依據。
   *
   * ⚠️ 實測填充率僅 83%，部分對話為空。為空者無法靠清單輪詢偵測新訊息，
   *    必須退回逐對話輪詢（見 `PollingMessageSource` 的 `listCovered`）。
   */
  lastMessageAt?: string
  updatedAt: string
}

/**
 * §10.6 —— 兩個正交維度，不可建模成三種模式列舉。
 *
 * ⚠️ 2026-08-25 修訂：原本是 `aiMode: 'collab' | 'human_only'`，
 *    與 §10.6 實測後定案的兩維度模型不一致。四個平台 mode 全數實測後，
 *    「AI 會不會自動回覆」與「客服能不能送出」確認是**互相獨立**的兩件事
 *    （Automation Only 時 AI 會回、客服不能送），單一列舉表達不了。
 */
export interface ConversationControl {
  /** AI 是否自動回覆 —— 為 true 時 AI 是撞單對象之一（§10.5） */
  aiReplies: boolean
  /** 客服能否送出 —— Automation Only 時為 false，平台端也會拒絕 */
  agentCanSend: boolean
  /** 產生上述兩維度的平台 mode，供 UI 顯示與除錯 */
  mode: ConversationMode | null
  /**
   * 主管強制介入（我方自訂，平台無此概念）。
   *
   * ⚠️ 這是全系統唯一的真鎖，但強制力僅及於 AgentCopilot 內部 ——
   *    直接使用 iMBrace 官方介面的同事擋不住。介面必須明示此邊界（§10.6）。
   */
  lock: null | {
    by: string
    name: string
    at: string
  }
}

/**
 * 平台 mode → 兩個正交維度（§10.6 對照表）。
 *
 * ⚠️ `null`（從未 JOIN）視同 automation：AI 在跑、我方尚未取得送出權。
 *    JOIN 之後才會變成 `manual`。
 */
export function controlFromMode(
  mode: ConversationMode | null | undefined,
  lock: ConversationControl['lock'] = null,
): ConversationControl {
  const m = mode ?? null
  return {
    aiReplies: m !== 'manual',
    agentCanSend: m === 'manual' || m === 'hybrid',
    mode: m,
    lock,
  }
}

/**
 * 是否有「我以外的人」可能送出訊息（§10.2 presence 來源 ③）。
 *
 * ⚠️ 回答的**不是**「有沒有人在」。`automation` 對「根本沒人」與
 *    「有人但選了 Automation Only（唯讀）」無法區分 —— 但那個歧義對撞單防護無害，
 *    因為 Automation Only 的同事送不出訊息，撞不了單。
 */
export function someoneElseCanSend(mode: ConversationMode | null | undefined): boolean {
  return mode === 'manual' || mode === 'hybrid'
}

// ── Presence（docs/ARCHITECTURE.md §10.2）───────────────────────────────

export type PresenceState = 'viewing' | 'composing' | 'joined'

/**
 * ⚠️ `source` 不是除錯欄位，是 UI 的必要輸入。
 *
 * §10.2：`sse` 代表「此刻確實開著這個對話」，`message` 只代表「N 分鐘前發言過」。
 * 把後者顯示成「正在檢視」會讓客服以為有人守著而實際沒人 —— 比不顯示更糟。
 * 各來源的涵蓋範圍與可信度不同，PresenceBar 必須據此分開呈現。
 *
 * ⚠️ §10.2 的第三個來源（`mode ∈ {manual, hybrid}`）**不在這個列舉裡** ——
 *    它只知道「有人能送出訊息」，不知道是誰，塞不進以 operatorId 為鍵的條目。
 *    它落在 `PresenceSnapshot.unidentifiedActor`（shared/types/events.ts）。
 */
export type PresenceSource =
  /** ① 自家 SSE 上報 —— 只涵蓋我方使用者，延遲 < 200ms，可信度高 */
  | 'sse'
  /** ② 訊息 `u_` 前綴反推 —— 涵蓋官方介面的同事，僅代表「曾經發言」 */
  | 'message'
  /** ④ JOIN/LEAVE webhook —— 全涵蓋，待規格（M4） */
  | 'webhook'

export interface PresenceEntry {
  operatorId: string
  operatorName: string
  state: PresenceState
  /**
   * 這個人有沒有 JOIN 這個對話。
   *
   * ⚠️ 為何不併進 `state`：「正在輸入」與「已 JOIN」是**兩個正交的維度**，
   *    一個人可以同時是這兩者。併成一個列舉的話，心跳送出 `composing`
   *    就會把 `joined` 蓋掉 —— 症狀是客服 JOIN 之後開始打字，
   *    自己就從「已加入」變回「觀察中」，而 Composer 的可用性判斷跟著失準。
   *
   *    這與 §10.6 拒絕把三種平台模式建模成單一列舉是同一個判斷。
   */
  joined: boolean
  source: PresenceSource
  /** 此狀態的發生時間（ISO8601）。source 為 `message` 時即該則訊息的時間 */
  at: string
}
