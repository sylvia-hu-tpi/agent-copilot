/**
 * 假的 iMBrace gateway —— 讓登入流程能在沒有真實憑證、沒有網路的情況下跑整合測試。
 *
 * ⚠️ 為何不 mock @imbrace/sdk：§5.1 的三個坑全都發生在「SDK 實際打出什麼請求」這一層
 * （token 有沒有被存起來、x-organization-id 有沒有帶上、refresh_token 有沒有被丟掉）。
 * 把 SDK 換成假的，等於把要測的東西整個測掉了。
 * 因此這裡假的是「伺服器」，SDK 用真的 —— client factory 本來就支援 baseUrl 覆寫。
 *
 * 路徑取自 @imbrace/sdk@1.4.0：
 *   {baseUrl}/platform/v1/login/_signin_email_request
 *   {baseUrl}/platform/v1/login/authenticate
 *   {baseUrl}/platform/v1/access/_exchange_access_token
 *
 * ── M1 新增（形狀全部照 `npm run spike:write` 的實測結果）───────────
 *   {baseUrl}/channel-service/v1/team_conversations/{id}   詳情（回 tcu_ / mode / is_joined / users）
 *   {baseUrl}/channel-service/v1/team_conversations/_join  JOIN 與切換 mode（同一支端點）
 *   {baseUrl}/channel-service/v1/team_conversations/_leave
 *   {baseUrl}/channel-service/v1/conversation_messages     取訊息（由新到舊）／送訊息
 *
 * ⚠️ 詳情回的 `id` 是 `tcu_` 而 `conversation_id` 是 `conv_` —— 這個「同一個對話
 *    有三種識別碼」的形狀必須忠實重現，否則測不到 §9.3 那一整類靜默失準的 bug。
 *
 * ⚠️ 訊息**由新到舊**排序（實測確認）。若這裡寫成由舊到新，
 *    `fetchLatest()` 的 `.reverse()` 就會被測成「正確」，而實際上是反的。
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { CLOSURE_BOARD_FIELDS, CLOSURE_BOARD_NAME } from '../server/services/closure/board-schema.js'

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | undefined>
  body: unknown
}

export interface MockGateway {
  baseUrl: string
  requests: RecordedRequest[]
  /** 取出打到某路徑的最後一筆請求，供斷言標頭與 body */
  lastRequestTo(pathSuffix: string): RecordedRequest | undefined
  /**
   * 在對話中插入一則訊息 —— 模擬「同事或 AI 搶先回覆」。
   * §10.4 的撞單檢查沒有這個就測不出來。
   */
  pushMessage(from: string, text: string): { id: string }
  /** 目前對話裡的訊息則數 —— 「斷線期間漏了幾則」的基準 */
  messageCount(): number
  /** 目前的服務模式（JOIN／切換後會變）*/
  currentMode(): string | null
  /** 已送出的訊息（驗證送出路徑真的打到平台）*/
  sentMessages(): Array<Record<string, unknown>>

  // ── Data Board（specs/006-closure-handoff-summary）────────────────
  /** 這個假 gateway 上那個 board 的 id —— 測試把它當 `IMBRACE_CLOSURE_BOARD_ID` 用 */
  boardId(): string
  /**
   * 目前 board 上的全部紀錄，**key 換成欄位名**（不是欄位 id）。
   *
   * ⚠️ 換成欄位名純粹是為了讓斷言讀得懂。**平台真正吃的是欄位 id**（實測 006-E3），
   *    那一層由 `board-repository.ts` 的 name→id 對照負責，且假 gateway 這邊
   *    也是以 id 為 key 儲存 —— 若哪天有人把 repository 改成送欄位名，
   *    這裡會查不到欄位而寫出一筆空紀錄，測試會紅。
   */
  boardItems(): Array<Record<string, unknown>>
  /** 某個 Board 操作被打了幾次 —— SC-003 靠它證明「重試耗盡後仍是失敗」而非被吞成成功 */
  boardCallCount(op: BoardOp): number
  /**
   * 直接塞一筆紀錄（不經寫入路徑），key 用**欄位名**。
   * 供 US2 造出「別人的結案紀錄」與「建立順序與 closed_at 相反」的情境。
   */
  seedBoardItem(fieldsByName: Record<string, unknown>): { id: string }
  close(): Promise<void>
}

