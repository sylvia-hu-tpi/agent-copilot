/**
 * StateStore / EventBus 介面 —— docs/ARCHITECTURE.md §8.3。
 *
 * ⚠️ 憲法第 3 條：這兩個介面的所有方法從 day 1 就必須是 async。
 *
 * 若寫成同步的 `map.get()`，M4 換 Redis 時要修改數十個呼叫點。
 * 先寫成 `await store.get()`，換實作只需一天。
 * 記憶體實作即使不需要 await，也一律回傳 Promise —— 不要為了「看起來乾淨」把它拆掉。
 */

import type { OrganizationChoice } from '../../shared/types/auth.js'
import type { PresenceEntry } from '../../shared/types/conversation.js'

// ── BFF Session（§7.1 / §7.2）──────────────────────────────────────────

/**
 * 已完成 ②loginWithOtp、尚未 ③selectOrganization 的中間狀態。
 *
 * ⚠️ 這個 stage 必須存在於 server session，否則重新整理 organization.vue
 * 會把客服踢回輸 email 的步驟（§5.1 ①）。
 */
export interface PendingOrgSession {
  stage: 'pending_org'
  email: string
  /** 第 ② 步就拿到了，必須帶到第 ③ 步 —— exchange 的回應不含使用者身分 */
  operatorId: string
  operatorName: string
  /** `login_acc_` 前綴的中間 token —— 只能用來 exchange，不能呼叫業務 API */
  loginToken: string
  organizations: OrganizationChoice[]
  /** session 本身的到期時間（epoch ms），非 token 到期時間 */
  expiresAt: number
}

/** 已選定組織、可正常操作的 session */
export interface ActiveSession {
  stage: 'active'
  email: string
  operatorId: string
  operatorName: string
  orgId: string
  orgName: string
  /** `acc_` 前綴。⚠️ 永不離開 server，不得回傳給瀏覽器（§7.2） */
  accessToken: string
  /**
   * ⚠️ `client.selectOrganization()` 會丟棄這個欄位，必須走手動 exchange 才拿得到（§5.1 ③）。
   * 沒有它，客服會在 8 小時 session 內被迫重跑 OTP。
   */
  refreshToken?: string
  /** access token 的到期時間（epoch ms），供續期判斷 */
  tokenExpiresAt?: number
  /** session 的到期時間（epoch ms）—— 8 小時滑動視窗，每次存取往後推 */
  expiresAt: number
}

export type Session = PendingOrgSession | ActiveSession

// ── CopilotSession（§4.2）─────────────────────────────────────────────

/**
 * 每個「已 JOIN 的對話」一個，由 session-manager 以 refcount 管理生命週期。
 *
 * M0 只定義輪詢與去重所需的最小欄位。
 * AI 產物（摘要、情緒序列、建議卡）於 M2 加入 —— 屆時新增欄位即可，
 * 不需改動 StateStore 介面。
 */
export interface CopilotSession {
  conversationId: string
  /** 正在檢視此對話的客服 id —— 歸零即可回收 session 與停止輪詢 */
  watchers: string[]
  /** 已處理到的最新訊息 id。§9.3「只取最新 N 則 + 本地比對」的比對基準 */
  lastMessageId: string | null
  createdAt: number
  updatedAt: number
}

// ── 介面 ──────────────────────────────────────────────────────────────

export interface StateStore {
  // Session
  getSession(id: string): Promise<Session | null>
  setSession(id: string, s: Session): Promise<void>
  deleteSession(id: string): Promise<void>

  // Copilot session（每對話一個）
  getCopilotSession(convId: string): Promise<CopilotSession | null>
  setCopilotSession(s: CopilotSession): Promise<void>
  deleteCopilotSession(convId: string): Promise<void>

  // Presence
  addPresence(convId: string, op: PresenceEntry, ttlMs: number): Promise<void>
  removePresence(convId: string, operatorId: string): Promise<void>
  listPresence(convId: string): Promise<PresenceEntry[]>

  /**
   * 多副本協調（§9.1 共享訂閱）。
   * @returns true 表示取得鎖；false 表示已有其他副本在輪詢此對話。
   */
  acquirePollLock(convId: string, ttlMs: number): Promise<boolean>
  releasePollLock(convId: string): Promise<void>

  /**
   * 事件去重（§4.3 JOIN 雙路徑）。
   *
   * ⚠️ 語意：**回傳 true 代表「先前已見過」= 這是重複事件，應丟棄**。
   * 首次呼叫回傳 false 並記錄。命名沿用 §8.3，但方向容易誤讀，呼叫端請寫成
   * `if (await store.seen(key, ttl)) return`。
   */
  seen(eventKey: string, ttlMs: number): Promise<boolean>
}

export type Unsubscribe = () => void

export interface EventBus {
  publish(topic: string, payload: unknown): Promise<void>
  subscribe(topic: string, handler: (payload: unknown) => void): Unsubscribe
}

// ── Topic 命名慣例（§8.3）──────────────────────────────────────────────

/** 推播給特定客服（JOIN 通知、跨對話提醒） */
export const operatorTopic = (operatorId: string): string => `operator:${operatorId}`

/** 推播給所有正在檢視該對話的人（新訊息、presence、分析結果） */
export const conversationTopic = (conversationId: string): string => `conversation:${conversationId}`

/**
 * 推播給整個組織（對話清單的變動）。
 *
 * ⚠️ §8.3 原本只列了 operator / conversation 兩種 topic，那是在「逐對話輪詢」的
 *    假設下訂的。改成 §9.3.1 的清單輪詢後，「哪個對話有新訊息」是**一次算出全部**的，
 *    需要一個對應的廣播範圍，否則側欄的未讀徽記就得靠前端自己再輪詢一次清單。
 */
export const organizationTopic = (orgId: string): string => `organization:${orgId}`
