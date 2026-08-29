---

description: "建議卡的漸進式知識庫引用 —— 實作任務清單"
---

# Tasks: 建議卡的漸進式知識庫引用

**Input**: Design documents from `/specs/004-progressive-citations/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、
[data-model.md](./data-model.md)、[contracts/progressive-suggestion-events.md](./contracts/progressive-suggestion-events.md)、
[quickstart.md](./quickstart.md)

**Tests**: 包含。本專案既有慣例即為 vitest 單元 + 對假 gateway 的整合測試；本規格的核心是
**兩段之間的交錯順序與覆蓋規則**（誰先落地、誰不得蓋誰、呼叫幾次），這些全是「靜默失效」型——
順序錯了畫面看起來還是有卡，只是引用悄悄消失或成本悄悄翻倍。沒有測試就沒有東西守得住。

**Organization**: 依 user story 分組。US1 與 US2 同為 P1，但 US2（更新提示與 Composer 保護）
建立在 US1 的 `pending → cited` 序列之上，因此 US1 先做。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行執行（不同檔案、無未完成的相依）
- **[Story]**: 對應的 user story（US1～US3）
- 每項任務都標出確切檔案路徑

## Path Conventions

單一 Nuxt 應用內建 Nitro BFF：`app/`（前端）／`server/`（BFF）／`shared/`（共用型別）／
`test/`（vitest）／`i18n/locales/`（文案）。本規格**不新增任何目錄**，`server/` 下**不新增檔案**。

---

## ⚠️ 動工前必讀

1. **`runBlockDeduped()` 的鎖只涵蓋第一段**（research.md #2）。把第二段留在鎖內不會報錯，
   但新一批客戶發言的分析會被舊尾巴拖慢最多 50 秒 —— 正是 FR-006 要避免的方向。
2. **過期判定用世代計數，MUST NOT 用 `basedOnMessageId`**（research.md #2）。手動重試用同一個錨點
   再跑一次，錨點比對會放行舊尾巴覆蓋新結果，而且不會報錯。`basedOnMessageId` 只供稽核與 UI。
3. **第二段 MUST 傳 `maxRetries: 0`，MUST NOT 傳 `onRetry`**（research.md #4）。漏掉前者會讓每批最壞
   6 次呼叫（FR-014 破功）；傳了後者會讓區塊在第二段失敗時閃出「重試中」——而第二段失敗
   依 FR-003 是靜默的。
4. **第二段的白名單集合是第二段呼叫當下的 hits**（data-model.md §7）。若沿用第一段的空集合，
   第二段所有帶 `sopId` 的卡會被整卡捨棄，畫面永遠看不到引用，且 `status` 仍是 `ready`——不報錯。
5. **重連快照不經 `forward()`**（003 動工前必讀第 4 點同一個陷阱）：`pending` 且無尾巴時改送 `none`
   的修正要放在 `sendAnalysisSnapshotAndResume()`，放在即時推播路徑上對快照無效。
6. **`aiReplies` 兩段都要帶**，一律 `controlFromMode(mode).aiReplies`（002 FR-016 的地雷）。
   第二段若漏帶，Hybrid 模式下的補位提示會在第二段消失。
7. **`SUGGESTION_STAGE2_CALL_TIMEOUT_MS` ＝ 20_000**（✅ 2026-08-29 已裁決，research.md #5）。
   只有這一個常數是 20 秒，MUST NOT 動 `retry-policy.ts` 的三個數字（15s／1s→4s／40s）——
   第二段 `maxRetries: 0` 不進重試迴圈，兩者沒有耦合。
8. **尾巴有兩個 `AbortController`，MUST NOT 合併**（data-model.md §4）。`stage1Abort` 給第一段、
   由第二段在「檢索有命中」時 abort；`tailAbort` 給第二段、由新世代與 `cancelPendingAnalysis()` abort。
   合併的後果是 LEAVE 之後第二段照跑、錢照付、結果無人看，**而且不報錯**。
9. **第二段整批換卡前 MUST 重跑 `markSupersededCards()`**（FR-015、data-model.md §8）。
   `checkSuggestionsSuperseded()` 是 `cards` 的第三個寫入者、不受世代管轄；漏了這步，
   同事已經回過的建議會以未標記的新卡復活，客服可能重複回覆客戶（憲法 7.2），且 `status` 仍是 `ready`。
10. **`beginAnalyzing()` 一個字都不要動**。它現在的 spread 會保留 `citation`，那**正是要的行為**
    （保留下來的舊卡若來自上一輪第二段，確實有 SOP 依據，不該被標成「未引用」）。
    data-model.md §2 原本寫「重設為 `'none'`」，該敘述已於 2026-08-29 訂正。

---

## Phase 1: Setup（型別、常數、文案、共用工具）

**Purpose**: 把各 story 都要用的型別、常數、`withRetry()` 選項與守衛先落地，讓後續任務不必互相等待

- [ ] T001 [P] 在 `shared/types/copilot.ts` 的 `SuggestionBlock` 新增 `citation: 'pending' | 'cited' | 'none'`、`basedOnMessageId: string | null`、`provenance: { stage: 1 | 2, stage1RetryAttempt: number }`，註解照 data-model.md §1 逐字寫上三值語意與「`basedOnMessageId` 僅供稽核與 UI、MUST NOT 做控制」的警告
- [ ] T002 [P] 在 `server/services/ai/retry-policy.ts` 新增 `WithRetryOptions.maxRetries?: number`（預設 `BACKOFF_MS.length`）與 `signal?: AbortSignal`，新增 `RetryAbortedError`；`signal` 只在退避等待中與下一次呼叫送出前檢查，已在飛的呼叫不受影響；`CALL_TIMEOUT_MS`／`BUDGET_MS`／`BACKOFF_MS` 一字不改，並在檔頭註解補一句「`maxRetries: 0` 時三數綁定不適用」（data-model.md §5）
- [ ] T003 [P] 在 `test/ai-retry-policy.test.ts` 新增：`maxRetries: 0` 對暫時性失敗不重試且不呼叫 `onRetry`、直接拋 `RetryExhaustedError(kind: 'transient')`；`signal` 在第一次退避等待中 abort → 拋 `RetryAbortedError` 且不再呼叫 `fn`；`signal` 在呼叫在飛時 abort → 該次呼叫的結果照常回傳；既有三個數值的斷言保持綠燈
- [ ] T004 刪除 `server/services/knowledge/agent-knowledge-provider.ts` 的 `SUGGESTION_RETRIEVAL_TIMEOUT_MS` 與其整段註解（research.md #8）；`KNOWLEDGE_SEARCH_TIMEOUT_MS` 的註解補一句「建議卡路徑（004 FR-003）與快查共用此值」；**同時改掉它唯一的使用端**——`server/services/copilot-analysis.ts` 的 import（`:43`）與 `analyzeSuggestionsOnce()` 裡 `search({ timeoutMs })` 的引數（`:745` 附近）改為 `KNOWLEDGE_SEARCH_TIMEOUT_MS`，連同那段「不可沿用 provider 預設值」的舊註解一併改寫；同步改寫 `shared/types/knowledge.ts` 中 `search()` 的 `@param opts.timeoutMs` 註解（拿掉「建議卡 MUST 傳入 SUGGESTION_RETRIEVAL_TIMEOUT_MS」三行）；移除 `test/copilot-analysis.test.ts` 對該常數的 import 與相關斷言。⚠️ **本項不是 [P]**（2026-08-29 訂正）：它必須動到 `copilot-analysis.ts`，與 T008 同檔；只刪常數不改使用端會讓 Phase 1 整段 typecheck 紅到 T012
- [ ] T005 [P] 在 `i18n/locales/zh-TW.json` 的 `copilot.suggestion` 新增：`citationPending`（「尚未引用知識庫・檢索中」）、`citedUpdated`（「已更新為有 SOP 依據的版本」）、`noKnowledgeRefPending`（「尚未引用知識庫」）；既有 `noKnowledgeRef`（「未引用知識庫」）不動（憲法 8.5）
- [ ] T006 [P] 在 `server/services/knowledge/mock-knowledge-provider.ts` 不改介面，於 `server/services/knowledge/index.ts` 裝配 Mock 時讀取 `AC_SMOKE_KNOWLEDGE_DELAY_MS` 帶入 `searchDelayMs`（比照既有 `AC_SMOKE_FORCE_KNOWLEDGE_FAILURE`，只在已退回 Mock 的路徑生效，註解寫明）
- [ ] T007 在 `test/contract-guards.test.ts` 新增三條守衛（各附「守衛本身有效」的自檢，比照既有寫法）：① `server/` 底下不得出現 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`；② `shared/` 底下不得出現 `suggestionTails`／`citedLanded`（data-model.md §4）；③ `app/composables/useCopilotSession.ts` 不得含 `useDraft`（契約 §3、FR-008）
- [ ] T008 補 `SuggestionBlock` 新欄位的預設值：`app/composables/useCopilotSession.ts::emptySuggestionBlock()` 與 `server/services/copilot-analysis.ts::initialState()` 皆為 `citation: 'none'`、`basedOnMessageId: null`、`provenance: { stage: 1, stage1RetryAttempt: 0 }`；`npm run typecheck` 通過（其餘建構 `SuggestionBlock` 的位置由型別錯誤指出，逐一補齊）

