# Phase 0 研究：結案摘要與人審面板

**Spec**: [spec.md](./spec.md) ｜ **Date**: 2026-09-03

> 本規格是 M3 第一個要**寫入正式 CRM** 的功能，也是第一個要碰 Data Board API 的功能。
> 因此本文件的重心不在「怎麼寫比較漂亮」，而在**哪些前提還沒被實測過** ——
> ✅ **2026-09-03：五項待實測全部跑完**（`spike:board-write`、`spike:closure-agent`），
> 其中 **#5／#7／#9 被推翻**，#6／#20 確認。下面每一項都已改寫為實測結論，
> 原本的假設保留在各項的「原假設」欄，因為推翻的理由本身就是設計依據。
> ⚠️ 三項被推翻的**全部是不報錯的靜默失效**，這不是巧合 —— 那正是 Data Board 這層的性格。

---

## A. 最重要的發現：結案摘要沒有 agent 可以呼叫

### #1 iMBrace 後台只有四個 agent，沒有一個產得出 `ClosureSummary`

- **Decision**：需要在 iMBrace 後台**新增第五個 agent**
  `AgentCopilot_結案摘要_agent`（環境變數 `IMBRACE_CLOSURE_AGENT_ID`），
  由 `AIProvider.summarizeClosure()` 呼叫。**這是本規格唯一一項 repo 外的前置作業。**
- **Rationale**：`docs/AGENT_PROMPTS.md` 的四個 agent 是 summary／sentiment／suggestion／knowledge。
  摘要 agent 的 `core_task` **逐字寫死了 `ConversationSummary` 的九個欄位**
  （`narrative`／`topics`／`intent`／`keyFacts`／`attempted`／`openIssues`／`riskFlags`／`advice`
  ＋「不要輸出 updatedAt 與 basedOnMessageId」），而 `ClosureSummary` 要的是
  `category`／`resolution`／`actionsTaken`／`sentimentOutcome`／`citedSopIds`／`followUps`
  —— **兩份形狀沒有交集**。拿摘要 agent 去要另一種 JSON，等於用 user prompt 對抗 system prompt：
  有時會成功、有時回舊形狀，而且**後台任何一次 prompt 微調都可能讓它靜默翻臉**
  （`CLAUDE.md` 的第四顆地雷正是在講這件事）。
- **Alternatives considered**：
  - ❌ **重用摘要 agent** —— 上述理由。
  - ❌ **用既有的 `ConversationSummary` 拼裝，不再呼叫 AI**：`ConversationSummary` 是**全對話的滾動摘要**
    （`basedOnMessageId` 是最新一則），而 FR-021 要求摘要只能涵蓋**本次區間**。
    拿滾動摘要當結案摘要，等於默默違反 FR-020／FR-021／FR-022 而且不會報錯。
  - ⚪ **保留為後續選項**：`category`／`resolution` 這類受控詞彙分類，理論上可由既有摘要 agent
    加一次分類呼叫完成。但那是兩次 AI 呼叫、兩份 prompt 要同步，且仍不解決區間問題。
- **對本規格的影響**（重要）：
  - `MockAIProvider.summarizeClosure()` 讓 US1～US3 的**整條路徑（面板、編輯、冪等寫入、
    四種失敗形態）完全可以在沒有第五個 agent 的情況下開發與驗收** —— 那些驗收本來就不需要真實 AI 產出。
  - 只有 SC-004（等待期間的誠實呈現）與「摘要內容品質」需要真 agent。
  - `npm run spike:agent-prompts`（`25-agent-prompt-drift.ts`）的 agent 清單 MUST 一併加上第五個，
    否則新 agent 的 prompt 會變成**唯一一個沒有快照保護的** —— 而那正是 §11 那顆地雷的形狀。

### #2 ✅ 已完成：第五個 agent 已建立，模型維持 `google.gemma-3-27b-it`

- **實測**（`spike:closure-agent`，n=8）：8/8 產出合格 JSON、受控詞彙 **0 挑錯**、
  無簡體字、`summary` 平均 152 字（prompt 要求 120–250）。中位數 **9.4 秒**。
