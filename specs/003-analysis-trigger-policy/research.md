# Phase 0 研究：分析管線的觸發與失敗政策

**Feature**: `specs/003-analysis-trigger-policy` ｜ **Date**: 2026-08-28

> 本規格不是新功能，是**對既有機制裡三處判斷錯誤的修正**（spec.md「缺陷背景」的機制鏈 ②③④）。
> 因此本文件的重點不在「選哪個技術方案」，而在「修在哪一層才不會製造第二個平行機制」——
> 憲法 2.2 的判準（改動應只落在原本就該負責的那一層）在此是主要的取捨依據。
>
> spec.md 的 Clarifications 已消除全部 NEEDS CLARIFICATION，本階段無待解問題。

---

## 現況機制鏈（追過程式碼後的定位）

四個環節各自都「照設計運作」，錯的是它們串起來之後的整體行為：

| # | 位置 | 現況 | 問題 |
|---|---|---|---|
| ① | `app/composables/useConversationView.ts:321` | `HEARTBEAT_MS` 每 20 秒 `beat()` 一次 | 正確，presence 本來就靠心跳 + TTL |
| ② | `server/api/presence.post.ts` | 一律 publish 一則 `watch` 控制訊息 | 正確，它無從得知「這次和上次一不一樣」 |
| ③ | `server/utils/stream-control.ts:102` `watch()` | **一律**先解除舊訂閱、再 `attach()` | ⚠️ 根因。心跳與真實變化走同一條路 |
| ④ | `server/api/stream.get.ts:113` `attach()` | 帶副作用：`sendAnalysisSnapshotAndResume()`＋前景時 `catchUpSummaryIfStale()` | ⚠️ 副作用本身沒錯，錯在它被每 20 秒呼叫一次 |
| ⑤ | `server/services/copilot-analysis.ts:585` `runIncremental()` | 門檻是 `if (!state) return` | ⚠️ 「有沒有分析狀態」不等於「有沒有人 JOIN」；且失敗時 `timeline` 不推進，同一批永遠是「未涵蓋」 |

---

## 決策 1：心跳去重修在 `createWatchRegistry`，不修在 presence 或 attach

**Decision**：`createWatchRegistry`（`server/utils/stream-control.ts`）為每個 conversationId 額外記住
上一次的 `{ priority, joined }`。`watch()` 收到與上次**完全相同**的組合時直接 return，不解除訂閱、
不重新 `attach()`、不送快照、不補跑。任一值不同時走既有路徑（解除舊的 → 以新值 `attach()`）。

**Rationale**：

- 這正是該註冊表存在的理由——它是整條鏈上**唯一知道「這條連線目前在監看什麼、以什麼參數」**的地方。
  修在這裡，FR-001 與 FR-002 是同一行判斷的兩面，不需要新增任何狀態容器。
- 它已經是純函式化、可被 vitest 直接 import 的模組（`stream.get.ts` 因 Nitro auto-import 測不到），
  新規則因此天生可測——這也是 002 當初把它抽出來的動機。
- 既有的兩條硬規則不受影響，且**恰好被同一個判斷涵蓋**：
  - 「優先度升級 MUST NOT 略過」（`stream-control.ts:79` 的 ②）→ background→foreground 是 `priority`
    改變，屬「有變化」，照常 attach。
  - 重連復原（`restoreJoined()`）→ 新連線的註冊表是空的，首次一定算「有變化」。**但 `restoreJoined()`
    也必須寫入這份記錄**，否則它掛上的對話會在下一次心跳被誤判為「首次」而重跑一次。

**Alternatives considered**：

| 方案 | 否決理由 |
|---|---|
| 在 `presence.post.ts` 判斷「和上次心跳一樣就不發控制訊息」 | server 端的這支 API 是無狀態的；要判斷就得另存一份「上次心跳」狀態，那份狀態與註冊表**必然重複且會不同步** |
| 在 `attach()` 裡判斷「已經 attach 過就不送快照」 | `watch()` 已經先把舊訂閱解除了，走到 `attach()` 時資訊已遺失。且會讓 `attach()` 同時承擔「掛載」與「判斷要不要掛載」兩件事 |
| 把 `sendAnalysisSnapshotAndResume()` 的補跑拿掉，只留快照 | 會直接違反 001 FR-010 與 002 US4 AC#5（FR-003、FR-004 明文要求兩者維持不變）。且問題不是「補跑」，是「每 20 秒補跑一次」 |
| 拉長 `HEARTBEAT_MS` | 治標。presence 的 TTL（45 秒）依賴這個頻率，改了會讓同事的 presence 變得遲鈍，而重跑仍然存在，只是變慢 |

