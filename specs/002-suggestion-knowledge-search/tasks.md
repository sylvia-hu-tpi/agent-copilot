---

description: "Task list template for feature implementation"
---

# Tasks: 建議卡與知識庫快查

**Input**: Design documents from `/specs/002-suggestion-knowledge-search/`

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、contracts/、quickstart.md（皆已存在）

**Tests**: 本專案既有慣例是每個功能都補齊對應的 Vitest 單元／整合測試（見 `specs/001-sentiment-panel` 與現有
`test/*.test.ts`），quickstart.md 已列出本功能的「自動化測試對照表」。以下任務因此包含測試任務，但不強制
「先寫測試」的 TDD 順序——沿用本 repo 現有習慣：先落地被測的函式／端點，緊接著補上驗證它的測試。

**Organization**: 依 User Story 分組（P1/P2 見 spec.md），各 Phase 內先 server 後 test 再 app，最後 i18n。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可平行進行（不同檔案、不依賴尚未完成的任務）
- **[Story]**：對應 spec.md 的 US1/US2/US3/US4
- 每個任務都附精確檔案路徑；標示 MODIFIED 的檔案已存在，NEW 為本功能新增

## Path Conventions

沿用專案既有三層結構：`app/`（Nuxt 前端）、`server/`（Nitro BFF）、`shared/`（前後端共用型別）、`test/`（Vitest）。

---

## Phase 1: Setup

- [X] T001 在 [nuxt.config.ts](nuxt.config.ts) 既有的 `NUXT_IMBRACE_*` 橋接表（約第 30-41 行，緊接
  `NUXT_IMBRACE_SENTIMENT_AGENT_ID`）新增兩筆：`NUXT_IMBRACE_KNOWLEDGE_AGENT_ID` → `IMBRACE_KNOWLEDGE_AGENT_ID`、
  `NUXT_IMBRACE_SUGGESTION_AGENT_ID` → `IMBRACE_SUGGESTION_AGENT_ID`（research.md #4）

---

## Phase 2: Foundational（所有 User Story 的阻塞前置工作）

**⚠️ CRITICAL**：本 Phase 完成前不得開始任何 User Story 的實作。

### 型別

- [X] T002 [P] 新增 `shared/types/knowledge.ts`，**一次寫入最終形狀**（data-model.md §2、§5）：
  `KnowledgeHit`（`id`/`title`/`snippet`/`score: number | null`/`updatedAt: string | null`/`sourceRef`）、
  `KnowledgeProvider`（`search(query, opts?: { topK?: number, fileId?: string, timeoutMs?: number }): Promise<KnowledgeHit[]>`
  —— `fileId` 供「展開全文」限定檔案內搜尋（US2／research.md #3），`timeoutMs` 供 SC-002 的逾時保障；
  **不設 `channel` 選項**，本功能無任何使用者）、`KnowledgeSearchRequest`（`{ query: string, expandRef?: string }`）、
  `KnowledgeSearchResponse`（`{ hits: KnowledgeHit[], degraded?: boolean }`）
- [X] T003 修改 `shared/types/copilot.ts`：新增 `SuggestionCard`（`id`/`sopId`/`sopTitle`/`text`/
  `confidence: number | null`/`rationale`/`tone`/`requiresData`/`supersededBy`，data-model.md §1.1）與
  `SuggestionBlock`（`status`/`retryAttempt?`/`firstFailureAt?`/`cards`/
  **`knowledgeSearch: { ran: boolean, hitCount: number }`**/`updatedAt`，§1.1——⚠️ 必須是兩個欄位，
  單一計數無法分辨「沒查」與「查了 0 命中」，那是憲法 6.2 v3.0.1 要求的可稽核證據）；
  在 `AIProvider` 介面新增 `suggest(input: { history, knowledgeHits: KnowledgeHit[], aiReplies: boolean }): Promise<SuggestionCard[]>`
  （data-model.md §1.2）；**同時刪除第 118-121 行「`suggest` 不在本功能範圍內，介面上刻意省略」的過期註解**
  （CLAUDE.md「正典文件修改後必須 grep 舊說法」的程式碼註解版本）（依賴 T002 的 `KnowledgeHit`）
- [X] T004 修改 `shared/types/events.ts`：`CopilotEvent` 新增
  `{ type: 'suggestion.updated', conversationId: string, suggestion: SuggestionBlock }` 成員（contracts/copilot-suggestion-events.md）；
  **同時把第 65 行「M3 的 suggestions 屆時再加」的過期註解改為反映本功能已落地**（依賴 T003）
- [X] T005 [P] 修改 `server/state/types.ts`：`CopilotAnalysisState` 新增 `suggestionBlock: SuggestionBlock` 欄位
  （data-model.md §3.1）；`StateStore` 介面新增三個 async 方法 `addJoinedConversation(operatorId, conversationId)`／
  `removeJoinedConversation(operatorId, conversationId)`／`listJoinedConversations(operatorId): Promise<string[]>`
  （data-model.md §3.2，供 research.md #8 的背景 watch 復原使用）（依賴 T003 的 `SuggestionBlock`）
- [X] T006 修改 `server/state/memory-store.ts`：實作 T005 新增的三個 `StateStore` 方法，內部用
  `Map<operatorId, Set<conversationId>>`，**不設 TTL**（JOIN/LEAVE 是明確操作，data-model.md §3.2 理由）；
  `addJoinedConversation`/`removeJoinedConversation` 需冪等（依賴 T005）
- [X] T051 修改 `server/api/conversations/[id]/join.post.ts`：JOIN 成功後呼叫
  `store.addJoinedConversation(session.operatorId, ctx.id)`（依賴 T006）
- [X] T052 修改 `server/api/conversations/[id]/leave.post.ts`：LEAVE 成功後呼叫
  `store.removeJoinedConversation(session.operatorId, ctx.id)`（依賴 T006）

  > ⚠️ T051／T052 的 ID 屬 US4 區段，但**刻意置於 Foundational**：它們是
  > `listJoinedConversations()` 的唯一寫入端，US2 的 T035（Phase 4）與 US4 的 T056 都是讀取端。
  > 留在 Phase 6 會讓 US2 的 JOIN 門檻恆回 403。ID 不重編，避免依賴關係全面位移。
- [X] T007 [P] 修改 `server/sources/types.ts`：`MessageSource` 介面新增 `getPriority(conversationId: string): WatchPriority`
  （research.md #9）
- [X] T008 修改 `server/sources/polling-message-source.ts`：實作 `getPriority()`，直接回傳
  `this.aggregateState(entry).priority`（對應既有私有方法，約第 209-217 行），對話目前無任何訂閱者時回傳
  `'background'`（安全預設）；並於 `test/message-source.test.ts` 新增對應測試（依賴 T007）

### 知識庫檢索