- **模型不換**。判斷依據是 `ARCHITECTURE.md` 附錄的既有數據，不是新的掃描：
  C-1（情緒，**短輸出**）顯示 `gpt-oss-20b` 比 `gemma` 快一倍；
  但 C-2（建議卡，**長 prompt ＋ 結構化輸出**，與結案摘要同一種形狀）顯示兩者中位數幾乎相同
  （9217 vs 9209ms），而 `gpt-oss` 的標準差是 **3.6 倍**、1/15 超過 15 秒。
  結案摘要要的是穩定不是創意，`gemma` 是對的選擇。
- ⚠️ **刻意不在此時做模型掃描或品質調校**：現在只能用手捏的假對話，
  等 `buildClosurePrompt()` 接上真正的涵蓋區間切分後結果就作廢，
  還會留下一組看起來有效、實際不可比的數字（`18-agent-model-latency.ts` 檔頭記錄過同一個陷阱）。
- agent 由**後台 UI 手動建立**（與既有四個相同），已納入 `spike:agent-prompts` 的快照清單，
  `docs/AGENT_PROMPTS.md` 現有五個 agent。

---

## B. Data Board：五項前提（已全部實測）

### #3 SDK 的 Board API 形狀

- **Decision**：用 `boards.list()`／`boards.get()`／`boards.createField()`／`boards.createItem()`／
  `boards.updateItem()`／`boards.getItem()`／`boards.search()`。全部經
  `server/services/imbrace.ts` 的防腐層包裝，**MUST NOT 讓 route 直接碰 SDK**（憲法 1.2、CLAUDE.md 地雷 3）。
- **Rationale**：`node_modules/@imbrace/sdk/dist/resources/boards.d.ts` 逐一確認存在。
  `search()` 的簽章是 `(boardId, { q?, filter?, limit?, offset?, sort? })`，
  回傳 Meilisearch 相容信封 `{ success, message: { hits: BoardItem[], estimatedTotalHits } }`
  —— **注意回傳形狀與 `listItems()` 的 `PagedResponse` 不同**，兩者不可互換。
- ⚠️ **2026-09-03 實測修正**：`search()` 的 `filter` 與 `sort` **都被平台靜默忽略**（見 #8、#9），
  因此實際可用的只有 `q`（全文檢索）＋ 本地過濾與本地排序。
  `listItems()` ＋ 本地過濾原本被否決（會退化成全表掃描），現在它與 `q` 的差別只剩「先粗篩一次」——
  仍用 `q`，因為它至少縮小了要比對的筆數，但**不能再假設平台幫我們過濾好了**。

### #4 Board 的識別：用環境變數，不用名稱查找

- **Decision**：`IMBRACE_CLOSURE_BOARD_ID` 由 setup script 印出、寫進 `.env.local`。
  執行期以此為準；**MUST NOT 每次寫入前用 `boards.list()` 依名稱找**。
- **Rationale**：名稱不是唯一鍵（實測 25 個 board，`boards.list()` 無唯一性保證），
  同名 board 出現時會靜默寫錯地方 —— 而 Board 是正式 CRM，寫錯的紀錄不會有錯誤訊息。
  setup script 的 `--verify` 模式負責確認該 id 仍指向欄位齊全的 board。
- **Alternatives considered**：名稱查找 ＋ 快取（否決，同上）；寫死 id（否決，換環境就爛）。

### #5 ✅ 已實測（原假設**部分被推翻**）：欄位 id 的取得方式

- **Decision**：`createItem`／`updateItem` 的 body 為 `{ fields: { <欄位id>: value } }`（假設成立）；
  但**欄位 id MUST 由 `boards.get()` 反查，MUST NOT 取 `createField()` 的回傳值**（假設被推翻）。
  `board-repository` 維持 name→id 的 process-local 快取（TTL 10 分鐘），來源改為 `boards.get()`。
- **實測**（`006-E2a`／`006-E3`）：`createItem` 確實吃欄位 id 而非欄位名。
  但 SDK 對 `createField()` 的註解逐字寫著「data-board returns the field directly
  (unlike legacy backend which returned the full Board)」—— **那句是錯的**，
  它回傳的是**整個 board**，`_id` 是 board id。
