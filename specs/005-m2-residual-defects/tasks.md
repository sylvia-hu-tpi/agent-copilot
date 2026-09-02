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

⚠️ **分支名 `feat/m2-copilot-panel` 不含 `005`**，`check-prerequisites.ps1` 會依
`.specify/feature.json` 持久化的目錄解析（2026-09-02 `/speckit-analyze` 時它還指著 004）。
覆寫用的環境變數是 **`SPECIFY_FEATURE_DIRECTORY`**（`SPECIFY_FEATURE` 只影響分支名，對目錄無效），
設一次就會寫回 `feature.json`，之後不必再帶：

```powershell
$env:SPECIFY_FEATURE_DIRECTORY = 'specs/005-m2-residual-defects'
```

（2026-09-02 `/speckit-implement` 已執行過一次，`feature.json` 目前指向 005。）

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
3a. **心跳 MUST 是 upsert：命中 0 筆時重新登記，MUST NOT no-op**（research.md #3a）。
   45／20 秒這組數字抄自 presence，但 presence 真正的安全網是 `reportViewing()` 是 upsert
   —— 項目被 TTL 清掉後下一拍會重建。**只抄數字不抄語意，背景分頁會自己重現本規格要修的缺陷**：
   瀏覽器把隱藏分頁的計時器節流到約每分鐘一次（> 45 秒 TTL）→ 登記被剔除 →
   而 SSE 連線**沒有斷、不會重連**，沒有任何路徑會重新登記 → 那條連線的憑證永遠回不來。
   症狀與原始缺陷逐字相同：畫面正常、不報錯、訊息不再進來。
   定址時**不先套 TTL 濾網**：逾期但尚未被讀取剔除的舊筆直接刷新、`connectionId` 不變；
   只有讀取點跑過、登記真的消失後，心跳才命中 0 筆而 upsert。
   （本段是摘要，**正典是 contracts/connection-lifecycle.md §4**，改動以該處為準。）
4. **`leave.post.ts` 一行不動**（research.md #6）。主動離開走
   `removeJoinedConversation()` ＋ 廣播 `control.updated`，**完全不經 `watchers`**，
   與連線計數今天就是分開的。把兩者「統一」會讓 003 T032a 已驗過的行為靜默退步。
5. **補算的缺口有左界，是 `timeline[0]` 而不是對話的第一則訊息**（research.md #8）。
   冷啟動一次只吃最近 `DEFAULT_MESSAGE_LIMIT`（50）則，更早的訊息是**刻意不看**、不是缺口。
   寫成「全量歷史 − 已涵蓋」的後果是長對話每輪補一點、永遠補不完，
   每次客戶發言都多打 3 批 AI —— 測試全綠、畫面正常，只有帳單知道。
5a. **抓取錨點是 `timeline[0].messageId`，MUST NOT 用 `lastCoveredMessageId()`**
   （research.md #7／#8、data-model.md §3「抓取範圍」）。後者回傳 timeline 的**最後**一筆
   （高水位）—— 中段批次失敗後，後續成功的批次會把高水位推到缺口**之後**，
   以它為錨點就**永遠撈不到中段缺口**：US2 的每一項任務都做完，卻一則也沒補到。
   而且若測試把缺口造在尾端，這個寫法會**通過測試**。
   **timeline 為空時（冷啟動情緒整批失敗）錨點為 `null`**，整個視窗的客戶發言都是缺口 ——
   與 `stream.get.ts` 重連快照對 `lastCoveredMessageId() === null` 的處理相同（data-model §3、spec FR-008）。
   MUST NOT 寫成「沒有 `timeline[0]` 就跳過」。
5b. **上限的操作定義是「每輪 18 則缺口訊息」，不是「3 批」**（FR-009）。缺口與本輪新發言合併後才切批，
   新發言的批次不計入；單輪呼叫次數上界 ＝ ⌈新發言數 ÷ 6⌉ ＋ 3。
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
    ⚠️ 但**型別守擋不到 `invalidSopIds` 本身**（它是 `string[]`，內容由模型自由生成），
    因此該欄位另加一道機械式收斂：**> 64 字元者改記 `sha256:<前16碼>+<原長度>`**。
    真實 id 與「像 id 的杜撰字串」都遠短於 64，原樣保留；長段客戶內容必然超過而被擋。
    MUST NOT 簡化成「一律雜湊」——那會殺掉 SC-006 判斷杜撰形狀的原料。
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

- [x] T001 執行 `npm run spike:agent-prompts`，確認四個 agent 的 system prompt 與 `docs/AGENT_PROMPTS.md` 快照逐字元相同；有差異時**先停下來**釐清，不要帶著漂移的 prompt 開始
- [x] T002 執行 `npm run typecheck && npm test && npm run build && npm run smoke`，記錄動工前全綠（或既有的紅）作為基線（2026-09-02：四個 agent prompt 與快照一致；typecheck 綠；37 檔 462 測試全綠；build 綠；smoke:flow 與 smoke:realtime 全過）

---

## Phase 2: Foundational（阻塞所有 user story）

**Purpose**: 兩處型別變更先落地，US1 與 US2 才編得過

**⚠️ CRITICAL**: 本階段完成前，US1／US2 無法開始（US3／US4 不受此阻塞）

- [x] T003 在 `server/state/types.ts` 同時改兩處（`sentimentGap` 以 optional 布林落地：`undefined` 與 `false` 同義，避免既有測試裡手寫的 `CopilotAnalysisState` 字面值全部要補欄位；判斷一律寫 `=== true`）：① `CopilotSession.watchers` 由 `string[]` 改為 `Array<{ operatorId: string, connectionId: string }>`；② `CopilotAnalysisState` 新增 server-only 欄位 `sentimentGap: boolean`（預設 `false`）。兩者在同一個檔案，**不可平行**；此時 `npm run typecheck` 會紅，那正是本任務的目的——它會逐一指出所有需要改的呼叫點