---

## 決策 2：失敗批次記憶放在 `CopilotAnalysisState` 的**新頂層欄位**，不放進三個 Block

**Decision**：`CopilotAnalysisState` 新增 `failedBatches?: Partial<Record<AnalysisBlock, FailedBatch>>`，
與 `summaryBlock`／`sentimentBlock`／`suggestionBlock` 平行。`FailedBatch = { lastMessageId, at, count }`。

**Rationale**：

- spec.md Assumptions 要求「**不改對外契約**：不新增推播事件欄位」。而 SSE 的三個事件送的正是
  `state.summaryBlock` 等**整個 block**（`publishBlock()`，`copilot-analysis.ts:140`）——
  失敗批次記憶若放進 block 內，它會自動流到瀏覽器，等於默默改了契約，且是那種型別檢查抓不到的改法。
- 放在頂層則完全不進 SSE：`CopilotAnalysisState` 本身是 server-only 型別（`server/state/types.ts:97`），
  前端從不接觸它。**這是本規格唯一一個「放錯位置就會靜默違反 Assumptions」的決策，因此明文記錄。**
- 生命週期需求（FR-011：跟隨既有分析狀態、不另訂保存期限）自動成立——它就在同一筆記錄裡，
  隨 2 小時 sliding TTL 一起消失。「失敗批次記憶存活期間對話一直沒有新發言，直到分析狀態過期」這個
  edge case 因此不需要任何額外程式碼。

**判定鍵為何是「區塊 ＋ 該批最後一則訊息 id」**（FR-005）：這是 spec.md Clarifications 已定案的
自癒機制的支點——客戶再說一句話 → 批次的最後一則變了 → 不再是同一批 → FR-007 自動再試一次。
用「訊息 id 集合的雜湊」會更精確，但沒有換到任何東西：批次一律是時間上連續的尾段，最後一則
不同就代表這是新的一批。

**Alternatives considered**：

| 方案 | 否決理由 |
|---|---|
| 放進各 Block（`SummaryBlock.failedBatch`） | 見上：會經 SSE 外流，違反「不改契約」 |
| 用既有的 `firstFailureAt` 當失敗批次記憶 | 它是**單輪重試序列**的起點（001 FR-014 的 40 秒預算用），語意是「這一輪從何時開始失敗」，不是「哪一批失敗過」。挪用它會讓兩個 FR 綁死在同一欄位上 |
| 讓 `sentimentBlock.timeline` 在失敗時也推進（塞一個 failed marker） | 那正是根因 ④ 的鏡像——把「已分析過」與「試過但失敗」混為一談。timeline 是要畫給人看的資料，塞入失敗標記會污染 sparkline 與 `computeStats()` |

---

## 決策 3：「這個對話還有沒有人 JOIN」重用 `aggregateState()`，新增 `MessageSource.isJoined()`

**Decision**：`MessageSource` 介面新增 `isJoined(conversationId): boolean`，
`PollingMessageSource` 的實作直接回傳 `this.aggregateState(entry).joined`；無訂閱者時回傳 `false`（安全預設）。
`runIncremental()` 的門檻由 `if (!state) return` 改為 `if (!state) return` **＋** `if (!isJoined) return`。

**Rationale**：

- `aggregateState()`（`polling-message-source.ts:220`）**早就在算 `joined`**，只是目前僅用於決定輪詢頻率。
  spec.md Clarifications 明文要求「沿用既有的監看聚合結果，不新增反向索引」——這就是那份聚合。
- 它天生是**對話層級**的（跑過該對話所有訂閱者），因此 FR-014（同事仍 JOIN 時我的 LEAVE 不停止分析）
  與 US2 AC#4 不需要額外邏輯，是同一個聚合的自然結果。
- 與既有的 `getPriority()`（`polling-message-source.ts:160`）形狀完全對稱——同一份聚合的另一個欄位，
  同樣的「無訂閱者時回安全預設」約定。新增的是一個 getter，不是一套機制。
- 憲法 2.2 檢核：`MessageSource` 是我方自己的 provider 介面（憲法 2.1 表列），新增方法只需同步
  `polling-message-source.ts` 與測試替身，M4 換 webhook 實作時照樣要回答這個問題。不是邊界劃錯。