- [X] T009 [P] 新增 `server/services/knowledge/agent-knowledge-provider.ts`：`AgentKnowledgeProvider implements KnowledgeProvider`，
  呼叫知識庫 agent 的 `streamChat()`、過濾 `tool-output-available` 且 `toolName === 'RAGknowledge'` 的事件，
  以正則 `/\[Source: ([^\]]+)\]\n([\s\S]*?)(?=\n\[Source: |$)/g` 切出 chunk、對檔名做兩次 `decodeURIComponent()`、
  比對 `folder_info.folders[].files[].name` 取得 `id`（比對不到時退回檔名雜湊）、以正則
  `/_V\d+_(\d{4})(\d{2})(\d{2})_/` 嘗試擷取 `updatedAt`（擷取不到為 `null`）、清理檔名版本/日期/可見範圍後綴
  作為 `title`、`score` 恆為 `null`（research.md #1、#2）；**`search()` MUST 套用逾時**——
  匯出常數 `KNOWLEDGE_SEARCH_TIMEOUT_MS = 8_000`（plan.md Constraints：短於 SC-002 的 10 秒門檻），
  `opts.timeoutMs` 可覆寫，逾時即拋錯交由呼叫端降級（**不重試**：檢索失敗時 FR-004 允許以空集合續行，
  重試只是再等一次）（依賴 T002）
- [X] T010 [P] 新增 `server/services/knowledge/mock-knowledge-provider.ts`：`MockKnowledgeProvider implements KnowledgeProvider`，
  回傳固定樣本 `KnowledgeHit[]`，比照 `server/services/ai/mock-ai-provider.ts` 的故障開關模式提供
  `MockKnowledgeProviderOptions`（`searchDelayMs?`/`searchFailure?: () => Error | null`）供測試用（依賴 T002）
- [X] T011 新增 `server/services/knowledge/index.ts`：`useKnowledgeProvider()`/`setKnowledgeProvider()` 裝配入口，
  比照 `server/services/ai/index.ts` 的 `envVar()` 雙鍵名讀法與 globalThis 單例模式；讀取
  `NUXT_IMBRACE_KNOWLEDGE_AGENT_ID`/`IMBRACE_KNOWLEDGE_AGENT_ID`（連同既有 API_KEY/ORG_ID），缺憑證時退回
  `MockKnowledgeProvider` 並印警告（research.md #4）（依賴 T009、T010）

### AI 建議卡生成

- [X] T012 修改 `server/services/ai/schemas.ts`：新增 `SuggestionCardSchema`（Zod；`tone` 用 `z.enum`、
  `confidence`/`sopId`/`sopTitle` 為 `.nullable()`）與 `parseSuggestionCards(raw): SuggestionCard[]`，**單張卡片**
  驗證失敗即跳過（不使整批失敗，比照既有 `riskFlags` 容錯精神，research.md #6）。
  ⚠️ schema 的 `.nullable()` **允許數字通過**，擋不住模型自評的 `confidence`——憲法 4.4 的強制歸零
  在 T018 落實，不要以為宣告成 nullable 就完事（依賴 T003）
- [X] T013 [P] 修改 `server/services/ai/mock-ai-provider.ts`：新增 `suggest()` 方法與對應的
  `suggestDelayMs?`/`suggestFailure?`/`invalidSuggestOutput?` 故障開關（比照既有 `summarize`/`analyzeSentiment`
  的 `MockAIProviderOptions` 模式），回傳固定樣本 `SuggestionCard[]`（依賴 T003）
- [X] T014 [P] 修改 `server/services/ai/imbrace-agent-provider.ts`：`ImbraceAgentProvider` constructor 新增
  `suggestionAgentId` 參數；新增 `suggest()` 方法，組 prompt（客戶發言 history + 傳入的 `knowledgeHits` 列表 +
  `aiReplies` 旗標，見 research.md #4「不掛 Knowledge Hub，hits 由呼叫端先查好傳入」），沿用既有
  `extractLeadingJson()`/`callAgent()` 的解析與錯誤處理模式。prompt MUST 明示三件事：
  ① **最多產出 5 張卡**（`docs/ARCHITECTURE.md` §14.6 的 3–5 張上限於生成階段落實，FR-001——
  不做事後截斷，截掉的卡片已經付出過呼叫成本）；
  ② `sopId` 只能從傳入的 `knowledgeHits` 的 `id` 中選，或填 `null`（憲法 4.3，後端仍會後驗）；
  ③ 無法確認的具體資料走 `requiresData`，不得編入 `text`（憲法 4.5）。
  ⚠️ 組 prompt 時訊息內容一律取 `Message.text`，**MUST NOT** 讀 `caption`（憲法 6.5／FR-017——
  `caption` 是上傳時的原始檔名，客戶上傳時為空）（依賴 T003）
- [X] T015 修改 `server/services/ai/index.ts`：`createProvider()` 新增讀取
  `NUXT_IMBRACE_SUGGESTION_AGENT_ID`/`IMBRACE_SUGGESTION_AGENT_ID`，缺憑證時的警告訊息一併列入，並把
  `suggestionAgentId` 傳入 `new ImbraceAgentProvider(...)`（依賴 T014）

**Checkpoint**：Foundation ready —— 型別、`KnowledgeProvider`、`AIProvider.suggest()`、`StateStore` 新方法皆已就緒，
可開始 User Story 實作。

---

## Phase 3: User Story 1 - JOIN 後取得可一鍵帶入的建議回覆卡 (Priority: P1) 🎯 MVP

**Goal**：客服 JOIN 對話後，系統依對話內容與知識庫檢索結果自動產生建議回覆卡，一鍵帶入 Composer（仍受既有撞單檢查約束）。

**Independent Test**：JOIN 一段已有客戶發言的對話，驗證建議卡出現且含可送出全文、一鍵帶入後 Composer 出現該文字且可編輯、送出仍走既有撞單檢查。

### Server

- [X] T016 [US1] 修改 `server/services/copilot-analysis.ts`：`AnalysisBlock` 型別擴充為
  `'summary' | 'sentiment' | 'suggestions'`；`beginAnalyzing()`/`publishRetrying()`/`finishBlockError()`/
  `publishBlock()`（約第 130-243 行）各自新增第三個分支，讀寫 `state.suggestionBlock` 並 publish
  `{ type: 'suggestion.updated', conversationId, suggestion }`
- [X] T017 [US1] 修改 `server/services/copilot-analysis.ts`：新增純函式
  `whitelistFilter(cards: SuggestionCard[], hits: KnowledgeHit[]): SuggestionCard[]`——`sopId === null` 或存在於
  `hits` 的 `id` 集合中才保留，否則整卡捨棄（不只清空 `sopId`，research.md #6、FR-003、憲法 4.3）