- ⚠️ **照註解實作的後果**：六個欄位全部拿到同一把 id → 六次寫入疊在同一把 key 上
  （last-write-wins）→ **平台照樣回 200**。症狀是「只有最後一個欄位有值，其餘全 null」，
  沒有任何錯誤訊息、沒有型別錯誤。這是本規格找到最危險的一條靜默失效路徑，
  也是 CLAUDE.md 地雷 3（SDK 型別與實際 API 不一致）的新實例。
- ⚠️ 平台的回應**一律包一層 `{ data: ... }`**，而 SDK 的型別（`Promise<Board>`、`Promise<BoardItem>`）
  沒有反映。首跑漏了這一層，`getItem()` 的每個欄位都讀成 `undefined`，
  差點把「我方沒解開外層」寫成「平台會靜默丟棄值」—— 一條會被寫進正典文件的假結論。
- **快取失效的地雷仍然成立**：欄位在平台上被改名後快取指向舊名 → 該欄位靜默寫不進去。
  因此快取 MUST 有 TTL，且 `--verify` 模式 MUST 不吃快取。

### #6 ✅ 已實測（假設成立）：`Number` 可用，且留空與 0 可區分

- **Decision**：`sentiment_*`／`period_message_count`／`confidence` 用 `Number`；
  **FR-022b 的「留空」以「不送該欄位」表達**。
- **實測**（`006-E2`／`006-E4`）：六種型別（`ShortText`／`LongText`／`Number`／`Date`／
  `SingleSelection`／`MultipleSelection`）全數可建立。未設定的 `Number` 欄位回讀為 **`null`**，
  與 `0` 明確可分。
- **因此 FR-022b 成立**：情緒三數值在評分點不齊時留空，報表不會把它讀成最低分。
  原本準備的退路（改用 `ShortText` 存數值字串、犧牲數值排序能力）**不需要動用**。

### #7 ✅ 已實測（原假設的**理由**被推翻，結論維持）：`text[]` 用 `LongText`

- **Decision**：`operators`／`cited_sops` 用 `LongText` 存 JSON 陣列字串（結論不變）；
  `actions_taken` 用 `MultipleSelection`（結論不變）。
- **實測**：
  - `006-E6`：`LongText` 可原樣往返 `["u_1","u_2"]`，無跳脫或截斷。
  - `006-E5`：`MultipleSelection` **會照收**選項清單外的值（原假設是「拒收或靜默丟棄」）。
- ⚠️ **理由改變了，結論卻更該維持**。原本選 `LongText` 是因為怕開放值域的值被丟棄；
  實測顯示不會被丟棄，所以 `operators`／`cited_sops` 技術上**可以**改用 `MultipleSelection`。
  仍然不改的理由是另一個：那會讓每一個新的客服 id／SOP id 都被記進該欄位的**選項清單**，
  選項清單於是隨資料無限成長 —— 那是把 schema 當資料用。`LongText` 沒有這個問題。
- ⚠️ **E5 連帶修正了 setup script 的一條驗證理由**：契約原本寫「選項不同步會讓該值寫入被丟棄」，
  **那是錯的**（值會寫進去）。真正的後果較輕但仍要修：該值不會成為 Board 上的正式選項，
  報表的篩選器裡看不到它。`--verify` 的選項比對因此保留，但理由要改寫（契約 B4）。

### #8 ⚠️ 已實測（**第一步的實作方式被推翻**）：`filter` 無效，改用 `q` ＋ 本地比對

- **Decision**：`commitClosure()` 的順序仍是三步，但第一步改寫：
  ① `boards.search(boardId, { q: '<draftId>' })` → **在本地逐字比對 `draft_id` 相符**
  → ② 命中 0 筆 `createItem()`／命中 1 筆 `updateItem()`
  → ③ `getItem()` 回查確認存在且 `draft_id` 相符。
