# 待向 iMBrace 團隊確認的事項

> 用途：向 iMBrace 團隊確認 AgentCopilot 所需的規格
>
> 我們已對 stable 環境做過大量唯讀實測，自行解答了多數問題（詳見文末附錄）。
> 本文件**只列目前仍需要貴方回覆的項目**，依優先序排列。
>
> 更新日期：2026-08-26

---

## 標記說明

| 標記 | 意義 |
|---|---|
| 🔴 P0 | 我們無法自行解決，且直接影響架構方向或上線資安門檻 |
| 🟠 P1 | 重要，目前有暫行繞法但非長久之計 |
| 🟡 P2 | 次要細節，有繞法，方便時再答即可 |
| 🔵 P3 | 不阻塞任何功能，時間有限可略過 |

## 快速索引

| 優先 | 題號 | 一句話 |
|---|---|---|
| 🔴 | [0-2](#0-2-aicomplete-與-aiembed-回傳-404) | `ai.complete`／`ai.embed` 回 404，是未部署、未開放、還是已汰換？ |
| 🔴 | [0-3c/f](#0-3-建議回覆的兩個關鍵缺口) | RAG 檢索品質可否調校？有無相關度分數？（問「電梯困人」未命中對應 SOP） |
| 🔴 | [A-1](#a-1-joinleave-payload-的完整-operator-清單) | webhook payload 能否附帶對話當前完整 operator 清單？ |
| 🔴 | [A-3](#a-3-webhook-簽章機制) | webhook 簽章機制為何？上線前的資安必要條件 |
| 🟠 | [0-1](#0-1-16-27-個-ai-provider-無法推論) | 16/27 個 AI Agent 因遮罩金鑰 bug／模型未開通而失敗，可協助修復嗎？ |
| 🟠 | [E-3](#e-3-ai-資料處理政策) | 對話內容送往 AI 的資料處理政策（合規必要條件） |
| 🟠 | [G-2](#g-2-rate-limit-規格) | 各類 API 的 rate limit 規格 |
| 🟠 | [H-2d](#h-2d-附件-url-是否有時效) | 附件（圖片／PDF）的 `content.url` 是否有時效？ |
| 🟠 | [H-3c](#h-3c-workflow-內部訊息如何區分) | workflow 內部中繼訊息與真正回給客戶的回覆如何區分？（撞單假警報） |
| 🟡 | 其餘 | 見下方各節，多為細節確認或已有暫行方案 |

---

## 0. AI 能力

### 0-1. 16/27 個 AI Provider 無法推論

我們對組織內 27 個 AI Agent 逐一實測，16 個失敗，錯誤形態有三種：

| 錯誤 | 範例 agent | 我們的推測 |
|---|---|---|
| `Cannot convert argument to a ByteString … value 8226` | NanShan Coordinator、國泰醫院小護士 | 8226 是 `•`。`ai.listProviders()` 讀回的 AWS 金鑰是遮罩過的 `AKI••••••LEF`，懷疑平台把遮罩後的字串當成真實金鑰送往 Bedrock |
| `The model 'X' does not exist or you do not have access to it` | Miru Test、企業助理 | 請求已到達 Bedrock，但該模型未在對應帳號／區域開通 |
| `Assistant is missing model_id/provider_id configuration` | Sales and Commercial Agent 等 | agent 設定不完整 |

**請問**：這是我們組織的設定問題嗎？第一種看起來像平台端 bug，可以協助修復嗎？修復後有無確定可用的模型可推薦？

### 0-2. `ai.complete` 與 `ai.embed` 回傳 404

`POST /v3/ai/completions`、`/v2/ai/completions`、`/v3/ai/embeddings`、`/v1/message-suggestion` 四個端點，API Key 與 access token 皆回 404（已排除權限問題）。

**請問**：這些端點是尚未部署、未對外開放、還是已被 AI Agent 機制取代？若已汰換，我們是否應一律改走 `aiAgent.streamChat`？

### 0-3. 建議回覆的兩個關鍵缺口

我們的介面會顯示建議回覆卡（SOP 來源＋信心度＋可直接送出的回覆全文）。已自行驗證：agent 能透過 SSE 取得引用來源（檔名＋chunk 原文，見附錄）、能穩定回傳 JSON。**剩下兩個缺口**：

| # | 問題 |
|---|---|
| 0-3c 🔴 | 有無**相關度分數**？實測 RAG 工具輸出無 score 欄位 |
| 0-3f 🔴 **最優先** | **RAG 檢索品質可否調校？** 問「電梯困人的處理步驟」，未命中同名的 `金融大樓電梯困人SOP.pdf`，反而回傳「管理辦法」的火災段落。chunk 大小／top-k／中文斷詞／同義詞可否調整？ |
| 0-3e 🟡 | 同一 agent 能否針對不同任務給不同 system prompt？ |

> **為何 0-3f 最關鍵**：若檢索品質調不動，客服可能照著錯誤的 SOP 回覆客戶，比沒有建議更糟——這會觸發我們改接第三方 AI 層的備案。若只是拿不到分數，我們可接受降級（信心度留空、只顯示 SOP 來源）。

### 0-4. 能否以 API 建立與設定 AI Agent？🟡

我們預期需要為「摘要」「情緒評分」「建議回覆」各建立一個專用 agent。可以用 API 建立 agent、設定 instructions、掛載 Knowledge Hub 嗎（`ai.createAiAgentApp()`／`chatAi.createAiAgent()`，尚未實測）？或建議在後台手動建立，我們只以 `assistant_id` 呼叫？

---

## A. JOIN / LEAVE Webhook

### A-1. JOIN/LEAVE payload 的完整 operator 清單 🔴

`Conversation.users[]` 實測為**團隊名冊**，不是對話參與者——兩個不同對話回傳同一批 14 人，且 JOIN/LEAVE 全程數量不變。這是我們目前唯一無法自行取得的 presence 資訊：**事件 payload 能否附帶該對話當前所有 operator 的清單？**

暫行替代方案：讀取 `mode` 欄位（`manual`/`hybrid` 代表「有人能送出訊息」），但只能回答「有沒有人」，答不出「是誰」。

### A-2. Payload 完整欄位規格為何？🟠

預期需要 `event_id`（冪等）、`event_type`、`occurred_at`、`conversation_id`、`operator`（id/name/email）、`channel`、`contact`、`current_operators[]`（見 A-1）。請確認實際提供哪些。

### A-3. 簽章驗證機制為何？🔴

**資安必要條件**——未經驗簽的 webhook endpoint 等同開放任何人偽造 JOIN 事件。是否提供簽章（HMAC-SHA256？）、放在哪個 header、簽的內容是什麼、signing secret 如何取得與輪替？**若目前無簽章機制，我們的 endpoint 無法安全對外開放。**

### A-4. 重送策略為何？🟠

非 2xx 回應會重送嗎？次數／間隔？`event_id` 是否維持不變（冪等處理用）？是否保證順序（我們預期不保證）？

### A-5. 是否提供來源 IP 範圍？🟡

若有固定範圍，我們會加白名單作為額外防護。

### A-6. 訂閱設定方式？🟡

透過 Workflow 的 Webhook piece（`channel.updateChannelWorkflow()`）設定，或另有專屬管理介面？

---

## B. 訊息層級的即時推播

### B-1. 是否有訊息層級的 WebSocket 或 SSE？🟠

官方 Conversations 介面本身有即時更新，推測平台端有推播機制，但 SDK 文件未見相關 API。目前以輪詢 `messages` 實作（前景 3s、背景 30s，共享訂閱）。**是否有可供外部使用的訊息推播機制？若無，我們的輪詢頻率是否可接受？**

### B-2. 增量拉取的正式參數為何？🟡

`?since=`／`?after=`／`?since_id=`／`?from_created_at=` 等八種寫法皆被忽略。目前繞法：訊息由新到舊排序，`limit=N` 即最新 N 則，改用「清單輪詢偵測變動→只抓變動者」，穩態約 0.33 req/s，**已可接受**，但仍歡迎提供正式的增量參數。

---

## D. Data Boards 作為儲存層 🟡 P3（我們會先自行實測）

1. **欄位型別**：`createField()` 實際支援哪些型別（需要 text／long text／number／datetime／select／multi-select）？
2. **唯一鍵約束**：能否以 `conversation_id` 為唯一鍵做冪等寫入？若不支援，「先 `search()` 再決定 create/update」在並發下是否有競態風險？
3. **寫入頻率限制**：預估每對話結案時一筆，是否有 rate limit 或單一 board 記錄數上限？
4. **`linkItems()` 用法**：希望將結案摘要關聯到 Contact 記錄，請提供範例。

---

## E. AI 資料處理政策

### E-3. AI 資料處理政策 🟠

**合規必要條件**。對話含客戶個資，送往 AI Agent（Bedrock）時：資料是否離開貴方環境？是否有資料留存？留存多久？有無相關資料處理協議可供參考？

---

## F. 權限與認證

### F-1. Access Token 的權限範圍？🟡

以 OTP 登入取得的 `acc_...` token，其可執行的操作是否受使用者角色限制（例如一般客服 vs 主管，能看到的對話範圍是否不同）？

### F-3. 同一使用者多處登入？🟠

同一客服同時在 iMBrace 官方介面與 AgentCopilot 登入，是否有 session 數量限制或互斥行為？

---

## G. 環境與測試

### G-2. Rate limit 規格 🔴

各類 API 的 rate limit 為何？超過時的回應形式（429 + `Retry-After`？）——這是我們輪詢頻率設計的前提。

### 測試資源請求 🔵

可否協助提供 sandbox 測試帳號，以及一個內容豐富的測試對話（同時包含客戶訊息、AI 自動回覆、真人客服回覆、圖片附件）？這對我們驗證附件與發送者身分很有幫助。

---

## H. 多模態附件與撞單防護

### H-2d. 附件 URL 是否有時效？🟠

我們已用真實對話驗證：`image`／`pdf` 型附件的 `content.url` 皆為直接可用的原始檔連結（3 個樣本皆未加簽章、無時效參數），平台未提供描述或 OCR。我們計劃自建 vision／文件分析。**`content.url` 是否有時效？下載是否需額外授權標頭？** 若有時效，我們必須在收到訊息當下就處理並快取，設計會不同。

### H-2f. `/contact/{id}/files` 端點是否為正式介面？🟡

我們在官方介面的「聯絡人資料」彈窗中，從網路請求觀察到 `GET .../api/channel-service/v1/contact/{contact_id}/files` 會回傳附件，且用既有 access token 即可呼叫成功。**這是否為正式支援、可依賴的介面？** 若是內部實作細節，我們不應該依賴它。（範圍我們已依情境判斷為聯絡人層級而非單一對話，不影響對話附件清單的實作，僅供備查。）

### H-3b. `pub_` 前綴是否即代表 AI workflow？🟠

實測 `from` 前綴 `con_`=客戶／`u_`=真人客服／`pub_`=推測為 AI workflow，398 則覆蓋率 100%。**`pub_` 是否還可能代表其他來源**（例如「透過 API 發送」「系統訊息」）？除上述三種，`from` 還可能出現哪些前綴？這直接影響撞單防護的正確性——若 `pub_` 混雜其他來源，會產生誤判警示。

### H-3c. workflow 內部訊息如何區分？🔴

同一個 workflow 會在同一對話裡送出兩種性質完全不同的訊息，**API 上完全無法區分**：

| `from` | `content.text` | 客戶收得到嗎 |
|---|---|---|
| `pub_486c5cab…` | `抱歉造成您使用上的不便…` | ✅ 是 |
| `pub_486c5cab…` | `{"route": "T1"}` | ❓ 推測否 |

除 `id` 與時間戳外所有欄位完全相同，沒有旗標可判斷。**這類 `{"route":...}` 訊息客戶端是否真的收得到？若收不到，API 上有沒有辦法區分（例如加一個 `is_internal` 旗標）？**

> **為何重要**：我們在協作模式下會把「AI 已回覆客戶」視為撞單並攔下客服的送出。若這類內部訊息被誤判為已送達客戶，會產生假警報——而假警報比沒有警報更糟，客服學會忽略提示後，真正的撞單也會被一併略過。**暫行做法**：發送者為 `pub_` 且整段文字可解析為 JSON 視為內部訊息並排除，這是啟發式判斷而非規格。

### H-4. `removeTeamMember()` 的實際效力為何？🟠

規劃中的「主管強制介入」功能需要：被 `removeTeamMember()` 移出的客服，**是否仍能在官方介面回覆該對話**？是否可自行重新 JOIN？是否有對話層級的鎖定或獨佔機制？若擋不住官方介面，這個功能就只是勸告而非真正的接管，我們需要誠實標示邊界。

### H-5. `role` 的值域為何？🟡

`auth.authenticate()` 回傳的 `role?: string` 與 `is_admin?: boolean`——**`role` 有哪些字串值？哪一個對應「客服主管」？`is_admin` 指組織管理員還是團隊主管？** 我們要的是「能強制介入他人對話的人」，不一定等於組織管理員。若粒度不足以區分，我們會退回設定檔白名單。

### H-6b/c. 送訊息的請求規格 🟡

`conversation_id` 應使用哪一種形式（裸 UUID 或 `conv_` 前綴）？附件訊息（`type: image`／`pdf`）的送出方式為何？是先 `_fileupload` 取得 url 再帶入，還是有其他流程？（此項為 M2 需求，不急）

> 附帶回報一個可能的 bug：對不存在的 `conversation_id` 送訊息，平台回 `500 Internal server error` 而非 `404`，我們無法從錯誤碼區分「對話不存在」與「平台端真的出錯」。

---

## 背景說明（可直接轉貼給對方）

我們正在開發 **AgentCopilot**——一個擴充 iMBrace Conversations 模組的真人客服輔助工具。當客服按下 JOIN 介入對話時，AgentCopilot 會即時擷取完整對話紀錄，提供對話摘要、客戶情緒分析、SOP 建議回覆與知識庫快查，讓客服能在數秒內掌握現況並一鍵帶入回覆。系統以獨立 Web Console 形式運作，透過 `@imbrace/sdk` 串接平台。

**我們目前的狀態**：對話層能力已全部驗證可用（對話列表、訊息、presence、Data Board 讀寫、聯絡人、頻道設定），主線開發已在進行中，不會空等任何回覆。真正的阻塞集中在 §0 的 AI 能力與 §A 的 webhook 規格。

---

## 附錄：已自行解決，不需回覆（供追溯）

以下項目已透過實測或型別分析自行解答，**不需要貴方回覆**，如與實際行為有出入歡迎指正。

| 題號 | 結論 |
|---|---|
| 0-3a/b/d | agent 能取得引用來源（SSE `tool-output-available` 事件的 `RAGknowledge` 輸出，含檔名與 chunk 原文，為自由文字非結構化欄位）；能穩定回傳 JSON（4/4 次可 `JSON.parse`） |
| B-2a | `messages` API 的 `?conversation_id=` 為必填，僅 SDK 型別未公開此參數 |
| C-1 | SDK 無獨立的知識檢索端點，只有建立與列檔用的 API |
| E-1 | `messageSuggestion` 僅回傳 `{ suggestions: string[] }`，無信心度、來源、語氣參數，改作降級 fallback |
| F-2 | `auth.exchangeAccessToken()` 回傳含 `refresh_token`，續期機制存在 |
| G-1 | `Environment` 型別確認有 `sandbox` |
| H-1 | 對話層級 `mode` 欄位即為「暫停／恢復 AI」的機制：`manual`（AI 關閉）／`automation`／`hybrid`。寫入走 `POST /v1/team_conversations/_join`，與 JOIN 同一端點 |
| H-2a | 語音訊息：我方確認 iMBrace 平台不支援語音訊息 |
| H-2b | 圖片／PDF 平台未做描述或 OCR，`content` 僅有 `url`（PDF 另有 `caption`） |
| H-2c | `caption` 對圖片／PDF 而言是上傳時系統帶入的原始檔名，非使用者輸入或 AI 產生；客戶上傳時該欄位目前樣本皆為空 |
| H-2e | 客戶端上傳介面（web 頻道）僅接受圖片與 PDF，其餘格式傳不進來 |
| H-2f-b | `contact/files` 端點範圍已依發現情境（官方介面「聯絡人資料」彈窗）判斷為聯絡人層級，非單一對話 |
| H-3 | 訊息發送者身分由 `from` 前綴判別：`con_`=客戶／`u_`=真人客服／`pub_`=AI，398 則覆蓋率 100% |
| H-6a | 送訊息成功後回應的物件形狀——**不阻塞任何功能**，撞單防護的版本錨點另有來源（`GET /v1/conversation_messages` 的真實訊息 id），優先序最低 |
| — | `messages.send()` 的欄位名經零投遞探測確認為 `conversation_id`（SDK 型別未宣告） |

> **註**：本文件中的結論多透過解讀 `@imbrace/sdk@1.4.0` 的 TypeScript 型別定義與 stable 環境唯讀實測得出。型別能說明 API 表面，但不能說明資料實際的填充情況，若與貴方的實際行為有出入，請務必指正。

---

## 回覆後的動作

收到回覆後請更新：
- `docs/ARCHITECTURE.md` §19 已知風險與待確認事項（狀態欄）
- `docs/SDK_FINDINGS.md` 對應項
- 對應的 provider 實作狀態（`server/sources/`）
- 本文件標記已解決項目