**Checkpoint**: `npm run typecheck && npm test` 綠燈。

⚠️ **此時的行為不等於現況，是一個不得部署的過渡狀態**：T004 把檢索的 `timeoutMs` 由 8 秒
改成 `KNOWLEDGE_SEARCH_TIMEOUT_MS`（30 秒），但兩段式要到 Phase 3 才存在——於是串行路徑變成
「等最多 30 秒檢索、再生成」，建議卡最壞會在 JOIN 後 40 秒以上才出現，直接撞破 002 SC-001。
**Phase 1 → Phase 2 → Phase 3 必須一口氣做完**，中間不得停留並部署。

---

## Phase 2: Foundational（`copilot-analysis.ts` 的控制流骨架）

**Purpose**: 世代、尾巴登記、共用的「生成→驗證→發布」工具。所有 story 都建立在這一層

**⚠️ CRITICAL**: 未完成前不得開始任何 story

- [ ] T009 在 `server/services/copilot-analysis.ts` 新增模組層級 `suggestionTails: Map<string, SuggestionTail>`（介面照 data-model.md §4：`generation`／**`stage1Abort`**／**`tailAbort`**／`citedLanded`／`done`／`lastRetrieval?`）與 `nextSuggestionGeneration(conversationId)`：`generation++`、對前一筆 `tailAbort.abort()`、建立**兩個**新的 `AbortController`；匯出 `awaitSuggestionTail(conversationId): Promise<void>`（僅供測試，註解註明）；`cancelPendingAnalysis()` MUST ① `tailAbort.abort()` ② `suggestionTails.delete(conversationId)`（003 FR-013 的延伸，註解寫理由：LEAVE 後沒人能按重試，備忘失去意義；不刪會讓這個 Map 隨程序生命週期逐對話累積，且每筆帶著 `lastRetrieval.hits`——它是唯一沒有回收機制的狀態，`CopilotAnalysisState` 有 2 小時 sliding TTL）。⚠️ 兩個 controller 的職責 MUST 在型別註解寫清楚（動工前必讀第 8 點）
- [ ] T010 在 `server/services/copilot-analysis.ts` 抽出兩個私有工具：`generateSuggestionCards(input, hits, opts: { maxRetries, callTimeoutMs, onRetry?, signal? })` → `withRetry(parseSuggestionCards(suggest(...)))` → `whitelistFilter(cards, hits)` → `forceNullConfidence(cards, hits)`，回傳 `{ cards, retryAttempt }`；`publishSuggestionReady(conversationId, { cards, knowledgeSearch, citation, basedOnMessageId, provenance })` → `updateAnalysisState`（含 `clearFailedBatch`）＋ `publishBlock`。既有的白名單／歸零順序不變（data-model.md §7）
- [ ] T011 在 `server/services/copilot-analysis.ts` 新增常數 `SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 20_000`，註解引用 research.md #5 的表格摘要（「第二段不進重試迴圈，改此值不牽動 001 FR-014 三數；15 秒對實測最慢 13.0 秒只剩 13% 餘裕，漂移即靜默逾時落成 `none`，侵蝕 SC-002」）。✅ 裁決已於 2026-08-29 完成，spec.md FR-003／Clarifications Q3／Q5／已知限制的 50 秒、plan、data-model §5、contracts 時序上限皆已同步；剩 `docs/ARCHITECTURE.md` §8.2b 由 T027 落定
- [ ] T012 將 `analyzeSuggestionsOnce()` 簽章改為 `(conversationId, input, strategy: 'progressive' | 'single')`，`analyzeSuggestions()` 同步帶 `strategy`；先以 `'single'` 實作為「等 `KNOWLEDGE_SEARCH_TIMEOUT_MS` 檢索 → `generateSuggestionCards(hits, { maxRetries: 2, onRetry })` → `publishSuggestionReady({ citation: hits.length > 0 ? 'cited' : 'none', provenance: { stage: 2, stage1RetryAttempt: 0 } })`」；所有既有呼叫端暫時傳 `'single'`（`runColdStart`／`runIncremental` 兩分支／`retryBlock`）；`'single'` 路徑同樣 MUST 在發布前重跑 `markSupersededCards()`（FR-015——它一樣是整批覆蓋）。⚠️ 參數名 MUST 是 `strategy`、**不是 `mode`**（2026-08-29 訂正）：`mode` 在本專案是對話服務模式的受控字彙（`manual`／`hybrid`／`automation`，CLAUDE.md 列為靜默失效地雷之一），而同一支函式的輸入正帶著由它推導出的 `aiReplies`（見動工前必讀第 6 點），同一段程式碼裡兩個 `mode` 指不同東西是找麻煩。⚠️ 這一步讓現況正式變成「單段、等 30 秒」，`test/copilot-analysis.test.ts` 既有斷言需依新欄位補齊但語意不變

