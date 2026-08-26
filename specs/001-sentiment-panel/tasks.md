---

description: "Task list for 情緒面板（摘要卡與情緒 Sparkline）"
---

# Tasks: 情緒面板（摘要卡與情緒 Sparkline）

**Input**: Design documents from `/specs/001-sentiment-panel/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 使用者已明確指定 plan.md 定案的三個測試檔（`test/ai-retry-policy.test.ts`、`test/sentiment-attachment-turn.test.ts`、`test/copilot-analysis.test.ts`）需產生對應測試任務——本清單納入這三份測試檔的建立與擴充任務，映射到各自對應的使用者故事階段。

**Organization**: 依 spec.md 的使用者故事分組（User Story 1／2／3），依 spec.md 列出的順序排列（P1、P2、P1）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可平行執行（不同檔案、彼此無依賴）
- **[Story]**：對應 spec.md 的 US1／US2／US3
- 每個任務皆含明確檔案路徑

## Path Conventions

沿用專案既有單一 Nuxt 應用三層結構（plan.md「Structure Decision」）：`shared/types/`（共用型別）、`server/`（Nitro BFF）、`app/`（前端）、`test/`（Vitest）。所有路徑皆為 repo 根目錄相對路徑。

---

## Phase 1: Setup

**Purpose**：確認基準狀態，本功能不需新增任何 npm 依賴（plan.md：情緒 sparkline 手刻 SVG，不引圖表庫；其餘皆沿用既有 Nuxt/Vue/Pinia/Zod/Vitest 技術棧）。

- [x] T001 於分支 `001-sentiment-panel` 執行 `npm run typecheck && npm test`，確認基準全綠後再開始（無程式碼變更）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**：三個使用者故事共用的型別、狀態擴充與分析管線骨架

**⚠️ CRITICAL**：本階段完成前不得開始任何使用者故事的任務

- [x] T002 於 `shared/types/copilot.ts`（新檔）定義 `AnalysisBlockStatus`、`ConversationSummary`、`SentimentPoint`、`SentimentMarker`、`SentimentTimelineEntry`、`SummaryBlock`、`SentimentBlock`、`isSentimentAlert()`、`isSentimentAlerting()`（2026-08-26 新增，FR-003 示警解除遲滯規則，見 data-model.md）、`AIProvider` 介面（`summarize`、`analyzeSentiment`），依 [data-model.md](./data-model.md) 逐一落地
- [x] T003 於 `shared/types/events.ts` 的 `CopilotEvent` 聯集新增 `summary.updated` 與 `sentiment.updated` 兩個成員，依 [contracts/copilot-sse-events.md](./contracts/copilot-sse-events.md)（依賴 T002）
- [x] T004 於 `server/state/types.ts` 新增 `CopilotAnalysisState` 介面（`conversationId`、`summaryBlock: SummaryBlock`、`sentimentBlock: SentimentBlock`、`lastAnalysisTriggerAt?: number`）與 `StateStore.getAnalysisState()`／`setAnalysisState(s, ttlMs)` 方法宣告；**不修改既有 `CopilotSession` 介面**——兩者生命週期各自獨立，見 data-model.md「2026-08-26 訂正」（依賴 T002）
- [x] T004b 於 `server/state/memory-store.ts` 實作 `getAnalysisState`／`setAnalysisState`：比照既有 `presence` 的 `Expiring<T>` 雙軌淘汰模式（讀取時惰性淘汰＋定期掃除），sliding TTL 2 小時，每次讀寫皆續期（依賴 T004）
- [x] ~~T005~~ **已併入 T010**（2026-08-26 訂正）：原「於 `upsertSession()` 初始化 `summaryBlock`／`sentimentBlock`」不再適用——那是 `CopilotSession`（輪詢／去重用途）的建立點，與分析狀態的建立時機（首次有可分析內容時）不同，混在一起會讓兩者生命週期重新耦合。初始化邏輯改寫入 T010 的 `runColdStart()` 首段（見下方 T010 新增的步驟 ⓪）
- [x] T006 [P] 於 `server/services/ai/retry-policy.ts`（新檔）實作 `classifyFailure(error): 'transient' | 'rate-limited' | 'permanent'` 與 `withRetry(fn, opts)`：僅 `'transient'` 進入重試迴圈（退避 1s → 4s、至多 2 次、單次呼叫逾時 15 秒、自首次失敗起算總預算 40 秒）；`'rate-limited'`（429）與 `'permanent'` 皆 0 次重試直接轉 `error`。`withRetry()` 的進度回呼／回傳值 MUST 附帶首次失敗的時間戳，供呼叫端（T010）寫入 `SummaryBlock.firstFailureAt`／`SentimentBlock.firstFailureAt`（2026-08-26 新增，CHK036，供前端／測試驗證 40 秒預算是否過期）。數值以 spec.md FR-014 為唯一權威來源，依 [research.md](./research.md) #2
- [x] T007 [P] 於 `server/services/ai/mock-ai-provider.ts`（新檔）實作 `MockAIProvider`（`summarize`、`analyzeSentiment` 回傳固定樣本資料，並支援測試用的失敗開關），依 `ARCHITECTURE.md` §8.2b（依賴 T002）
- [x] T008 [P] 於 `server/services/ai/schemas.ts`（新檔）以 Zod 定義 `ConversationSummary`／`SentimentPoint` 的驗證 schema（憲法 4.2），依 [data-model.md](./data-model.md)「驗證規則」（依賴 T002）
- [x] T009 於 `server/services/ai/index.ts`（新檔）實作 `useAIProvider()` 裝配點，回傳 `MockAIProvider` 實例（比照 `KnowledgeProvider` 裝配模式，憲法 2.1／2.2）（依賴 T006、T007）
- [x] T010 於 `server/services/copilot-analysis.ts`（新檔）實作核心分析協調：`runColdStart(conversationId, history)` 與 `runIncremental(conversationId, previousSummary, newCustomerMessages)`，內部共用邏輯依序為：⓪ 若該對話尚無 `CopilotAnalysisState`（`getAnalysisState()` 回 `null`），先初始化 `summaryBlock`／`sentimentBlock` 為 `{ status: 'empty', ... }` 並寫入（原 T005，已併入本任務，見上）① **（2026-08-26 新增，由 `/speckit-analyze` 發現缺口）** 在呼叫 `AIProvider` 之前，先將本次要重算的區塊（摘要／情緒各自獨立判斷）`status` 設為 `'analyzing'`（若原本是 `'ready'`，依 data-model.md「呈現規則」保留舊內容不清空）、寫回 `CopilotAnalysisState`，並立即 `publish` 對應的 `summary.updated`／`sentiment.updated` 事件——此步驟 MUST 先於下方②的 AI 呼叫執行且不等待其完成，否則 SC-001「90% 情況 3 秒內看到分析中」與 FR-011「MUST NOT 等到全部內容就緒才顯示區塊」在 AI 呼叫耗時 5～12.2 秒（`ARCHITECTURE.md` §17）的情況下無法成立，也會與 [contracts/copilot-sse-events.md](./contracts/copilot-sse-events.md) 明訂的「`analyzing` 事件立即送出（先於分析完成）」矛盾 ② 過濾純附件（無文字）客戶發言為 `SentimentMarker`（FR-002、FR-012，不送模型；判別依據為 `Message.text === ''`——⚠️ 此判別式僅在本功能範圍內成立，見 data-model.md SentimentMarker 驗證規則的 M3 附註，M3 實作附件文字化時 MUST 重新檢查）③ 經 `withRetry()` 呼叫 `AIProvider` ④ 經 T008 的 Zod schema 驗證輸出（憲法 4.2）⑤ 依全量 `timeline`（不受最近 50 點顯示上限影響）重新計算 `sentimentBlock.stats.lowestScore`／`lowestAt`（FR-015，避免統計值只涵蓋近期畫面範圍而安靜算錯）⑥ 寫回 `CopilotAnalysisState`（`setAnalysisState()`，依賴 T004、T004b；**不是** `CopilotSession`，兩者是不同物件，見 data-model.md「2026-08-26 訂正」）；轉為 `retrying`／`error` 時寫入 `withRetry()`（T006）回報的 `firstFailureAt`，轉為 `ready` 時清空該欄位（2026-08-26 新增，CHK036）⑦ 透過 `useEventBus().publish(conversationTopic(id), ...)` 送出最終結果的 `summary.updated`／`sentiment.updated`（依賴 T003）；錯誤記錄僅留 `conversationId` 與失敗分類，不得輸出訊息全文或 `drivers`（憲法 1.5，research.md #6）（依賴 T004、T004b、T006、T007、T008、T009）
- [x] T010c **（2026-08-26 新增，由 `/speckit-analyze` 發現 FR-010 缺口）** 於 `server/api/stream.get.ts` 的 `attach()` 補上摘要／情緒的重連快照：比照既有『watch 一個對話時立刻送一次 `control.updated`／`presence.updated` 目前狀態，不必等下一次變動』的模式（見該函式現有註解），若 `getAnalysisState(conversationId)` 非 `null`，立即 `send()` 目前的 `summary.updated`／`sentiment.updated`——這是 FR-010「客服切回對話時，系統 MUST 立即顯示已保留的結果」唯一的送達路徑：資料雖已獨立存在 `CopilotAnalysisState`（T004、T004b）不受客服切走影響，但目前設計是純 SSE 推播、只在狀態變動時發事件，若離開期間沒有新客戶發言就不會有任何事件，重新連線的前端會永遠拿不到已保留的結果。送出快照後，比對 `summaryBlock.summary.basedOnMessageId`／`sentimentBlock.timeline` 已涵蓋的訊息與該對話目前最新的客戶訊息，若離開期間累積了新的客戶發言，非同步觸發一次 `runIncremental()` 補跑（沿用 T010 既有路徑，不另開分支），補跑期間該區塊依 T010 步驟①轉為 `analyzing` 並保留舊內容（FR-010「補跑期間 MUST 明確標示內容正在更新」）；此次補跑視同一次全新的 `runIncremental()` 呼叫，擁有自己獨立的一份 FR-014 重試預算（最多 2 次、40 秒），不延續、不合併離開前尚未用完的重試次數（2026-08-26 定案 CHK034，維持實作簡單，不需跨『離開期間』持久化重試計數）（依賴 T003、T004b、T010）

**Checkpoint**：型別、狀態擴充、AIProvider 裝配、分析管線骨架、重連快照就緒，可平行展開三個使用者故事

---

## Phase 3: User Story 1 - JOIN 後立即掌握對話全貌 (Priority: P1) 🎯 MVP

**Goal**：客服 JOIN 對話後，短時間內看到涵蓋歷史的摘要卡與情緒 sparkline；無客戶發言的對話顯示明確的「尚無資料」狀態；純附件輪不產生分數點但仍在時間軸上以中性標記呈現

**Independent Test**：JOIN 一段已有多輪客戶／AI 往來的對話，驗證摘要卡內容對應歷史、情緒 sparkline 點數對應含文字的客戶發言輪數、純附件輪呈現為中性標記；不依賴建議卡等其他功能

### Tests for User Story 1 ⚠️

> **先寫測試，確認失敗後才開始實作**

- [x] T011 [P] [US1] 於 `test/sentiment-attachment-turn.test.ts`（新檔）驗證：純附件（無文字）客戶發言 MUST NOT 產生 `SentimentPoint`、MUST 產生 `SentimentMarker` 並出現在 `timeline` 中不消失、`SentimentMarker` 不參與示警判定（FR-002、FR-012，對應 `copilot-analysis.ts` 的過濾邏輯）
- [x] T012 [P] [US1] 於 `test/copilot-analysis.test.ts`（新檔）驗證：`runColdStart()` 送給 `AIProvider.summarize()`／`analyzeSentiment()` 的輸入涵蓋完整對話歷史、無客戶發言時兩區塊狀態為 `'empty'`、AI 輸出格式不符 Zod schema 時該次分析轉為 `error` 狀態而非讓格式外資料進入系統（憲法 4.2，FR-001、FR-002、FR-009）；**（2026-08-26 新增）** 以 mock `AIProvider` 刻意延遲回應，斷言 `summary.updated`／`sentiment.updated` 的 `status: 'analyzing'` 事件在 `AIProvider.summarize()`／`analyzeSentiment()` 的 Promise resolve **之前**已發布（對應 T010 步驟①、FR-011、SC-001）

### Implementation for User Story 1

- [x] T013 [P] [US1] 於 `server/api/conversations/[id]/join.post.ts` 的 JOIN 成功後，若該對話尚無 `CopilotAnalysisState` 或其 `summaryBlock`／`sentimentBlock` 仍為 `'empty'`，以 `fetchLatest()`（`server/sources/message-fetch.ts`）取得歷史並非同步觸發 `runColdStart()`（T010），不等待其完成才回應（依賴 T010）
- [x] T014 [P] [US1] 於 `app/composables/useCopilotSession.ts`（新檔）實作 composable：訂閱 `useStreamStore()`（`app/stores/stream.ts`）解析出的 `CopilotEvent`，過濾 `summary.updated`／`sentiment.updated` 且 `conversationId` 相符者，暴露 reactive 的 `summary: Ref<SummaryBlock>`、`sentiment: Ref<SentimentBlock>`（依賴 T003）
- [x] T015 [P] [US1] 於 `app/components/copilot/SummaryCard.vue`（新檔）依 `SummaryBlock.status` 呈現 `empty`／`analyzing`／`ready` 三種狀態，`ready` 時顯示 `intent`／`keyFacts`／`attempted`／`openIssues`（FR-001、FR-009、FR-011 漸進呈現），並顯示 `riskFlags`（風險徽章列，`riskFlags` 為空陣列時不顯示徽章列本身，而非顯示空的徽章列容器）與 `advice`（一句話行動建議文字區塊）——2026-08-26 訂正：`ConversationSummary` 型別已含這兩個欄位（`data-model.md`），本次確認納入 UI 呈現範圍（FR-001）
- [x] T016 [P] [US1] 於 `app/components/copilot/SentimentGauge.vue`（新檔）依 `ARCHITECTURE.md` §14.5 手刻 SVG polyline 繪製 `timeline` 中最近 50 個 `SentimentPoint`（FR-015），`SentimentMarker` 於時間軸上以可辨識中性圖示呈現（FR-012），依 `SentimentBlock.status` 呈現 `empty`／`analyzing`／`ready` 三種狀態
- [x] T017 [US1] 於 `app/pages/c/[conversationId].vue` 掛載 `useCopilotSession` 並將 `SummaryCard`／`SentimentGauge` 置入右欄（依賴 T014、T015、T016）

**Checkpoint**：User Story 1 可獨立測試——JOIN 對話後面板正確顯示歷史摘要與情緒走勢

---

## Phase 4: User Story 2 - 對話持續進行時面板保持更新 (Priority: P2)

**Goal**：客戶新發言以增量方式更新面板（不重送完整歷史給模型）；客服自己送出的訊息不觸發重新分析；情緒轉為挫折／生氣時主動示警（顏色＋圖示＋文字）

**Independent Test**：在已 JOIN 的對話中新增一則客戶發言，驗證面板更新且模型輸入為 patch（既有摘要＋新訊息，非全量歷史）；客服自己送出回覆不觸發重新分析；情緒轉差至「挫折」或「生氣」時示警三者並呈

### Tests for User Story 2 ⚠️

- [x] T018 [US2] 擴充 `test/copilot-analysis.test.ts`：驗證 `runIncremental()` 的模型輸入僅含既有摘要與新增客戶訊息、MUST NOT 含完整歷史（FR-004）；新增 1 秒 debounce 聚合多筆客戶發言為單次分析；客服（`sender.type === 'agent'`）送出的訊息不觸發 `runIncremental()`（FR-005）；**（2026-08-26 新增）** `ready → analyzing` 的轉移比照 T012，斷言 `analyzing` 事件於呼叫 `AIProvider` 前已發布，且前端可據此於補跑期間疊加「更新中」提示而不清空舊內容（data-model.md「呈現規則」）；**（2026-08-26 新增）** 直接單元測試 `isSentimentAlerting(timeline)`（T002）的遲滯規則：`[...,'frustrated']` → `true`；`[...,'frustrated','neutral']` → `false`；`[...,'frustrated','concerned']` → 仍為 `true`（未回到 calm／neutral 前不解除，FR-003 2026-08-26 修訂）；`SentimentMarker` 混雜在 timeline 中不影響判定（依賴 T012 既有測試基底）

### Implementation for User Story 2

- [x] T019 [US2] 於 `server/services/session-manager.ts` 的 `onMessages()` 內，過濾 `messages` 中 `sender.type === 'customer'` 者，以 `conversationId` 為鍵 debounce 1 秒（`ARCHITECTURE.md` §11.1）後呼叫 `runIncremental()`（T010），無客戶發言時不觸發（依賴 T010、T018）
- [x] T020 [P] [US2] 於 `app/components/copilot/SentimentGauge.vue` 依 `isSentimentAlerting(timeline)`（T002，2026-08-26 修訂——**不是**只看最新一點的 `isSentimentAlert(label)`，那會被批次中一則語氣稍緩的訊息誤導清除示警）判斷本次是否示警，以顏色＋圖示＋文字標籤三者並呈方式主動示警（FR-003、憲法 8.1，依賴 T016）；示警文字標籤加 `aria-live="polite"`，顏色對比符合 WCAG AA 4.5:1；解除示警需最新一筆評分點回升至「擔憂」以下（`isSentimentAlerting()` 已內建此遲滯規則），歷史評分點的標記不受影響（FR-003 2026-08-26 修訂）。**動工前 MUST 先核對 Claude Design 畫布上 `CopilotPanel` 元件的現行版本**（不得只憑 `DESIGN_TOKENS.md` §7.2 的肉眼讀圖描述），確認具體圖示、文案措辭、示警呈現在單點或區塊層級；若畫布內容與 `DESIGN_TOKENS.md` 描述或本任務假設有落差，MUST 先與相關人員釐清再動工（見 spec.md FR-003 2026-08-26 修訂、Notes 一節）

**Checkpoint**：User Story 1 與 2 皆可獨立運作——新訊息即時更新面板，且未觸發不必要的全量重算

---

## Phase 5: User Story 3 - AI 分析故障時仍能正常對話 (Priority: P1)

**Goal**：摘要或情緒分析失敗時，僅該區塊顯示錯誤與重試選項；訊息流與 Composer 完全不受影響；暫時性失敗自動退避重試（至多 2 次、40 秒預算），429／非暫時性失敗與重試用盡後可手動重試

**Independent Test**：模擬 `AIProvider` 呼叫失敗，驗證僅失敗區塊顯示錯誤、另一區塊與訊息流／Composer 正常可用；驗證自動重試的退避時序與次數上限；呼叫 `POST .../copilot/retry` 驗證僅重跑指定區塊

### Tests for User Story 3 ⚠️

- [x] T021 [P] [US3] 於 `test/ai-retry-policy.test.ts`（新檔）以假時鐘（`vi.useFakeTimers()`）驗證 `classifyFailure()`：單次呼叫逾時／5xx → `'transient'`；429 → `'rate-limited'`；401／請求無效／Zod 驗證失敗／未列舉錯誤 → `'permanent'`。並驗證 `withRetry()`：`'transient'` 走 1s → 4s 兩次重試、`'rate-limited'` 與 `'permanent'` 皆 0 次重試、單次呼叫逾 15 秒視為失敗、自首次失敗起算逾 40 秒預算即停止轉 `error`、`retryAttempt` 正確回報（FR-014）
- [x] T022 [P] [US3] 擴充 `test/copilot-analysis.test.ts`：驗證 `summaryBlock` 分析失敗不影響 `sentimentBlock`（反之亦然）、狀態依序轉移 `analyzing → retrying → error`、`error` 狀態下透過重試進入點可重新觸發該區塊且不影響另一區塊已顯示內容（FR-006、FR-008）

### Implementation for User Story 3

- [x] T023 [US3] 於 `server/api/conversations/[id]/copilot/retry.post.ts`（新檔）依 [contracts/copilot-retry-api.md](./contracts/copilot-retry-api.md) 實作：驗證 `block ∈ {'summary','sentiment'}`、目標區塊非 `'error'` 時回 409、否則非同步觸發對應區塊重新分析並回 202（依賴 T010）
- [x] T024 [US3] 於 `app/composables/useCopilotSession.ts` 新增 `retry(block: 'summary' | 'sentiment')` 方法，呼叫 T023 端點（依賴 T014、T023）
- [x] T025 [P] [US3] 於 `app/components/copilot/SummaryCard.vue` 新增 `error` 狀態的錯誤訊息與可鍵盤操作的重試按鈕（憲法 8.2），以及 `retrying` 狀態的「重試中 (n/2)」進度顯示（不需額外倒數秒數，2026-08-26 定案 CHK030）——FR-014 的進度可視要求對兩個區塊同等適用，不得只有 `SentimentGauge`（T026）有；`analyzing`／`retrying` 期間重試按鈕 MUST 維持可見但停用（`disabled`，非隱藏——2026-08-26 定案 CHK033），不額外加冷卻節流（既有 409 已足夠防止重疊觸發，2026-08-26 定案 CHK032）；呼叫 `retry('summary')`（依賴 T015、T024）
- [x] T026 [P] [US3] 於 `app/components/copilot/SentimentGauge.vue` 新增 `error` 狀態的錯誤訊息與可鍵盤操作的重試按鈕，`retrying` 狀態顯示「重試中 (n/2)」進度（FR-014）；`analyzing`／`retrying` 期間重試按鈕 MUST 維持可見但停用、不額外加冷卻節流（同 T025，2026-08-26 定案 CHK032／CHK033）；呼叫 `retry('sentiment')`（依賴 T016、T024）
- [x] T027 [US3] 擴充 `test/realtime-http.ts` 的驗收情境，涵蓋三類斷言（2026-08-26 訂正：原描述僅涵蓋第一類，plan.md Testing 一節承諾的 `summary.updated`／`sentiment.updated` 事件收斂缺任務落實；2026-08-26 再訂正：新增第③類，`/speckit-analyze` 發現 FR-010 重連快照缺測試覆蓋）：① 模擬摘要／情緒分析故障或重試進行中時，斷言送出訊息（`POST /api/messages`）仍成功且不被延遲阻擋（SC-002）；② 兩位客服同時開啟 SSE 連線 JOIN 同一對話，觸發一次分析完成，斷言兩條連線皆在合理時間內各自收到對應的 `summary.updated`／`sentiment.updated` 事件（事件收斂，對應 plan.md Testing 承諾）；③ 客服 JOIN 對話並等到分析完成為 `ready` 後斷開 SSE 連線（unwatch），期間不產生新客戶訊息，重新建立連線並 watch 同一對話，斷言**立即**（不必等待任何新事件）收到一次涵蓋既有結果的 `summary.updated`／`sentiment.updated`（FR-010，對應 T010c）（依賴 T010、T010c、T019、T023）

**Checkpoint**：三個使用者故事皆可獨立驗證——AI 故障時面板降級但主線不受影響，客服可手動重試

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**：跨故事的收尾項目

- [x] T028 [P] 於 `i18n/locales/zh-TW.json` 補齊情緒面板文案（empty／analyzing／retrying／error／重試按鈕／情緒示警標籤），憲法 8.5
- [x] T029 [P] 更新 `docs/ARCHITECTURE.md` §11.5 的 `SentimentPoint` 型別範例以反映 `kind` 判別欄位與 `SentimentMarker` 的新增（data-model.md 附註），並 grep 確認無其他文件仍引用舊形狀（`CLAUDE.md` 正典修改後的必要動作）
- [x] T030 依 [quickstart.md](./quickstart.md) 手動走完三個情境的驗證步驟
  > ⚠️ **2026-08-26 記錄**（實作 session 無瀏覽器存取，本項由使用者親自操作完成）：
  >
  > 使用者已在真實 `IMBRACE_ENV=stable` 環境親自操作並回報兩個問題，皆已定位、修復、
  > 補上迴歸測試並重新驗證全綠（見下方「已由使用者操作發現並修復」）。之後使用者也已
  > 親自確認情境一的「尚無資料」狀態與冷啟動後單次 `analyzing → ready`（不再重複）行為。
  >
  > **情境一**：✅ 冷啟動、10 秒內內容就緒、情緒點數對應客戶發言輪數、empty 狀態、
  > 純附件輪的中性標記（迴紋針圖示正確出現在時間軸底部），皆已由使用者在真實對話
  > 中實機確認。⚠️ 注意：`MockAIProvider` 對所有評分點固定回傳 `score: 70`，且
  > `SentimentGauge.vue` 不畫個別評分點的圓點記號，因此走勢圖恆為水平直線——這是
  > 預期行為，不代表折線邏輯有問題；純附件輪的驗證訊號是「有沒有出現迴紋針標記」，
  > 不是「折線有沒有轉折」。
  >
  > **情境二／三的示警與故障/重試 UI**：❌ **目前的開發環境驗不到**——`MockAIProvider`
  > 永遠回傳 `label: 'neutral'` 且不會失敗，正式的 `npm run dev` 流程沒有觸發故障或
  > 負面情緒的手段（故障開關只存在於 vitest 的建構子參數注入，未暴露給執行中的 dev
  > server）。已徵詢使用者是否要另外加開發用觸發機制（環境變數／debug 端點），
  > **使用者決定不加，改以既有自動化測試作為這幾項的驗收依據**：
  > - 示警三者並呈與遲滯規則（`isSentimentAlerting()`）→ `test/copilot-analysis.test.ts`、
  >   `test/sentiment-attachment-turn.test.ts`
  > - 故障分類、退避時序、重試進度 → `test/ai-retry-policy.test.ts`
  > - 故障隔離（一區塊失敗不影響另一區塊）、手動重試 → `test/copilot-analysis.test.ts`
  >
  > 代價：`SentimentGauge.vue`／`SummaryCard.vue` 的 `error`／`retrying` 狀態與情緒示警
  > 三者並呈的**實際畫面呈現**（圖示是否清楚、顏色對比在真實螢幕上是否易讀、文案是否
  > 通順）從未被人眼看過，只驗證了資料流與狀態機邏輯正確。且 FR-003 示警的具體圖示／
  > 文案仍未對照 Claude Design 畫布上 `CopilotPanel` 原始檔（`dc-import` 動態渲染，
  > Artifact 擷取不到內部逐字內容，見 `docs/DESIGN_TOKENS.md` §7.0）核實。
  >
  > **已由使用者操作發現並修復**：
  > 1. `session-manager.ts` 的 `onMessages()` 對任何被 SSE 檢視（未必 JOIN）的對話都會
  >    觸發，`runIncremental()` 卻會悄悄建立分析狀態，等於未 JOIN 也在分析（違反 FR-001）。
  >    修復：`runIncremental()` 改為若無既有 `CopilotAnalysisState` 直接略過。
  > 2. T010c 重連快照呼叫 `fetchSince()`，未依其明文的「錨點被擠出視窗時回傳整批、
  >    由呼叫端自行去重」約定去重，導致已涵蓋的訊息在對話存活夠久後被誤判為新訊息，
  >    重複觸發分析、`keyFacts` 不斷疊加同一筆事實。修復：新增 `newCustomerMessagesSince()`
  >    依 `sentimentBlock.timeline` 已涵蓋的 messageId 集合過濾。
  >    兩項修復皆已補上迴歸測試（`test/copilot-analysis.test.ts` 新增 5 個測試），
  >    typecheck／156 個 vitest／build／smoke 全數重新驗證通過。
  >
  > **順帶修復的既有 UI 缺口**（使用者實機操作時發現，嚴格說不屬於本功能規格，但影響
  > 本次驗收的可用性，一併處理）：
  > 3. 右欄 Copilot 面板未比照左側欄做拖曳調寬把手（純屬本次新增右欄時的疏漏）。
  >    修復：`app/pages/c/[conversationId].vue` 新增拖曳把手，範圍 320–520px、預設 380px
  >    （依 `docs/DESIGN_TOKENS.md` §7.1 的設計稿數字），寬度存 `localStorage`。
  > 4.（既有 M1 缺口，非本功能引入）側欄清單的 `mode`／小綠人圖示只在整批重載
  >    （`conversations.load()`）時更新，JOIN／LEAVE／切換模式當下不會連動，
  >    客服會覺得「按了 JOIN 但列表沒反應」。修復：新增 watcher，`view.control.value.mode`
  >    一有變化就直接同步進側欄快取的對應項目，不必整批重打 API。
- [x] T031 執行 `npm run typecheck && npm test && npm run build && npm run smoke`，確認全綠

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**：無依賴，立即可開始
- **Foundational (Phase 2)**：依賴 Setup 完成——**阻擋所有使用者故事**
- **User Story 1 (Phase 3)**：依賴 Foundational 完成；與其他使用者故事無依賴
- **User Story 2 (Phase 4)**：依賴 Foundational 完成；`onMessages()` 的增量觸發（T019）邏輯上建立在 US1 的分析管線輸出之上，但可獨立測試（US1 的冷啟動與 US2 的增量觸發是同一支 `copilot-analysis.ts` 的兩個進入點，互不阻擋）
- **User Story 3 (Phase 5)**：依賴 Foundational 完成；錯誤/重試 UI（T025、T026）依賴 US1 已建立的 `SummaryCard.vue`／`SentimentGauge.vue`（T015、T016）
- **Polish (Phase 6)**：依賴所有欲交付的使用者故事完成

### Within Each User Story

- 測試先寫、確認失敗，才開始實作
- 型別／狀態 → 服務層 → API 端點 → 前端 composable → 前端元件 → 頁面整合
- 各故事完成後才進入下一優先序故事（或依人力平行展開）

### Parallel Opportunities

- Foundational 內 T006／T007／T008 三個不同檔案可平行
- US1 測試 T011／T012 可平行；實作 T013／T014／T015／T016 四個不同檔案可平行（T017 需等 T014–T016 完成）
- US2 的 T020（前端）與 US3 尚未開始時彼此無交集，但 US2 只有單一測試任務（T018），依規則單一任務不標 [P]
- US3 測試 T021／T022 可平行；實作 T025／T026 兩個不同元件檔可平行（皆需等 T024 完成）
- Polish 的 T028／T029 可平行

---

## Parallel Example: User Story 1

```bash
# 測試（先行）：
Task: "sentiment-attachment-turn.test.ts 驗證純附件輪不產生分數點"
Task: "copilot-analysis.test.ts 驗證冷啟動輸入涵蓋完整歷史與 Zod 驗證"

