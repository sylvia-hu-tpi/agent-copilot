/**
 * ② 驗證 OTP —— docs/ARCHITECTURE.md §7.1 / §5.1 ①
 *
 * 這一步一次拿到 `login_acc_` token 與組織清單，不需再呼叫 organizations.list()。
 * 兩者都存進 BFF session（stage: pending_org），因此：
 *  - 瀏覽器只拿到組織清單，拿不到任何 token
 *  - 重新整理 organization.vue 不會被踢回輸 email 的步驟
 */

import { z } from 'zod'
import { loginWithOtp } from '../../services/imbrace.js'
import { anonymousImbraceClient } from '../../utils/imbrace-client.js'
import { SESSION_TTL_MS, startBffSession } from '../../utils/session.js'
import { readBodyAs } from '../../utils/validate.js'

const Body = z.object({
  email: z.string().trim().email('請輸入有效的 email'),
  otp: z.string().trim().min(4, '請輸入驗證碼'),
})

export default defineEventHandler(async (event) => {
  const { email, otp } = await readBodyAs(event, Body)

  const result = await loginWithOtp(anonymousImbraceClient(), email, otp)

  await startBffSession(event, {
    stage: 'pending_org',
    email,
    operatorId: result.operatorId,
    operatorName: result.operatorName,
    loginToken: result.loginToken,
    organizations: result.organizations,
    expiresAt: Date.now() + SESSION_TTL_MS,
  })

  // ⚠️ 刻意不回傳 loginToken —— 憲法第 2 條，token 永不離開 server
  return {
    operatorName: result.operatorName,
    organizations: result.organizations,
  }
})
