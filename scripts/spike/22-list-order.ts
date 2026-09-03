/**
 * 22 — `conversations.search()` 的預設排序
 *
 * ── 為什麼非問不可 ─────────────────────────────────────────────
 * §9.3.1 的第一層清單輪詢只取前 `LIST_PAGE_SIZE`（100）筆且**不分頁**，
 * 側欄也因此把「載入更多」鎖在同一個上限（`stores/conversations.ts`）。
 * 這整套安排只有在一個前提下才成立：
 *
 *     **有新訊息的對話，會被排到清單的前面。**
 *
 * 若平台預設按 `created_at`（或建立順序）排，那麼一個三個月前建立的老對話
 * 今天來了新訊息，可能排在第 300 位 —— 第一層永遠看不到它，
 * 客服**完全不會知道有這則訊息**，而且不報錯、沒有日誌。
 * 對話數上百的正式環境會真的發生。
 *
 * 目前唯一的樣本（`out/13-list-sample.json`）只有 3 筆，順序與 `last_message_at`
 * 遞減一致，但 n=3 無法區分是 `last_message_at` 還是 `updated_at` 排序，
 * 也無法排除只是巧合。本支就是為了把它從「看起來像」變成「量過」。
 *
 * ── 這支做什麼 ────────────────────────────────────────────────
 * ⚠️ **全程唯讀**：只呼叫 `conversations.search()`，不 JOIN、不送訊息、不改 mode。
 *    可以安全地對 `IMBRACE_ENV=stable`（正式環境）執行。
 *
 * ① 取一整頁，檢查三個時間欄位各自是否單調遞減 —— 判斷排序鍵。
 * ② 分兩頁取（skip=0 / skip=N），檢查邊界是否連續、有無重疊或跳號 ——
 *    這決定「載入更多」的 skip 分頁會不會漏抓。
 *
 * ⚠️ **本支回答不了「超過 100 筆時實際會怎樣」** —— 那要等組織的對話數真的
 *    超過上限才驗得到。它只回答排序規則本身。
 */

import { runProbe, requireEnv, env, isMain, type Finding } from './lib/harness.js'
import { unwrapPaged } from '../../server/sources/mappers.js'
import { resolveBusinessUnitId } from '../../server/services/business-unit.js'

/** 清單單筆裡我們關心的三個時間欄位（SDK 型別未宣告，實測存在） */
interface RawRow {
  id?: string
  name?: string
  status?: string
  last_message_at?: string | null
  updated_at?: string | null
  created_at?: string | null
}

const FIELDS = ['last_message_at', 'updated_at', 'created_at'] as const
type Field = typeof FIELDS[number]

/** 單調遞減的比例 —— 1 表示完全依此欄位由新到舊排序 */
function descRatio(rows: RawRow[], field: Field): { ratio: number, pairs: number, missing: number } {
  let ok = 0
  let pairs = 0
  let missing = 0
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]?.[field]
    const b = rows[i]?.[field]
    if (!a || !b) { missing++; continue }
    pairs++
    if (new Date(a).getTime() >= new Date(b).getTime()) ok++
  }
  return { ratio: pairs === 0 ? 0 : ok / pairs, pairs, missing }
}

