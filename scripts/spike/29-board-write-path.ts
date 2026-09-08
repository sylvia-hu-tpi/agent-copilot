/**
 * 29 — Data Board 寫入路徑實測（`specs/006-closure-handoff-summary` research #5／#6／#7／#8）。
 *
 * ⚠️⚠️ **本專案第一支有實質寫入副作用的 spike，且 `IMBRACE_ENV=stable` 是正式環境。**
 *      它會在真實組織建立一個 board、寫入幾筆 item，然後**把自己建的東西刪掉**。
 *      因此：
 *        ① board 名稱固定帶 `_spike_closure_` 前綴 ＋ 時間戳，不可能撞到正式 board
 *        ② 不加 `--yes` 只會印出「將要做什麼」然後結束，不做任何寫入
 *        ③ 無論成功失敗都在 finally 清除（清不掉會印出 board id 要人手動處理）
 *      **執行前 MUST 讓使用者知情**（`CLAUDE.md` 環境章節）。
 *
 * ── 為什麼這支要先跑，比 setup script 更早 ────────────────────
 * 下面五項假設若不成立，Board 欄位表就要改，而欄位表是 setup script、
 * `ClosureSummary` 型別、`ARCHITECTURE.md` §13.3 三處的共同來源 ——
 * 改在「還沒建正式 board、還沒寫三份文件」之前最便宜。
 *
 *   #5 寫入用欄位 id 還是欄位名？
 *   #6 `Number` 型別存在嗎？未設定時回讀是 `null` 還是 `0`？（FR-022b 的成立條件）
 *   #7 `MultipleSelection` 收不收白名單外的值？（決定 operators／cited_sops 用哪型）
 *   #8 `search(filter:)` 與 `sort:` 能不能用？（冪等查詢與候選清單的成立條件）
 *   ＋ API Key 有沒有建／刪 board 的權限（決定 setup script 走哪條憑證）
 *
 * 跑法：
 *   npm run spike:board-write            # 只印計畫，不動任何東西
 *   npm run spike:board-write -- --yes   # 真的執行
 */

import { runProbe, isMain, requireEnv, SkipProbe, type Finding, type Probe } from './lib/harness.js'
import { clientForApiKey } from '../../server/services/imbrace.js'
import type { ImbraceClient } from '@imbrace/sdk'

const CONFIRMED = process.argv.includes('--yes')

/** ⚠️ 清除靠這個前綴掃描，不靠 id —— 改動它等於讓上一輪的殘留變成孤兒 */
const BOARD_PREFIX = '_spike_closure_'

/** 六種型別各一欄 —— 涵蓋結案摘要欄位表用到的全部型別，不必建滿 26 欄 */
const PROBE_FIELDS = [
  { name: 'p_short', type: 'ShortText' },
  { name: 'p_long', type: 'LongText' },
  { name: 'p_num', type: 'Number' },
  { name: 'p_date', type: 'Date' },
  { name: 'p_single', type: 'SingleSelection', options: ['resolved', 'workaround', 'escalated'] },
  { name: 'p_multi', type: 'MultipleSelection', options: ['已建立工單', '已派工'] },
] as const

/**
 * 平台回傳的 id 有三種擺法，全部試過。
 *
 * ⚠️ **`boards.create()` 把結果包在 `{ data: {...} }` 裡，SDK 的 `Promise<Board>` 型別沒說**
 *    —— 2026-09-03 首跑就是栽在這裡：id 取不到 → 函式提早 return → `finally` 拿不到 id →
 *    **正式環境留下一個沒被刪掉的 board**。型別標的是 `Board`，實際是 `{data: Board}`，
 *    而 TypeScript 一聲都不吭（CLAUDE.md 地雷 3「SDK 型別與實際 API 不一致」的又一例）。
 */
function idOf(o: unknown): string | null {
  const r = o as Record<string, unknown> | null
  const inner = (r?.data && typeof r.data === 'object' && !Array.isArray(r.data))
    ? r.data as Record<string, unknown>
    : r
  const v = inner?._id ?? inner?.id
  return typeof v === 'string' ? v : null
}

/**
 * 平台的回應**一律**包一層 `{ data: ... }`，而 SDK 的型別（`Promise<BoardItem>` 等）沒說。
 *
 * ⚠️ 2026-09-03 首跑漏了這一層，`getItem()` 的每個欄位都讀成 `undefined`，
 *    差點把「我自己沒解開外層」寫成「平台會靜默丟棄值」—— 那會變成一條寫進正典文件的假結論。
 */
function unwrap(o: unknown): Record<string, unknown> {
  const r = o as Record<string, unknown> | null
  if (r?.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return r.data as Record<string, unknown>
  }
  return (r ?? {}) as Record<string, unknown>
}

