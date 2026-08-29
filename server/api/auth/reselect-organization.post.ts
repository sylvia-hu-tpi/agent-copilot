/**
 * 回到選組織畫面 —— 把 active session 退回 `pending_org`（U-3，2026-08-30）。
 *
 * ── 為什麼是「退回」而不是「直接換」 ─────────────────────────────
 * 換組織的實質動作就是 `organization.post.ts` 已經在做的那件事：用 `login_acc_`
 * 中間 token 對目標組織 exchange。與其再寫一套「換組織」端點（第二份驗證清單、
 * 第二份 exchange 呼叫、第二個會漂移的地方），這裡只把 session 的 stage 退回去，
 * 讓既有的選組織流程**原封不動**地跑第二次。
 *
 * ⚠️ **這支會丟掉目前組織的 `accessToken` 與 `refreshToken`。**
 *    那是刻意的：它們綁定在舊組織上，留著只會變成一份不知道該不該用的憑證。
 *    使用者若中途反悔而沒有重新選組織，session 會停在 `pending_org` ——
 *    路由守衛會把他帶到 `/organization`，那正是他要去的地方，不會卡死。
 *
 * ⚠️ **背景輪詢的憑證不需要在這裡清。** 它由 SSE 連線的生命週期管理
 *    （`registerCredential()` 的 unsubscribe 在連線關閉時執行），
 *    而導向 `/organization` 會離開工作區、關掉那條連線。
 *    在這裡再清一次等於製造第二個要維護的清理點。
 */

import { requireActiveBffSession, saveBffSession, SESSION_TTL_MS } from '../../utils/session.js'

export default defineEventHandler(async (event) => {
  const session = await requireActiveBffSession(event)

  await saveBffSession(event, {
    stage: 'pending_org',
    email: session.email,
    operatorId: session.operatorId,
    operatorName: session.operatorName,
    loginToken: session.loginToken,
    organizations: session.organizations,
    expiresAt: Date.now() + SESSION_TTL_MS,
  })

  // ⚠️ 回應不得出現任何 token（憲法 1.1）
  return { stage: 'pending_org' as const, organizations: session.organizations }
})
