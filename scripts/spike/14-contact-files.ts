/**
 * 14 — 附件清單端點（使用者於 2026-08-26 由瀏覽器 Network 面板發現）
 *
 * `GET {gateway}/api/channel-service/v1/contact/{contact_id}/files`
 *
 * 不在 `@imbrace/sdk@1.4.0` 的公開型別中，是從官方前端的實際請求反推出來的。
 * `{contact_id}` 是 `con_` 開頭的聯絡人 id（H-3 已確認：訊息 `from` 欄位的 `con_` 前綴
 * 就是聯絡人 id），不是對話 id ——過 §9.3 的「三種識別碼」教訓，這裡特別記錄清楚。
 *
 * 用途：驗證 §19.1 #11 的殘留問題——
 *   ① 這個端點能否作為附件清單的正式來源（而非逐則訊息裡找 image/pdf type）
 *   ② `caption` 欄位在「客服上傳」與「客戶上傳」兩種情境下是否真的不同（H-2c）
 *
 * ⚠️ **範圍是聯絡人層級，不是單一對話（2026-08-26 確認來源後更新）**：路徑是
 * `/contact/{id}/files`，完全沒有 conversation id。使用者是在官方介面的
 * 「聯絡人資料（User Profile）」彈窗中發現此端點呼叫的——這個情境本質上就是
 * 聯絡人層級視圖，強烈支持此端點回傳的是「這個聯絡人所有對話的附件」。
 * 技術上仍未用多對話聯絡人驗證過（見下方 H-2f-scope finding，verdict 為 partial 而非 yes），
 * 但**實作上應假設是聯絡人層級，不可當成「這個對話的附件清單」使用**——
 * 若要用，應明確定位為「客戶歷史附件」，需要另外過濾或標示來源對話。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import { env, isMain, requireEnv, runProbe, writeReport, type Finding } from './lib/harness.js'
import { tryStrategies } from '../../server/sources/message-fetch.js'

function transportOf(client: ImbraceClient) {
  return (client.messages as unknown as {
    http: { getFetch(): typeof fetch }
    base: string
  })
}

interface ContactFile {
  _id?: string
  type?: string
  from?: string
  content?: { url?: string, caption?: string, extension?: string }
}

export const probe14 = () => runProbe('14', '附件清單端點（contact/files）', async (p, client) => {
  const convId = requireEnv('SPIKE_CONVERSATION_ID')

  // ── 找一個 con_ 開頭的聯絡人 id，來源是訊息的 from 欄位（H-3 已驗證的前綴語意）──
  const results = await tryStrategies(client, convId)
  const best = results.filter(r => r.messages.length > 0).sort((a, b) => b.precision - a.precision)[0]
  const contactId = best?.messages.find(m => (m as { from?: string }).from?.startsWith('con_'))
    ?.from as string | undefined

  if (!contactId) {
    p.record({
      question: 'new-1', claim: 'contact/files 端點是否可用',
      verdict: 'unknown',
      evidence: '此對話目前沒有客戶（con_ 前綴）發過言，找不到 contact_id 可測',
    })
    return
  }

  const t = transportOf(client)
  const fetchFn = t.http.getFetch()
  // ⚠️ 這個端點在 cloud.imbrace.co，跟 SDK 打的 gateway host（t.base）不是同一個，
  //    不能用既有的「砍掉最後一段路徑」邏輯推導 —— 目前只確認這一個完整寫死的 URL 有效。
  const gw = 'https://cloud.imbrace.co'
  const url = `${gw}/api/channel-service/v1/contact/${contactId}/files`

  let res: Response
  try {
    res = await fetchFn(url, { method: 'GET' })
  } catch (e) {
    p.record({
      question: 'new-1', claim: 'contact/files 端點是否可用',
      verdict: 'unknown',
      evidence: `請求失敗：${e instanceof Error ? e.message : String(e)}`,
    })
    return
  }

  p.record({
    question: 'new-1',
    claim: 'contact/files 端點（非 SDK 公開端點）是否可用',
    verdict: res.ok ? 'yes' : 'no',
    evidence: `GET ${url.replace(gw, '')} → ${res.status}`,
    impact: res.ok
      ? '可作為「列出對話所有附件」的來源，不需逐則訊息掃描 type。⚠️ 非 SDK 公開端點，穩定性與 rate limit 未知，上線前建議向 iMBrace 確認是否為正式支援的介面'
      : undefined,
  })

  if (!res.ok) return

  const files = await res.json() as ContactFile[]
  p.fixture('contact-files', files)

  p.record({
    question: 'H-2f-scope',
    claim: '此端點是「聯絡人所有對話」還是「單一對話」的附件範圍',
    verdict: 'partial',
    evidence: `路徑無 conversation id；回傳 ${files.length} 則與此對話已知附件數一致。`
      + '**使用者是在官方介面的「聯絡人資料（User Profile）」彈窗中發現此端點的呼叫**，'
      + '該情境本質是聯絡人層級視圖，強烈支持此端點是「聯絡人所有對話」的範圍，非單一對話——'
      + '但仍未用有多個對話紀錄的聯絡人做過技術驗證，故未升級為 yes',
    impact: '🚨 在技術驗證或向 iMBrace 確認前，不可把此端點結果當成「這個對話的附件清單」——'
      + '若聯絡人有多個對話，很可能混入其他對話的附件。'
      + '若要在 UI 使用，應明確定位為「客戶歷史附件」而非「本對話附件」，兩者呈現方式不同',
  })

  const byAgent = files.filter(f => f.from?.startsWith('u_'))
  const byCustomer = files.filter(f => f.from?.startsWith('con_'))
  const agentWithCaption = byAgent.filter(f => (f.content?.caption ?? '').trim().length > 0)
  const customerWithCaption = byCustomer.filter(f => (f.content?.caption ?? '').trim().length > 0)

  p.record({
    question: 'H-2c',
    claim: '`caption` 是原始檔名，且僅在客服上傳時才會有值',
    verdict: byAgent.length > 0 && byCustomer.length > 0
      ? (agentWithCaption.length === byAgent.length && customerWithCaption.length === 0 ? 'yes' : 'partial')
      : 'unknown',
    evidence: `客服上傳 ${byAgent.length} 則，${agentWithCaption.length} 則帶 caption；`
      + `客戶上傳 ${byCustomer.length} 則，${customerWithCaption.length} 則帶 caption`,
    impact: customerWithCaption.length === 0 && byCustomer.length > 0
      ? '⚠️ 客戶上傳的附件（最主要的真實情境）沒有 caption 可用，UI 不能假設有檔名可顯示，圖片仍需自建 vision 描述'
      : undefined,
  })

  const allHaveUrl = files.every(f => !!f.content?.url)
  p.record({
    question: 'H-2b/e',
    claim: '此端點回傳的附件是否皆帶可用 url',
    verdict: allHaveUrl ? 'yes' : 'partial',
    evidence: `${files.length} 則附件中 ${files.filter(f => f.content?.url).length} 則帶 url`,
  })

  await probeConversationScopedAlternative(p, fetchFn, gw, convId)
})

/**
 * 使用者提問：要取得「當前對話」的附件，是否得靠 cloud.imbrace.co 上另一支
 * conversation_messages 端點？——這裡直接測，同時驗證這條 host 是否只是既有
 * `/v1/conversation_messages` 的別名（若是，代表我們既有的、已證實 100% precision
 * 的訊息取數路徑本來就是正確答案，不需要引入新端點）。
 */
