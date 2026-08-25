# 待向 iMBrace 團隊確認的事項

> 用途：一次性向 iMBrace 團隊確認 AgentCopilot 所需的規格
>
> 建議做法：**一次問完**。分批詢問會拉長等待週期，且部分問題彼此相關（例如 webhook 的 operator 清單同時影響 presence 設計與撞單防護）。
>
> 更新日期：2026-08-25

---

## ⚠️ 2026-08-25：本清單已大幅縮短

我們完成了 `@imbrace/sdk@1.4.0` 的**型別層靜態分析**（解開 npm 套件通讀全部 `.d.ts`），
自行解答了其中數題。**請優先回覆下方標記為 🔴 的項目**，其餘僅供確認或已無需回覆。

| 標記 | 意義 | 是否需要貴方回覆 |
|---|---|---|
| ✅ **已自行解答** | 已從 SDK 型別確認，不需佔用貴方時間 | 否（如有出入請指正） |
| 🟡 **已縮小範圍** | 大部分已釐清，僅剩具體細節 | 簡答即可 |
| 🔴 **仍需回覆** | 型別層無法回答，且會阻塞開發 | **是** |

**完整分析見我們的 `docs/SDK_FINDINGS.md`（可應要求提供）。**

### 快速索引

| 題號 | 狀態 | 一句話 |
|---|---|---|
| A-1 完整 operator 清單 | ✅ | `Conversation.users[]` 已提供，改為「錦上添花」 |
| A-2/A-4/A-5/A-6 webhook 細節 | 🔴 | 規格未定，型別無從得知 |
| A-3 webhook 簽章 | 🔴 | **資安必要條件** |
| B-1 訊息推播 | 🔴 | 確認確實無公開推播機制 |
| B-2 增量拉取 | 🔴 | **`messages.list()` 連 `conversation_id` 都沒有 —— 最急** |
| C-1 Knowledge 查詢 API | ✅ | 確認不存在，我方改自建 |
| C-2 RAG 檢索端點 | 🟡 | 僅需確認 `processEmbedding` 後有無查詢法 |
| D-1~D-4 Data Boards | 🟡 | 可自行實測，僅 D-2 唯一鍵需確認 |
| E-1 messageSuggestion | ✅ | 型別已明確，我方改自建 |
| E-2 模型與 structured output | 🟡 | 僅需確認額外欄位能否 passthrough |
| E-3 AI 資料處理政策 | 🔴 | **合規必要條件** |
| F-1 token 權限範圍 | 🔴 | 型別看不出來 |
| F-2 token 續期 | ✅ | 有 `refresh_token` |
| F-3 多處登入 | 🔴 | 型別看不出來 |
| G-1 測試環境 | ✅ | 有 `sandbox` |
| G-2 rate limit | 🔴 | **輪詢策略的前提** |
| H-1 單一對話暫停 AI | 🔴 | **產品可用性前提** |
| H-2 語音／圖片文字化 | 🔴 | **最高優先，決定工作量級距** |
| H-3 發送者身分 | 🔴 | **最高優先，決定撞單防護能否成立** |
| H-4 removeTeamMember 效力 | 🔴 | API 存在，但效力型別看不出 |
| H-5 角色與團隊 | ✅ | `OrganizationMembership.role/is_admin` |

---

## 背景說明（可直接轉貼給對方）

我們正在開發 **AgentCopilot** —— 一個擴充 iMBrace Conversations 模組的真人客服輔助工具。

當客服按下 JOIN 介入對話時，AgentCopilot 會即時擷取完整對話紀錄，提供對話摘要、客戶情緒分析、SOP 建議回覆與知識庫快查，讓客服能在數秒內掌握現況並一鍵帶入回覆。

系統以獨立 Web Console 形式運作，透過 `@imbrace/sdk` 串接平台。以下是我們在開發規劃階段整理出的規格疑問。

---

## A. JOIN / LEAVE Event Trigger（第一優先）

