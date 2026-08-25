/**
 * M1 驗收的最後兩項 —— docs/ARCHITECTURE.md §18。
 *
 *   npm run build && npm run smoke
 *
 *   [ ] 兩個瀏覽器開同一對話：A 送出後 B 在 4 秒內看到
 *   [ ] SSE 斷線後能自動重連並補齊斷線期間的訊息
 *
 * ── 為何這兩項獨立成一支 script ─────────────────────────────────
 * `smoke-http.ts` 是「一位客服走一遍流程」，這裡是**兩位客服、兩條 SSE 連線**，
 * 而且要精準控制斷線時機。兩者的 fixture 形狀不同，硬塞在一起會讓兩邊都難讀。
 *
 * ── 這支涵蓋到哪裡、不涵蓋到哪裡（⚠️ 不要高估）───────────────────
 * ✅ 涵蓋：真實 HTTP + 真實 SSE + 真實 Nitro 建置產物，從 A 按下送出到
 *    B 的連線上收到 `messages.appended` 的**實際毫秒數**；斷線期間漏掉的訊息
 *    能否靠 `GET /api/messages?since=` 完整補回，且不重送已讀的部分。
 * ❌ 不涵蓋：瀏覽器 `EventSource` 本身的行為、以及前端 store 何時決定重連。
 *    後者由 `test/nuxt/stream-store.test.ts` 對真正的 `app/stores/stream.ts` 驗，
 *    前者只有真實瀏覽器驗得到 —— 但它是瀏覽器的實作，不是我方的程式碼。
 */

import type { CopilotEvent } from '../shared/types/events.js'
import { sameOperator } from '../server/sources/mappers.js'
import { startNitro, type HttpClient, type NitroHarness, type StreamClient } from './nitro-harness.js'

/** §18 驗收數字：前景清單輪詢 3s + 傳輸餘裕 */
const DELIVERY_BUDGET_MS = 4_000

const CONV = '68e39cf1-68df-47a0-9e68-6e19c72eff8a'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures++
}

interface MessagesResponse {
  messages: Array<{ id: string, text: string, sender: { id?: string, type: string } }>
  lastMessageId: string | null
}

async function messagesOf(client: HttpClient, query = ''): Promise<MessagesResponse> {
  const res = await client.call(`/api/messages?conversationId=${CONV}${query}`)
  if (res.status !== 200) throw new Error(`GET /api/messages 回 ${res.status}：${res.body}`)
  return JSON.parse(res.body) as MessagesResponse
}

async function send(client: HttpClient, text: string, baseMessageId: string | null): Promise<void> {
  const res = await client.call('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ conversationId: CONV, text, baseMessageId }),
  })
  if (res.status !== 200) throw new Error(`POST /api/messages 回 ${res.status}：${res.body}`)
}

/** 開一條 SSE 並讓它開始監看這個對話（控制通道走 POST /api/presence）*/
async function watch(
  client: HttpClient,
  clientId: string,
  joined: boolean,
): Promise<StreamClient> {
  const stream = await client.openStream(clientId)
  const res = await client.call('/api/presence', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: CONV,
      state: joined ? 'joined' : 'viewing',
      joined,
      visible: true,
      clientId,
    }),
  })
  if (res.status !== 200) throw new Error(`POST /api/presence 回 ${res.status}：${res.body}`)

  // attach() 完成的訊號：控制狀態的首發快照
  await stream.waitFor(
    e => e.type === 'control.updated' && e.conversationId === CONV,
    { label: `${clientId} 的 control.updated` },
  )
  return stream
}

function appendedTexts(evt: CopilotEvent): string[] {
  return evt.type === 'messages.appended' ? evt.messages.map(m => m.text) : []
}