**Checkpoint**: `npm test` 綠燈；行為＝單段、檢索等 30 秒、`citation` 正確為 `cited`／`none`。仍是過渡狀態

---

## Phase 3: User Story 1 - 先拿到可用的建議，再拿到有依據的建議 (Priority: P1) 🎯 MVP

**Goal**: 前景兩段式：第一段在 20 秒內顯示（`pending`），第二段有命中時整批換上（`cited`），
否則落定為 `none` 且卡片不動；過期與競態依世代處理。

**Independent Test**: quickstart.md US1 場景 1～5；自動化見 T017。JOIN 一段知識庫有內容的對話，
EventStream 上依序看到 `ready/pending` → `ready/cited`，且 `pending` 在 20 秒內。

### Implementation for User Story 1

- [ ] T013 [US1] 在 `server/services/copilot-analysis.ts::analyzeSuggestionsOnce()` 實作 `mode === 'progressive'`：`nextSuggestionGeneration()` → 同時啟動 `retrieval = search(query, { topK: 5, timeoutMs: KNOWLEDGE_SEARCH_TIMEOUT_MS })`（catch → `[]`，日誌比照既有）與 `stage1 = generateSuggestionCards(input, [], { maxRetries: 2, onRetry: publishRetrying, signal: tail.stage1Abort.signal })`；`stage1` 落地且 `!tail.citedLanded` → `publishSuggestionReady({ citation: 'pending', knowledgeSearch: { ran: true, hitCount: 0 }, provenance: { stage: 1, stage1RetryAttempt } })`；`stage1` 拋 `RetryAbortedError` → 靜默返回（不 `finishBlockError`）；其他失敗 → 既有 `finishBlockError()`。**鎖內只等 `stage1`**，`retrieval` 交給 T014 的尾巴
- [ ] T014 [US1] 在 `server/services/copilot-analysis.ts` 實作尾巴（`tail.done`）：`await retrieval` → 寫 `tail.lastRetrieval = { anchor, hits, at }` → 世代不符即返回 → `hits.length === 0` → `updateAnalysisState`（只改 `citation: 'none'`、`knowledgeSearch.hitCount`、`updatedAt`，cards 不動）＋ `publishBlock`；`hits.length > 0` → `tail.stage1Abort.abort()`（擋第一段未送出的重試，FR-006a）→ **送出前先檢查 `tail.tailAbort.signal.aborted`，已 abort 就直接返回**（LEAVE／新世代，動工前必讀第 8 點）→ `generateSuggestionCards(input, hits, { maxRetries: 0, callTimeoutMs: SUGGESTION_STAGE2_CALL_TIMEOUT_MS, signal: tail.tailAbort.signal })`；成功且 `cards.length > 0` 且世代相符 → `tail.citedLanded = true` → **以當下歷史重跑 `markSupersededCards()`（FR-015，順序在白名單與 `confidence` 歸零之後，data-model.md §8）** → `publishSuggestionReady({ citation: 'cited', knowledgeSearch: { ran: true, hitCount }, provenance: { stage: 2, stage1RetryAttempt } })`；失敗／逾時／全數捨棄 → 同 `hitCount === 0` 的 `'none'` 轉移（`hitCount` 記真實命中數，日誌以 `logFailure` 分類記錄「第二段失敗」但 **MUST NOT** `finishBlockError`）。⚠️ 若尾巴落地時第一段仍在 `retrying`（狀態非 `ready`），一樣直接寫 `ready/cited`（FR-006a）
- [ ] T015 [US1] 在 `server/services/copilot-analysis.ts` 實作 FR-005「命中已在手」：`analyzeSuggestionsOnce()` 開頭，若 `mode === 'progressive'` 且前一筆 `suggestionTails.get(id)?.lastRetrieval?.anchor === batchAnchor(input.history)` 且有值 → 改走 `'single'` 路徑並直接使用備忘的 hits（不再發檢索——⚠️ 註解 MUST 明確寫上：**憲法 6.2 v3.0.2** 的量詞是「每一批訊息至少一次檢索，且該批的重新生成 MUST 建立在那次檢索的真實結果上」，錨點相同保證是同一批，備忘就是那次檢索的結果，因此**不是「略過檢索」**。⚠️ 條文原本寫「每一次生成」，兩段式與本路徑都會違反其字面，已於 2026-08-29 因本規格澄清為 v3.0.2，見憲法附錄 C）；`runColdStart`／`runIncremental` 前景分支／`retryBlock` 改傳 `'progressive'`
- [ ] T016 [US1] 在 `server/api/stream.get.ts::sendAnalysisSnapshotAndResume()` 送 `suggestion.updated` 前：若 `suggestionBlock.citation === 'pending'` 且 `suggestionTails` 無該對話的尾巴（新匯出 `hasSuggestionTail(conversationId)`）→ 先寫回 `citation: 'none'` 再送（契約 §4）；註解說明這是程序重啟後唯一會讓「尚未」永久卡住的路徑
- [ ] T017 [US1] 在 `test/copilot-analysis.test.ts` 新增 `describe('兩段式（004 US1）')`，以 `MockAIProvider({ suggestDelayMs })`／`MockKnowledgeProvider({ searchDelayMs })` ＋ `vi.useFakeTimers()` ＋ `awaitSuggestionTail()` 涵蓋契約 §2 每一列：① 正常序列 `analyzing → ready/pending → ready/cited`，且 `pending` 事件早於檢索完成；② 檢索 0 筆 → `ready/none` 且 `cards` 與 `pending` 那則深度相等；③ 檢索拋錯／逾時（`searchDelayMs > KNOWLEDGE_SEARCH_TIMEOUT_MS`）→ 同 ②；④ 第二段 `suggestFailure` → `none`、`suggest()` 恰呼叫 2 次、事件中無 `retrying`、狀態非 `error`；⑤ 第二段回傳的卡 `sopId` 全不在 hits → `none` 且 cards 為第一段；⑥ 新批次啟動後舊尾巴落地 → 不發布（事件序列裡新世代 `analyzing` 之後無舊世代事件）；⑦ 第一段暫時性失敗進退避、第二段先落地 → `ready/cited`，之後 `suggest()` 不再被呼叫（abort）、無 `pending`；⑧ 第一段在飛時第二段落地，第一段後到 → 不覆蓋（`citedLanded`）；⑨ 呼叫次數上限：第一段失敗兩次後成功＋第二段 → `suggest()` 恰 4 次、`provenance.stage1RetryAttempt === 2`；⑩ 命中已在手：先跑一輪讓備忘產生，再 `retryBlock('suggestions')` → 無 `pending`、`suggest()` 只多 1 次、`search()` 不再被呼叫；⑪ **搶答標記（FR-015）**：第一段落地後注入一則同事回覆讓某張卡被標記，再讓第二段落地 → 第二段的新卡中對應內容**仍帶搶答標記**（`markSupersededCards()` 被重跑）；⑫ **LEAVE 取消第二段（U1）**：第一段落地、檢索回來前呼叫 `cancelPendingAnalysis()` → 尾巴結束後 `suggest()` **不再被呼叫**（第二段未送出）且 `suggestionTails` 已無該對話的登記；⑬ **卡數上限（FR-012）**：兩段落地的 `cards.length` 皆 ≤ 5
- [ ] T018 [US1] 在 `test/stream-analysis-visibility.test.ts` 新增：狀態為 `ready/pending` 且無尾巴時，連線快照送出的 `suggestion.updated` 為 `none` 且狀態已寫回；有尾巴時照送 `pending`
- [ ] T019 [P] [US1] 在 `app/components/copilot/SuggestionList.vue` 新增 `citation === 'pending'` 的標頭標示（`i-lucide-loader-circle` 旋轉圖示＋`copilot.suggestion.citationPending`，圖示＋文字，憲法 8.1）；`readyEmpty && citation === 'pending'` 時「本次未產生建議」旁同樣顯示檢索中；重試按鈕的 `disabled` 條件不變（`status !== 'error'`）
- [ ] T020 [P] [US1] 在 `app/components/copilot/SuggestionCard.vue` 新增 prop `citation: SuggestionBlock['citation']`，`sopTitle === null` 時依 `citation === 'pending'` 顯示 `noKnowledgeRefPending`，否則 `noKnowledgeRef`；`SuggestionList.vue` 傳入 `block.citation`