我們理解貴團隊近期將開放 Conversation 模組的 JOIN / LEAVE 事件訂閱。以下是我們需要確認的細節：

### A-1. Payload 是否包含該對話的**完整 operator 清單**？

> ✅ **2026-08-25：已自行解答，本題降級為「錦上添花」。**
>
> 我們發現 `Conversation.users: SimpleUser[]`（`{id, display_name, avatar_url}`）
> 已提供該對話當前的完整 operator 清單，透過 `conversations.getByConversationId()`
> 即可取得。因此即使 webhook 只帶觸發者，我們仍可在收到事件後補拉一次來補齊。
>
> **僅剩的請求**：若 payload 能直接附帶清單，可省去一次往返、降低延遲與 API 壓力。
> 有的話很好，沒有也不阻塞我們。

<details><summary>原始問題（保留供參）</summary>

**情境**：平台目前不限制單一客服介入，可能同時有多位客服 JOIN 同一對話。AgentCopilot 需要顯示「目前有誰在這個對話中」，以避免多位客服同時回覆造成客戶收到重複訊息。

**需求**：事件 payload 除了觸發者之外，希望能包含**該對話當前所有 operator 的清單**。

</details>

### A-2. Payload 完整欄位規格為何？

我們預期會需要（請確認實際提供哪些）：

| 欄位 | 用途 |
|---|---|
| `event_id` | 冪等去重 |
| `event_type` | `join` / `leave` |
| `occurred_at` | 時間戳，防重放 |
| `conversation_id` | 對應對話 |
| `operator` | id、name、email |
| `channel` | 類型與 id |
| `contact` | id |
| `current_operators[]` | 見 A-1 |

### A-3. 簽章驗證機制為何？

**這是資安必要條件。** 未經驗簽的 webhook endpoint 等同開放任何人偽造 JOIN 事件。

需要確認：
- 是否提供簽章？演算法為何（HMAC-SHA256？）
- 簽章放在哪個 HTTP header？
- 簽的內容是什麼（raw body？body + timestamp？）
- signing secret 如何取得與輪替？

**若目前無簽章機制**，請告知是否有規劃；在此之前我們的 endpoint 無法安全地對外開放。

### A-4. 重送策略為何？

- 我方回應非 2xx 時會重送嗎？重送幾次？間隔多久？
- 重送時 `event_id` 是否維持不變？（我們需要據此做冪等處理）
- 是否保證順序？（我們預期**不保證**，並會據此設計對帳機制）

### A-5. 是否提供來源 IP 範圍？

若有固定 IP 範圍，我們會加上白名單作為額外防護。

### A-6. 訂閱設定方式？

透過 Workflow 的 Webhook piece（`channel.updateChannelWorkflow()`）設定，或另有專屬的訂閱管理介面？

---

## B. 訊息層級的即時推播（重要）

### B-1. 是否有訊息層級的 WebSocket 或 SSE？

**情境**：AgentCopilot 需要在對話進行中即時取得新訊息，以便更新分析並防止撞單。

我們注意到 iMBrace 官方 Conversations 介面本身具備即時更新能力，推測平台端已有推播機制，但 SDK 文件（`/sdk/`、`/reference/`）中未見相關 API。

**目前的替代方案**：我們以輪詢 `messages` API 實作（前景對話約 1.5 秒一次，背景對話降頻，並以 conversation 為單位共享訂閱以避免重複請求）。

**需要確認**：
- 是否有可供外部使用的訊息推播機制（WebSocket / SSE / long-polling）？
- 若有，是否有文件或範例？
- 若無，我們的輪詢頻率是否在可接受範圍內？**是否有 rate limit 需要注意？**

### B-2. `messages` API 的查詢參數 🔴 **最急，可能阻塞我們的開發**

> ⚠️ **2026-08-25：問題比原先以為的更根本。**

我們查閱 SDK 後發現 `messages.list()` 的簽章是：

```ts
list(params?: { type?: string; q?: string; limit?: number; skip?: number })
//  → GET /v1/conversation_messages
```

