# Phase 0 — 技術研究：M2 遺留缺陷與量測補強

**Spec**: [spec.md](./spec.md) ｜ **日期**: 2026-09-02

> 每一則都寫「決定／理由／否決的替代方案」。
> 標 ⚠️ 的是「最誘人但錯的做法」——它們看起來更省事，而且錯了不會報錯。

---

## US1 — 多連線的計數

### #1 登記的唯一性單位：server 端產生的 `connectionId`，不是 `clientId`

**決定**：`stream.get.ts` 在每一條 SSE 連線建立時以 `crypto.randomUUID()` 產生一個
**server 端** `connectionId`，作為 ① 憑證登記的鍵、② `session.watchers` 的鍵。
`clientId`（前端帶來的）**不作為鍵**，只作為定址標籤（見 #2）。

**理由**：`clientId` 存在 `sessionStorage`（`app/stores/stream.ts` 的 `resolveClientId()`），
而**瀏覽器的「複製分頁」會連同 `sessionStorage` 一起複製** —— 兩個分頁因此可能帶著
**同一個 `clientId`**。若拿它當鍵，這兩個分頁會共用一筆登記，關掉其中一個就把另一個一併刪掉：
**那正是本規格要修的缺陷，換了個觸發條件重新出現，而且一樣不報錯。**
`PollingMessageSource.subscribe()` 用 `Symbol()` 解過同一個坑（該檔註解寫得很清楚），
本規格沿用同一原則；改用 UUID 字串而非 symbol 的唯一理由是 `session.watchers` 會經
`StateStore` 持久化，需要可序列化的值。

**否決的替代方案**：
- 以 `clientId` 為鍵 —— 見上，會靜默重現缺陷。
- 以 `Symbol()` 為鍵（完全比照 `subscribe()`）—— 憑證登記可以，但 `watchers` 不行（要進 store），
  兩處用不同機制會讓 FR-004 的「一致性」難以斷言。統一用字串。

### #2 心跳與活躍度的定址：`(orgId, operatorId, clientId)` 命中的**全部**登記

**決定**：`setCredentialActivity()` 與新的存活心跳都以 `(orgId, operatorId, clientId)` 定址，
並更新**所有命中的登記**，而不是「取一筆」。
存活心跳找不到任何一筆時**重新登記**（upsert，見 #3a）；
`setCredentialActivity()` 找不到時 no-op（活躍度沒有登記可依附時本來就無事可做）。

**理由**：承 #1，複製分頁會讓兩條連線共用 `clientId`。若心跳只更新「其中一筆」，
另一筆會在 TTL 到期後被回收 —— 而那條連線還活著。更新全部命中者是安全的：
它永遠不會碰到別的 operator 或別的分頁的登記，最壞情況只是多更新了一筆本來就該活著的。

⚠️ **`setCredentialActivity()` 現行是 operator 級的（`registry.get(orgId).get(operatorId)`），
這本身是一個既有的靜默缺陷**：兩個分頁一前景一背景時，後送到的心跳覆蓋前一筆，
`hasForegroundOperator()` 因此可能回錯，第一層清單輪詢在 3 秒與 30 秒之間跳。
改成 per-registration 後，`hasForegroundOperator()` ＝「任一登記為前景」，
才真正符合這個函式的名字。本規格順手修掉它（FR-001／FR-002 的直接後果，不是額外範圍）。

### #3 存活兜底的訊號來源：前端**連線層級**心跳（新端點）

**決定**：新增 `POST /api/connection/beat`（body 只有 `clientId`），前端在 SSE 連線建立後
每 20 秒送一次，**與有沒有進入對話無關**；server 端更新該連線登記的 `lastSeenAt`。
常數比照 presence：`CREDENTIAL_TTL_MS = 45_000`、`CREDENTIAL_HEARTBEAT_MS = 20_000`。

**理由**：FR-005a 明文要求存活訊號是連線層級的。
現有的 `POST /api/presence`（唯一的既有心跳）**body 必填 `conversationId`**，
分頁開著但還沒點進任何對話時完全不送 —— 而那正是「登記已存在、但沒有任何心跳」的狀態，
沿用它等於留一個永遠洩漏的視窗。