- [X] T018 [US1] 修改 `server/services/copilot-analysis.ts`：新增
  `analyzeSuggestions(conversationId, input: { history: Message[], aiReplies: boolean })`——以 `history` 中
  `sender.type === 'customer'` 的最近幾則 `.text`（**不得使用 `caption`**，FR-017）串接為查詢字串，呼叫
  `useKnowledgeProvider().search(query, { topK: 5 })`（research.md #5；逾時 8 秒由 provider 內建，T009）
  → 經 `withRetry()` 呼叫 `useAIProvider().suggest({ history, knowledgeHits, aiReplies })` →
  `parseSuggestionCards()`（T012）→ `whitelistFilter()`（T017）→ **`forceNullConfidence()`** →
  寫入 `suggestionBlock` 並 publish；套用與 `analyzeSummary()` 相同的 `beginAnalyzing`/失敗處理模式。
  三個易漏的細節：
  - **`confidence` 強制歸零（憲法 4.4、FR-002）**：`knowledgeHits.every(h => h.score === null)` 時，
    寫入前 MUST 把每張卡的 `confidence` 覆寫為 `null`。iMBrace 路徑的 `score` **恆為 null**，
    等於這條每一次都會觸發；Zod 的 `.nullable()` 擋不住模型自評的數字（T012），只靠 prompt 交代
    等同沒有規則。抽成純函式 `forceNullConfidence(cards, hits)` 以便 T025 單獨測。
  - **`knowledgeSearch` 兩個欄位**：檢索呼叫**送出後**即 `ran: true`（無論結果多寡或是否拋錯），
    `hitCount: knowledgeHits.length`。憲法 6.2 v3.0.1 禁止的是「略過檢索」，不是「結果是空的」——
    這個欄位就是該條要求的可稽核證據，不得簡化回單一計數。
  - **檢索失敗不使整塊轉 error**：`search()` 拋錯時捕捉、以 `knowledgeHits = []` 續行生成
    （FR-004 的誠實降級），`ran` 仍為 `true`
- [X] T019 [US1] 修改 `server/services/copilot-analysis.ts`：`runColdStart()`／`runIncremental()`／`retryBlock()`／
  `scheduleIncremental()` 簽章新增 `aiReplies: boolean` 參數並沿呼叫鏈往下傳；`runColdStart()`/`runIncremental()`
  的 `Promise.all()` 加入 `analyzeSuggestions()`（與 summary/sentiment 併行）；`retryBlock()` 的
  `block === 'suggestions'` 分支呼叫 `analyzeSuggestions(conversationId, { history, aiReplies })`（FR-001、
  FR-016、FR-024）
> ⚠️ **T020／T021／T022 共同約束（FR-016）**：`aiReplies` 一律以既有的
> `controlFromMode(mode).aiReplies` 推導（`shared/types/conversation.ts`），**MUST NOT** 寫成
> `mode === 'hybrid'`。兩式在 `automation` 與 `null`（從未 JOIN）兩種 mode 下結論不同，
> 且不會有任何型別錯誤——這正是 §10.2／§10.6 記錄過的靜默失效地雷。

- [X] T020 [US1] 修改 `server/api/conversations/[id]/join.post.ts`：`triggerColdStartIfNeeded()` 呼叫
  `runColdStart()` 時傳入 `aiReplies: controlFromMode(mode).aiReplies`
- [X] T021 [US1] 修改 `server/services/session-manager.ts`：`onMessages()`（約第 184-216 行）呼叫
  `scheduleIncremental()` 前，一次算齊**兩個**新參數並傳入——
  `aiReplies`（`controlFromMode(runtime.listPoller.latest(conversationId)?.mode).aiReplies`）與
  `priority`（`runtime.messageSource.getPriority(conversationId)`，T008）。
  ⚠️ 兩者刻意在同一個任務完成：它們改的是同一個呼叫點的同一行，拆成兩個 Phase 只會讓第二次動工時
  得重讀第一次的成果（`priority` 在 T047／T048 之前不會產生行為差異，提前傳入無害）
  （依賴 T008、T019）
- [X] T022 [US1] 修改 `server/api/conversations/[id]/copilot/retry.post.ts`：`Body.block` 的 `z.enum` 新增
  `'suggestions'`；`targetStatus` 查表新增 `state.suggestionBlock.status` 分支；呼叫 `retryBlock()` 前以
  `controlFromMode(useCopilotRuntime(session.orgId).listPoller.latest(conversationId)?.mode).aiReplies`
  算出 `aiReplies` 一併傳入（contracts/copilot-suggestion-events.md「重試 API 契約擴充」）
- [X] T023 [US1] 修改 `server/api/stream.get.ts`：`sendAnalysisSnapshotAndResume()`（約第 148-167 行）新增
  `await send({ type: 'suggestion.updated', conversationId, suggestion: analysisState.suggestionBlock })`
  （contracts/copilot-suggestion-events.md「重連快照」）

### Server 測試

- [X] T024 [P] [US1] 新增 `test/agent-knowledge-provider.test.ts`：以 fixture
  `scripts/spike/out/11-宏宏企業-knowledge-raw.json` 驗證 chunk 切分、雙重 `decodeURIComponent()`、
  `folder_info` id 比對、`updatedAt` 正則擷取（含擷取不到回傳 `null` 的情境）、`title` 清理後綴
  （research.md #1、#2）
- [X] T025 [P] [US1] 新增 `test/suggestion-whitelist.test.ts`：`whitelistFilter()`——合法 `sopId` 保留、
  不在白名單的 `sopId` 整卡捨棄（非僅清空欄位）、`sopId === null` 一律保留、全數捨棄後回傳空陣列；
  併測 `forceNullConfidence()`（T018）——hits 全數 `score === null` 時，模型回傳的 `confidence: 87`
  MUST 被覆寫為 `null`（憲法 4.4、FR-002）
- [X] T026 [US1] 修改 `test/copilot-analysis.test.ts`：新增 US1 案例——冷啟動的 `Promise.all()` 含
  `analyzeSuggestions()`；`knowledgeHits` 為空時建議卡仍以 `sopId: null` 產生（不因空檢索而不產生建議卡，
  對照 FR-004 與 FR-019 的差異見 data-model.md §1.1 `knowledgeSearch` 註解）；單張卡片 schema 驗證失敗時
  僅該卡被跳過、其餘卡片仍然 ready；全數白名單捨棄後 `status` 仍為 `'ready'`、`cards: []`；
  **`knowledgeSearch.ran` 在每一條成功路徑上皆為 `true`**（憲法 6.2 v3.0.1 的可稽核證據）；
  **含附件的訊息輪只以 `Message.text` 進入 prompt，`caption` 不出現在送給模型的內容裡**（FR-017、憲法 6.5）
- [X] T026a [P] [US1] 新增 `test/suggestion-send-path.test.ts`（SC-004 明文要求以自動化測試驗證）：
  以建議卡「一鍵帶入」與快查「插入為回覆」兩條路徑寫入草稿後送出，斷言 `POST /api/messages` 攜帶的
  `lastMessageId` 版本錨點與客服手動輸入時**完全一致**，撞單檢查照常觸發、無任何繞過路徑
  （FR-006、憲法 7.2／3.3①）。⚠️ 這是本功能唯一直接觸及「刻意阻斷封閉集合」的保證，
  不可只靠 quickstart 的手動步驟