**既沒有 `conversation_id`，也沒有 `since`。** 但我們整套設計都建立在
「取某一對話中、某則訊息之後的新訊息」之上。

請確認：

| # | 問題 |
|---|---|
| B-2a | **如何取得「單一對話」的訊息？** `q` 參數可以帶 conversation id 嗎？或後端其實支援未在 SDK 公開的 `?conversation_id=`？ |
| B-2b | 是否支援 `since` / `after` / `since_id` 之類的增量參數？（我們試過幾種命名） |
| B-2c | 若兩者皆無，貴方建議的做法為何？我們目前只能「全量取回後本地過濾」，在 1.5 秒輪詢下對雙方都是不必要的負擔 |

> **為何最急**：這一題若無解，我們的輪詢策略（§9）無法成立，會直接卡住主線開發。
> 這也是目前唯一「我們無法靠自己繞過」的問題。

---

## C. Knowledge / DocIQ 查詢 API（重要）

### C-1. Knowledge 與 DocIQ 模組是否有 SDK 查詢介面？

> ✅ **2026-08-25：已自行確認「不存在」，本題不需回覆。**
>
> 我們對 `@imbrace/sdk@1.4.0` 全部 `.d.ts` 搜尋 `knowledge|semantic|retriev`，
> 只找到建立與列檔（`processEmbedding`、`listEmbeddingFiles`、`boards.searchFolders`），
> 沒有任何 query / retrieve / semanticSearch 端點。
>
> **我們的因應**：改用已公開的 `ai.embed()` 自建向量檢索。SOP 數量級小（數百條），
> 離線建索引 + 記憶體 cosine 即可，且分數自控，反而更適合我們對信心度校準的需求。
>
> 若貴方日後開放語意檢索 API，我們的 `KnowledgeProvider` 抽象可直接替換，屆時再告知即可。

### C-2. `processEmbedding()` 之後的檢索方式 🟡 **僅需簡答**

我們仍想確認一件事，以免重造輪子：

- `aiAgent.processEmbedding({ fileId })` 建立的 embedding，**有沒有任何方式可以查詢**？
  （例如未在 SDK 公開的 REST 端點，或只能透過掛給 AI Agent 間接使用？）

若答案是「只能掛給 AI Agent 使用、無法直接檢索」，我們就確定走自建路線，不需進一步討論。

**補充確認**（若方便）：`boards.search(boardId, {q, filter, limit})` 看起來是 Meilisearch 相容介面 ——
是否支援 `showRankingScore` 之類的參數以取回相關度分數？SDK 型別中未見此參數。

---

## D. Data Boards 作為儲存層

我們計劃使用 Data Boards 儲存 AgentCopilot 產生的結案摘要與分析資料。

### D-1. 欄位型別支援哪些？

我們需要：`text`、`long text`、`number`、`datetime`、`select`（受控詞彙）、`multi-select` 或 `text[]`（陣列）。

請確認 `createField()` 實際支援的型別清單。

### D-2. 是否支援唯一鍵約束？

我們需要以 `conversation_id` 為唯一鍵做**冪等寫入**（同一對話重複產生摘要時應覆蓋而非新增）。

- 平台是否支援欄位的 unique 約束？
- 若不支援，是否建議「先 `search()` 再決定 `createItem` / `updateItem`」？此做法在並發下是否有競態風險？

### D-3. 寫入頻率限制？

我們預估寫入頻率不高（每個對話結案時一筆），但想確認是否有 rate limit 或單一 board 的記錄數上限。

### D-4. `linkItems()` 的使用方式？

我們希望將結案摘要關聯到對應的 Contact 記錄，請提供範例。

---

## E. AI 相關

### E-1. `client.messageSuggestion` 的行為與參數？

> ✅ **2026-08-25：型別已明確，本題不需回覆。**
>
> ```ts
> MessageSuggestionResponse = { suggestions: string[] }
> ```
>
> 回傳僅為字串陣列，**無信心度、無來源引用、無數量或語氣參數**。
> 我們原本規劃「建議回覆先用 `messageSuggestion`」，現已修正為改走自訂 prompt +
> 自建檢索，`messageSuggestion` 僅作為降級 fallback。
>
> 若我們理解有誤（例如實際回傳含型別未宣告的額外欄位），再請告知。