**Checkpoint**: `npm run typecheck && npm test` 綠燈；`AC_SMOKE_KNOWLEDGE_DELAY_MS=3000 npm run dev` 下 JOIN 可在畫面上看到「檢索中」→ 卡片換成帶來源的版本（此時尚無更新提示，那是 US2）

---

## Phase 4: User Story 2 - 更新不得悄悄抽換內容 (Priority: P1)

**Goal**: 第二段到達時自動換上並給區塊層級的明確提示（自動淡出）；Composer 內容在任何更新下不變。

**Independent Test**: quickstart.md US2 場景 1～3；自動化見 T023、T024。第二段到達前一鍵帶入並多打幾個字，
第二段到達後 Composer 一字不變且畫面有提示。

### Implementation for User Story 2

- [ ] T021 [US2] 在 `app/composables/useCopilotSession.ts::handle()` 的 `suggestion.updated` 分支加入轉移推導：`prev = suggestions.value`；`prev.citation !== 'cited' && evt.suggestion.citation === 'cited' && prev.cards.length > 0` → `suggestionCitedAt.value = Date.now()`；收到 `status === 'analyzing'` 或 `citation === 'pending'` → 清為 `null`；`watch(conversationId)` 一併清除；回傳值新增 `suggestionCitedAt`。**MUST NOT** import `useDraft` 或碰任何 Composer 狀態（契約 §3，T007 守衛）
- [ ] T022 [US2] 在 `app/components/copilot/SuggestionList.vue` 新增 prop `citedAt: number | null`；有值時於卡片列表上方顯示提示列（`role="status"`、`aria-live="polite"`、`i-lucide-book-check` 圖示＋`copilot.suggestion.citedUpdated` 文字），以 `setTimeout` 5 秒後隱藏（`onBeforeUnmount` 清 timer；prop 變為 `null` 時立即隱藏）；`app/pages/c/[conversationId].vue` 把 `suggestionCitedAt` 傳入
- [ ] T023 [P] [US2] 新增 `test/nuxt/suggestion-citation-cue.test.ts`（比照 `test/nuxt/copilot-retry-all.test.ts` 的掛載方式）：① 依序注入 `ready/pending`（有卡）→ `ready/cited` 事件 → `suggestionCitedAt` 有值、提示列可見且含文字與圖示；② 假時鐘前進 5 秒 → 提示隱藏；③ 首個事件即 `ready/cited`（模擬重連快照）→ 不觸發；④ `cited` 後收到新批次 `analyzing` → 立即清除；⑤ `citation: 'pending'` 時列表標頭顯示 `citationPending`、卡片來源列為 `noKnowledgeRefPending`
- [ ] T024 [US2] 在 `test/realtime-http.ts`（`npm run smoke:realtime`）新增場景：以 `AC_SMOKE_KNOWLEDGE_DELAY_MS=2000` 啟動的 server 上，客服 JOIN 後 SSE 依序收到 `ready/pending` 與 `ready/cited`（斷言順序與 `pending` 的 `cards.length > 0`）；期間對 Composer 路徑無任何寫入（SC-003：此 harness 不含瀏覽器，只能斷言「兩則事件之間不存在任何非 `suggestion.updated` 的對話事件」這個**弱代理**，SC-003 的實證留給 quickstart US2 手動場景——quickstart 覆蓋表已據此訂正，MUST NOT 再寫成「smoke 涵蓋 SC-003」）；`package.json` 的 `smoke:realtime` 若需環境變數，在 harness 內以 `spawn` 帶入，不改 npm script

