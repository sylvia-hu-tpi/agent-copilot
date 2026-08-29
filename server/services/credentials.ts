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
 */

import type { Unsubscribe } from '../state/types.js'

/** 客服的即時活躍度 —— 決定第一層清單輪詢要跑多快（§9.2） */
export type OperatorActivity = 'foreground' | 'background'

export interface PollingCredential {
  operatorId: string
  orgId: string
  /** ⚠️ 永不離開 server，也永不寫進日誌（憲法 1.1 / 1.5） */
  accessToken: string
  activity: OperatorActivity
  registeredAt: number
}

const KEY = Symbol.for('agent-copilot.polling-credentials')

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

/**
 * 登記一位連線中客服的憑證（由 SSE 連線建立時呼叫）。
 *
 * @returns 取消登記的函式 —— **必須**在 SSE 連線關閉時呼叫，
 *          否則客服關掉分頁後輪詢仍會用他的 token 繼續跑。
 */
export function registerCredential(
  cred: Omit<PollingCredential, 'registeredAt' | 'activity'> & { activity?: OperatorActivity },
): Unsubscribe {
  const byOperator = registry().get(cred.orgId) ?? new Map<string, PollingCredential>()
  registry().set(cred.orgId, byOperator)

  byOperator.set(cred.operatorId, {
    ...cred,
    activity: cred.activity ?? 'foreground',
    registeredAt: Date.now(),
  })

  // ⚠️ 第一層輪詢的間隔在排程當下就固定了。runtime 常常在還沒有任何憑證時
  //    就建立並排了 30 秒那一拍，少了這行它要等滿 30 秒才會發現有人上線了。
  notifyUpgrade(cred.orgId)

  let done = false
  return () => {
    if (done) return
    done = true
    byOperator.delete(cred.operatorId)
    if (byOperator.size === 0) registry().delete(cred.orgId)
  }
}

/** 更新活躍度（分頁切到背景時由 presence 心跳帶進來） */
export function setCredentialActivity(
  orgId: string,
  operatorId: string,
  activity: OperatorActivity,
): void {
  const cred = registry().get(orgId)?.get(operatorId)
  if (!cred) return
  cred.activity = activity
  // 切回前景 → 間隔應由 30 秒回到 3 秒，但已排定的那一拍不會自己變快
  if (activity === 'foreground') notifyUpgrade(orgId)
}

/**
 * 借一份憑證來做唯讀輪詢。沒有任何人連線時回 null —— 呼叫端應停止輪詢。
 *
 * ⚠️ 取**最近登記**的那一份：越晚登記的 session 剩餘壽命越長，
 *    比較不會在輪詢途中過期。
 */
export function borrowCredential(orgId: string): PollingCredential | null {
  const byOperator = registry().get(orgId)
  if (!byOperator || byOperator.size === 0) return null

  let newest: PollingCredential | null = null
  for (const cred of byOperator.values()) {
    if (!newest || cred.registeredAt > newest.registeredAt) newest = cred
  }
  return newest
}

/** 該組織是否有人「前景」在線 —— 決定清單輪詢的頻率（§9.2） */
export function hasForegroundOperator(orgId: string): boolean {
  const byOperator = registry().get(orgId)
  if (!byOperator) return false
  for (const cred of byOperator.values()) {
    if (cred.activity === 'foreground') return true
  }
  return false
}

/** 目前有憑證登記的組織 —— 輪詢排程器用來決定要跑哪些迴圈 */
export function registeredOrgIds(): string[] {
  return [...registry().keys()]
}

/** 測試用：清空登記處 */
export function resetCredentials(): void {
  registry().clear()
}