### E-2. `client.ai.complete()` 的模型與限制 🟡 **部分已釐清**

我們從型別看到：

```ts
CompletionInput = { model, messages, temperature, maxTokens, metadata, stream }
//  沒有 response_format / tools / tool_choice
```

但 `GET /v3/ai/workflow-agent/models` 回傳的模型帶有 `is_toolCall_available`
與 `is_vision_available` 旗標，代表底層模型是支援的。因此僅需確認：

| # | 問題 |
|---|---|
| E-2a | **`complete()` 傳入 SDK 型別未宣告的 `response_format` 或 `tools` 欄位，後端會 passthrough 嗎？** 若會，我們就能取得穩定的結構化輸出 |
| E-2b | 若不支援，貴方是否有其他取得 JSON 結構化輸出的建議做法？ |
| E-2c | token 上限、rate limit、計費方式？ |

> **為何重要**：我們需要模型回傳固定 schema 的 JSON（摘要、情緒分數、建議卡）並以 Zod 驗證。
> 若只能解析自由文字，我們需額外實作重試與降級機制。

### E-3. 對話內容送往 AI 的資料處理政策？

對話含客戶個資。使用 `ai.complete()` 或 `messageSuggestion` 時：
- 資料是否離開貴方環境？
- 是否有資料留存？留存多久？
- 是否有相關的資料處理協議可供參考？

---

## F. 權限與認證

### F-1. Access Token 的權限範圍？

以 OTP 登入取得的 `acc_...` token，其可執行的操作是否受該使用者在平台上的角色權限限制？

例如：一般客服 vs 主管，能看到的對話範圍是否不同？

### F-2. Token 續期機制？

> ✅ **2026-08-25：已自行解答，本題不需回覆。**
>
> `auth.exchangeAccessToken(orgId)` 回傳 `{ token, refresh_token }` —— 有 refresh token。
> 僅剩一個小問題（方便再答）：**refresh_token 的 TTL 與輪替規則為何？**

### F-3. 同一使用者多處登入？

同一客服若同時在 iMBrace 官方介面與 AgentCopilot 登入，是否有 session 數量限制或互斥行為？

---

## G. 環境與測試

### G-1. 測試環境？

> ✅ **2026-08-25：已自行解答。**
>
> SDK 的 `Environment = 'develop' | 'sandbox' | 'stable' | 'prodv2'` —— 有 sandbox。
>
> **僅剩**：可否協助提供 sandbox 的測試帳號，以及**一個內容豐富的測試對話**
> （最好同時包含客戶訊息、AI 自動回覆、真人客服回覆、圖片附件、語音訊息）？
> 這對我們驗證 H-2 與 H-3 非常關鍵。

### G-2. Rate limit 的整體規格？

各類 API 的 rate limit 為何？超過時的回應形式（429 + `Retry-After`？）

---

## H. 多模態訊息與 AI 模式（第一優先）

### H-1. 是否有 API 可暫停／恢復「單一對話」的 AI 自動回覆？

**情境**：我們的產品設計是 —— 客服 JOIN 之後，AI 仍持續自動回覆（協作模式）；客服需要時可按下「切換為全真人模式」停止該對話的 AI 回覆。

**需要確認**：
- 是否有 API 可**針對單一對話**暫停／恢復 AI workflow 的自動回覆？
- 若有，方法名稱與參數為何？狀態如何查詢？
- 暫停是否會影響該 channel 上的其他對話？（我們需要的是**僅限該對話**）
- 暫停後若對話結束或客服離開，是否會自動恢復？

**若無此 API**，請問建議的替代做法為何？例如：
- 透過 `channel.updateChannelWorkflow()` 或 workflow 內的條件判斷達成？
- 或有其他對話層級的狀態可用來讓 workflow 自行跳過？

