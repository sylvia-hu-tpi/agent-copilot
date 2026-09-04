---

description: "結案摘要與人審面板的實作任務清單"
---

# Tasks: 結案摘要與人審面板

**Input**: `specs/006-closure-handoff-summary/` 的設計文件
**Prerequisites**: plan.md ✅、spec.md ✅、research.md ✅、data-model.md ✅、contracts/ ✅（兩份）、quickstart.md ✅

**Tests**: **本規格明文要求測試**（spec.md「驗收方式的補充要求」第 3 點：每一條「不報錯但會做錯事」的路徑
MUST 有一個會紅的迴歸測試；本清單共新增 10 支測試檔（8 支在 `test/`、2 支在 `test/nuxt/`）與 4 條契約守衛）。測試任務因此**不是可選**，
且排在對應實作之前或同一 Phase 內 —— 先寫測試、看它紅、再實作。

**Organization**: 依 User Story 分 Phase。US1 是 MVP；US2／US3 驗的是 US1 寫入路徑的兩個側面；US4 是使能項。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可平行（不同檔案、不依賴未完成的任務）
- **[Story]**：所屬 User Story（US1～US4）
- 每個任務都帶確切檔案路徑

## Path Conventions

沿用既有 Nuxt 4 單一 repo：`app/`（前端）、`server/`（Nitro BFF）、`shared/`（兩端共用型別）、
`config/`（設定）、`test/`（vitest）、`scripts/`（setup script 與 spike）、`i18n/locales/`（文案）。
新增兩個目錄：`server/api/conversations/[id]/closure/`、`server/services/closure/`。

## ⚠️ 開工前必讀的三件事

1. **已存在、不要重做**：`config/categories.ts`（四份受控詞彙＋推導型別）、
   `server/services/ai/imbrace-agent-provider.ts` 的 `buildClosurePrompt()`、
   `scripts/spike/25-agent-prompt-drift.ts` 的第五個 agent、`.env.example` 的
   `IMBRACE_CLOSURE_AGENT_ID`／`IMBRACE_CLOSURE_BOARD_ID`、spike 29／31 及其實測結論。
2. **正典文件改了就要 grep 舊說法**（CLAUDE.md）。本清單中每個 `docs/` 任務都附驗法。
3. **`IMBRACE_ENV=stable` 是正式環境**。T046、T051 會在真實組織建立 Board 或寫入紀錄，
   執行前 MUST 讓使用者知情。手動驗收期間 MUST NOT 編輯 `server/**`（Nitro 熱重啟會清空 session）。

---

## Phase 1: Setup（環境與共用型別）

**Purpose**: 兩個環境變數的橋接、npm scripts、以及四個消費者都要 import 的型別。

- [x] T001 在 `nuxt.config.ts` 的 `IMBRACE_*` → `NUXT_*` 橋接表新增 `NUXT_IMBRACE_CLOSURE_BOARD_ID: 'IMBRACE_CLOSURE_BOARD_ID'` 與 `NUXT_IMBRACE_CLOSURE_AGENT_ID: 'IMBRACE_CLOSURE_AGENT_ID'`，並在 `runtimeConfig`（**非 `runtimeConfig.public`**）新增 `imbraceClosureBoardId: ''`、`imbraceClosureAgentId: ''`（憲法 1.1；預設值留空字串，理由見該檔檔頭第 2 點）
- [x] T002 [P] 在 `package.json` 的 `scripts` 新增 `"board:setup": "tsx scripts/setup-closure-board.ts"`、`"board:verify": "tsx scripts/setup-closure-board.ts --verify"`、`"spike:closure-latency": "tsx scripts/spike/30-closure-latency.ts"`
- [x] T003 [P] 在 `shared/types/copilot.ts` 新增 `ClosurePeriod`、`ClosureDraftReadonly`、`ClosureDraft`、`ClosureDraftAiPart`（＝ `ClosureDraft` 去掉 `draftId`／`conversationId`／`period`／`readonly`）與 `ClosureSummary`（含 `periodOrigin`；`sentimentStart`／`sentimentEnd`／`sentimentTrough`／`confidence` 一律 `number | null`；`resolution`／`sentimentOutcome` **MUST** 使用 `config/categories.ts` 匯出的 `ClosureResolution`／`ClosureSentimentOutcome`，MUST NOT 自己再寫一份字面聯集）；並在 `AIProvider` 介面新增 `summarizeClosure(input: { history, vocabulary, knowledgeHits, signal? }): Promise<ClosureDraftAiPart>`。逐字形狀見 data-model.md §1～§4.2；`signal?: AbortSignal` 是為契約 R2.9「取消 MUST 真的中止在途 AI 呼叫」預留
- [x] T004 [P] 新增 `server/services/closure/board-schema.ts`：純模組（**不得使用任何 Nitro auto-import**，理由見 `tsconfig.scripts.json` 檔頭 —— setup script 也要 import 它），匯出 `CLOSURE_BOARD_NAME = 'AgentCopilot_ClosureSummary'` 與 `CLOSURE_BOARD_FIELDS`：26 個欄位的 `{ name, type, options? }` 陣列，逐欄對照 `contracts/closure-board-schema.md` §2；受控詞彙欄位的 `options` 直接取自 `config/categories.ts`（`category`→`CATEGORIES`、`resolution`→`RESOLUTIONS`、`actions_taken`→`ACTIONS_TAKEN`、`sentiment_outcome`→`SENTIMENT_OUTCOMES`、`period_origin`→`['closure','first','custom']`）。⚠️ 這份陣列是 `board-repository.ts` 與 `setup-closure-board.ts` 的**共同來源**（FR-052 的「同步」靠單一來源而非靠人記得）

**Checkpoint**: `npm run typecheck` 綠（新型別尚無使用者，但 `AIProvider` 多了一個方法會讓兩個 provider 紅 —— 由 Phase 2 補上）

---

## Phase 2: Foundational（所有 Story 的阻塞前置）

**Purpose**: Board 防腐層、AI provider 的第五個方法、Zod schema、假 gateway 的 Board 端點、冪等寫入倉儲。
沒有這些，任何一個 Story 都跑不起來。

**⚠️ CRITICAL**: 本 Phase 完成前不得開始任何 User Story。