⚠️ **MUST NOT 用 `stream.get.ts` 既有的 server 端 `stream.heartbeat` 當存活訊號。**
這是最誘人的做法（零前端改動、25 秒現成的節拍），但它證明的是「**server 還認為這條連線存在**」，
不是「client 還在」。半開連線（網路斷、瀏覽器崩潰）正是要防的情形，而在那個情形下
server 端心跳會**恆真**地一直把登記續命下去 —— 兜底變成永不觸發的裝飾。
存活訊號必須由**對側**發出，這是它唯一有意義的形式。

**否決的替代方案**：把 `presence.post.ts` 的 `conversationId` 改成 optional ——
那支路由的 `state`／`joined`／`visible` 三個欄位都以「對某個對話」為前提，
拿掉對話之後這些欄位沒有意義，會讓一支語意清楚的端點變成兩件事的混合體。

### #3a 心跳是 **upsert**：命中 0 筆時重新登記，MUST NOT no-op

**決定**：`POST /api/connection/beat` 命中 0 筆登記時，以
`requireActiveBffSession(event)` 取得的 `operatorId`／`orgId`／`accessToken`
**重新登記一筆**（`connectionId` 由 server 現場另產，維持「不離開 server」）。端點仍不接受、也不回傳任何 token（憲法 1.1），
身分來源與 `stream.get.ts:48` 的 `requireActiveBffSession(event)` 完全相同（`registerCredential()` 在同檔第 85 行用的就是它）。
⚠️ 定址時**不先套 TTL 濾網**：逾期但尚未被讀取剔除的舊筆直接刷新、`connectionId` 保留；
只有讀取點跑過、登記真的消失後才走上面的重新登記（2026-09-02 裁定，contracts §4）。

**理由**：⚠️ **只抄 presence 的數字、不抄它的語意，兜底會自己變成本規格要修的缺陷。**
`CREDENTIAL_TTL_MS = 45_000` ／ `CREDENTIAL_HEARTBEAT_MS = 20_000` 抄自 presence，
但 presence 真正的安全網是 `reportViewing()`（`server/services/presence.ts:55`）是 **upsert**
—— 項目被 TTL 清掉後，下一拍心跳把它重建。

心跳若寫成「找不到就 no-op」，**背景分頁會自己觸發原始缺陷**：
瀏覽器對隱藏分頁的計時器有節流（Chrome 在分頁隱藏數分鐘後壓到約每分鐘一次），
60 秒 > 45 秒 → 登記被 TTL 剔除 → 而 SSE 連線**沒有斷**、不會有重連、
沒有任何路徑會重新登記 → 那條連線的憑證永遠回不來。
症狀與 US1 的原始缺陷逐字相同：畫面正常、不報錯、訊息不再進來。

**否決的替代方案**：
- **把 `CREDENTIAL_TTL_MS` 拉長到 150 秒**（大於節流週期）—— 異常中斷後已登出的憑證
  會被繼續拿去輪詢最長 2.5 分鐘，把 FR-005a 要關的窗口反而拉大；
  而 150 這個數字是在賭「Chrome 的節流不會比一分鐘更慢」，那是實作細節不是規範，
  改變時不會有任何訊號 —— 用一個不會報錯的假設換另一個。
- **前端改用不受節流的訊號**（Web Worker 計時器、`visibilitychange` ＋ `sendBeacon`）——
  Chrome 對背景分頁的 Worker 計時器同樣會節流，各瀏覽器保證不一致，
  前端複雜度上升而假設沒有變可靠。

### #4 過期回收用惰性剔除，不加計時器

**決定**：不新增 `setInterval` 掃描。在 `borrowCredential()`／`hasForegroundOperator()`／
`registeredOrgIds()` 三個讀取點各自先剔除 `now - lastSeenAt > CREDENTIAL_TTL_MS` 的登記。

**理由**：這三個讀取點就是憑證登記的**全部**消費者，而且全部在輪詢路徑上
（最慢 30 秒一拍）—— 回收延遲的上界因此是 TTL ＋ 一個輪詢週期，對「不要用已登出的 token」
這個目標綽綽有餘。相對地，一支計時器就是第九份執行期狀態：要登記進
`test/contract-guards.test.ts` 的擁有權表、要在每支測試裡收拾、還要處理 `unref`。
**成本不對稱，而收益是零。**

### #5 `session.watchers` 的形狀，與 FR-004 的一致性怎麼被斷言

**決定**：`CopilotSession.watchers` 由 `string[]`（去重的 operatorId）改為
`Array<{ operatorId: string, connectionId: string }>`，每條連線一筆。
移除時只移除該 `connectionId` 那一筆；歸零才 `deleteCopilotSession()`。
`watchers` 只被 `session-manager.ts` 讀（已全 repo 確認，無前端消費者），改形狀不影響對外契約。

