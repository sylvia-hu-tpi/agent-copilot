/**
 * M0 + M1 驗收煙霧測試 —— 對「已建置的 Nitro 伺服器」跑完整流程。
 *
 *   npm run build && npm run smoke
 *
 * ⚠️ 為何獨立成 script 而非 vitest：它需要先跑過 `npm run build`，
 *    把測試綁在建置產物上會讓 `npm test` 變得又慢又脆。
 *    這支專門驗 vitest 覆蓋不到的那一層：HTTP route、cookie 往返、
 *    以及 M0 驗收的「access token 不出現在任何回應中」。
 *
 * 涵蓋 docs/ARCHITECTURE.md §18 M0 驗收清單：
 *   [x] 能以 OTP 登入並選擇組織（選擇畫面一律出現）
 *   [x] 重新整理 organization.vue 不會被踢回輸 email（GET /api/auth/me 仍回 pending_org）
 *   [x] 能列出對話清單
 *   [x] access token 不出現在任何網路回應中
 *
 * 「session 中確實存有 refresh_token」（§5.1 ③）由 test/auth-flow.test.ts 覆蓋 ——
 * 從 HTTP 外部看不到 session 內容，那正是這個設計的重點。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { startMockGateway, type MockGateway } from './mock-gateway.js'

const ROOT = resolve(import.meta.dirname, '..')
const SECRETS = ['acc_TESTTOKEN', 'login_acc_TESTTOKEN', 'refresh_TESTTOKEN']

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures++
}

/** M0 驗收：憑證絕不可出現在任何回應中（body 或 cookie） */
function assertNoSecrets(label: string, body: string, setCookie: string[]): void {
  const haystack = `${body}\n${setCookie.join('\n')}`
  const leaked = SECRETS.filter(s => haystack.includes(s))
  check(`${label}：回應不含任何 token`, leaked.length === 0, leaked.join(', '))
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) return
    }
    catch {
      // 尚未啟動，繼續等
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`伺服器在 ${timeoutMs}ms 內未就緒`)
}