**⚠️ 已知限制（spec.md 已列，非本決策造成）**：這個聚合只涵蓋**我方系統內**的 JOIN。同事若直接在
iMBrace 官方介面 JOIN，我方的訂閱者清單裡沒有他，分析會停止。`docs/ARCHITECTURE.md` §10.2 已確認
平台回傳的 `users[]` 是團隊名冊而非對話參與者，M4 的 webhook payload 到位前無解。

---

## 決策 4：LEAVE 的 5 秒門檻由既有的「LEAVE 後立即補一次心跳」承接，不新增停止通道

**Decision**：不在 `leave.post.ts` 新增控制通道訊息。既有的
`useConversationView.ts` `leave()` 在拿到回應後立刻 `detail.viewerJoined = false` 並 `await beat('viewing')`，
該次 presence 會帶 `joined: false` → `watch(convId, 'foreground', false)` → 依決策 1 這是**真實變化**
→ 重新 attach → 該連線的訂閱者 `joined` 變 false → 決策 3 的聚合隨之翻轉。全程一次往返，遠低於 5 秒（SC-002）。

**Rationale**：LEAVE 已經有一條會立刻走完的路徑，只是目前終點（`runIncremental` 的門檻）看錯了東西。
修好門檻，這條路徑自動生效。另開一條「LEAVE 專用的停止通道」會讓「分析要不要跑」有兩個真相來源，
而那正是根因 ④ 的形狀。

**FR-013「MUST 清除尚未執行、等待中的分析排程」怎麼滿足**：兩層，缺一不可——

1. **保證層（正確性）**：`runIncremental()` 在 debounce **觸發的當下**檢查 `isJoined()`。這涵蓋所有路徑
   （心跳補跑、`onMessages` 增量、背景名額釋出後的重排），且判斷的是排程觸發時的真實狀態，不是排入時的。
2. **清理層（字面要求）**：新增 `cancelPendingAnalysis(conversationId)`，在聚合 `joined` 由 true 翻為 false
   的那一刻呼叫，`clearTimeout()` 並刪除 `debounceTimers` 條目。

只做 2 不做 1 會漏（背景名額滿時 `runIncremental` 會自己重新 `scheduleIncremental()`，那是清理之後才排的）；
只做 1 不做 2 行為正確但留著一個空轉的計時器。

**Edge case「分析執行到一半時 LEAVE」**（spec.md 明列）：兩層都只擋「排入新的」，不中止已在飛的呼叫——
`runIncremental()` 的門檻在進入點，已進入者跑完並照常寫入狀態。這與 spec.md Assumptions
「執行中的分析不中斷」一致，不需要額外處理。

---

## 決策 5：FR-009 的併發去重用 per-(對話, 區塊) 的 in-flight ＋ pending 旗標

**Decision**：`copilot-analysis.ts` 內新增
`inFlight = new Map<`${convId}:${block}`, Promise<void>>` 與 `rerunPending = new Set<同鍵>`。
區塊分析入口先查 `inFlight`：有的話設 `rerunPending` 後 return；沒有的話執行，`finally` 時若
`rerunPending` 有標記則清除並再跑一次。

**Rationale**：

- 既有的 `stateLocks`（`copilot-analysis.ts:121`）保護的是**狀態寫入**不互相覆蓋，粒度是整個對話，
  而且它會把兩份分析**依序都跑完**——不是去重。兩者解決的是不同問題，不可合併。
- 粒度必須是「對話 ＋ 區塊」而非整個對話：三個區塊本來就是 `Promise.all` 併行的（`runColdStart()`、
  `runIncremental()`），用對話粒度會把它們串成序列，直接拖慢 SC-001 的 3 秒／10 秒門檻。
- 「後到的觸發合併為跑完後再執行一次」（FR-009 明文，MUST NOT 直接丟棄）→ 旗標而非佇列：
  合併語意是「至少再跑一次最新的」，累積 N 次觸發就跑 N 次沒有意義。
- 這同時吸收了 spec.md edge case「『全部重試』往返期間另一個分頁也按了同一區塊的重試」，
  也正是「不做樂觀 disable」（決策 7）能夠成立的前提。

**⚠️ 與失敗批次記憶的互動順序**：`rerun` 那一次仍要重新過一次 FR-006 的失敗批次記憶檢查——否則「失敗 →
期間又被觸發 → rerun 無視記憶再跑一次」會在錯誤狀態上多出一輪呼叫，把 SC-001 的「不超過 1 輪」打破。