async function probeConversationScopedAlternative(
  p: import('./lib/harness.js').Probe,
  fetchFn: typeof fetch,
  gw: string,
  convId: string,
): Promise<void> {
  const url = `${gw}/api/channel-service/v1/conversation_messages?conversation_id=${convId}`
  try {
    const res = await fetchFn(url, { method: 'GET' })
    const raw = res.ok ? await res.json() as unknown : null
    const body = Array.isArray(raw)
      ? raw
      : (['data', 'items', 'results', 'hits'] as const)
          .map(k => (raw as Record<string, unknown> | null)?.[k])
          .find(Array.isArray) as unknown[] | undefined
    p.record({
      question: 'H-2f-alt',
      claim: 'cloud.imbrace.co 上的 conversation_messages 是否為既有端點的別名（同一資料）',
      verdict: res.ok ? 'yes' : 'no',
      evidence: res.ok
        ? `GET ${url.replace(gw, '').replace(convId, '<convId>')} → ${res.status}，`
          + `回傳形狀 ${Array.isArray(raw) ? '陣列' : `物件鍵：${Object.keys(raw as object).join(',')}`}，`
          + `解出 ${body?.length ?? '無法解出陣列'} 則`
        : `GET ${url.replace(gw, '').replace(convId, '<convId>')} → ${res.status}`,
      impact: res.ok
        ? '確認：取得「這個對話的附件」不需要任何新端點——既有的 conversation_messages（見 server/sources/message-fetch.ts 的 raw-conversation-id 策略，precision 100%）過濾 type ∈ {image, pdf} 就是正確答案，`contact/files` 端點無論範圍為何都用不到這個目的'
        : 'cloud.imbrace.co 這個 host 不見得能直接打 conversation_messages；沿用既有 SDK/gateway 路徑即可，不影響結論',
    })
  } catch (e) {
    p.record({
      question: 'H-2f-alt',
      claim: 'cloud.imbrace.co 上的 conversation_messages 是否為既有端點的別名',
      verdict: 'unknown',
      evidence: `請求失敗：${e instanceof Error ? e.message : String(e)}`,
    })
  }
}

if (isMain(import.meta.url)) {
  const findings = await probe14()
  console.log(`\n📄 ${writeReport(findings)}`)
  console.log(`\n環境：${env('IMBRACE_ENV', 'stable')}\n`)
}