- [x] T005 在 `server/services/imbrace.ts` 新增 Board API 的防腐層包裝（憲法 1.2；CLAUDE.md 地雷 3）：`getBoard(client, boardId)`、`listBoards(client)`、`createBoard(client, name, description)`、`createBoardField(client, boardId, spec)`、`searchBoardItems(client, boardId, q, limit)`、`createBoardItem(client, boardId, fieldsById)`、`updateBoardItem(client, boardId, itemId, fieldsById)`、`getBoardItem(client, boardId, itemId)`。每個函式 **MUST 解開平台一律包的 `{ data: ... }` 外層**（research #5；SDK 型別沒反映），`searchBoardItems` 回 `{ hits, estimatedTotalHits }`（Meilisearch 信封，與 `listItems()` 的 `PagedResponse` 不可互換）。檔頭註解逐字記下三條實測：`createField()` 回的是整個 board 不是 field、`search(filter:)` 被靜默忽略、`search(sort:)` 欄位被忽略 —— **本檔 MUST NOT 提供 `filter`／`sort` 參數**，讓上層根本沒得用
- [x] T006 [P] 在 `server/services/ai/schemas.ts` 新增 `ClosureDraftAiPartSchema` 與 `parseClosureDraftAiPart(raw, vocabulary, knowledgeHitIds)`（憲法 4.2）：`summary`／`intent` `.min(1)`（空 → 拋錯，整份視為產生失敗，FR-046）；`category`／`resolution`／`actionsTaken`／`sentimentOutcome` 不在白名單 → **該欄位留空**（空字串／空陣列），MUST NOT 拋錯、MUST NOT 保留模型的值（FR-015、R2.5）；`citedSopIds` 不在 `knowledgeHitIds` 內者逐一丟棄（憲法 4.3、R2.7）；`followUps[].action` 空字串者丟棄該筆；`confidence` 無值 → `null`（憲法 4.4）
- [x] T007 [P] 在 `server/services/ai/mock-ai-provider.ts` 實作 `summarizeClosure()`：回固定但合法的 `ClosureDraftAiPart`（受控詞彙一律取 `vocabulary` 的第一個值，`citedSopIds` 取 `knowledgeHits` 前兩個）；`MockAIProviderOptions` 新增 `closureFailure?: () => Error`（比照既有 `suggestFailure`）與 `closureDelayMs?: number`（SC-004 的等待誠實測試要能把它拉長）；`signal` aborted 時拋 `AbortError`
- [x] T008 [P] 在 `server/services/ai/imbrace-agent-provider.ts` 實作 `summarizeClosure()`：建構子新增 `closureAgentId: string | null`；以既有的 `buildClosurePrompt()` 組 prompt、走既有 `callAgent()` 與 `retry-policy.ts`，結果經 T006 的 `parseClosureDraftAiPart()`；`closureAgentId` 為 `null` 時拋出訊息為「IMBRACE_CLOSURE_AGENT_ID 未設定」的錯誤（MUST NOT 靜默退回 mock —— 正式環境退回 mock 會寫出假摘要）。同步修改 `server/services/ai/index.ts`：讀 `NUXT_IMBRACE_CLOSURE_AGENT_ID`／`IMBRACE_CLOSURE_AGENT_ID` 傳入建構子；缺它**不**改變既有「退回 MockAIProvider」的判定（其餘四個 agent 齊全就用真 provider）
- [x] T009 [P] 在 `test/mock-gateway.ts` 新增 Data Board 端點與故障注入：記憶體內的 board／fields／items 三張表；端點 `boards.get`（回 `{ data: { ...board, fields } }`）、`boards.search`（**只依 `q` 做子字串比對、忽略 `filter`／`sort`** —— 忠實重現實測行為 006-E7／E8，讓「誤信平台過濾」的實作在測試裡就會錯）、`createItem`／`updateItem`／`getItem`（皆包 `{ data }`）；`MockGatewayOptions` 新增 `board?: { failWith?: Record<'search'|'create'|'update'|'get', number>, hangMs?: Partial<Record<'search'|'create'|'update'|'get', number>>, createButHideFromGet?: boolean, createButTimeout?: { times: number } }`（最後一項：前 N 次 `createItem` 實際建立紀錄但不回應 —— SC-002 的注入形態）；`MockGateway` 新增 `boardItems(): Array<Record<string, unknown>>` 與 `boardCallCount(op): number`。⚠️ 既有註解寫明「不要用 5xx／429：SDK 會指數退避」，但 SC-003 **明列 5xx 注入 10 次**，且 SDK 的 retry 寫死在 `node_modules/@imbrace/sdk/dist/http.js`（`maxRetries = 3`，1s→2s→4s，不可設定）—— 因此 Board 路徑的 `failWith` **允許 5xx**，並在該註解旁補一句「Board 的 5xx 由 T037 以並行＋拉長 timeout 承擔約 7 秒的退避，不是例外」。MUST NOT 以 4xx 或 `hangMs` 代替 5xx（那會讓 SC-003 的 5xx 一格從未被驗到）
- [x] T010 新增 `server/services/closure/board-repository.ts`（依賴 T004、T005）：① `fieldIdMap(client, boardId)`：以 `getBoard()` 建 name→id 對照，process-local 快取 **TTL 10 分鐘**，提供 `{ bypassCache: true }`（`--verify` 不吃快取，research #5）；② `toFieldsById(summary)`：`ClosureSummary` → `{ [fieldId]: value }`，`null` 的數值欄位**不送該欄位**（FR-022b：留空 ≠ 0，research #6），`operators`／`citedSopIds`／`followUps` 以 `JSON.stringify` 存 `LongText`；③ `commitClosure(client, boardId, summary, { reqId, log })`：固定三步 `searchBoardItems(q: draftId)` → **本地逐字比對 `draft_id`**（R3.13，MUST NOT 省略）→ 0 筆 `createBoardItem`／1 筆 `updateBoardItem`／≥2 筆取**最早建立**那筆 update ＋ `console.warn` → `getBoardItem` 回查，找不到或 `draft_id` 不符 → 拋 `ClosureWriteError({ failKind: 'unverified' })`（R3.5）；整條路徑以 `AbortSignal.timeout(30_000)` 包住（R3.12，FR-032a），逾時拋 `ClosureWriteError({ failKind: 'failed', status: 504 })`；三步各記一行日誌帶 `reqId`（FR-035a），日誌 **MUST NOT** 含 `summary`／`intent`（憲法 1.5）；回 `{ recordId, created: boolean }`。④ `listClosuresFor(client, boardId, conversationId)`：`searchBoardItems(q: conversationId)` → 本地逐字比對 `conversation_id` → **本地**依 `closed_at` 降冪 → 回全部（R1.6；`overflowCount` 由呼叫端以 `length - 5` 算，MUST NOT 用 `estimatedTotalHits`）。⚠️ 檔頭註解註明本目錄**不是**分析管線成員（不加 `@analysis-pipeline` 標記）
- [x] T011 [P] 新增 `server/services/closure/sentiment-range.ts`：純函式 `sentimentRange(timeline: SentimentTimelineEntry[], periodStart: string): { start: number | null, end: number | null, trough: number | null, note: string | null }` —— 過濾 `kind === 'point'` 且 `at >= periodStart` 的點；若 timeline **最早一個 point 的 `at` 晚於 `periodStart`**（區間起點未被涵蓋）或區間內無點 → 三者一起 `null` ＋ `note` 說明實際涵蓋範圍（例：「情緒評分僅涵蓋 {最早點} 起，未涵蓋區間起點 {periodStart}」）；否則 `start` ＝ 最早點、`end` ＝ 最晚點、`trough` ＝ 區間內最小 `score`。**本檔 MUST NOT 出現 `lowestScore`**（FR-022a、契約守衛 G2）
- [x] T012 [P] 新增 `server/services/closure/period.ts`：① `buildCandidates(closures, firstMessageAt)`：取 `listClosuresFor()` 結果前 5 筆映成候選（`start = closed_at`、`origin: 'closure'`、`label: { category, reviewedByName, closedAt }`）＋ `fallback`（`start = firstMessageAt`、`origin: 'first'`）＋ `overflowCount = max(0, total - 5)`；② `countByCandidate(client, ctx, candidates)`：**一次**由新到舊以既有 `server/sources/message-fetch.ts` 的 `skip` 分頁掃訊息，掃到最舊候選的 `start` 或 **500 則上限**為止，一趟算出所有候選與 fallback 的 `messageCount`；超過上限的候選 `messageCount: null` ＋ `truncated: true`（**MUST NOT 序列化成 0**，R1.3）；③ `defaultIndex(candidates)` ＝ 最上面 `messageCount > 0` 的索引，全為 0 回 `-1`（R1.2）；④ `fetchPeriodMessages(client, ctx, periodStart)`：取「`periodStart` 之後的第一則」起的全部訊息作為快照 —— `closure`／`first`／`custom` 三種 origin **共用這一條路徑**（research #12）。**本檔 MUST NOT 出現 `filter:`／`sort:`**（守衛 G4）

**Checkpoint**: `npm run typecheck && npm test` 綠；`MockAIProvider.summarizeClosure()` 可被呼叫；假 gateway 能建立並回查 board item。

---

## Phase 3: User Story 1 — 結案：AI 寫的摘要要先給人看過，才進得了 CRM（Priority: P1）🎯 MVP

**Goal**: 按「結案」只開面板（不再先 LEAVE）；選涵蓋區間 → 以快照產生草稿 → 客服編輯 → **明確按下寫入**才進 Board，
帶審核者與時間 → 成功後才 LEAVE。未結案時第 6 區塊整塊不存在；結案時置頂、其餘五塊收合。