### App

- [X] T027 [P] [US1] 修改 `app/composables/useCopilotSession.ts`：新增 `emptySuggestionBlock()`
  （`status: 'empty'`、`cards: []`、`knowledgeSearch: { ran: false, hitCount: 0 }`——尚未查過，
  `ran` 為 `false` 在此是正確的：憲法 6.2 管的是「生成建議卡時不得略過檢索」，不是「初始狀態」）、
  `suggestions: Ref<SuggestionBlock>`，`handle()` 新增 `case 'suggestion.updated'`，`retry()` 的參數型別擴充納入
  `'suggestions'`，切換對話時一併重置為 empty
- [X] T028 [P] [US1] 新增 `app/components/copilot/SuggestionCard.vue`：五態呈現（比照
  `app/components/copilot/SummaryCard.vue` 的模式，`status` 為 `empty`/`analyzing`/`retrying`/`ready`/`error`），
  `ready` 狀態顯示 `text`/`sopTitle`（null 時顯示「未引用知識庫」）/`tone` 標籤/`confidence`（null 時留空不顯示）/
  `requiresData` 清單；「一鍵帶入」按鈕 emit `insert` 事件並帶出 `card.text`（**不含 `rationale`**，
  contracts/copilot-suggestion-events.md）。
  ⚠️ 元件檔頭註解 MUST 寫明兩條負向約束及其理由，讓它們留在程式碼裡而不只留在規格裡：
  **FR-026**（卡片內容不得逐字串流——與憲法 4.3「顯示前驗證、驗不過整張捨棄」不相容，
  串流會讓客服看著讀到一半的卡整張消失）與 **FR-002／憲法 4.4**（`confidence` 為 `null` 時留空不顯示，
  不得改用「—」以外的任何估算或替代數字）
- [X] T029 [US1] 新增 `app/components/copilot/SuggestionList.vue`：掛載 `SuggestionCard.vue` × `cards.length`，
  區分「尚無資料」（`status==='empty'`，FR-014）／「產生中」（`analyzing`/`retrying`，含
  `retryAttempt` 顯示「重試中 (n/2)」）／「本次未產生建議」（`ready` 且 `cards.length===0`，中性文案，非錯誤）／
  「暫時無法產生建議」（`error`，含重試按鈕 emit `retry`）四種可互相區分的狀態；卡片數超出可視高度時捲動而非截斷
  （spec.md Edge Cases）。
  第三種狀態底下有兩種語意（`knowledgeSearch.hitCount === 0` = 知識庫沒這題／`> 0` = 有命中但引用
  全遭白名單捨棄）：**對客服的呈現一致**（都是中性空狀態），但 MUST 分別記錄——後者是模型杜撰引用的
  訊號，需要調 prompt（data-model.md §7 對照表）。
  ⚠️ 依 **FR-024**，`ready` 狀態下 MUST NOT 出現任何一般性的「重新產生」按鈕；重試按鈕只在
  `error` 狀態可用（失敗的結果不進快取，重試才真的會重新呼叫）。元件註解寫明此約束與理由
  （§11.3 的快取鍵 `{conversationId}:{lastMessageId}` 使同一狀態不會產生不同結果，
  任何「重新產生」都只是給出系統做不到的承諾）（依賴 T028）
- [X] T030 [US1] 新增 `app/composables/useOverwriteConfirm.ts`：共用確認流程（research.md #11、FR-018、憲法
  8.4）——`request(text: string)`：若當前草稿非空白，設定 `pending.value = text` 等待確認；空白則直接呼叫
  `onApply(text)`；`confirm()`/`cancel()` 控制 `pending` 的解除；供 `SuggestionCard.vue` 的「一鍵帶入」與（US2）
  `KnowledgeSearch.vue` 的「插入為回覆」共用，不使用瀏覽器原生 `confirm()`（需可鍵盤操作）
- [X] T031 [US1] 修改 `app/pages/c/[conversationId].vue`：在右欄既有 `CopilotSummaryCard`/`CopilotSentimentGauge`
  下方掛載 `<CopilotSuggestionList>`；以 `useOverwriteConfirm()` 包裝草稿寫入，`request()` 的
  `onApply` 呼叫 `draft.text.value = text`；`pending` 非 null 時顯示 inline 確認 UI（沿用 `ac-alert-warn`
  樣式慣例，含「覆蓋」/「取消」兩個可鍵盤操作按鈕）（依賴 T029、T030）
- [X] T032 [US1] 修改 `i18n/locales/zh-TW.json`：新增 `copilot.suggestion.*`（title/empty/analyzing/updating/
  retrying/error/readyEmpty/insert/tone 各列舉值標籤/requiresData 標籤/未引用知識庫文案）與
  `copilot.draftOverwrite.*`（confirm/cancel/message）鍵值

**Checkpoint**：User Story 1 完整可獨立驗收（quickstart.md US1 場景）。

---

## Phase 4: User Story 2 - 知識庫自然語言快查 (Priority: P2)

**Goal**：客服可隨時以自然語言查詢知識庫，結果可插入回覆或展開全文，與建議卡是否已產生無關。

**Independent Test**：輸入自然語言查詢，驗證結果列表含標題與更新日期、可插入或展開、查無結果時有明確狀態。

### Server

- [x] ~~T033 修改 `shared/types/knowledge.ts` 新增 `fileId`／`degraded`~~ —— **已併入 T002**
  （同一個檔案在同一個功能內建立後隔 31 個任務又自我翻修，沒有理由；T002 直接寫入最終形狀，
  含 `fileId`／`timeoutMs`／`expandRef`／`degraded`）。**ID 保留不重編**，避免其餘 60 餘個任務與
  依賴關係全部位移
- [X] T034 修改 `server/services/knowledge/agent-knowledge-provider.ts`：`search()` 支援 `opts.fileId`——
  有值時將其作為 `RAGknowledge` 工具呼叫的 `document_file_ids` 輸入參數（research.md #3）（依賴 T002、T009）
- [X] T035 新增 `server/api/conversations/[id]/knowledge-search.post.ts`：Zod body
  `{ query: z.string(), expandRef: z.string().optional() }`；`query` 空白或僅空白字元 → 直接回傳
  **200** `{ hits: [] }`（**不是 400**——那是「尚未查詢」，不是用戶端錯誤），**不呼叫** `KnowledgeProvider`（FR-008）；以
  `(await store.listJoinedConversations(session.operatorId)).includes(conversationId)` 判斷 JOIN，未 JOIN →
  403 `{ message: '需先加入對話' }`（FR-025）；呼叫 `useKnowledgeProvider().search(query, { topK: 5, fileId: expandRef })`，
  逾時（8 秒，T009）或拋錯時捕捉並回傳 200 `{ hits: [], degraded: true }`（**不得回 5xx**，
  contracts/knowledge-search-api.md）
  （依賴 T011、T034、**T051**——JOIN 門檻查的是 `listJoinedConversations()`，
  若寫入端 T051 尚未完成，本端點會恆回 403；T051／T052 已因此前移至 Phase 2）

