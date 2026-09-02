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
import type { SentimentBlock, SuggestionBlock, SummaryBlock } from '../../shared/types/copilot.js'
// ⚠️ 純型別匯入（執行期被抹除，不產生模組相依）——`AnalysisBlock` 的正典定義在
//    server/services/analysis-state.ts，這裡刻意不重寫一份同值的 union，
//    否則日後新增／更名區塊時會有兩個地方要改，而漏改的那一份不會報錯。
import type { AnalysisBlock } from '../services/analysis-state.js'

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
  /**
   * ⚠️ **保留 `login_acc_` 中間 token 是為了「切換組織」**（U-3，2026-08-30）。
   *    換到另一個組織必須用它重新 exchange，而 exchange 只吃這個 token；
   *    active session 的 `accessToken` 已經綁定在單一組織上，換不了。
   *
   * ⚠️ **這代表它會在 server 端存活整個 8 小時 session，而不只是登入那幾秒。**
   *    它能換到這位客服**任何**組織的存取權，因此與 `accessToken` 同等對待：
   *    永不離開 server、永不寫進日誌、不出現在任何 API 回應（憲法 1.1／1.5）。
   *    ⚠️ 這個取捨是刻意的 —— 不留它就做不到切換組織，而 1b 的文案正在承諾這件事。
   *    若日後決定不做切換，這個欄位 MUST 一併移除，不要留著「反正沒用到」。
   */
  loginToken: string
  /**
   * 可切換的組織清單。與 `PendingOrgSession.organizations` 是同一份，
   * 帶著它才能在不重跑 OTP 的情況下回到選組織畫面。
   * ⚠️ 這份清單**沒有憑證**，可以安全地回給瀏覽器（`GET /api/auth/me`）。
   */
  organizations: OrganizationChoice[]
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
  /** 新增（specs/002-suggestion-knowledge-search） */
  suggestionBlock: SuggestionBlock
  /** debounce 計時器用的最後一次觸發時間戳（epoch ms），非對外欄位，供 copilot-analysis.ts 內部使用 */
  lastAnalysisTriggerAt?: number
  /**
   * 失敗批次記憶（specs/003-analysis-trigger-policy，data-model.md §1）。
   *
   * ⚠️ **MUST 留在頂層，MUST NOT 併入任一 Block。**
   *    `summary.updated`／`sentiment.updated`／`suggestion.updated` 三個 SSE 事件送的是
   *    **整個 Block**（`publishBlock()`，`server/services/analysis-state.ts`）——放進 Block 就等於把它送到瀏覽器，
   *    也就等於默默改了對外契約，而型別檢查抓不到這個違反
   *    （contracts/analysis-trigger-contract.md 1.1，驗法：`grep -n "failedBatches" shared/` 必須零結果）。
   *
   * 生命週期跟隨本狀態的 2 小時 sliding TTL，**不另訂保存期限**（FR-011）。
   */
  failedBatches?: Partial<Record<AnalysisBlock, FailedBatch>>
}

/**
 * 「同一批訊息、同一個區塊已經失敗過」的記憶 —— specs/003-analysis-trigger-policy FR-005～FR-008。
 *
 * ⚠️ 鍵是「區塊 ＋ 該批**最後一則**訊息 id」，這不是任意選擇，是**自癒機制的支點**：
 *    客戶再說一句話 → 該批的最後一則變了 → 不再是同一批 → FR-007 自動再試一次。
 *    改成對話層級或時間窗，「對話還活著」的自癒就會消失，錯誤狀態會變成永久紅燈，
 *    而 FR-010（不加第二層自動退避重試）就再也無法成立。
 */
export interface FailedBatch {
  /** 這一批**最後一則客戶訊息**的 id —— 判定「是不是同一批」的鍵（FR-005） */
  lastMessageId: string
  /** 這一批最近一次失敗的時間（ISO8601），供診斷與日後可能的觀測需求 */
  at: string
  /** 這一批累計失敗次數 —— 手動重試也失敗時遞增 */
  count: number
  /**
   * 客服手動重試（FR-008）或重新 JOIN 冷啟動（FR-015）已把這一批**放行**：
   * 門檻不再擋它，但 `count` 保留。
   *
   * ⚠️ 為何不直接刪掉整筆（data-model.md §1「讀寫時機」表寫的是「清」）：
   *    刪掉的話 `count` 每次都從 1 重新起算，而 `count` 唯一能超過 1 的路徑
   *    正是「手動重試也失敗」—— 該欄位會變成恆為 1 的死欄位，
   *    與它自己的定義互相矛盾。放行旗標讓兩個要求同時成立，代價是一個布林。
   *
   * ⚠️ 這裡 MUST 是**狀態**而非呼叫端的參數：分析入口有同區塊併發去重
   *    （`runBlockDeduped()`，`server/services/analysis-dedupe.ts`），手動重試很可能被合併進一次進行中的分析，
   *    屆時真正執行的是**先前那個**閉包 —— 用參數傳「這次要略過門檻」會在合併路徑上遺失，
   *    症狀是「剛好有分析在跑的時候按重試，按了沒反應」。
   */
  released?: boolean
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

  // 背景 JOIN 持久追蹤（specs/002-suggestion-knowledge-search/research.md #8）——
  // 獨立於 watcher refcount，供 SSE 重連復原背景 watch 用。不設 TTL：JOIN／LEAVE 是明確操作。

  /** JOIN 成功時呼叫；冪等（重複呼叫同一組合不產生副作用） */
  addJoinedConversation(operatorId: string, conversationId: string): Promise<void>
  /** LEAVE 成功時呼叫 */
  removeJoinedConversation(operatorId: string, conversationId: string): Promise<void>
  /** SSE 連線建立時查詢，用於重建背景 watch */
  listJoinedConversations(operatorId: string): Promise<string[]>

  // ── 左欄「你在此對話中」的判定快取（ARCHITECTURE §10.2.1）─────────────
  //
  // ⚠️ **與上面三支是不同的東西，不可合併。** `joinedConversations` 是「經我方 BFF
  //    JOIN 過的」正向集合，只記得住 true；這裡要記的是**問過平台之後的答案**，
  //    而「答案是 false」同樣必須記得住 —— 否則同事的對話每輪都會再問一次平台，
  //    那正是這個快取要避免的成本。

  /** `undefined` ＝ 沒問過（或已被淘汰），**不等於 false** */
  getViewerJoined(operatorId: string, conversationId: string): Promise<ViewerJoinedEntry | undefined>
  setViewerJoined(operatorId: string, conversationId: string, entry: ViewerJoinedEntry): Promise<void>
}

/**
 * 「我有沒有 JOIN 這一則」的快取項。
 *
 * ⚠️ **`mode` 是失效訊號，不是除錯欄位。** 平台的 `is_joined` 只有單筆詳情才有，
 *    我們負擔不起每輪對每一列各查一次（前景清單輪詢是 3 秒一次）。
 *    但 `mode` 在清單裡是免費的，而且 JOIN／LEAVE 一定伴隨 `mode` 變動
 *    （`null`／`automation` ⇄ `manual`／`hybrid`，§10.2）——
 *    所以「解析當下的 mode」與「現在的 mode」不同，就是重新解析的時機。
 *    少了這個欄位就只剩 TTL，而 TTL 會讓成本隨候選集合線性成長。
 */
export interface ViewerJoinedEntry {
  joined: boolean
  /** 解析當下該對話的 `mode`；與現值不同即視為過期 */
  mode: string | null
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
