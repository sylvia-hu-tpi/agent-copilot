/**
 * 00 — OTP 登入，取得個別使用者的 access token（F-1 / F-2 / H-5）
 *
 * 兩段式，不需互動輸入（CI 與重跑友善）：
 *   npm run spike:auth              → 寄出 OTP
 *   npm run spike:auth -- 123456    → 驗證並把 token 寫回 .env.local
 *
 * 為何需要它：API Key 是組織層級的 server-to-server 憑證，
 * 不帶使用者角色（H-5），且疑似無權呼叫 AI 端點。
 * 取得 acc_ token 後才能用 07-auth-boundary.ts 比對兩者的能力差異。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { anonymousClient } from '../../server/services/imbrace.js'
import { env, loadEnv, ROOT } from './lib/harness.js'
import type { Environment } from '@imbrace/sdk'

/** 寫入 .env.local，就地取代既有鍵，並清掉同名的空白重複行 */
function upsertEnv(pairs: Record<string, string>): void {
  const file = resolve(ROOT, '.env.local')
  let text = readFileSync(file, 'utf8')

  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^${key}\\s*=.*$`, 'm')
    text = re.test(text)
      ? text.replace(re, `${key}=${value}`)
      : `${text.trimEnd()}\n${key}=${value}\n`
  }

  // ⚠️ loadEnvFile 取最後一筆，範本殘留的空白同名鍵會覆蓋掉實際值
  const parse = (l: string) => l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/)
  const withValue = new Set(
    text.split(/\r?\n/).map(parse).filter(m => m?.[2]?.trim()).map(m => m![1]),
  )
  text = text.split(/\r?\n/)
    .filter(l => {
      const m = parse(l)
      return !(m && !m[2]!.trim() && withValue.has(m[1]!))
    })
    .join('\n')

  writeFileSync(file, text, 'utf8')
}

async function main() {
  loadEnv()
  const e = env('IMBRACE_ENV', 'stable') as Environment
  const email = env('IMBRACE_EMAIL')
  const otp = process.argv[2]?.trim()

  if (!email) {
    console.error('請先在 .env.local 設定 IMBRACE_EMAIL')
    process.exit(1)
  }

  const client = anonymousClient({ env: e })

  // ── 第一段：寄出 OTP ──────────────────────────────
  if (!otp) {
    console.log(`① 對 ${email} 送出 OTP（env=${e}）…`)
    await client.requestOtp(email)
    console.log('   ✅ 已送出，請查收信件。\n')
    console.log('   收到後執行：npm run spike:auth -- <驗證碼>')
    return
  }

  // ── 第二段：驗證並取得 token ───────────────────────
  // ⚠️ 必須用 client 層的 loginWithOtp（而非 auth.authenticate）——
  //    前者會把回傳的 login_acc_ token 存進 TokenManager，
  //    後者只回傳資料，後續呼叫等於未認證，會 401。
  console.log('② 驗證 OTP…')
  // client 層的便利方法回傳 Record<string, unknown>，此處補回實際形狀
  const auth = await client.loginWithOtp(email, otp) as {
    user_id?: string
    userId?: string
    organizations?: Array<{
      organization_id: string
      display_name: string
      role?: string
      is_admin?: boolean
      status?: string
    }>
  }
  console.log(`   ✅ 登入成功  user_id=${auth.user_id ?? auth.userId ?? '(未提供)'}`)

  // H-5：角色資訊是否隨組織清單回傳
  const orgs = auth.organizations ?? []
  console.log(`\n③ 可用組織 ${orgs.length} 個：`)
  orgs.forEach((o, i) => console.log(
    `   [${i}] ${o.display_name}  id=${o.organization_id}\n`
    + `       role=${o.role ?? '(無)'}  is_admin=${o.is_admin ?? '(無)'}  status=${o.status ?? '-'}`,
  ))

  const hasRole = orgs.some(o => o.role !== undefined || o.is_admin !== undefined)
  console.log(hasRole
    ? '\n   ✅ H-5：organizations[] 帶 role/is_admin —— 主管判定可沿用平台角色'
    : '\n   ❌ H-5：未提供角色欄位 —— 需退回 config/supervisors.yaml 白名單')

  // 優先選目前 .env.local 已設定的組織，否則取第一個
  const preferred = env('IMBRACE_ORGANIZATION_ID')
  const chosen = orgs.find(o => o.organization_id === preferred) ?? orgs[0]
  if (!chosen) {
    console.error('沒有可用組織，中止。')
    process.exit(1)
  }
  console.log(`\n④ 選用組織：${chosen.display_name}`)

  // ⚠️ exchange 端點要求請求本身帶 x-organization-id，因此必須先設好。
  //    client.selectOrganization() 會做這件事，但它把 refresh_token 丟掉了，
  //    而我們要驗證 F-2，所以此處複製其流程以保留完整回傳。
  const http = (client as unknown as {
    http: { setOrganizationId(id: string | undefined): void }
  }).http
  http.setOrganizationId(chosen.organization_id)

  const exchanged = await client.auth.exchangeAccessToken(chosen.organization_id)
  client.setAccessToken(exchanged.token)
  console.log(`   token 前綴：${exchanged.token?.slice(0, 8)}…  長度=${exchanged.token?.length}`)
  console.log(`   refresh_token：${exchanged.refresh_token ? '✅ 有（F-2：可續期）' : '❌ 無（F-2：到期須重跑 OTP）'}`)

  upsertEnv({
    IMBRACE_ACCESS_TOKEN: exchanged.token,
    IMBRACE_ORGANIZATION_ID: chosen.organization_id,
  })
  console.log('\n✅ 已寫入 .env.local（IMBRACE_ACCESS_TOKEN / IMBRACE_ORGANIZATION_ID）')
  console.log('   下一步：npx tsx scripts/spike/07-auth-boundary.ts')
}

main().catch(err => {
  console.error('\n💥', err instanceof Error ? err.message : err)
  process.exit(1)
})