FR-004 的「同一件事只有一個真相」以**可執行的斷言**呈現，不只是敘述：
`watchers.length === pipelines().get(conversationId).refs` 在每次 attach／release 之後都成立。
測試以「同一客服兩條連線、兩位客服各一條、異常中斷」三組情境逐一驗這條等式。

⚠️ **`isResume` 的語意會被連帶改變**：現行 `session.watchers.length > 1` 在「同一客服開第二個分頁」
時是 `false`（因為去重），改成連線計數後會變 `true`。`session.opened` 的 `reason` 目前沒有任何
前端消費者（全 repo grep 只有型別定義與一支測試的事件清單），但**這是行為變更，MUST 明說**：
新語意是「這個對話在我 attach 之前已經有人在看」，比舊語意更接近這個欄位的字面意思。

### #6 「主動離開」與「關掉分頁」天然是兩條路，本規格 MUST NOT 把它們併起來

**決定**：不動 `leave.post.ts` 一行。

**理由**：讀過程式碼後可以確認，spec Edge Case 擔心的耦合**目前並不存在**——
主動離開的傳播完全不經過 `watchers`：
`leave.post.ts` 做的是 `removeJoinedConversation(operatorId, convId)`（**per-operator** 的持久紀錄）
＋ 廣播 `control.updated`；該客服所有分頁的面板因此一起消失（003 T032a 驗過的行為）。
而關閉分頁走的是 `stream.onClosed()` → `watchers.closeAll()` → `releasePipeline()`。
**兩條路徑在今天就是分開的**，本規格只改後者。

⚠️ 但這件事必須寫成**守衛**而不是註解：一旦有人日後為了「統一清理路徑」把 LEAVE 接到
連線計數上，SC-002a 會靜默退步。tasks 需包含一條「LEAVE 後該客服所有連線的面板同步消失」的
整合測試（現況即應通過，它守的是不退步）。

---

## US2 — 恢復時的補算

### #7 缺口的判定基準已經存在，缺的是「用在哪條路徑上」

**決定**：缺口的**篩選**沿用既有的 `newCustomerMessagesSince()`（`copilot-analysis.ts:676`）
—— 它對整條 timeline 的 `messageId` 集合做差集，正是 FR-007 要的
「以情緒時間軸涵蓋到哪裡為基準」。本規格要做的是把同一個判準接到**恢復路徑**
（`runIncremental()` 的情緒輸入）上；今天它只用在 `stream.get.ts` 的重連快照路徑。

⚠️ **`lastCoveredMessageId()` MUST NOT 被拿來當補算的抓取錨點。**
它回傳的是 timeline 的**最後**一筆（高水位），而中段批次失敗後，
後續成功的批次會把高水位推到缺口**之後** —— 以它為錨點呼叫 `fetchSince()`
就永遠取不到中段的缺口，US2 的所有任務做完仍然一則都補不到，而且不報錯。
抓取範圍見 #8 與 data-model.md §3。
（它在重連快照路徑上是對的，因為那條路徑要的正是「比高水位更新的訊息」。）

### #8 缺口的**左界**是時間軸的第一個點，不是對話的第一則訊息

**決定**：補算範圍 = 「時間軸第一個點之後、尚未涵蓋的客戶發言」，
**MUST NOT** 回頭補時間軸起點之前的訊息。

**抓取錨點因此是 `timeline[0].messageId`**（不是 `lastCoveredMessageId()`，見 #7）：

```
resolveHistory(conversationId, timeline[0]?.messageId ?? null)   // fetchSince 的錨點；timeline 為空時 null → 整批
  → newCustomerMessagesSince(state, 那批)                        // 對整條 timeline 做差集
  → 取前 18 則（＝3 批；與本輪新發言合併後才切批，新發言的批次不計入上限）
```

⚠️ **timeline 為空**（冷啟動情緒整批失敗）時錨點為 `null`，整個視窗都是缺口 ——
與 `stream.get.ts` 重連快照對 `lastCoveredMessageId() === null` 的處理相同（2026-09-02 裁定，spec FR-008）。

