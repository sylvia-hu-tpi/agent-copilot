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
 *
 * ── ④ 建議卡／知識庫檢索故障（specs/002-suggestion-knowledge-search US3、T045）───
 * 獨立起第二份 server（`AC_SMOKE_FORCE_SUGGEST_FAILURE`／`AC_SMOKE_FORCE_KNOWLEDGE_FAILURE`
 * 環境變數注入故障），驗證 HTTP／SSE 這一層的保證：故障不得拖慢或阻擋送出訊息。
 * 兩個 provider 各自的故障隔離邏輯已由 test/copilot-analysis.test.ts 的單元測試涵蓋，
 * 這裡不重複測業務邏輯本身。
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

/**
 * 三個分析事件 —— specs/003-analysis-trigger-policy 契約不變式 C 的過濾範圍。
 * 未 JOIN 的連線 MUST 一則都收不到，**含連線建立當下的快照**。
 */
function isAnalysisEvent(evt: CopilotEvent): boolean {
  return evt.type === 'summary.updated' || evt.type === 'sentiment.updated' || evt.type === 'suggestion.updated'
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * ④ 建議卡／知識庫檢索故障時，訊息流與 Composer 不受影響（specs/002-suggestion-knowledge-search
 * US3、T045）——獨立起一份 server（env 注入故障開關），避免影響上面 ①②③ 用的那份 harness。
 *
 * 兩個開關同時打開：`AIProvider.suggest()` 恆失敗、`KnowledgeProvider.search()` 恆失敗——
 * 兩者各自獨立的故障隔離已由 test/copilot-analysis.test.ts 的單元測試涵蓋，這裡只驗證
 * HTTP／SSE 這一層的保證：故障不得拖慢或阻擋送出訊息，且對應區塊／端點如實回報錯誤狀態。
 */
async function runFaultInjectionScenario(): Promise<void> {
  console.log('\n── ④ 建議卡／知識庫檢索故障：訊息流不受影響（US3）──────────')

  let harness: NitroHarness | undefined
  try {
    harness = await startNitro({
      port: 3125,
      env: {
        AC_SMOKE_FORCE_SUGGEST_FAILURE: '1',
        AC_SMOKE_FORCE_KNOWLEDGE_FAILURE: '1',
      },
    })
    const a = harness.client()
    await a.signIn('agent@example.com')

    await a.call(`/api/conversations/${CONV}`)
    const joined = await a.call(`/api/conversations/${CONV}/join`, {
      method: 'POST', body: JSON.stringify({ mode: 'manual' }),
    })
    check('④ JOIN 仍然成功（故障不影響 JOIN 本身）', joined.status === 200, `實際 ${joined.status}`)

    const streamA = await watch(a, 'browser-a-fault', true)

    // SC-003：即使建議卡生成必然失敗，送出訊息仍須立即成功、不被拖慢
    const sendAt = Date.now()
    await send(a, 'A：即使建議卡故障，這則訊息也該正常送出', (await messagesOf(a)).lastMessageId)
    const sendElapsed = Date.now() - sendAt
    check(
      '④ 建議卡／知識庫故障期間，送出訊息仍立即成功、不被阻擋或延遲（SC-003、憲法 3.2）',
      sendElapsed <= DELIVERY_BUDGET_MS,
      `實際 ${sendElapsed}ms`,
    )

    // 建議卡最終應顯示 error（AIProvider.suggest() 恆失敗），不影響摘要／情緒
    const suggestionError = await streamA.waitFor(
      e => e.type === 'suggestion.updated' && e.suggestion.status === 'error',
      { label: 'A 收到 suggestion.updated（status: error）', timeoutMs: 15_000 },
    )
    check(
      '④ 建議卡生成故障時，suggestionBlock 最終轉為 error（不影響訊息流本身）',
      suggestionError.event.type === 'suggestion.updated' && suggestionError.event.suggestion.status === 'error',
    )

    // 知識庫快查端點：MUST NOT 回 5xx，改以 degraded:true 降級（憲法 3.1／3.2）
    const searchRes = await a.call(`/api/conversations/${CONV}/knowledge-search`, {
      method: 'POST',
      body: JSON.stringify({ query: '故障期間的查詢' }),
    })
    const searchBody = JSON.parse(searchRes.body) as { hits: unknown[], degraded?: boolean }
    check(
      '④ 知識庫檢索故障時，快查端點回 200 { hits: [], degraded: true }（不是 5xx）',
      searchRes.status === 200 && searchBody.degraded === true && searchBody.hits.length === 0,
      `status=${searchRes.status} body=${searchRes.body}`,
    )
  }
  finally {
    await harness?.close()
  }
}

/**
 * ⑥ 離開對話後不再有任何分析事件 —— specs/003-analysis-trigger-policy SC-002、FR-012、FR-016a。
 *
 * ⚠️ **這是 2026-08-27 那晚缺陷的另一半**：客服按下離開之後，分析仍然每 20 秒跑一輪。
 *    原因是 `runIncremental()` 的門檻寫的是「有沒有分析狀態」，而分析狀態有 2 小時 sliding TTL、
 *    LEAVE 不會清掉它。修好之後這條路徑靠的是既有機制，不另開停止通道（決策 4）：
 *    離開 → 前端立刻補送一次 `beat('viewing')`（`joined: false`）→ 控制通道判定為真實變化
 *    → 重新 attach → 訂閱者的 `joined` 翻轉 → 對話層級聚合翻轉 → 分析停止。
 *
 * ⚠️ **前提必須先驗**：如果 JOIN 狀態下本來就收不到分析事件，後面「離開後收不到」會是假綠。
 *    這與 ⑤ 場景的教訓是同一句話（2026-08-27：FR-020 連 4 次全紅，根因是測試自己沒讓 B 離開對話）。
 */
async function runLeaveStopsAnalysis(a: HttpClient, gateway: NitroHarness['gateway']): Promise<void> {
  console.log('\n── ⑥ 離開對話後 5 秒內不再有分析事件（specs/003-analysis-trigger-policy SC-002）──')

  const stream = await watch(a, 'browser-a-leave', true)

  // 前提：仍 JOIN 時收得到分析事件（背景 debounce 8 秒，給足餘裕）
  const cursorBefore = stream.cursor()
  gateway.pushMessage('con_1', '客戶：離開前的最後一個問題')
  const before = await stream.waitFor(
    e => isAnalysisEvent(e),
    { since: cursorBefore, label: '離開前仍收得到分析事件（前提）', timeoutMs: 12_000 },
  )
  check('⑥ 前提成立：仍 JOIN 時收得到分析事件', isAnalysisEvent(before.event), before.event.type)

  // 按下「離開對話」。⚠️ 前端的 `leave()` 在拿到回應後會**立刻**補送一次 `beat('viewing')`，
  //    這裡照同一條路徑走 —— 那一次心跳才是讓 server 端 `joined` 翻轉的東西。
  const leaveRes = await a.call(`/api/conversations/${CONV}/leave`, { method: 'POST' })
  check('⑥ A 成功離開對話', leaveRes.status === 200, `實際 ${leaveRes.status} ${leaveRes.body}`)

  const beatRes = await a.call('/api/presence', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: CONV, state: 'viewing', joined: false, visible: true, clientId: 'browser-a-leave',
    }),
  })
  check('⑥ 離開後補送的 presence（joined:false）上報成功', beatRes.status === 200, `實際 ${beatRes.status}`)

  const cursorAfterLeave = stream.cursor()
  gateway.pushMessage('con_1', '客戶：離開之後才說的話')

  // 中欄照常 —— 過濾範圍恰為三個分析事件（US2 AC#3）
  const stillAppended = await stream.waitFor(
    e => appendedTexts(e).includes('客戶：離開之後才說的話'),
    { since: cursorAfterLeave, label: '離開後中欄仍收得到新訊息', timeoutMs: DELIVERY_BUDGET_MS },
  )
  check('⑥ 離開後中欄照常收到新訊息（US2 AC#3：中欄完全不受影響）', Boolean(stillAppended))

  // ⚠️ 5 秒是 SC-002 的門檻本身，不是任意的等待時間。前景 debounce 1 秒、背景 8 秒，
  //    5 秒內若門檻沒生效，前景那條路徑一定會冒出分析事件。
  await sleep(5_000)
  const analysisAfterLeave = stream.received.slice(cursorAfterLeave).filter(r => isAnalysisEvent(r.event))
  check(
    '⑥ 離開後 5 秒內不再有任何分析事件（SC-002）',
    analysisAfterLeave.length === 0,
    analysisAfterLeave.map(r => r.event.type).join(' / ') || '0 則',
  )

  stream.close()
}

