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

export interface Conversation {
  id: string
  channel: string
  contactId: string
  status: string
  name: string
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