**Checkpoint**: US1＋US2 完整；`npm run build && npm run smoke` 綠燈

---

## Phase 5: User Story 3 - 背景對話的兩段式行為 (Priority: P2)

**Goal**: 背景對話不走兩段式：等檢索完成一次產出；切回時顯示既有卡片。

**Independent Test**: quickstart.md US3 場景 1～3；自動化見 T026。背景注入新客戶發言，EventStream 上該對話
只出現一次 `ready`（無 `pending`），`suggest()` 只呼叫一次。

### Implementation for User Story 3

- [ ] T025 [US3] 確認 `server/services/copilot-analysis.ts::runIncremental()` 的 `priority === 'background'` 分支傳 `'single'`（T012 已如此），並在 `analyzeSuggestionsOnce()` 的 `mode` 參數註解與該分支各寫一段 **FR-013 的理由**：「背景沒有人在等（002 SC-007 以切回時已更新為驗收）、第一段的產出沒有人會看到、背景並行上限 10 個對話正是省下的量；前景與背景**刻意**不一致，MUST NOT 為了一致性改回兩段」——沒有這段註解，日後會被當 bug 修回來（spec Clarifications）
- [ ] T026 [US3] 在 `test/copilot-analysis.test.ts` 新增 `describe('背景對話（004 US3）')`：① `runIncremental(priority: 'background')` 配 `searchDelayMs` → 事件序列為 `analyzing → ready/cited`，無 `pending`，`suggest()` 恰 1 次且在 `search()` 完成之後才被呼叫；② 檢索 0 筆 → `ready/none`，`provenance` 為 `{ stage: 2, stage1RetryAttempt: 0 }`；③ 背景進行中切回前景（連線快照）→ 快照送出既有的上一批卡（`status: 'analyzing'` 保留 cards），不空白