# 實作：
Task: "join.post.ts 觸發 runColdStart()"
Task: "useCopilotSession.ts 訂閱 SSE 事件"
Task: "SummaryCard.vue 三態呈現"
Task: "SentimentGauge.vue 手刻 SVG sparkline"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（**關鍵阻擋項**）
3. 完成 Phase 3 User Story 1
4. **停下並驗證**：依 quickstart.md 情境一獨立測試 User Story 1
5. 視需要部署／展示（此時已消除 JOIN 接手的資訊斷層，是本功能的核心價值）

### Incremental Delivery

1. Setup + Foundational → 基礎就緒
2. + User Story 1 → 獨立驗證 → MVP 可展示（摘要卡＋情緒 sparkline 於 JOIN 後出現）
3. + User Story 2 → 獨立驗證 → 面板隨對話進行持續更新且成本可控
4. + User Story 3 → 獨立驗證 → 補上憲法 3.1／3.2 要求的故障降級，功能完整交付

### Parallel Team Strategy

Foundational 完成後：開發者 A 接手 User Story 1（含前後端），開發者 B 待 A 的 T014–T016 完成後接手 User Story 3 的錯誤/重試 UI，同時可另一人接手 User Story 2 的 `session-manager.ts` 增量觸發（與 US1/US3 檔案不重疊）。

---

## Notes

- [P] 任務＝不同檔案、彼此無阻擋依賴
- [Story] 標籤將任務對應回 spec.md 的使用者故事，供追溯
- 測試任務對應使用者要求的三個檔案（`ai-retry-policy.test.ts`、`sentiment-attachment-turn.test.ts`、`copilot-analysis.test.ts`），其中 `copilot-analysis.test.ts` 在 US1 建立、於 US2／US3 擴充（同一檔案跨階段編輯，非平行任務）
- 每個使用者故事完成後應可獨立驗證，不需等待後續故事
- 依邏輯分組提交（每個任務或每組相關任務提交一次）
- 避免：模糊任務描述、同檔案的 [P] 衝突、破壞故事獨立性的跨故事依賴
- **本清單刻意不含圖片／PDF 附件內容文字化的實作任務**（FR-013 已延後至 M3，見 `spec.md` Assumptions、2026-08-26 訂正）——這不是遺漏，純附件輪的處理範圍僅止於 T010 步驟②（過濾為 `SentimentMarker`，不評分、不文字化）