/**
 * ⑦ 建議卡的漸進式引用：SSE 上依序收到 `ready/pending` 與 `ready/cited`
 * （specs/004-progressive-citations US1／US2、SC-001／SC-002）。
 *
 * 獨立起一份 server 並以 `AC_SMOKE_KNOWLEDGE_DELAY_MS` 給檢索一個人為延遲 ——
 * Mock 檢索本身是零延遲的，不拉開就看不到中間狀態，這條序列會退化成一則事件。
 *
 * ⚠️ **這裡驗的是 HTTP／SSE 這一層的序列**，兩段之間的交錯規則（誰不得蓋誰、呼叫幾次）
 *    已由 `test/copilot-analysis.test.ts` 的 `describe('兩段式（004 US1）')` 涵蓋，不重複。
 *
 * ⚠️ **SC-003（第二段更新時 Composer 一字不變）在這一層驗不到，MUST NOT 寫成已驗證。**
 *    本 harness 不含瀏覽器，看不到 Composer 的實際內容。它由
 *    `test/contract-guards.test.ts` 的原始碼守衛（`useCopilotSession` 不得 import `useDraft`）
 *    與 quickstart US2 的手動場景各守一半。
 *
 *    ⚠️ **2026-08-29 實測推翻了兩種「弱代理」寫法**，記錄於此以免有人再寫一次：
 *      ① 「兩則事件之間不存在任何非 `suggestion.updated` 的對話事件」—— `messages.appended`
 *         （正常訊息流量）與冷啟動的 `summary.updated`／`sentiment.updated` 本來就會落在
 *         中間，而它們與 Composer 無關；
 *      ② 「兩則之間恰好只有一則 `suggestion.updated`」—— 第二層輪詢在這 2 秒內會為新訊息
 *         另起一輪分析，中間本來就會多出 `analyzing`／`pending`。
 *    兩者都恆紅，而且驗的都不是 SC-003。**寧可不驗，也不要留一個看起來像驗過的假斷言。**
 */
