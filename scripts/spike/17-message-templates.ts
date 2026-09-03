/**
 * 17 — 罐頭訊息（message templates）端點（使用者於 2026-08-27 提供）
 *
 * `GET {cloud}/api/channel-service/v2/message_templates?business_unit_id={pub_id}&limit=15&skip=0&sort=-updated_at&fields=title`
 *
 * 與 14-contact-files 同一條 host（`cloud.imbrace.co`，非 SDK 打的 gateway），
 * 同樣不在 `@imbrace/sdk` 的公開型別中。
 *
 * **為什麼要測**：`specs/002-suggestion-knowledge-search` 的建議卡在知識庫未命中時，
 * 會退化成「AI 即時生成、無來源引用」的通用建議（FR-004）。罐頭訊息是後台人工維護、
 * 已審核過的文字——若它可讀，理論上可以成為憲法 4.3 白名單的**第二個來源**，
 * 讓那批「無來源」的卡片變成「有來源」的卡片。
 *
 * ⚠️ **本 spike 不改變 002 的任何實作**。002 已定案不假設此端點可用（見該 spec 的 Assumptions）；
 * 這裡只回答「形狀是什麼、拿不拿得到內容本體」，供後續 feature 決定是否納入。
 *
 * ⚠️ **2026-08-27 首跑的教訓（§9.3 的三種識別碼，第三次踩到）**：本腳本原先直接把
 * `businessUnitId()` 取得的 `bu_…` 當作 `business_unit_id` 傳入，端點回 `200 {data:[],total:0}`，
 * 於是記下「這個 business unit 沒有範本」。使用者隨後指出，他在瀏覽器看到的這個參數值是
 * **`pub_` 開頭**，與 `bu_…` 根本是兩種不同的識別碼。
 * **傳錯 id 不會 400、不會報錯，只會安靜地回 0 筆**——正是 CLAUDE.md 列為第一級地雷的那個失效模式。
 * 因此本腳本改為**列舉所有候選 id 逐一實測**，讓「哪一個才對」由回應決定，而不是由我推理。
 *
 * 要回答的問題：
 *   ① 端點在我方憑證下可用嗎（憑證是 gateway 的，未必吃得動 cloud host）
 *   ② `business_unit_id` 到底吃哪一種 id（`bu_` / `pub_` / channel `_id`）——空結果 vs 錯誤 id 必須分辨
 *   ③ 去掉 `fields=title` 後，拿得到**內容本體**嗎——只有標題的話對建議卡毫無用處
 *   ④ 分頁行為（`limit`/`skip`）與總數欄位
 *   ⑤ 附帶：`pub_` 若同時是「發送者前綴」與「business unit 識別碼」，H-3b 的
 *      「`pub_` = AI workflow」推論可能需要修正為「`pub_` = 官方帳號／publisher 實體」
 *   ⑥ 這個 `pub_` id 有沒有 API 可程式化取得（使用者 2026-08-27 二次提供
 *      `GET /api/platform/v1/business_units`，`data[].public_id`）——若吻合，
 *      「只能從瀏覽器 Network 面板抄」的限制就解除了
 *
 * 唯讀 GET，不觸及寫入類實測的風險（CLAUDE.md：`IMBRACE_ENV=stable` 是正式環境）。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import { businessUnitId, env, isMain, runProbe, writeReport } from './lib/harness.js'

const CLOUD = 'https://cloud.imbrace.co'

function transportOf(client: ImbraceClient) {
  return (client.messages as unknown as {
    http: { getFetch(): typeof fetch }
    base: string
  })
}

/** 只挑「看起來像內容本體」的鍵，避免把整包未知結構印進 findings */
function contentKeys(row: Record<string, unknown>): string[] {
  return Object.keys(row).filter(k => /content|body|text|message|payload|template/i.test(k))
}