- **實測**（`006-E7`，board 內 3 筆、目標 1 筆）：

  | 呼叫 | 結果 |
  |---|---|
  | `filter: '<欄位id> = "draft-aaa"'` | 回**全部 3 筆** |
  | `filter: '<欄位名> = "draft-aaa"'` | 回**全部 3 筆** |
  | `filter: '<欄位id>:"draft-aaa"'` | 回**全部 3 筆** |
  | `q: 'draft-aaa'` | 回 **1 筆**（正確） |

- ⚠️ **`filter` 被靜默忽略**：不報錯、不回 400，就是照回整批。這與 §9.3 的訊息增量拉取
  （`since`／`after` 等八種寫法全部被忽略）是**同一個形狀**，可以視為這個平台的性格。
- ⚠️ **`q` 是全文檢索，不是精確比對**，因此本地的逐字比對 **MUST NOT 省略** ——
  少了它，「查有既有紀錄」會退化成「隨便抓一筆看起來像的」，然後 `updateItem` 會去改到
  **別人的結案紀錄**。⚠️ 這件事不會報錯，而且被改掉的是同事的工作成果。
- **③ 回查仍然不可省**：平台不保證唯一鍵（`uniqueSeen: 0`），200 不等於紀錄真的建立了。
- 命中 ≥ 2 筆的處置不變：取最早建立的那一筆更新，並記一行警告日誌。
- 已記入 `docs/IMBRACE_QUESTIONS.md` **D-5**（🟠），詢問正確語法；**不等回覆，先用本方案。**

## C. 涵蓋區間：三項成本與正確性的取捨

### #9 ⚠️ 已實測（**被推翻**）：候選清單必須本地過濾與本地排序

- **Decision**：`boards.search(boardId, { q: '<conversationId>' })`
  → **本地**逐字比對 `conversation_id`
  → **本地**依 `closed_at` 降冪排序
  → 取前 5 筆，並以「本地比對後的總筆數」決定畫布 `scopeState` 的 `overflow`。
- **原假設（已作廢）**：`{ filter: 'conversation_id = "<id>"', sort: ['closed_at:desc'], limit: 6 }`，
  取 6 筆用來知道「有沒有第 6 筆」，總數取自 `estimatedTotalHits`。
- **實測**（`006-E7`／`006-E8`）：
  - `filter` 被靜默忽略（見 #8）。
  - `sort` **看起來有效**（`:desc` 與 `:asc` 回的順序互為相反），但拿一個**不存在的欄位名**
    去排會得到**完全相同**的順序 —— 決定性證據：**排序的欄位被忽略**，
    平台實際依**建立時間**排序，只有方向生效。
- ⚠️ **`sort` 這一條特別危險，因為它在多數情況下看起來是對的**：結案紀錄的建立順序
  通常就等於 `closed_at` 的順序，要到有人補登、或多副本時鐘不同步才會分岔。
  屆時客服拿到的是排錯的候選（可能選到更舊的區間），**而畫面上完全看不出來**，
  寫進 Board 的 `period_start` 也就跟著錯。
- ⚠️ `estimatedTotalHits` **不能用來算 `overflow` 的「另有 N 個」** ——
  它是 `q` 的命中數，不是「該對話的結案紀錄數」。必須用本地比對後的筆數。
- **候選的 `label`** 逐字取自畫布：「上次結案 · 分類：{category}（{審核者顯示名}）」——
  `category` 與 `reviewed_by` 必須跟著候選一起查回來。
- 已記入 `docs/IMBRACE_QUESTIONS.md` **D-5**；**不等回覆，先用本地方案。**

### #10 則數怎麼算：一次降冪掃描，算出全部候選的則數

- **Decision**：取回候選後，**一次**由新到舊分頁掃訊息（`skip` 分頁，沿用既有的取數路徑），
  一路數到「最舊的候選 `closedAt`」為止，再以 `at` 做區間切分，一趟算出所有候選的則數。