**Checkpoint**: 型別已就位，US1 與 US2 可以開始（US3／US4 從一開始就可平行）

---

## Phase 3: User Story 1 — 開第二個分頁不會讓第一個分頁安靜死掉（P1）🎯 MVP

**Goal**: 同一位客服的多條連線各自獨立；關掉其中一條，其餘連線的訊息流與 Copilot session 完全不受影響。

**Independent Test**: 同一帳號開兩個分頁連上同一組織／同一段對話，關掉其中一個，
驗證另一個仍持續收到新訊息、且自己送出的訊息不被重複 fan-out。

### Tests for User Story 1 ⚠️

> 先寫測試並確認它們**會紅**，再實作。這一組測試就是本 story「壞掉時會變紅的東西」。

- [x] T004 [P] [US1] 在 `test/connection-counting.test.ts` 建立不變式 I-1／I-2／I-3（憑證登記）：一條連線一筆登記、逾期登記不被 `borrowCredential()` 回傳、`hasForegroundOperator()` ＝任一登記為前景
- [x] T005 [P] [US1] 在 `test/connection-counting.test.ts` 建立**不變式 I-4**（⚠️ 實作時發現 `session-manager.ts` 經 `copilot-runtime.ts` 用到 Nitro auto-import，vitest／tsc 不能 import 它；計數核心因此抽成 `server/services/session-registry.ts`，等式的兩邊都在那裡，測試對它驗） —— `session.watchers.length === pipeline.refs`，對「同一客服兩條連線」「兩位客服各一條」「異常中斷」三組情境各驗一次。⚠️ 測試名稱與註解 MUST 標明它驗的是**單副本**（`pipeline.refs` 是 process-local，多副本下這條等式本來就不成立，見 data-model.md §2）
- [x] T006 [P] [US1] 在 `test/connection-counting.test.ts` 建立 contracts/connection-lifecycle.md §3 的四個情境（關一條／session 不刪／全關才清／不同客服互不影響）
- [x] T007 [P] [US1] 在 `test/connection-counting.test.ts` 建立存活兜底測試：以假時鐘推進超過 `CREDENTIAL_TTL_MS`，驗證逾期登記被回收；心跳抵達後不被回收。⚠️ **MUST 另加兩條「漏拍後」測試**（必讀 3a）：
  ① **漏拍後重建（upsert）**：推進 60 秒（模擬背景分頁被節流成每分鐘一拍）後，**先呼叫 `borrowCredential()` 觸發惰性剔除、斷言登記數為 0**，再送一拍心跳，斷言登記**被重新建立**（新 `connectionId`）且 `borrowCredential()` 又回得出來。⚠️ 回收是惰性的（research #4）——推進時鐘本身**不會移除任何東西**；少了那一步讀取，心跳只是刷新了仍在 Map 裡的舊筆，upsert 分支從未被執行而測試全綠。
  ② **漏拍後刷新（不重建）**：推進 60 秒但**不**讀取，直接送一拍心跳，斷言舊筆被刷新、`connectionId` **不變**、登記數仍為 1（contracts §4「定址時不先套 TTL 濾網」）。
  少了 ①，兜底自己就是缺陷而沒有東西會變紅；少了 ②，「先套濾網」的寫法會通過 ①
- [x] T008 [P] [US1] 在 `test/connection-counting.test.ts` 建立**複製分頁**測試：兩條連線帶**相同** `clientId`，驗證 ① 關掉其中一條不影響另一條、② 一次心跳把兩筆的 `lastSeenAt` 都更新（研究 #1／#2 的兩個坑各對應一條斷言）
- [x] T009 [P] [US1] 在 `test/connection-counting.test.ts` 建立 **I-7／I-8 夾擊測試**：主動離開對該客服**所有**連線生效、連線關閉只影響該條連線。⚠️ 兩條 MUST 同時存在——只驗其中一條時，把兩條路徑合併的錯誤修法會通過測試（SC-002a）

### Implementation for User Story 1