/**
 * 只抓 `{{變數}}` 語法本身，不擷取周圍文字——`text` 是客服話術全文，
 * 依憲法 1.5「日誌不得輸出訊息全文」不得整段印出或存檔，即使是 spike 產出。
 * 佔位符名稱（如 `tel`）本身不是客戶個資，可以安全記錄。
 */
function extractPlaceholders(text: string): string[] {
  const matches = [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
  const names = matches.map(m => m[1]).filter((n): n is string => !!n)
  return [...new Set(names)]
}

/** 遞迴掃出所有帶型別前綴的 id 字串（`pub_` / `bu_` / `ch_` …），連同它出現的路徑 */
function collectPrefixedIds(node: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof node === 'string') {
    if (/^(pub|bu|ch|org|acc)_[\w-]{6,}$/.test(node) && !out.has(node)) out.set(node, path)
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectPrefixedIds(v, `${path}[${i}]`, out))
    return out
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectPrefixedIds(v, path ? `${path}.${k}` : k, out)
  }
  return out
}

interface Attempt {
  id: string
  where: string
  status: number | 'error'
  total: number | null
}

/** 拿一個候選 id 去打端點，回報 status 與 total —— 判斷「對不對」的唯一依據 */
async function tryId(
  fetchFn: typeof fetch,
  base: string,
  id: string,
  where: string,
): Promise<Attempt> {
  const url = `${base}?business_unit_id=${encodeURIComponent(id)}&limit=15&skip=0&sort=-updated_at`
  try {
    const r = await fetchFn(url, { method: 'GET' })
    if (!r.ok) return { id, where, status: r.status, total: null }
    const body = await r.json() as { total?: number, data?: unknown[] }
    const total = typeof body.total === 'number'
      ? body.total
      : (Array.isArray(body) ? (body as unknown[]).length : (body.data?.length ?? null))
    return { id, where, status: r.status, total }
  } catch {
    return { id, where, status: 'error', total: null }
  }
}

