/**
 * M0 驗收煙霧測試 —— 對「已建置的 Nitro 伺服器」跑完整登入流程。
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
      ? '\n✅ M0 煙霧測試全數通過\n'
      : `\n❌ ${failures} 項未通過\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n💥', err instanceof Error ? err.message : err)
  process.exit(1)
})