### Server 測試

- [X] T036 [P] [US2] 新增 `test/knowledge-search-api.test.ts`：空白查詢不呼叫 provider 且回傳 200 `{hits:[]}`；
  未 JOIN 回 403；provider 拋錯回 200 `{hits:[],degraded:true}`；**provider 逾時（超過
  `KNOWLEDGE_SEARCH_TIMEOUT_MS`）同樣回 200 `{hits:[],degraded:true}` 而非無限等待**（SC-002 的
  10 秒門檻靠這個上限成立）；`expandRef` 有值時 provider 收到對應 `fileId`
  （contracts/knowledge-search-api.md）

### App

- [X] T037 [P] [US2] 新增 `app/composables/useKnowledgeSearch.ts`：輸入 debounce 300ms；到期時輸入為空白 →
  不送請求並清空既有結果、回到「尚未輸入查詢」狀態（非「查無結果」）；以遞增請求序號比對避免競態下舊回應覆蓋新查詢
  （contracts「前端契約」）；暴露 `query`、`hits`、`loading`、`error`、`degraded`、`hasQueried`（是否曾送出過非空白查詢，
  供 UI 區分「尚未輸入查詢」vs「查無相關結果」）、`search()`、`expand(sourceRef: string)`（呼叫同一端點並帶
  `expandRef`）
- [X] T038 [US2] 新增 `app/components/copilot/KnowledgeSearch.vue`：輸入框 + 結果列表（`title`、`updatedAt`
  或「更新日期未知」、超過 12 個月標示過舊提醒，FR-009；**不顯示** `score` 或任何編號）；每筆結果「插入為回覆」
  （`hit.snippet` 原文，經 T030 的 `useOverwriteConfirm()`，不經 AI 改寫，FR-022）／「展開全文」（呼叫
  `expand()`，inline 顯示於目前對話視窗內、不使用彈出視窗，附註「本次可取得的相關內容，可能未涵蓋完整文件」，
  research.md #3）；四種可互相區分的狀態：尚未輸入查詢／查無相關結果（FR-011）／錯誤(`degraded`)+重試／
  需先 JOIN（依賴 T030、T037）
- [X] T039 [US2] 修改 `app/pages/c/[conversationId].vue`：在右欄掛載 `<CopilotKnowledgeSearch>`（依賴 T038）
- [X] T040 [US2] 修改 `i18n/locales/zh-TW.json`：新增 `copilot.knowledgeSearch.*`（placeholder/empty/noResults/
  notJoined/degraded/insert/expand/expandDisclaimer/staleWarning/updatedAtUnknown 等）鍵值

**Checkpoint**：User Story 1、2 皆可獨立運作。

---

## Phase 5: User Story 3 - AI 或知識庫故障時仍能正常對話 (Priority: P1)

**Goal**：建議卡生成或知識庫檢索故障時，訊息流與 Composer 不受影響，僅受影響區塊顯示錯誤與重試。

**Independent Test**：模擬建議卡或知識庫檢索呼叫失敗，驗證訊息流可讀、輸入框可送出、僅受影響區塊顯示錯誤狀態。

> 大部分故障隔離保證已由 US1/US2 沿用既有五態機（`beginAnalyzing`/`finishBlockError`）與
> `knowledge-search.post.ts` 的 `degraded` 欄位結構性達成；本 Phase 補齊故障注入開關與明確的隔離測試。

- [x] ~~T041／T042「確認故障開關可獨立運作」~~ —— **已併入 T043**
  （兩者沒有產出物、只是複述 T013／T010 的驗收條件；「開關互不影響」是可斷言的行為，
  應該是測試而不是一個待辦。T043 的兩個案例本身就會證明它）
- [X] T043 [US3] 修改 `test/copilot-analysis.test.ts`：新增 US3 案例——`analyzeSuggestions()` 的
  `AIProvider.suggest()` 失敗時僅 `suggestionBlock.status` 轉 `'error'`，`summaryBlock`/`sentimentBlock`
  不受影響（反之亦然）；`KnowledgeProvider.search()` 失敗（拋錯）時 `analyzeSuggestions()` **不**整塊轉
  `error`，改為以空 `knowledgeHits` 繼續呼叫 `AIProvider.suggest()`、產生不含引用的通用建議
  （US1 AC#4／FR-004；此時 `knowledgeSearch` MUST 為 `{ ran: true, hitCount: 0 }`——憲法 6.2 v3.0.1
  禁止的是「略過檢索」，不是「檢索結果是空的」，見 data-model.md §1.1）。
  併入原 T041／T042 的驗收：斷言 `suggestDelayMs`／`suggestFailure`／`invalidSuggestOutput` 與
  `summarizeFailure`／`sentimentFailure`／`searchFailure` **彼此獨立**——只開 `searchFailure` 時
  `MockAIProvider.suggest()` 本身仍成功（這正是上述「檢索失敗但生成可用」情境的前提）
- [X] T044 [US3] 修改 `test/knowledge-search-api.test.ts`（T036）：新增斷言——空白查詢／未 JOIN／`degraded`／
  正常查無結果四種狀態的回應形狀彼此互斥且可區分（呼應 FR-011、FR-025 與 contracts 的四態要求）
- [X] T045 [US3] 修改 `test/realtime-http.ts`：擴充 smoke:realtime 場景，注入建議卡生成與知識庫檢索故障，
  斷言訊息流仍可讀、`POST /api/messages` 送出不被阻擋或延遲（SC-003），僅對應 SSE 事件／HTTP 回應顯示錯誤狀態

**Checkpoint**：User Story 1、2、3 皆可獨立運作，故障情境下主線不受影響。

---

## Phase 6: User Story 4 - 對話持續進行時建議卡保持最新 (Priority: P2)

**Goal**：新訊息或他人／AI 回覆抵達時重新評估既有建議卡；已 JOIN 但非聚焦的背景對話也持續重算情緒與建議卡
（不含摘要），並受並行上限與 debounce 節流；客服切回背景對話時立即看到已更新結果，摘要才補跑。

**Independent Test**：在已顯示建議卡的對話中注入新客戶發言或觸發 AI 自動回覆，驗證既有建議卡被重新評估、
重複內容被標示或移除；背景對話以「切走注入新發言、再切回」驗證同樣行為，並涵蓋 §11 的並行上限與 debounce。

### 背景並行與 debounce

- [X] T046 [US4] 修改 `server/services/copilot-analysis.ts`：新增 globalThis-keyed 模組狀態
  `backgroundInFlight: Set<string>`（conversationId）與常數 `BACKGROUND_CONCURRENCY_LIMIT = 10`、
  `BACKGROUND_DEBOUNCE_MS = 8_000`（data-model.md §8、research.md #9）