**Checkpoint**: 三個 story 完整，`npm test` 綠燈

---

## Phase 6: Polish & 正典文件同步

**Purpose**: 本功能推翻了三份文件裡的現況描述（「建議卡目前拿不到引用」「8 秒短逾時」「先檢索再生成」），
依 CLAUDE.md 的規則逐處清乾淨，並落定 §8.2b 留給 004 的裁決

- [ ] T027 [P] 在 `docs/ARCHITECTURE.md` §8.2b：把「FR-014 的裁決 MUST 在 004 的設計定案後才做」一段改寫為裁決結果（✅ 2026-08-29 已定：`SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 20_000`，第一段的 15s 單次逾時與 40s 退避預算**不動**，理由是第二段 `maxRetries: 0` 不進重試迴圈、與那三數沒有耦合）；「⛔ 它補不上 FR-001 的缺口」段已註明門檻改 20 秒，確認不需再改；建議卡流程相關章節（`grep -n "先檢索\|再生成\|8 秒\|拿不到引用" docs/ARCHITECTURE.md`）改為兩段式描述並註明 004
- [ ] T028 [P] 在 `specs/001-sentiment-panel/spec.md` FR-014 的「暫時性失敗 MUST 自動重試」子項末尾加一句：「⚠️ 例外：004 建議卡的第二段生成不自動重試（004 FR-014），理由見該規格 Clarifications 2026-08-29」——例外不能只寫在例外那一邊
- [ ] T029 [P] 更新 `specs/002-suggestion-knowledge-search/quickstart.md`「建議卡目前拿不到知識庫引用」已知限制（改為「已由 004 兩段式解決，`pending`／`cited` 序列見 004 contracts」）、**`specs/002-suggestion-knowledge-search/spec.md` FR-004**（「未引用知識庫」自 004 起有「尚未／未」兩種語意，加一句指向 004 FR-002）、`specs/002-suggestion-knowledge-search/data-model.md` 裡「兩個逾時值 MUST NOT 共用」的段落（改為「004 起共用 `KNOWLEDGE_SEARCH_TIMEOUT_MS`」）。⚠️ `002 plan.md` Constraints、`002 tasks.md` T009／T036、`002 contracts/knowledge-search-api.md` **已於 2026-08-29 `/speckit-analyze` 修完**（連同 SC-002 拆條），本項只需複查
- [ ] T030 執行 `grep -rn "SUGGESTION_RETRIEVAL_TIMEOUT_MS\|拿不到引用\|拿不到知識庫引用\|8 秒短逾時\|8_000\|25 秒" docs/ specs/ server/ shared/ test/ app/`，逐處確認只剩歷史註記（帶「已於 004…」字樣）或本規格自己的敘述；另 grep `"每一次建議卡生成"` 確認憲法 v3.0.2 的舊量詞未殘留、`grep -rn "45 秒" specs/004-progressive-citations/` 確認第二段逾時改 20 秒後無漏改；`docs/IMBRACE_QUESTIONS.md` 0-3h（檢索延遲可否調校）仍成立，不動
- [ ] T031 更新 `specs/004-progressive-citations/checklists/requirements.md` 的 Notes（記錄 T011 的裁決結果與 `/speckit-analyze` 的 14 項修正），並跑完 quickstart.md 的自動化對照表：`npm run typecheck && npm test && npm run build && npm run smoke`
- [ ] T032 在測試環境對真實 agent 跑 quickstart.md US1 場景 1～4 一次（⚠️ `IMBRACE_ENV=stable` 是正式環境，JOIN 前確認對象並讓使用者知情），記錄 `pending` 出現時間、`cited` 出現時間與 10 段對話的 `cited` 比例到 `scripts/spike/out/`，作為 SC-001／SC-002 的驗收證據；若 `cited` 比例 < 90% 且失敗原因是第二段 20 秒逾時，回到 T011 重議

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001／T002／T003／T005／T006 五項可平行；**T004 不可平行**——它要動 `copilot-analysis.ts`（刪常數就得同時改使用端），與 T008 同檔，兩者依序（T004 → T008 或反之，同一人做）；T007 依 T004（守衛①要在常數刪除後才會綠）；T008 依 T001
- **Foundational (Phase 2)**: 依 Phase 1；T009 → T010 → T011 → T012 依序（同一檔）。**Phase 1 與 Phase 2 之間不得停留部署**（過渡狀態見各 checkpoint）
- **US1 (Phase 3)**: 依 Phase 2；T013 → T014 → T015 → T016 依序；T017、T018 依 T016；T019、T020 可與後端平行
- **US2 (Phase 4)**: 依 US1 的 T013～T014（需要 `pending → cited` 序列）；T021 → T022；T023、T024 依 T022
- **US3 (Phase 5)**: 依 Phase 2 即可（`'single'` 路徑在 T012 就存在）；可與 US1 平行，但 T026 ③ 需 T016
- **Polish (Phase 6)**: 依所有 story；T027～T029 可平行；T030 依 T027～T029；T031、T032 最後