---

## 決策 6：未 JOIN 時**整欄隱藏面板**，而不是保留內容加凍結標示

> ⚠️ **本決策於 2026-08-28 取代原方案。** 原方案是「保留但凍結 ＋ 兩種文案標示」，
> 已隨 spec.md 的 Clarifications 一併推翻。保留這段說明是因為推翻的理由本身是設計依據。

**Decision**：客服未 JOIN 該對話時，右側 Copilot 面板**整欄不呈現**（FR-016），中欄延伸至可用寬度；
且伺服器 **MUST NOT** 把該對話的三個分析事件推給這條連線（FR-016a）。JOIN 時面板自動展開並提供
收合按鈕（FR-017），收合狀態以「每位客服、每個對話」為粒度存 `localStorage`（FR-017a）。

**Rationale**：

- **原方案在一個必然會出現的情境下會說謊。** FR-017（舊）要求 LEAVE 後標示「已凍結」，
  US2 AC#4 要求同事仍 JOIN 時分析照常繼續——兩者的交集（我 LEAVE、同事還在）下，內容其實正在
  客服眼前變動，畫面卻宣稱它凍結了。那正是原方案自己最想避免的**靜默地說錯話**，只是方向相反。
  我曾試圖用「兩種文案」修補（真凍結／已離開但仍在更新），但那是用文案繞過矛盾，
  不是消除矛盾——而且第二種文案在「同事從官方介面 JOIN」時仍然會判錯（決策 3 的已知限制）。
- **隱藏讓「可見 ⟺ 即時」成為恆真命題**（SC-006 的新形式）。客服不再需要分辨畫面上的東西新不新——
  看得到就是新的。這比任何標示都可靠，因為它不依賴客服讀到那行小字。
- **面板的存在理由是服務「正在處理這個對話的人」**。沒有 JOIN 就沒有這個身分，
  這與 001 FR-001（JOIN 後才產生摘要）、002 FR-025（知識庫快查的 JOIN 門檻）是同一條界線，
  本決策只是把它延伸到可見性上，不是新立規則。
- **原方案的立論並未落空**。它的理由是「客服 LEAVE 後常需要回頭看摘要寫交接紀錄」——
  那個需求由**結案摘要**承接（FR-020～FR-022）：客服想留下紀錄就按「結案」，
  那條路徑會產生可編輯的摘要並在確認後寫入；「離開對話」則是單純退出。
  兩個出口分開之後，原本要靠凍結面板勉強承接的需求有了正確的歸屬。

**為何伺服器端也要過濾（FR-016a），而不是只在前端不渲染**：只在前端隱藏的話，
分析結果仍會持續推到這條連線並更新前端 store——重新 JOIN 或切換時可能閃出一份「不知何時來的」內容，
而且違反「畫面上不存在的東西不該持續佔用推播頻寬」的直覺。過濾點在
`server/api/stream.get.ts` 的 `forward()`：它本來就是「依收訊者自己的身分決定送什麼」的那一層
（目前已在為 presence 做同樣的事）。

**MUST NOT 一併過濾的事件**：`messages.appended`、`presence.updated`、`control.updated`、
`conversation.updated`、`stream.heartbeat`。那些服務的是中欄，與 JOIN 無關——
US2 AC#3 明文要求中欄一切照常。過濾範圍**恰為**三個分析事件
（`summary.updated`／`sentiment.updated`／`suggestion.updated`）。

**判斷資料從哪來**：`forward()` 需要知道「這條連線對這個對話有沒有 JOIN」——
那正是決策 1 為了心跳去重必須在 `createWatchRegistry` 裡新增的 `joined` 欄位（data-model.md §2）。
**同一份新狀態同時餵兩個需求，不另立第二份真相來源。**

**Alternatives considered**：

| 方案 | 否決理由 |
|---|---|
| 保留但凍結 ＋ 單一文案 | 同事仍 JOIN 時必然說謊（見上） |
| 保留但凍結 ＋ 兩種文案 | 用文案繞過矛盾而非消除；且第二種文案在官方介面 JOIN 時仍會判錯 |
| 只在前端隱藏、伺服器照推 | 推播浪費，且會留下「隱藏期間偷偷更新的 store」，切換時可能閃出舊內容 |
| 面板改為變灰／空狀態／骨架 | 仍然佔位，且骨架會讓客服以為正在載入而空等——FR-016 明文禁止 |