**Independent Test**: 在一通有客戶發言的對話上 JOIN、按下結案、看到可編輯面板、改一個欄位、按寫入、到 Board 確認寫入的是**改過之後**的內容且帶審核者與時間。不依賴冪等即可驗證。

### 測試（先寫，看它紅）

- [x] T013 [P] [US1] 在 `test/contract-guards.test.ts` 新增四條守衛（沿用檔內 `stripNonCode`／`filesUnder`；每條 MUST 先斷言目標檔案**存在**，避免檔案不在時守衛靜默恆真）：G1 `server/api/conversations/[id]/closure/commit.post.ts` 不得出現 `fetchLatest`／`fetchSince`／`rawList`／`message-fetch`／`/api/messages`；G2 `server/services/closure/**` 不得出現 `lowestScore`；G3 `app/stores/closure.ts` 不得出現 `localStorage`／`sessionStorage`；G4 `server/services/closure/**` 不得出現 `filter:`／`sort:`
- [x] T014 [P] [US1] 新增 `test/closure-commit-guard.test.ts`（SC-001、契約 R3.1）：掃描 `app/**/*.{ts,vue}`，字串 `/closure/commit` **只能出現一次**，且必須在 `app/stores/closure.ts`；另斷言 `app/composables/useConversationView.ts` 的 `closeConversation()` 函式體內**不含** `/leave`（research #16：LEAVE 移到寫入成功之後）
- [x] T015 [P] [US1] 新增 `test/closure-scope-selection.test.ts`（SC-006a，四情境各 5 次）：以固定 fixture 呼叫 `period.ts` 的 `buildCandidates`／`countByCandidate`／`defaultIndex`（訊息與結案紀錄皆為記憶體 fixture，`countByCandidate` 以注入的取數函式替代真實 client）：① 第 N 次服務 → 預設選最近一次 `closedAt`，則數不含前幾輪；② 最上候選 0 則 → `defaultIndex` 跳到下一個，0 則那列仍在 `candidates` 內；③ 客戶昨天 17:35 發言、今天 10:15 才有人接、無結案 → 同一區間（**反例測試**：斷言沒有任何 gap 規則把它切開）；④ 從未結案 → `candidates` 為空、`defaultIndex === -1`、`fallback` 存在。另加：超過 500 則 → `messageCount === null && truncated === true`，且 `JSON.stringify` 後不是 `0`
- [x] T016 [P] [US1] 新增 `test/closure-sentiment-range.test.ts`（SC-006b、FR-022a、FR-022b）：造一條**跨兩個區間**的 timeline，前一區間含全局最低分 → 斷言 `trough` ＝ 本區間最小值且 **≠** 全局最低（即 ≠ `stats.lowestScore` 的值）；timeline 最早點晚於 `periodStart` → 三者一起 `null` 且 `note` 有值；三者「部分有值」的組合不可能出現（窮舉斷言）；經 T010 `toFieldsById()` 後 `null` 的欄位**不在** body 內，而 `0` 分在 body 內（留空與 0 可區分）
- [x] T017 [P] [US1] 新增 `test/closure-leave-no-write.test.ts`（SC-006）：對假 gateway 觸發 `/leave` 的服務路徑 20 次，斷言 `boardCallCount('create') === 0`、`boardCallCount('update') === 0`、`MockAIProvider.summarizeClosure` 呼叫次數 0，且 003 SC-002（離開後 5 秒內不再產生新分析）在 20 次中 20/20 成立（沿用 `test/analysis-join-boundary.test.ts` 的手法）
- [x] T018 [P] [US1] 新增 `test/nuxt/closure-wait-honesty.test.ts`（SC-004、FR-046a、FR-040a）。⚠️ **MUST 放 `test/nuxt/`**：本測試 import `app/stores/closure.ts`，只有該目錄由 `nuxt typecheck` 以真正的 auto-import 型別檢查（`ref`／`$fetch`），放 `test/` 會落到 `tsconfig.scripts.json` 必紅（理由見 `test/nuxt/stream-store.test.ts` 檔頭與 `tsconfig.scripts.json` L33–39）；`$fetch` 比照該檔以 global 注入的 `vi.fn()` 模擬三支端點。以 `MockAIProvider({ closureDelayMs })` 模擬短／中／長三種區間共 20 次產生，對 `app/stores/closure.ts`（Pinia 在測試中以 `setActivePinia(createPinia())` 啟用）斷言三個 0：完成前 `status` 從未等於 `'ready'`、`i18n/locales/zh-TW.json` 的 `closure.*` 文案中**不含**「秒」「約」＋數字的時間承諾（正則掃描）、`generating` 狀態下 `canCancel === true` 且呼叫 `cancel()` 會 abort 在途請求（斷言 `AbortSignal.aborted`）

### Server 實作

- [x] T019 [US1] 新增 `server/api/conversations/[id]/closure/scopes.post.ts`（契約 §1）：沿用 `leave.post.ts` 的骨架（`conversationIdParam`／`requireActiveBffSession`／`imbraceClientFor(session)`／`loadConversationContext`）；讀 `useRuntimeConfig().imbraceClosureBoardId`（空字串 → 500「IMBRACE_CLOSURE_BOARD_ID 未設定」）；呼叫 T010 `listClosuresFor()` → T012 `buildCandidates()` → `countByCandidate()` → `defaultIndex()`；回 `{ candidates, fallback, overflowCount, defaultIndex, firstMessageAt, baselineAt: new Date().toISOString(), closureBaseline: <全部紀錄 id> }`。Board 查詢失敗 → **502**（R1.4，MUST NOT 回只有 `fallback` 的 200）。候選 `label.reviewedByName` 以既有 `server/services/directory.ts` 由 `reviewed_by` 解析顯示名
- [x] T020 [US1] 新增 `server/api/conversations/[id]/closure/draft.post.ts`（契約 §2）：Zod body `{ periodStart: string(datetime), periodOrigin: enum }`，**MUST NOT 接受任何訊息內容**；`draftId = crypto.randomUUID()`；以 T012 `fetchPeriodMessages()` 在**本次請求內**取快照（R2.1）；以既有 `server/services/knowledge/index.ts` 的 provider 檢索 `knowledgeHits`（比照 `server/services/blocks/suggestion.ts` 的用法）；`useAIProvider().summarizeClosure({ history, vocabulary: CLOSURE_VOCABULARY, knowledgeHits, signal })` —— `signal` 綁 `event.node.req.on('close')` 觸發的 `AbortController`（R2.9：取消 MUST 真的中止在途 AI 呼叫）；`readonly` 由 server 算 —— **新增 `server/services/closure/readonly-fields.ts`** 匯出 `computeReadonlyFields(ctx, analysisState, periodStart)`（T021 的 commit 端點會重用同一支，R3.7 的「server 重算」靠單一來源）：`operators`／`joinedAt`／`channel`／`contactId` 取自 `ctx` 與 state store 的 JOIN 紀錄，`sentiment*`／`sentimentNote` 取自 T011 `sentimentRange(analysisState.sentimentBlock.timeline, periodStart)`；端點再補 `closedAt: null`、`confidence` 取自 AI part；回完整 `ClosureDraft`（`period.messageCount` ＝ 本次快照的則數）。產生失敗 → **502**（R2.6），錯誤與日誌 MUST NOT 含訊息全文（R2.8）。**本端點不設固定秒數逾時**（R2.9）
- [x] T021 [US1] 新增 `server/api/conversations/[id]/closure/commit.post.ts`（契約 §3）：請求進入時先 `reqId = randomUUID().slice(0, 8)`（FR-035a）；Zod body 逐字對照契約 §3 Request（受控詞彙以 `config/categories.ts` 建 `z.enum`，`category` 以 `CATEGORIES` 建）；`reviewedBy = session.operatorId`、`reviewedAt = now`（R3.6，MUST NOT 取自 body）；`operators`／`joinedAt`／`channel`／`contactId`／`sentiment*`／`sentimentNote` **由 server 重算**（R3.7，直接呼叫 T020 建立的 `server/services/closure/readonly-fields.ts`，MUST NOT 在本檔另寫一份）；`closedAt = now`；組 `ClosureSummary`（`recordId` 由 repository 回填）→ T010 `commitClosure()`；成功後以 `listClosuresFor()` 減去 `body.closureBaseline` 算 `newClosuresSincePanelOpen`（R3.10，只列面板開啟後新出現者），每筆帶 `{ recordId, operatorName, closedAt }`，`operatorName` 比照 T019 以 `server/services/directory.ts` 由 `reviewed_by` 解析顯示名（T035 的提示文案與 T036 的斷言都要它）；回 `{ recordId, reviewedBy, reviewedAt, created, reqId, newClosuresSincePanelOpen }`。失敗 → `createError({ statusCode: 502|504, data: { failKind, reqId } })`（R3.8、R3.14、R3.15）。**本檔 MUST NOT import 任何訊息取數模組、MUST NOT 呼叫 LEAVE**（R3.3、R3.9；守衛 G1）
- [x] T022 [US1] 在 `test/smoke-http.ts` 新增三支 closure 端點的檢查：未登入 POST 各回 401；登入後 POST `scopes` 回 200 且 body 含 `fallback`／`baselineAt`；三個回應皆通過既有的憑證外洩掃描（FR-035）