async function runProgressiveCitationScenario(): Promise<void> {
  console.log('\n── ⑦ 建議卡漸進式引用：ready/pending → ready/cited（004 US1）──────')

  let harness: NitroHarness | undefined
  try {
    harness = await startNitro({
      port: 3126,
      env: { AC_SMOKE_KNOWLEDGE_DELAY_MS: '2000' },
    })
    const a = harness.client()
    await a.signIn('agent@example.com')

    await a.call(`/api/conversations/${CONV}`)
    const joined = await a.call(`/api/conversations/${CONV}/join`, {
      method: 'POST', body: JSON.stringify({ mode: 'manual' }),
    })
    check('⑦ A 成功 JOIN', joined.status === 200, `實際 ${joined.status}`)

    const stream = await watch(a, 'browser-a-citation', true)

    const pending = await stream.waitFor(
      e => e.type === 'suggestion.updated' && e.suggestion.status === 'ready' && e.suggestion.citation === 'pending',
      { label: '⑦ 第一段落地（ready/pending）', timeoutMs: 15_000 },
    )
    check(
      '⑦ 第一段在檢索完成前就落地為 ready/pending（FR-001：先給可用的卡）',
      pending.event.type === 'suggestion.updated' && pending.event.suggestion.citation === 'pending',
    )
    check(
      '⑦ 第一段確實帶著卡片（`pending` 不是一個空狀態）',
      pending.event.type === 'suggestion.updated' && pending.event.suggestion.cards.length > 0,
      pending.event.type === 'suggestion.updated' ? `${pending.event.suggestion.cards.length} 張` : '',
    )

    const cursorAfterPending = stream.cursor()
    const cited = await stream.waitFor(
      e => e.type === 'suggestion.updated' && e.suggestion.status === 'ready' && e.suggestion.citation === 'cited',
      { since: cursorAfterPending, label: '⑦ 第二段整批換上（ready/cited）', timeoutMs: 30_000 },
    )
    check(
      '⑦ 第二段在第一段**之後**才落地，且標示為 cited（順序本身就是驗收項）',
      cited.at >= pending.at
      && cited.event.type === 'suggestion.updated'
      && cited.event.suggestion.provenance.stage === 2,
      cited.event.type === 'suggestion.updated' ? JSON.stringify(cited.event.suggestion.provenance) : '',
    )
    check(
      '⑦ 第二段的 knowledgeSearch 記下真實命中數（憲法 6.2 的可稽核證據）',
      cited.event.type === 'suggestion.updated'
      && cited.event.suggestion.knowledgeSearch.ran
      && cited.event.suggestion.knowledgeSearch.hitCount > 0,
      cited.event.type === 'suggestion.updated' ? JSON.stringify(cited.event.suggestion.knowledgeSearch) : '',
    )

    // 整塊覆蓋（契約 §2、FR-010）：每一則 `suggestion.updated` 都帶著**完整**的 block，
    // 不是 partial merge、更不是逐字串流的片段。這條在事件層級驗得到，而且恆真。
    check(
      '⑦ 第二段送的是完整 block（整塊覆蓋，非 partial merge／逐字串流）',
      cited.event.type === 'suggestion.updated'
      && cited.event.suggestion.cards.length > 0
      && cited.event.suggestion.cards.every(c => typeof c.text === 'string' && c.text.length > 0)
      && typeof cited.event.suggestion.updatedAt === 'string',
    )

    // ⚠️ **SC-003 在這一層驗不到**（見本函式開頭）。這行不是 check()，因為沒有可斷言的東西 ——
    //    寫成 check() 只會製造「已經驗過了」的錯覺，那比沒有驗更糟。
    console.log('  ℹ️  SC-003（更新時 Composer 一字不變）不在本 harness 的涵蓋範圍：'
      + '靜態面由 test/contract-guards.test.ts 守（useCopilotSession 不得 import useDraft），'
      + '行為面由 quickstart US2 的手動場景驗')

    stream.close()
    await sleep(300)
  }
  finally {
    await harness?.close()
  }
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

    // ⚠️ `let`：③ 會把 A 的連線換成重連後的那一條（見該處的憑證登記說明）
    let streamA = await watch(a, 'browser-a', true)
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
    //    只能靠輪詢發現 `last_message_at` 變了才 poke。
    //    這一筆才是驗收數字的來源，前一筆再快都不能代替它。
    //
    // ⚠️ **這一項分不出是第一層還是第二層發現的** —— 兩層在前景都是 3 秒。
    //    2026-08-29 之前第一層整場都沒跑過（見 ARCHITECTURE §9.3.1 的警告），
    //    這一項照樣是綠的，缺陷一路藏到 ⑤ 才露出來（那裡第二層降到 15 秒）。
    //    要真的驗第一層，得看 ⑤ 那一項，或直接數 gateway 收到幾筆 `_search`。
    const cursorCustomer = streamB.cursor()
    const customerAt = Date.now()
    gateway.pushMessage('con_1', '客戶：好，那我再等等')

    const customerSeen = await streamB.waitFor(
      e => appendedTexts(e).includes('客戶：好，那我再等等'),
      { since: cursorCustomer, label: 'B 收到客戶的訊息' },
    )
    check(
      `客戶回覆（無捷徑，只靠輪詢偵測）也在 ${DELIVERY_BUDGET_MS / 1000} 秒內出現`,
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

    console.log('\n── ③ 情緒面板：分析中不阻擋訊息、多連線收斂、重連快照（specs/001-sentiment-panel）──')

    // ① 分析仍在進行中（或尚未完成）時，送出訊息 MUST NOT 被阻擋或延遲（SC-002、FR-007）。
    //    JOIN 當下已非同步觸發過一次冷啟動，這裡再送一則客戶訊息會觸發 debounce 後的增量分析——
    //    重點不是等它跑完，而是驗證「送出訊息」這條路徑完全不等待面板分析。
    const sendDuringAnalysisAt = Date.now()
    gateway.pushMessage('con_1', '客戶：還有一個問題想問')
    await send(a, 'A 的回覆：好的，請說', (await messagesOf(a)).lastMessageId)
    const sendDuringAnalysisElapsed = Date.now() - sendDuringAnalysisAt
    check(
      '面板分析（冷啟動／增量）進行中，訊息送出仍立即成功、不被阻擋（SC-002）',
      sendDuringAnalysisElapsed <= DELIVERY_BUDGET_MS,
      `實際 ${sendDuringAnalysisElapsed}ms`,
    )

    // ② 事件收斂：**同一位已 JOIN 客服的兩條連線**（例如開了兩個分頁）都應各自收到
    //    summary.updated／sentiment.updated（plan.md Testing 承諾）。
    //
    // ⚠️ **2026-08-28 改寫（specs/003-analysis-trigger-policy FR-016a）**：原本這裡驗的是
    //    「A 與 B 兩條連線都收到」，而 B 從頭到尾**沒有 JOIN**。新的契約不變式 C 明訂
    //    未 JOIN 的連線 MUST 收不到這三個事件，因此原斷言驗的是已被推翻的行為 ——
    //    收斂改用 A 自己的第二條連線驗，B 那一半反過來成為 FR-016a 的斷言。
    const streamA2 = await watch(a, 'browser-a-2', true)
    const cursorA2 = streamA.cursor()
    const cursorA2b = streamA2.cursor()
    const cursorB2 = reconnectedB.cursor()
    const triggeredAt = Date.now()
    gateway.pushMessage('con_1', '客戶：訂單編號是 GW9981')

    const isCopilotUpdate = (e: CopilotEvent) => e.type === 'summary.updated' || e.type === 'sentiment.updated'
    // debounce 1 秒聚合 + MockAIProvider 近乎即時回應，給足餘裕
    const copilotTimeoutMs = 8_000

    const summaryA = await streamA.waitFor(isCopilotUpdate, { since: cursorA2, label: 'A 收到面板更新', timeoutMs: copilotTimeoutMs })
    const summaryA2 = await streamA2.waitFor(isCopilotUpdate, { since: cursorA2b, label: 'A 的第二個分頁收到面板更新', timeoutMs: copilotTimeoutMs })
    check(
      '已 JOIN 客服的兩條連線都在合理時間內各自收到 summary.updated／sentiment.updated（事件收斂）',
      summaryA.at - triggeredAt <= copilotTimeoutMs && summaryA2.at - triggeredAt <= copilotTimeoutMs,
      `A ${summaryA.at - triggeredAt}ms／A2 ${summaryA2.at - triggeredAt}ms`,
    )

    // FR-016a：B 從頭到尾沒有 JOIN → 這三個事件一則都不該送到他的連線。
    // ⚠️ 上面兩個 waitFor 已經等到分析真的發生了，因此「B 沒收到」不是因為還沒送。
    const analysisToB = reconnectedB.received.slice(cursorB2).filter(r => isAnalysisEvent(r.event))
    check(
      '未 JOIN 的連線收不到三個分析事件（FR-016a、SC-006）',
      analysisToB.length === 0,
      analysisToB.map(r => r.event.type).join(' / ') || '0 則',
    )
    // 中欄照常 —— 過濾範圍恰為三個分析事件，MUST NOT 波及訊息流（US2 AC#3）。
    // ⚠️ 這裡 MUST 用 waitFor 而不是「檢查目前收到幾則」：上面兩個 waitFor 只等到 A 收到分析事件，
    //    B 的 messages.appended 可能還在路上，用當下的計數會隨時序紅／綠。
    const appendedToB = await reconnectedB.waitFor(
      e => appendedTexts(e).includes('客戶：訂單編號是 GW9981'),
      { since: cursorB2, label: 'B 仍照常收到中欄訊息', timeoutMs: DELIVERY_BUDGET_MS },
    )
    check('未 JOIN 的連線仍照常收到 messages.appended（中欄完全不受影響，US2 AC#3）',
      appendedTexts(appendedToB.event).includes('客戶：訂單編號是 GW9981'))
    // 再確認一次：整段期間三個分析事件仍然是零
    check(
      '中欄事件照送的同時，三個分析事件仍然一則都沒有（過濾範圍恰為那三個）',
      reconnectedB.received.slice(cursorB2).filter(r => isAnalysisEvent(r.event)).length === 0,
    )

    // ③ FR-010：客服切回對話（重新連線＋watch）時，MUST 立即收到已保留的分析結果，
    //    不必等待任何新客戶發言（不同於①②，這裡刻意不再 push 新訊息）——
    //    這是 T010c 的重連快照，伺服端以 `void sendAnalysisSnapshotAndResume()`
    //    非同步送出（不擋 attach() 本身），所以用 waitFor 而非同步檢查 received，
    //    但仍斷言它在很短時間內就到，而非要等到下一次真正的分析事件。
    //
    // ⚠️ **2026-08-28 改寫（specs/003-analysis-trigger-policy FR-003）**：快照同樣**只給已 JOIN 的
    //    連線**。原本這裡用的是 B（從未 JOIN），那條斷言驗的是已被推翻的行為。改用 A 自己的
    //    第二個分頁重連 —— 001 FR-010 的 2 秒門檻**不得退步**（SC-005）。
    //
    // ⚠️ **2026-09-02 改寫（specs/005-m2-residual-defects US1、SC-001）**：這裡原本是「先關掉 A 既有的
    //    兩條連線、再開新的那一條」—— 因為 `registerCredential()` 以 `(orgId, operatorId)` 為鍵，同一位客服
    //    的第二條連線關閉時會把還開著的第一條連線的憑證一併移除，`borrowCredential()` 回 null、兩層輪詢
    //    全部拉回空陣列，畫面正常但訊息再也不進來。那是既有缺陷的**迴避**。
    //    005 把登記與 `session.watchers` 都改以連線為單位，這一段因此改成**真實情境**：關掉 A 的第二個
    //    分頁，斷言第一個分頁仍在 4 秒內收到新訊息。這是 `connectionId` 從 `stream.get.ts` 一路接到
    //    `registerCredential()`／`watchConversation()` 的接線**唯一**能自動化驗到的地方
    //    （`test/connection-counting.test.ts` 只驗 registry，碰不到 route）。
    streamA2.close()
    await sleep(300)

    const cursorA1 = streamA.cursor()
    const afterTabCloseAt = Date.now()
    gateway.pushMessage('con_1', '客戶：關掉一個分頁之後這句還看得到嗎')
    const stillAlive = await streamA.waitFor(
      e => appendedTexts(e).includes('客戶：關掉一個分頁之後這句還看得到嗎'),
      { since: cursorA1, label: 'A 關掉第二個分頁後仍收到新訊息', timeoutMs: DELIVERY_BUDGET_MS },
    )
    check(
      '同一客服關掉其中一個分頁，另一個分頁仍在 4 秒內收到新訊息（005 SC-001；修正前 100% 失聯）',
      stillAlive.at - afterTabCloseAt <= DELIVERY_BUDGET_MS,
      `實際 ${stillAlive.at - afterTabCloseAt}ms`,
    )

    // 之後的場景沿用「A 只有一條全新連線」的前提 —— 這裡才把第一個分頁也關掉
    streamA.close()
    await sleep(300)

    const reconnectAt = Date.now()
    const resumedA = await watch(a, 'browser-a-3', true)
    const snapshotSummary = await resumedA.waitFor(
      e => e.type === 'summary.updated',
      { label: 'A 重連後立即收到 summary.updated 快照', timeoutMs: 2_000 },
    )
    const snapshotSentiment = await resumedA.waitFor(
      e => e.type === 'sentiment.updated',
      { label: 'A 重連後立即收到 sentiment.updated 快照', timeoutMs: 2_000 },
    )
    check(
      '已 JOIN 的連線重新 watch 後，MUST 立即收到已保留的 summary.updated／sentiment.updated（001 FR-010，不得退步）',
      snapshotSummary.at - reconnectAt <= 2_000 && snapshotSentiment.at - reconnectAt <= 2_000,
      `summary ${snapshotSummary.at - reconnectAt}ms／sentiment ${snapshotSentiment.at - reconnectAt}ms`,
    )
    // ⑤ 之後都用這一條當作 A 的連線（見上面關閉順序的說明）
    streamA = resumedA

    // ⚠️ **快照那條路徑走 `send()`、不經 `forward()`** —— 只在 `forward()` 加過濾對它完全無效。
    //    這一項就是為了抓那個漏洞：未 JOIN 的全新連線一連上線 MUST NOT 拿到任何一個 Block
    //    （漏掉的症狀是「畫面上沒有面板，資料卻已經在他的瀏覽器裡」，SC-006 在伺服器端不成立）。
    reconnectedB.close()
    await sleep(300)
    const freshB = await watch(b, 'browser-b-fresh', false)
    await sleep(1_500)
    const snapshotToB = freshB.received.filter(r => isAnalysisEvent(r.event))
    check(
      '未 JOIN 的連線在建立當下 MUST NOT 收到分析快照（FR-003、契約不變式 C 的第二條路徑）',
      snapshotToB.length === 0,
      snapshotToB.map(r => r.event.type).join(' / ') || '0 則',
    )
    freshB.close()
    await sleep(300)

    console.log('\n── ⑤ 多對話背景更新：切走仍 JOIN 時繼續背景分析、切回補跑摘要（specs/002-suggestion-knowledge-search US4）──')

    // ⚠️ **前置條件：B 必須先離開這個對話。**
    //    優先度是**整個對話**聚合出來的（`PollingMessageSource.aggregateState()`：任一訂閱者為
    //    foreground 則整體為 foreground，§9.2 同一份規則）。B 在 ③ 重連後仍以 `viewing`＝foreground
    //    看著同一個對話，此時就算 A 切走，這個對話對系統而言**仍然是前景**——摘要照重算是正確行為，
    //    不是 FR-020 的違反。不先關掉 B 的話，下面「背景期間 MUST NOT 重算摘要」驗的是一個
    //    根本不成立的前提，且會隨機因負載時序而紅／綠（2026-08-27：實測 HEAD 上連 4 次全紅）。
    // （B 的兩條連線已在 ③ 收尾時關閉，此處不需要再關）

    // A 切走但仍 JOIN 著（research.md #8：presence 語意修正後 MUST 變成 background watch，不是 unwatch）
    const awayRes = await a.call('/api/presence', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, state: 'away', joined: true, visible: true, clientId: 'browser-a-3' }),
    })
    check('⑤ A 切走但仍 JOIN 時，presence 上報成功', awayRes.status === 200, `實際 ${awayRes.status}`)

    const cursorBgTrigger = streamA.cursor()
    gateway.pushMessage('con_1', '客戶：背景期間又問了一個問題')

    // 前提：訊息本身要先被偵測到（第一層清單輪詢 → poke → 第二層拉取），
    // 否則下面的「背景分析仍持續」驗的是一個根本沒被觸發的東西
    await streamA.waitFor(
      e => appendedTexts(e).includes('客戶：背景期間又問了一個問題'),
      { since: cursorBgTrigger, label: '⑤ 背景期間的客戶訊息被偵測到（前提）', timeoutMs: 12_000 },
    )

    // 背景 debounce 是 BACKGROUND_DEBOUNCE_MS（8 秒），給足餘裕
    const bgSentiment = await streamA.waitFor(
      e => e.type === 'sentiment.updated',
      { since: cursorBgTrigger, label: 'A 背景收到 sentiment.updated', timeoutMs: 12_000 },
    )
    check('⑤ 客服切走但仍 JOIN 的背景對話，情緒分析仍持續更新（FR-019）', bgSentiment.event.type === 'sentiment.updated')

    const bgSuggestion = await streamA.waitFor(
      e => e.type === 'suggestion.updated',
      { since: cursorBgTrigger, label: 'A 背景收到 suggestion.updated', timeoutMs: 12_000 },
    )
    check('⑤ 背景對話的建議卡也持續更新（FR-019，含其必要的知識庫檢索）', bgSuggestion.event.type === 'suggestion.updated')

    // 摘要 MUST NOT 在背景期間重算（FR-020）——同一批觸發後的短時間內不該出現 summary.updated
    const gotSummaryInBackground = await streamA.waitFor(
      e => e.type === 'summary.updated',
      { since: cursorBgTrigger, label: '(不該出現) summary.updated', timeoutMs: 2_000 },
    ).then(() => true).catch(() => false)
    check('⑤ 背景期間 MUST NOT 重算摘要（FR-020）', !gotSummaryInBackground)

    // 客服切回（重新聚焦）——優先度升級為 foreground（驗證 attach() 不被 watched.has() 擋下，
    // 即 research.md #8 決策 3／T055），摘要才補跑並先顯示「更新中」（US4 AC#5）
    const cursorRefocus = streamA.cursor()
    const refocusAt = Date.now()
    const refocusRes = await a.call('/api/presence', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV, state: 'joined', joined: true, visible: true, clientId: 'browser-a-3' }),
    })
    check('⑤ A 切回時 presence 上報成功', refocusRes.status === 200, `實際 ${refocusRes.status}`)

    const analyzingSummary = await streamA.waitFor(
      e => e.type === 'summary.updated' && e.summary.status === 'analyzing',
      { since: cursorRefocus, label: '切回後摘要顯示「更新中」', timeoutMs: 3_000 },
    )
    check('⑤ 切回背景對話時，摘要先顯示「更新中」再補跑（US4 AC#5）',
      analyzingSummary.event.type === 'summary.updated' && analyzingSummary.event.summary.status === 'analyzing')

    const readySummary = await streamA.waitFor(
      e => e.type === 'summary.updated' && e.summary.status === 'ready',
      { since: cursorRefocus, label: '補跑完成的摘要', timeoutMs: 8_000 },
    )
    check('⑤ 摘要補跑後恢復 ready，涵蓋背景期間的新發言',
      readySummary.at - refocusAt <= 8_000,
      `實際 ${readySummary.at - refocusAt}ms`)

    // 斷線重連（含瀏覽器重新整理）後，已 JOIN 的對話立即以背景優先度復原，不必等下一次
    // presence 心跳（research.md #8 決策 4，T056；一併驗證 T059 的重連復原目標）
    streamA.close()
    await new Promise(r => setTimeout(r, 300))
    const restoredStream = await a.openStream('browser-a-restored')
    const restoredControl = await restoredStream.waitFor(
      e => e.type === 'control.updated' && e.conversationId === CONV,
      { label: '重連後不必任何 presence 心跳，立即收到已 JOIN 對話的背景 watch', timeoutMs: 3_000 },
    )
    check('⑤ 斷線重連後，已 JOIN 的對話立即以背景優先度復原（不必等下一次 presence 心跳）',
      restoredControl.event.type === 'control.updated')
    restoredStream.close()
    await sleep(300)

    await runLeaveStopsAnalysis(a, gateway)
  }
  finally {
    await harness?.close()
  }

  await runFaultInjectionScenario()
  await runProgressiveCitationScenario()

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