- **Rationale**：每個候選各掃一次是 N 倍成本，而它們的區間是巢狀的 —— 掃最舊那個就順便涵蓋了全部。
- ⚠️ **「從第一則對話起算」的則數需要掃完整段歷史**（實測單一對話最多 398 則，§9.3）。
  因此掃描 MUST 有上限：**預設 500 則（10 頁 × 50）**。超過上限時，
  該候選的則數以「**超過 500 則**」呈現，MUST NOT 顯示一個數不完就猜的數字（憲法 4.5）。
  ⚠️ 這個上限**只影響顯示**，不影響摘要內容 —— 真正送去產生摘要的訊息由 #11 的快照決定。

### #11 快照：在 server 端取，不用瀏覽器手上那份

- **Decision**：產生草稿的端點自己去取「`periodStart` 之後的訊息」，**MUST NOT** 接受前端傳來的訊息內容。
- **Rationale**：① 瀏覽器手上只有已載入的部分（`hasMore` 為真時不完整）；
  ② 讓前端送訊息內容等於開一條「客服可以竄改送給 AI 的對話內容」的路；
  ③ FR-020 的快照語意要求「按下那一刻」—— server 端取數的時間點就是那一刻，語意最直接。
- ⚠️ **FR-020 最容易寫錯的地方**：寫入端點若再取一次最新訊息來重算摘要，
  客服確認過的內容與實際寫入的內容就不一致，而且不會報錯。
  **因此寫入端點 MUST NOT 接觸任何訊息取數路徑** —— 它只收草稿內容與區間，直接寫。
  `test/contract-guards.test.ts` 加一條守衛掃描該檔不得出現訊息取數的呼叫。

### #12 自訂起算時間（FR-021e-1）

- **Decision**：前端傳 `periodStart` 的 ISO 時間 ＋ `periodOrigin: 'custom'`。
  server 一律以「該時點之後的第一則訊息」為實際起點，與選 `closedAt` 的路徑**共用同一段程式碼**。
- **Rationale**：兩條路徑只差在 `periodStart` 從哪來；分兩份實作遲早會分岔。
- `periodOrigin` 是 `'closure' | 'first' | 'custom'` 三值，**MUST 隨紀錄寫入**（FR-021e-1 逐字要求
  「自訂起點 MUST 在面板與正式紀錄上皆可辨識為『自訂起算時間（非結案起點）』」）。
  ⚠️ 這是 §13.3 的欄位表**目前沒有**的一欄 —— 見 #21 的文件改判義務。

---

## D. 情緒數值

### #13 三個數值由 server 從既有時間軸算出，不再呼叫 AI

- **Decision**：讀 `CopilotAnalysisState.sentimentBlock.timeline`，
  過濾 `kind === 'point'` 且 `at >= periodStart` 的點：
  `sentimentStart` ＝ 最早一點、`sentimentEnd` ＝ 最晚一點、`sentimentTrough` ＝ 區間內最小 `score`。
- **Rationale**：這三個是**事實計算**不是推論（FR-010a 因此把它們列為唯讀）。
  再呼叫一次 AI 只會製造第二個真相來源，而報表若與面板上的 sparkline 對不起來，
  沒有人分得出哪一個才對。
- ⚠️ **`sentimentTrough` MUST NOT 取 `sentimentBlock.stats.lowestScore`** ——
  那是**整條時間軸**的最低點（sparkline 用），跨越了區間邊界。FR-022a 逐字禁止。
  這是「不報錯但會做錯事」的第一名候選，`test/` MUST 有一條專門會紅的迴歸測試。

### #14 評分點不齊時三個數值留空（FR-022b）

- **Decision**：若 `timeline` 的**最早一個 point 的 `at` 晚於 `periodStart`**，
  代表區間起點沒被涵蓋到 → 三個數值全部留空（不送該欄位），並在 `period_sentiment_note`
  以一行說明實際涵蓋範圍。
- **Rationale**：兩個成因（2 小時 sliding TTL 過期、冷啟動 50 則上限）在**現有狀態裡分不出來**，
  也不需要分 —— 對報表而言結論都是「這一段的情緒不可信」。
  只取現有點的最低值會安靜地把「近期最低點」寫成「本次最低點」（FR-022a 的反面）。
