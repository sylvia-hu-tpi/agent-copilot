# 待向 iMBrace 團隊確認的事項

> 用途：一次性向 iMBrace 團隊確認 AgentCopilot 所需的規格
>
> 建議做法：**一次問完**。分批詢問會拉長等待週期，且部分問題彼此相關（例如 webhook 的 operator 清單同時影響 presence 設計與撞單防護）。
>
> 更新日期：2026-08-25

---

## ⚠️ 2026-08-25 更新：我們已完成大量實測，本清單大幅收斂

我們對 stable 環境（`app-gatewayv2.imbrace.co`）做了完整的**唯讀**實測
（21 項能力逐一呼叫，並以 API Key 與客服 access token 各測一遍），
自行解答了原清單中的多數問題。

**對話相關的能力全部可用，我們可以立即開始開發。**
真正需要貴方協助的只剩下 **AI 與知識檢索**這一塊 —— 見下方 §0。

| 標記 | 意義 | 需要貴方回覆？ |
|---|---|---|
| ✅ **已自行解答** | 已實測確認 | 否（如與實際不符請指正） |
| 🟡 **已縮小範圍** | 僅剩細節 | 簡答即可 |
| 🔴 **仍需回覆** | 我們無法自行解決，且影響架構決策 | **是** |

### 快速索引

| 題號 | 狀態 | 一句話 |
|---|---|---|
| **0-1 AI provider 目前不可用** | 🔴 | **最優先** —— 27 個 agent 全部無法執行推論 |
| **0-2 `ai.complete` / `ai.embed` 回 404** | 🔴 | **最優先** —— 是未部署、未開放、還是已汰換？ |
| **0-3 建議回覆能做到什麼程度** | 🔴 | **最優先** —— 決定我們能不能只用 iMBrace |
| 0-4 能否以 API 建立自己的 AI Agent | 🟠 | 影響我們的整合方式 |
| A-1 完整 operator 清單 | ✅ | `Conversation.users[]` 已提供，改為「錦上添花」 |
| A-2/A-4/A-5/A-6 webhook 細節 | 🔴 | 規格未定 |
| A-3 webhook 簽章 | 🔴 | 資安必要條件 |
| B-1 訊息推播 | 🟠 | 確認確實無公開推播機制 |
| B-2a 依對話取訊息 | ✅ | `?conversation_id=` 為必填，僅 SDK 未公開 |
| B-2b 增量拉取 | 🔴 | `since`/`after`/`since_id` 皆被忽略 |
| C-1 Knowledge 查詢 API | ✅ | 確認 SDK 無此端點（但見 0-3） |
| D-1~D-4 Data Boards | 🟡 | 可自行實測，僅 D-2 唯一鍵需確認 |
| E-1 messageSuggestion | ✅ | 端點 404，不存在（見 0-2） |
| E-3 AI 資料處理政策 | 🔴 | 合規必要條件 |
| F-1 token 權限範圍 | 🟡 | 已知 API Key 為組織層級廣泛讀取 |
| F-2 token 續期 | ✅ | 有 `refresh_token` |
| F-3 多處登入 | 🟠 | |
| G-1 測試環境 | 🟠 | 有 sandbox，但我們的 key 僅能用於 stable |
| G-2 rate limit | 🔴 | 輪詢策略的前提 |
| H-1 單一對話暫停 AI | 🔴 | 產品可用性前提 |
| H-2 語音／圖片文字化 | 🔴 | 決定工作量級距 |
| H-3 發送者身分 | ✅ | `from` 前綴 `con_`/`u_`/`pub_`，僅需確認 `pub_` |
| H-4 removeTeamMember 效力 | 🟠 | |
| H-5 角色與團隊 | 🟡 | `role` 存在，僅需確認值域 |

---

## 0. AI 能力現況 🔴 最優先

> **這一節決定我們的架構方向，是目前唯一的阻塞點。**
>
> 我們的產品需要四項 AI 功能：**對話摘要**、**客戶情緒評分**、**建議回覆**、**知識庫查詢**。
> 目前這四項在我們的環境中都無法運作，但我們**無法判斷是設定問題還是能力缺失** ——
> 這正是需要貴方協助的地方。

### 0-1. 我們組織的 AI provider 有 16/27 無法執行推論

> ⚠️ **2026-08-25 下午更正**：本節原寫「全部失敗」，是抽測後外推的錯誤結論。
> 逐一實測 27 個後：**11 個可用**（含 4 個能做知識庫檢索）、16 個失敗。
> 0-3 的多數子題我們也已自行驗證出答案 —— 完整結果見
> [MEETING_2026-08-25.md](MEETING_2026-08-25.md)。

