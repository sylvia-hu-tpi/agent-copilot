/**
 * 客服 id 的比對 —— 前端版本。
 *
 * ⚠️ 與 `server/sources/mappers.ts` 的 `sameOperator()` 是同一個規則，
 *    但不能直接 import：那個檔案會拉進 `@imbrace/sdk` 的型別，
 *    而憲法 1.2 規定 `server/` 以外不得碰 SDK。
 *
 * 規則本身很簡單但**不可省略**：訊息的 `from` 帶 `u_` 前綴，
 * 而登入回應的 `user_id` 不保證帶 —— 直接用 `===` 比會永遠不相等。
 */
export function sameOperatorId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return strip(a) === strip(b)
}

function strip(id: string): string {
  return id.startsWith('u_') ? id.slice('u_'.length) : id
}
