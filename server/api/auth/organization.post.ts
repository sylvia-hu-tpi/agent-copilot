/**
 * ③ 選擇組織，換發 `acc_` token —— docs/ARCHITECTURE.md §7.1 / §5.1 ③
 *
 * ⚠️ 這裡走手動 exchange 而非 client.selectOrganization()，
 *    因為後者會丟棄 refresh_token，客服會在 8 小時 session 內被迫重跑 OTP。
 *    醜陋處全部關在 services/imbrace.ts 的 exchangeOrganizationToken() 裡。
 */

import { z } from 'zod'
import { exchangeOrganizationToken } from '../../services/imbrace.js'
import { loginTokenImbraceClient } from '../../utils/imbrace-client.js'
import { requirePendingBffSession, saveBffSession, SESSION_TTL_MS } from '../../utils/session.js'

const Body = z.object({
  organizationId: z.string().trim().min(1, '請選擇組織'),
})

export default defineEventHandler(async (event) => {
  const { organizationId } = Body.parse(await readBody(event))
  const pending = await requirePendingBffSession(event)

  // ⚠️ 只允許 ② 回傳的組織 —— 那份清單是「membership-scoped，每一筆都可 exchange」。
  //    不驗證的話，任何人都能拿別的組織 id 來試 exchange。
  const chosen = pending.organizations.find(o => o.id === organizationId)
  if (!chosen) {
    throw createError({ statusCode: 403, statusMessage: '此帳號不屬於該組織' })
  }

  const { accessToken, refreshToken } = await exchangeOrganizationToken(
    loginTokenImbraceClient(pending.loginToken),
    chosen.id,
  )

  await saveBffSession(event, {
    stage: 'active',
    email: pending.email,
    operatorId: pending.operatorId,
    operatorName: pending.operatorName,
    orgId: chosen.id,
    orgName: chosen.name,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + SESSION_TTL_MS,
  })

  // ⚠️ 回應中不得出現 accessToken / refreshToken
  return {
    operatorId: pending.operatorId,
    operatorName: pending.operatorName,
    orgId: chosen.id,
    orgName: chosen.name,
  }
})