我們對組織內 **27 個 AI Agent 逐一實測**，其中 16 個失敗，錯誤形態有三種：

| 錯誤 | 範例 agent | 我們的推測 |
|---|---|---|
| `Cannot convert argument to a ByteString because the character at index 31 has a value of 8226` | NanShan Coordinator、國泰醫院小護士 | 8226 是 `•`。`ai.listProviders()` 讀回來的 AWS 金鑰是 `AKI••••••LEF`（遮罩過），懷疑平台把**遮罩後的字串**當成真實金鑰送往 Bedrock |
| `The model 'X' does not exist or you do not have access to it` | Miru Test（`anthropic.claude-sonnet-5`）、企業助理（`openai.gpt-oss-120b-1:0`） | 請求已到達 Bedrock，但該模型未在對應的 AWS 帳號／區域開通 |
| `Assistant is missing model_id/provider_id configuration` | Sales and Commercial Agent 等 | agent 設定不完整 |

兩個 provider（`TPI_AWSBedrock`、`bedrock-partners`）皆是如此。

**請問**：
- 這是我們組織的設定問題嗎？可以協助修復嗎？
- 第一種錯誤看起來像平台端的 bug（遮罩值被當真值使用），是否需要我們提供更多資訊？
- 修復後，是否有一個**確定可用的模型**可以推薦給我們？

> 補充：`aiAgent.streamChat` 的**機制本身是正常的** —— 回傳 HTTP 200、`text/event-stream`、
> 標準的 `start` / `text-delta` / `finish` 事件。純粹是 agent 背後的模型呼叫失敗。

### 0-2. `ai.complete` 與 `ai.embed` 回傳 404

| 端點 | API Key | 客服 access token |
|---|---|---|
| `POST /v3/ai/completions` | 404 | 404 |
| `POST /v2/ai/completions` | 404 | 404 |
| `POST /v3/ai/embeddings` | 404 | 404 |
| `POST /v1/message-suggestion` | 404 `Cannot POST` | 404 |

這些是 `@imbrace/sdk@1.4.0` 中 `client.ai.complete()`、`client.ai.embed()`、
`client.messageSuggestion.getSuggestions()` 實際打的路徑。兩種憑證結果相同，故應非權限問題。

**請問**：
- 這些端點是**尚未部署**、**未對外開放**、還是**已被 AI Agent 機制取代**？
- 若已汰換，SDK 是否會同步更新？我們是否應一律改走 `aiAgent.streamChat`？
- 若仍在規劃中，有無時程？

### 0-3. 建議回覆功能，我們能做到什麼程度？ ⭐ 最關鍵

我們的介面設計中，客服會看到 2–3 張「建議回覆卡」，每張包含：

```
┌────────────────────────────────────────────┐
│ SOP 3.2 安撫圓場              信心度 92%    │  ← A: 引用來源  B: 信心度
│ 「陳先生您好，造成您的不便真的很抱歉，我     │  ← C: 可直接送出的回覆全文
│  立刻協助您查詢設備狀態，請稍等 30 秒。」   │
│                              [一鍵帶入]     │
└────────────────────────────────────────────┘
```

**C（回覆全文）是必要的；A 與 B 我們可以彈性調整。**

我們注意到組織內已有掛載知識庫的 agent（例如 `TBC_T2_RAG問答_Agent`，`board_ids` 有 1 筆），
且平台已有 **311 個 RAG 檔案**與 **20 個 Knowledge Hub 資料夾**。

**請問，在 agent 掛載知識庫的前提下**：

| # | 問題 | 狀態 |
|---|---|---|
| 0-3a | agent 的回答中，能否得知它**引用了哪些來源**？ | ✅ **已自行驗證：可以**。SSE `tool-output-available` 事件帶 `RAGknowledge` 輸出，含檔名與 chunk 原文 |
| 0-3b | 是結構化欄位還是文字？ | ✅ **已自行驗證：文字**。`result` 是 markdown 字串，需自行 parse `[Source: …]`；檔名為 double URL-encoded |
| 0-3c | 有無**相關度分數**？ | 🔴 **仍需回覆**：實測無 score 欄位。有沒有辦法取得？ |
| 0-3d | 能否回傳**固定格式 JSON**？ | ✅ **已自行驗證：可以**（4/4 次可 `JSON.parse`，靠 prompt；`response_format` 欄位為 null，其值域仍待確認） |
| 0-3e | 同一 agent 能否針對不同任務給不同 system prompt？ | 🟠 仍需回覆 |
| **0-3f** | **RAG 檢索品質可否調校？** | 🔴 **最優先**：問「電梯困人」未命中 `金融大樓電梯困人SOP.pdf`，反而回傳「管理辦法」的火災段落。chunk 大小／top-k／中文斷詞／同義詞可否調整？ |