`timeline[0]` 本身已被涵蓋，`fetchSince()` 回傳的是它**之後**的訊息，左界天然成立。
⚠️ `fetchSince()` 的既有約定是「錨點找不到（已被擠出最近 50 則視窗）時**回傳整批**，
由呼叫端自行去重」（`server/sources/message-fetch.ts`）——
`newCustomerMessagesSince()` 對整條 timeline 去重，正好吃得下這個回傳形狀，不需額外處理。

**理由**：⚠️ 這是本組需求最容易做錯的地方。冷啟動一次只吃最近
`DEFAULT_MESSAGE_LIMIT = 50` 則（`server/sources/message-fetch.ts`），
更早的訊息是**刻意不看**的，不是缺口。若把「全量歷史 − 已涵蓋」當缺口，
一段 398 則的長對話會在第一次補算就試圖回頭補 300 多則客戶發言 ——
受 3 批上限節流後不會爆量，但會**每一輪都補一點、永遠補不完**，
於是每一次新客戶發言都額外多打 3 批 AI 呼叫，直到對話結束。
症狀是帳單變高、情緒延遲變差，而畫面上一切正常。

### #9 「有沒有缺口」用一個旗標判斷，不靠每輪撈歷史

**決定**：`CopilotAnalysisState` 頂層新增 `sentimentGap: boolean`（server-only，
位置與守衛比照 `failedBatches` —— **MUST NOT 進任何 Block、MUST NOT 進 `shared/`**）。
情緒批次失敗時設為 `true`；補算後確認已無未涵蓋發言時清為 `false`。
只有 `sentimentGap === true` 的那幾輪才去取歷史算缺口。

**理由**：FR-012 要求「無缺口時的行為與現況逐一相同，不得增加任何 AI 呼叫」。
AI 呼叫確實不會增加，但**若每輪都撈歷史，就多了一趟 HTTP 往返**——
那是每一次客戶發言都要付的成本，而絕大多數情況沒有缺口。旗標讓正常路徑完全不變。

這不違反 spec 的 Assumption「不新增『這個區塊分析到第幾批』的持久化狀態」：
它記的是**有沒有缺口**（一個布林），不是**進度到第幾批**，
因此不與 `analyzing`／`retrying`／`error` 三態機衝突，也不需要「部分完成」這第四種狀態。

**否決的替代方案**：以 `sentimentBlock.status === 'error'` 判斷 —— 不成立，
自癒成功後 status 會回到 `ready`，而缺口還在（那正是 US2 描述的情形）。

### #10 歷史從哪來：`setHistoryResolver()`，比照 `setJoinedResolver()`

**決定**：新增一個注入點，由 `copilot-runtime.ts` 在載入時把
`messageSource.fetchSince` 注入分析管線，管線端以 `resolveHistory(conversationId, anchor)` 使用。

**理由**：整條分析管線 **MUST NOT import `copilot-runtime.ts`**
（`test/contract-guards.test.ts` 守著，理由是 Nitro auto-import 會被拉進
`tsconfig.scripts.json` 的型別圖）。同一個問題在 003 已經解過一次，答案就是
`setJoinedResolver()`；本規格照抄那個形狀，不發明第二種寫法。
預設值比照既有慣例是「安全的無作用值」（回空陣列＝視為無缺口）。

### #11 補算只擴充**情緒**的輸入

**決定**：`runIncremental()` 內只有 `analyzeSentimentBatch()` 收到「新訊息 ∪ 缺口」；
`analyzeSummary()` 與 `analyzeSuggestions()` 的輸入**一個字不變**。

**理由**：⚠️ 三者的錨點語意不同，混用會靜默做錯事——
摘要的錨點是 `summaryBlock.summary.basedOnMessageId`（`catchUpSummaryIfStale()` 的註解已經
警告過「誤用對方的錨點會讓摘要漏補或誤判為最新」）；建議卡是針對「這一批」生成的，
把幾天前的舊發言塞進去會產生一批答非所問的卡。
情緒是唯一「每則發言各自一個點、缺一點就是缺一點」的區塊，也只有它有這個缺口問題。

### #12 補算的上限與 003 SC-001 的關係

**決定**：每輪最多 18 則缺口訊息（＝3 批，FR-009；操作定義是訊息數，見 spec），由**既有的**新發言觸發帶動，
**MUST NOT** 自行 `scheduleIncremental()` 續排下一輪。
補算失敗時走既有的 `finishBlockError()` → `error` ＋ 失敗批次記憶（FR-010 自動成立）。
`resolveJoined()` 的門檻在 `runIncremental()` 開頭就擋住已 LEAVE 的對話（FR-011 自動成立）。