> **為何重要**：真人組織一則回覆需 20–40 秒，AI 只需 1–2 秒。協作模式下客戶極可能同時收到 AI 與真人的訊息，內容甚至相互矛盾。「切換為全真人模式」是我們處理此問題的主要手段。

### H-4. `removeTeamMember()` 的實際效力為何？

**情境**：我們規劃一個「主管強制介入」功能 —— 主管可接管對話，此時停止 AI 自動回覆，且其他客服不得再回覆，僅該主管可發言。

我們可以在自家系統內限制客服操作，但無法限制他們直接使用 iMBrace 官方介面。因此想確認是否能透過 API 達成真正的限制。

**需要確認**：
- 呼叫 `conversations.removeTeamMember()` 將某客服移出對話後，該客服**是否仍能在官方介面回覆該對話**？
- 被移除的客服**是否可自行重新 JOIN**？是否有辦法禁止？
- 是否有對話層級的鎖定或獨佔機制（例如指定唯一負責人）？

> **為何重要**：主管強制介入若擋不住官方介面，就只是勸告而非真正的接管。我們需要知道實際的強制力邊界，才能在介面上誠實標示，避免主管誤以為已完全接管。

### H-5. Access token 能否取得使用者的角色與團隊資訊？

> ✅ **2026-08-25：多半已自行解答。**
>
> `auth.authenticate()` 回傳的 `OrganizationMembership` 帶有：
> ```ts
> { organization_id, display_name, role?: string, is_admin?: boolean, status?, … }
> ```
>
> **僅剩兩個小問題**：
> 1. `role` 的**值域**為何？（有哪些角色字串？哪一個對應「主管」？）
> 2. `is_admin` 指的是組織管理員，還是客服團隊的主管？兩者在我們的情境下意義不同 ——
>    我們要的是「能強制介入他人對話的人」，不一定等於組織管理員。
>
> 若 `role` 的粒度不足以區分客服主管，我們會退回設定檔白名單，也請一併告知。

### H-2. 訊息中的語音與圖片，平台端是否已做文字化處理？

**情境**：對話中包含客戶傳送的圖片（如設備照片）與語音訊息。我們的 AI 分析管線需要將這些內容納入摘要、情緒判斷與建議生成。

**我們從 SDK 型別看到的（2026-08-25）**：

```ts
MessageType = 'text' | 'image' | 'quick_reply' | 'file' | 'pdf'   // ← 沒有 audio
MessageContent = { text?, url?, caption?, title?, payload? }       // ← 沒有 transcript
```

型別上看起來**未做文字化**，但我們不確定後端是否回傳型別未宣告的欄位。

**需要確認**：

| # | 項目 | 問題 |
|---|---|---|
| H-2a | **語音訊息** | 語音訊息以哪個 `MessageType` 回傳？（型別中無 `audio`，是歸在 `file` 嗎？）平台是否已做 STT？轉錄結果的欄位名稱為何？ |
| H-2b | **圖片附件** | 平台是否已產生圖片描述或 OCR？是否隨 message 回傳？欄位名稱？ |
| H-2c | **`caption` 的語意** | `MessageContent.caption` 是**使用者附上的說明文字**，還是**AI 產生的描述**？我們目前假設是前者，若假設錯誤請指正 |
| H-2d | **附件 URL** | `content.url` 是否有時效？下載是否需額外授權標頭？ |
| H-2e | **檔案型別** | 支援哪些附件型別？大小限制？ |

> **為何重要**：若平台端已完成文字化，我們可直接取用；若未提供，我們需自行接入 STT 與視覺模型，
> **這會顯著改變我們 AI 管線的複雜度與開發時程**（我方估算差距約 5–10 個工作天）。
> 這是我們目前不確定性最高、影響範圍最大的一項。

### H-3. 訊息的發送者身分如何區分？

**情境**：我們需要區分每則訊息是由「客戶」、「AI workflow」、還是「真人客服」發出。

