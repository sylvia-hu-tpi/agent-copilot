/**
 * 「絕對時刻」在畫面上的顯示格式 —— **本地時區 ＋ 時區標記**。
 *
 * ⚠️ 抽出來的理由不是「少寫幾行」，是**這件事有兩個相反的要求，很容易被弄成同一種**：
 *    - **畫面**要本地時區（客服在 UTC+8 讀 `02:13`，對不上自己十點多接手的記憶）。
 *    - **寫進 Data Board 與後端日誌的值**要原始 UTC ISO —— 存進去的字串一旦帶了
 *      產生它的那台瀏覽器的時區，之後就再也無法確定它是哪個時刻。
 *    本檔只負責前者，而且只回傳字串、不碰任何要送出的 payload。
 *
 * ⚠️ **時區標記（`timeZoneName: 'short'`）MUST 保留**。這些時刻都可能被拿去跟別處對照
 *    （Board 的 `joined_at`、後端日誌、同事的截圖），而那些一律是 UTC。
 *    不標時區的本地時間會讓同一個時刻看起來像兩個不同的時刻 ——
 *    而這些欄位的用途正是事後核對，把它變得更難核對等於白做。
 */

/**
 * 單一 ISO 時刻 → `2026/09/08 10:13 [GMT+8]`。
 *
 * ⚠️ 解析失敗時回傳**原字串**，MUST NOT 回 `Invalid Date` ——
 *    看不懂的原始值也比一句假的錯誤訊息有用，而且那正是「這個值本身壞掉」的證據。
 *
 * @param timeZone 省略 ＝ 瀏覽器的當地時區（正式路徑一律省略）。
 *        存在只為了讓測試能釘住一個時區 —— 照跑測試那台機器的時區斷言，
 *        換一台機器就會紅，而那個紅燈與程式碼對錯無關。
 */
export function formatAbsolute(iso: string, locale: string, timeZone?: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    timeZone,
  }).format(at)
}

/**
 * ISO8601 的形狀。⚠️ **要求帶時區（`Z` 或 `±hh:mm`）**：不帶時區的
 * `2026-09-08T02:13:19` 會被 `new Date()` 當成**本地時間**解析，
 * 換算出來的東西是錯的，而且錯得看不出來 —— 這種字串寧可原樣顯示。
 */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g

/**
 * 把一整句話裡的 ISO 時刻**就地**換成易讀版本，其餘一個字都不動。
 *
 * ⚠️ **就地改寫，不是重組句子。** 用在 server 已經組好的說明文字上
 *    （例如 `sentimentNote`）—— 要在前端重組就得把那些句子拆成 i18n key ＋ 參數，
 *    連帶改動契約欄位、Board schema 與規格文件；而客服要的只是「那個時間我看得懂」。
 *
 * ⚠️ 認不出來的就留原樣。`sentimentNote` 其中一句正是
 *    「區間起點無法解析（…）」—— 那句裡的字串本來就不是合法時間，
 *    **它 MUST 維持原樣**，否則那句話會自相矛盾。
 */
export function humanizeTimestamps(text: string, locale: string, timeZone?: string): string {
  return text.replace(ISO_TIMESTAMP, iso => formatAbsolute(iso, locale, timeZone))
}