**理由**：「補完為止」的迴圈是這裡唯一會踩爆 003 SC-001 的寫法
（AI 完全不可用時 10 分鐘內不得超過 1 輪）。改由下一次自然事件帶動，
呼叫量的上界就仍然是「客戶發言次數」，與現況同一個量級。

---

## US3 — 引用品質

### #13 封閉清單放在 `buildSuggestionPrompt()`，且刻意與量測共用同一份

**決定**：在既有 prompt 的規則段之前，加入一行**顯式列舉**：
「可用的 sopId（封閉清單，只能從中選，不得自創）：[...]」；
空集合時明示「本次沒有可用的 sopId，全部填 null」。既有的規則 ② 保留。

**理由**：現行 prompt 只在每一筆 hit 的第一行寫 `- id: xxx`，模型得自己彙整出「可選集合」；
杜撰的形狀是**憑空造一個長得像 id 的字串**（不是填錯欄位、不是截斷），與「沒有看到一份清單」
這個假設一致。這是 repo 內唯一能動的槓桿（最強的槓桿在後台的 system prompt，見 spec 的 ⚠️）。

> ⚠️ **2026-09-03：上面那個假設已被實測否決，但決定維持不變。** 封閉清單落地後以同一組
> 15 段對話重量一次，杜撰率 **21% → 21%，零改善**。攤開被擋下的字串才發現模型不是憑空造，
> 而是抄**知識庫文件內文**裡的正式 SOP 編號（`TC-XXX-NNN`）——我方交給它的 `id` 是代用碼
> （`knowledge-fallback-<hex>`），兩者是不同的東西，給它代用碼的清單並沒有回答它的問題。
> **程式碼刻意不回退**：清單零代價，而它是「模型看得到清單仍不照著填」這個結論的唯一證據。
> 完整證據與後續槓桿見 `docs/ARCHITECTURE.md` §8.2b。

⚠️ `buildSuggestionPrompt()` 是**刻意匯出給 `spike:agent-latency` 共用的同一份**
（該函式註解寫明「手抄一旦漂移，量出來的數字就不再代表正式路徑」）。
因此本次改動會同時改變量測用的 prompt 長度 —— 這是對的，但**004 的延遲基線因此不可跨改動比較**，
FR-017 的杜撰率量測要在改動前先取一次基準值。

### #14 白名單一行都不改

**決定**：`whitelistFilter()` 維持現狀（FR-014）。本規格只改「送進去的東西」。

### #15 稽核事件放 `server/utils/citation-audit.ts` —— 管線**外**，這是刻意的

**決定**：具名事件的發送模組放在 `server/utils/`，由 `blocks/suggestion.ts`（管線內部檔）import。

**理由**：拆檔守衛的方向是「**管線內部檔不得被管線外值 import**」，
反過來（管線內部檔 import 管線外的工具）從來就是允許的。把稽核模組放在管線外，
FR-017 的量測腳本才能直接 import 它的型別與解析函式 —— 若放進管線內部檔，
腳本會被守衛擋下，而唯一的繞法是從 barrel re-export，那等於把稽核塞進分析管線的對外介面。

因此本規格**不新增任何管線成員檔**，`@analysis-pipeline` 標記與擁有權表都不需要動。
（唯一要動守衛的是 #9 的 `sentimentGap`，但它是 `CopilotAnalysisState` 的欄位、
不是模組層 Map，走的是「`shared/` 不得出現」那一條，不是擁有權那一條。）

### #16 標準輸出是完整集合，額外落點是 JSONL 且開檔失敗只降級

**決定**：
- 每一次第二段落定都輸出**一行 JSON** 到標準輸出（NDJSON），欄位見
  [contracts/citation-audit-event.md](./contracts/citation-audit-event.md)。
- 額外落點以環境變數開啟，格式 **JSONL**（一行一筆）。
- 落點的**開檔／建目錄**包在 try/catch 裡，失敗時降級為「只寫標準輸出」，
  並在標準錯誤輸出留**一行**可辨識的原因（FR-015a）。

**理由**：FR-015 的第三點（完整集合 MUST 在標準輸出）與 FR-015a（要防的是開檔不是寫入）
都是 spec 從 SysTalk.Red 的實際代價反推來的，理由已寫在 spec，不在此重述。
選 JSONL 而非 JSON 陣列的理由 spec 也已列（寫壞只壞一行、寫入成本與檔案長度無關）。

