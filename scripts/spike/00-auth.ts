/**
 * 00 — 認證流程與角色資訊（F-1 / F-2 / H-5）
 *
 * 這支是互動式的，且必須第一個跑：它產出後續 probe 需要的 access token。
 *   npm run spike:auth
 *
 * 順帶回答 H-5：authenticate() 回傳的 organizations[] 帶有 role / is_admin，
 * 若屬實，「主管」判定可直接沿用平台角色，不必自建權限系統。
 */

import { createInterface } from 'node:readline/promises'
import { anonymousClient } from '../../server/services/imbrace.js'
import { env, loadEnv, OUT_DIR } from './lib/harness.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Environment } from '@imbrace/sdk'

async function main() {
  loadEnv()
  const e = env('IMBRACE_ENV', 'sandbox') as Environment
  const email = env('IMBRACE_EMAIL')
  if (!email) {
    console.error('請先在 .env.local 設定 IMBRACE_EMAIL')
    process.exit(1)
  }

  const client = anonymousClient({ env: e })
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log(`\n① 對 ${email} 送出 OTP（env=${e}）…`)
  await client.auth.signinEmailRequest(email)
  console.log('   已送出，請查收信件。')

  const otp = (await rl.question('② 輸入收到的驗證碼：')).trim()

  console.log('③ 驗證中…')
  const auth = await client.auth.authenticate({ email, otp })

  console.log(`\n✅ 登入成功`)
  console.log(`   login token 前綴：${auth.accessToken?.slice(0, 12)}…`)
  console.log(`   user_id：${auth.user_id ?? auth.userId ?? '(未提供)'}`)

  // ── H-5：角色資訊 ────────────────────────────────────
  const orgs = auth.organizations ?? []
  console.log(`\n④ 可用組織 ${orgs.length} 個：`)
  orgs.forEach((o, i) => {
    console.log(
      `   [${i}] ${o.display_name}  id=${o.organization_id}\n` +
      `       role=${o.role ?? '(無)'}  is_admin=${o.is_admin ?? '(無)'}  status=${o.status ?? '-'}`,
    )
  })

  const hasRole = orgs.some(o => o.role !== undefined || o.is_admin !== undefined)
  console.log(
    hasRole
      ? '\n   ✅ H-5：organizations[] 含 role/is_admin —— 主管判定可沿用平台角色'
      : '\n   ❌ H-5：organizations[] 未提供 role/is_admin —— 需改用 config/supervisors.yaml 白名單',
  )

  if (orgs.length === 0) {
    console.error('沒有可用組織，中止。')
    process.exit(1)
  }

  const idx = orgs.length === 1
    ? 0
    : Number((await rl.question(`\n⑤ 選擇組織 [0-${orgs.length - 1}]：`)).trim())
  const chosen = orgs[idx]
  if (!chosen) { console.error('選擇無效'); process.exit(1) }

  const exchanged = await client.auth.exchangeAccessToken(chosen.organization_id)
  rl.close()

  console.log(`\n✅ 已取得 access token`)
  console.log(`   refresh_token：${exchanged.refresh_token ? '有 ✅（F-2：可續期，不必重跑 OTP）' : '無 ❌（F-2：到期須重新 OTP）'}`)

  console.log(`\n────────────────────────────────────────────`)
  console.log(`把以下兩行貼進 .env.local：\n`)
  console.log(`IMBRACE_ACCESS_TOKEN=${exchanged.token}`)
  console.log(`IMBRACE_ORGANIZATION_ID=${chosen.organization_id}`)
  console.log(`────────────────────────────────────────────\n`)

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    resolve(OUT_DIR, '00-auth-findings.json'),
    JSON.stringify([
      {
        question: 'H-5', claim: 'access token 能否取得使用者角色／團隊',
        verdict: hasRole ? 'yes' : 'no',
        evidence: hasRole
          ? `organizations[] 提供 role=${chosen.role ?? '-'} / is_admin=${chosen.is_admin ?? '-'}`
          : 'organizations[] 未提供角色欄位',
        impact: hasRole
          ? '可沿用平台角色，避免自建權限系統（風險 #16 解除）'
          : '需以 config/supervisors.yaml 白名單暫代，並列為技術債',
      },
      {
        question: 'F-2', claim: 'token 是否可續期',
        verdict: exchanged.refresh_token ? 'yes' : 'no',
        evidence: exchanged.refresh_token ? 'exchangeAccessToken 回傳 refresh_token' : '無 refresh_token',
        impact: exchanged.refresh_token
          ? 'BFF session 可自動續期，客服不會在工作中被登出'
          : 'token 到期須重跑 OTP —— 需在 UI 上處理重新登入且保留 conversationId',
      },
    ], null, 2), 'utf8',
  )
}

main().catch(err => { console.error('\n💥', err); process.exit(1) })