### Within Each User Story

- 後端控制流 → 契約守衛／測試 → 前端；同一檔案（`copilot-analysis.ts`）的任務嚴格依序
- 每個 story 的 checkpoint 都要 `npm run typecheck && npm test`；動到 `server/api/stream.get.ts`（T016）後一併跑 `npm run build && npm run smoke`

### Parallel Opportunities

- Phase 1：T001／T002／T003／T005／T006 五項互不相依（五個不同檔案）。⚠️ **T004 不在其中**（2026-08-29 訂正）——它必須改 `copilot-analysis.ts` 的 import 與呼叫端，與 T008 撞同一個檔案
- US1：T019、T020（前端）與 T013～T018（後端）平行
- US3 整個 phase 可與 US1 平行（不同 describe、`'single'` 路徑已在 Phase 2 存在）
- Polish：T027／T028／T029 三份文件平行

---

## Parallel Example: Phase 1

```bash
# 五個不同檔案，同時開工：
Task: "T001 shared/types/copilot.ts — SuggestionBlock 三個新欄位"
Task: "T002 server/services/ai/retry-policy.ts — maxRetries／signal／RetryAbortedError"
Task: "T003 test/ai-retry-policy.test.ts — 新選項的測試"
Task: "T005 i18n/locales/zh-TW.json — 三個新文案鍵"
Task: "T006 server/services/knowledge/index.ts — AC_SMOKE_KNOWLEDGE_DELAY_MS"

# T004 與 T008 都要動 copilot-analysis.ts，序列做，不併入上面：
#   T004 agent-knowledge-provider.ts／shared/types/knowledge.ts／copilot-analysis.ts — 刪除短逾時常數與其使用端
#   T008 copilot-analysis.ts／useCopilotSession.ts — SuggestionBlock 新欄位預設值
```

