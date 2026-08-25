/** 登出：清 server session 與 cookie —— docs/ARCHITECTURE.md §7.2 */

import { dropBffSession } from '../../utils/session.js'

export default defineEventHandler(async (event) => {
  await dropBffSession(event)
  return { ok: true }
})
