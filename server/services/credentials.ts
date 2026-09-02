/**
 * 背景輪詢用的憑證登記處。
 *
 * ── 為何需要這個東西 ─────────────────────────────────────────────
 * §9.3.1 的第一層清單輪詢是**每個組織一份**的背景迴圈，不隸屬於任何一個 HTTP 請求。
 * 但 iMBrace 的每個 API 呼叫都需要某位客服的 access token，而 token 只存在於
 * 各自的 BFF session 裡。因此輪詢必須「借用」某位目前連線中客服的憑證。
 *
 * ── 這與憲法 1.3「操作歸屬」的關係 ───────────────────────────────
 * 憲法 1.3 的標的是**寫入操作的歸屬**，不是效能 ——
 * 禁止的是共用憑證去做別人的寫入，因為稽核軌跡會指向錯的人。
 * （v1 的措辭是「不建立全域 SDK 單例」，過寬且與本模組衝突；
 *   v2.0.0 修憲後，下列兩道界線已直接寫進憲法 1.3 的表格。）
 *
 * 本模組因此設下兩道界線，讓借用不會踩到那個理由：
 *  ① 這裡登記的憑證**只用於唯讀輪詢**（`conversations.search`、訊息查詢）。
 *     所有寫入（JOIN / LEAVE / 切換 mode / 送出訊息）一律走 HTTP 請求路徑，
 *     以發起者自己的 session token 執行 —— 見各 `server/api/**` 路由。
 *  ② 不快取 client 實例，每次輪詢當場以憑證建立一個。沒有全域單例。
 *
 * ⚠️ 若日後有人想用這裡的憑證做寫入，那是憲法違規，不是最佳化。
 *    正確做法是把該操作放回請求路徑，或依憲法 B.1 的流程提出修憲。
 *
 * ── 登記的單位是「一條連線」，不是「一位客服」（specs/005-m2-residual-defects US1）──
 *
 * ⚠️ 2026-09-02 之前的登記以 `(orgId, operatorId)` 為鍵，取消登記時無條件把該 operator
 *    的項目整個刪掉。同一位客服開兩個分頁、關掉其中一個 → 仍開著那條的憑證一併消失 →
 *    `borrowCredential()` 回 null → 兩層輪詢拉回空陣列 → **那個分頁從此收不到任何新訊息**，
 *    而畫面看起來完全正常。現在的鍵是 `stream.get.ts` 在連線建立時產生的 server 端
 *    `connectionId`（research.md #1）。
 *
 * ⚠️ **`clientId` MUST NOT 當作鍵**：它存在 `sessionStorage`，瀏覽器的「複製分頁」會連同
 *    `sessionStorage` 一起複製，兩條連線可能帶同一個 `clientId` —— 拿它當鍵就是把上面那個缺陷
 *    換個觸發條件重新種一次。它只作為**定址標籤**：心跳與活躍度以 `(orgId, operatorId, clientId)`
 *    命中的**全部**登記為對象（research.md #2），移除只以 `connectionId` 為準。
 *
 * ── 存活兜底：TTL ＋ 前端連線層級心跳（FR-005a）──────────────────────
 *
 * ⚠️ **這是「每次登記各自唯一」的必要配套，不是額外保險。** 舊實作有一個意外的自癒：
 *    同一位客服下次登記會覆蓋上一筆，所以就算關閉事件沒觸發，洩漏最多活到他下次上線。
 *    改成每次登記各自唯一之後這個自癒消失，**每次洩漏都永久累積** —— `borrowCredential()`
 *    永遠不回 null（用著已登出的 token 一直輪詢）、`hasForegroundOperator()` 永遠回 true。
 *    因此每筆登記帶 `lastSeenAt`，逾期未更新（`CREDENTIAL_TTL_MS`）即在讀取點惰性剔除。
 *
 * ⚠️ 存活訊號 MUST 由**對側**（瀏覽器）發出 —— `POST /api/connection/beat`。
 *    MUST NOT 用 `stream.get.ts` 的 server 端 `stream.heartbeat`：它證明的是「server 還認為
 *    連線在」，半開連線（網路斷、瀏覽器崩潰）下**恆真**，兜底會變成永不觸發的裝飾。
 *
 * ⚠️ **心跳是 upsert，MUST NOT 是純更新**（research.md #3a，本檔最容易照抄錯的一行）：
 *    瀏覽器對隱藏分頁的計時器有節流（Chrome 壓到約每分鐘一次 > 45 秒 TTL），登記會被剔除，
 *    而 SSE 連線**沒有斷、不會重連**，沒有任何路徑會重新登記 —— 心跳若寫成「找不到就 no-op」，
 *    背景分頁會自己重現本模組要修的缺陷，症狀逐字相同：畫面正常、不報錯、訊息不再進來。
 *
 * ⚠️ 回收是**惰性**的，沒有計時器（research.md #4）：三個讀取點就是登記的全部消費者，
 *    而且全部在輪詢路徑上（最慢 30 秒一拍），回收延遲的上界是 TTL ＋ 一個輪詢週期。
 *    一支計時器就是第九份執行期狀態，要進擁有權表、要在每支測試裡收拾，成本不對稱而收益是零。
 */

