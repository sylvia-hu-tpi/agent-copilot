/**
 * 憑證外洩掃描 —— 自 `test/smoke-http.ts` 抽出的共用 helper（specs/006 FR-035、R3.11）。
 *
 * ⚠️ **為什麼值得一個共用檔案**：憲法 1.1 的「token 不進任何回應」在 smoke 有守，
 *    但**錯誤路徑**沒有 —— 而錯誤訊息正是最容易夾帶憑證的地方（SDK 的例外訊息
 *    常常帶著整個請求，包含 Authorization 標頭）。006 新增了四種寫入失敗形態，
 *    每一種都會把平台的錯誤訊息往上傳，因此每一種都要掃。
 *
 * ⚠️ 掃的是**假 gateway 實際發出的那幾個 token 字串**，不是「看起來像 token 的
 *    正則」—— 後者會有偽陽性也會有偽陰性，而這條檢查一旦不可信就會被關掉。
 */

/** 與 `test/mock-gateway.ts` 發出的字串逐字相同。⚠️ 兩處要一起改 */
export const MOCK_SECRETS = [
  'acc_TESTTOKEN',
  'login_acc_TESTTOKEN',
  'refresh_TESTTOKEN',
] as const

/**
 * @param haystack 要掃描的內容（回應 body、錯誤訊息、`data` 的 JSON 序列化…）
 * @returns 命中的憑證字串；空陣列代表乾淨
 */
export function leakedSecrets(haystack: string): string[] {
  return MOCK_SECRETS.filter(s => haystack.includes(s))
}

/**
 * 把一個錯誤攤平成可掃描的字串 —— 訊息、`data`、`cause` 都要看。
 *
 * ⚠️ `cause` 不可略過：我方的 `ClosureWriteError` 會把平台的原始錯誤掛在
 *    `cause` 上，而那正是最可能帶著憑證的那一個。
 */
export function errorHaystack(err: unknown): string {
  const parts: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return
    if (typeof value === 'string') { parts.push(value); return }
    if (value instanceof Error) {
      parts.push(value.message, value.stack ?? '')
      visit((value as { cause?: unknown }).cause, depth + 1)
      visit((value as { data?: unknown }).data, depth + 1)
      return
    }
    if (typeof value === 'object') {
      try { parts.push(JSON.stringify(value)) }
      catch { /* 循環參照就算了，上面已經取到 message */ }
    }
  }
  visit(err, 0)
  return parts.join('\n')
}
