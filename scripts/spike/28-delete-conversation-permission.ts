/**
 * 28 — 客服（Admin 或任一角色）能否刪除聊天室（對話）
 *
 * 要回答的問題：
 *   SDK 型別層存在 `api.channel.deleteConversation({ id })`，且標記 ⚠️ DESTRUCTIVE。
 *   問題是「當前這個客服身分（含 Admin）實際上有沒有權限刪」——這是後台角色控管，
 *   不是型別能回答的，只有打 gateway 才知道。
 *
 * ⚠️ 安全性：本探測**絕不刪除任何真實對話**。
 *   作法是拿一個保證不存在的隨機 UUID 去打刪除端點，只憑回傳狀態碼判權限：
 *     401 / 403        → 權限在查資源之前就被擋 → 明確「無權刪除」
 *     404（資源層級）  → 通過鑑權、只是找不到那筆 → 「有權刪除」（弱陽性，見下）
 *     404（端點層級）  → 路由不存在 → 此部署不開放刪除
 *     405 / 400        → 端點在但方法/參數不符 → 需人工判讀
 *
 *   ⚠️ 判讀限制：若後端「先查資源、找不到就 404」而把鑑權放在其後，
 *   則假 UUID 一律回 404，我們就無法從 404 區分「有權」與「無權但被藏成 404」。
 *   因此只有 401/403 是**決定性**的（確定無權）；404 只是「未被鑑權擋下」的弱訊號。
 *   要 100% 確認「有權且能真的刪掉」，唯一方法是對一個**指定的拋棄式對話**真的刪一次——
 *   那需要使用者明確指定對象與同意，不在本唯讀探測範圍內。
 */

import { runProbe, isMain, type Finding } from './lib/harness.js'
import type { ImbraceClient } from '@imbrace/sdk'

/** 保證不存在的隨機 UUID v4 —— 打到刪除端點也刪不到任何東西 */
function fabricatedConversationId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

interface Classified {
  status: number | null
  label: string
  /** 對「有無刪除權限」的判讀 */
  perm: 'denied' | 'granted-weak' | 'endpoint-missing' | 'inconclusive'
  raw: string
}

function classify(err: unknown): Classified {
  const msg = err instanceof Error ? err.message : String(err)
  // SDK 的 http 層會把狀態碼帶進 message；也可能掛在 err.status / err.response.status
  const anyErr = err as { status?: number; statusCode?: number; response?: { status?: number } }
  const status =
    anyErr?.status ??
    anyErr?.statusCode ??
    anyErr?.response?.status ??
    (msg.match(/\b(400|401|403|404|405|409|500)\b/)?.[1]
      ? Number(msg.match(/\b(400|401|403|404|405|409|500)\b/)![1])
      : null)

  const raw = msg.slice(0, 160)
  switch (status) {
    case 401: return { status, label: '🔒 401 Unauthorized', perm: 'denied', raw }
    case 403: return { status, label: '🔒 403 Forbidden', perm: 'denied', raw }
    case 404: {
      // 端點層 404 通常訊息含 "Cannot DELETE" / "route" / 沒有資源語意；
      // 資源層 404 通常含 conversation / not found (資源名)。這裡只能粗略猜。
      const endpointish = /cannot\s+(delete|find\s+route)|no\s+route|method\s+not/i.test(msg)
      return endpointish
        ? { status, label: '❌ 404（疑似端點不存在）', perm: 'endpoint-missing', raw }
        : { status, label: '🟡 404 Not Found（疑似資源層 → 已通過鑑權）', perm: 'granted-weak', raw }
    }
    case 405: return { status, label: '❌ 405 Method Not Allowed', perm: 'endpoint-missing', raw }
    case 400: {
      // 400 是**業務驗證層**的錯誤 → 已通過鑑權（無權會是 401/403）。
      // 實測到的訊息 "Invalid status value" 特別關鍵：它證明後端的 DELETE
      // 其實走「狀態轉換」語義，而非硬刪除 —— 也就是說鑑權過了、卡在請求內容。
      return { status, label: `🟡 400（鑑權已過，卡業務驗證）：${raw}`, perm: 'granted-weak', raw }
    }
    case 409: return { status, label: '⚠️ 409 Conflict', perm: 'inconclusive', raw }
    case 500: return { status, label: '💥 500 Server Error', perm: 'inconclusive', raw }
    default: return { status, label: '⚠️ ' + raw.slice(0, 60), perm: 'inconclusive', raw }
  }
}