import { CONNECTION_HEARTBEAT_MS } from '../../shared/types/events.js'
import type { Unsubscribe } from '../state/types.js'

/** 客服的即時活躍度 —— 決定第一層清單輪詢要跑多快（§9.2） */
export type OperatorActivity = 'foreground' | 'background'

export interface PollingCredential {
  /** server 端 `crypto.randomUUID()`，本筆登記的鍵（research.md #1）。⚠️ 永不離開 server */
  connectionId: string
  /** 前端分頁 id，僅供定址。⚠️ 不唯一 —— 複製分頁會共用（見檔頭） */
  clientId: string
  operatorId: string
  orgId: string
  /** ⚠️ 永不離開 server，也永不寫進日誌（憲法 1.1 / 1.5） */
  accessToken: string
  activity: OperatorActivity
  registeredAt: number
  /** FR-005a 的存活時間戳：登記時與每一拍連線心跳更新 */
  lastSeenAt: number
}

/**
 * 登記逾期未收到心跳即回收（FR-005a）。數字抄自 presence（`PRESENCE_TTL_MS`）：
 * 20 秒心跳 ＋ 容忍漏一拍。
 *
 * ⚠️ MUST NOT 為了「背景分頁計時器會被節流到每分鐘一次」而拉長它（例如 150 秒）：
 *    那會讓異常中斷後已登出的憑證被繼續拿去輪詢最長 2.5 分鐘，把 FR-005a 要關的窗口反而拉大，
 *    而且是在賭瀏覽器節流的實作細節。節流問題由 `touchCredential()` 的 upsert 語意解，不是由 TTL 解。
 */
export const CREDENTIAL_TTL_MS = 45_000

/**
 * 前端連線心跳的間隔 —— 與 `shared/types/events.ts` 的 `CONNECTION_HEARTBEAT_MS` 是**同一個值**
 * （前端 import 不到 `server/`，因此常數住在 shared，這裡只是給 server 端一個語意相符的名字）。
 * ⚠️ 兩者 MUST 保持同一個 binding，MUST NOT 各抄一份數字 —— 抄開之後其中一份會安靜地漂移。
 */
export const CREDENTIAL_HEARTBEAT_MS = CONNECTION_HEARTBEAT_MS

const KEY = Symbol.for('agent-copilot.polling-credentials')

/** orgId → connectionId → 登記 */
type Registry = Map<string, Map<string, PollingCredential>>
type Global = typeof globalThis & { [KEY]?: Registry }

function registry(): Registry {
  const g = globalThis as Global
  if (!g[KEY]) g[KEY] = new Map()
  return g[KEY]
}

type CredentialWatcher = (orgId: string) => void

const WATCH_KEY = Symbol.for('agent-copilot.polling-credential-watchers')
type WatcherGlobal = typeof globalThis & { [WATCH_KEY]?: Set<CredentialWatcher> }

function watchers(): Set<CredentialWatcher> {
  const g = globalThis as WatcherGlobal
  if (!g[WATCH_KEY]) g[WATCH_KEY] = new Set()
  return g[WATCH_KEY]
}

/**
 * 訂閱「這個組織現在可能需要更頻繁地輪詢了」—— 有人上線、或分頁切回前景。
 *
 * ⚠️ **相依方向是刻意的。** 本模組 MUST NOT 反向 import `copilot-runtime.ts`
 *    （理由見該檔 `setJoinedResolver` 的說明：它會把 Nitro auto-import 拉進
 *    `tsconfig.scripts.json` 的型別圖）。所以這裡只發通知、不知道對方是誰，
 *    由 runtime 自己決定要做什麼。
 *
 * ⚠️ 只在「可能變快」時發，不在登出／轉背景時發 —— 變慢不需要立刻反應，
 *    下一拍自然會用新的間隔。
 */
export function onCredentialUpgrade(watcher: CredentialWatcher): Unsubscribe {
  watchers().add(watcher)
  return () => {
    watchers().delete(watcher)
  }
}