### 前端狀態與文案

- [x] T023 [US1] 新增 `app/stores/closure.ts`（Pinia，`defineStore('closure')`，比照 `app/stores/conversations.ts`）：**檔頭註解 MUST 寫明**「結案草稿是模型產物、重按即可重生、尚未寫入任何紀錄，因此 FR-040 要求重新整理等同取消；憲法 8.4『草稿絕不遺失』的標的是 Composer 草稿，兩者標的不同，**MUST NOT 加 `localStorage` 持久化**」（守衛 G3）。狀態 `Map<conversationId, ClosureSession>`，`ClosureSession = { status: 'loadingScopes'|'scopesError'|'generating'|'draftError'|'ready'|'writing'|'leaving'|'writtenLeaveFailed', scopes, selected: { periodStart, periodOrigin } | null, draft: ClosureDraft | null, stale: boolean, error: { failKind?: 'failed'|'unverified', message, reqId?, at } | null, baselineAt, closureBaseline, abort: AbortController | null }`。Actions：`open(id)`（→ `loadingScopes` 並打 `scopes`；成功依 `defaultIndex` 自動 `pick()`；失敗 → `scopesError`）、`pick(periodStart, origin)`（**先清空 `draft` 再發請求**，R2.2 → `generating` → `ready`／`draftError`）、`regenerate()`（＝以當前 `selected` 再 `pick()`，新 `draftId`）、`updateField(key, value)`（只允許 data-model §2 的可編輯欄位）、`markStale()`、`commit()`（**全 repo 唯一呼叫 `/closure/commit` 之處**；`writing` 期間 `canCancel === false`；成功 → `leaving`，回傳 `newClosuresSincePanelOpen` 供 UI 提示；失敗 → **回 `ready`** ＋ `error = { failKind, message, reqId, at }`，`draft` 原封不動 —— 四種失敗共用這一條，**沒有 `writeFailed` 狀態**）、`cancel(id)`（`abort?.abort()` 後 `delete`；任何狀態除 `writing`／`leaving` 皆可）、`finish(id)`（寫入且 LEAVE 成功 → `delete`）、`markLeaveFailed(id)`（→ `writtenLeaveFailed`，`draft` 清空 —— FR-047b 區塊已消失）。Getters：`isClosing(id)`、`canCancel(id)`、`hasPending(id)`（供 Sidebar，FR-041）
- [x] T024 [P] [US1] 在 `i18n/locales/zh-TW.json` 新增 `closure.*` 全部文案（憲法 8.5），**逐字取自** `docs/DESIGN_TOKENS.md`：§7.2 第 6 區塊（tag「AI 草稿 · 可修改」、「已進入結案流程」、按鈕六態文字、B7／B8 的 `failTitle`／`failBody`／`failMeta` 樣板、「回報 IT」＋ 按下後的 toast「已複製錯誤資訊，請貼給 IT」—— 後者畫布未定義，由 T040 補的行為所需）、§7.5 選擇器（候選列樣板「{t} 起 · {n} 則」、「超過 500 則」、`never`／`overflow`／`zeroTop`／`regen` 四段提示、「本次摘要涵蓋 {t} 起 · {n} 則」、「自訂起算時間（非結案起點）」、自訂彈窗全部文案）、1c 結案中狀態（標題列「取消結案」「結案中…」「取消結案＝回到已接手狀態，不會留下任何紀錄」「寫入請求已送出，此時無法取消」、Composer 橫幅「結案中 —— 摘要內容為按下結案當下的對話快照，不含此後的新訊息。送出新訊息後，可按「重新產生」把它納入摘要。」、服務模式提示「結案中無法切換服務模式，請先取消結案」、左側「結案未完成」）、§8.5 C1 橫幅三句、FR-044 過期標記「對話有新內容，建議重新產生」、FR-021e 從未結案告知、FR-021h「無法載入結案紀錄」。⚠️ 產生中的忙碌文案 **MUST NOT 含秒數或「約」**（FR-046a；T018 會掃）；⚠️ B8 文案 MUST NOT 含「重試可能產生重複紀錄」（FR-032c）

### 前端元件

- [x] T025 [P] [US1] 新增 `app/components/copilot/ClosureCustomStart.vue`：`role="dialog"` ＋ `aria-label` 取 i18n「自訂起算時間」＋ Esc 關閉（憲法 8.2）；props `{ min: firstMessageAt, max: now }`；月曆（超出範圍 `opacity:0.4` ＋ `cursor:not-allowed`）＋ 時／分輸入 ＋ 「可選範圍：{min}（首次進線）至今」；emit `apply(isoStart)` 對應「以此起算並重新產生」、`close` 對應「取消」。⚠️ 畫布的「約 N 則」預估在本規格**不實作**（需要額外一次掃描；套用後真正的則數會由 `draft.period.messageCount` 呈現），改為不顯示該行 —— 於 `docs/DESIGN_FEEDBACK.md` 記一筆（見 T058）
- [x] T026 [P] [US1] 新增 `app/components/copilot/ClosureScopePicker.vue`（`DESIGN_TOKENS.md` §7.5）：props `{ scopes, selected, state: 'quiet'|'row'|'list' }`；候選列**時間降冪**、`fallback` 獨立墊底（虛線 `--border-dash`）；每列 `{t}` ＋ `{n} 則`（`null && truncated` → 「超過 500 則」；`n > 150` → `--warn` 色）＋ `label`；**0 則列不可選**：`--surface-3` 底 ＋ `circle-slash-2` icon ＋ `cursor:not-allowed` ＋ `tabIndex:-1` ＋ handler 內 `if (n === 0) return`（憲法 8.1：不只靠顏色）；選中列 `--navy` 框 ＋ `circle-dot`；標題列 `role="button"` ＋ `tabIndex` ＋ `aria-expanded`（憲法 8.2）；`never`／`overflow`／`zeroTop` 三態**自動展開**並顯示對應 i18n 提示（`overflowCount` 帶入「另有 {n} 個更早的結案起點未列出」）；唯讀涵蓋說明一行「本次摘要涵蓋 {t} 起 · {n} 則」（**不可省**，FR-021f）；「自訂起算時間」入口**任何狀態都可用**（FR-021e-1），已套用時右側顯示「{t} · 已套用」；emit `pick(start, origin)`
- [x] T027 [US1] 新增 `app/components/copilot/ClosureBlock.vue`（第 6 區塊，`DESIGN_TOKENS.md` §7.2 ⑥；依賴 T023、T026）：置頂列 `flag` icon ＋「已進入結案流程」；tag「AI 草稿 · 可修改」（分隔 U+00B7）；內嵌 `ClosureScopePicker`；**可編輯欄位**：`summary`（textarea）、`intent`（input）、`category`／`resolution`／`sentimentOutcome`（`USelect`，選項取 `config/categories.ts`，**無自由輸入**）、`actionsTaken`（多選）、`citedSopIds`（可移除的 chip）、`followUps`（可增刪列）；**唯讀區**：涵蓋區間一行、`sentimentStart`／`End`／`Trough`（`null` 時顯示 `sentimentNote`，MUST NOT 顯示 0）、`operators`、`joinedAt`；模型留空的受控詞彙欄位顯示「請選擇」提示（FR-015）；`stale` 時顯示過期標記「對話有新內容，建議重新產生」（FR-044，與 Composer 橫幅是兩個獨立呈現）；狀態呈現：`loadingScopes`／`generating`（按鈕收成單一忙碌鍵 ＋ 旋轉 `loader-2`，文案為**產生**語意、無秒數）、`scopesError`（「無法載入結案紀錄」＋ 重試）、`draftError`（錯誤 ＋ 重試，**不呈現空白草稿**）、`ready` 兩顆按鈕「重新產生」／「一鍵寫入 CRM」、`writing`（兩顆皆 `disabled`，主鈕「寫入中…」）。B7／B8 的呈現留給 T040。**`commit` 只能由「一鍵寫入 CRM」的 handler 經 store 呼叫**（T014 會掃）
- [x] T028 [P] [US1] 新增 `app/components/conversation/ClosureLeaveFailedBanner.vue`（C1，`DESIGN_TOKENS.md` §8.5）：頂端橫幅三句文案取 i18n ＋「重試離開」按鈕，emit `retry`；`role="status"`