⚠️ **相對路徑預設值有坑**（spec 已標）：預設值 MUST 是「不啟用」，而不是某個相對路徑 ——
dev 的 cwd 可寫會讓這個坑在開發期完全隱形，到容器裡才炸。

### #17 PII 用型別擋，不用 review 擋

**決定**：稽核事件的型別上把 `text`、`title`、`snippet` 標成 `never`
（`{ text?: never, title?: never, snippet?: never }`），讓「順手把標題記進去」在
`npm run typecheck` 就過不了。

**理由**：憲法 1.5 的違反是靜默的，而這一類「順手多記一個欄位」正是 review 最容易放過的改動。
`invalidSopIds`（杜撰的識別碼字串本身）**不是 PII** —— 它是模型憑空造的字串、不是客戶內容，
而它正是 FR-017 歸因分析的原料。這個判斷要寫進契約，否則下一個讀者會以為它漏擋了。

### #18 FR-017 的量測直接讀 #15 的事件，不另建管線

**決定**：杜撰率量測沿用 `spike:progressive` 的骨架（它已經走生產路徑的 `runColdStart()`），
新增的部分只是**收集稽核事件並聚合**：整體杜撰率、逐對話分布。

**理由**：事件在生產路徑上發出，量測腳本跑的又是生產路徑，
兩者天然是同一份資料 —— 這正是 FR-015「證據 MUST 落在生產路徑」換來的直接好處。

---

## US4 — 延遲量測與衛生

### #19 並行度掃描：env 覆寫 ＋ **每個檔位一個子行程**

**決定**：`SENTIMENT_CONCURRENCY` 改為在模組載入時讀 `process.env.SENTIMENT_CONCURRENCY`
（預設 3）。掃描腳本 `scripts/spike/26-sentiment-concurrency.ts` 對每一個檔位
**各開一個子行程**跑量測核心，三輪、輪換檔位順序、序列執行。

**理由**：⚠️ **同一個行程內無法切換並行度** —— 它是 module-level `const`，
在第一次 import 時就綁定了。若不用子行程，唯一的替代是把它改成「每次呼叫時讀」的可變值，
那會讓生產路徑多一個可被執行期改寫的旋鈕，違反本專案對這類常數的一貫處置
（見 `SENTIMENT_CHUNK_SIZE` 的「MUST NOT 有任何生產路徑改從外部覆寫它」）。
子行程把可變性完全關在量測工具那一側。

**配套守衛**：新增契約測試斷言 `.env.example`／`nuxt.config.ts` 等設定檔
**MUST NOT** 設定 `SENTIMENT_CONCURRENCY` —— 否則這個為量測開的門會在生產環境被誤用，
而症狀是「某個環境的情緒延遲莫名其妙不一樣」。

⚠️ **樣本 MUST NOT 並行取得**（FR-018a）：並行度正是被量的變數。
因此本量測沒有縮短時間的空間，實跑約 1 小時，這是規格已接受的成本。

### #20 掃描的兩列數據，spike 21 已經在記

**決定**：不新建量測核心，重用 `spike:progressive` 已經在記的
`sentimentCalls`（每次呼叫的延遲與成敗）與峰值並發。

**理由**：spike 21 的檔頭已經寫明「並行會壓低總時間但可能抬高單次延遲，
**只看總時間會看到『變快了』而完全看不到失敗率上升**，兩者必須一起看」——
FR-018 要的「兩列並陳」就是它現在的輸出形狀。26 號腳本負責的是**掃描與輪換**，不是量測本身。

### #21 `user_id` 傳的是 AI 服務的 client user id，不是客服的 operatorId

**決定**：`callAgent()` 帶上 `user_id`；該 id 由防腐層
（`server/services/imbrace.ts`）取一次並快取。

**理由**：spike 19 已確認 SDK 的 `streamChat()` 在該欄位缺席時會**先串行 await**
一次 `POST /ai-agent/chat-client/auth/user` 取 id 才打 `/v2/chat`，實測固定成本 54ms，
且該腳本已核對過多次取得的 id **一致**（快取的前提成立）。

⚠️ 這個 id 是 **AI 服務的 client user id，與客服身分無關**，因此
**不觸及憲法 1.3 的操作歸屬**（那條管的是寫入要掛在發起者身上）。
把它誤填成客服的 `operatorId` 會讓 AI 服務端的用量統計掛到錯的人身上，
而且不會有任何錯誤 —— 這一點要寫進程式碼註解。