/** 從 BoardItem 裡把某個欄位的值撈出來 —— 形狀未知，三種常見擺法都試 */
function valueOf(item: unknown, fieldId: string, fieldName: string): unknown {
  const r = unwrap(item)
  if (r?.fields && typeof r.fields === 'object') {
    const f = r.fields as Record<string, unknown>
    if (fieldId in f) return f[fieldId]
    if (fieldName in f) return f[fieldName]
  }
  if (Array.isArray(r?.data)) {
    const hit = (r.data as Array<Record<string, unknown>>).find(
      d => d.key === fieldId || d.key === fieldName,
    )
    if (hit) return hit.value
  }
  if (fieldId in r) return r[fieldId]
  if (fieldName in r) return r[fieldName]
  return undefined
}

/**
 * 由 `boards.get()` 的回應建 name → field id 對照。
 * 欄位清單的擺法未知，因此掃描所有陣列，取元素同時具 `name` 與 `_id`／`id` 的那一份。
 */
function mapFieldIds(boardDetail: unknown): Record<string, string> {
  const b = unwrap(boardDetail)
  const out: Record<string, string> = {}
  for (const v of Object.values(b)) {
    if (!Array.isArray(v)) continue
    for (const el of v) {
      const r = el as Record<string, unknown>
      const name = typeof r?.name === 'string' ? r.name : null
      const id = typeof r?._id === 'string' ? r._id : typeof r?.id === 'string' ? r.id : null
      if (name && id) out[name] = id
    }
  }
  return out
}

export const probe29 = () => runProbe('29', 'Data Board 寫入路徑', async (p) => {
  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: 'stable',
  })

  const boardName = `${BOARD_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`

  if (!CONFIRMED) {
    console.log('\n  🔍 乾跑模式（未帶 --yes），以下動作**不會**執行：\n')
    console.log(`     1. boards.create({ name: "${boardName}" })`)
    console.log(`     2. createField ×${PROBE_FIELDS.length}：${PROBE_FIELDS.map(f => `${f.name}(${f.type})`).join('、')}`)
    console.log('     3. createItem ×2（一筆完整、一筆刻意不送 p_num 以驗「留空 vs 0」）')
    console.log('     4. search(filter/sort)、getItem、updateItem')
    console.log(`     5. boards.delete("<剛建的 board>")  ← 清除\n`)
    console.log('  ⚠️ 這是正式環境（stable）。確認無誤後改用：npm run spike:board-write -- --yes\n')
    throw new SkipProbe('乾跑模式 —— 未帶 --yes，不執行任何寫入')
  }

  try {
    await runWrites(p, client, boardName)
  }
  finally {
    await sweepSpikeBoards(p, client)
  }
})

/**
 * 依**名稱前綴**清除，不依賴任何一次 id 解析成功。
 *
 * ⚠️ 這是 2026-09-03 首跑的直接教訓：原本的清除吃 `runWrites()` 回傳的 boardId，
 *    而那次正是 id 解析失敗 → 提早 return → 清除拿到 null → **正式環境留下一個 board**。
 *    「清除的前提是前面每一步都成功」是個很爛的前提 —— 清除存在的理由恰恰是前面會失敗。
 *    改以前綴掃描後，這支腳本無論在哪一步爆掉都收得乾淨，重跑也會順手撿走上一輪的殘留。
 */
async function sweepSpikeBoards(p: Probe, client: ImbraceClient): Promise<void> {
  try {
    const res = await client.boards.list({ limit: 200 }) as unknown as { data?: Array<Record<string, unknown>> }
    const orphans = (res?.data ?? []).filter(b => String(b.name ?? '').startsWith(BOARD_PREFIX))
    for (const b of orphans) {
      const id = String(b._id ?? b.id ?? '')
      if (!id) continue
      await client.boards.delete(id)
      console.log(`     🧹 已刪除 ${String(b.name)}（${id}）`)
    }
    if (orphans.length === 0) console.log('     🧹 無殘留 spike board')
  }
  catch (err) {
    console.log(`     ⚠️ **清除失敗，請手動刪除名稱以 ${BOARD_PREFIX} 開頭的 board**：${err instanceof Error ? err.message : String(err)}`)
    p.record({
      question: '006-E0',
      claim: 'spike board 清除',
      verdict: 'no',
      evidence: `以前綴 ${BOARD_PREFIX} 掃描刪除失敗`,
      impact: '⚠️ 正式環境可能殘留 spike board，請手動刪除。',
    })
  }
}