### 前端組裝

- [x] T029 [US1] 修改 `app/composables/useConversationView.ts`：`closeConversation()` 改為**只呼叫 `useClosureStore().open(conversationId)`**，**刪掉** `/leave` 呼叫與 `viewerJoined = false`／`beat('viewing')`（research #16；FR-005 因此自動成立 —— 客服仍是 JOIN 狀態，分析照常）；**改寫 M3 銜接註解**：原文「插入點在停止分析與隱藏面板之間」改為「停止分析與隱藏面板兩件事都移到寫入成功後的 LEAVE」；新增 `cancelClosing()`（→ `store.cancel()`）、`finishClosure()`（`store.commit()` 成功後呼叫既有 `leave()`；`leave()` 失敗 → `store.markLeaveFailed()`，**MUST NOT 回退結案**，FR-033）、`retryLeaveAfterClosure()`；在既有的新訊息抵達處（SSE `message` 事件 handler）加一行：`if (store.isClosing(id)) store.markStale(id)`（FR-020／FR-044）。⚠️ 保留 `closeConversation` 與 `leave` 為**兩個獨立函式**（003 FR-022a、FR-004）
- [x] T030 [US1] 修改 `app/composables/useCopilotPanel.ts`：新增 `variant: computed<'expanded'|'closing'>`（依 `useClosureStore().isClosing(conversationId)`）；進入 `closing` 時保存五塊的展開組合與捲動位置（`saved = { open, scroll }`，§7.4），全部收合成單行，面板 `scrollTop = 0`；離開 `closing`（取消或寫入成功或 `writtenLeaveFailed`）時**原樣還原**。⚠️ 既有的 `collapsed` 持久化（`localStorage`）不變，`saved` **不**持久化（跟著結案狀態同生共死）
- [x] T031 [US1] 修改 `app/pages/c/[conversationId].vue`（依賴 T027～T030）：① 右欄在 `panel.variant === 'closing'` 時於 ①之前掛 `<CopilotClosureBlock>`，其餘五塊改為收合單行（標題 ＋ tag ＋ 展開箭頭，`role="button"` ＋ `aria-expanded`）；**非結案時第 6 區塊整塊不 render**（FR-047，`v-if` 不是 `v-show`）；② 中欄標題列：結案中把「結案」換成「取消結案」（→ `view.cancelClosing()`）＋「結案中…」＋ 輔助說明「取消結案＝回到已接手狀態，不會留下任何紀錄」；`status === 'writing'` 時「取消結案」`disabled` ＋ `title="寫入請求已送出，此時無法取消"` ＋ 其下一行 `lock` icon ＋ 同句（FR-040a）；③ Composer 上方常駐橫幅（FR-042，文案取 i18n，**輸入框不鎖**）；④ `<ConversationModeSelect>` 結案中 `disabled` ＋ 提示「結案中無法切換服務模式，請先取消結案」（FR-043）；⑤ `status === 'writtenLeaveFailed'` 時頂端掛 `<ConversationClosureLeaveFailedBanner @retry="view.retryLeaveAfterClosure()">`，此時右欄 `variant` 已回 `expanded`（FR-047b）；⑥ `ClosureBlock` 的寫入成功事件 → `view.finishClosure()`
- [x] T032 [US1] 修改 `app/components/conversation/Sidebar.vue`：每列若 `useClosureStore().hasPending(c.id)` 顯示「結案未完成」標記（i18n），**不是**倒數、不是自動寫入（FR-041）；標記隨 store 條目刪除而消失。`SidebarCollapsed.vue` 若有徽章區也同步（沿用未讀徽章的位置）
- [x] T033 [US1] 確認 FR-002／SC-008：逐句對照 `i18n/locales/zh-TW.json` 的 `conversation.exitHint`「離開＝僅退出不寫入 · 結案＝產生摘要供確認後寫入」與 T029 後的實際行為；若 `conversation.closing`（「結案中…」）／`conversation.closeFailed` 的既有語意與新流程不合（例如 `closeFailed` 現在該對應「無法載入結案紀錄」而非「LEAVE 失敗」），**在本規格內改其中一方**，MUST NOT 留下第二筆帳。結果記在 T059 的驗收紀錄

**Checkpoint**: T013～T018 全綠；`npm run typecheck && npm test` 綠；`npm run build && npm run smoke` 綠；quickstart §3 手動走查步驟 1～8 可完成（Board 需先由 T046 建立，或暫以手動建立的 Board 搭配 `IMBRACE_CLOSURE_BOARD_ID`）。**US1 可獨立交付。**

---

## Phase 4: User Story 2 — 重複觸發不製造重複紀錄，也不銷毀服務歷史（Priority: P2）

**Goal**: 同一份草稿（同 `draftId`）重試任意次 → Board 恰好一筆且內容為最後確認版；不同草稿／不同客服／不同時期 → 各自一筆並存；
面板開啟後才出現的他人結案，寫入時**告知**（非攔截）。

**Independent Test**: 對同一份草稿在假 gateway 注入逾時後重試，數 Board 筆數；再以兩份不同 `draftId` 寫入同一對話，數筆數。兩個期望值不同，各自可驗。

- [x] T034 [P] [US2] 新增 `test/closure-idempotency.test.ts`（SC-002、US2 AC#1／1a／2／3／4、契約 R3.4／R3.13、research #22 第 5／6 列）：對假 gateway（T009）以 `board.createButTimeout = { times: 9 }` 注入 → 同一 `draftId` 呼叫 `commitClosure()` 10 次 → `boardItems()` 中 `draft_id` 相符者**恰好 1 筆**，內容為第 10 次送出的版本（第 10 次前改 `summary`，FR-030c），第 10 次 `created === false`；兩份不同 `draftId` 寫同一 `conversation_id` → **2 筆並存**、先寫那筆內容未變；`q` 回多筆但 `draft_id` 不相符（假 gateway 預先塞入 `draft_id` 含相同前綴的他人紀錄）→ 斷言**沒有** `updateItem` 打到那些紀錄、而是 `createItem`（R3.13 反例）；`≥2` 筆相符 → 更新**最早建立**那筆並有 `console.warn`；`listClosuresFor()` 對一批 `closed_at` 與建立順序**相反**的紀錄仍回 `closed_at` 降冪（R1.6 反例）
- [x] T035 [US2] 在 `app/components/copilot/ClosureBlock.vue` 與 `app/stores/closure.ts` 實作 FR-034 的告知：`commit()` 回應的 `newClosuresSincePanelOpen` 非空時，於 `leaving` 前以非阻斷的 `UToast`／inline notice 顯示「{operatorName} 已於 {HH:MM} 完成結案」（i18n），**MUST NOT** 做成需要確認的攔截、MUST NOT 暗示會覆蓋對方（R3.10）；紀錄照常已寫入、流程照常 LEAVE
- [x] T036 [US2] 在 `test/closure-idempotency.test.ts` 補 `newClosuresSincePanelOpen` 的計算斷言：面板開啟當下已存在的紀錄（在 `closureBaseline` 內）**不出現**；開啟後新增的**出現**且帶 `operatorName`／`closedAt`（R3.10）