**⚠️ 已知代價（spec.md「已知限制」已載明）**：LEAVE 之後先前的摘要與建議卡就看不到了
（伺服器端仍存活 2 小時，重新 JOIN 即可看到，但畫面上不再呈現）。這是刻意換來的——
需要離開後回顧的人，正確的出口是「結案」。

---

## 決策 7：「全部重試」純前端，對每個 error 區塊各發一次既有端點

**Decision**：`useCopilotSession` 新增 `retryAll()`，對 `status === 'error'` 的區塊各發一次既有的
`POST /api/conversations/:id/copilot/retry`。不新增端點、不改請求／回應形狀。按鈕的
`disabled` 條件為「三個區塊都不是 `error`」。**不做樂觀 disable**。

**Rationale**：spec.md Assumptions 已定案（「目前沒有效能問題需要靠合併請求解決，改契約的代價大於收益」）。
三個並行的 POST 對 BFF 是可忽略的負載，而合併端點會多一份請求形狀要維護與測試。
不做樂觀 disable 的對價由決策 5 的併發去重承擔——重複按下不會跑兩份分析。

**FR-019 明文要求「各區塊自身的重試按鈕 MUST NOT 為了『全部重試』另加互鎖邏輯」**：既有規則
（僅 `error` 可按）已足夠——按下後區塊立刻轉 `analyzing`，按鈕由狀態自然失效。這也順帶涵蓋
「同事在另一個分頁按了重試」。

---

## 決策 8：失敗批次記憶的解除點共三處，且 `beginAnalyzing()` **不是**其中之一

> ⚠️ **2026-08-28 implement 階段的用詞訂正**：本節原標題與內文寫的是「清除點」。實作後三處只有
> **「分析成功」是真的刪除整筆**，另外兩處（手動重試 FR-008、冷啟動 FR-015）改為把 `released`
> 旗標設為 `true` —— 直接刪除會讓 `count`（累計失敗次數）永遠是 1 而變成死欄位。
> 本節其餘推論完全不受影響：三處的**時機**與「`beginAnalyzing()` 不是其中之一」的理由一字未變。
> 設計與理由見 data-model.md §1「為何是放行而不是刪除」。

**Decision**：清除 `failedBatches[block]` 的時機恰為三處：

| 時機 | 對應 FR | 位置 |
|---|---|---|
| 手動重試該區塊 | FR-008 | `retryBlock()` |
| 冷啟動（含重新 JOIN） | FR-015 | `runColdStart()` |
| 該區塊分析成功 | 隱含（成功即無需記憶） | 各 `finish*Success` 路徑 |

**Rationale / 反例**：直覺上會想寫在 `beginAnalyzing()`（「開始分析就清掉」），但那會讓 FR-006 完全失效——
`beginAnalyzing()` 是每次分析的共同入口，包含被記憶擋下之前就已排入的那些。記憶必須在**決定要不要跑**
之前被讀到，並且只在「有理由相信這次會不一樣」時才清。三處清除點對應的正是三個這樣的理由。

---

## 對既有驗收的回歸風險（SC-005）

| 既有驗收 | 受本規格影響的路徑 | 為何仍成立 |
|---|---|---|
| 001 FR-010 重連快照 2 秒門檻 | 決策 1 改了 `watch()` | 新連線註冊表為空 → 首次必算「有變化」→ 快照照送 |
| 002 US4 AC#5 切回前景補跑摘要 | 決策 1 | background→foreground 屬 `priority` 變化 → 照常 attach 並補跑 |
| 002 FR-019～FR-021 背景分析與節流 | 決策 3、5 | 背景對話仍是 JOIN 中 → `isJoined()` 為 true，不受新門檻影響 |
| 001 FR-014 單輪重試預算 | 未觸及 | 本規格只處理「那一輪用盡之後」的政策（spec.md Assumptions 明文） |
| `npm run smoke:realtime` 的 4 秒門檻 | 決策 1 | 訊息推播不經 `attach()` 的副作用路徑，僅經 topic 訂閱 |

⚠️ `test/stream-reconnect-background.test.ts` 與 `test/presence-away-joined.test.ts` 直接測
`createWatchRegistry` 與 `resolvePresenceControl`，是決策 1 最可能撞到的兩份測試——
必須確認它們驗的是「重連復原」與「away+joined 不 unwatch」，**而非**「每次 watch 都重新 attach」。