- [X] T047 [US4] 修改 `server/services/copilot-analysis.ts`：`scheduleIncremental(conversationId, customerMessages, priority, aiReplies)`——
  `priority === 'foreground'` 沿用既有 `DEBOUNCE_MS = 1_000`，`'background'` 改用 `BACKGROUND_DEBOUNCE_MS`；
  `debounceTimers` 的 entry 一併保存 `priority`/`aiReplies`（依賴 T046）
- [X] T048 [US4] 修改 `server/services/copilot-analysis.ts`：`runIncremental(conversationId, newCustomerMessages, priority, aiReplies)`——
  `priority === 'background'` 時，若 `backgroundInFlight.size >= BACKGROUND_CONCURRENCY_LIMIT` 且本對話不在
  集合中，**不執行**，改為以相同長度重新排一次 debounce（保留 pending，不清空，不顯示為錯誤，spec.md Edge
  Cases）；否則執行前加入 `backgroundInFlight`、`finally` 移出；`priority === 'background'` 時**跳過**
  `analyzeSummary()` 呼叫（FR-020），僅執行 `analyzeSentimentBatch()` 與 `analyzeSuggestions()`（FR-019）
  （依賴 T046、T047）
- [X] T049 [US4] 修改 `server/services/copilot-analysis.ts`：新增
  `catchUpSummaryIfStale(conversationId: string, history: Message[]): Promise<void>`（research.md #10）——
  比對 `state.summaryBlock.summary?.basedOnMessageId` 與 `history` 中尚未涵蓋的客戶發言，無新發言時 no-op；
  有新發言時先發布 `summaryBlock.status = 'analyzing'`（保留舊內容），再呼叫既有 `analyzeSummary()`

### 訂閱與 presence 修正（research.md #8）

- [x] ~~T050 `session-manager.ts` 傳入 `priority`~~ —— **已併入 T021**（同一個呼叫點的同一行，
  `aiReplies` 與 `priority` 一次算齊；分兩個 Phase 只是讓第二次動工時得重讀第一次的成果）
> **T051／T052 已前移至 Phase 2 Foundational**（見該處）——它們是 `listJoinedConversations()` 的
> 唯一寫入端，而 US2 的知識庫快查（T035，Phase 4）就靠它判定 JOIN 門檻。留在本 Phase 會讓
> US2 在自己的 checkpoint 上恆回 403，「US2 可獨立驗收」的宣稱不成立。

- [X] T053 [US4] 修改 `app/composables/useConversationView.ts`：`watch(conversationId, ...)` 處理器（約第
  356-374 行）中，切換對話時對**前一個**對話送出的 presence body，把寫死的 `joined: false` 改為切換前讀取的
  `detail.value?.viewerJoined`（**必須在 `loadAll()` 覆蓋 `detail` 之前讀取**，
  contracts/presence-watch-control.md「呼叫端契約」）
- [X] T054 [US4] 修改 `server/api/presence.post.ts`：`state === 'away'` 時不再無條件送出 `{kind:'unwatch'}`，
  改依 `joined` 分流——`joined === true` → `{ kind: 'watch', priority: 'background' }`；`joined === false` →
  `{ kind: 'unwatch' }`；`clearViewing()`（第 57 行）維持無條件執行不變（contracts/presence-watch-control.md
  「修正後」表格）
- [X] T055 [US4] 修改 `server/api/stream.get.ts`：控制通道 handler（約第 79-94 行）中，`watched.has(convId)`
  為真時不再直接 `return`——改為先呼叫既有的 `Unsubscribe`，再以新 `priority` 重新 `attach()`（research.md #8
  決策 3）
- [X] T056 [US4] 修改 `server/api/stream.get.ts`：連線建立時（① 訂閱組織事件之前）新增第零步——呼叫
  `store.listJoinedConversations(session.operatorId)`，對每筆 `attach(convId, 'background', true)`
  （research.md #8 決策 4）；`attach()` 內以 `priority === 'foreground'` 時額外呼叫
  `catchUpSummaryIfStale(conversationId, history)`（T049，history 取自 `runtime.messageSource.fetchSince()`，
  與 `sendAnalysisSnapshotAndResume()` 並列呼叫，US4 AC#5）（依賴 T049、T055）

### 建議卡重複判定（FR-015）

- [X] T057 [US4] 修改 `server/services/copilot-analysis.ts`：新增重複判定邏輯（判定方式留待實作決定，spec.md
  Assumptions 允許簡單的關鍵詞重疊/相似度比對）——新客戶發言、同事回覆、或 Hybrid 模式下 AI 自動回覆抵達時，
  對 `suggestionBlock.cards` 中與該次回覆內容明顯重複者，寫入
  `card.supersededBy = { kind: 'agent' | 'ai', messageId }` 並整塊覆蓋發布（FR-015、US4 AC#2）

### 測試

- [X] T058 [P] [US4] 新增 `test/presence-away-joined.test.ts`：`state:'away', joined:true` → 送出
  `watch(background)` 控制訊息、`clearViewing()` 仍被呼叫；`joined:false` → 送出 `unwatch`
  （contracts/presence-watch-control.md「測試對照」）
- [ ] T059 [P] [US4] 新增 `test/stream-reconnect-background.test.ts`：模擬 `listJoinedConversations` 回傳多筆
  conversationId，驗證每筆皆以 `background` 呼叫 `attach()`；稍後對其中一筆送出 `foreground` watch 時能成功
  升級（不被 `watched.has()` 擋下）
- [X] T060 [US4] 修改 `test/copilot-analysis.test.ts`：新增 US4 案例——`priority:'background'` 時
  `runIncremental()` 跳過 `analyzeSummary()` 但仍執行情緒與建議卡分析；`BACKGROUND_CONCURRENCY_LIMIT` 滿載時
  超額對話僅重排 debounce、不執行、`pending` 不清空；背景 debounce 使用 `BACKGROUND_DEBOUNCE_MS`
- [X] T061 [P] [US4] 新增 `test/catch-up-summary.test.ts`：`catchUpSummaryIfStale()`——無新客戶發言時 no-op；
  有新發言時先發布 `analyzing` 再更新為含新內容的 `ready`

### App

- [X] T062 [US4] 修改 `app/components/copilot/SuggestionCard.vue`：`card.supersededBy` 非 null 時顯示搶答標示
  （「AI 已回覆類似內容」／「同事已回覆類似內容」）並降級呈現（依 US4 AC#2，樣式選擇：淡化或摺疊，不自列表移除
  亦可，只要視覺上明顯降級）（依賴 T028）