async function runWrites(p: Probe, client: ImbraceClient, boardName: string): Promise<void> {
  // ── ① API Key 能不能建 board ───────────────────────────────
  let board: unknown
  try {
    board = await client.boards.create({ name: boardName, description: 'specs/006 spike，可安全刪除' })
  }
  catch (err) {
    p.record({
      question: '006-E1',
      claim: 'API Key 具備建立 Data Board 的權限',
      verdict: 'no',
      evidence: `boards.create() 失敗：${err instanceof Error ? err.message : String(err)}`,
      impact: '⚠️ **setup script 不能走 `clientForApiKey()`**，得改用客服 access token。'
        + '這會推翻 `server/services/imbrace.ts` 該函式註解裡「僅用於 Data Board schema setup script」那句話，'
        + '也代表佈署流程需要一位有權限的客服帳號，而不只是一把 API key。',
    })
    return
  }

  const boardId = idOf(board)
  if (!boardId) {
    p.record({
      question: '006-E1', claim: 'boards.create() 回傳可用的 board id',
      verdict: 'no', evidence: `回應無 _id／id 欄位：${JSON.stringify(board).slice(0, 200)}`,
      impact: '⚠️ setup script 印不出 IMBRACE_CLOSURE_BOARD_ID，需改由 boards.list() 回頭找。',
    })
    return
  }
  p.record({
    question: '006-E1', claim: 'API Key 具備建立 Data Board 的權限',
    verdict: 'yes', evidence: `建立成功，board id ${boardId}`,
    impact: 'setup script 可沿用 `clientForApiKey()`，佈署只需一把 API key。',
  })
  console.log(`     📋 board ${boardId}`)

  // ── ② 六種欄位型別哪些建得起來 ─────────────────────────────
  const typeFailures: string[] = []
  for (const f of PROBE_FIELDS) {
    try {
      await client.boards.createField(boardId, {
        name: f.name,
        type: f.type,
        ...('options' in f ? { options: [...f.options] } : {}),
      })
    }
    catch (err) {
      typeFailures.push(`${f.name}(${f.type})：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /*
    ⚠️ **欄位 id MUST 由 `boards.get()` 反查，MUST NOT 取 `createField()` 的回應。**

    2026-09-03 首跑的教訓：SDK 對 `createField()` 的註解寫著「data-board returns the
    field directly (unlike legacy backend which returned the full Board)」——**那句是錯的**，
    它回的是整個 board，`_id` 是 **board id**。於是六個欄位全拿到同一把 id，
    六次寫入疊在同一把 key 上（last-write-wins），而**平台照樣回 200**。
    症狀是「只有最後一個欄位有值」，其餘全 null，沒有任何錯誤訊息。

    這一段同時就是 `board-repository` 正式路徑要做的事（research #5 的 name→id 快取），
    因此這裡驗的不只是 spike 自己，而是那個快取的建法。
  */
  const boardDetail = await client.boards.get(boardId)
  p.fixture('board-detail', boardDetail, true)
  const fieldIds = mapFieldIds(boardDetail)
  const unresolved = PROBE_FIELDS.map(f => f.name).filter(n => !fieldIds[n])
  p.record({
    question: '006-E2a',
    claim: '欄位 id 可由 boards.get() 反查（createField 的回應不可信）',
    verdict: unresolved.length === 0 ? 'yes' : 'no',
    evidence: unresolved.length === 0
      ? `六個欄位名全數對應到不同的 field id：${Object.entries(fieldIds).map(([n, i]) => `${n}=${i.slice(0, 8)}`).join('、')}`
      : `以下欄位在 boards.get() 裡找不到對應 id：${unresolved.join('、')}`,
    impact: unresolved.length === 0
      ? '⚠️ **research #5 成立且更嚴格**：`board-repository` 的 name→id 快取 MUST 由 `boards.get()` 建立，'
        + 'MUST NOT 取 `createField()` 的回傳值 —— 後者回的是整個 board（SDK 註解寫反了），'
        + '取到的是 board id。六個欄位拿到同一把 id 時平台照樣回 200，只有最後一個欄位有值，'
        + '其餘全 null 且無任何錯誤。這是本規格目前找到最危險的一條靜默失效路徑。'
      : '⚠️ boards.get() 的回應裡找不到欄位清單，name→id 快取建不起來，寫入路徑阻塞。',
  })
  p.record({
    question: '006-E2',
    claim: '結案摘要需要的六種欄位型別皆可建立（含 Number）',
    verdict: typeFailures.length === 0 ? 'yes' : 'no',
    evidence: typeFailures.length === 0
      ? `六種全數建立成功：${PROBE_FIELDS.map(f => f.type).join('、')}`
      : `失敗 ${typeFailures.length} 項 —— ${typeFailures.join('；')}`,
    impact: typeFailures.length === 0
      ? '契約 `closure-board-schema.md` 的型別表成立，不需調整。'
      : '⚠️ 契約的型別表要改。若失敗的是 `Number`，`sentiment_*`／`period_message_count`／'
        + '`confidence` 改用 ShortText 存數值字串，且 MUST 記進 IMBRACE_QUESTIONS.md —— '
        + 'Board 端從此無法對這些欄位做數值排序與統計，那是能力損失，不是實作細節。',
  })

  // ── ③ createItem 吃欄位 id 還是欄位名 ──────────────────────
  // 三筆各給不同時間，sort 才驗得出「真的排了」而不只是「沒拋錯」
  const t0 = Date.now()
  const DATES = {
    aaa: new Date(t0).toISOString(),
    bbb: new Date(t0 - 3_600_000).toISOString(),
    ccc: new Date(t0 - 7_200_000).toISOString(),
  }
  const byId: Record<string, unknown> = {}
  for (const [name, fid] of Object.entries(fieldIds)) {
    byId[fid] = name === 'p_short'
      ? 'draft-aaa'
      : name === 'p_long'
        ? JSON.stringify(['u_1', 'u_2'])
        : name === 'p_num'
          ? 42
          : name === 'p_date'
            ? DATES.aaa
            : name === 'p_single' ? 'resolved' : ['已建立工單']
  }

  let itemId: string | null = null
  let writeShape: 'fields-by-id' | 'flat-by-name' | 'none' = 'none'
  try {
    const created = await client.boards.createItem(boardId, { fields: byId })
    itemId = idOf(created)
    if (itemId) writeShape = 'fields-by-id'
  }
  catch { /* 落到下面試欄位名 */ }

  if (!itemId) {
    try {
      const created = await client.boards.createItem(boardId, {
        p_short: 'draft-aaa', p_long: JSON.stringify(['u_1', 'u_2']),
        p_num: 42, p_date: DATES.aaa, p_single: 'resolved', p_multi: ['已建立工單'],
      })
      itemId = idOf(created)
      if (itemId) writeShape = 'flat-by-name'
    }
    catch (err) {
      p.record({
        question: '006-E3', claim: 'createItem 的 body 形狀',
        verdict: 'no', evidence: `{fields:{id:value}} 與扁平欄位名兩種都失敗：${err instanceof Error ? err.message : String(err)}`,
        impact: '⚠️ 寫入路徑不通，本規格的 US1～US3 全部阻塞。需向 iMBrace 索取 createItem 的正確 body 規格。',
      })
      return
    }
  }

  p.record({
    question: '006-E3',
    claim: 'createItem 以欄位 id 為 key（而非欄位名）',
    verdict: writeShape === 'fields-by-id' ? 'yes' : 'no',
    evidence: `可用形狀：${writeShape}，item id ${itemId}`,
    impact: writeShape === 'fields-by-id'
      ? 'research #5 成立：`board-repository` MUST 先取 field 清單建 name→id 快取（TTL 10 分鐘）。'
        + '⚠️ 欄位在平台上被改名後快取會靜默失效，`--verify` MUST 不吃快取。'
      : '✅ 比預期簡單：可直接用欄位名，`board-repository` 不需要 name→id 快取那一層，'
        + '連帶少掉「改名導致靜默寫不進去」這個地雷。契約與 research #5 要改寫。',
  })

  const fid = (n: string): string => fieldIds[n] ?? n

  // ── ④ Number 留空 vs 0（FR-022b 的成立條件）────────────────
  //
  // ⚠️ 這是本支最重要的一項。FR-022b 逐字要求「留空與 0 分在紀錄上 MUST 可區分 ——
  //    否則報表會把留空當成最低分」。若未設定的 Number 回讀為 0，這條就從
  //    設計問題變成平台限制，欄位型別得整組改。
  let sparseItemId: string | null = null
  try {
    const sparse = writeShape === 'fields-by-id'
      ? { fields: { [fid('p_short')]: 'draft-bbb', [fid('p_date')]: DATES.bbb } } // 刻意不送 p_num
      : { p_short: 'draft-bbb', p_date: DATES.bbb }
    sparseItemId = idOf(await client.boards.createItem(boardId, sparse))
  }
  catch { /* 記在下面 */ }

  if (sparseItemId) {
    const back = await client.boards.getItem(boardId, sparseItemId)
    const raw = valueOf(back, fid('p_num'), 'p_num')
    const distinguishable = raw === undefined || raw === null || raw === ''
    p.record({
      question: '006-E4',
      claim: 'Number 欄位「未設定」與「0」在回讀時可區分（FR-022b 的成立條件）',
      verdict: distinguishable ? 'yes' : 'no',
      evidence: `不送 p_num 建立的 item，回讀值為 ${JSON.stringify(raw)}（型別 ${typeof raw}）`,
      impact: distinguishable
        ? 'FR-022b 可依原計畫實作：情緒三數值留空 ＝ 不送該欄位。'
        : '⚠️ **平台把未設定的 Number 回讀為 0**。FR-022b 無法用 Number 達成 —— '
          + '`sentiment_*` 改用 ShortText 存數值字串（留空 ＝ 空字串），'
          + '並 MUST 記進 IMBRACE_QUESTIONS.md。MUST NOT 默默接受 0：'
          + '那會讓報表把「這段情緒不可信」讀成「客戶情緒是最低分」。',
    })
    p.fixture('sparse-item', back, true)
  }

  // ── ⑤ MultipleSelection 收不收白名單外的值 ─────────────────
  let outsideAccepted: 'rejected' | 'dropped' | 'accepted' | 'unknown' = 'unknown'
  try {
    const body = writeShape === 'fields-by-id'
      ? { fields: { [fid('p_short')]: 'draft-ccc', [fid('p_multi')]: ['不在選項裡的值'], [fid('p_date')]: DATES.ccc } }
      : { p_short: 'draft-ccc', p_multi: ['不在選項裡的值'], p_date: DATES.ccc }
    const created = await client.boards.createItem(boardId, body)
    const cid = idOf(created)
    if (cid) {
      const back = await client.boards.getItem(boardId, cid)
      const v = valueOf(back, fid('p_multi'), 'p_multi')
      const arr = Array.isArray(v) ? v : []
      outsideAccepted = arr.some(x => String(x).includes('不在選項裡')) ? 'accepted' : 'dropped'
    }
  }
  catch {
    outsideAccepted = 'rejected'
  }
  p.record({
    question: '006-E5',
    claim: 'MultipleSelection 對白名單外的值的處置',
    verdict: outsideAccepted === 'accepted' ? 'yes' : outsideAccepted === 'rejected' ? 'partial' : 'no',
    evidence: `送入未定義的選項值 → ${outsideAccepted}`,
    impact: outsideAccepted === 'accepted'
      ? '✅ 值域開放：`operators`／`cited_sops` 可改用 MultipleSelection，報表能力比 LongText 好。research #7 要改寫。'
      : outsideAccepted === 'rejected'
        ? '會明確報錯（不是靜默丟棄）—— 至少壞掉時看得見。`operators`／`cited_sops` 仍 MUST 用 LongText。'
        : '⚠️ **靜默丟棄，這是最糟的一種**：寫入回 200、值不見了、沒有任何錯誤。'
          + '`operators`／`cited_sops` MUST 用 LongText（research #7 成立）；'
          + '且 `actions_taken` 的選項與 `config/categories.ts` 不同步時會安靜地少資料 —— '
          + 'setup script 的 `--verify` MUST 比對選項（契約 B4），這一條不是可選的。',
  })

  // ── ⑥ LongText 存 JSON 陣列的往返 ──────────────────────────
  if (itemId) {
    const back = await client.boards.getItem(boardId, itemId)
    const v = valueOf(back, fid('p_long'), 'p_long')
    let roundTripped = false
    try {
      roundTripped = JSON.stringify(JSON.parse(String(v))) === JSON.stringify(['u_1', 'u_2'])
    }
    catch { /* 保持 false */ }
    p.record({
      question: '006-E6',
      claim: 'LongText 可原樣往返 JSON 陣列字串（operators／cited_sops 的存法）',
      verdict: roundTripped ? 'yes' : 'no',
      evidence: `寫入 ["u_1","u_2"]，回讀 ${JSON.stringify(v)?.slice(0, 120)}`,
      impact: roundTripped
        ? '開放值域的欄位可安心用 LongText ＋ JSON.parse。'
        : '⚠️ 平台會改寫 LongText 內容（跳脫、截斷或去空白）。'
          + '`operators`／`cited_sops` 需改用分隔字元（如 `\\n`）或另尋型別。',
    })
    p.fixture('full-item', back, true)
  }

  // ── ⑦ search 的 filter：四種寫法都試 ───────────────────────
  //
  // ⚠️ **不能只試一種就下「filter 不可用」的結論。** Meilisearch 的 filter 吃的是
  //    索引屬性名，而這個 board 的屬性名很可能是**欄位 id** 而非欄位名 ——
  //    傳錯的症狀與「不支援 filter」完全一樣（回整批、無錯誤），兩者必須分開。
  //    §9.3 的訊息增量拉取就是同一個形狀：八種寫法全部被靜默忽略。
  const filterForms: Array<{ label: string, body: Record<string, unknown> }> = [
    { label: `filter 欄位id = "draft-aaa"`, body: { filter: `${fid('p_short')} = "draft-aaa"`, limit: 10 } },
    { label: `filter 欄位名 = "draft-aaa"`, body: { filter: `p_short = "draft-aaa"`, limit: 10 } },
    { label: `filter 欄位id:"draft-aaa"`, body: { filter: `${fid('p_short')}:"draft-aaa"`, limit: 10 } },
    { label: `q="draft-aaa"（全文檢索）`, body: { q: 'draft-aaa', limit: 10 } },
  ]

  const filterResults: string[] = []
  let workingForm: string | null = null
  for (const form of filterForms) {
    try {
      const res = await client.boards.search(boardId, form.body as Parameters<typeof client.boards.search>[1])
      const hits = res?.message?.hits ?? []
      const values = hits.map(h => String(valueOf(h, fid('p_short'), 'p_short') ?? ''))
      const exact = hits.length === 1 && values[0] === 'draft-aaa'
      filterResults.push(`${form.label} → ${hits.length} 筆 [${values.join(', ')}]${exact ? ' ✅' : ''}`)
      if (exact && !workingForm) workingForm = form.label
    }
    catch (err) {
      filterResults.push(`${form.label} → 拋錯：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  filterResults.forEach(r => console.log(`       ${r}`))
  p.fixture('search-forms', filterResults, true)

  p.record({
    question: '006-E7',
    claim: 'boards.search() 能精確查出單一 draft_id（＝ 憲法 5.3 冪等第一步的成立條件）',
    verdict: workingForm ? 'yes' : 'no',
    evidence: `board 內共 3 筆、目標 1 筆。${filterResults.join('；')}`,
    impact: workingForm
      ? `可用寫法為「${workingForm}」。⚠️ 若可用的是**欄位 id** 形式，`
        + '`board-repository` 的冪等查詢就與 name→id 快取（E2a）綁在一起 —— '
        + '快取失效時查詢會靜默回整批，而「查有既有紀錄」的判斷會變成隨機取一筆。'
        + '因此冪等查詢 MUST 在拿到結果後**再比對一次 draft_id 逐字相符**，不可信任平台已經幫我們過濾。'
      : '⚠️ **filter 被靜默忽略（回整批、無錯誤），冪等的第一步不成立**。'
        + '這與 §9.3 的訊息增量拉取是同一個形狀。替代方案：`listItems()` 分頁全撈 ＋ 本地比對 draft_id。'
        + '⚠️ 代價是隨紀錄成長退化為全表掃描 —— MUST 記進 IMBRACE_QUESTIONS.md 詢問正確的 filter 語法。'
        + '⚠️ 無論走哪條，寫入後的回查（FR-031）都 MUST 保留：它是唯一能發現「200 但紀錄不存在」的一步。',
  })

  // ── ⑧ search 的 sort：驗「真的排了」，不是「沒拋錯」──────────
  //
  // ⚠️ 上一版只斷言「未拋錯」就記成可用 —— 那與 filter 被靜默忽略是同一個錯誤形狀。
  //    平台對不認得的參數一律照回整批且不報錯，因此**唯一有效的判準是回傳順序本身**。
  const order = async (dir: 'desc' | 'asc'): Promise<string[]> => {
    const res = await client.boards.search(boardId, { sort: [`${fid('p_date')}:${dir}`], limit: 10 })
    return (res?.message?.hits ?? []).map(h => String(valueOf(h, fid('p_short'), 'p_short') ?? ''))
  }
  try {
    const desc = await order('desc')
    const asc = await order('asc')
    // 決定性對照：拿一個**不存在的欄位**去排。結果與 p_date 相同 ⇒ 欄位被忽略，
    // 平台其實是依建立時間排序，而 `:desc`／`:asc` 只控制方向。
    const bogusRes = await client.boards.search(boardId, { sort: ['no_such_field_xyz:desc'], limit: 10 })
    const bogus = (bogusRes?.message?.hits ?? []).map(h => String(valueOf(h, fid('p_short'), 'p_short') ?? ''))
    console.log(`       sort 不存在的欄位:desc → [${bogus.join(', ')}]`)
    const fieldIgnored = bogus.join(',') === desc.join(',')
    console.log(`       sort desc → [${desc.join(', ')}]`)
    console.log(`       sort asc  → [${asc.join(', ')}]`)
    const sortsByGivenField = desc.join(',') === 'draft-aaa,draft-bbb,draft-ccc'
    p.record({
      question: '006-E8',
      claim: 'boards.search() 的 sort 會依**指定的欄位**排序',
      verdict: sortsByGivenField ? 'yes' : 'no',
      evidence: `p_date 由新到舊為 aaa>bbb>ccc（與建立順序刻意相反）。`
        + `desc → [${desc.join(', ')}]、asc → [${asc.join(', ')}]、`
        + `不存在的欄位:desc → [${bogus.join(', ')}]${fieldIgnored ? '（與 p_date:desc 相同）' : ''}`,
      impact: sortsByGivenField
        ? 'FR-021b 的「最近 5 筆 closed_at 降冪」可交給平台排序。'
        : '⚠️ **欄位被忽略，平台實際是依「建立時間」排序**（`:desc`／`:asc` 只控制方向，且不報錯）。'
          + `${fieldIgnored ? '不存在的欄位得到完全相同的順序，這是決定性證據。' : ''}`
          + '⚠️ 這條**特別危險**，因為它在多數情況下看起來是對的：結案紀錄的建立順序通常與 '
          + '`closed_at` 一致，直到有人補登、或時鐘不同步才會分岔 —— 那時客服會拿到排錯的候選，'
          + '而畫面上完全看不出來。因此候選清單 MUST **本地排序**，'
          + 'research #9 的 `sort` ＋ `limit: 6` 取法不成立。',
    })
  }
  catch (err) {
    p.record({
      question: '006-E8', claim: 'boards.search() 的 sort 真的會排序',
      verdict: 'no', evidence: `sort 參數拋錯：${err instanceof Error ? err.message : String(err)}`,
      impact: '⚠️ 候選清單改為本地排序，research #9 要改寫。',
    })
  }

  // ── ⑨ 索引延遲：建立之後多久才搜尋得到？───────────────────
  //
  // ⚠️ **這一段直接決定冪等在最危險情境下成不成立**（specs/006 US3 AC#3 ／畫布 B8
  //    「回報成功但紀錄不存在」）。冪等的第一步是 `q: draftId` 搜尋，
  //    而**搜尋與 `getItem` 是兩條不同的路徑**：
  //      · `getItem(id)` 直接以 id 取，回查（第三步）用它
  //      · `q` 是全文檢索，寫入前的「有沒有既有紀錄」用它
  //    若建立之後索引要一段時間才跟上，那麼「逾時後重試」會查不到既有那筆 →
  //    走 createItem → **產生第二筆**，而且不會報錯。
  //    這裡量的就是那段時間窗有多大。
  const LAG_RUNS = 3
  const LAG_TIMEOUT_MS = 20_000
  const lagResults: Array<{ getItemOk: boolean, foundAfterMs: number | null }> = []

  for (let r = 0; r < LAG_RUNS; r++) {
    const probeDraftId = `lag-${Date.now()}-${r}`
    const body = writeShape === 'fields-by-id'
      ? { fields: { [fid('p_short')]: probeDraftId } }
      : { p_short: probeDraftId }

    const created = await client.boards.createItem(boardId, body)
    const newId = idOf(created)
    if (!newId) { lagResults.push({ getItemOk: false, foundAfterMs: null }); continue }

    // (a) 立刻以 id 直接取 —— 這是回查（第三步）走的路徑
    let getItemOk = false
    try {
      const back = await client.boards.getItem(boardId, newId)
      getItemOk = String(valueOf(back, fid('p_short'), 'p_short') ?? '') === probeDraftId
    }
    catch { /* 保持 false */ }

    // (b) 輪詢全文檢索，直到搜得到為止 —— 這是冪等第一步走的路徑
    const started = Date.now()
    let foundAfterMs: number | null = null
    while (Date.now() - started < LAG_TIMEOUT_MS) {
      try {
        const res = await client.boards.search(boardId, { q: probeDraftId, limit: 20 })
        const hit = (res?.message?.hits ?? []).some(
          h => String(valueOf(h, fid('p_short'), 'p_short') ?? '') === probeDraftId,
        )
        if (hit) { foundAfterMs = Date.now() - started; break }
      }
      catch { /* 忽略單次失敗，繼續輪詢 */ }
      await new Promise(res => setTimeout(res, 400))
    }

    lagResults.push({ getItemOk, foundAfterMs })
    console.log(`       run ${r + 1}: getItem 立即可取=${getItemOk}、`
      + `搜尋於 ${foundAfterMs === null ? `> ${LAG_TIMEOUT_MS}ms（逾時未找到）` : `${foundAfterMs}ms`} 後找到`)
  }

  p.fixture('index-lag', lagResults, true)

  const allGetOk = lagResults.every(x => x.getItemOk)
  const lags = lagResults.map(x => x.foundAfterMs)
  const worst = lags.some(v => v === null) ? null : Math.max(...(lags as number[]))

  p.record({
    question: '006-E10',
    claim: '建立後可立即以 `q` 搜尋到（＝ 冪等第一步在重試時查得到既有紀錄）',
    verdict: worst !== null && worst < 1000 ? 'yes' : worst !== null ? 'partial' : 'no',
    evidence: `n=${LAG_RUNS}。getItem 立即可取：${allGetOk ? '3/3' : lagResults.filter(x => x.getItemOk).length + `/${LAG_RUNS}`}；`
      + `搜尋延遲：${lags.map(v => v === null ? '逾時' : `${v}ms`).join('、')}`,
    impact: worst !== null && worst < 1000
      ? '✅ 索引即時。「逾時後重試」時第一步查得到既有紀錄 → 走 updateItem，不會產生第二筆。'
        + '畫布 B8 的警語「重試可能產生重複紀錄」可作為保險保留，但實務上風險很低。'
      : worst !== null
        ? `⚠️ 索引最慢 ${worst}ms 才跟上。**在這段時間窗內重試會產生第二筆紀錄**（第一步查不到 → createItem）。`
          + '對策：① 依畫布 B8 的設計，把重試綁在人工查驗之後（那段時間足以讓索引追上）；'
          + '② 或在 createItem 之後把 item id 留在草稿裡，重試時先用 `getItem(id)` 確認，查不到才走搜尋。'
        : '⚠️ **逾時仍搜尋不到**。冪等的第一步在這種情況下形同無效 —— '
          + '重試必然走 createItem，必然產生重複。MUST 改用「把 item id 記在草稿裡、重試時直接 getItem」的作法，'
          + '並記進 IMBRACE_QUESTIONS.md 詢問索引的一致性保證。',
  })

  if (!allGetOk) {
    p.record({
      question: '006-E11',
      claim: '`getItem(id)` 在建立後立即可取（＝ 回查這一步本身可信）',
      verdict: 'no',
      evidence: `${lagResults.filter(x => x.getItemOk).length}/${LAG_RUNS} 立即可取`,
      impact: '⚠️ **回查（FR-031）本身會誤判**：紀錄其實建立了，但回查當下取不到 → '
        + '我方會判定為失敗（畫布 B8）。這代表 B8 不是罕見情境，而是常態 —— '
        + '回查 MUST 加上短暫重試（例如 3 次 × 300ms）才可信，否則會把成功寫入報成失敗。',
    })
  }

  // ── ⑧ updateItem 的覆蓋語意（FR-030c）──────────────────────
  if (itemId) {
    try {
      const body = writeShape === 'fields-by-id'
        ? { fields: { [fid('p_short')]: 'draft-aaa-edited' } }
        : { p_short: 'draft-aaa-edited' }
      await client.boards.updateItem(boardId, itemId, body)
      const back = await client.boards.getItem(boardId, itemId)
      const short = String(valueOf(back, fid('p_short'), 'p_short') ?? '')
      const numKept = valueOf(back, fid('p_num'), 'p_num')
      p.record({
        question: '006-E9',
        claim: 'updateItem 是部分更新（未送的欄位保留）而非整筆覆蓋',
        verdict: short === 'draft-aaa-edited' && (numKept === 42 || numKept === '42') ? 'yes' : 'partial',
        evidence: `只送 p_short 後：p_short=${JSON.stringify(short)}、p_num=${JSON.stringify(numKept)}（原為 42）`,
        impact: short === 'draft-aaa-edited' && (numKept === 42 || numKept === '42')
          ? 'FR-030c 的「更新為當下草稿內容」MUST 送**完整**欄位集合 —— '
            + '只送異動欄位會讓客服刪掉的內容留在 Board 上，而畫面上看不出來。'
          : '⚠️ updateItem 會清掉未送的欄位（整筆覆蓋語意）。'
            + '這反而讓 FR-030c 更單純，但 MUST 寫進契約，否則日後有人「最佳化」成只送異動欄位就會掉資料。',
      })
    }
    catch (err) {
      p.record({
        question: '006-E9', claim: 'updateItem 可用',
        verdict: 'no', evidence: `updateItem 拋錯：${err instanceof Error ? err.message : String(err)}`,
        impact: '⚠️ FR-030c（重試時更新為當下內容）無法實作，冪等只能退化成「查有就不寫」—— '
          + '那會讓客服逾時後修改的版本永遠進不了 Board，且畫面顯示成功。此為阻塞項。',
      })
    }
  }

}

if (isMain(import.meta.url)) {
  void probe29().then((f: Finding[]) => {
    // ⚠️ 用 exitCode 而非 process.exit()：後者會在 SDK 的 fetch handle 還在關閉時
    //    強制結束，Windows 上的 libuv 會丟 `UV_HANDLE_CLOSING` assertion（首跑實測）。
    process.exitCode = f.filter(x => x.verdict === 'no').length > 0 ? 1 : 0
  })
}
