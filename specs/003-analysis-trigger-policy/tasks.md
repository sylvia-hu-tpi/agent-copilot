---

description: "分析管線的觸發與失敗政策 —— 實作任務清單"
---

# Tasks: 分析管線的觸發與失敗政策

**Input**: Design documents from `/specs/003-analysis-trigger-policy/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、
[data-model.md](./data-model.md)、[contracts/analysis-trigger-contract.md](./contracts/analysis-trigger-contract.md)、
[quickstart.md](./quickstart.md)

**Tests**: 包含。本專案既有慣例即為 vitest 單元 + 對假 gateway 的整合測試，且本規格修的三處
**全部是「靜默失效」型缺陷**（不報錯、無型別錯誤，只是安靜地做錯事）——沒有測試就沒有任何東西
守得住這些不變式。plan.md 的 Testing 一節已列出對應的測試檔。

**Organization**: 依 user story 分組，每個 story 可獨立實作與驗證。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行執行（不同檔案、無未完成的相依）
- **[Story]**: 對應的 user story（US1～US4）
- 每項任務都標出確切檔案路徑

## Path Conventions

單一 Nuxt 應用內建 Nitro BFF：`app/`（前端）／`server/`（BFF）／`shared/`（共用型別）／
`test/`（vitest）／`i18n/locales/`（文案）。本規格**不新增任何目錄或分層**。

---

## ⚠️ 動工前必讀

1. **`shared/` 不得出現 `failedBatches`**（契約 1.1）。SSE 送的是整個 Block，
   失敗記錄放進 Block 就等於默默改契約，而型別檢查抓不到。
2. **`WatchRegistration.joined` 是唯一真相來源**（契約不變式 C）。心跳去重（US1）與推播過濾（US2）
   共用同一份，**MUST NOT** 另立第二份「這條連線 JOIN 了哪些對話」的記錄。
3. **`test/stream-reconnect-background.test.ts` 與 `test/presence-away-joined.test.ts` 會被撞到**。
   動 T016 之前先讀它們，確認斷言驗的是「重連復原」與「away+joined 不 unwatch」，
   而不是「每次 watch 都重新 attach」——若是後者，那個斷言本身就是缺陷的一部分。

---

## Phase 1: Setup（型別與文案骨架）

**Purpose**: 先把型別與文案鍵位落地，讓後續任務不必互相等待

- [ ] T001 [P] 在 `server/state/types.ts` 新增 `FailedBatch` 介面（`lastMessageId` / `at` / `count`）與 `CopilotAnalysisState.failedBatches?: Partial<Record<AnalysisBlock, FailedBatch>>`，並加註「MUST 留在頂層、MUST NOT 併入任一 Block」的理由（data-model.md §1）
- [ ] T002 [P] 在 `server/sources/types.ts` 的 `MessageSource` 介面新增 `isJoined(conversationId: string): boolean`，註解註明「無訂閱者時回傳 false（安全預設）」與「只答得出我方系統內的 JOIN」（契約第三部分）
- [ ] T003 [P] 在 `i18n/locales/zh-TW.json` 的 `copilot` 與 `conversation` 區塊新增本規格文案：面板收合／展開、「全部重試」、「離開對話」、「結案」及其輔助說明（「離開＝僅退出不寫入・結案＝產生摘要供確認後寫入」）、未接手時的 Composer 提示（憲法 8.5）
- [ ] T004 在 `test/component-names.test.ts` 加入結構性守衛：斷言 `shared/` 底下不存在 `failedBatches` 字串（契約 1.1 的可執行版本，取代人工 grep）

---

## Phase 2: Foundational（阻斷性前置，所有 story 都依賴）

**⚠️ CRITICAL**: 這一階段完成前，任何 user story 都無法開始

- [ ] T005 在 `server/sources/polling-message-source.ts` 實作 `isJoined()`，直接回傳 `this.aggregateState(entry).joined`；無 entry 時回傳 `false`。與既有 `getPriority()` 並列擺放，兩者共用同一份 `aggregateState()`（research.md 決策 3）
- [ ] T006 [P] 在 `test/message-source.test.ts` 補上 `isJoined()` 的單元測試：無訂閱者 → `false`；單一訂閱者 `joined: true` → `true`；兩位訂閱者其一 `joined: false` → 仍為 `true`（對話層級聚合，FR-014）；全部退訂後 → `false`
- [ ] T007 在 `server/utils/stream-control.ts` 把 `createWatchRegistry` 的 `watched` 由 `Map<string, () => void>` 改為 `Map<string, WatchRegistration>`（`{ off, priority, joined }`，data-model.md §2）。**本任務只改資料結構，不改判斷邏輯** —— 讓 T016 與 T028 能各自獨立進行
- [ ] T008 在 `server/utils/stream-control.ts` 的 `restoreJoined()` 中一併寫入 `{ priority: 'background', joined: true }`。⚠️ 漏掉這行的症狀：復原的對話會在 20 秒後的第一次心跳被誤判為「首次」而重跑一輪（契約不變式 A）
- [ ] T009 在 `server/utils/stream-control.ts` 匯出 `isWatchedAsJoined(conversationId): boolean`（讀 `WatchRegistration.joined`），供 T028 的推播過濾使用 —— 明確標註這是不變式 C 的唯一資料來源
- [ ] T010 [P] 在 `server/services/copilot-analysis.ts` 新增失敗記憶的三個純存取函式：`readFailedBatch(state, block)`、`markFailedBatch(state, block, lastMessageId)`、`clearFailedBatch(state, block)`，並匯出供測試直接引用（data-model.md §1）
- [ ] T011 [P] 在 `server/services/copilot-analysis.ts` 新增 `analysisInFlight: Map` 與 `analysisRerunPending: Set`（鍵為 `${conversationId}:${block}`）及包裹函式 `runBlockDeduped(conversationId, block, fn)`。⚠️ 粒度 MUST 為「對話＋區塊」，MUST NOT 與既有 `stateLocks` 合併（data-model.md §3）

**Checkpoint**: 型別、聚合、註冊表結構與兩個 helper 就緒，四個 user story 可平行展開

---

## Phase 3: User Story 1 - AI 中斷時系統停止無止境重跑（Priority: P1）🎯 MVP

**Goal**: 服務中斷期間不再每 20 秒重跑完整分析。同一批訊息在同一區塊失敗過就不再自動重試。

**Independent Test**: 注入 AI 故障 → JOIN 一個有客戶發言的對話 → 靜置 10 分鐘 → 統計分析嘗試次數
不超過 1 輪（quickstart.md US1-A）。不依賴 LEAVE 行為或「全部重試」。

### Tests for User Story 1 ⚠️

> 先寫測試並確認會失敗，再進實作

- [ ] T012 [P] [US1] 新增 `test/stream-control-heartbeat.test.ts`：相同 `{priority, joined}` 重複 `watch()` → `attach` 只被呼叫一次；`priority` 改變 → 再次 attach；`joined` 改變 → 再次 attach；首次 watch → attach；`unwatch()` 後再 `watch()` → 視為首次而 attach（契約不變式 A 的完整表格）
- [ ] T013 [P] [US1] 新增 `test/analysis-failure-memory.test.ts`：同一 `(區塊, 最後一則訊息 id)` 失敗後再次觸發 → 不執行；`retryBlock()` 後 → 執行；`runColdStart()` 後 → 執行；成功後記憶被清除；**`beginAnalyzing()` MUST NOT 清除記憶**（data-model.md §1 的反例）
- [ ] T014 [P] [US1] 在 `test/copilot-analysis.test.ts` 補上 FR-009 併發去重：同區塊連續觸發三次 → 只執行兩次（當次 + 一次合併的 rerun）；**rerun 那次仍會過失敗記憶檢查**（data-model.md §3 第 3 點）
- [ ] T015 [US1] 新增對假 gateway 的整合測試（`test/` 下，沿用 `test/mock-gateway.ts`）：AI 端點恆回 500 → JOIN → 模擬 30 次心跳（不使用真實計時）→ 斷言分析嘗試總數 ≤ 1 輪（SC-001 的自動化版本）

### Implementation for User Story 1

- [ ] T016 [US1] 在 `server/utils/stream-control.ts` 的 `watch()` 實作心跳去重：`prev.priority === priority && prev.joined === joined` 時直接 return，不解舊訂閱、不 `attach()`；否則走既有路徑並寫入新記錄（FR-001、FR-002，research.md 決策 1）
- [ ] T017 [US1] 在 `server/services/copilot-analysis.ts` 的 `finishBlockError()` 新增第四個參數 `batchLastMessageId: string | null`，失敗時寫入失敗記憶；為 `null` 時不寫入（沒有可判定的批次，寧可下次再試也不要用假的鍵擋住未來的分析，data-model.md §1）
- [ ] T018 [US1] 在 `server/services/copilot-analysis.ts` 的三個分析入口（`analyzeSummary` / `analyzeSentimentBatch` / `analyzeSuggestions`）算出該批的 `lastMessageId` 並向下傳給 `finishBlockError()`；同時在 `beginAnalyzing()` **之前**加入失敗記憶檢查，命中則直接 return（FR-005、FR-006）
- [ ] T019 [US1] 在 `server/services/copilot-analysis.ts` 用 T011 的 `runBlockDeduped()` 包住三個分析入口，實作 FR-009 的合併與 rerun；rerun 前 MUST 重新讀一次失敗記憶
- [ ] T020 [US1] 在 `server/services/copilot-analysis.ts` 的 `retryBlock()` 開頭清除該區塊的失敗記憶（FR-008），在 `runColdStart()` 開頭清除全部三個區塊的失敗記憶（FR-015）
- [ ] T021 [US1] 全檔搜尋確認**沒有**任何自動退避重試的計時器或「X 秒後自動重試」文案（FR-010）；若既有程式碼有殘留，一併移除並在 commit 說明

**Checkpoint**: US1 可獨立驗收 —— 注入故障、靜置 10 分鐘、統計呼叫次數

---

## Phase 4: User Story 2 - LEAVE 後分析停止、Copilot 面板隱藏（Priority: P1）

**Goal**: 按下離開／結案後不再產生任何新分析，右側面板整欄消失，中欄完全不受影響。

**Independent Test**: JOIN → 等分析完成 → 按下離開 → 觀察後續無新分析、面板整欄消失、
中欄訊息流與草稿照常（quickstart.md US2-A／US2-B）。不依賴故障情境。

### Tests for User Story 2 ⚠️

- [ ] T022 [P] [US2] 新增 `test/analysis-join-boundary.test.ts`：`runIncremental()` 在 `isJoined() === false` 時不執行；`true` 時照常；兩位客服其一 LEAVE 後仍為 `true`（FR-012、FR-014）；`cancelPendingAnalysis()` 清除既有 debounce 計時器（FR-013）
- [ ] T023 [P] [US2] 新增 `test/stream-analysis-visibility.test.ts`：未 JOIN 的連線收不到 `summary.updated`／`sentiment.updated`／`suggestion.updated`；**仍收得到** `messages.appended`／`presence.updated`／`control.updated`／`conversation.updated`／`stream.heartbeat`（契約不變式 C 的完整清單，FR-016a）
- [ ] T024 [P] [US2] 新增 `test/copilot-panel-collapse.test.ts`：可見性判定 = `viewerJoined`（**MUST NOT** 由 Block 是否 `empty` 推出）；收合偏好以 `ac.copilotCollapsed.${conversationId}` 為鍵、per 對話各自記；未存過時預設展開（FR-016、FR-017a）

### Implementation for User Story 2

- [ ] T025 [US2] 在 `server/services/copilot-analysis.ts` 的 `runIncremental()` 把門檻由 `if (!state) return` 改為同時檢查 `isJoined()`；⚠️ 檢查點在 debounce **觸發的當下**，不是排入時（FR-012，research.md 決策 4 的保證層）
- [ ] T026 [US2] 在 `server/services/copilot-analysis.ts` 匯出 `cancelPendingAnalysis(conversationId)`（`clearTimeout` 並刪除 `debounceTimers` 條目），並在聚合 `joined` 由 true 翻為 false 的時點呼叫（FR-013 的清理層，data-model.md §4）
- [ ] T027 [US2] 在 `server/api/stream.get.ts` 的 `sendAnalysisSnapshotAndResume()` 讓補跑（`runIncremental`）一併受 `isJoined()` 門檻約束；⚠️ **快照本身照送**（001 FR-010 的重連快照不得退步）
- [ ] T028 [US2] 在 `server/api/stream.get.ts` 的 `forward()` 加入分析事件過濾：以 T009 的 `isWatchedAsJoined()` 判斷，未 JOIN 時丟棄三個分析事件、其餘一律照送（FR-016a）。⚠️ 過濾 `stream.heartbeat` 會直接斷線 —— 清單以契約不變式 C 的表格為準
- [ ] T029 [P] [US2] 新增 `app/composables/useCopilotPanel.ts`：暴露 `visible`（= `viewerJoined`）與 `collapsed`（讀寫 `localStorage` 的 `ac.copilotCollapsed.${conversationId}`，per 對話、預設展開），並在對話切換時重讀（FR-016、FR-017、FR-017a）
- [ ] T030 [P] [US2] 新增 `app/components/copilot/PanelHeader.vue`：COPILOT 標題列 ＋ 收合按鈕（須可鍵盤操作，憲法 8.2）；「全部重試」的位置一併預留給 US4，本任務先不接行為
- [ ] T031 [US2] 在 `app/pages/c/[conversationId].vue` 以 `v-if` 讓整欄面板在未 JOIN 時**不渲染**（含分隔拖曳把手），中欄延伸至可用寬度；收合態改渲染窄直條（對照 `docs/wireframe/03-workspace_toggleCopilot.png`）。⚠️ MUST NOT 用變灰／空狀態／骨架代替（FR-016）。**同檔順手修正**：`copilotWidth` 預設值由 `ref(380)` 改為 `ref(420)` —— 畫布已於 2026-08-28 統一為 420px（`docs/DESIGN_TOKENS.md` §7.1），拖曳範圍 320–520 不變，僅影響首次開啟的預設寬度
- [ ] T032 [US2] 在 `app/pages/c/[conversationId].vue` 與 `app/composables/useConversationView.ts` 把單一的「加入對話／離開」toggle 改為設計稿的兩態：未 JOIN → 「接手對話」＋下拉（`manual`／`hybrid` 兩選項，文案寫出後果而非模式名稱）；已 JOIN → 「離開對話」（次要）＋「結案」（primary）＋輔助說明（FR-020、SC-007，對照 `docs/wireframe/03-workspace_assignment02.png` 與 `03-workspace_lightTheme.png`）
- [ ] T033 [US2] 讓「結案」暫時等同「離開對話」＋停止分析＋隱藏面板，但 MUST 實作為**獨立的程式碼路徑**（自己的 handler，不是 `leave()` 的別名或參數值，FR-022a）。在該處寫下 M3 銜接註解，內容須涵蓋：① 結案流程屬 M3，插入點在「停止分析」與「隱藏面板」之間；② MUST NOT 直接串上自動寫入（憲法 5.1）；③ M3 落地後結案期間分析**照常執行**（FR-023），現在的「停止分析」是階段性行為，不是要保留的語意
- [ ] T034 [US2] 驗證憲法 8.4：LEAVE → 面板消失 → Composer 草稿仍在。若面板隱藏連帶重建了頁面元件而清掉草稿，改為只卸載面板子樹

**Checkpoint**: US1 與 US2 皆可獨立驗收

---

## Phase 5: User Story 3 - 客戶再次發言時自動恢復（Priority: P2）

**Goal**: 服務恢復後，只要客戶再說一句話，面板就自己回到正常內容，客服零手動操作。

**Independent Test**: 注入故障 → 失敗 → 解除故障 → 注入一則新客戶發言 → 驗證自動恢復
（quickstart.md US3）。這是「不做自動退避重試」能夠成立的唯一前提。

### Tests for User Story 3 ⚠️

- [ ] T035 [P] [US3] 在 `test/analysis-failure-memory.test.ts` 補上自癒路徑：同一區塊失敗後，出現新的客戶發言（批次的最後一則改變）→ **自動**再嘗試一次（FR-007）；服務仍未恢復時 → 最多再一輪後回到錯誤狀態，MUST NOT 進入週期性重跑（US3 AC#2）

### Implementation for User Story 3

- [ ] T036 [US3] 確認 T018 的失敗記憶檢查是以「該批**最後一則**訊息 id」比對而非對話層級或時間窗 —— 這是自癒的支點，寫成其他鍵會讓 US3 完全失效（data-model.md §1）
- [ ] T037 [US3] 依 quickstart.md US3 手動走一次完整路徑（注入故障 → 解除 → 新發言 → 自動恢復），確認過程中零手動操作（SC-003）

**Checkpoint**: 失敗政策的取捨（不加第二層退避）在真實路徑上成立

---

## Phase 6: User Story 4 - 一次重試所有失敗的區塊（Priority: P3）

**Goal**: 三個區塊同時失敗時，一次操作即可重試全部。

**Independent Test**: 讓三個區塊同時進入錯誤狀態 → 按下「全部重試」→ 三個都開始重新分析
（quickstart.md US4）。純體驗改善，不影響正確性。

### Tests for User Story 4 ⚠️

- [ ] T038 [P] [US4] 在 `test/copilot-panel-collapse.test.ts` 補上「全部重試」的判定：只對 `status === 'error'` 的區塊發出請求；無任何 error 時按鈕為不可按；已成功的區塊 MUST NOT 被重跑（FR-018）

### Implementation for User Story 4

- [ ] T039 [US4] 在 `app/composables/useCopilotSession.ts` 新增 `retryAll()`：對每個 `error` 區塊各發一次既有的 `POST /api/conversations/:id/copilot/retry`。⚠️ MUST NOT 新增 `retry-all` 端點或讓 `block` 接受陣列（契約 1.2）
- [ ] T040 [US4] 在 `app/components/copilot/PanelHeader.vue` 接上「全部重試」按鈕：`disabled` 條件為「三個區塊都不是 `error`」，須可鍵盤操作（憲法 8.2）。**刻意不做樂觀 disable** —— 往返期間按鈕仍可按是預期行為，重複按由 FR-009 吸收（FR-019、research.md 決策 7）
- [ ] T041 [US4] 確認各區塊自身的重試按鈕**未被加上任何互鎖邏輯**（FR-019）—— 既有的「僅 error 可按」規則已足夠，按下後區塊轉 `analyzing` 會讓按鈕自然失效

**Checkpoint**: 四個 user story 全部可獨立驗收

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T042 執行 `npm run typecheck && npm test`
- [ ] T043 執行 `npm run build && npm run smoke`（本規格動到 `server/api/**` 與 `server/sources/**`，smoke 為必跑）
- [ ] T044 擴充 `test/realtime-http.ts`／`npm run smoke:realtime`：新增「LEAVE 後 5 秒內不再有分析事件」（SC-002）與「未 JOIN 的連線收不到分析事件」（FR-016a）兩個斷言
- [ ] T045 [P] 依 quickstart.md 逐項完成回歸驗收（SC-005）：001 重連快照 2 秒門檻、002 US4 AC#5 切回補跑摘要、002 背景分析與節流、smoke 的 4 秒門檻、憲法 8.4 草稿不遺失
- [ ] T046 [P] 更新 `docs/ARCHITECTURE.md` §11.1 觸發策略表 —— 補上「presence 心跳不觸發分析」與「失敗批次不自動重跑」兩條
- [ ] T047 [P] 核對 `docs/ARCHITECTURE.md` §15 的降級行為敘述 —— 修正後實作才真正符合其承諾（「顯示錯誤狀態＋提供手動重試」），確認兩者一致
- [ ] T048 [P] 核對 `docs/ARCHITECTURE.md` §18 的 M2 驗收清單是否需納入 SC-001／SC-002
- [ ] T049 執行 `CLAUDE.md` 要求的舊說法掃描：`grep -rn "保留但凍結\|凍結標示" docs/ specs/`、`grep -rn "每 20 秒\|無限重試\|3,780" docs/`、`grep -rn "自動重試" docs/ARCHITECTURE.md`。⚠️ **這一步是本專案最常犯、代價最高的錯誤，掃到第三輪為止**
- [ ] T050 [P] 確認 `docs/IMBRACE_QUESTIONS.md` G-2（rate limit 書面規格）**不撤回** —— 本規格大幅降低呼叫量使該題急迫性下降，但問題本身仍未獲答覆
- [ ] T051 [P] 核對 `docs/DESIGN_TOKENS.md` 是否需為面板收合態與兩個離開出口新增 token
- [ ] T052 依 quickstart.md 完成人工驗收：US1-A 靜置 10 分鐘統計、US2-B 面板消失逐項清單、US2-C 兩瀏覽器（含用 EventStream 確認未 JOIN 端真的收不到）、SC-007 找一位未參與本規格的同事讀文案
- [ ] T053 [P] 把 spec.md「待修憲事項」（憲法 5.3 的主鍵改為 uuid、冪等鍵改為草稿 id）登記為獨立待辦 —— **MUST NOT 在本規格內修憲**（MAJOR 變更，B.4 建議在里程碑交界進行）。確認該筆待辦在 003 收尾後仍然可見，不隨本規格結案而遺失

---

## 附錄：M3 結案流程的定案（本規格不實作，僅承接）

> 這些是 003 的釐清過程中一併定案的 M3 行為。寫在這裡是為了讓 M3 開工時不必重新推導，
> 也讓 003 的 T033 知道自己要留成什麼形狀。完整理由見 spec.md 的
> 「Session 2026-08-28 補充」與「待修憲事項」。
>
> **視覺依據**（四張，索引與判讀重點見 `docs/DESIGN_TOKENS.md`「1c 的狀態變體」）：
> `docs/wireframe/03-workspace_close.png`（結案中）、`_close_abstractExpired.png`（摘要過期）、
> `_close_writing.png`（寫入中）、`_close_colleaguePerspective.png`（同事視角）、
> `_close_logoutFailed.png`（寫入成功但 LEAVE 失敗）。

| 主題 | 定案 |
|---|---|
| 摘要的輸入 | **按下結案那一刻的對話快照**；之後的新訊息不進摘要，除非按「重新產生」（＝重新取一次快照） |
| Composer | **不鎖**。改為上方常駐橫幅「結案中——摘要不含此後的新訊息；要送出訊息請先取消結案」 |
| 服務模式 | **鎖住（唯讀）並附提示**。與 Composer 的區別：3.1 保護的是「還能看對話、還能回覆」，服務模式是設定項，不在其保護標的內 |
| 新訊息抵達 | 摘要區塊顯示「對話有新內容，建議重新產生」（與常駐橫幅是兩件不同的事） |
| 結案狀態的生命週期 | **只活在該瀏覽器分頁內**。重新整理／登出 = 取消結案。取消是純前端回退，無資料需清理 |
| 未完成的提醒 | 左側清單標記「有未完成的結案」，**分頁內提醒**。⚠️ MUST NOT 做倒數自動寫入（違反憲法 5.1） |
| 取消結案 | 需有明確按鈕。按下「一鍵寫入 CRM」後 MUST 立即 disable 取消鈕（請求已送出，非樂觀 disable） |
| 寫入與 LEAVE 的順序 | **先寫入、後 LEAVE**。寫入成功即視為結案成功；LEAVE 失敗 MUST 顯示可重試提示，MUST NOT 回退結案 |
| 兩人同時結案 | 不阻擋。presence 顯示「XXX 正在結案」；第二位寫入時 SHOULD 提示前一筆的存在 |
| 分析行為 | 結案期間**照常執行**（FR-023），分析門檻維持單一條件 |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**：無相依，可立即開始
- **Phase 2 Foundational**：依賴 Phase 1 —— **阻斷所有 user story**
- **Phase 3～6 User Stories**：皆依賴 Phase 2；之後可平行或依 P1 → P1 → P2 → P3 順序進行
- **Phase 7 Polish**：依賴所有欲交付的 story 完成

### User Story Dependencies

- **US1（P1）**：Phase 2 之後即可開始，不依賴其他 story ← **MVP**
- **US2（P1）**：Phase 2 之後即可開始。與 US1 共用 `WatchRegistration`（T007）但兩者改的是不同判斷式，可平行
- **US3（P2）**：**依賴 US1 的 T018**（失敗記憶的比對鍵就是自癒的支點）。US1 完成前無法驗證
- **US4（P3）**：**依賴 US2 的 T030**（`PanelHeader.vue` 是按鈕的容器）。其餘獨立

### 跨 story 的共用檔案（不可平行）

| 檔案 | 涉及任務 | 說明 |
|---|---|---|
| `server/utils/stream-control.ts` | T007 → T008 → T009、T016 | T007 先改結構，其餘才能接續 |
| `server/services/copilot-analysis.ts` | T010、T011、T017～T021、T025、T026 | 同一檔案，**MUST 依序** |
| `server/api/stream.get.ts` | T027、T028 | 同一檔案，依序 |
| `app/pages/c/[conversationId].vue` | T031、T032 | 同一檔案，依序 |
| `app/components/copilot/PanelHeader.vue` | T030（US2）→ T040（US4） | T030 先建立容器 |
| `test/copilot-panel-collapse.test.ts` | T024（US2）→ T038（US4） | T024 先建立檔案 |
| `test/analysis-failure-memory.test.ts` | T013（US1）→ T035（US3） | T013 先建立檔案 |

### Parallel Opportunities

- Phase 1 的 T001／T002／T003 三個檔案互不相干，可完全平行
- Phase 2 的 T006 與 T010／T011 可平行（不同檔案）
- Phase 3 的測試 T012／T013／T014 皆為不同檔案，可平行撰寫
- Phase 4 的測試 T022／T023／T024 皆為新檔，可平行撰寫
- Phase 4 的 T029／T030 為兩個新前端檔案，可平行
- Phase 7 的文件任務 T045～T048、T050、T051 皆可平行

---

## Parallel Example: User Story 1

```bash
# 三份測試檔互不相干，可同時撰寫（先確認會失敗）：
Task: "T012 test/stream-control-heartbeat.test.ts —— 心跳去重的完整表格"
Task: "T013 test/analysis-failure-memory.test.ts —— 失敗記憶與三個清除點"
Task: "T014 test/copilot-analysis.test.ts —— FR-009 併發去重與 rerun"

# 實作階段：T017～T021 全在 copilot-analysis.ts，MUST 依序，不可平行
```

---

## Implementation Strategy

### MVP First（US1）

1. Phase 1 Setup → Phase 2 Foundational
2. Phase 3 US1
3. **停下來驗收**：注入故障、靜置 10 分鐘、統計呼叫次數（SC-001）
4. 這一步就止住了 2026-08-27 的出血 —— 即使後面全部不做，也已交付本規格的主要價值

### Incremental Delivery

1. Setup + Foundational → 基礎就緒
2. US1 → 獨立驗收 → **止血完成（MVP）**
3. US2 → 獨立驗收 → LEAVE 語意修正 ＋ 面板可見性
4. US3 → 獨立驗收 → 自癒路徑成立，US1 的取捨得到支撐
5. US4 → 獨立驗收 → 體驗改善
6. Phase 7 → 回歸、文件同步、人工驗收

⚠️ **US3 排在 US2 之後但價值上緊接 US1**：它是「不做自動退避重試」這個決策的前提。
若時程被壓縮而必須取捨，寧可延後 US4，不要延後 US3 —— 沒有 US3，US1 的止血會變成
「故障後面板永遠是紅的」。

---

## Notes

- `[P]` = 不同檔案、無相依
- `[Story]` 標籤讓每項任務可追溯到 spec.md 的 user story
- 每完成一項就在本檔打勾 `[x]`，每個 Phase 收尾用 `/commit-split` 分類建立 commit
  （`CLAUDE.md` 的 `/speckit-implement` 例外條款）
- **提交前至少 `npm run typecheck && npm test`**；動到 `server/api/**`、`server/sources/**` 時一併 `npm run smoke`
- ⚠️ 本規格的三個缺陷都不會報錯。**測試綠燈不代表缺陷已修好** —— T052 的人工驗收不可省略
