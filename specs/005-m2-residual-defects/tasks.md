---

description: "M2 遺留缺陷與量測補強 —— 實作任務清單"
---

# Tasks: M2 遺留缺陷與量測補強

**Input**: Design documents from `/specs/005-m2-residual-defects/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、
[data-model.md](./data-model.md)、[contracts/connection-lifecycle.md](./contracts/connection-lifecycle.md)、
[contracts/citation-audit-event.md](./contracts/citation-audit-event.md)、[quickstart.md](./quickstart.md)

**Tests**: 包含，而且**本規格比前四份更依賴測試**。spec 的第一段就寫明四類項目的共通點是
「**它們全部不會報錯**」——雙分頁缺陷讓畫面安靜停止更新、恢復不補算讓走勢缺一段、
杜撰引用被擋下只是「這次沒有引用」。沒有一項會讓測試變紅、型別報錯或客服看到錯誤訊息。
**因此「壞掉時什麼會變紅」必須是被建造出來的東西**，不是既有測試的副產品。

**Organization**: 依 user story 分組。四則故事彼此獨立（技術主題不同、檔案幾乎不重疊），
可平行推進；唯一的共用前置是 `server/state/types.ts` 的兩處型別變更（Phase 2）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行執行（不同檔案、無未完成的相依）
- **[Story]**: 對應的 user story（US1～US4）
- 每項任務都標出確切檔案路徑

## Path Conventions

單一 Nuxt 應用內建 Nitro BFF：`app/`（前端）／`server/`（BFF）／`shared/`（共用型別）／
`test/`（vitest）／`scripts/spike/`（真實環境量測）。
本規格新增一個目錄：`server/api/connection/`（Nitro 檔案路由慣例）。

---

## ⚠️ 動工前必讀

1. **`clientId` MUST NOT 當作登記的鍵**（research.md #1）。它存在 `sessionStorage`，
   而瀏覽器的「複製分頁」會連同 `sessionStorage` 一起複製 —— 兩條連線可能帶同一個 `clientId`。
   拿它當鍵就是把本規格要修的缺陷換個觸發條件重新種一次，而且一樣不報錯。
   鍵一律用 `stream.get.ts` 產生的 server 端 `connectionId`。
2. **心跳與 activity 的定址 MUST 更新「命中的全部」，MUST NOT「取一筆」**（research.md #2）。
   承上，複製分頁共用 `clientId` 時只更新其中一筆，另一條活著的連線會在 45 秒後被回收。
3. **MUST NOT 用 server 端的 `stream.heartbeat` 當存活訊號**（research.md #3）。
   它證明的是「server 還認為連線在」，半開連線下**恆真** —— 兜底變成永不觸發的裝飾。
   存活訊號必須由對側（瀏覽器）發出。
4. **`leave.post.ts` 一行不動**（research.md #6）。主動離開走
   `removeJoinedConversation()` ＋ 廣播 `control.updated`，**完全不經 `watchers`**，
   與連線計數今天就是分開的。把兩者「統一」會讓 003 T032a 已驗過的行為靜默退步。
5. **補算的缺口有左界，是 `timeline[0]` 而不是對話的第一則訊息**（research.md #8）。
   冷啟動一次只吃最近 `DEFAULT_MESSAGE_LIMIT`（50）則，更早的訊息是**刻意不看**、不是缺口。
   寫成「全量歷史 − 已涵蓋」的後果是長對話每輪補一點、永遠補不完，
   每次客戶發言都多打 3 批 AI —— 測試全綠、畫面正常，只有帳單知道。
6. **補算只擴充 `analyzeSentimentBatch()` 的輸入**（research.md #11）。摘要與建議卡的錨點語意不同：
   摘要用 `summaryBlock.summary.basedOnMessageId`（`catchUpSummaryIfStale()` 的註解已警告過誤用的後果），
   建議卡是針對「這一批」生成的。把舊發言塞進去會產生一批答非所問的卡。
7. **補算 MUST NOT 自行 `scheduleIncremental()` 續排下一輪**（FR-009／FR-010）。
   「補完為止」的迴圈是這裡唯一會踩爆 003 SC-001 的寫法。
8. **`whitelistFilter()` 一行不改**（FR-014）。本規格只改「送進去的東西」，不改「擋下來的規則」。
9. **稽核事件 MUST 放在 `server/utils/`，MUST NOT 放進分析管線**（research.md #15）。
   拆檔守衛禁止「管線外值 import 管線內部檔」；放進管線的話，FR-017 的量測腳本 import 不到它，
   唯一的繞法是從 barrel re-export —— 那等於把稽核塞進分析管線的對外介面。
10. **標準輸出 MUST 是完整集合，MUST NOT 以 log 級別分流**（FR-015）。
    額外落點只能是它的拷貝；**要防的是「開檔」不是「寫入」**（FR-015a）。
11. **`invalidSopIds` 不是 PII，MUST 保留**（contracts/citation-audit-event.md §1）。
    它是模型憑空造的字串、不是客戶內容，而它正是 FR-017 歸因分析的原料。
    `text`／`title`／`snippet` 則以型別標 `never` 擋掉。
12. **US3 的量測基線 MUST 在改 prompt 之前取**（research.md #13）。
    `buildSuggestionPrompt()` 是刻意與 `spike:agent-latency` 共用的同一份，
    改動會同時改變量測用的 prompt —— 沒有先取基線就失去了「改動前後可比較」這個 SC-006 的判準。
13. **量測前先跑 `npm run spike:agent-prompts`**（§11）。四個 agent 的 system prompt 不在本 repo，
    被改掉不會有 commit。**量測數字是間接證據，快照 diff 是直接證據。**
14. **15 秒 p90 門檻在本規格期間維持不動**（FR-020a）。
    「掃描還沒跑就先改驗收標準」是被明文排除的做法。

---

## Phase 1: Setup（動工前的基線）

**Purpose**: 讓「本規格造成的紅」與「動工前就有的紅」分得開

- [ ] T001 執行 `npm run spike:agent-prompts`，確認四個 agent 的 system prompt 與 `docs/AGENT_PROMPTS.md` 快照逐字元相同；有差異時**先停下來**釐清，不要帶著漂移的 prompt 開始
- [ ] T002 執行 `npm run typecheck && npm test && npm run build && npm run smoke`，記錄動工前全綠（或既有的紅）作為基線

---

## Phase 2: Foundational（阻塞所有 user story）

**Purpose**: 兩處型別變更先落地，US1 與 US2 才編得過

**⚠️ CRITICAL**: 本階段完成前，US1／US2 無法開始（US3／US4 不受此阻塞）

- [ ] T003 在 `server/state/types.ts` 同時改兩處：① `CopilotSession.watchers` 由 `string[]` 改為 `Array<{ operatorId: string, connectionId: string }>`；② `CopilotAnalysisState` 新增 server-only 欄位 `sentimentGap: boolean`（預設 `false`）。兩者在同一個檔案，**不可平行**；此時 `npm run typecheck` 會紅，那正是本任務的目的——它會逐一指出所有需要改的呼叫點

**Checkpoint**: 型別已就位，US1 與 US2 可以開始（US3／US4 從一開始就可平行）

---

## Phase 3: User Story 1 — 開第二個分頁不會讓第一個分頁安靜死掉（P1）🎯 MVP

**Goal**: 同一位客服的多條連線各自獨立；關掉其中一條，其餘連線的訊息流與 Copilot session 完全不受影響。

**Independent Test**: 同一帳號開兩個分頁連上同一組織／同一段對話，關掉其中一個，
驗證另一個仍持續收到新訊息、且自己送出的訊息不被重複 fan-out。

### Tests for User Story 1 ⚠️

> 先寫測試並確認它們**會紅**，再實作。這一組測試就是本 story「壞掉時會變紅的東西」。

- [ ] T004 [P] [US1] 在 `test/connection-counting.test.ts` 建立不變式 I-1／I-2／I-3（憑證登記）：一條連線一筆登記、逾期登記不被 `borrowCredential()` 回傳、`hasForegroundOperator()` ＝任一登記為前景
- [ ] T005 [P] [US1] 在 `test/connection-counting.test.ts` 建立**不變式 I-4** —— `session.watchers.length === pipeline.refs`，對「同一客服兩條連線」「兩位客服各一條」「異常中斷」三組情境各驗一次。⚠️ 測試名稱與註解 MUST 標明它驗的是**單副本**（`pipeline.refs` 是 process-local，多副本下這條等式本來就不成立，見 data-model.md §2）
- [ ] T006 [P] [US1] 在 `test/connection-counting.test.ts` 建立 contracts/connection-lifecycle.md §3 的四個情境（關一條／session 不刪／全關才清／不同客服互不影響）
- [ ] T007 [P] [US1] 在 `test/connection-counting.test.ts` 建立存活兜底測試：以假時鐘推進超過 `CREDENTIAL_TTL_MS`，驗證逾期登記被回收；心跳抵達後不被回收
- [ ] T008 [P] [US1] 在 `test/connection-counting.test.ts` 建立**複製分頁**測試：兩條連線帶**相同** `clientId`，驗證 ① 關掉其中一條不影響另一條、② 一次心跳把兩筆的 `lastSeenAt` 都更新（研究 #1／#2 的兩個坑各對應一條斷言）
- [ ] T009 [P] [US1] 在 `test/connection-counting.test.ts` 建立 **I-7／I-8 夾擊測試**：主動離開對該客服**所有**連線生效、連線關閉只影響該條連線。⚠️ 兩條 MUST 同時存在——只驗其中一條時，把兩條路徑合併的錯誤修法會通過測試（SC-002a）

### Implementation for User Story 1

- [ ] T010 [US1] 改寫 `server/services/credentials.ts`：registry 形狀改為 `Map<orgId, Map<connectionId, PollingCredential>>`；`PollingCredential` 加 `connectionId`／`clientId`／`lastSeenAt`；`registerCredential()` 收 `connectionId` 與 `clientId`，回傳的 unsubscribe 只移除該筆
- [ ] T011 [US1] 在 `server/services/credentials.ts` 加入 `CREDENTIAL_TTL_MS = 45_000`／`CREDENTIAL_HEARTBEAT_MS = 20_000`，並在 `borrowCredential()`／`hasForegroundOperator()`／`registeredOrgIds()` 三個讀取點做**惰性剔除**（research.md #4：不加計時器，理由寫進註解）
- [ ] T012 [US1] 在 `server/services/credentials.ts` 新增 `touchCredential(orgId, operatorId, clientId)`，更新**命中的全部**登記的 `lastSeenAt`；`setCredentialActivity()` 簽章加 `clientId`，同樣更新全部命中者。⚠️ 兩者都 MUST NOT 寫成「取一筆」，理由（複製分頁共用 clientId）寫進註解
- [ ] T013 [US1] 新增 `server/api/connection/beat.post.ts`：body 只有 `clientId`（Zod 驗證），呼叫 `touchCredential()`，回傳 `{ ok: true }`。⚠️ **MUST NOT** 接受或回傳任何 token（憲法 1.1）
- [ ] T014 [US1] 修改 `server/api/stream.get.ts`：連線建立時 `const connectionId = crypto.randomUUID()`；`registerCredential()` 帶上 `connectionId` 與 `clientId`；`attach()` 內的 `watchConversation()` 帶上 `connectionId`
- [ ] T015 [US1] 修改 `server/services/session-manager.ts`：`WatchRequest` 加 `connectionId`；`upsertSession()` 每條連線各推一筆（不再以 operatorId 去重）；`releasePipeline()` 收 `connectionId` 並只 filter 掉該筆
- [ ] T016 [US1] 在 `server/services/session-manager.ts` 調整 `isResume` 的判準與註解：新語意是「這個對話在我 attach 之前已經有人在看」。⚠️ 這是**行為變更**（同一客服的第二個分頁由 `join` 變成 `resume`），MUST 在註解裡寫明，並確認 `session.opened` 的 `reason` 仍無前端消費者
- [ ] T017 [US1] 修改 `server/api/presence.post.ts`：`setCredentialActivity()` 呼叫帶上 body 既有的 `clientId`
- [ ] T018 [US1] 在 `app/stores/stream.ts` 加入連線層級心跳：SSE 連線建立後每 `CREDENTIAL_HEARTBEAT_MS`（20 秒）打一次 `POST /api/connection/beat`，**與有沒有進入對話無關**；連線關閉時停止。⚠️ 與 presence 心跳是**兩支獨立**的心跳，回答的是不同問題，MUST NOT 合併
- [ ] T019 [US1] 在 `test/contract-guards.test.ts` 新增守衛：`server/api/conversations/[id]/leave.post.ts` **MUST NOT** 出現 `connectionId`／`releasePipeline`／`unregisterCredential` 等連線層級識別項——防止日後有人為了「統一清理路徑」把主動離開接到連線計數上（research.md #6）
- [ ] T020 [US1] 執行 `npm run build && npm run smoke`（含 `smoke:realtime` 的兩位客服／兩條 SSE），確認 HTTP route 與 cookie 往返正常且憑證不外洩

**Checkpoint**: US1 可獨立驗收。單獨交付這一條就已消除一類客服會回報「訊息不見了」的事故。

---

## Phase 4: User Story 2 — 故障排除之後，情緒走勢不留永久空洞（P2）

**Goal**: 恢復分析時同時補齊先前未涵蓋的客戶發言，情緒時間軸不留缺口，且無缺口時的行為與現況逐字相同。

**Independent Test**: 注入 AI 故障讓中段若干批失敗，排除故障後由新客戶發言觸發恢復，
驗證情緒時間軸涵蓋到全部客戶發言、沒有中斷區間。

### Tests for User Story 2 ⚠️

- [ ] T021 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立主線情境：中段若干批失敗 → 新發言觸發恢復 → 時間軸無中斷區間（SC-003）
- [ ] T022 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立**左界測試**：造一段長度超過 `DEFAULT_MESSAGE_LIMIT`（50）的對話，冷啟動只涵蓋最近 50 則，驗證補算**不**回頭處理 `timeline[0]` 之前的訊息。⚠️ 這是本 story 最容易漏的測試（動工前必讀 #5）
- [ ] T023 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立上限測試：未涵蓋量很大時，單輪最多 3 批（＝18 則），以 AI 呼叫次數斷言（FR-009）
- [ ] T024 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立**零成本測試**：無缺口（`sentimentGap === false`）時，AI 呼叫次數**與取歷史次數**皆與現況逐一相同（FR-012、不變式 I-7）
- [ ] T025 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立止血不退步測試：補算失敗 → 停在 `error` 等待手動重試、**MUST NOT** 自行再排一輪（FR-010、SC-004 對應 003 SC-001）
- [ ] T026 [P] [US2] 在 `test/sentiment-backfill.test.ts` 驗證補算**只**擴充情緒的輸入：摘要與建議卡收到的訊息集合不變（FR-011 之外，research.md #11 的獨立斷言）

### Implementation for User Story 2

- [ ] T027 [US2] 在 `server/services/analysis-state.ts` 掛上 `sentimentGap` 的轉移：情緒批次失敗（`finishBlockError(_, 'sentiment', _)`）時設為 `true`。⚠️ 只改狀態一律走 `updateAnalysisState()`（`stateLocks` 的不變式）
- [ ] T028 [US2] 在 `server/services/copilot-analysis.ts` 新增 `setHistoryResolver()` 與 `resolveHistory()`，形狀完全比照既有的 `setJoinedResolver()`；預設值是安全的無作用值（回空陣列＝視為無缺口）
- [ ] T029 [US2] 在 `server/services/copilot-runtime.ts` 載入時呼叫 `setHistoryResolver()`，注入 `messageSource.fetchSince`（相依方向與 `setJoinedResolver()` 相同，管線 MUST NOT 反向 import）
- [ ] T030 [US2] 在 `server/services/copilot-analysis.ts` 實作缺口計算：`sentimentGap === true` 時取歷史，缺口 ＝「`timeline[0]` 之後、不在 timeline 的客戶發言」，取前 3 批；沿用既有的 `newCustomerMessagesSince()` 去重約定
- [ ] T031 [US2] 在 `server/services/copilot-analysis.ts` 的 `runIncremental()` 內把「新訊息 ∪ 缺口」只交給 `analyzeSentimentBatch()`；`analyzeSummary()` 與 `analyzeSuggestions()` 的輸入**一個字不變**（動工前必讀 #6）
- [ ] T032 [US2] 在 `server/services/copilot-analysis.ts` 補算完成後更新 `sentimentGap`：已無未涵蓋發言時清為 `false`，仍有剩餘時維持 `true`；**MUST NOT** 自行排下一輪（動工前必讀 #7）
- [ ] T033 [US2] 在 `test/contract-guards.test.ts` 新增守衛：`shared/` 底下不得出現 `sentimentGap`（比照既有的 `failedBatches` 契約 1.1，含「守衛本身有效」的自檢）

**Checkpoint**: US2 可獨立驗收。此時第三刀拆檔（`blocks/sentiment.ts`）的觸發條件已滿足，但**不在本規格範圍**。

---

## Phase 5: User Story 3 — 建議卡為什麼沒有引用，答得出來（P2）

**Goal**: 任何一次「未引用知識庫」都能分辨成因（未命中／未引用／被捨棄），且杜撰率可重複量測。

**Independent Test**: 對固定的一組真實對話重複量測，穩定產出「杜撰率」與「哪些對話會杜撰」兩項數字，
且該數字在強化命中清單前後可比較。

> ⚠️ **本 Phase 的任務順序是規範，不是風格**：稽核事件 → **基線量測** → 改 prompt → 改動後量測。
> 先改 prompt 就失去了 SC-006 的「可比較」（動工前必讀 #12）。

### Tests for User Story 3 ⚠️

- [ ] T034 [P] [US3] 在 `test/citation-audit.test.ts` 驗證 `outcome` 的四值判定：`cited`／`no-hits`／`not-cited`／`discarded` 各造一組輸入（contracts/citation-audit-event.md §2）
- [ ] T035 [P] [US3] 在 `test/citation-audit.test.ts` 驗證 PII 型別守：以型別層測試（`@ts-expect-error`）確認 `text`／`title`／`snippet` 塞不進事件；並驗證 `invalidSopIds` **有**被保留
- [ ] T036 [P] [US3] 在 `test/citation-audit.test.ts` 驗證 FR-015a 的降級：**開檔**失敗時不拋出、不中止、標準輸出的事件仍完整、stderr 留下一行可辨識的原因

### Implementation for User Story 3 —— 第一段：稽核事件（改 prompt 之前）

- [ ] T037 [US3] 新增 `server/utils/citation-audit.ts`：定義 `CitationAuditEvent` 型別（含 `text?: never` 等型別守）與 `emitCitationAudit()`；標準輸出寫一行 JSON（NDJSON）。⚠️ 檔案放在**管線外**，理由寫進檔頭（動工前必讀 #9）
- [ ] T038 [US3] 在 `server/utils/citation-audit.ts` 加入額外落點（JSONL，環境變數開啟、**預設不啟用**）：建目錄／開檔包在 try/catch，失敗降級為只寫標準輸出並在 stderr 留一行。⚠️ 預設值 MUST NOT 是相對路徑（容器的 WORKDIR 屬 root 卻跑非 root，bind mount 會遮蔽 `chown`）
- [ ] T039 [US3] 在 `server/services/blocks/suggestion.ts` 的**三條**落定路徑發出事件：前景兩段式的第二段落定、背景單段落定、「命中已在手」的單段落定。⚠️ 漏掉任一條會讓該路徑的個案永遠查不到（SC-005 對它不成立）
- [ ] T040 [US3] 新增 `scripts/spike/27-citation-quality.ts` 與 `npm run spike:citation-quality`：沿用 `spike:progressive` 的骨架（走生產路徑的 `runColdStart()`），收集稽核事件並聚合出整體杜撰率**與逐對話分布**
- [ ] T041 [US3] **取基線**：`npm run spike:agent-prompts` 後執行 `npm run spike:citation-quality`（n=45 口徑，FR-018a），把結果存進 `scripts/spike/out/` 並記下執行時段。⚠️ 這一步 MUST 在 T042 之前完成

### Implementation for User Story 3 —— 第二段：封閉清單（基線之後）

- [ ] T042 [US3] 在 `server/services/ai/imbrace-agent-provider.ts` 的 `buildSuggestionPrompt()` 加入**顯式封閉清單**段落（可用的 sopId 列舉 ＋「只能從清單中選、不得自創」）；空集合時明示「本次沒有可用的 sopId，全部填 null」。既有規則 ② 保留
- [ ] T043 [US3] 確認 `whitelistFilter()`（`server/services/blocks/suggestion.ts`）**一行未改**，並在該函式加一行註解指向 FR-014
- [ ] T044 [US3] **改動後量測**：再跑一次 `npm run spike:citation-quality`（同樣 n=45、同一組對話），與 T041 的基線並列比較，把兩組數字寫進 `docs/ARCHITECTURE.md`。⚠️ **本項不承諾 004 SC-002 的 80% 會提高**——沒有改善**不代表失敗**，交付物是「答得出為什麼」與「量得出來」

**Checkpoint**: US3 可獨立驗收。SC-005 由事件名與欄位判定，不需讀程式碼。

---

## Phase 6: User Story 4 — 情緒延遲還剩的那個槓桿，量過再決定（P3）

**Goal**: 產出一個有依據的數字，足以支撐「並行度要不要改」這個決定；順帶補上 `user_id` 的衛生欠帳。

**Independent Test**: 跑一次並行度掃描，對每一個檔位同時得到總時間與單次失敗率兩列。

### Implementation for User Story 4 —— 並行度掃描

- [ ] T045 [US4] 在 `server/services/copilot-analysis.ts` 把 `SENTIMENT_CONCURRENCY` 改為 `Number(process.env.SENTIMENT_CONCURRENCY ?? 3)`，**只在模組載入時讀一次**；註解寫明「這道門只為 `spike:sentiment-concurrency` 而開，生產設定 MUST NOT 設定它」，並說明為何 `SENTIMENT_CHUNK_SIZE` 不比照辦理
- [ ] T046 [P] [US4] 在 `test/contract-guards.test.ts` 新增守衛：`.env.example`／`nuxt.config.ts` 等設定檔**MUST NOT** 出現 `SENTIMENT_CONCURRENCY`（含「守衛本身有效」的自檢）。⚠️ 它一旦被抄進某個環境的設定，症狀是「那個環境的情緒延遲莫名其妙不一樣」，沒有任何錯誤
- [ ] T047 [US4] 新增 `scripts/spike/26-sentiment-concurrency.ts` 與 `npm run spike:sentiment-concurrency`：對 3／4／5 三個檔位**各開一個子行程**（同一行程內改不了 module-level const），三輪、輪次間輪換檔位順序（3,4,5／4,5,3／5,3,4）、同一時段連續跑完、**序列執行不得並行取樣**
- [ ] T048 [US4] 讓 26 號腳本重用 `spike:progressive` 既有的 `sentimentCalls`（每次呼叫的延遲與成敗）與峰值並發，輸出**總時間分布**與**單次呼叫失敗率**兩列並陳（FR-018）
- [ ] T049 [US4] **執行掃描**（實跑約 1 小時；先跑 `npm run spike:agent-prompts`），把原始產出存進 `scripts/spike/out/`，並記錄執行時段；平台若處於已知降級時段 MUST 明確標註（FR-020）
- [ ] T050 [US4] 依 FR-019 的判準做決定並寫進 `docs/ARCHITECTURE.md`：總時間改善**且**失敗率未上升才採用；只有總時間改善 **MUST NOT** 作為採用理由，且該結論本身要留在文件裡。⚠️ 15 秒門檻在本規格期間維持不動（FR-020a）

### Implementation for User Story 4 —— `user_id` 衛生

- [ ] T051 [P] [US4] 在 `server/services/imbrace.ts`（防腐層）新增 AI 服務 client user id 的取得與 process-local 快取。⚠️ 註解 MUST 寫明它**與客服身分無關**，填成 `operatorId` 會讓 AI 服務端的用量統計掛到錯的人身上而不報錯
- [ ] T052 [US4] 在 `server/services/ai/imbrace-agent-provider.ts` 的 `callAgent()` 帶上 `user_id`，省去 SDK 每次呼叫先 await 一次 auth 的往返（實測 54ms）
- [ ] T053 [US4] 執行 `npm run spike:userid` 驗證：帶上 `user_id` 不會 400、輸出照常、多次取得的 id 一致；並確認既有分析行為完全不變（FR-021）

**Checkpoint**: 四則 user story 全部可獨立驗收。

---

## Phase 7: Polish & 跨切面

- [ ] T054 更新 `docs/ARCHITECTURE.md` §18 M2：把本規格關閉的項目（`registerCredential()` 雙分頁、`session.watchers` 雙分頁、自動恢復不補算、`user_id` 衛生、並行度掃描）逐一標記為已關閉並指向 005
- [ ] T055 ⚠️ **執行 `CLAUDE.md` 第一級警告的 grep**：`grep -rn "雙分頁" docs/`、`grep -rn "未修的缺陷" docs/`、`grep -rn "user_id" docs/`、`grep -rn "並行度" docs/`——同一個結論散落在決策摘要、詳細章節、里程碑驗收、風險表**甚至另一份正典文件**，改完「主要」那份時最危險
- [ ] T056 [P] 檢查 `docs/IMBRACE_QUESTIONS.md` 的 0-3e：US3 的封閉清單結果會影響該題的敘述（該題引用了「44% 的呼叫至少產生一張杜撰的知識庫來源編號」）。有新數字就更新，**自行解決的部分要明確撤回並附上解法**，不是默默刪掉
- [ ] T057 [P] 在 `docs/ARCHITECTURE.md` §18 M2「分析管線拆檔」註記第三刀的觸發條件（「005 的情緒改動落地之後」）**已滿足**，但**不在本規格執行**
- [ ] T058 依 [quickstart.md](./quickstart.md) 逐項執行手動驗收，特別是 US1 的真實雙分頁情境與「斷網而非關分頁」的存活兜底驗證
- [ ] T059 執行 `npm run typecheck && npm test && npm run build && npm run smoke`，確認 001～004 的既有驗收全部維持通過（SC-008），與 T002 的基線對照

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1（Setup）**：無相依，立即可開始
- **Phase 2（Foundational）**：相依 Phase 1；**阻塞 US1 與 US2**（US3／US4 不受阻塞）
- **Phase 3～6（User Stories）**：US1／US2 相依 Phase 2；US3／US4 只相依 Phase 1
- **Phase 7（Polish）**：相依所有已完成的 story

### User Story Dependencies

- **US1（P1）**：Phase 2 之後即可開始。與其他三則**無相依**
- **US2（P2）**：Phase 2 之後即可開始。與 US1 **無相依**（不同檔案：credentials／session-manager vs analysis 管線）
- **US3（P2）**：**完全獨立**，Phase 1 之後即可開始。內部順序嚴格：T037～T041 → T042～T044
- **US4（P3）**：**完全獨立**，Phase 1 之後即可開始。內部可再拆兩束（掃描 T045～T050、`user_id` T051～T053，兩束互不相依）

### Within Each User Story

- 測試先寫、先確認會紅，再實作
- 型別 → 服務 → 端點 → 前端
- US3 的「基線在改 prompt 之前」是**硬相依**，不是建議

### Parallel Opportunities

- **T004～T009**（US1 測試）可平行撰寫
- **T021～T026**（US2 測試）可平行撰寫
- **T034～T036**（US3 測試）可平行撰寫
- **US3 與 US4 可與 Phase 2／US1／US2 完全平行**——它們不碰 `server/state/types.ts`、
  不碰 `credentials.ts`、不碰 `session-manager.ts`
- **T051～T053（`user_id`）是整份清單裡最獨立的一束**，任何時候都能插進去做

⚠️ **不可平行**的地方：T010～T012 全在 `credentials.ts`；T014／T017 分別改 `stream.get.ts`／
`presence.post.ts` 但都相依 T010 的新簽章；T027～T032 全在分析管線且共用 `sentimentGap` 的轉移。

---

## Parallel Example: User Story 1 的測試

```bash
# 這五項在同一個檔案的不同 describe，可由不同人同時撰寫後合併：
Task: "I-1／I-2／I-3 憑證登記的三條不變式"
Task: "I-4 watchers.length === pipeline.refs（三組情境、標明單副本）"
Task: "contracts §3 的四個情境"
Task: "存活兜底（假時鐘推進 45 秒）"
Task: "複製分頁共用 clientId 的兩條斷言"
Task: "I-7／I-8 夾擊（LEAVE 對全部連線 vs 關線只影響自己）"
```

---

## Implementation Strategy

### MVP First（只做 US1）

1. Phase 1（Setup）→ Phase 2（型別）→ Phase 3（US1）
2. **STOP and VALIDATE**：跑 quickstart 的 US1 手動情境（真實雙分頁）
3. 這一條單獨交付就已經消除一類「訊息不見了」的事故 —— 四項裡唯一會讓**主線功能**失效的

### Incremental Delivery

1. Setup ＋ Foundational → 型別就位
2. **US1** → 獨立驗收 → 交付（MVP，止血）
3. **US2** → 獨立驗收 → 交付（情緒走勢不再有空洞；此時第三刀拆檔的條件成立）
4. **US3** → 獨立驗收 → 交付（答得出「為什麼沒有引用」）
5. **US4** → 產出數字 → 依判準決定要不要改並行度

### 平行分工

- 開發者 A：Phase 2 → US1（連線層，`server/api/`＋`server/services/credentials.ts`／`session-manager.ts`＋`app/stores/stream.ts`）
- 開發者 B：US2（分析管線，`copilot-analysis.ts`／`analysis-state.ts`／`copilot-runtime.ts`）
- 開發者 C：US3 ＋ US4（`blocks/suggestion.ts`／`ai/`／`server/utils/`／`scripts/spike/`）

三束的檔案幾乎不重疊，唯一的交會點是 Phase 2 的 `server/state/types.ts`（一次改完）。

---

## Notes

- `[P]` ＝ 不同檔案、無未完成的相依
- `[Story]` 標籤讓每一項任務都能回溯到 spec 的哪一則故事
- 每個 Phase 結束用 `/commit-split` 分類建立 commit；勾選變更併入該 phase 收尾的 commit
- ⚠️ **本規格的每一項驗證都要能回答「壞掉時什麼會變紅」** —— 答不出來的驗證等於沒驗，
  因為這四類缺陷全部不會報錯
- ⚠️ **判讀任何 AI 相關數字之前先跑 `npm run spike:agent-prompts`**（§11）：
  量測數字是間接證據，快照 diff 是直接證據