async function main(): Promise<void> {
  let gateway: MockGateway | undefined
  let server: ChildProcess | undefined

  try {
    gateway = await startMockGateway()
    const port = 3123
    const baseUrl = `http://127.0.0.1:${port}`

    server = spawn(process.execPath, ['.output/server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_SESSION_SECRET: 'smoke-test-secret',
        NUXT_IMBRACE_BASE_URL: gateway.baseUrl,
        NUXT_PUBLIC_IMBRACE_ENV: 'stable',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stderr?.on('data', d => process.stderr.write(`[server] ${d}`))
    /**
     * ⚠️ stdout **必須被消耗掉**，即使不印。`stdio: 'pipe'` 開了管線卻沒人讀，
     *    緩衝區滿了之後伺服器的 `console.log` 會**阻塞整個程序**（症狀是伺服器
     *    毫無徵兆地停住，看起來像死結）。順便：這也是為什麼加在伺服器端的
     *    `console.log` 探針在這裡完全看不到 —— 只有 stderr 被轉發。
     */
    server.stdout?.on('data', (d) => {
      if (process.env.SMOKE_TRACE) process.stderr.write(`[server:out] ${d}`)
    })

    await waitForServer(baseUrl)

    // cookie jar：手動維護，才驗得到 Set-Cookie 的實際內容
    let cookie = ''
    async function call(path: string, init: RequestInit = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...init.headers,
        },
      })
      const setCookie = res.headers.getSetCookie?.() ?? []
      const first = setCookie[0]
      if (first) cookie = first.split(';')[0] ?? cookie
      const body = await res.text()
      return { status: res.status, body, setCookie }
    }

    console.log('\n── 未登入 ──────────────────────────────────────────')
    const health = await call('/api/health')
    check('GET /api/health 回 200', health.status === 200)

    const anon = await call('/api/auth/me')
    check('未登入時 GET /api/auth/me 回 401', anon.status === 401, `實際 ${anon.status}`)

    const guarded = await call('/api/conversations')
    check('未登入時 GET /api/conversations 回 401', guarded.status === 401, `實際 ${guarded.status}`)

    console.log('\n── ① 寄送 OTP ──────────────────────────────────────')
    const otp = await call('/api/auth/otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'agent@example.com' }),
    })
    check('POST /api/auth/otp 回 200', otp.status === 200, `實際 ${otp.status} ${otp.body}`)
    check(
      '確實打到平台的 _signin_email_request',
      gateway.lastRequestTo('/login/_signin_email_request') !== undefined,
    )

    const badEmail = await call('/api/auth/otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    check('email 格式錯誤時回 4xx 而非 500', badEmail.status >= 400 && badEmail.status < 500,
      `實際 ${badEmail.status}`)

    console.log('\n── ② 驗證 OTP ──────────────────────────────────────')
    const login = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'agent@example.com', otp: '123456' }),
    })
    check('POST /api/auth/login 回 200', login.status === 200, `實際 ${login.status} ${login.body}`)
    assertNoSecrets('login', login.body, login.setCookie)

    const loginJson = JSON.parse(login.body) as { organizations?: unknown[] }
    check('回傳組織清單（供選組織畫面渲染）', Array.isArray(loginJson.organizations)
      && loginJson.organizations.length === 2)

    const sessionCookie = login.setCookie.find(c => c.startsWith('ac_session='))
    check('已下發 ac_session cookie', sessionCookie !== undefined)
    check('cookie 為 HttpOnly', sessionCookie?.toLowerCase().includes('httponly') === true)
    check('cookie 為 SameSite=Lax', sessionCookie?.toLowerCase().includes('samesite=lax') === true)

    console.log('\n── 重新整理 organization.vue（§5.1 ①）──────────────')
    const pending = await call('/api/auth/me')
    const pendingJson = JSON.parse(pending.body) as { stage?: string, organizations?: unknown[] }
    check('GET /api/auth/me 回 200', pending.status === 200, `實際 ${pending.status}`)
    check('stage 為 pending_org —— 不會被踢回輸 email', pendingJson.stage === 'pending_org',
      `實際 ${pendingJson.stage}`)
    check('仍帶得出組織清單，可直接重新渲染選單',
      Array.isArray(pendingJson.organizations) && pendingJson.organizations.length === 2)
    assertNoSecrets('me(pending_org)', pending.body, pending.setCookie)

    console.log('\n── ③ 選擇組織 ──────────────────────────────────────')
    const notMine = await call('/api/auth/organization', {
      method: 'POST',
      body: JSON.stringify({ organizationId: 'org_not_mine' }),
    })
    check('不屬於自己的組織被擋下（403）', notMine.status === 403, `實際 ${notMine.status}`)

    const chosen = await call('/api/auth/organization', {
      method: 'POST',
      body: JSON.stringify({ organizationId: 'org_a' }),
    })
    check('POST /api/auth/organization 回 200', chosen.status === 200,
      `實際 ${chosen.status} ${chosen.body}`)
    assertNoSecrets('organization', chosen.body, chosen.setCookie)

    const exchange = gateway.lastRequestTo('/access/_exchange_access_token')
    check('exchange 請求帶有 x-organization-id（§5.1 ②）',
      exchange?.headers['x-organization-id'] === 'org_a',
      `實際 ${exchange?.headers['x-organization-id']}`)

    const active = await call('/api/auth/me')
    const activeJson = JSON.parse(active.body) as { stage?: string, orgId?: string }
    check('stage 轉為 active', activeJson.stage === 'active', `實際 ${activeJson.stage}`)
    check('orgId 正確', activeJson.orgId === 'org_a')
    assertNoSecrets('me(active)', active.body, active.setCookie)

    console.log('\n── 對話清單 ────────────────────────────────────────')
    const list = await call('/api/conversations')
    check('GET /api/conversations 回 200', list.status === 200, `實際 ${list.status} ${list.body}`)
    const listJson = JSON.parse(list.body) as { items?: Array<{ name?: string }> }
    check('取得對話', listJson.items?.length === 1, JSON.stringify(listJson.items))
    check('名稱為平台代號格式', listJson.items?.[0]?.name === 'TWN#GW4772')

    const search = [...gateway.requests].reverse().find(r => r.path.includes('_search'))
    check('用 search 且帶 business_unit_id（不是無範圍的 list）',
      search?.path.includes('business_unit_id=bu_test') === true, search?.path)

    console.log('\n── M1 對話詳情（§10.6 ②：tcu id 只有詳情 API 會回）──')
    const CONV = '68e39cf1-68df-47a0-9e68-6e19c72eff8a'

    const detail = await call(`/api/conversations/${CONV}`)
    check('GET /api/conversations/:id 回 200', detail.status === 200, `實際 ${detail.status} ${detail.body}`)
    const detailJson = JSON.parse(detail.body) as {
      conversation?: { id?: string, teamConversationId?: string, viewerJoined?: boolean }
      control?: { aiReplies?: boolean, agentCanSend?: boolean, mode?: string | null }
      presence?: { operators?: unknown[], unidentifiedActor?: boolean }
    }
    check('取得 tcu_ 開頭的 team_conversation id（JOIN/LEAVE/mode 都要用）',
      detailJson.conversation?.teamConversationId?.startsWith('tcu_') === true,
      detailJson.conversation?.teamConversationId)
    check('對話 id 已正規化為裸 UUID（§9.3：三種識別碼不可混用）',
      detailJson.conversation?.id === CONV, detailJson.conversation?.id)
    check('未 JOIN 時 agentCanSend 為 false', detailJson.control?.agentCanSend === false,
      JSON.stringify(detailJson.control))
    check('PresenceBar 的空狀態是空陣列而非 null（§10.2 空狀態是常態）',
      Array.isArray(detailJson.presence?.operators)
      && detailJson.presence.operators.length === 0)
    assertNoSecrets('conversation detail', detail.body, detail.setCookie)

    const wrongId = await call('/api/conversations/tcu_042cae1b-8833-4580-be7e-54f03289ae41')
    check('傳 tcu id 當對話 id 會被當場擋下（§9.3 靜默出錯的防呆）',
      wrongId.status === 400, `實際 ${wrongId.status}`)

    console.log('\n── M1 訊息（§9.3：只取最新 N 則、由舊到新）────────')
    const msgList = await call(`/api/messages?conversationId=${CONV}`)
    check('GET /api/messages 回 200', msgList.status === 200, `實際 ${msgList.status} ${msgList.body}`)
    const msgListJson = JSON.parse(msgList.body) as {
      messages?: Array<{ id: string, at: string, sender?: { type?: string } }>
      lastMessageId?: string | null
    }
    const msgs = msgListJson.messages ?? []
    check('取得訊息', msgs.length >= 2, String(msgs.length))
    check('由舊到新排序（平台回的是由新到舊，防腐層須反轉）',
      msgs.every((m, i) => i === 0 || new Date(msgs[i - 1]!.at) <= new Date(m.at)),
      msgs.map(m => m.at).join(' → '))
    check('發送者依 from 前綴判別（con_ → customer、pub_ → ai）',
      msgs[0]?.sender?.type === 'customer' && msgs[1]?.sender?.type === 'ai',
      msgs.map(m => m.sender?.type).join(','))

    const noConv = await call('/api/messages')
    check('缺 conversationId 回 400 而非 500', noConv.status === 400, `實際 ${noConv.status}`)

    console.log('\n── M1 JOIN 與服務模式（§10.6）──────────────────────')
    const joined = await call(`/api/conversations/${CONV}/join`, {
      method: 'POST', body: JSON.stringify({}),
    })
    check('POST join 回 200', joined.status === 200, `實際 ${joined.status} ${joined.body}`)
    check('JOIN 預設進入 manual（與官方介面一致，避免兩邊行為不同造成誤送）',
      gateway.currentMode() === 'manual', String(gateway.currentMode()))
    const joinBody = gateway.lastRequestTo('/team_conversations/_join')?.body as
      { team_conversation_id?: string, conversation_id?: string, mode?: string } | undefined
    check('JOIN 送出的是 team_conversation_id 而非 conversation_id（SDK 型別宣告錯）',
      joinBody?.team_conversation_id?.startsWith('tcu_') === true
      && joinBody?.conversation_id === undefined, JSON.stringify(joinBody))

    console.log('\n── M1 撞單防護（§10.4 —— 唯一有效的一層）──────────')
    const anchor = msgListJson.lastMessageId ?? null

    // 同事搶先回覆
    gateway.pushMessage('u_other', '您好，我已經幫您補寄了')

    const collided = await call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, text: '我幫您查詢一下', baseMessageId: anchor }),
    })
    check('同事已回覆時送出被攔截（409）', collided.status === 409, `實際 ${collided.status} ${collided.body}`)
    const collisionJson = JSON.parse(collided.body) as {
      data?: { reason?: string, collision?: { kind?: string, messages?: Array<{ sender?: { type?: string } }> } }
    }
    check('攔截原因為 collision', collisionJson.data?.reason === 'collision',
      JSON.stringify(collisionJson.data?.reason))
    check('判定為 agent 而非 ai（⚠️ 必須以 sender.type 判斷，不可用 direction）',
      collisionJson.data?.collision?.kind === 'agent', collisionJson.data?.collision?.kind)
    check('回傳對方送出的內容，讓客服判斷是否重複',
      (collisionJson.data?.collision?.messages?.length ?? 0) > 0)
    check('攔截時平台端不該收到任何送出請求',
      gateway.sentMessages().length === 0, String(gateway.sentMessages().length))

    const forced = await call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: CONV, text: '我幫您查詢一下', baseMessageId: anchor, force: true,
      }),
    })
    check('客服選「仍要送出」時放行（我方偵測有誤判可能，不可堵死）',
      forced.status === 200, `實際 ${forced.status} ${forced.body}`)
    check('確實送到平台，且帶了 conversation_id（H-6 實測欄位名）',
      gateway.sentMessages().length === 1
      && typeof gateway.sentMessages()[0]?.conversation_id === 'string',
      JSON.stringify(gateway.sentMessages()[0]))

    const noAnchor = await call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, text: 'hi' }),
    })
    check('未帶 baseMessageId 回 400 —— 不可靜默跳過撞單檢查',
      noAnchor.status === 400, `實際 ${noAnchor.status}`)

    console.log('\n── M1 AI 撞單：內部訊息不可觸發假警報（§10.5）──────')
    // Hybrid 模式下 AI 才是撞單對象；Manual 下列入 AI 就是製造假警報
    await call(`/api/conversations/${CONV}/mode`, {
      method: 'POST', body: JSON.stringify({ mode: 'hybrid' }),
    })

    const afterForce = await call(`/api/messages?conversationId=${CONV}`)
    const anchor2 = (JSON.parse(afterForce.body) as { lastMessageId?: string }).lastMessageId ?? null

    // ⚠️ workflow 的內部訊息 —— 與真回覆同一個 from、同一個 type，客戶收不到
    gateway.pushMessage('pub_bot', '{"route": "T1"}')
    const internalOnly = await call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, text: '我來協助您', baseMessageId: anchor2 }),
    })
    check('AI 內部訊息（純 JSON）不觸發撞單 —— 假警報比沒有警報更糟',
      internalOnly.status === 200, `實際 ${internalOnly.status} ${internalOnly.body}`)

    const afterInternal = await call(`/api/messages?conversationId=${CONV}`)
    const anchor3 = (JSON.parse(afterInternal.body) as { lastMessageId?: string }).lastMessageId ?? null

    // 真正回給客戶的 AI 訊息 —— 這個必須攔
    gateway.pushMessage('pub_bot', '您好，我幫您查詢一下訂單狀態')
    const realAi = await call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, text: '我來協助您', baseMessageId: anchor3 }),
    })
    check('AI 真的回覆客戶時必須攔截（409）', realAi.status === 409,
      `實際 ${realAi.status} ${realAi.body}`)
    check('判定為 ai',
      (JSON.parse(realAi.body) as { data?: { collision?: { kind?: string } } })
        .data?.collision?.kind === 'ai')

    console.log('\n── M1 Automation Only 唯讀（§10.6 硬性約束）────────')
    const auto = await call(`/api/conversations/${CONV}/mode`, {
      method: 'POST', body: JSON.stringify({ mode: 'automation' }),
    })
    check('切換為 automation 回 200', auto.status === 200, `實際 ${auto.status}`)

    const blocked = await call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, text: 'hi', baseMessageId: null, force: true }),
    })
    check('唯讀模式下後端實際拒絕送出（不可只在前端 disable）',
      blocked.status === 409, `實際 ${blocked.status} ${blocked.body}`)
    check('拒絕原因為 automation_only',
      (JSON.parse(blocked.body) as { data?: { reason?: string } }).data?.reason === 'automation_only')

    console.log('\n── M1 Presence 上報 ────────────────────────────────')
    const beat = await call('/api/presence', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: CONV, state: 'viewing', joined: false, visible: true, clientId: 'smoke-1',
      }),
    })
    check('POST /api/presence 回 200', beat.status === 200, `實際 ${beat.status} ${beat.body}`)
    assertNoSecrets('presence', beat.body, beat.setCookie)

    const noClient = await call('/api/presence', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, state: 'viewing' }),
    })
    check('缺 clientId 回 400（少了它控制訊息會廣播給所有分頁）',
      noClient.status === 400, `實際 ${noClient.status}`)

    console.log('\n── 登出 ────────────────────────────────────────────')
    const logout = await call('/api/auth/logout', { method: 'POST' })
    check('POST /api/auth/logout 回 200', logout.status === 200)

    const afterLogout = await call('/api/auth/me')
    check('登出後 session 失效（401）', afterLogout.status === 401, `實際 ${afterLogout.status}`)

    console.log('\n── 竄改 cookie ─────────────────────────────────────')
    cookie = 'ac_session=forged.signature'
    const forged = await call('/api/auth/me')
    check('偽造的 cookie 被驗簽擋下（401）', forged.status === 401, `實際 ${forged.status}`)
  }
  finally {
    server?.kill()
    await gateway?.close()
  }

  console.log(
    failures === 0
      ? '\n✅ M0 + M1 煙霧測試全數通過\n'
      : `\n❌ ${failures} 項未通過\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n💥', err instanceof Error ? err.message : err)
  process.exit(1)
})
