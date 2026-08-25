/** ① 寄出 OTP —— docs/ARCHITECTURE.md §7.1 */

import { z } from 'zod'
import { anonymousImbraceClient } from '../../utils/imbrace-client.js'
import { readBodyAs } from '../../utils/validate.js'

const Body = z.object({
  email: z.string().trim().email('請輸入有效的 email'),
})

export default defineEventHandler(async (event) => {
  const { email } = await readBodyAs(event, Body)

  await anonymousImbraceClient().requestOtp(email)

  // ⚠️ 不回傳「此 email 是否存在」—— 那等於做帳號列舉。一律回相同結果。
  return { ok: true }
})