- **Alternatives considered**：重跑整段區間的情緒分析（成本 ＝ 區間則數 ÷ 批次大小 × 5 秒，
  長區間動輒數分鐘，直接撞爛 SC-004；且憲法 5.3 附註的「保留期限」尚未拍板，
  補算出來的點也無處可存）。

---

## E. 前端狀態與流程

### #15 結案狀態放 Pinia store，**不進 `localStorage`**

- **Decision**：新增 `app/stores/closure.ts`（tab-local、per-conversation），
  持有 `{ draftId, periodStart, periodOrigin, draft, status, error }`。
  **MUST NOT 寫 `localStorage`、MUST NOT 進 `StateStore`。**
- **Rationale**：FR-040 逐字要求「重新整理或登出 MUST 等同取消結案」。放進 store 而非
  `useConversationView` 的區域 ref，是因為 FR-041 的**側欄標記**要跨對話讀得到它。
- ⚠️ **與憲法 8.4「草稿絕不遺失」看似衝突，實際不衝突**：8.4 的標的是 **Composer 草稿**
  —— 客服自己打的字，遺失無從復原。結案草稿是**模型產物**，重按一次就能重生，
  且尚未寫入任何紀錄，取消不需要補償動作（FR-040 逐字寫明這一點）。
  ⚠️ 這個區別 MUST 寫進 store 的檔頭註解 —— 否則下一個人看到「草稿」兩個字就會依 8.4 加上持久化，
  而那會讓 FR-040 靜默失效（重新整理後回到一個半完成的結案面板，且沒有任何錯誤）。

### #16 結案流程 MUST NOT 先 LEAVE —— 這是一次刪除，不是新增

- **Decision**：`closeConversation()` 改成**只開面板**，不呼叫 `/leave`。
  LEAVE 移到寫入成功之後（FR-033）。
- **Rationale**：M2 現況是「先 leave → 停止分析 → 隱藏面板」。新流程裡客服在結案期間**仍是 JOIN 狀態**，
  於是 FR-005（結案期間分析照常執行、門檻維持 003 FR-012 的單一條件）
  **靠刪掉那行 leave 就自動成立**，不需要為結案新增任何分析門檻條件。
- ⚠️ `app/composables/useConversationView.ts` 的 M3 銜接長註解在落地時 MUST 一併改寫 ——
  它現在寫的是「插入點在停止分析與隱藏面板之間」，而正確答案是「**那兩件事都往後移**」。
  留著會讓下一個人以為順序沒變。

### #17 面板不新增 SSE 事件

- **Decision**：三支端點全部走 HTTP request／response。**不新增任何 `CopilotEvent` 型別。**
- **Rationale**：草稿只活在一個分頁裡（FR-040），沒有第二個消費者需要被推播。
  唯一的例外是 presence 的「正在結案」，見 #18 —— 它搭既有的 `presence.updated` 便車。

### #18 「XXX 正在結案」是 `PresenceEntry` 的**布林**，不是 `PresenceState` 的第四個值

- **Decision**：`PresenceEntry` 加 `closing: boolean`，與既有的 `joined: boolean` 並列。
  `PresenceState` 維持 `'viewing' | 'composing' | 'joined'` 三值不動。
- **Rationale**：這與 `joined` 為什麼不併進 `state` 是**同一個判斷**
  （`shared/types/conversation.ts` 該欄位的註解逐字記錄過）：客服可以同時「正在結案」和「正在輸入」。
  併成列舉的話，結案期間打一個字就會把「正在結案」蓋掉 —— 症狀是同事畫面上的提示忽隱忽現，
  而且不會報錯。⚠️ 這正是本專案在 `mode` 與 presence 上已經吃過兩次虧的形狀（§10.2、§10.6）。
- **不持久化**：跟著既有的 presence TTL 走，天然滿足 FR-045 的「MUST NOT 讓 FR-040 失效」。
- 這是 FR-045 的 **SHOULD**，優先序排在所有 MUST 之後。

### #19 受控詞彙設定檔用 `.ts` 而不是 `.yaml`