> **為何這題最關鍵**：如果答案是「可以取得引用來源、也能穩定回傳 JSON」，
> 我們就能**完全只用 iMBrace** 實現全部功能，這是我們最希望的結果 —— 部署與維運成本最低。
> 若只能取得自由文字，我們仍可接受降級（拿掉信心度數字），但需要知道邊界在哪裡。

### 0-4. 能否以 API 建立與設定 AI Agent？

我們預期需要為「摘要」「情緒評分」「建議回覆」各建立一個專用 agent。

**請問**：
- 可以用 API 建立 agent、設定 instructions、掛載 Knowledge Hub 嗎？
  （我們看到 `ai.createAiAgentApp()` 與 `chatAi.createAiAgent()`，但尚未實測）
- 或者建議在後台手動建立，我們只以 `assistant_id` 呼叫？
- agent 的 instructions 若由我們的程式管理（納入版控），有無建議做法？

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

### B-2. `messages` API 的查詢參數

> ✅ **B-2a 已自行解答**：後端**強制要求** `?conversation_id=`
> （不帶會回 `400 {"code":400,"message":"conversation_id required"}`），
> 只是 SDK 的 `messages.list()` 簽章未公開此參數。
> **建議 SDK 補上**，否則每位使用者都得自行繞過型別。

**B-2b 仍需確認 🔴：是否支援增量拉取？**

我們試過 `?since=`、`?after=`、`?since_id=`、`?from_created_at=`，
帶入後回傳筆數與全量相同，判斷為**參數被忽略**。

| # | 問題 |
|---|---|
| B-2b | 是否有任何方式只取「某則訊息之後」的新訊息？正確的參數名稱為何？ |
| B-2c | 若確實不支援，在 1.5 秒輪詢的情境下，貴方建議的做法為何？（我們目前只能每次全量取回再本地比對 `lastMessageId`，對雙方都是不必要的負擔） |

> **情境**：客服介入對話期間，我們需要即時偵測「其他同事或 AI 是否已先回覆客戶」，
> 以避免客戶收到重複訊息。這需要高頻取得新訊息。

---

## C. Knowledge / DocIQ 查詢 API（重要）

### C-1. Knowledge 與 DocIQ 模組是否有 SDK 查詢介面？

> ✅ **2026-08-25：已自行確認 SDK 無此端點。本題併入 §0-3 討論。**
>
> 我們對 `@imbrace/sdk@1.4.0` 全部 `.d.ts` 搜尋 `knowledge|semantic|retriev`，
> 只找到建立與列檔（`processEmbedding`、`listRagFiles`、`boards.searchFolders`），
> 沒有任何 query / retrieve / semanticSearch 端點。
>
> ⚠️ **我們原本規劃改用 `ai.embed()` 自建向量檢索，但該端點回 404（見 §0-2），
> 這條路也不通。** 因此知識庫查詢目前只剩「透過掛載知識庫的 AI Agent」一途，
> 相關問題已整理於 §0-3。

### C-2. `processEmbedding()` 之後的檢索方式 🟡 **僅需簡答**

- `aiAgent.processEmbedding({ fileId })` 建立的 embedding，**有沒有任何方式可以查詢**？
  （未在 SDK 公開的 REST 端點亦可）
- 若只能透過掛給 AI Agent 間接使用，請直接告知，我們就依 §0-3 的方向設計。

**補充確認**（若方便）：`boards.search(boardId, {q, filter, limit})` 看起來是 Meilisearch 相容介面 ——
是否支援 `showRankingScore` 之類的參數以取回相關度分數？SDK 型別中未見此參數。
（此為我們取得「引用來源 + 分數」的備案之一）

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

### E-2. `client.ai.complete()` 的模型與限制

> ⚠️ **2026-08-25：本題已被 §0-2 取代 —— `ai.complete()` 實際回傳 404。**
>
> 結構化輸出的需求已移至 **§0-3d**（能否要求 AI Agent 回傳固定格式 JSON）。
>
> 僅剩一題仍適用：**token 上限、rate limit、計費方式為何？**（併入 G-2 一起回覆即可）

> 補充觀察：`GET /v3/ai/workflow-agent/models` 目前回傳空陣列（`data: []`），
> 但 `GET /v3/ai/providers` 回傳的兩個 provider 底下各列有 30+ 個模型，
> 且皆標記 `is_toolCall_available: true`。兩者不一致，不確定何者為準。

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