/** Board 的四種操作 —— 故障注入與計次都以它為鍵 */
export type BoardOp = 'search' | 'create' | 'update' | 'get'

export interface BoardMockOptions {
  /**
   * 指定操作要回的 HTTP 狀態碼。
   *
   * ⚠️ **Board 路徑允許 5xx**，與本檔上方 `failWith` 的「不要用 5xx」不同。
   *    SC-003 明列「平台 5xx」是四種失敗形態之一，用 4xx 或 `hangMs` 代替
   *    會讓那一格從未被驗到。代價是 SDK 的退避重試寫死在
   *    `node_modules/@imbrace/sdk/dist/http.js`（`maxRetries = 3`，1s→2s→4s，不可設定），
   *    一次 5xx 要花約 7 秒 —— 由 `test/closure-write-failures.test.ts` 以
   *    **並行 ＋ 拉長該組 timeout** 承擔，那不是例外，是已知成本。
   */
  failWith?: Partial<Record<BoardOp, number>>
  /** 指定操作延遲多久才回應（ms）—— 逾時測試用 */
  hangMs?: Partial<Record<BoardOp, number>>
  /**
   * `getItem` 一律回 404 —— 重現「寫入回 200 但回查不存在」（`failKind: 'unverified'`）。
   * ⚠️ 這是本規格最重要的一條測試（契約 R3.5）：少了它，
   *    「Board 上其實沒有」永遠不會被發現。
   */
  createButHideFromGet?: boolean
  /**
   * 前 N 次 `createItem` **實際建立紀錄但不回應**（連線掛著）——
   * SC-002「逾時後重試」的注入形態。⚠️ 刻意不是「不建立也不回應」：
   * 真正危險的情境正是「平台其實寫進去了，只是我方沒收到回應」，
   * 冪等要擋的就是這一種。
   */
  createButTimeout?: { times: number }
}


export interface MockGatewayOptions {
  /** authenticate 回傳的組織清單 */
  organizations?: Array<Record<string, unknown>>
  /** exchange 是否回傳 refresh_token（用來驗證 F-2 與 §5.1 ③） */
  withRefreshToken?: boolean
  /** 指定路徑要回傳的 HTTP 狀態碼，用來測失敗路徑。
   *  ⚠️ 不要用 5xx／429：SDK 會自動指數退避重試（1s→2s→4s），測試會逾時。
   *  ⚠️ **Board 路徑（`board.failWith`）是例外，那裡允許 5xx** —— specs/006 的 SC-003
   *     明列 5xx 是四種失敗形態之一。約 7 秒的退避由 `test/closure-write-failures.test.ts`
   *     以並行 ＋ 拉長該組 timeout 承擔，那不是例外，是已知成本。 */
  failWith?: Record<string, number>
  /** authenticate 回 200 但不帶 token —— 測防腐層有沒有把這種「假成功」擋下來 */
  omitLoginToken?: boolean
  /** 對話的初始服務模式（§10.6）。`null` 代表從未 JOIN */
  mode?: 'manual' | 'hybrid' | 'automation' | null
  /** Data Board 的故障注入（specs/006）。省略即一切正常 */
  board?: BoardMockOptions
}

const DEFAULT_ORGS = [
  { organization_id: 'org_a', display_name: '客服一部', role: 'admin', is_admin: false },
  { organization_id: 'org_b', display_name: '客服二部', role: 'member', is_admin: false },
]

/**
 * email → 客服身分。與下方 `users[]` 團隊名冊一致 ——
 * 名冊裡沒有的人，撞單提示就查不到名字（那條路徑也需要測得到）。
 */
const OPERATORS: Record<string, { id: string, name: string }> = {
  'agent@example.com': { id: 'u_test_operator', name: '測試客服' },
  'other@example.com': { id: 'u_other', name: '李小華' },
  default: { id: 'u_test_operator', name: '測試客服' },
}

/**
 * 探測用對話。⚠️ 三種識別碼刻意設成互相對得起來但字串不同（§9.3）。
 *
 * ⚠️ 匯出是為了讓測試**用同一組常數**，而不是各自抄一份 —— 抄錯一個字元的症狀
 *    是「查不到對話」，而那與「路徑寫錯」在畫面上長得一模一樣（§9.3 的整個主題）。
 */