- **Decision**：建立 `config/categories.ts`，匯出四份 `as const` 陣列
  （`CATEGORIES`／`RESOLUTIONS`／`ACTIONS_TAKEN`／`SENTIMENT_OUTCOMES`），
  **不新增任何相依套件**。
- **Rationale**：這份清單有**四個消費者**：AI prompt、server 端後驗（Zod enum）、
  面板的選單選項、setup script 建立 `SingleSelection`／`MultipleSelection` 的選項。
  四邊都要 import 它。用 `.ts` 換到一件 `.yaml` 換不到的東西：
  `RESOLUTIONS satisfies readonly ClosureSummary['resolution'][]` 讓
  「設定檔的值域」與「型別的字面聯集」的一致性**在 typecheck 就會紅**，
  不必靠一條可能被漏寫的測試。而 `resolution`／`sentimentOutcome` 的值域本來就寫死在
  `ClosureSummary` 的型別裡（§11.5），兩處分岔是必然會發生的事。
- **Alternatives considered**：
  - `.yaml` ＋ 新增 `yaml` 套件：憲法 4.6 與 §11.7 都逐字寫 `config/categories.yaml`，
    照抄最省事 —— 但換來一個相依、一份執行期解析，且失去上面那個編譯期保證。
  - `.json`：無註解、無型別，且 `import ... with { type: 'json' }` 在 tsx／Nitro／vitest
    三個載入器下的行為不一致（本專案路徑含空白，載入器問題已經吃過虧）。
- ✅ **文件改判義務已完成（2026-09-03）**：`CONSTITUTION.md` 4.6（發布為 v4.0.1，PATCH）與
  `ARCHITECTURE.md` 的四處（§5 目錄樹、§11.5、§11.7、§19.3 未完成索引）已全部訂正。
  `grep -rn "categories.yaml" docs/` 為零結果；`specs/003` 內的命中是當時的歷史紀錄，保留不改。

### #20 ✅ 已裁示：SC-004 的固定秒數門檻撤銷，改驗「等待期間是否誠實」

- **Decision**：**摘要產生不設固定秒數門檻**（2026-09-03 使用者裁示），
  改以 SC-004 的三個 0 驗收：顯示「已完成」而實際未完成 **0** 次、
  顯示會過期的時間承諾 **0** 次、產生期間無法取消 **0** 次。
- **Rationale**：撤銷的理由**不是**「我們達不到」（原文正確地禁止了那種放寬），
  而是**口徑套錯了**。10 秒是為**增量摘要**訂的 —— 每次只看新增幾則訊息，工作量固定；
  結案摘要看的是整段服務，可能數百則，工作量由涵蓋區間長度決定。
  拿固定工作量的門檻去量變動工作量的作業，訂緊了長區間永遠紅、訂鬆了短區間永遠綠。
- **實測參考值**：短區間（9 則）中位數 9.4 秒。長區間逾 1 分鐘為可接受。
  ⚠️ 這個數字**只作容量規劃參考，MUST NOT 回頭變成驗收門檻**。
- ⚠️ **但「不設門檻」MUST NOT 蔓延到寫入路徑**（FR-032a）：寫入是三次 Board 呼叫、
  工作量固定，正是應該有門檻的那一類，取 **30 秒**硬逾時。
  沒有它的話，FR-040a 的「寫入中不可取消」就變成「客服被卡住出不來」——
  **兩條 MUST 一起讀**：產生不設限但隨時可取消，寫入有上限但期間不可取消。
- **仍然成立的**：候選查詢與則數掃描可與面板開啟平行；
  ⚠️ **MUST NOT 為了搶時間就先用預設區間跑一次 AI**，客服改選區間時那次必定被丟棄。

---

## F. 文件與驗收

### #21 §13.3 的欄位表少了 `period_origin`，MUST 補

- **Decision**：Board schema 與 `ClosureSummary` 各加一欄
  `period_origin` / `periodOrigin`（`'closure' | 'first' | 'custom'`）。
- **Rationale**：FR-021e-1 逐字要求自訂起點在**正式紀錄上**可辨識為「自訂起算時間（非結案起點）」。
  只有 `period_start` 這個時間戳的話，事後**無法區分**「客服選了某次結案」與「客服自己打了一個時間」
  —— 而候選清單只列最近 5 筆，更早的區間一律走自訂，這個混淆會很常見。