export const probe22 = () => runProbe('22', '清單預設排序與 skip 分頁邊界', async (p, client) => {
  const orgId = requireEnv('IMBRACE_ORGANIZATION_ID')
  const businessUnitId = env('IMBRACE_BUSINESS_UNIT_ID') || await resolveBusinessUnitId(client, orgId)

  // ── ① 一整頁 ────────────────────────────────────────
  const PAGE = 100
  const first = unwrapPaged<RawRow>(await client.conversations.search({ businessUnitId, q: '', limit: PAGE }))
  console.log(`  取回 ${first.length} 筆（limit=${PAGE}）`)

  if (first.length < 2) {
    console.log('  ⏭  少於 2 筆，判斷不了排序')
    p.record({
      question: 'U-1', claim: 'conversations.search() 的預設排序鍵',
      verdict: 'unknown',
      evidence: `只取回 ${first.length} 筆，樣本不足`,
      impact: '§9.3.1 的 100 筆上限是否安全仍未知',
    })
    return
  }

  const scores = FIELDS.map(f => ({ field: f, ...descRatio(first, f) }))
  for (const s of scores) {
    console.log(
      `     ${s.field.padEnd(18)} 遞減比例 ${(s.ratio * 100).toFixed(1)}%`
      + `（可比對 ${s.pairs} 組，缺值 ${s.missing} 組）`,
    )
  }
  p.fixture('list-order-sample', first.slice(0, 30).map(r => ({
    id: r.id, status: r.status,
    last_message_at: r.last_message_at, updated_at: r.updated_at, created_at: r.created_at,
  })), true)

  // ⚠️ 只有「完全遞減」才算數：99% 的遞減比例代表它**不是**排序鍵，只是碰巧接近。
  const perfect = scores.filter(s => s.pairs > 0 && s.ratio === 1)
  const sortKey = perfect.find(s => s.field === 'last_message_at')
    ?? perfect.find(s => s.field === 'updated_at')
    ?? perfect[0]

  // last_message_at 的填充率（§9.3.1 實測 83%）—— 缺值的那些靠什麼排也要看得出來
  const filled = first.filter(r => r.last_message_at).length
  console.log(`     last_message_at 填充率 ${((filled / first.length) * 100).toFixed(0)}%（${filled}/${first.length}）`)

  p.record({
    question: 'U-1',
    claim: 'conversations.search() 是否預設把「最近有新訊息的對話」排在前面',
    verdict: sortKey
      ? (sortKey.field === 'created_at' ? 'no' : 'yes')
      : 'partial',
    evidence: sortKey
      ? `n=${first.length}，\`${sortKey.field}\` 完全遞減（${sortKey.pairs} 組比對全部成立）；`
        + `其餘欄位：${scores.filter(s => s.field !== sortKey.field).map(s => `${s.field}=${(s.ratio * 100).toFixed(0)}%`).join('、')}`
      : `n=${first.length}，三個時間欄位皆非完全遞減`
        + `（${scores.map(s => `${s.field}=${(s.ratio * 100).toFixed(0)}%`).join('、')}）`,
    impact: !sortKey
      ? '❗ 清單沒有可辨識的時間排序 → §9.3.1 的「只取前 100 筆且不分頁」不安全：'
        + '排在 100 名之後的對話有新訊息時，第一層永遠偵測不到，且不報錯。'
        + '必須改為指定排序參數，或補上第一層的分頁。'
      : sortKey.field === 'created_at'
        ? '❗ 依建立時間排序 → 老對話收到新訊息時不會前移，100 筆上限不安全（同上）。'
        : `✅ 依 \`${sortKey.field}\` 由新到舊排序 → 有新訊息的對話會前移，`
          + '§9.3.1 的 100 筆上限在「對話總數 > 100 但活躍對話 < 100」的情況下安全。'
          + '⚠️ 仍未驗證的是總數真的超過 100 時的實際行為。',
  })

  // ── ② skip 分頁邊界 ─────────────────────────────────
  // 「載入更多」用 skip 分頁；若兩頁之間會重疊或跳號，去重就不只是保險而是必要
  const HALF = Math.max(2, Math.floor(first.length / 2))
  if (first.length >= 4) {
    const pageA = unwrapPaged<RawRow>(await client.conversations.search({ businessUnitId, q: '', limit: HALF, skip: 0 }))
    const pageB = unwrapPaged<RawRow>(await client.conversations.search({ businessUnitId, q: '', limit: HALF, skip: HALF }))
    const idsA = new Set(pageA.map(r => r.id))
    const overlap = pageB.filter(r => idsA.has(r.id)).length
    const combined = new Set([...pageA, ...pageB].map(r => r.id))
    const expected = Math.min(first.length, HALF * 2)

    console.log(`     skip 分頁：A=${pageA.length} B=${pageB.length} 重疊=${overlap} 去重後=${combined.size}（單頁取回同範圍=${expected}）`)

    p.record({
      question: 'U-1b',
      claim: 'skip 分頁的兩頁之間是否連續（無重疊、無跳號）',
      verdict: overlap === 0 && combined.size === expected ? 'yes' : 'partial',
      evidence: `limit=${HALF}：A ${pageA.length} 筆、B ${pageB.length} 筆，重疊 ${overlap} 筆，`
        + `去重後 ${combined.size} 筆（單頁取同範圍為 ${expected} 筆）`,
      impact: overlap === 0 && combined.size === expected
        ? '✅ skip 分頁在靜態清單下連續。⚠️ 這不代表清單持續重排時也連續 —— '
          + '側欄的 `loadMore()` 仍必須以 id 去重（已實作）。'
        : '⚠️ skip 分頁會重疊或跳號 → 「載入更多」的 id 去重是必要的，不是保險；'
          + '且跳號代表可能漏抓，捲到底不等於看完全部。',
    })
  }
  // ── ③ skip 被忽略時，換哪個參數名可行？ ─────────────
  //    ⚠️ 直接打 raw HTTP：SDK 只宣告了 `skip`，要試別的名字只能繞過它。
  //       這是「SDK 型別與實際 API 不一致」的同一類問題 —— spike 的職責正是找出
  //       防腐層該擋什麼，所以這裡直接試；真要用時繞道 MUST 關在防腐層裡。
  if (first.length >= 4) {
    const res = client.conversations as unknown as { http: { getFetch(): typeof fetch }, v1: string }
    const HALF2 = Math.max(2, Math.floor(first.length / 2))
    const baseIds = new Set(first.slice(0, HALF2).map(r => r.id))

    const tries = ['skip', 'offset', 'from', 'page', 'start', 'skip_count'] as const
    const outcome: Array<{ param: string, status: number, count: number, sameAsFirstPage: boolean }> = []

    for (const param of tries) {
      const url = new URL(`${res.v1}/team_conversations/_search`)
      url.searchParams.set('business_unit_id', businessUnitId)
      url.searchParams.set('type', 'text')
      url.searchParams.set('q', '')
      url.searchParams.set('limit', String(HALF2))
      // page 慣例是 1-based，其餘是筆數位移
      url.searchParams.set(param, param === 'page' ? '2' : String(HALF2))

      const r = await res.http.getFetch()(url, { method: 'GET' })
      const body = r.ok ? unwrapPaged<RawRow>(await r.json()) : []
      const same = body.length > 0 && body.every(x => baseIds.has(x.id))
      outcome.push({ param, status: r.status, count: body.length, sameAsFirstPage: same })
      console.log(`     ${param.padEnd(11)} HTTP ${r.status}  ${body.length} 筆  ${same ? '❌ 與第一頁相同' : '✅ 內容不同'}`)
    }

    const works = outcome.find(o => o.status === 200 && o.count > 0 && !o.sameAsFirstPage)
    const summary = outcome
      .map(o => `${o.param}=${o.status}/${o.count}筆${o.sameAsFirstPage ? '(同第一頁)' : ''}`)
      .join('、')
    p.fixture('list-paging-params', outcome, true)
    p.record({
      question: 'U-1c',
      claim: '對話清單有沒有任何可用的分頁參數',
      verdict: works ? 'partial' : 'no',
      evidence: works
        ? `可用參數為 ${works.param}（回 200 且內容與第一頁不同，${works.count} 筆）。全部結果：${summary}`
        : `六種寫法全部無效：${summary}`,
      impact: works
        ? `🟡 分頁可行但要走 ${works.param}，SDK 未宣告 → 繞道 MUST 關在 server/services/imbrace.ts 的防腐層。`
        : '❗ **清單完全無法分頁**：skip 被靜默忽略（回 200，內容與第一頁相同），其他寫法也不可行。'
          + '→ 側欄的「載入更多」按下去只會拿回同一頁，看起來像壞掉但不報錯，MUST 移除。'
          + '清單能看到的永遠只有 limit 的前 N 筆，更早的只能靠搜尋。',
    })
  }

  // ── ④ offset 是不是「精確的第二頁」？ ────────────────
  //    ⚠️ 「內容與第一頁不同」還不夠。若 offset 的語意是頁碼、或位移基準不同，
  //       也會得到不同內容卻不是我們要的那一段 —— 那種錯誤會讓「載入更多」
  //       安靜地跳過中間幾筆，而使用者只會覺得「有些對話不見了」。
  if (first.length >= 4) {
    const res2 = client.conversations as unknown as { http: { getFetch(): typeof fetch }, v1: string }
    const H = Math.max(2, Math.floor(first.length / 2))

    const fetchPage = async (offset: number, limit: number): Promise<RawRow[]> => {
      const url = new URL(`${res2.v1}/team_conversations/_search`)
      url.searchParams.set('business_unit_id', businessUnitId)
      url.searchParams.set('type', 'text')
      url.searchParams.set('q', '')
      url.searchParams.set('limit', String(limit))
      url.searchParams.set('offset', String(offset))
      const r = await res2.http.getFetch()(url, { method: 'GET' })
      return r.ok ? unwrapPaged<RawRow>(await r.json()) : []
    }

    const second = await fetchPage(H, H)
    const expectIds = first.slice(H, H + H).map(r => r.id)
    const gotIds = second.map(r => r.id)
    const exact = gotIds.length === expectIds.length && gotIds.every((id, i) => id === expectIds[i])

    // 再驗一次 offset=1：位移應該只差一筆，這能分辨「位移」與「頁碼」兩種語意
    const shifted = await fetchPage(1, 3)
    const shiftExpect = first.slice(1, 4).map(r => r.id)
    const shiftOk = shifted.map(r => r.id).join() === shiftExpect.join()

    console.log(`     offset=${H} 是否等於第 ${H + 1}–${H * 2} 筆：${exact ? '✅ 精確相符' : '❌ 不符'}`)
    console.log(`     offset=1&limit=3 是否等於第 2–4 筆：${shiftOk ? '✅ 是（語意為筆數位移）' : '❌ 否（可能是頁碼語意）'}`)

    p.fixture('offset-exactness', { expectIds, gotIds, exact, shiftOk }, true)
    p.record({
      question: 'U-1d',
      claim: 'offset 的語意是否為「筆數位移」且能精確取到第二頁',
      verdict: exact && shiftOk ? 'yes' : (exact || shiftOk ? 'partial' : 'no'),
      evidence: `offset=${H}&limit=${H} 取回 ${gotIds.length} 筆，與全量的第 ${H + 1}–${H * 2} 筆`
        + `${exact ? '完全相符' : '不相符'}；offset=1&limit=3 ${shiftOk ? '等於第 2–4 筆' : '不等於第 2–4 筆'}`,
      impact: exact && shiftOk
        ? '✅ offset 是可靠的筆數位移分頁 → 側欄的「載入更多」把 skip 換成 offset 即可，'
          + '繞道 MUST 關在 server/services/imbrace.ts 的防腐層（SDK 型別宣告的是 skip）。'
        : '⚠️ offset 有效但語意不是單純的筆數位移 → 不可直接拿來做「載入更多」，'
          + '否則會安靜地跳過或重複中間幾筆。需先釐清語意再決定。',
    })
  }
})

if (isMain(import.meta.url)) {
  void probe22().then((f: Finding[]) => {
    if (f.some(x => x.verdict === 'no')) process.exitCode = 1
  })
}