- [x] T010 [US1] 改寫 `server/services/credentials.ts`：registry 形狀改為 `Map<orgId, Map<connectionId, PollingCredential>>`；`PollingCredential` 加 `connectionId`／`clientId`／`lastSeenAt`；`registerCredential()` 收 `connectionId` 與 `clientId`，回傳的 unsubscribe 只移除該筆
- [x] T011 [US1] 在 `server/services/credentials.ts` 加入 `CREDENTIAL_TTL_MS = 45_000`／`CREDENTIAL_HEARTBEAT_MS = 20_000`，並在 `borrowCredential()`／`hasForegroundOperator()`／`registeredOrgIds()` 三個讀取點做**惰性剔除**（research.md #4：不加計時器，理由寫進註解）
- [x] T012 [US1] 在 `server/services/credentials.ts` 新增 `touchCredential(cred)`，更新**命中的全部**登記的 `lastSeenAt`（⚠️ 定址時**不先套 TTL 濾網**：逾期但尚未被讀取剔除的舊筆直接刷新、`connectionId` 保留，contracts §4），**命中 0 筆時以傳入的身分與憑證新增一筆**（upsert，`connectionId` 現場 `crypto.randomUUID()` 另產）；`setCredentialActivity()` 簽章加 `clientId`，同樣更新全部命中者（但**不** upsert —— 活躍度沒有登記可依附時本來就無事可做）。⚠️ 兩者都 MUST NOT 寫成「取一筆」（複製分頁共用 clientId），且 `touchCredential()` 的 upsert **不是保險而是必要**——理由（背景分頁計時器節流 > TTL）MUST 寫進註解，見必讀 3a
- [x] T013 [US1] 新增 `server/api/connection/beat.post.ts`：body 只有 `clientId`（Zod 驗證），以 `requireActiveBffSession(event)` 取得 `operatorId`／`orgId`／`accessToken`（與 `stream.get.ts:48` 同一來源）後呼叫 `touchCredential()`，回傳 `{ ok: true }`。upsert 時的 `connectionId` **由 server 現場另產**——`connectionId` 維持「永不離開 server」，body 一如既往只有 `clientId`。⚠️ **MUST NOT** 接受或回傳任何 token（憲法 1.1）——身分一律從 session 取，不從 body 取
- [x] T014 [US1] 修改 `server/api/stream.get.ts`：連線建立時 `const connectionId = crypto.randomUUID()`；`registerCredential()` 帶上 `connectionId` 與 `clientId`；`attach()` 內的 `watchConversation()` 帶上 `connectionId`
- [x] T015 [US1] 修改 `server/services/session-manager.ts`（計數本體移至 `session-registry.ts`：`attachWatcher()`／`acquirePipeline()`／`detachWatcher()`／`releasePipelineRef()`；`session-manager.ts` 只接 `messageSource` 訂閱與 EventBus 推播）：`WatchRequest` 加 `connectionId`；`upsertSession()` 每條連線各推一筆（不再以 operatorId 去重）；`releasePipeline()` 收 `connectionId` 並只 filter 掉該筆
- [x] T016 [US1] 在 `server/services/session-manager.ts` 調整 `isResume` 的判準與註解：新語意是「這個對話在我 attach 之前已經有人在看」。⚠️ 這是**行為變更**（同一客服的第二個分頁由 `join` 變成 `resume`），MUST 在註解裡寫明，並確認 `session.opened` 的 `reason` 仍無前端消費者
- [x] T017 [US1] 修改 `server/api/presence.post.ts`：`setCredentialActivity()` 呼叫帶上 body 既有的 `clientId`
- [x] T018 [US1] 在 `app/stores/stream.ts` 加入連線層級心跳（常數 `CONNECTION_HEARTBEAT_MS` 住在 `shared/types/events.ts`，server 端的 `CREDENTIAL_HEARTBEAT_MS` 是同一個 binding；`vitest.config.ts` 因此補上 `#shared` alias，否則 app 檔的值匯入在 vitest 下 `Cannot find module`）：SSE 連線建立後每 `CREDENTIAL_HEARTBEAT_MS`（20 秒）打一次 `POST /api/connection/beat`，**與有沒有進入對話無關**；連線關閉時停止。⚠️ 與 presence 心跳是**兩支獨立**的心跳，回答的是不同問題，MUST NOT 合併
- [x] T019 [US1] 在 `test/contract-guards.test.ts` 新增守衛：`server/api/conversations/[id]/leave.post.ts` **MUST NOT** 出現 `connectionId`／`releasePipeline`／`touchCredential`／`registerCredential` 這四個連線層級識別項——防止日後有人為了「統一清理路徑」把主動離開接到連線計數上（research.md #6）。⚠️ 清單裡的每一個名字 MUST 是**實際存在於程式碼的識別項**（沒有 `unregisterCredential` 這支函式——移除是 `registerCredential()` 回傳的閉包），並比照 T033／T046 加上「守衛本身有效」的自檢，否則守衛會恆綠
- [x] T020 [US1] 先把 `POST /api/connection/beat` **加進 `scripts/smoke` 的 `smoke:flow` 呼叫序列與憑證外洩掃描**（回應只允許 `{ ok: true }`；憲法 1.1），再執行 `npm run build && npm run smoke`（含 `smoke:realtime` 的兩位客服／兩條 SSE），確認 HTTP route 與 cookie 往返正常且憑證不外洩。⚠️ smoke 的掃描只掃它打過的 route，新端點不加進去等於沒掃

**Checkpoint**: US1 可獨立驗收。單獨交付這一條就已消除一類客服會回報「訊息不見了」的事故。

---

## Phase 4: User Story 2 — 故障排除之後，情緒走勢不留永久空洞（P2）

**Goal**: 恢復分析時同時補齊先前未涵蓋的客戶發言，情緒時間軸不留缺口，且無缺口時的行為與現況逐字相同。

**Independent Test**: 注入 AI 故障讓中段若干批失敗，排除故障後由新客戶發言觸發恢復，
驗證情緒時間軸涵蓋到全部客戶發言、沒有中斷區間。

### Tests for User Story 2 ⚠️