export const MOCK_CONV_BARE = '68e39cf1-68df-47a0-9e68-6e19c72eff8a'
export const MOCK_TCU_ID = 'tcu_042cae1b-8833-4580-be7e-54f03289ae41'
const CONV_BARE = MOCK_CONV_BARE
const CONV_PREFIXED = `conv_${CONV_BARE}`
const TCU_ID = MOCK_TCU_ID

export async function startMockGateway(opts: MockGatewayOptions = {}): Promise<MockGateway> {
  const requests: RecordedRequest[] = []
  const fail = opts.failWith ?? {}

  // ── 可變的對話狀態 ────────────────────────────────────────────
  let mode: string | null = opts.mode ?? null
  let seq = 0
  const sent: Array<Record<string, unknown>> = []

  /**
   * ⚠️ `updated_at` 只在「真的有事發生」時才推進。
   *
   * 寫成每次回應都給 `new Date()` 會讓第一層清單輪詢（§9.3.1）**每一拍都看到變動**，
   * 於是 `hasNewMessages` 是否正確就再也測不出來 ——
   * 少發 `poke()` 的 bug 會被這個永遠為真的 `touched` 掩蓋過去。
   */
  let updatedAt = new Date(Date.UTC(2026, 7, 25, 0, 0, 0)).toISOString()
  let touchSeq = 0
  function touch(): void {
    updatedAt = new Date(Date.UTC(2026, 7, 25, 1, ++touchSeq, 0)).toISOString()
  }

  /** ⚠️ 由舊到新存放，回應時才反轉 —— 平台實測是由新到舊回傳 */
  const messages: Array<Record<string, unknown>> = []

  function addMessage(from: string, text: string): { id: string } {
    const id = `msg_${++seq}`
    touch()
    messages.push({
      id,
      conversation_id: CONV_PREFIXED,
      from,
      type: 'text',
      content: { text },
      created_at: new Date(Date.UTC(2026, 7, 25, 0, seq, 0)).toISOString(),
    })
    return { id }
  }

  addMessage('con_1', '你好，我的訂單還沒到')
  addMessage('pub_bot', '您好，我幫您查詢一下')

  // ── Data Board 的記憶體狀態（specs/006）──────────────────────────
  //
  // ⚠️ **這裡忠實重現三件實測到的平台行為，因為它們都是「不報錯但做錯事」：**
  //   ① 回應一律包一層 `{ data: ... }`（唯 `/search/` 例外，回 Meilisearch 信封）
  //   ② `search` **只依 `q` 做子字串比對，`filter` 與 `sort` 一律忽略**
  //      —— 讓「誤信平台過濾／排序」的實作在測試裡就會錯，而不是上線後才錯
  //   ③ 欄位以**欄位 id** 為 key，不是欄位名
  const BOARD_ID = 'bd_closure_test'
  const boardFields = CLOSURE_BOARD_FIELDS.map((f, i) => ({
    id: `fld_${String(i).padStart(2, '0')}_${f.name}`,
    _id: `fld_${String(i).padStart(2, '0')}_${f.name}`,
    name: f.name,
    type: f.type,
    order: i,
    /*
      受控詞彙欄位的選項 —— 平台放在 `data: [{ id, _id, value }]`
      （2026-09-04 真實環境實測；**不是** `options`，那個 key 被平台靜默忽略）。
      ⚠️ 忠實重現這個擺法，`server/services/imbrace.ts` 的 `optionsOf()` 才有東西可讀；
         若這裡回 `options: [...]`，那支函式就會走到它的保險分支而不是實際分支。
    */
    ...(f.options ? { data: f.options.map(value => ({ id: `opt_${value}`, _id: `opt_${value}`, value })) } : {}),
  }))
  const fieldIdByName = new Map(boardFields.map(f => [f.name, f.id]))
  const boardItems: Array<{ id: string, fields: Record<string, unknown>, created_at: string }> = []
  const boardOpts = opts.board ?? {}
  const boardCalls: Record<BoardOp, number> = { search: 0, create: 0, update: 0, get: 0 }
  let boardItemSeq = 0
  let createTimeoutsLeft = boardOpts.createButTimeout?.times ?? 0
  /**
   * 掛住不回應的連線與它們的計時器 —— `close()` 時要一併清掉。
   *
   * ⚠️ **兩者都要**。只 destroy 連線的話，`hangMs` 的 `setTimeout` 仍在事件迴圈裡，
   *    `server.close()` 會一直等到它到期（60 秒）——症狀是「測試在 afterEach 卡住」，
   *    而那與「被測程式碼真的沒有落定」在紅字上長得一模一樣。
   */
  const hungResponses: ServerResponse[] = []
  const hangTimers: Array<ReturnType<typeof setTimeout>> = []

  function seedBoardItem(fieldsByName: Record<string, unknown>): { id: string } {
    const byId: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(fieldsByName)) {
      const fid = fieldIdByName.get(name)
      if (fid) byId[fid] = value
    }
    const id = `bi_${++boardItemSeq}`
    boardItems.push({ id, fields: byId, created_at: new Date(Date.UTC(2026, 8, 1, 0, boardItemSeq, 0)).toISOString() })
    return { id }
  }

  function itemByName(item: { id: string, fields: Record<string, unknown> }): Record<string, unknown> {
    const out: Record<string, unknown> = { record_id: item.id }
    for (const f of boardFields) {
      if (f.id in item.fields) out[f.name] = item.fields[f.id]
    }
    return out
  }

  /** `q` 的比對：把該筆所有欄位值串起來做子字串比對 —— 全文檢索的最小忠實模型 */
  function matchesQuery(item: { fields: Record<string, unknown> }, q: string): boolean {
    if (!q) return true
    return Object.values(item.fields).some(v => JSON.stringify(v ?? '').includes(q))
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = req.url ?? ''

      requests.push({
        method: req.method ?? '',
        path,
        headers: req.headers as Record<string, string | undefined>,
        body: raw ? JSON.parse(raw) : undefined,
      })

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      const failStatus = Object.entries(fail).find(([suffix]) => path.endsWith(suffix))?.[1]
      if (failStatus) return send(failStatus, { message: 'mock failure' })

      if (path.endsWith('/login/_signin_email_request')) {
        return send(200, {})
      }

      if (path.endsWith('/login/authenticate')) {
        // ⚠️ 依 email 給不同的 user_id —— 「兩位客服」的情境沒有這個就測不出來：
        //    兩條 session 若共用同一個 operatorId，presence 的自我排除、
        //    撞單的 sameOperator 過濾都會被測成「正確」而實際上分不出人。
        const email = String((requests.at(-1)?.body as { email?: string } | undefined)?.email ?? '')
        const who = OPERATORS[email] ?? OPERATORS.default!
        return send(200, {
          ...(opts.omitLoginToken ? {} : { accessToken: 'login_acc_TESTTOKEN' }),
          user_id: who.id,
          display_name: who.name,
          organizations: opts.organizations ?? DEFAULT_ORGS,
        })
      }

      // channel-service：conversations.search 需要 bu id，bu id 由 channel.list 推導
      if (path.includes('/channel-service/v1/channels')) {
        return send(200, { data: [{ id: 'ch_1', bu_id: 'bu_test', name: 'LINE' }] })
      }

      if (path.includes('/team_conversations/_search')) {
        return send(200, {
          data: [{
            // ⚠️ 清單的 id 是**對話 id**（裸 UUID），沒有 tcu —— 這正是
            //    「從列表按 JOIN 必須先取一次詳情」的原因（§10.6 ②）
            id: CONV_BARE,
            channel_type: 'line',
            contact_id: 'con_1',
            status: 'open',
            name: 'TWN#GW4772',
            mode,
            // ⚠️ 清單 payload 的 users 實測為 null
            users: null,
            last_message_at: messages.at(-1)?.created_at,
            updated_at: updatedAt,
          }],
        })
      }

      // ── M1：對話詳情 ──────────────────────────────────────
      // ⚠️ 路徑參數同時接受對話 id 與 tcu id（實測確認），此處忠實重現
      const detailMatch = /\/team_conversations\/([^/?]+)$/.exec(path)
      if (req.method === 'GET' && detailMatch && !path.includes('_search')) {
        const id = decodeURIComponent(detailMatch[1] ?? '')
        const known = [CONV_BARE, CONV_PREFIXED, TCU_ID].includes(id)
        if (!known) return send(404, { message: 'conversation not found' })
        return send(200, {
          object_name: 'team_conversation',
          id: TCU_ID,
          _id: TCU_ID,
          conversation_id: CONV_PREFIXED,
          channel_type: 'line',
          contact_id: 'con_1',
          status: 'open',
          name: 'TWN#GW4772',
          mode,
          is_joined: mode === 'manual' || mode === 'hybrid',
          is_agent_joined: true,
          is_presence: false,
          // ⚠️ 團隊名冊，不是對話參與者（§10.2）—— 只當姓名對照表用
          users: [
            { id: 'u_test_operator', display_name: '測試客服', is_bot: false },
            { id: 'u_other', display_name: '李小華', is_bot: false },
            { id: 'u_bot', display_name: 'Bot', is_bot: true },
          ],
          updated_at: updatedAt,
        })
      }

      // ── M1：JOIN／切換 mode 是同一支端點（§10.6 實測）────────
      if (path.includes('/team_conversations/_join')) {
        const body = (requests.at(-1)?.body ?? {}) as { mode?: string }
        mode = body.mode ?? 'manual'
        touch()
        return send(200, { success: true })
      }

      if (path.includes('/team_conversations/_leave')) {
        // ⚠️ LEAVE 後回到 automation —— 與「有人但選 Automation Only」同值
        mode = 'automation'
        touch()
        return send(200, { success: true })
      }

      // ── M1：訊息 ─────────────────────────────────────────────
      if (path.includes('/conversation_messages')) {
        if (req.method === 'POST') {
          const body = (requests.at(-1)?.body ?? {}) as Record<string, unknown>
          // ⚠️ 平台對缺欄位的實際回應（實測）
          if (!body.conversation_id) return send(400, { code: 400, message: 'conversation_id required' })
          sent.push(body)
          const created = addMessage('u_test_operator', String(body.text ?? ''))
          return send(200, { id: created.id, conversation_id: CONV_PREFIXED })
        }

        const url = new URL(`http://x${path}`)
        if (!url.searchParams.get('conversation_id')) {
          return send(400, { code: 400, message: 'conversation_id required' })
        }
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const skip = Number(url.searchParams.get('skip') ?? 0)
        // ⚠️ 由新到舊 —— 這正是 limit=N 等於「最新 N 則」的原因
        const newestFirst = [...messages].reverse()
        return send(200, { data: newestFirst.slice(skip, skip + limit), total: messages.length })
      }

      // ── specs/006：Data Board ────────────────────────────────
      // SDK 的路徑（`node_modules/@imbrace/sdk/dist/resources/boards.js`）：
      //   GET    {gw}/data-board/boards/{id}
      //   POST   {gw}/data-board/boards/{id}/items
      //   GET    {gw}/data-board/boards/{id}/items/{itemId}
      //   PATCH  {gw}/data-board/boards/{id}/items/{itemId}
      //   POST   {gw}/data-board/search/{id}
      if (path.includes('/data-board/')) {
        const boardOp: BoardOp | null = path.includes('/data-board/search/')
          ? 'search'
          : /\/items\/[^/?]+$/.test(path)
            ? (req.method === 'PATCH' ? 'update' : 'get')
            : /\/items$/.test(path) && req.method === 'POST'
              ? 'create'
              : null

        // ⚠️ 計次在故障注入**之前** —— SC-003 要證明「SDK 重試耗盡後仍是失敗」，
        //    而那個證明就是「create 被打了 40 次（10 × 4 次嘗試）」。
        //    放到成功分支之後計次的話，那個斷言會永遠是 0 而看起來像通過。
        if (boardOp) boardCalls[boardOp]++

        const respond = (status: number, payload: unknown): void => {
          const delay = boardOp ? boardOpts.hangMs?.[boardOp] : undefined
          if (delay) {
            hungResponses.push(res)
            hangTimers.push(setTimeout(() => send(status, payload), delay))
            return
          }
          send(status, payload)
        }

        const failStatusForOp = boardOp ? boardOpts.failWith?.[boardOp] : undefined
        if (failStatusForOp) return respond(failStatusForOp, { message: `mock board failure (${boardOp})` })

        // 全文檢索：⚠️ **只看 `q`**。body 裡的 filter／sort 一律忽略（實測 006-E7／E8）
        const searchMatch = /\/data-board\/search\/([^/?]+)$/.exec(path)
        if (searchMatch) {
          const body = (requests.at(-1)?.body ?? {}) as { q?: string, limit?: number }
          const q = String(body.q ?? '')
          const hits = boardItems.filter(it => matchesQuery(it, q))
          return respond(200, {
            success: true,
            message: {
              // ⚠️ 依**建立順序**回，不依任何欄位排序 —— 平台就是這樣（006-E8）。
              //    回傳順序若在這裡先排好，「本地排序」那段程式碼刪掉也不會有測試變紅。
              hits: hits.slice(0, body.limit ?? 50).map(it => ({ ...it, _id: it.id })),
              query: q,
              estimatedTotalHits: hits.length,
            },
          })
        }

        const itemMatch = /\/data-board\/boards\/([^/?]+)\/items\/([^/?]+)$/.exec(path)
        if (itemMatch) {
          const itemId = decodeURIComponent(itemMatch[2] ?? '')
          const found = boardItems.find(it => it.id === itemId)
          if (req.method === 'PATCH') {
            if (!found) return respond(404, { message: 'item not found' })
            const body = (requests.at(-1)?.body ?? {}) as { fields?: Record<string, unknown> }
            // ⚠️ **部分更新**（未送的欄位保留），實測 006-E9。整筆覆蓋會讓
            //    「只送有改的欄位」那種寫法在測試裡也通過，而正式環境不會。
            Object.assign(found.fields, body.fields ?? {})
            return respond(200, { data: { ...found, _id: found.id } })
          }
          if (boardOpts.createButHideFromGet) return respond(404, { message: 'item not found' })
          if (!found) return respond(404, { message: 'item not found' })
          return respond(200, { data: { ...found, _id: found.id } })
        }

        if (/\/data-board\/boards\/[^/?]+\/items$/.test(path) && req.method === 'POST') {
          const body = (requests.at(-1)?.body ?? {}) as { fields?: Record<string, unknown> }
          const id = `bi_${++boardItemSeq}`
          boardItems.push({
            id,
            fields: { ...(body.fields ?? {}) },
            created_at: new Date(Date.UTC(2026, 8, 1, 1, boardItemSeq, 0)).toISOString(),
          })
          // ⚠️ **紀錄已經建立了，只是不回應** —— 「平台其實寫進去了，我方沒收到回應」
          //    正是冪等要擋的那一種。不建立就不回應的話，重試產生第二筆這個 bug
          //    在測試裡永遠不會出現。
          if (createTimeoutsLeft > 0) { createTimeoutsLeft--; hungResponses.push(res); return }
          return respond(200, { data: { _id: id, id, fields: boardItems.at(-1)!.fields } })
        }

        const boardMatch = /\/data-board\/boards\/([^/?]+)$/.exec(path)
        if (boardMatch && req.method === 'GET') {
          return respond(200, {
            data: { _id: BOARD_ID, id: BOARD_ID, name: CLOSURE_BOARD_NAME, fields: boardFields },
          })
        }

        return send(404, { message: `mock gateway: 未實作的 data-board 路徑 ${path}` })
      }

      if (path.endsWith('/access/_exchange_access_token')) {
        return send(200, {
          token: 'acc_TESTTOKEN',
          ...(opts.withRefreshToken === false ? {} : { refresh_token: 'refresh_TESTTOKEN' }),
        })
      }

      return send(404, { message: `mock gateway: 未實作的路徑 ${path}` })
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    lastRequestTo: (suffix: string) => [...requests].reverse().find(r => r.path.endsWith(suffix)),
    pushMessage: addMessage,
    messageCount: () => messages.length,
    currentMode: () => mode,
    sentMessages: () => sent,
    boardId: () => BOARD_ID,
    boardItems: () => boardItems.map(itemByName),
    boardCallCount: (op: BoardOp) => boardCalls[op],
    seedBoardItem,
    close: () => new Promise<void>((resolve, reject) => {
      // ⚠️ 先結束掛住的連線，否則 `server.close()` 會等它們，測試會逾時 ——
      //    而 `createButTimeout` 的存在理由就是製造這種連線。
      for (const timer of hangTimers.splice(0)) clearTimeout(timer)
      for (const hung of hungResponses.splice(0)) {
        try { hung.destroy() }
        catch { /* 已經關掉就算了 */ }
      }
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}
