/**
 * 連線層級的存活心跳 —— specs/005-m2-residual-defects FR-005a、contracts/connection-lifecycle.md §4。
 *
 * 前端在 SSE 連線建立後每 `CONNECTION_HEARTBEAT_MS`（20 秒）送一次，**與有沒有進入對話無關**
 * （分頁開著但還沒點進任何對話時仍須送達）。server 端把 `(orgId, operatorId, clientId)`
 * 命中的**全部**憑證登記的 `lastSeenAt` 更新為現在；命中 0 筆時**重新登記一筆**（upsert）。
 *
 * ⚠️ **MUST NOT 沿用 `POST /api/presence`**：它的 body 必填 `conversationId`，分頁還沒進入任何
 *    對話時完全不送，會留一個永遠洩漏的視窗；而且它的 `state`／`joined`／`visible` 都以
 *    「對某個對話」為前提，拿掉對話之後這些欄位沒有意義（research.md #3）。
 *    兩支心跳回答的是不同問題（「有沒有人在看這個對話」vs「這條連線還在不在」），刻意不共用。
 *
 * ⚠️ **憲法 1.1**：body 只有 `clientId`、回應只有 `{ ok: true }`。身分與憑證一律取自
 *    `requireActiveBffSession(event)`（與 `stream.get.ts` 同一個來源），**不接受、也不回傳任何 token**。
 *    重建登記時的 `connectionId` 由 server 現場另產 —— `connectionId` 維持「永不離開 server」。
 */

import { z } from 'zod'
import { touchCredential } from '../../services/credentials.js'
import { requireActiveBffSession } from '../../utils/session.js'
import { readBodyAs } from '../../utils/validate.js'

const Body = z.object({
  /** 這個瀏覽器分頁的識別碼（與 `/api/stream?clientId=` 同一個）。⚠️ 只作定址，不作鍵 */
  clientId: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { clientId } = await readBodyAs(event, Body)
  const session = await requireActiveBffSession(event)

  touchCredential({
    orgId: session.orgId,
    operatorId: session.operatorId,
    clientId,
    accessToken: session.accessToken,
  })

  return { ok: true }
})