function notifyUpgrade(orgId: string): void {
  for (const watcher of [...watchers()]) {
    try {
      watcher(orgId)
    }
    catch {
      // 訂閱者爆掉不得影響登記本身 —— 登記失敗會讓整個組織的輪詢停擺
    }
  }
}

function orgMap(orgId: string): Map<string, PollingCredential> {
  const existing = registry().get(orgId)
  if (existing) return existing
  const fresh = new Map<string, PollingCredential>()
  registry().set(orgId, fresh)
  return fresh
}

function dropIfEmpty(orgId: string): void {
  if (registry().get(orgId)?.size === 0) registry().delete(orgId)
}

/**
 * 惰性回收：剔除逾期登記（FR-005a）。三個讀取點各自呼叫，沒有計時器（見檔頭）。
 * @returns 剔除的筆數，供監控與測試
 */
function evictExpired(orgId: string, now: number): number {
  const byConnection = registry().get(orgId)
  if (!byConnection) return 0
  let evicted = 0
  for (const [connectionId, cred] of byConnection) {
    if (now - cred.lastSeenAt > CREDENTIAL_TTL_MS) {
      byConnection.delete(connectionId)
      evicted++
    }
  }
  dropIfEmpty(orgId)
  return evicted
}

/**
 * 登記一條連線中客服的憑證（由 SSE 連線建立時呼叫，每條連線一筆）。
 *
 * @returns 取消登記的函式 —— **必須**在 SSE 連線關閉時呼叫，且**只移除這一筆**（同一位客服的
 *          其他連線完全不受影響，FR-002）。忘了呼叫也不會永久洩漏：FR-005a 的 TTL 會回收它。
 */
export function registerCredential(
  cred: Omit<PollingCredential, 'registeredAt' | 'lastSeenAt' | 'activity'> & { activity?: OperatorActivity },
): Unsubscribe {
  const byConnection = orgMap(cred.orgId)
  const now = Date.now()

  byConnection.set(cred.connectionId, {
    ...cred,
    activity: cred.activity ?? 'foreground',
    registeredAt: now,
    lastSeenAt: now,
  })

  // ⚠️ 第一層輪詢的間隔在排程當下就固定了。runtime 常常在還沒有任何憑證時
  //    就建立並排了 30 秒那一拍，少了這行它要等滿 30 秒才會發現有人上線了。
  notifyUpgrade(cred.orgId)

  let done = false
  return () => {
    if (done) return
    done = true
    // ⚠️ 只刪這一個 connectionId。若這筆已被 TTL 剔除、之後由心跳重建成另一個 connectionId
    //    （contracts §4），這裡會打空 —— 那一筆改由心跳的生命週期擁有，分頁關掉後心跳停止，
    //    ≤ CREDENTIAL_TTL_MS 由惰性回收清掉。這與 SC-002 對「異常中斷」已接受的保證是同一個。
    const current = registry().get(cred.orgId)
    current?.delete(cred.connectionId)
    dropIfEmpty(cred.orgId)
  }
}

/** 命中 `(orgId, operatorId, clientId)` 的**全部**登記 —— 複製分頁會共用 `clientId`，MUST NOT 只取一筆 */
function matching(orgId: string, operatorId: string, clientId: string): PollingCredential[] {
  const byConnection = registry().get(orgId)
  if (!byConnection) return []
  const out: PollingCredential[] = []
  for (const cred of byConnection.values()) {
    if (cred.operatorId === operatorId && cred.clientId === clientId) out.push(cred)
  }
  return out
}

/**
 * 連線層級存活心跳（`POST /api/connection/beat`，FR-005a）。
 *
 * 更新 `(orgId, operatorId, clientId)` 命中的**全部**登記的 `lastSeenAt`；
 * **命中 0 筆時以傳入的身分與憑證重新登記一筆**（upsert）。
 *
 * ⚠️ **upsert 不是保險而是必要**（research.md #3a）：瀏覽器把隱藏分頁的計時器節流到約每分鐘一次
 *    （> 45 秒 TTL）→ 登記被剔除 → 而 SSE 連線沒有斷、不會重連，沒有任何路徑會重新登記 →
 *    那條連線的憑證永遠回不來。寫成「找不到就 no-op」，背景分頁會自己重現本檔要修的缺陷。
 *
 * ⚠️ **定址時不先套 TTL 濾網**（2026-09-02 裁定，contracts §4）：逾期但尚未被讀取剔除的舊筆
 *    直接刷新 —— 原 `connectionId` 保留，SSE 關閉時的 unsubscribe 仍打得中。
 *    只有讀取點跑過、登記真的消失後，才會命中 0 筆而走重建。先套濾網再比對會讓每一次漏拍
 *    都製造一筆孤兒登記。
 *
 * 重建的那一筆 `connectionId` **由 server 現場另產** —— `connectionId` 維持「永不離開 server、
 * 不信任 client」，body 一如既往只有 `clientId`。活躍度取 `'background'`：會被 TTL 剔除的
 * 幾乎都是計時器被節流的**隱藏**分頁，那正是背景；若其實是前景（例如網路短暫中斷 > 45 秒），
 * 下一拍 presence 心跳（帶 `visible`）就會把它改回來。
 */