- [x] T021 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立主線情境：中段若干批失敗 → 新發言觸發恢復 → 時間軸無中斷區間（SC-003）。⚠️ 缺口 **MUST 造在中段**，且其後 MUST 另有成功的批次把高水位推過缺口——把缺口造在尾端時，錯用 `lastCoveredMessageId()` 當錨點的實作也會通過（必讀 5a）
- [x] T022 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立**左界測試**：造一段長度超過 `DEFAULT_MESSAGE_LIMIT`（50）的對話，冷啟動只涵蓋最近 50 則，驗證補算**不**回頭處理 `timeline[0]` 之前的訊息。⚠️ 這是本 story 最容易漏的測試（動工前必讀 #5）
- [x] T022a [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立**空 timeline 測試**（spec FR-008、data-model §3）：冷啟動情緒整批失敗（timeline 為空、`sentimentGap === true`）→ 新客戶發言觸發 → 斷言以 `null` 錨點呼叫 `resolveHistory()`、整個視窗的客戶發言被視為缺口、本輪補 18 則。⚠️ 「沒有 `timeline[0]` 就跳過」的寫法在這條會紅
- [x] T023 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立上限測試：未涵蓋量很大時，單輪最多 **18 則缺口訊息**，以 AI 呼叫次數斷言（FR-009）。⚠️ MUST 造兩組：① 無新發言（呼叫次數 ＝ 3）；② 本輪另有 7 則新發言（呼叫次數 ≤ ⌈7 ÷ 6⌉ ＋ 3 ＝ 5）—— 缺口與新發言合併後才切批，只驗 ① 分不出「上限算的是缺口訊息數還是總批次數」
- [x] T024 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立**零成本測試**：無缺口（`sentimentGap === false`）時，AI 呼叫次數**與取歷史次數**皆與現況逐一相同（FR-012、不變式 S-1）
- [x] T025 [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立止血不退步測試：補算失敗 → 停在 `error` 等待手動重試、**MUST NOT** 自行再排一輪（FR-010、SC-004 對應 003 SC-001）
- [x] T026 [P] [US2] 在 `test/sentiment-backfill.test.ts` 驗證補算**只**擴充情緒的輸入：摘要與建議卡收到的訊息集合不變（research.md #11 的獨立斷言）
- [x] T026a [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立 **LEAVE 優先測試**（FR-011）：客服已離開該對話時，恢復觸發**不得**取歷史、不得排入補算；補算進行中發生 LEAVE 時，**已在飛的不中斷**、但不得再排新的批次。⚠️ MUST 是**新寫**的測試，不能宣稱由 003 FR-012 的既有測試涵蓋——補算是一條新的輸入路徑，既有測試根本不會經過它
- [x] T026b [P] [US2] 在 `test/sentiment-backfill.test.ts` 建立**併發測試**（spec Edge Case「補算與新發言同時發生」）：補算在飛時再來一批新客戶發言，斷言同一則客戶發言**只被送進 AI 一次**、兩者不互相覆蓋涵蓋範圍。⚠️ 實作時發現兩件事，都改在生產路徑：① `runBlockDeduped()` rerun 重跑的是**第一次**觸發的閉包（註解寫的是「再跑一次最新的」，實作存的是布林旗標）——第二批被丟掉、第一批原封重送；改為保留最新那次的 `fn`。② 缺口補算撈歷史時，同時觸發的那批新發言在平台上已存在、會被當缺口一併補掉，rerun 時再送一次——補算路徑一律先濾掉已在時間軸上的訊息（不撈歷史，零成本仍成立）

### Implementation for User Story 2

- [x] T027 [US2] 在 `server/services/analysis-state.ts` 掛上 `sentimentGap` 的轉移：情緒批次失敗（`finishBlockError(_, 'sentiment', _)`）時設為 `true`。⚠️ 只改狀態一律走 `updateAnalysisState()`（`stateLocks` 的不變式）
- [x] T028 [US2] 在 `server/services/copilot-analysis.ts` 新增 `setHistoryResolver()` 與 `resolveHistory()`，形狀完全比照既有的 `setJoinedResolver()`；預設值是安全的無作用值（回空陣列＝視為無缺口）
- [x] T029 [US2] 在 `server/services/copilot-runtime.ts` 載入時呼叫 `setHistoryResolver()`，注入 `messageSource.fetchSince`（相依方向與 `setJoinedResolver()` 相同，管線 MUST NOT 反向 import）
- [x] T030 [US2] 在 `server/services/copilot-analysis.ts` 實作缺口計算：`sentimentGap === true` 時以 **`timeline[0].messageId` 為錨點**呼叫 `resolveHistory()`（⚠️ **不是** `lastCoveredMessageId()`，必讀 5a），缺口 ＝「`timeline[0]` 之後、不在 timeline 的客戶發言」，取前 **18 則**（必讀 5b）；timeline 為空時錨點為 `null`、整批視窗都是缺口（必讀 5）；沿用既有的 `newCustomerMessagesSince()` 去重約定（它對整條 timeline 做差集，正好吃得下 `fetchSince()` 錨點失效時回傳整批的既有約定）
- [x] T031 [US2] 在 `server/services/copilot-analysis.ts` 的 `runIncremental()` 內把「新訊息 ∪ 缺口」只交給 `analyzeSentimentBatch()`；`analyzeSummary()` 與 `analyzeSuggestions()` 的輸入**一個字不變**（動工前必讀 #6）
- [x] T032 [US2] 在 `server/services/copilot-analysis.ts` 補算完成後更新 `sentimentGap`：已無未涵蓋發言時清為 `false`，仍有剩餘時維持 `true`；**MUST NOT** 自行排下一輪（動工前必讀 #7）
- [x] T032a [US2] 在 `server/services/analysis-state.ts`／`copilot-analysis.ts` 補上 `sentimentGap` 生命週期表的**其餘兩條轉移**（data-model.md §3）：**冷啟動成功**與**手動重試成功**時清為 `false`。⚠️ **不需要、也 MUST NOT 為此另判「是否涵蓋到最新」**：`runColdStart()` 與 `retryBlock()` 的輸入都是 `fetchLatest()` 的完整視窗（`retryBlock()` 把整份 `history` 交給 `analyzeSentimentBatch()`，不是只重跑失敗批），成功即必然涵蓋視窗內全部客戶發言，視窗之前的訊息依左界規則本來就不是缺口 —— 「成功即清」，不撈歷史。⚠️ 少了這條，手動重試成功後旗標永遠是 `true`，此後**每一輪客戶發言都多撈一趟歷史**——正是 research.md #9 立這個旗標要避免的成本，而畫面與測試全綠。T024 的零成本測試 MUST 增加「手動重試成功之後」這一組
- [x] T033 [US2] 在 `test/contract-guards.test.ts` 新增**兩條**守衛：① `shared/` 底下不得出現 `sentimentGap`（比照既有的 `failedBatches` 契約 1.1，含「守衛本身有效」的自檢）；② `copilot-runtime.ts` 原始碼 MUST 含 `setHistoryResolver(`（比照 `test/contract-guards.test.ts:140` 既有的 `setJoinedResolver(` 守衛）。⚠️ 少了 ②：T028 的預設 resolver 回空陣列＝「視為無缺口」，T029 的注入一旦漏掉，US2 整個靜默失效而單元測試全綠 —— 正是既有守衛為 `setJoinedResolver()` 立的那個理由

**Checkpoint**: US2 可獨立驗收。此時第三刀拆檔（`blocks/sentiment.ts`）的觸發條件已滿足，但**不在本規格範圍**。

---

## Phase 5: User Story 3 — 建議卡為什麼沒有引用，答得出來（P2）

**Goal**: 任何一次「未引用知識庫」都能分辨成因（未命中／未引用／被捨棄），且杜撰率可重複量測。

**Independent Test**: 對固定的一組真實對話重複量測，穩定產出「杜撰率」與「哪些對話會杜撰」兩項數字，
且該數字在強化命中清單前後可比較。

> ⚠️ **本 Phase 的任務順序是規範，不是風格**：稽核事件 → **基線量測** → 改 prompt → 改動後量測。
> 先改 prompt 就失去了 SC-006 的「可比較」（動工前必讀 #12）。

### Tests for User Story 3 ⚠️

- [x] T034 [P] [US3] 在 `test/citation-audit.test.ts` 驗證 `outcome` 的**六值**判定：`cited`／`no-hits`／`not-cited`／`discarded`／`no-cards`／`failed` 各造一組輸入（contracts/citation-audit-event.md §2），並驗判定順序（**先 `hitCount === 0` → `no-hits`**（失敗與回空也一樣），再 `failed`，再 `cardsReturned`／`cardsKept`；contracts §2 於 2026-09-02 依實作對齊）。⚠️ `discarded`／`no-cards`／`failed` 三組 MUST 順帶斷言 **FR-016 的靜默行為未變**：`status` 仍是 `ready`、`citation` 落 `'none'`、不重試、不轉 `error`。⚠️ `no-cards`（模型回 0 張／整批未過 Zod）與 `failed`（第二段呼叫失敗）是 2026-09-02 補的：原本四值對這兩種「未引用」無值可填，SC-005 的「任何一次」對它們不成立
- [x] T035 [P] [US3] 在 `test/citation-audit.test.ts` 驗證 PII 型別守：以型別層測試（`@ts-expect-error`）確認 `text`／`title`／`snippet` 塞不進事件；並驗證 `invalidSopIds` **有**被保留。⚠️ 另加**長度收斂**測試（contracts §1）：≤64 字元原樣保留、>64 字元改記 `sha256:<前16碼>+<原長度>` 且原字串不出現在輸出裡——型別守擋不到這個欄位，這條是它唯一的機械式保證
- [x] T036 [P] [US3] 在 `test/citation-audit.test.ts` 驗證 FR-015a 的降級：**開檔**失敗時不拋出、不中止、標準輸出的事件仍完整、stderr 留下一行可辨識的原因

### Implementation for User Story 3 —— 第一段：稽核事件（改 prompt 之前）

- [x] T037 [US3] 新增 `server/utils/citation-audit.ts`：定義 `CitationAuditEvent` 型別（含 `text?: never` 等型別守）與 `emitCitationAudit()`；`invalidSopIds` 逐筆施加**長度收斂**（>64 字元改記 `sha256:<前16碼>+<原長度>`，理由寫進註解）；標準輸出寫一行 JSON（NDJSON）。⚠️ 檔案放在**管線外**，理由寫進檔頭（動工前必讀 #9）
- [x] T038 [US3] 在 `server/utils/citation-audit.ts` 加入額外落點（JSONL，環境變數開啟、**預設不啟用**）：建目錄／開檔包在 try/catch，失敗降級為只寫標準輸出並在 stderr 留一行。⚠️ 預設值 MUST NOT 是相對路徑（容器的 WORKDIR 屬 root 卻跑非 root，bind mount 會遮蔽 `chown`）
- [x] T039 [US3] 在 `server/services/blocks/suggestion.ts` 的**三條**落定路徑發出事件：前景兩段式的第二段落定、背景單段落定、「命中已在手」的單段落定。⚠️ **落定包含失敗**：`settleNone()` 的每一個進入點（`hits.length === 0`、`cards.length === 0`、`catch`）都是落定，`failed`／`no-cards` 只會從那裡發出；只在 `publishSuggestionReady()` 發事件會漏掉這兩值。⚠️ 漏掉任一條會讓該路徑的個案永遠查不到（SC-005 對它不成立）
- [x] T040 [US3] 新增 `scripts/spike/27-citation-quality.ts` 與 `npm run spike:citation-quality`：沿用 `spike:progressive` 的骨架（走生產路徑的 `runColdStart()`），收集稽核事件並聚合出整體杜撰率**與逐對話分布**（分母 ＝ `hitCount > 0` 且 `outcome ∉ { no-cards, failed }`，contracts §5）。⚠️ 口徑固定為 **15 段對話 × 3 輪 ＝ 45 次帶命中的生成**，輪次間輪換對話順序（FR-017）——每段對話固定 3 個樣本，是「逐對話分布」看得出集中性的最小條件
- [ ] T041 [US3] **取基線**：`npm run spike:agent-prompts` 後執行 `npm run spike:citation-quality`（15 段對話 × 3 輪 ＝ n=45，FR-017；實跑約 21 分鐘），把結果存進 `scripts/spike/out/` 並記下執行時段。⚠️ 這一步 MUST 在 T042 之前完成

> ⏸ **2026-09-02 `/speckit-implement` 停在 T041**：FR-017 要求固定 15 段對話，而 `.env.local` 的
> `SPIKE_CONVERSATION_IDS` 是佔位字串、歷次 21 號量測都只用過 4 個命令列標題。基線要等使用者提供
> 15 段對話清單（`SPIKE_CITATION_CONVERSATION_IDS` 或命令列），且實跑約 21 分鐘的真實環境 AI 呼叫。
> T042～T044 因「基線在改 prompt 之前」的硬相依一併等待；程式碼（稽核事件、量測腳本）已全部就位。

### Implementation for User Story 3 —— 第二段：封閉清單（基線之後）

- [ ] T042 [US3] 在 `server/services/ai/imbrace-agent-provider.ts` 的 `buildSuggestionPrompt()` 加入**顯式封閉清單**段落（可用的 sopId 列舉 ＋「只能從清單中選、不得自創」）；空集合時明示「本次沒有可用的 sopId，全部填 null」。既有規則 ② 保留
- [ ] T043 [US3] 確認 `whitelistFilter()`（`server/services/blocks/suggestion.ts`）**一行未改**，並在該函式加一行註解指向 FR-014（⏸ 註解已於 T037 一併加上、函式本體未動；「一行未改」的最終確認留到 T042 落地後再做一次，本項因此暫不勾）
- [ ] T044 [US3] **改動後量測**：再跑一次 `npm run spike:citation-quality`（**同一組 15 段對話、同樣 3 輪**，約 21 分鐘），與 T041 的基線並列比較，把兩組數字寫進 `docs/ARCHITECTURE.md`。⚠️ **本項不承諾 004 SC-002 的 80% 會提高**——沒有改善**不代表失敗**，交付物是「答得出為什麼」與「量得出來」

**Checkpoint**: US3 可獨立驗收。SC-005 由事件名與欄位判定，不需讀程式碼。

---

## Phase 6: User Story 4 — 情緒延遲還剩的那個槓桿，量過再決定（P3）

**Goal**: 產出一個有依據的數字，足以支撐「並行度要不要改」這個決定；順帶補上 `user_id` 的衛生欠帳。

**Independent Test**: 跑一次並行度掃描，對每一個檔位同時得到總時間與單次失敗率兩列。

### Tests for User Story 4 ⚠️

> US4 的兩項改動都落在**生產路徑**上（並行度常數、每一次 AI 呼叫），
> 而它們壞掉的方式與其他三則一樣不會報錯。手動 spike 不算「會變紅的東西」——
> 它要有人去跑、去讀數字，而回歸時沒有人會跑它。

- [x] T044a [P] [US4] 在 `test/contract-guards.test.ts`（或就近的單元測試）斷言**未設 env 時 `SENTIMENT_CONCURRENCY === 3`**——這道門只為量測而開，預設值被改掉時 MUST 有東西變紅。⚠️ 另加兩組：`SENTIMENT_CONCURRENCY=''` 與 `='abc'` 時仍為 3（`Number('')` 是 0、`Number('abc')` 是 NaN，交給 `mapWithConcurrency()` 是靜默錯誤）。常數現況是**未匯出**的 `const`（`copilot-analysis.ts:168`），T045 MUST 一併 export，否則本條只能靠行為推測
- [x] T044b [P] [US4] 對假 gateway 斷言 `callAgent()` 的請求 payload **只多了 `user_id`**：其餘欄位與呼叫次數逐一不變（FR-021「MUST NOT 改變任何既有分析行為」的自動化守衛）。⚠️ 並斷言 `user_id` **不等於** `operatorId`——填錯不會報錯，只會讓 AI 服務端的用量統計掛到錯的人身上（research.md #21）

### Implementation for User Story 4 —— 並行度掃描

- [x] T045 [US4] 在 `server/services/copilot-analysis.ts` 把 `SENTIMENT_CONCURRENCY` 改為從 `process.env.SENTIMENT_CONCURRENCY` 讀取，**MUST 驗證為正整數、否則回退 3 並在 stderr 留一行**（data-model §6；`Number()` 直接轉會把空字串變 0、typo 變 NaN），**只在模組載入時讀一次**，並改為 `export`（T044a 要斷言它）；註解寫明「這道門只為 `spike:sentiment-concurrency` 而開，生產設定 MUST NOT 設定它」，並說明為何 `SENTIMENT_CHUNK_SIZE` 不比照辦理
- [x] T046 [P] [US4] 在 `test/contract-guards.test.ts` 新增守衛：受檢清單**明列**為 `.env.example`、`nuxt.config.ts`、`package.json` 的 scripts 三處，斷言它們**MUST NOT** 出現 `SENTIMENT_CONCURRENCY`（含「守衛本身有效」的自檢）。⚠️ 受檢範圍 MUST NOT 擴大成全 repo 掃描——`scripts/spike/26-*.ts` 正是唯一該設定它的地方，擴大範圍會讓守衛自傷。⚠️ 它一旦被抄進某個環境的設定，症狀是「那個環境的情緒延遲莫名其妙不一樣」，沒有任何錯誤。⚠️ **守衛看不到 gitignored 的 `.env.local`**——那正是最可能被貼進去的地方；T045 的註解與 quickstart MUST 寫明此殘餘風險（本地的 `.env.local` 與 Nuxt 共用，貼了就等於改生產路徑）
- [x] T047 [US4] 新增 `scripts/spike/26-sentiment-concurrency.ts` 與 `npm run spike:sentiment-concurrency`：對 3／4／5 三個檔位**各開一個子行程**（同一行程內改不了 module-level const），三輪、輪次間輪換檔位順序（3,4,5／4,5,3／5,3,4）、同一時段連續跑完、**序列執行不得並行取樣**
- [x] T048 [US4] 讓 26 號腳本重用 `spike:progressive` 既有的 `sentimentCalls`（每次呼叫的延遲與成敗）與峰值並發，輸出**總時間分布**與**單次呼叫失敗率**兩列並陳（FR-018）
- [ ] T049 [US4] ⏸（2026-09-02 停在此：實跑約 1 小時的真實環境 AI 呼叫，且需與 T041 同一組固定對話；腳本已就位、`--dry-run` 驗過輪換計畫）**執行掃描**（實跑約 1 小時，加上 T041／T044 的兩次杜撰率量測，本規格量測總時數約 1 小時 40 分；先跑 `npm run spike:agent-prompts`），把原始產出存進 `scripts/spike/out/`，並記錄執行時段；平台若處於已知降級時段 MUST 明確標註（FR-020）
- [ ] T050 [US4] 依 FR-019 的判準做決定並寫進 `docs/ARCHITECTURE.md`：總時間改善**且**失敗率未上升才採用；只有總時間改善 **MUST NOT** 作為採用理由，且該結論本身要留在文件裡。⚠️ 15 秒門檻在本規格期間維持不動（FR-020a）。⚠️ 若決定採用新檔位，MUST **一併複查 FR-009 的「每輪 18 則缺口訊息（＝3 批）」上限**並把結論寫進文件——那個數字的理由是「對齊 `SENTIMENT_CONCURRENCY` 的一波並行」，並行度一改，理由就不再自動成立（維持 18 則仍在一波之內，但 MUST 是被複查過的決定，不是被遺忘的常數）

### Implementation for User Story 4 —— `user_id` 衛生

- [x] T051 [P] [US4] 在 `server/services/imbrace.ts`（防腐層）新增 AI 服務 client user id 的取得與 process-local 快取。⚠️ 註解 MUST 寫明它**與客服身分無關**，填成 `operatorId` 會讓 AI 服務端的用量統計掛到錯的人身上而不報錯
- [x] T052 [US4] 在 `server/services/ai/imbrace-agent-provider.ts` 的 `callAgent()` 帶上 `user_id`，省去 SDK 每次呼叫先 await 一次 auth 的往返（實測 54ms）
- [x] T053 [US4] 執行 `npm run spike:userid` 驗證（2026-09-02 實跑：auth 往返 n=20 中位 55ms／p90 70ms，20 次皆同一個 id；帶 `user_id` 5/5 輸出正常；既有分析行為由 `test/ai-user-id.test.ts` 對假 client 斷言 payload 只多一個欄位）：帶上 `user_id` 不會 400、輸出照常、多次取得的 id 一致；並確認既有分析行為完全不變（FR-021）

**Checkpoint**: 四則 user story 全部可獨立驗收。

---

## Phase 7: Polish & 跨切面

- [x] T054 更新 `docs/ARCHITECTURE.md` §18 M2：把本規格關閉的項目（`registerCredential()` 雙分頁、`session.watchers` 雙分頁、自動恢復不補算、`user_id` 衛生、並行度掃描）逐一標記為已關閉並指向 005
- [x] T055 ⚠️ **執行 `CLAUDE.md` 第一級警告的 grep**（2026-09-02：`雙分頁` 六處皆已帶關閉註記；`未修的缺陷` 只剩節名與一處指向節名的引用（該節仍有未關閉的排序項，節名保留）；`user_id` 的「尚未做」改為已做、發現段落改成過去式；風險表兩列改寫；`三者` 措辭已無殘留）：`grep -rn "雙分頁" docs/`、`grep -rn "未修的缺陷" docs/`、`grep -rn "user_id" docs/`、`grep -rn "並行度" docs/`——同一個結論散落在決策摘要、詳細章節、里程碑驗收、風險表**甚至另一份正典文件**，改完「主要」那份時最危險
- [x] T056 [P] 檢查 `docs/IMBRACE_QUESTIONS.md` 的 0-3e（2026-09-02：改寫為「稽核紀錄與可重複量測已完成、封閉清單進行中、量測後更新 44%／80%」；數字本身待 T044 才能更新）：US3 的封閉清單結果會影響該題的敘述（該題引用了「44% 的呼叫至少產生一張杜撰的知識庫來源編號」）。有新數字就更新，**自行解決的部分要明確撤回並附上解法**，不是默默刪掉
- [x] T057 [P] 在 `docs/ARCHITECTURE.md` §18 M2「分析管線拆檔」註記第三刀的觸發條件（「005 的情緒改動落地之後」）**已滿足**，但**不在本規格執行**
- [ ] T058 依 [quickstart.md](./quickstart.md) 逐項執行手動驗收，特別是 US1 的真實雙分頁情境與「斷網而非關分頁」的存活兜底驗證
- [x] T059（2026-09-02：typecheck 綠、42 檔 552 測試全綠、build 綠、`smoke:flow`（含新加的 beat 四項）與 `smoke:realtime` 全過；`session.opened` 的 `reason` 經 grep 確認仍無前端消費者，T016 的語意變更不影響畫面）執行 `npm run typecheck && npm test && npm run build && npm run smoke`，確認 001～004 的既有驗收全部維持通過（SC-008），與 T002 的基線對照。⚠️ 回歸清單 MUST 點名 T016 的行為變更（`isResume` 語意改變、同一客服的第二個分頁由 `join` 變 `resume`）：它在 spec 沒有對應的 FR／SC，只記在 data-model §2，是最容易在回歸時被忽略的一項

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
- **US4（P3）**：**完全獨立**，Phase 1 之後即可開始。內部可再拆兩束（掃描 T044a／T045～T050、`user_id` T044b／T051～T053，兩束互不相依）

### Within Each User Story

- 測試先寫、先確認會紅，再實作
- 型別 → 服務 → 端點 → 前端
- US3 的「基線在改 prompt 之前」是**硬相依**，不是建議

### Parallel Opportunities

- **T004～T009**（US1 測試）可平行撰寫
- **T021～T026b**（US2 測試，含 T022a）可平行撰寫
- **T034～T036**（US3 測試）可平行撰寫
- **T044a／T044b**（US4 測試）可平行撰寫
- **US3 與 US4 可與 Phase 2／US1 完全平行**——它們不碰 `server/state/types.ts`、
  不碰 `credentials.ts`、不碰 `session-manager.ts`
- ⚠️ **US4 與 US2 有一個檔案交會**：T045（US4）與 T028／T030～T032a（US2）都改
  `server/services/copilot-analysis.ts`。邏輯上互不相依（T045 只動 `SENTIMENT_CONCURRENCY` 那幾行），
  但同時開工會撞 merge；建議 T045 等 US2 的 T032a 落地後再做，或由同一個人接手
- **T051～T053（`user_id`）是整份清單裡最獨立的一束**，任何時候都能插進去做

⚠️ **不可平行**的地方：T010～T012 全在 `credentials.ts`；T013 相依 T012 的 upsert 簽章；
T014／T017 分別改 `stream.get.ts`／`presence.post.ts` 但都相依 T010 的新簽章；
T027～T032a 全在分析管線且共用 `sentimentGap` 的轉移。

---

## Parallel Example: User Story 1 的測試

```bash
# 這六項在同一個檔案的不同 describe，可由不同人同時撰寫後合併：
Task: "I-1／I-2／I-3 憑證登記的三條不變式"
Task: "I-4 watchers.length === pipeline.refs（三組情境、標明單副本）"
Task: "contracts §3 的四個情境"
Task: "存活兜底（假時鐘推進 45 秒）＋ 漏拍後 upsert 重建"
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

三束的檔案幾乎不重疊，交會點有兩個：Phase 2 的 `server/state/types.ts`（一次改完），
以及 `server/services/copilot-analysis.ts`（開發者 B 的 US2 與開發者 C 的 T045 —— 後者排在 US2 之後）。

---

## 交接（2026-09-02 `/speckit-implement` 第一輪停點）

**已完成**：T001～T040、T044a／T044b、T045～T048、T051～T057、T059（58/65），全部已 commit；
`/code-review high d1b4417..HEAD` 跑過六個 finder，明確且屬本次變更的項目已修並 commit
（歷史取回失敗的 try/catch、純附件輪不進去重鎖、dedupe rerun 在 `finally` 消化、摘要 rerun 重讀
`previousSummary`、`invalidSopIds` 從 `whitelistFilter()` 結果反推、歷史解析器找不到 owner 改拋錯、
TTL > 2×心跳的不變式測試、26 號改用 21 號的 `budgetStats()`、風險表兩列、死掉的 re-export）。

**下次續跑**：
1. **T041 → T042 → T043 → T044**：需要你提供固定 15 段對話標題（或填 `.env.local` 的
   `SPIKE_CITATION_CONVERSATION_IDS`），基線約 21 分鐘、改動後再 21 分鐘，先 `npm run spike:agent-prompts`。
2. **T049 → T050**：並行度掃描約 1 小時，同一組對話；決定寫進 `docs/ARCHITECTURE.md`，並複查 FR-009 的 18 則。
3. **T058** 手動驗收（quickstart 的 US1 雙分頁、斷網兜底、背景分頁節流）。

**code review 尚未處置、需要決策的項目**（都不是本次的回歸，屬設計層或既有行為）：
- `runBlockDeduped()` 三次以上併發時中間那次觸發的訊息會被最新的覆蓋而永久漏掉（旗標不會設，
  補算撈不到）。深層修法：rerun 的輸入不放閉包、改由回呼從 state 推導（摘要／建議卡也要）。
- `POST /api/connection/beat` 在 SSE 已關、心跳仍在飛的窗口會 upsert 一筆無人擁有的登記；
  同一 `clientId` 重連後的心跳會讓它（以及半開舊連線的登記）一直續命，45 秒回收在這條路徑上不成立。
  選項：beat 命中 0 筆時不重建、改回傳訊號讓前端重連（會回到「背景分頁節流→失聯」的原始問題，
  需另解）；或重建筆帶「孤兒」標記、由下一次 SSE 登記接管。
- 重建的登記以 `background` 起算，而只開清單頁（沒有進入對話）的分頁**不會送 presence 心跳**，
  切回前景後第一層輪詢會停在 30 秒直到開啟某個對話。選項：beat 的 body 加 optional `visible`。
- `callAgent()` 把 `resolveAiClientUserId()` 的結構性錯誤也吞成一行警告，FR-021 失效時沒有持續訊號；
  可考慮結構性錯誤直接拋、或在 smoke 斷言 `user_id` 存在。
- `runSingleStage()` 在命中 > 0 但卡片全數被捨棄時仍寫 `citation: 'cited'`（004 既有行為），
  與稽核事件的 `discarded` 不一致；`settleOrphanedPendingCitation()`（重啟孤兒）不發事件。
- `collapseSopId()` 對 ≤ 64 字元的字串原樣輸出，短句客訴若被模型塞進 `sopId` 會進 stdout
  （contracts §1 已寫明是歸納不是保證；要更嚴可改為含 CJK／空白即雜湊）。
- `test/realtime-http.ts` 第 567 行仍保留「先關掉 A 兩條連線再開新的」的迴避；缺陷修好後可改成
  真實情境（開 A2、關 A1、斷言 A2 仍收到 `messages.appended`）——這是 `connectionId` 接線唯一能自動化驗到的地方。
- 小項：三支 spike 各自複製 `parseArgs`／寫檔邏輯；27 號每輪重抓歷史；`SessionWatcher.operatorId` 目前無讀者。

## Notes

- `[P]` ＝ 不同檔案、無未完成的相依
- `[Story]` 標籤讓每一項任務都能回溯到 spec 的哪一則故事
- 每個 Phase 結束用 `/commit-split` 分類建立 commit；勾選變更併入該 phase 收尾的 commit
- ⚠️ **本規格的每一項驗證都要能回答「壞掉時什麼會變紅」** —— 答不出來的驗證等於沒驗，
  因為這四類缺陷全部不會報錯
- ⚠️ **判讀任何 AI 相關數字之前先跑 `npm run spike:agent-prompts`**（§11）：
  量測數字是間接證據，快照 diff 是直接證據