async function main(): Promise<void> {
  let harness: NitroHarness | undefined

  try {
    harness = await startNitro()
    const { gateway } = harness

    const a = harness.client()
    const b = harness.client()
    await a.signIn('agent@example.com')
    await b.signIn('other@example.com')

    // 兩條 session 必須是不同的人，否則後面每一項都在自己騙自己
    const meA = JSON.parse((await a.call('/api/auth/me')).body) as { operatorId?: string }
    const meB = JSON.parse((await b.call('/api/auth/me')).body) as { operatorId?: string }
    check('兩位客服是不同的 operator（測試前提）',
      Boolean(meA.operatorId) && meA.operatorId !== meB.operatorId,
      `${meA.operatorId} vs ${meB.operatorId}`)

    // A 先 JOIN —— 未 JOIN 的對話送不出訊息（§10.6）
    await a.call(`/api/conversations/${CONV}`)
    const joined = await a.call(`/api/conversations/${CONV}/join`, {
      method: 'POST', body: JSON.stringify({ mode: 'manual' }),
    })
    check('A 成功 JOIN', joined.status === 200, `實際 ${joined.status} ${joined.body}`)

    console.log('\n── ① A 送出後，B 在 4 秒內看到（§18 M1）────────────')

    const streamA = await watch(a, 'browser-a', true)
    const streamB = await watch(b, 'browser-b', false)

    // ⚠️ 既有訊息**不會**從 SSE 補推給後加入的連線：第二層是共享訂閱，
    //    第一位訂閱者拉過之後錨點就前進了。前端的初次載入本來就走 REST
    //    （`useConversationView.loadAll()`），這裡照同一條路徑走。
    const initialB = await messagesOf(b)
    check('B 開啟對話時載得到既有訊息（初次載入走 REST，不靠 SSE 補推）',
      initialB.messages.some(m => m.text === '您好，我幫您查詢一下'),
      `${initialB.messages.length} 則`)

    const anchor = (await messagesOf(a)).lastMessageId
    const cursorB = streamB.cursor()
    const startedAt = Date.now()
    await send(a, 'A 的回覆：已為您補寄，明天到貨', anchor)

    const seen = await streamB.waitFor(
      e => appendedTexts(e).includes('A 的回覆：已為您補寄，明天到貨'),
      { since: cursorB, label: 'B 收到 A 的訊息' },
    )
    const elapsed = seen.at - startedAt

    check(
      `B 在 ${DELIVERY_BUDGET_MS / 1000} 秒內看到 A 送出的訊息`,
      elapsed <= DELIVERY_BUDGET_MS,
      `實際 ${elapsed}ms`,
    )
    check('B 收到的是 A 的訊息，且標記為同事（agent）而非 AI',
      seen.event.type === 'messages.appended'
      && seen.event.messages.some(m =>
        m.sender.type === 'agent' && sameOperator(m.sender.id, meA.operatorId)),
      JSON.stringify(seen.event.type === 'messages.appended'
        ? seen.event.messages.map(m => m.sender)
        : seen.event.type))

    // A 自己那條連線也該收到 —— 少了它，A 的畫面要等下一輪輪詢才看得到自己送的訊息
    const echoed = await streamA.waitFor(
      e => appendedTexts(e).includes('A 的回覆：已為您補寄，明天到貨'),
      { label: 'A 自己的訊息回音', timeoutMs: DELIVERY_BUDGET_MS },
    )
    check('A 自己的連線也收得到（畫面不必等下一輪輪詢）', Boolean(echoed))

    // ⚠️ 上面那筆走的是「送出 API 直接 poke()」的捷徑，量到的是我方內部延遲。
    //    真正撐著 4 秒預算的是**客戶回覆** —— 它不經過我方任何 API，
    //    只能靠第一層清單輪詢（3s）發現 `last_message_at` 變了才 poke。
    //    這一筆才是驗收數字的來源，前一筆再快都不能代替它。
    const cursorCustomer = streamB.cursor()
    const customerAt = Date.now()
    gateway.pushMessage('con_1', '客戶：好，那我再等等')

    const customerSeen = await streamB.waitFor(
      e => appendedTexts(e).includes('客戶：好，那我再等等'),
      { since: cursorCustomer, label: 'B 收到客戶的訊息' },
    )
    check(
      `客戶回覆（無捷徑，只靠第一層輪詢）也在 ${DELIVERY_BUDGET_MS / 1000} 秒內出現`,
      customerSeen.at - customerAt <= DELIVERY_BUDGET_MS,
      `實際 ${customerSeen.at - customerAt}ms`,
    )

    console.log('\n── ② 斷線重連補齊（§9.5 對帳式補齊）────────────────')

    // B 記下自己看到的最後一則 —— 前端的 lastMessageId 就是這樣來的
    const beforeOutage = await messagesOf(b)
    const anchorB = beforeOutage.lastMessageId
    check('B 斷線前有版本錨點', anchorB !== null, String(anchorB))

    streamB.close()
    // 讓伺服器端確實跑完 onClosed 的清理，再製造斷線期間的訊息
    await new Promise(r => setTimeout(r, 300))
    const eventsWhileDown = streamB.received.length

    gateway.pushMessage('con_1', '客戶：那我等等再確認')
    await send(a, 'A 的追加說明：單號是 GW4772', (await messagesOf(a)).lastMessageId)

    // 斷線期間第一層輪詢仍在跑（A 還連著），確定訊息確實產生了才判斷「漏掉」
    await streamA.waitFor(
      e => appendedTexts(e).includes('A 的追加說明：單號是 GW4772'),
      { label: 'A 收到斷線期間的訊息' },
    )
    check('B 斷線期間確實收不到任何事件（不是測試自己漏設定）',
      streamB.received.length === eventsWhileDown,
      `${streamB.received.length - eventsWhileDown} 則`)

    // 重連：前端的做法是「重開連線 + 以自己的 lastMessageId 回源頭對帳」
    const reconnectedB = await watch(b, 'browser-b', false)
    const resync = await messagesOf(b, `&since=${encodeURIComponent(anchorB ?? '')}`)
    const resyncTexts = resync.messages.map(m => m.text)

    check('對帳補回斷線期間漏掉的全部訊息（客戶那則 + 同事那則）',
      resyncTexts.includes('客戶：那我等等再確認')
      && resyncTexts.includes('A 的追加說明：單號是 GW4772'),
      resyncTexts.join(' / '))
    check('對帳只回錨點之後的部分，不重送已經看過的訊息',
      !resyncTexts.includes('A 的回覆：已為您補寄，明天到貨'),
      resyncTexts.join(' / '))
    check('補回的訊息由舊到新，可直接接在訊息流尾端',
      resyncTexts[0] === '客戶：那我等等再確認',
      resyncTexts.join(' / '))

    // 錨點已被 N 則的視窗擠出去時：寧可重送也不可漏送（§9.4）
    const lost = await messagesOf(b, '&since=msg_not_in_window')
    check('錨點失效時回傳整批而非空陣列（寧可重送也不漏送）',
      lost.messages.length === gateway.messageCount(),
      `${lost.messages.length} / ${gateway.messageCount()}`)

    // 重連後的連線必須是活的 —— 否則會是「補齊了，然後又聾了」
    const cursorAfter = reconnectedB.cursor()
    const resumedAt = Date.now()
    await send(a, 'A 的第三則：確認完成', (await messagesOf(a)).lastMessageId)
    const afterReconnect = await reconnectedB.waitFor(
      e => appendedTexts(e).includes('A 的第三則：確認完成'),
      { since: cursorAfter, label: 'B 重連後的新訊息' },
    )
    check('重連後的連線恢復即時推播，延遲仍在預算內',
      afterReconnect.at - resumedAt <= DELIVERY_BUDGET_MS,
      `實際 ${afterReconnect.at - resumedAt}ms`)
  }
  finally {
    await harness?.close()
  }

  console.log(
    failures === 0
      ? '\n✅ M1 即時性驗收（4 秒內看到、斷線補齊）全數通過\n'
      : `\n❌ ${failures} 項未通過\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n💥', err instanceof Error ? err.message : err)
  process.exit(1)
})