- [X] T063 [US4] 修改 `test/realtime-http.ts`：擴充 quickstart.md US4 場景——JOIN A、JOIN B（A 成為背景）、
  對 A 注入新客戶發言、斷言 A 的情緒與建議卡於背景重新計算且摘要未重算、切回 A 斷言立即顯示已更新結果
  （不重新產生等待）、摘要短暫顯示「更新中」後補上涵蓋新發言的內容
  ✅ 2026-08-27：commit 646a3cb 已新增「⑤ 多對話背景更新」場景（第 366-434 行），涵蓋上述全部斷言
  ——含斷線重連後立即以背景優先度復原（T059 的重連情境因此也已被這支 smoke 場景間接驗證，
  但 T059 明文要求的「多筆 conversationId 各自以 background attach()」多對話案例仍只有單一對話，
  T059 本身保持未勾選）。

> **2026-08-27 交接筆記（本次 session 的主要產出）**：`test/realtime-http.ts` 既有的 FR-010
> 重連快照斷言（「重新連線並 watch 後 MUST 於 2 秒內收到已保留的 summary.updated／sentiment.updated」）
> 曾在啟用 T056（SSE 重連復原背景 watch）後穩定失敗，事件延遲到剛好 `STREAM_HEARTBEAT_MS`（25 秒）
> 才送達。逐行加時間戳記追蹤後定位到**與 T056 邏輯無關的既有缺陷**：h3 的 `EventStream` 從不呼叫
> `res.flushHeaders()`，Node 預設「回應標頭與第一個 write() 一起 flush」，導致一條「目前沒有任何
> 已 JOIN 對話」的全新連線（例如客服只是 viewing、從未 JOIN——即 `test/realtime-http.ts` 的
> browser-b）在建立當下沒有事件可送，於是連 HTTP 標頭都卡住不送出，直到下一次心跳。T056 只是
> ***意外治好*** 了已 JOIN 客服（A）的連線（因為復原迴圈讓它一開始就有東西可送），因而讓從未
> JOIN 的 B 成為第一個踩到這個既有缺陷的案例。**修法**：`server/api/stream.get.ts` 在連線建立時
> 無條件送一次 `stream.heartbeat`，強制立即 flush，不必等待任何對話相關事件——已驗證 FR-010
> 斷言恢復通過（9ms，遠低於 2 秒門檻），**斷言本身的 2 秒門檻不需要放寬**，那個數字本來就是對的，
> 卡住的是實作而不是測試。`npm run typecheck && npm test`（210 tests）與 `npm run smoke`（含
> `smoke:flow`／`smoke:realtime`）均已在本次 session 內重新跑過並全數通過。
>
> 尚未完成：T059（見上）、T064-T067（文件同步／grep 舊說法／全量驗證指令的最終確認—— T067
> 本次已跑過驗證指令但尚未在 tasks.md 正式勾選，留給下一個 session 依 Phase 7 清單逐項確認）。

**Checkpoint**：全部四個 User Story 皆可獨立驗收，本功能主要風險（多對話背景運算）已覆蓋。

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T064 [P] 修改 `docs/ARCHITECTURE.md`：同步 §18 M2/M3「內容」與 M2「驗收」清單（知識庫快查移入 M2，
  research.md #12）；新增 §12.4「知識庫快查已知限制」（展開全文不保證涵蓋整份文件，research.md #3）
- [ ] T065 [P] 修改 `docs/IMBRACE_QUESTIONS.md`：新增一題，詢問知識庫檔案是否有可查詢的「最後修改時間」中繼資料
  API、以及是否有正式 SOP 編號制度（research.md #2 待辦）
- [ ] T066 依 CLAUDE.md「正典文件修改後必須 grep 舊說法」——`grep -rn "SOP #" docs/`、
  `grep -rn "重新產生建議" docs/`、`grep -rn "串流" docs/`（確認 §19.1 #20 的「建議卡串流顯示」已撤銷，
  spec.md Clarifications 第 4 題；`docs/DESIGN_TOKENS.md:256` 的「↻ 重新產生」是 M3 結案摘要按鈕，
  屬**預期命中**，不是漏改）、`grep -rn "knowledgeHitCount" specs/ shared/ server/ app/ test/`
  （確認已全面改為 `knowledgeSearch`，憲法 6.2 v3.0.1）、
  `grep -rn "mode === 'hybrid'" server/ app/`（確認 `aiReplies` 一律走 `controlFromMode()`，FR-016）、
  `grep -rln "知識庫快查" docs/ARCHITECTURE.md`（確認 M3 清單已同步移除，T064）、
  `grep -n "0-3f\|0-3g" docs/IMBRACE_QUESTIONS.md`（確認新題號與既有題號不衝突），逐一確認無殘留舊說法
- [ ] T067 執行 `npm run typecheck && npm test && npm run build && npm run smoke`，確認全部通過（quickstart.md
  前置準備／CLAUDE.md 驗證指令，動到 `server/api/**`／`server/state/**`／`server/sources/**` 因此須含 smoke）
- [x] T068 [P] 新增 `scripts/spike/17-message-templates.ts` 與 `npm run spike:templates`：實測
  `GET /api/channel-service/v2/message_templates?business_unit_id={pub_id}&limit=15&skip=0&sort=-updated_at`
  的回應形狀（內容本體欄位、分頁行為、`business_unit_id` 與我方 `orgId`／`pub_id` 的對映、
  SDK 有無對應方法），產出寫入 `scripts/spike/out/`，結論寫進 `docs/PLATFORM_CAPABILITY.md`。
  **與本功能實作無關、不阻塞任何任務**——罐頭訊息是人工維護且已審核的文字，原評估是否可作為
  FR-003 白名單的第二個來源，依 CLAUDE.md「跑 spike 實測，不要推理」先實測形狀。
  ⚠️ 唯讀 GET，不觸及 §9.3 的寫入類實測風險
  ✅ **2026-08-27 已完成**（含使用者提供的 `platform/v1/business_units` 端點、及後台加入
  `{{tel}}` 佔位符後的三次複測）：端點可用、內容本體在 `text`、有真實 `updated_at`；
  `business_unit_id` 吃的是 **`pub_` 開頭的第四種識別碼**（傳 `bu_`／`org_`／`bot_id` 皆靜默回
  0 筆），且可由 `GET /api/platform/v1/business_units` 的 `public_id` 程式化取得；
  **`text` 確實含 `{{變數}}` 佔位符**（偵測到 `{{tel}}`，抓語法本身、不印範本全文，憲法 1.5）。
  結論已寫入 `docs/PLATFORM_CAPABILITY.md` §4.1（含佔位符三個處置選項的取捨表）。
  **使用者 2026-08-27 定案：不納入建議卡**——建議卡是系統主動判斷的完整回覆、範本是客服主動
  挑選的現成文字，兩者情境不同；改列為輸入框旁獨立「常用回覆」功能的候選方向（與
  `docs/wireframe/03-workspace_lightTheme.png` 已畫出的按鈕吻合），未排入任何里程碑，
  實測結論留存供屆時沿用（spec.md Assumptions）

