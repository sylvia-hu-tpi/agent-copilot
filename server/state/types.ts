/**
 * StateStore / EventBus 介面 —— docs/ARCHITECTURE.md §8.3。
 *
 * ⚠️ 憲法 2.3：這兩個介面的所有方法從 day 1 就必須是 async。
 *
 * 若寫成同步的 `map.get()`，M4 換 Redis 時要修改數十個呼叫點。
 * 先寫成 `await store.get()`，換實作只需一天。
 * 記憶體實作即使不需要 await，也一律回傳 Promise —— 不要為了「看起來乾淨」把它拆掉。
 */

import type { OrganizationChoice } from '../../shared/types/auth.js'
import type { PresenceEntry } from '../../shared/types/conversation.js'
import type { SentimentBlock, SummaryBlock } from '../../shared/types/copilot.js'

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
 * 每個「已 JOIN 的對話」一個，由 session-manager 以 refcount 管理生命週期——
 * `watchers.length === 0` 時 `releasePipeline()` 會整組刪除。
 *
 * M0 只定義輪詢與去重所需的最小欄位，往後也**只應該**放輪詢／去重相關欄位。
 *
 * ⚠️ 2026-08-26 訂正：原註解預告「AI 產物（摘要、情緒序列、建議卡）於 M2 加入，
 * 屆時新增欄位即可」——這個計畫在 `specs/001-sentiment-panel` 的 `/speckit-analyze`
 * 被推翻：AI 產物若掛在這裡，客服切走對話（watchers 歸零，完全正常的操作）就會把
 * 分析成果連帶刪除，違反 FR-010「切走再切回，結果 MUST 被保留」。
 * AI 產物改落地於獨立的 `CopilotAnalysisState`（見 `specs/001-sentiment-panel/data-model.md`），
 * 透過 `StateStore.getAnalysisState`／`setAnalysisState`（sliding TTL，不受 watcher 數影響），
 * 不會、也不應該再擴充這個介面。
 */
export interface CopilotSession {
  conversationId: string
  /** 正在檢視此對話的客服 id —— 歸零即可回收 session 與停止輪詢 */
  watchers: string[]
  /**
   * `advanceAnchor()` 會寫入，但目前沒有讀者（docs/ARCHITECTURE.md §18）——
   * 不是撞單檢查的版本錨點，也不是 §9.3 輪詢去重的比對基準，兩者另有各自的欄位。
   */
  lastMessageId: string | null
  createdAt: number
  updatedAt: number
}

// ── CopilotAnalysisState（specs/001-sentiment-panel）───────────────────

/**
 * 摘要／情緒分析結果 —— **完全獨立於 `CopilotSession`**，不受 watcher 數量影響、
 * 也不因客服切走而被清除（見上方 `CopilotSession` 註解的 2026-08-26 訂正）。
 *
 * 生命週期：sliding TTL 2 小時，每次讀取（切回檢視）或寫入（新一輪分析完成）皆續期。
 * 詳見 specs/001-sentiment-panel/data-model.md「CopilotAnalysisState」一節。
 */
export interface CopilotAnalysisState {
  conversationId: string
  summaryBlock: SummaryBlock
  sentimentBlock: SentimentBlock
  /** debounce 計時器用的最後一次觸發時間戳（epoch ms），非對外欄位，供 copilot-analysis.ts 內部使用 */
  lastAnalysisTriggerAt?: number
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

  // 摘要／情緒分析狀態（與 CopilotSession 完全獨立的資料集，見上方型別註解）
  getAnalysisState(convId: string): Promise<CopilotAnalysisState | null>
  /** ttlMs：sliding TTL，每次呼叫皆以當下時間重新起算到期時間 */
  setAnalysisState(s: CopilotAnalysisState, ttlMs: number): Promise<void>

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