**Checkpoint**: T034、T036 綠。「把冪等鍵改回 `conversation_id`」會弄紅 T034 的並存斷言；「省略本地比對」會弄紅 R3.13 反例。

---

## Phase 5: User Story 3 — 寫入失敗時，畫面 MUST NOT 顯示成功（Priority: P2）

**Goal**: 四種失敗形態（逾時、4xx、5xx、200 但回查不存在）在前端**走同一個狀態機出口**（回 `ready`、草稿保留、面板不關、不離開），
只有文案與按鈕分 B7／B8；寫入有 30 秒硬上界、期間不可取消；已寫入但 LEAVE 失敗 → 結案視為成功 ＋ C1 橫幅。

**Independent Test**: 故障注入四種形態各 10 次，每次檢查端點回非 2xx、store 回 `ready`、`draft` 逐欄未變、`panelOpen`、回應帶 `reqId`。不需真實 AI（草稿為固定值）。

- [x] T037 [P] [US3] 新增 `test/closure-write-failures.test.ts`（SC-003、契約 §4、FR-032c、FR-035a；**repository 層**）：四種各注入 10 次 —— 逾時（`board.hangMs.create` ＞ repository 逾時；測試以可注入的逾時值縮短，見 T039）、4xx（`board.failWith.create = 422`）、**5xx（`board.failWith.create = 503`，真注入）**：SDK 會退避重試 3 次共約 7 秒且不可關閉，因此 10 次以**不同 `draftId` 用 `Promise.all` 並行**、該 `describe` 以 `{ timeout: 15_000 }` 放寬（只放這一組，MUST NOT 全域放寬），並額外斷言 `boardCallCount('create') === 40`（10 × 4 次嘗試 —— 證明重試耗盡後仍是失敗、而非被吞成成功）、200 但回查不存在（`board.createButHideFromGet = true`）。每次斷言：`commitClosure()` 拋 `ClosureWriteError`、`failKind` 前三種為 `'failed'`、第四種為 `'unverified'`、錯誤含 `reqId`。⚠️ 第四種是本規格最重要的一條測試（R3.5）。
  **store 層**另寫 `test/nuxt/closure-store-failures.test.ts`（⚠️ MUST 放 `test/nuxt/`，理由同 T018）：以 global 注入的 `$fetch` 模擬四種非 2xx 回應（`data.failKind` 分別為 `failed`×3、`unverified`），經 store 的 `commit()` 後 `status === 'ready'`、`draft` 深比較未變、條目仍存在（面板不關）、**沒有**任何 `/leave` 呼叫；四種的 store 狀態轉移**完全相同**（只比 `error.failKind` 不同）
- [x] T038 [P] [US3] 新增 `test/closure-write-timeout.test.ts`（FR-032a、FR-040a）：假 gateway 讓 `createItem` 永不回應 → 斷言 `commitClosure()` 在逾時值內以 `failKind: 'failed'`／`status 504` 失敗（測試注入短逾時，並另有一條斷言正式預設值為 `30_000`）；store 的部分（`writing` 期間 `canCancel === false`，落定後 `status === 'ready'` 且 `canCancel === true`、`draft` 仍在）寫在 T037 的 `test/nuxt/closure-store-failures.test.ts`，以永不 resolve 的 `$fetch` 模擬寫入中
- [x] T039 [US3] 調整 `server/services/closure/board-repository.ts` 的 `commitClosure()` 簽章：新增 `opts.timeoutMs = CLOSURE_WRITE_TIMEOUT_MS`（匯出常數 `30_000`，註解逐字寫明它是 FR-040a「寫入中不可取消」的成立前提，且 **MUST NOT 被 SC-004 的「不設固定秒數」波及**），供 T037／T038 注入短值；確認逾時後**不重試**（客服自己決定要不要重按）
- [x] T040 [US3] 在 `app/components/copilot/ClosureBlock.vue` 實作 B7／B8 兩種失敗態（`DESIGN_TOKENS.md` §7.2「兩種寫入失敗態」）：`error.failKind === 'failed'` → B7：`failTitle`「寫入 CRM 失敗」、`failBody` 逐字、**紅色**主鈕「重試寫入 CRM」＋ `rotate-cw`、次鈕「回報 IT」（**行為**：畫布只定義了按鈕文字 —— 按下後以 `navigator.clipboard.writeText()` 複製 meta 列全文「{HH:mm:ss} {狀態} · {原因}（req {reqId}）」＋ `draftId` ＋ `conversationId`，並以 `UToast` 顯示「已複製錯誤資訊，請貼給 IT」；**MUST NOT** 複製草稿內容（`summary`／`intent` 是客戶對話個資，憲法 1.5 的同一個理由）；不開 mailto、不引入新環境變數）、「重新產生」降為次要；`'unverified'` → B8：「寫入結果無法確認」、`failBody` 逐字（含「請勿當成已完成」與 CRM 查驗步驤）、主鈕「已確認沒有，重試寫入」＋ `shield-check`、**無次鈕**；兩者共用 meta 列 `clock` icon ＋ `{HH:mm:ss} {狀態} · {原因}（req {reqId}）`。⚠️ 兩者只切文案與按鈕，**MUST NOT** 在 store 開第二條狀態路徑（T037 會驗）
- [x] T041 [US3] 驗證 US3 AC#4（已寫入但 LEAVE 失敗）：在 `test/nuxt/closure-store-failures.test.ts`（T037 的 store 層檔案）補一條 —— `commit` 成功後 `/leave` 回 4xx → store `status === 'writtenLeaveFailed'`、`draft === null`（第 6 區塊已消失，FR-047b）、`boardItems()` 仍有該筆（不回退）、`retryLeave()` 成功後條目刪除
- [x] T042 [US3] 確認憑證不外洩（FR-035、R3.11）：在 `test/closure-write-failures.test.ts` 對四種失敗的錯誤訊息與 `data` 斷言不含假 gateway 發出的 token 字串（沿用 `test/smoke-http.ts` 的掃描 regex，抽成共用 helper 於 `test/redact-assert.ts` 若尚無）

**Checkpoint**: T037、T038、T041 全綠；`npm run build && npm run smoke` 綠（動了 `server/services/closure/**`）。

---

## Phase 6: User Story 4 — 環境可重建：Data Board schema 由 script 建立並驗證（Priority: P3）

**Goal**: `npm run board:setup` 建立 Board 與 26 個欄位、可重跑不重複；`npm run board:verify` 逐欄比對**名稱＋型別＋選項**，缺漏逐欄列出並非零離開。

**Independent Test**: 無 Board 的環境跑 setup → 檢查欄位；再跑一次 → 欄位不變兩份；手動刪一欄跑 verify → 被指出。

