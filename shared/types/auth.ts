/**
 * 登入相關的領域型別（前後端共用）—— docs/ARCHITECTURE.md §7.1。
 *
 * ⚠️ 這裡只放「可以送到瀏覽器」的東西。
 * access token / refresh token 屬於 server session，定義在 server/state/types.ts，
 * 永遠不會出現在本檔 —— 這個界線就是憲法 1.1在型別層的體現。
 */

/**
 * 第 ② 步 loginWithOtp 一次回傳 token 與組織清單，不需再呼叫 organizations.list()。
 *
 * ⚠️ `role`（實測 `admin`）與 `isAdmin`（實測 `false`）語意不一致、值域待確認
 * （IMBRACE_QUESTIONS H-5）。在確認前**不可**用它們做主管權限判定。
 */
export interface OrganizationChoice {
  id: string
  name: string
  role?: string
  isAdmin?: boolean
  status?: string
}

/** GET /api/auth/me 的回應 —— 刻意只有身分，沒有任何憑證 */
export interface MeResponse {
  stage: 'pending_org' | 'active'
  email: string
  operatorId?: string
  operatorName?: string
  orgId?: string
  orgName?: string
  /** stage 為 pending_org 時提供，供 organization.vue 重新整理後仍能渲染 */
  organizations?: OrganizationChoice[]
}
