/**
 * 目前登入狀態 —— docs/ARCHITECTURE.md §7.2
 *
 * 前端 SPA 啟動與每次重新整理都靠這支判斷該停在哪一步。
 * ⚠️ 回應刻意只有身分，沒有任何憑證。
 */

import type { MeResponse } from '../../../shared/types/auth.js'
import { readBffSession } from '../../utils/session.js'

export default defineEventHandler(async (event): Promise<MeResponse> => {
  const session = await readBffSession(event)
  if (!session) throw createError({ statusCode: 401, statusMessage: '尚未登入' })

  if (session.stage === 'pending_org') {
    return {
      stage: 'pending_org',
      email: session.email,
      operatorId: session.operatorId,
      operatorName: session.operatorName,
      // 重新整理 organization.vue 時要能重新渲染選單，不必重跑 OTP（§5.1 ①）
      organizations: session.organizations,
    }
  }

  return {
    stage: 'active',
    email: session.email,
    operatorId: session.operatorId,
    operatorName: session.operatorName,
    orgId: session.orgId,
    orgName: session.orgName,
  }
})
