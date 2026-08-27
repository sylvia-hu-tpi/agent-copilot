/**
 * Business unit id 的推導與快取。
 *
 * ⚠️ 為何非有不可：實測 `conversations.list()` 在沒有 business unit scope 時
 * **永遠回傳空陣列**，且不報錯。必須改用 `conversations.search({ businessUnitId, q })`。
 * 這是「症狀看起來像沒資料、實際是查詢方式錯」的典型坑，見 docs/PLATFORM_CAPABILITY.md。
 *
 * bu id 由 `channel.list()` 的 `bu_id` 取得。此值在一個組織內近乎不變，
 * 但每次列對話都多打一次 API 太浪費 —— 故以組織為鍵快取。
 *
 * ⚠️ **本函式回傳的 `bu_…` 只適用於 SDK 的 `conversations.*`，MUST NOT 拿去打
 * `cloud.imbrace.co/api/channel-service/**`。** 後者的 `business_unit_id` 參數吃的是
 * **`pub_` 開頭的另一種識別碼**——而且它在回應裡的欄位名也叫 `bu_id`，裝的卻是 `pub_` 值。
 * 兩者形狀都是「前綴＋UUID」，傳錯**不會報錯，只會安靜回 `{data:[],total:0}`**。
 * 2026-08-27 實測（`npm run spike:templates`）已踩過一次，詳見
 * `docs/PLATFORM_CAPABILITY.md` §4.1。這是 §9.3「三種識別碼」的第四種。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import { unwrapPaged } from '../sources/mappers.js'

/** ⚠️ SDK 把 channel.list() 標成 Channel[]，實測回的是 { data: [...] }，且 bu_id 不在型別中 */
interface RawChannel {
  bu_id?: string
}

const TTL_MS = 30 * 60 * 1000

const CACHE_KEY = Symbol.for('agent-copilot.bu-cache')
type Global = typeof globalThis & {
  [CACHE_KEY]?: Map<string, { id: string, expiresAt: number }>
}

function cache(): Map<string, { id: string, expiresAt: number }> {
  const g = globalThis as Global
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map()
  return g[CACHE_KEY]
}

/**
 * @param orgId 快取鍵。不同組織的 bu 不同，不可共用。
 * @param override 由 runtimeConfig / 環境變數指定時直接採用，跳過推導。
 */
export async function resolveBusinessUnitId(
  client: ImbraceClient,
  orgId: string,
  override?: string,
): Promise<string> {
  if (override) return override

  const hit = cache().get(orgId)
  if (hit && hit.expiresAt > Date.now()) return hit.id

  const channels = unwrapPaged<RawChannel>(await client.channel.list())
  const id = channels.find(c => c.bu_id)?.bu_id
  if (!id) {
    throw new Error(
      `組織 ${orgId} 的 channel 清單中找不到 bu_id —— `
      + '無法組出 conversations.search() 的查詢範圍（見 docs/PLATFORM_CAPABILITY.md）',
    )
  }

  cache().set(orgId, { id, expiresAt: Date.now() + TTL_MS })
  return id
}