export function touchCredential(
  identity: { orgId: string, operatorId: string, clientId: string, accessToken: string },
): { touched: number, created: boolean } {
  const now = Date.now()
  const hits = matching(identity.orgId, identity.operatorId, identity.clientId)
  if (hits.length > 0) {
    for (const cred of hits) cred.lastSeenAt = now
    return { touched: hits.length, created: false }
  }

  const connectionId = crypto.randomUUID()
  orgMap(identity.orgId).set(connectionId, {
    connectionId,
    ...identity,
    activity: 'background',
    registeredAt: now,
    lastSeenAt: now,
  })
  return { touched: 0, created: true }
}

/**
 * 更新活躍度（分頁切到背景時由 presence 心跳帶進來）。
 *
 * ⚠️ 以 `(orgId, operatorId, clientId)` 定址並更新**全部**命中者（research.md #2）。
 *    舊實作是 operator 級整筆覆寫：兩個分頁一前景一背景時後送者贏，
 *    `hasForegroundOperator()` 因此可能回錯，第一層清單輪詢在 3 秒與 30 秒之間跳，沒有任何訊號。
 * ⚠️ 找不到時 no-op（**不** upsert）—— 活躍度沒有登記可依附時本來就無事可做，
 *    重建登記是連線心跳（`touchCredential()`）的責任。
 */
export function setCredentialActivity(
  orgId: string,
  operatorId: string,
  clientId: string,
  activity: OperatorActivity,
): void {
  const hits = matching(orgId, operatorId, clientId)
  if (hits.length === 0) return
  for (const cred of hits) cred.activity = activity
  // 切回前景 → 間隔應由 30 秒回到 3 秒，但已排定的那一拍不會自己變快
  if (activity === 'foreground') notifyUpgrade(orgId)
}

/**
 * 借一份憑證來做唯讀輪詢。沒有任何人連線時回 null —— 呼叫端應停止輪詢。
 *
 * ⚠️ 先剔除逾期登記（I-2：逾期者 MUST NOT 被回傳），再取**最近登記**的那一份：
 *    越晚登記的 session 剩餘壽命越長，比較不會在輪詢途中過期。
 */
export function borrowCredential(orgId: string): PollingCredential | null {
  evictExpired(orgId, Date.now())
  const byConnection = registry().get(orgId)
  if (!byConnection || byConnection.size === 0) return null

  let newest: PollingCredential | null = null
  for (const cred of byConnection.values()) {
    if (!newest || cred.registeredAt > newest.registeredAt) newest = cred
  }
  return newest
}

/** 該組織是否有人「前景」在線 —— 決定清單輪詢的頻率（§9.2）。I-3：任一未逾期登記為前景即為 true */
export function hasForegroundOperator(orgId: string): boolean {
  evictExpired(orgId, Date.now())
  const byConnection = registry().get(orgId)
  if (!byConnection) return false
  for (const cred of byConnection.values()) {
    if (cred.activity === 'foreground') return true
  }
  return false
}

/** 目前有憑證登記的組織 —— 輪詢排程器用來決定要跑哪些迴圈（先剔除逾期者，全部登記都逾期的組織不算） */
export function registeredOrgIds(): string[] {
  const now = Date.now()
  for (const orgId of [...registry().keys()]) evictExpired(orgId, now)
  return [...registry().keys()]
}

/**
 * 該組織目前的全部登記（**不**觸發惰性回收）—— 監控（§17）與測試用。
 * ⚠️ 回傳的是登記本身（含 `accessToken`），MUST NOT 送出 server 或寫進日誌。
 */
export function registeredCredentials(orgId: string): PollingCredential[] {
  return [...(registry().get(orgId)?.values() ?? [])]
}

/** 測試用：清空登記處 */
export function resetCredentials(): void {
  registry().clear()
}