- [ ] T043 [P] [US4] 新增 `test/closure-board-verify.test.ts`（SC-007 的自動化部分）：對 T044 抽出的純函式 `diffBoardFields(actualFields, CLOSURE_BOARD_FIELDS)` 以 fixture 斷言：齊全 → 空差集；缺 `period_origin`／`period_sentiment_note` → `missing` 逐欄列名與型別；`sentiment_trough` 為 `ShortText` → `typeMismatch` 列出「實際 ShortText，應為 Number」；`category` 選項少「退款進度」→ `optionMismatch` 列出缺的值（B2／B3／B4）
- [ ] T044 [US4] 新增 `scripts/setup-closure-board.ts`（契約 §3／§4）：以 `clientForApiKey()` 執行（該函式註解逐字寫明這是唯一正當用途，憲法 1.3）；讀 `.env.local`（比照 `scripts/spike/lib/harness.ts`）；`--verify` 旗標；流程：① 以 `IMBRACE_CLOSURE_BOARD_ID` 取 board（無此變數且非 verify → `createBoard(CLOSURE_BOARD_NAME)`；**MUST NOT 以名稱查找既有 board**，research #4）；② `getBoard()` 取現有欄位（**不吃快取**，`fieldIdMap(…, { bypassCache: true })`）；③ 純函式 `diffBoardFields()`（匯出供 T043）算 `missing`／`typeMismatch`／`optionMismatch`；④ setup 模式只對 `missing` 逐一 `createBoardField()`（B1：先讀再算差集，MUST NOT 無條件建立），**欄位 id 事後以 `getBoard()` 反查、MUST NOT 取 `createField()` 回傳值**（research #5）；⑤ 輸出逐字比照契約 §4 的形狀，結尾印 `IMBRACE_CLOSURE_BOARD_ID=<id>`（B5）；⑥ 離開碼：齊全 0、有缺／型別不符／選項不符 **非 0**（B2）；**MUST NOT 印出 API key 或 token**（B6）。⚠️ 型別不符與選項不符**只報不改**（改型別可能毀資料；改選項留給人判斷）
- [ ] T045 [P] [US4] 修改 `docs/ARCHITECTURE.md`（plan.md 文件改判義務 #2）：§13.3 欄位表補 `period_origin`（SingleSelection）與 `period_sentiment_note`（ShortText）兩列；§11.5 `ClosureSummary` 補 `periodOrigin: 'closure' | 'first' | 'custom'`，`sentimentStart`／`sentimentEnd`／`sentimentTrough`／`confidence` 改為 `number | null` 並註明 FR-022b 與憲法 4.4 的理由。驗法：`grep -n "period_origin\|period_sentiment_note" docs/ARCHITECTURE.md shared/types/copilot.ts server/services/closure/board-schema.ts specs/006-closure-handoff-summary/contracts/closure-board-schema.md` 四個檔案都命中；`grep -n "sentimentTrough: number$\|confidence: number$" docs/ARCHITECTURE.md` 零結果
- [ ] T046 [US4] **（需使用者知情，正式環境寫入）** 在 `IMBRACE_ENV=stable` 執行 `npm run board:setup` 兩次、`npm run board:verify` 一次，把印出的 `IMBRACE_CLOSURE_BOARD_ID` 寫進 `.env.local`；第二次 setup 斷言欄位數仍為 26；於平台 UI 手動刪除一欄後 `npm run board:verify` 非零離開且逐欄列出；補回該欄。結果（三次輸出）貼進 T059 的驗收紀錄。⚠️ 執行前先向使用者確認

**Checkpoint**: `npm run board:verify` 離開碼 0；T043 綠；四份欄位事實副本（ARCHITECTURE §13.3、`shared/types/copilot.ts`、`board-schema.ts`、契約）一致。

---

## Phase 7: Polish & 跨 Story 事項

**Purpose**: FR-045 的 SHOULD、容量量測 spike、四項人工驗收、跨 spec 熱點複審、正典文件收尾。

### FR-045（SHOULD）：presence「XXX 正在結案」

- [ ] T047 [P] 修改 `shared/types/conversation.ts`：`PresenceEntry` 新增 `closing: boolean`，與 `joined` 並列；註解逐字說明「MUST NOT 做成 `PresenceState` 的第四個值 —— 結案期間打一個字，`composing` 會把 `closing` 蓋掉」（research #18）。**`PresenceState` 維持三值不動**
- [ ] T048 [P] 修改 `server/api/presence.post.ts` 的 Zod `Body` 新增 `closing: z.boolean().default(false)`，並在 `server/services/presence.ts` 的 `reportViewing()`／`snapshotOf()` 帶過 `closing`（跟既有 TTL 走，不持久化；FR-045 的「MUST NOT 讓 FR-040 失效」因此天然成立）
- [ ] T049 修改 `app/composables/useConversationView.ts` 的 `beat()` 心跳送出 `closing: useClosureStore().isClosing(id)`；修改 `app/components/conversation/PresenceBar.vue`：他人 `closing === true` 時顯示「〈某人〉正在結案／你仍可回覆或自行結案」（i18n；`DESIGN_TOKENS.md` 1c「同事視角」），**純提示、不阻擋**（FR-045、憲法 3.3）
- [ ] T050 在 `test/contract-guards.test.ts` 或既有 presence 測試補一條：`PresenceState` 的字面聯集恰為三值（掃 `shared/types/conversation.ts` 該行）；`test/closure-scope-selection.test.ts` 或新測試補：presence 心跳 `composing` 不會把 `closing` 覆寫成 `false`

### 量測與人工驗收

- [ ] T051 [P] 新增 `scripts/spike/30-closure-latency.ts`（research #24 末段）：對真實環境量三段時間 —— `scopes`（候選查詢＋則數掃描）、`draft`（快照＋AI）、`commit`（三步寫入）—— 各 n=5，分短（≤ 10 則）／中（≈ 50 則）／長（≥ 200 則）三種區間，輸出到 `scripts/spike/out/30-*.json`。檔頭註解逐字寫明：**這是容量規劃參考，MUST NOT 回頭變成 SC-004 的驗收門檻**（research #20）。唯讀除了 `commit` 段 —— `commit` 段 MUST 帶 `--yes` 才執行且寫入前印計畫，結案紀錄的 `summary` 以「spike 30 量測用，可刪除」開頭
- [ ] T052 **人工驗收 SC-005（＝ 003 SC-007 重跑，FR-003）**：找 **3 位未參與本專案**的人，只給他們看中欄底部兩顆按鈕與 `conversation.exitHint` 那行文案，**在按下之前**請他們說出「哪一個會留下紀錄」；3/3 通過才算過。結果（受測者代號、回答、日期）記入 T059。⚠️ 這是獨立任務，MUST NOT 被「結案」而非「驗證」（research #23）
- [ ] T053 **人工驗收 US1 AC#3**：開啟結案面板後**完全不操作**放置 10 分鐘，確認 Board 上沒有任何紀錄（無自動化替代 —— 它驗的是「沒有閒置自動寫入路徑」）。結果記入 T059
- [ ] T054 **人工走查 quickstart.md §3**（步驟 1～8 ＋「中途要驗的三件事」）：結案期間送訊息（輸入框不鎖、橫幅在、摘要不自動更新只出過期標記）、切走再回來（Sidebar 標記）、重新整理（等同取消：JOIN 狀態、面板照常、第 6 區塊不見、各區塊重新分析、Board 無紀錄）。⚠️ 走查期間 MUST NOT 編輯 `server/**`。結果記入 T059

### 跨 spec 熱點複審（quickstart.md §4；spec.md 驗收補充要求 2）

- [ ] T055 複審四個熱點檔案並把結論寫入 T059：`app/composables/useConversationView.ts`（003 FR-022a 的獨立行為路徑仍成立、M3 銜接註解已改寫）；`server/services/copilot-analysis.ts`（**沒有**為結案新增第二個門檻條件，003 FR-012 維持單一條件 —— `grep -n "closing\|closure" server/services/copilot-analysis.ts` 零結果）；`test/contract-guards.test.ts`（既有守衛一條都沒被弱化 —— `git diff main -- test/contract-guards.test.ts` 只有新增）；`shared/types/conversation.ts`（`PresenceState` 仍是三值）

### 正典文件收尾