**我們從 SDK 型別看到的（2026-08-25）**：

```ts
ConversationMessage = { …, from: string, … }   // ← 單一字串，沒有 sender type 判別欄位
```

我們目前的做法是**反推**：`from === contact_id` 判為客戶、`from ∈ conversation.users[]`
判為真人客服、**其餘一律推定為 AI**。

**需要確認**：

| # | 問題 |
|---|---|
| H-3a | **`from` 的值域為何？** 分別會出現哪些形式的值（contact id / user id / 固定字串 / workflow id）？ |
| H-3b | **AI workflow 發出的訊息，`from` 是什麼？** 有沒有固定值或前綴可辨識？ |
| H-3c | **「已離開對話的客服」發的歷史訊息，`from` 還會出現在 `conversation.users[]` 中嗎？** |

> **H-3c 為何關鍵**：若客服 LEAVE 後就從 `users[]` 移除，我們的反推法會把
> **他過去發的訊息誤判為 AI**。撞單防護一旦誤判，客服會收到假警報；
> 而假警報比沒有警報更糟 —— 客服學會忽略提示後，真正的撞單也會被一併略過。
>
> **為何重要**：這項防護是我們整套設計中唯一真正能防止客戶收到重複回覆的一層。
> 若無法精確區分 AI 與真人，此功能形同虛設。

---

## 優先序摘要（2026-08-25 修訂）

若需分批回覆，**只要先回這五題就能解除我們大部分的阻塞**：

| 優先 | 項目 | 阻塞什麼 | 我們能否自行繞過 |
|---|---|---|---|
| 🔴 P0 | **B-2** `messages` 如何依對話取數 | **輪詢策略（§9）的地基，會卡住主線開發** | ❌ **不能** |
| 🔴 P0 | **H-2** 語音／圖片是否已文字化 | AI 管線的形狀與 M2 工作量級距（±5–10 工作天） | 🟡 可自建，但成本高 |
| 🔴 P0 | **H-3** `from` 的值域與 AI 訊息辨識 | 撞單防護能否正確運作 —— 產品核心價值 | 🟡 反推法有誤判風險 |
| 🔴 P0 | **H-1** 單一對話的 AI 暫停 API | 「切換為全真人模式」能否實作 | ❌ **不能** |
| 🔴 P0 | **A-3** webhook 簽章機制 | 上線前的資安必要條件 | ❌ **不能** |

其餘：

| 優先 | 項目 | 備註 |
|---|---|---|
| 🟠 P1 | **E-3** AI 資料處理政策 | 合規必要條件，需在開工前確認 |
| 🟠 P1 | **G-2** rate limit 規格 | 輪詢頻率設計的前提 |
| 🟠 P1 | **H-4** `removeTeamMember()` 的實際效力 | 主管強制介入的強制力邊界 |
| 🟠 P1 | **A-2 / A-4 / A-5 / A-6** webhook 細節 | 規格到位時一併提供即可 |
| 🟠 P1 | **F-1 / F-3** token 權限範圍與多處登入 | |
| 🟡 P2 | **E-2a** 額外欄位能否 passthrough | 我們會先自行實測 |
| 🟡 P2 | **C-2 / D 各項 / G-1 測試帳號** | 簡答或協助提供即可 |
| ✅ — | **A-1、C-1、E-1、F-2、G-1(環境)、H-5** | **已自行解答，不需回覆** |

---

## 回覆後的動作

收到回覆後請更新：
- `docs/ARCHITECTURE.md` §19 已知風險與待確認事項（狀態欄）
- `docs/SDK_FINDINGS.md` 第三節「必須 live 驗證」的對應項
- 對應的 provider 實作狀態（`server/sources/`）
- 本文件標記已解決項目

> **註**：本文件中標為 ✅ 的項目，是我們透過解讀 `@imbrace/sdk@1.4.0` 的
> TypeScript 型別定義自行得出的。若與貴方的實際行為有出入，**請務必指正** ——
> 型別能說明 API 表面，但不能說明資料實際的填充情況。