> ✅ **2026-08-25：已自行解答，僅剩一題需確認。**
>
> 實測發現 `from` 帶**型別前綴**，70 則訊息的判別覆蓋率 100%：
>
> | 前綴 | 判定 | 實測筆數 |
> |---|---|---|
> | `con_…` | 客戶（contact） | 28 |
> | `u_…` | 真人客服（user） | 3 |
> | `pub_…` | **推測為 AI workflow** | 39 |
>
> 我們已改用前綴判別，不再依賴比對 `conversation.users[]`。
>
> ⚠️ 補充一個重要觀察：該對話的 `users[]` 是**空陣列**，但訊息中確實有 3 則 `u_` 客服發言。
> 若我們沿用原本的反推法，會把這些同事全部誤判為 AI。這印證了前綴判別的必要性。

**H-3b 仍需確認 🟠**：

- **`pub_` 前綴是否即代表 AI workflow 發出的訊息？** 還是另有其他語意
  （例如「透過 API 發送」「系統訊息」「官方帳號推播」）？
- 除了上述三種，`from` 還可能出現哪些前綴？

> **為何仍需確認**：我們的撞單防護必須精確區分「同事回覆」與「AI 自動回覆」。
> 若 `pub_` 實際上混雜了其他來源，會產生誤判警示 ——
> 而假警報比沒有警報更糟：客服學會忽略提示後，真正的撞單也會被一併略過。

---

## 優先序摘要（2026-08-25 修訂）

**若時間有限，請優先回覆 §0 的四題。** 那一節決定我們的架構方向，
其餘問題都可以在開發過程中逐步釐清。

| 優先 | 項目 | 阻塞什麼 | 我們能否自行繞過 |
|---|---|---|---|
| 🔴 P0 | **0-1** AI provider 目前不可用 | **四項 AI 功能全部無法運作** | ❌ 需貴方修復 |
| 🔴 P0 | **0-3** 建議回覆能做到什麼程度 | **決定我們能否只用 iMBrace 完成專案** | ❌ **不能** |
| 🔴 P0 | **0-2** `ai.complete`／`ai.embed` 404 | 摘要與情緒評分的實作方式 | ❌ **不能** |
| 🔴 P0 | **H-1** 單一對話的 AI 暫停 API | 「切換為全真人模式」能否實作 | ❌ **不能** |
| 🔴 P0 | **A-3** webhook 簽章機制 | 上線前的資安必要條件 | ❌ **不能** |
| 🔴 P1 | **H-2** 語音／圖片是否已文字化 | M2 工作量級距（±5–10 工作天） | 🟡 可自建，成本高 |
| 🔴 P1 | **B-2b** 增量拉取 | 輪詢的 API 壓力 | 🟡 可用全量比對，但浪費頻寬 |
| 🔴 P1 | **G-2** rate limit 規格 | 輪詢頻率設計的前提 | ❌ **不能** |
| 🔴 P1 | **E-3** AI 資料處理政策 | 合規必要條件 | ❌ **不能** |
| 🟠 P2 | **0-4** 能否以 API 建立 agent | 整合方式 | 🟡 可改為後台手動建立 |
| 🟠 P2 | **A-2 / A-4 / A-5 / A-6** webhook 細節 | 規格到位時一併提供即可 | |
| 🟠 P2 | **H-4** `removeTeamMember()` 效力 | 主管強制介入的強制力邊界 | |
| 🟠 P2 | **H-5** `role` 值域 | `role=admin` 但 `is_admin=false`，何者對應客服主管？ | |
| 🟠 P2 | **H-3b** `pub_` 前綴是否為 AI | 撞單防護的正確性 | 🟡 已可用排除法 |
| 🟠 P2 | **B-1 / F-1 / F-3 / G-1** | | |
| 🟡 P3 | **D 各項** | 我們會先自行實測 | |
| ✅ — | **A-1、B-2a、C-1、E-1、F-2、H-3** | **已實測解答，不需回覆** | |

### 我們目前的狀態

**對話層的能力我們已全部驗證可用**（對話列表、訊息、presence、Data Board 讀寫、
聯絡人、頻道設定），因此**主線開發可以立即開始，不會空等**。

唯一的阻塞是 §0 的 AI 能力。我們希望盡可能只使用 iMBrace 完成整個專案 ——
若某些呈現細節（例如信心度數字）做不到，我們可以調整介面設計來配合，
**但需要先知道能力邊界在哪裡**，才能決定要不要引入額外的系統。

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