- [ ] T056 [P] 修改 `docs/ARCHITECTURE.md` §18 M3 驗收清單：勾選「摘要可編輯後才寫入 Board」、「重複觸發摘要為覆蓋而非新增」（該行措辭已於 v4.0.0 訂正為「同一草稿冪等、多次結案並存」—— 確認措辭後打勾）、「UI 上已經有一行文案在對客服承諾這個尚未實作的行為」三項；「LEAVE 產生交接摘要、resolved 產生結案摘要，兩者不混用」**標記為不適用並附 FR-017 理由，MUST NOT 打勾**。驗法：`grep -n "兩者不混用" docs/ARCHITECTURE.md` 命中處旁有「不適用」字樣
- [ ] T057 [P] 依 CLAUDE.md「正典文件修改後必須 grep 舊說法」全文掃描並修正殘留：`grep -rn "先 leave\|停止分析 → 隱藏面板\|結案即停止分析" docs/ app/ server/`（M2 階段性行為的描述，除刻意保留的歷史紀錄外一律改寫或加「已由 006 改掉」）；`grep -rn "categories.yaml" docs/`（應零結果，確認未被回退）；`grep -rn "sentimentTrough: number\b" docs/ shared/`（應只剩 `number | null`）；`grep -rn "closeConversation" docs/`（描述須與 T029 後的行為一致）
- [ ] T058 [P] 修改 `docs/DESIGN_FEEDBACK.md`：新增 D-5「自訂起算時間彈窗的『約 N 則』預估在 006 未實作 —— 需額外一次訊息掃描，套用後以 `draft.period.messageCount` 呈現實際則數；請 Design 確認可接受或改為套用後才顯示」（T025 的刻意偏離）；並確認 D-4（`writing` 鎖住標題列取消鍵）已依 T031 實作、若 Design 已回覆則結案該項
- [ ] T059 在 `specs/006-closure-handoff-summary/quickstart.md` 末尾新增「## 6. 驗收紀錄」章節，逐條記錄：SC-001～SC-008 的驗證方式與結果（含 T046、T052、T053、T054、T055 的人工結果與日期）、FR-002／SC-008 的文案對照結論（T033）、`npm run typecheck && npm test && npm run build && npm run smoke` 的最終輸出摘要
- [ ] T060 最終全綠：`npm run typecheck && npm test && npm run build && npm run smoke`；確認 `grep -rn "@imbrace/sdk" app/ shared/` 零結果（憲法 1.2 既有守衛未被破壞）；確認 `git status` 沒有掃進另一個 session 的進行中修改（CLAUDE.md 協作注意）

---

## Dependencies & Execution Order

### Phase 依賴

- **Phase 1（Setup）**：無依賴，可立即開始。T002／T003／T004 可平行，T001 獨立
- **Phase 2（Foundational）**：依賴 Phase 1（T003 的型別、T004 的欄位表）—— **阻塞全部 Story**
  - T005 → T010（倉儲用防腐層）；T004 → T010（倉儲用欄位表）
  - T006 → T008（真 provider 用 schema）
  - T007／T009／T011／T012 彼此獨立
- **Phase 3（US1）**：依賴 Phase 2 全部
  - 測試 T013～T018 先寫（皆 [P]），預期紅
  - Server：T019／T020／T021 彼此獨立（不同檔），T022 依賴三支端點
  - 前端：T023（store）→ T027（Block）→ T031（page）；T024／T025／T026／T028 可平行；T029／T030 依賴 T023；T032 依賴 T023
- **Phase 4（US2）**：依賴 Phase 2 的 T010（倉儲）與 Phase 3 的 T023（store）；T034 可與 Phase 3 前端工作平行
- **Phase 5（US3）**：依賴 T010、T021、T023、T027；T037／T038 可平行先寫；T039 → T037／T038 綠；T040 依賴 T027
- **Phase 6（US4）**：依賴 T004、T005；**與 Phase 3～5 平行**（US1 可暫用手動建立的 Board）；T046 需使用者知情
- **Phase 7（Polish）**：T047～T050 依賴 T023；T051 依賴 Phase 3～5 全部接起來；T052～T055 依賴 US1～US3 完成；T056～T060 最後

### User Story 依賴

- **US1（P1）**：Phase 2 後可開始，不依賴其他 Story
- **US2（P2）**：驗的是 US1 寫入路徑的冪等側面 —— 依賴 T010 與 T023，但測試可獨立於 US1 前端
- **US3（P2）**：驗的是 US1 寫入路徑的失敗側面 —— 依賴 T010、T021、T023、T027
- **US4（P3）**：只依賴 Phase 1／2 的 T004／T005，可與 US1～US3 完全平行

### 每個 Story 內的順序

- 測試先寫並確認**紅**，再實作到綠
- 型別 → schema／service → route → store → 元件 → page 組裝
- 每個 Phase 收尾以 `/commit-split` 分類建立 commit（CLAUDE.md：`/speckit-implement` 期間邊做邊在本檔勾選）

---

## Parallel Example: Phase 2

```bash
# T005 完成後，以下五個可同時進行（不同檔案、互不依賴）：
Task: "T006 server/services/ai/schemas.ts 新增 ClosureDraftAiPartSchema"
Task: "T007 server/services/ai/mock-ai-provider.ts 實作 summarizeClosure()"
Task: "T009 test/mock-gateway.ts 新增 Board 端點與故障注入"
Task: "T011 server/services/closure/sentiment-range.ts"
Task: "T012 server/services/closure/period.ts"
# 然後 T008（依賴 T006）與 T010（依賴 T004、T005）
```

## Parallel Example: US1

```bash
# 六條測試同時寫（全部預期紅）：
Task: "T013 contract-guards G1～G4"
Task: "T014 test/closure-commit-guard.test.ts"
Task: "T015 test/closure-scope-selection.test.ts"
Task: "T016 test/closure-sentiment-range.test.ts"
Task: "T017 test/closure-leave-no-write.test.ts"
Task: "T018 test/nuxt/closure-wait-honesty.test.ts"

# 三支端點同時寫：
Task: "T019 scopes.post.ts"
Task: "T020 draft.post.ts"
Task: "T021 commit.post.ts"

# T023 store 完成後，四個元件／文案同時寫：
Task: "T024 i18n closure.*"
Task: "T025 ClosureCustomStart.vue"
Task: "T026 ClosureScopePicker.vue"
Task: "T028 ClosureLeaveFailedBanner.vue"
```

---

## Implementation Strategy

### MVP First（只做 US1）

1. Phase 1 → Phase 2（T005～T012）
2. Phase 3：T013～T018 先紅 → T019～T033 到綠
3. **停下來驗證**：quickstart §3 手動走查（Board 可先手動建立，或先跑 T044／T046）
4. 此時已可 demo「結案 → 人審 → 寫入 → 離開」整條路徑

### 漸進交付

1. Setup ＋ Foundational → 基礎就位
2. US1 → 獨立測試 → **MVP**
3. US2 → T034／T036 綠 → 冪等驗證通過
4. US3 → T037／T038／T041 綠 → 四種失敗形態都不會顯示成功
5. US4 → T043 綠、T046 在 stable 跑過 → 環境可重建
6. Polish → presence SHOULD、spike 30、四項人工驗收、文件收尾

### 平行分工（多人時）

- Phase 2 完成後：A 做 US1 server（T019～T022）、B 做 US1 前端（T023～T032）、C 做 US4（T043～T046）
- US1 收尾時：A 轉 US2（T034～T036）、B 轉 US3 前端（T040）、C 轉 US3 測試（T037～T039）

---

## Notes

- **[P]** ＝ 不同檔案、不依賴未完成任務
- 每個 Story 都應能獨立完成並獨立驗證；US2／US3 雖依賴 US1 的寫入路徑，但各有自己的測試檔與 SC
- **本規格三項最容易漏的事**（全部不報錯）：① `sentiment*` 留空以「不送該欄位」表達，MUST NOT 送 0；② 冪等查詢 `q` 後 MUST 本地逐字比對 `draft_id`；③ 欄位 id MUST 由 `getBoard()` 反查，MUST NOT 取 `createField()` 回傳
- **不做的事**（plan.md「不新增」）：SSE 事件型別、新 provider 介面、權限模型、刻意阻斷情境、相依套件、平台對話狀態變更、`HandoverSummary`
- 手動驗收（T046、T052～T054）期間 MUST NOT 編輯 `server/**`
- 每個 Phase 收尾 `/commit-split`；勾選變更併入該 Phase 的 commit