export const probe28 = () =>
  runProbe('28', '客服能否刪除聊天室（deleteConversation 權限）', async (p, c: ImbraceClient) => {
    // ── 1. 先確認「我是誰」：組織層角色 + 每個 team 的角色 ──────────────
    let roleLine = '（無法取得帳號）'
    try {
      const acc = await c.account.getAccount()
      const teamRoles = (acc.team_roles ?? [])
        .map(t => `${t.team_id.slice(0, 8)}…:${t.role}`)
        .join('、') || '（無 team role）'
      roleLine = `org-role=${acc.role}｜status=${acc.status}｜team-roles=[${teamRoles}]`
      console.log(`\n  身分：${acc.display_name || acc.email}`)
      console.log(`  角色：${roleLine}`)
      p.fixture('who-am-i', {
        role: acc.role, status: acc.status,
        team_roles: (acc.team_roles ?? []).map(t => ({ team_id: t.team_id, role: t.role })),
      }, true)
    } catch (err) {
      console.log(`  ⚠️ getAccount() 失敗：${err instanceof Error ? err.message : String(err)}`)
    }

    // ── 2. 拿假 UUID 探刪除端點（不會刪到任何真實對話）────────────────
    const fakeId = fabricatedConversationId()
    console.log(`\n  探測 deleteConversation（假 id=${fakeId}）...`)

    let result: Classified
    try {
      await c.api.channel.deleteConversation({ id: fakeId })
      // 竟然成功 → 代表「刪一個不存在的 id 也回 2xx」，或後端把它當 idempotent
      result = {
        status: 200, perm: 'granted-weak', raw: '2xx（對不存在的 id 也回成功，idempotent delete）',
        label: '🟢 2xx（端點可呼叫且鑑權通過；對不存在 id 回成功）',
      }
      console.log('  ⚠️ 回 2xx —— 沒有真的刪到東西（id 不存在），但代表鑑權通過')
    } catch (err) {
      result = classify(err)
      console.log(`  → ${result.label}`)
    }
    p.fixture('delete-probe', { fakeId, ...result }, true)

    // ── 3. 判定 ────────────────────────────────────────────
    const verdict =
      result.perm === 'denied' ? 'no'
      : result.perm === 'granted-weak' ? 'partial'   // 弱陽性，見 impact 的判讀限制
      : result.perm === 'endpoint-missing' ? 'no'
      : 'unknown'

    p.record({
      question: 'DEL-1',
      claim: '當前客服身分是否有權刪除聊天室（對話）',
      verdict,
      evidence:
        `身分 ${roleLine}；`
        + `以不存在的 UUID 打 deleteConversation 得 ${result.label}`,
      impact:
        result.perm === 'denied'
          ? `❌ 決定性結論：此憑證/角色**無權**刪除對話（鑑權在查資源前就擋下，回 ${result.status}）。`
            + '若產品需要「刪除聊天室」能力，需在 iMBrace 後台調整角色權限，並向 iMBrace 確認 Admin 是否為門檻。'
          : result.perm === 'granted-weak'
            ? '🟡 弱陽性：鑑權未擋下（回 404 資源層 / 400 業務驗證 / 2xx），代表此身分（admin）**很可能有權**刪除。'
              + '⚠️ 兩點實測校正：'
              + '(1) SDK 的 deleteConversation({id}) 實際打 `DELETE /team_conversations/{id}` —— '
              + 'id 必須是 **teamConversationId**（§9.3 三種識別碼之一），傳錯種類只會靜默不作用或報錯。'
              + '(2) 後端回 "Invalid status value" 暗示「刪除」是**狀態轉換（軟刪除/封存）**而非硬刪除。'
              + '要 100% 確認，需拿一個**真實的 teamConversationId**（指定拋棄式對話、使用者同意）實刪一次，本唯讀探測不做。'
            : result.perm === 'endpoint-missing'
              ? '❌ 此部署似乎不開放 deleteConversation 端點（404 端點層 / 405）。刪除聊天室在此環境無此路徑。'
              : `❓ 結果不明確（${result.label}）。需人工檢視原始錯誤：${result.raw}`,
    })
  })

if (isMain(import.meta.url)) {
  probe28().then((_f: Finding[]) => process.exit(0))
}