- ⚠️ 依 FR-052，新增欄位 MUST 同步 setup script 的清單與 `--verify` 的比對清單。
  同 #19，這是本規格第二筆文件改判義務。

### #22 「會紅的迴歸測試」清單（spec.md 驗收補充要求 3）

規格逐字點名四條路徑，逐一對應到本計畫的落點：

| 路徑 | 會紅的測試 | 為什麼型別檢查抓不到 |
|---|---|---|
| 寫入回應成功但紀錄不存在 | 假 gateway 回 200 但 `getItem` 回 404 → 端點 MUST 回失敗 | 200 就是 200，沒有型別能表達「這個 200 是假的」 |
| 快照被實作成「送出時取最新」 | 契約守衛掃描寫入端點不得出現訊息取數呼叫（#11） | 取最新與取快照的型別完全相同 |
| 情緒最低點被算成近期最低點 | 造一條跨兩個區間的 timeline，斷言 trough 只看區間內（#13） | `stats.lowestScore` 與區間最低值都是 `number` |
| Board 少建一欄 | setup script `--verify` 對缺欄以非零離開（FR-051） | 平台不會為缺欄報錯，只會讓該維度永遠是空的 |
| 冪等查詢誤信平台已過濾 | 假 gateway 對 `q` 回多筆不相符的紀錄 → 端點 MUST 不去 update 它們（#8） | `filter` 被忽略時回的是合法的 200 ＋ 一批合法的紀錄 |
| 候選清單誤信平台已排序 | 造一批 `closed_at` 與建立順序相反的紀錄，斷言取到的是最近 5 筆（#9） | 兩種順序在多數資料上相同，只有補登或時鐘偏移時才分岔 |

### #23 SC-005（＝ 003 SC-007 重跑）是人工驗收，不是自動化

- **Decision**：排在寫入路徑可用之後、里程碑收尾之前執行，找 3 位未參與者。
  **MUST 在 `tasks.md` 有一個獨立任務**，否則它會像 003 那次一樣被「結案」而不是被驗證（FR-003）。

### #24 ✅ 已完成：兩支 spike 已跑，正式環境無殘留

- `29-board-write-path.ts`（`npm run spike:board-write`）：涵蓋 #5／#6／#7／#8／#9。
- `31-closure-agent-shape.ts`（`npm run spike:closure-agent`）：涵蓋 #2，唯讀。
- ⚠️ **29 是本專案第一支有實質寫入副作用的 spike**，且 `IMBRACE_ENV=stable` 是正式環境。
  安全機制：① 不帶 `--yes` 只印計畫；② board 名稱固定帶 `_spike_closure_` 前綴 ＋ 時間戳；
  ③ 結束時**依名稱前綴掃描刪除**。
- ⚠️ **③ 是第一次跑之後才改成這樣的，理由值得記下**：原本的清除吃「建立時取得的 board id」，
  而首跑正是**在取 id 那一步失敗**（SDK 型別沒說回應包了一層 `{data:...}`）→ 提早 return
  → 清除拿到 `null` → **正式環境留下一個 board**（事後手動刪除）。
  **「清除的前提是前面每一步都成功」是個很爛的前提** —— 清除存在的理由恰恰是前面會失敗。
  改成前綴掃描後，腳本在任何一步爆掉都收得乾淨，重跑還會順手撿走上一輪的殘留。
- ⚠️ 首跑另有一次**歸因錯誤**：`getItem()` 讀不到值，`impact` 差點寫成「平台會靜默丟棄值」，
  實際是我方沒解開 `{data:...}`。是翻原始 fixture 才擋下來的。
  **spike 的 `impact` 欄位是會被寫進正典文件的東西，下結論前 MUST 先看原始 JSON。**
- 未來還需要一支 `30-closure-latency.ts` 量 SC-004 的整條流程，
  但它要等 US1 落地（三段都接起來）才量得了，**不在前置作業內**。