---

## Implementation Strategy

### MVP First（US1）

1. Phase 1 → Phase 2 **一口氣做完**（中間是過渡狀態）
2. Phase 3（US1）：後端 T013～T018 先，前端 T019～T020 隨後
3. **停下驗證**：quickstart.md US1 場景 1～5（本機用 `AC_SMOKE_KNOWLEDGE_DELAY_MS=3000`）
4. 此時客服已能「先拿到卡、再拿到有依據的卡」，只是換上時沒有提示（US2）

### Incremental Delivery

1. US1 → 驗證 → 可示範（MVP）
2. US2 → 驗證（提示＋Composer 不變）→ 可示範
3. US3 → 驗證（背景單段）
4. Polish：文件同步與真實環境量測（T032 是 SC-001／SC-002 的驗收證據，不可省）

---

## `/speckit-analyze` 修正紀錄（2026-08-29，動工前）

實作尚未開始時跑過一次 `/speckit-analyze`，14 項全數處置。**已經改完、不必再做**的有：

- **憲法 6.2 澄清為 v3.0.2**（量詞由「每一次生成」改為「每一批至少一次」）——`docs/CONSTITUTION.md`
  與 `.specify/memory/constitution.md` 兩份已同步、附錄 C 已留紀錄。⚠️ **MUST NOT 再修一次憲法**
- **002 SC-002 拆為 SC-002a（90%／20 秒）與 SC-002b（100%／35 秒）**——原本的單一 25 秒門檻
  源自已排除模型的離群值，且比 30 秒的逾時上限還短，使它自己那句「逾時 MUST 短於門檻」從未成立。
  002 spec／plan／tasks／contracts 與 `agent-knowledge-provider.ts` 的常數註解皆已同步
- **`SUGGESTION_STAGE2_CALL_TIMEOUT_MS` 裁決為 20 秒**（T011 不再是決策點）
- **新增 004 FR-015**（第二段換卡後重跑搶答判定）與 data-model §8
- 兩個 `AbortController` 的拆分、`suggestionTails` 的刪除時機、`beginAnalyzing()` 不動 `citation`、
  T004 的排序、契約時序上限的訂正、quickstart 對 SC-003 覆蓋程度的誠實化、`mode`→`strategy` 改名

**仍待實作**的部分已寫進上面各 T 項與「動工前必讀」。

## Notes

- 本規格的成本承諾（FR-014：前景每批最壞 4 次、背景 1 次）由 T017 ⑨ 與 T026 ① 以 `suggest()` 呼叫次數
  直接斷言——不是信任註解
- `SUGGESTION_STAGE2_CALL_TIMEOUT_MS` 已定為 20 秒；spec／plan／data-model／contracts／quickstart 的
  「45 秒」皆已改為 50 秒，只剩 `docs/ARCHITECTURE.md` §8.2b 由 T027 落定。改完仍 MUST grep「45 秒」
- FR-015 的搶答標記由 T017 ⑪ 斷言，第二段的可取消性由 T017 ⑫ 斷言——兩者都是靜默失效型，
  沒有測試就沒有東西守得住
- 三個契約守衛（T007）與 003 的守衛同檔，MUST NOT 併進 `test/component-names.test.ts`（理由見該檔檔頭）