- [x] T069 [P] **前置條件追蹤（非程式碼任務）**：`IMBRACE_KNOWLEDGE_AGENT_ID`／`IMBRACE_SUGGESTION_AGENT_ID`
  兩把 agent id 於本次實作期間 `.env.local` 尚未建立（缺憑證時已如預期退回 Mock，不阻塞開發，
  見 research.md #4）。**但 quickstart.md US1 場景第 2 步（SC-001 手動計時）與 T067 的
  `npm run smoke` 之外、對真實環境的人工驗收都需要這兩把 id 才能跑出非 Mock 的結果。**
  待使用者於 iMBrace 後台建立 `AgentCopilot_知識庫檢索_agent`（掛 Knowledge Hub）與
  `AgentCopilot_建議回覆_agent`（不掛）後填入 `.env.local`，即可移除本項——與 T068 同性質的
  「留一筆待辦，避免真的要手動驗收時才發現漏了」，不影響本 Phase 其餘任務的完成判定。
  ✅ **2026-08-27 已確認**：`.env.local` 已存在 `IMBRACE_KNOWLEDGE_AGENT_ID`／
  `IMBRACE_SUGGESTION_AGENT_ID` 兩把值，皆非空。尚未實際對真實環境跑過 quickstart.md
  US1 場景第 2 步的人工計時驗收（SC-001）——那一步仍待人工執行，本項只確認「前置憑證已備妥」。

> **SC-001（3 秒／10 秒延遲門檻）刻意不列自動化任務**：`smoke` 跑的是假 gateway ＋ Mock provider，
> 對它斷言延遲量到的是 `suggestDelayMs` 這個自己設的數字，不是真實 AI 呼叫（實測中位數 5.0 秒、
> 最慢 12.2 秒）。改以 quickstart.md 的手動／staging 場景驗收。**這是刻意取捨，不是漏做**——
> 日後要補自動化，前提是先有一條打真實 agent 的驗收路徑。（SC-002 不同：它的 10 秒門檻由
> `KNOWLEDGE_SEARCH_TIMEOUT_MS = 8_000` 這個實際生效的上限保障，可在 T036 斷言。）

---

## Dependencies & Execution Order

### Phase 相依

> **本次調整（2026-08-27，`/speckit-analyze` 後）**：T051／T052 前移至 Phase 2（否則 US2 恆回 403）；
> T033 併入 T002、T041／T042 併入 T043、T050 併入 T021；新增 T026a（SC-004 撞單測試）與 T068
> （罐頭訊息 spike，不阻塞）。**被合併的任務 ID 一律保留原位並標記，不重新編號**——重編會讓
> 全篇 60 餘處依賴標註與外部引用同時失效。

- **Setup (Phase 1)**：無相依，立即可做
- **Foundational (Phase 2)**：依賴 Setup；**阻塞所有 User Story**（含前移的 T051／T052）
- **User Stories (Phase 3-6)**：皆依賴 Foundational 完成
  - **US1 → US3**：US3 的故障隔離測試需要 US1 的 `analyzeSuggestions()`/`SuggestionCard.vue` 已存在
  - **US1、US2 → US3**：US3 同時涵蓋知識庫快查的故障隔離，需要 US2 的 `knowledge-search.post.ts` 已存在
  - **US1 → US4**：US4 的背景重算呼叫的是 US1 建立的 `analyzeSuggestions()`；建議實作順序 US1 → US2 → US3 → US4
  - US2 本身不依賴 US1（除共用的 `KnowledgeProvider`/`useOverwriteConfirm` 已在 Foundational／US1 備妥）
- **Polish (Phase 7)**：依賴所有已完成的 User Story

### User Story 相依

- **US1 (P1)**：僅依賴 Foundational，可作為 MVP 獨立交付
- **US2 (P2)**：依賴 Foundational（含前移後的 T051／T052——JOIN 門檻的寫入端）+ US1 的 T030
  （`useOverwriteConfirm`）——若要完全獨立，可將 T030 提前至 Foundational 或在 US2 內重做一份簡化版
- **US3 (P1)**：依賴 US1（T016-T019）與 US2（T035）已完成其故障路徑的結構（五態機、`degraded` 欄位）
- **US4 (P2)**：依賴 US1 的 `analyzeSuggestions()`（T018）與 Foundational 的 `StateStore`/`getPriority()`

### 各 User Story 內部

- Server 型別/服務 → Server API/routing → Server 測試 → App composable → App 元件 → App 頁面掛載 → i18n

### Parallel Opportunities

- Foundational：T002（新檔）可與後續無依賴任務平行；T009/T010（不同檔）平行；T013/T014（不同檔，皆依賴 T003）平行
- US1：T024/T025/T026a（三個獨立新測試檔）平行；T027/T028（不同檔）平行
- US4：T058/T059/T061（三個獨立新測試檔）平行
- Polish：T064/T065/T068（兩份文件＋一支獨立 spike 腳本）平行

---

## Parallel Example: Foundational Phase

```bash
# T002 完成、T003 完成後，可平行進行：
Task: "新增 server/services/knowledge/agent-knowledge-provider.ts"
Task: "新增 server/services/knowledge/mock-knowledge-provider.ts"

# T003 完成後，可平行進行：
Task: "修改 server/services/ai/mock-ai-provider.ts 新增 suggest()"
Task: "修改 server/services/ai/imbrace-agent-provider.ts 新增 suggest()"
```

## Parallel Example: User Story 1

```bash
Task: "新增 test/agent-knowledge-provider.test.ts"
Task: "新增 test/suggestion-whitelist.test.ts"

Task: "修改 app/composables/useCopilotSession.ts 訂閱 suggestion.updated"
Task: "新增 app/components/copilot/SuggestionCard.vue"
```

---

## Implementation Strategy

### MVP First（僅 User Story 1）

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（**阻塞，不可略過**）
3. 完成 Phase 3 User Story 1
4. **停下驗證**：依 quickstart.md US1 場景手動驗證，並跑
   `npm run typecheck && npm test`
5. 視情況部署／展示（MVP：建議卡一鍵帶入）

### Incremental Delivery

1. Setup + Foundational → 基礎就緒
2. + US1 → 獨立驗證 → MVP 可展示
3. + US2 → 獨立驗證（知識庫快查）
4. + US3 → 獨立驗證（故障降級，補齊 US1/US2 的韌性保證）
5. + US4 → 獨立驗證（多對話背景更新，本功能風險最集中的部分，建議放最後且預留最多驗證時間）
6. Polish：文件同步 + grep 舊說法 + 全量驗證指令

### 風險提示

US4（背景多對話）觸及 `presence.post.ts`／`stream.get.ts`／`session-manager.ts` 等既有基礎設施的判斷邏輯修正，
變更面比表面上的 FR 描述更底層（見 plan.md Summary、research.md #8）。建議 US4 的每個子任務（T053-T057）
完成後個別跑 `npm run smoke:realtime` 一次，而非全部改完才一次驗證，以便快速定位是哪一處修正破壞了既有的
撞單防護時效或 presence 顯示正確性。
