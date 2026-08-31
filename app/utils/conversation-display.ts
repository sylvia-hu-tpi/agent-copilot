/**
 * 對話在畫面上的共用呈現規則 —— 頭像、status 圓點、頻道 icon。
 *
 * ⚠️ 抽出來的理由不是「少寫幾行」，而是**兩處長不一樣就是 bug**：
 *    側欄列項與中欄標題列指的是同一個對話，頭像顏色／縮寫／狀態色若各算各的，
 *    客服點進去會看到「換了一個對話」的錯覺。這類不一致不會有型別錯誤。
 */

/** 頭像色階：沿用既有 token 配對，不另外發明新色票 */
const AVATAR_PALETTE = [
  { bg: 'var(--navy-soft)', fg: 'var(--navy)' },
  { bg: 'var(--active-bg)', fg: 'var(--active)' },
  { bg: 'var(--ai-bg)', fg: 'var(--ai)' },
  { bg: 'var(--agent-bg)', fg: 'var(--navy-2)' },
  { bg: 'var(--warn-bg)', fg: 'var(--warn)' },
  { bg: 'var(--open-bg)', fg: 'var(--open)' },
] as const

/** 依名稱／代號決定固定的頭像配色，同一對話每次渲染都要拿到同一組顏色 */
export function avatarColor(key: string): { bg: string, fg: string } {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]!
}

/**
 * 頭像縮寫：`TWN#GW4772` 這類代號取 `#` 後兩個字母（如 `GW`）；
 * 真人姓名（如「高翊庭」）無此樣式，中文取首字、其餘取前兩碼並轉大寫。
 */
export function avatarLabel(source: string): string {
  const src = (source || '').trim()
  const coded = src.match(/#([a-zA-Z]{2})/)
  if (coded) return coded[1]!.toUpperCase()
  if (!src) return '?'
  return /[一-鿿]/.test(src[0]!) ? src.slice(0, 1) : src.slice(0, 2).toUpperCase()
}

/**
 * 對話 status 的圓點配色（畫布 §8.2 逐字）。
 * ⚠️ 未列出的 status **不畫圓點**——憑空給一個顏色等於發明一個設計稿沒有的狀態。
 */
export const STATUS_COLOR: Record<string, { fg: string, bg: string } | undefined> = {
  active: { fg: 'var(--active)', bg: 'var(--active-bg)' },
  open: { fg: 'var(--open)', bg: 'var(--open-bg)' },
}

/**
 * 頻道 icon：自訂圖檔，放在 `public/icons/`。
 * 沒有對應圖檔的頻道維持文字徽記。
 */
export const CHANNEL_ICON: Record<string, string> = {
  web: '/icons/channel-web.png',
  line: '/icons/channel-line.png',
}

/**
 * 中欄 meta 列的「建立於 08/25 13:58」（畫布 §8.3）。
 * ⚠️ 不帶年份是照畫布；跨年的對話因此讀不出年份 —— 但那也是畫布的取捨，
 *    真要區分年份時 `title` 屬性帶完整時間即可，不改這一行的密度。
 */
export function createdAtLabel(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

/**
 * meta 列要顯示的短對話代號（畫布示範值 `conv_8f21c0`）。
 *
 * ⚠️ 我方的 id 是裸 UUID，沒有 `conv_` 前綴（§9.3 —— 前綴只出現在訊息 payload 的
 *    `conversation_id`，`normalizeConversationId()` 一律脫掉）。這裡**不補回前綴**：
 *    補一個平台上不存在的前綴，會讓客服拿這串去官方介面搜尋時查不到。
 */
export function shortConversationId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}
