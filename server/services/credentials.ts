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
  if (cred) cred.activity = activity
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