export const probe17 = () => runProbe('17', '罐頭訊息端點（message_templates）', async (p, client) => {
  const fetchFn = transportOf(client).http.getFetch()
  const base = `${CLOUD}/api/channel-service/v2/message_templates`

  // ── 列舉候選 id ───────────────────────────────────────────────────
  //    來源①：既有 harness 的 businessUnitId()（`bu_` 開頭，首跑用的就是它）
  //    來源②：channel.list() 回應裡所有帶型別前綴的 id（`pub_` 應該在這裡面）
  //    來源③：.env.local 的 SPIKE_PUBLIC_ID（使用者從瀏覽器 Network 面板提供的值）
  //    來源④：GET /api/platform/v1/business_units 的 `public_id`（使用者 2026-08-27 二次提供，
  //           見下方 new-17f——這支端點可程式化取得來源③的值，不必再手動抄瀏覽器）
  const buId = await businessUnitId(client)
  const channels = await client.channel.list() as unknown
  p.fixture('channel-list', channels)

  let platformBu: { publicId: string, raw: unknown } | null = null
  try {
    const r = await fetchFn(`${CLOUD}/api/platform/v1/business_units`, { method: 'GET' })
    if (r.ok) {
      const body = await r.json() as { data?: Array<{ public_id?: string }> }
      p.fixture('platform-business-units', body)
      const publicId = body.data?.find(row => row.public_id)?.public_id
      if (publicId) platformBu = { publicId, raw: body }
    }
  } catch {
    // 不影響主流程——這支是額外來源，拿不到就退回既有的三個來源
  }

  const candidates = new Map<string, string>()
  candidates.set(buId, 'harness businessUnitId()')
  for (const [id, where] of collectPrefixedIds(channels, 'channel.list()')) {
    if (!candidates.has(id)) candidates.set(id, where)
  }
  const fromEnv = env('SPIKE_PUBLIC_ID')
  if (fromEnv && !candidates.has(fromEnv)) candidates.set(fromEnv, '.env.local SPIKE_PUBLIC_ID')
  if (platformBu && !candidates.has(platformBu.publicId)) {
    candidates.set(platformBu.publicId, 'GET /api/platform/v1/business_units .data[].public_id')
  }

  const attempts: Attempt[] = []
  for (const [id, where] of candidates) attempts.push(await tryId(fetchFn, base, id, where))
  p.fixture('id-attempts', attempts)

  const reachable = attempts.filter(a => a.status === 200)
  const withData = attempts.filter(a => (a.total ?? 0) > 0)

  // ── ① 端點是否可用 ────────────────────────────────────────────────
  p.record({
    question: 'new-17a',
    claim: 'message_templates 端點（非 SDK 公開端點）在我方憑證下可用',
    verdict: reachable.length > 0 ? 'yes' : 'no',
    evidence: attempts.map(a => `${a.id.slice(0, 12)}…(${a.where}) → ${a.status}`
      + (a.total === null ? '' : ` total=${a.total}`)).join('；'),
    impact: reachable.length > 0
      ? 'gateway 憑證吃得動 cloud host，不需另外處理認證'
      : '⚠️ 401/403 代表憑證不通；404 代表路徑有誤',
  })

  // ── ② `business_unit_id` 到底吃哪一種 id ───────────────────────────
  //    關鍵：傳錯 id 也回 200 + 0 筆，所以「有資料的那一個」才是唯一可信的證據。
  const winner = withData[0]
  p.record({
    question: 'new-17b',
    claim: '`business_unit_id` 吃的是 `pub_` 開頭的 publisher id，不是 `bu_` 開頭的 business unit id',
    verdict: withData.length > 0
      ? (winner!.id.startsWith('pub_') ? 'yes' : 'no')
      : 'unknown',
    evidence: withData.length > 0
      ? `唯一查到資料的是 ${winner!.id.slice(0, 12)}…（來源：${winner!.where}），total=${winner!.total}；`
        + `其餘 ${attempts.length - withData.length} 個候選皆回 200 但 0 筆`
      : `${attempts.length} 個候選 id 全部回 200 但 0 筆——無法分辨「id 都不對」與「真的沒建範本」。`
        + '請在後台建一則範本後重跑，或把瀏覽器 Network 面板看到的值填入 .env.local 的 SPIKE_PUBLIC_ID',
    impact: withData.length > 0
      ? '🚨 §9.3「三種識別碼」再添一種：`pub_` 是 publisher／官方帳號實體，`bu_` 是 business unit，'
        + '兩者形狀都是前綴＋UUID，**傳錯不會報錯、只會安靜回 0 筆**。'
        + '任何要打 channel-service 的程式碼都必須明確標註吃的是哪一種'
      : '⚠️ 0 筆不等於端點不可用，也不等於 id 正確——首跑就是誤把 0 筆當成「沒有範本」',
  })

  // ── ⑥ 這個 `pub_` id 是否有 API 可程式化取得（不必手動抄瀏覽器）───────
  if (winner) {
    p.record({
      question: 'new-17f',
      claim: 'GET /api/platform/v1/business_units 的 `public_id` 可程式化取得 message_templates 要的那個 `pub_` id',
      verdict: platformBu
        ? (platformBu.publicId === winner.id ? 'yes' : 'partial')
        : 'no',
      evidence: platformBu
        ? (platformBu.publicId === winner.id
            ? `platform/v1/business_units 回傳 public_id=${platformBu.publicId.slice(0, 12)}…，`
              + `與 message_templates 唯一查得到資料的 id 完全一致`
            : `platform/v1/business_units 回傳 ${platformBu.publicId.slice(0, 12)}…，`
              + `與 message_templates 有效的 ${winner.id.slice(0, 12)}… **不一致**`)
        : 'platform/v1/business_units 端點不可用或回應中無 public_id 欄位',
      impact: platformBu?.publicId === winner.id
        ? '✅ 推翻先前「只能從瀏覽器 Network 面板抄」的結論——'
          + '`resolveBusinessUnitId()`（SDK 的 bu_）與這支新端點（channel-service 的 pub_）'
          + '可以各自程式化取得，不再需要任何寫死的環境變數／人工抄值。'
          + '若日後納入範本作為白名單來源，裝配路徑已經完整'
        : undefined,
    })
  }

  if (!winner) return

  // 後續三題一律用「已證實有資料」的那個 id，避免又在錯的 id 上得出結論
  const okId = winner.id
  const query = `business_unit_id=${encodeURIComponent(okId)}&limit=15&skip=0&sort=-updated_at`

  const res = await fetchFn(`${base}?${query}&fields=title`, { method: 'GET' })
  const titleOnly = res.ok ? await res.json() as unknown : null
  if (titleOnly) p.fixture('templates-title-only', titleOnly)

  // ── ③ 拿不拿得到內容本體（去掉 fields 限制）──────────────────────────
  const urlFull = `${base}?${query}`
  const resFull = await fetchFn(urlFull, { method: 'GET' })
  if (!resFull.ok) {
    p.record({
      question: 'new-17c',
      claim: '不帶 `fields` 時可取得範本的內容本體',
      verdict: 'no',
      evidence: `GET 不帶 fields → ${resFull.status}（帶 fields=title 時為 ${res.status}）`,
      impact: '只拿得到標題的話，對建議卡沒有價值——建議卡需要的是可送出的文字本身',
    })
    return
  }

  const full = await resFull.json() as unknown
  p.fixture('templates-full', full)

  const fullRows = Array.isArray(full)
    ? full as Record<string, unknown>[]
    : ((full as { data?: Record<string, unknown>[] })?.data ?? [])
  const sample = fullRows[0]
  const keys = sample ? Object.keys(sample) : []
  const bodyKeys = sample ? contentKeys(sample) : []

  p.record({
    question: 'new-17c',
    claim: '不帶 `fields` 時可取得範本的內容本體（不只標題）',
    verdict: bodyKeys.length > 0 ? 'yes' : (sample ? 'partial' : 'unknown'),
    evidence: sample
      ? `第一筆的欄位：${keys.join(', ')}；疑似內容本體的欄位：${bodyKeys.join(', ') || '（無）'}`
      : '回傳 0 筆，無從判斷欄位',
    impact: bodyKeys.length > 0
      ? '可作為 KnowledgeHit 之外的第二個白名單來源：範本 id 進白名單、內容進 snippet'
      : undefined,
  })

  // ── ⑤ `text` 是否含 `{{變數}}` 佔位符（僅抓語法本身，不印範本全文，憲法 1.5）───
  if (sample && typeof sample.text === 'string') {
    const placeholders = extractPlaceholders(sample.text)
    p.record({
      question: 'new-17g',
      claim: '範本 `text` 是否含 `{{變數}}` 佔位符',
      verdict: placeholders.length > 0 ? 'yes' : 'no',
      evidence: placeholders.length > 0
        ? `偵測到 ${placeholders.length} 個相異佔位符：${placeholders.map(x => `{{${x}}}`).join('、')}`
          + '（僅列出佔位符語法本身，範本全文不印出、不寫入 fixture——憲法 1.5）'
        : `未偵測到 {{...}} 語法（樣本長度 ${sample.text.length} 字）`,
      impact: placeholders.length > 0
        ? '🚨 直接把 `text` 當建議卡文字送出會逐字帶出 `{{tel}}` 這類語法給客戶，'
          + 'MUST 先決定處置才可納入：① 交給 `requiresData`（客服送出前自行填入）'
          + '② 整則排除含佔位符的範本 ③ 若能取得對話上下文對應值就地代換（電話號碼這類欄位'
          + '客服對話中未必存在對應資料，這條路線可行性存疑，優先考慮①②）。'
          + '此為 002 維持不納入罐頭訊息的唯一剩餘理由——僅此一筆樣本，'
          + '不能推論所有範本是否都含佔位符，需更多樣本或直接詢問 iMBrace 範本語法規格'
        : '本筆樣本無佔位符，但樣本數僅 1，不足以推論全體範本皆如此',
    })
  }

  // ── ④ 分頁行為 ────────────────────────────────────────────────────
  const resPage2 = await fetchFn(`${base}?business_unit_id=${encodeURIComponent(okId)}&limit=1&skip=1&sort=-updated_at`, { method: 'GET' })
  const page2 = resPage2.ok ? await resPage2.json() as unknown : null
  const page2Rows = Array.isArray(page2)
    ? page2 as unknown[]
    : ((page2 as { data?: unknown[] })?.data ?? [])

  // ⚠️ 全量 0 筆時，`limit=1&skip=1` 回 0 筆是必然結果，證明不了分頁有生效——
  //    §9.3 的教訓正是「看起來對」不等於「真的有作用」（八種增量寫法全被忽略，
  //    但每一種都回了看似正常的結果）。0 筆時必須是 unknown，不能是 yes。
  const pagingTestable = fullRows.length > 1
  p.record({
    question: 'new-17d',
    claim: '`limit`/`skip` 分頁參數確實生效（對照 §9.3：平台的訊息端點忽略八種增量寫法）',
    verdict: !resPage2.ok || !pagingTestable
      ? 'unknown'
      : (page2Rows.length <= 1 ? 'yes' : 'no'),
    evidence: !resPage2.ok
      ? `分頁請求 → ${resPage2.status}`
      : pagingTestable
        ? `limit=1&skip=1 回 ${page2Rows.length} 筆（全量為 ${fullRows.length} 筆）`
        : `全量僅 ${fullRows.length} 筆，limit/skip 回 ${page2Rows.length} 筆——`
          + '樣本不足以分辨「分頁生效」與「參數被忽略」，需先在後台建立 ≥2 則範本再重跑',
    impact: resPage2.ok && pagingTestable && page2Rows.length > 1
      ? '⚠️ 分頁參數被忽略——與 §9.3 的訊息端點同一個坑，取全量後自行切'
      : undefined,
  })

  // ── ⑤ 附帶收穫：`pub_` 的語意 ──────────────────────────────────────
  //    H-3b 目前把 `from: pub_…` 推論為「AI workflow」。若同一個前綴也是
  //    business unit 層級的識別碼，那個推論的標的可能一開始就抓錯了。
  if (okId.startsWith('pub_')) {
    p.record({
      question: 'H-3b',
      claim: '`pub_` 前綴代表的是「官方帳號／publisher 實體」，而非「AI workflow」這個角色',
      verdict: 'partial',
      evidence: `message_templates 的 business_unit_id 吃的是 ${okId.slice(0, 12)}…（pub_ 開頭），`
        + '代表 `pub_` 標識的是一個「發布主體」層級的實體，不是某個 AI 流程。'
        + '對照 03-operators-snapshot.json：對話的 operators 裡也有一個 `pub_` id，名稱為 Bot',
      impact: '⚠️ 這**不會**改變撞單防護的現行行為（`from: pub_…` 仍然代表「不是真人客服送的」，'
        + '撞單該攔還是要攔），但會改變 IMBRACE_QUESTIONS H-3b 的問法——'
        + '該問的不是「pub_ 是不是 AI」，而是「同一個 publisher 送出的訊息，'
        + '哪些是真的送達客戶、哪些是 workflow 的內部中繼訊息」（那才是 H-3c 的真正問題）',
    })
  }
})

if (isMain(import.meta.url)) {
  const findings = await probe17()
  console.log(`\n📄 ${writeReport(findings)}`)
  console.log(`\n環境：${env('IMBRACE_ENV', 'stable')}\n`)
}
