# iMBrace 平台能力邊界與方案評估

> **stable 環境（`app-gatewayv2.imbrace.co`，正式環境）的實測結果**，非文件宣稱。全程唯讀。
> 探針：`scripts/spike/06-capability-map.ts`、`07-auth-boundary.ts`、`02-multimodal.ts`、`14-contact-files.ts`
>
> 本文是能力矩陣與方案評估的正典。實測過程的修正歷程已移至文末附錄，正文只保留目前結論。

---

## 1. 結論

**對話層能力全可用；AI 層部分可用。**

> 📌 「15 項」這個數字曾被寫成「對話層 15 項」，是誤植。`06-capability-matrix.json` 探測的 21 項中有 15 項回 ✅，
> 但那是**跨領域**的總數（含知識庫檔案、AI provider 清單、組織），不是對話層的項數。
> 且其中一項（`getByConversationId` 取 operator 清單）已被後續實測推翻，目前實際為 **14/21**。
> 逐項結果以下方 §4 的能力矩陣為準，不要再引用單一數字。

```
✅ 對話 / 訊息 / 聯絡人 / Data Board / 知識庫檔案來源 / 頻道 ── 見 §4 矩陣
✅ AI 推論（透過 AI Agent）─────────────────────────── 11/27 agent 可用
✅ image／pdf 型附件（有 url，僅缺描述與檔名）
❌ ai.complete / ai.embed / messageSuggestion ──────── 404
❌ 相關度分數、檢索品質調校、舊資料型 file 附件內容 ──── 仍不可得
```

**憑證權限已排除。** 用 API Key 與客服本人的 access token 各測一遍，404 的端點兩者表現完全一致——是部署缺失，不是權限問題。

仍然成立的缺口：**無相關度分數**、**檢索品質不可調校**、**舊資料型 `file`（非圖片/PDF）附件內容取不到**（客戶端上傳介面本身只接受圖片與 PDF，這批舊樣本的來源待查，詳見 `ARCHITECTURE.md` §19.1 #11）。

---

## 2. Demo 功能對照

依 `demo_agentCopilot01.png` / `02.png` 逐項對到實測能力：

| Demo 功能 | 位置 | 需要的能力 | 現況 |
|---|---|---|---|
| 對話列表、訊息流、presence | 左/中欄 | conversations + messages | ✅ |
| AI 階段完整對話紀錄 | 右欄 ④ | messages（同一份資料，不需額外 API） | ✅ |
| 一鍵寫入 CRM | 右欄 ⑤ | Data Board createItem/search | ✅ |
| AI 轉接摘要 | 左欄 | LLM 推論 | ✅ 走 AI Agent |
| 客戶情緒提示 | 右欄 ① | LLM 推論 | ✅ 走 AI Agent |
| AI 語意即時建議（SOP + 信心度） | 右欄 ② | LLM + 語意檢索 + 引用歸因 | 🟡 內容可做，信心度數字無真實依據（nullable，見下） |
| 知識庫自然語言快查 | 右欄 ③ | 語意檢索 | 🟡 走 agent 間接檢索，非獨立端點 |
| 結案摘要自動填入 | 右欄 ⑤ | LLM 推論 | ✅ 走 AI Agent |

---

## 3. AI 層的三種失敗形態

三種性質完全不同，混為一談會導出錯誤結論。

### ① 端點根本不存在（架構性，無法修復）

| 端點 | 結果 |
|---|---|
| `POST /v3/ai/completions`、`/v2/ai/completions` | ❌ 404（兩種憑證皆然） |
| `POST /v3/ai/embeddings` | ❌ 404 |
| `POST /v1/message-suggestion` | ❌ 404 `Cannot POST` |

無法用自訂 prompt 直打做摘要／情緒／結案，無法自建向量檢索，`messageSuggestion` 完全不存在（不只是缺信心度）。

### ② AI Agent 路由存在，16/27 個 agent 跑不動（運維性，iMBrace 可修）

`aiAgent.streamChat` → `POST /ai-agent/v2/chat` 機制本身正常（HTTP 200、SSE、標準事件格式）。27 個 agent 逐一實測，**11 個可用**（含 4 個能做知識庫檢索），16 個失敗：

| 失敗形態 | 推測原因 |
|---|---|
| `Cannot convert argument to a ByteString … value 8226` | provider 的 AWS 金鑰讀回是遮罩過的 `AKI••••••LEF`，平台疑似把遮罩後的字串當真值送去 Bedrock |
| `The model X does not exist or you do not have access to it` | 模型未在對應 AWS 帳號／區域開通 |
| `Assistant is missing model_id/provider_id configuration` | agent 設定不完整 |

兩個 provider（`TPI_AWSBedrock`、`bedrock-partners`）皆受影響。

### ③ 真正補不上的只有「分數」（架構性）

- **結構化輸出**：可用，4/4 次 prompt 靠 agent 直接 `JSON.parse`
- **引用來源**：可用，agent 的 SSE `tool-output-available` 事件吐出 `RAGknowledge` 工具輸出，含 `📁 Sources:` 檔名清單與 `[Source: 檔名]` 標記的 chunk 原文（檔名 double URL-encoded，引用在自由文字裡非結構化欄位）
- **相關度分數**：❌ 無，RAG 工具回傳純文字沒有 score 欄位
- **檢索品質不可調校**：❌ 實測問「電梯困人」未命中知識庫裡的 `金融大樓電梯困人SOP.pdf`，反而回傳「管理辦法」的火災段落；chunk 大小、top-k、中文斷詞、同義詞都不在我方手上

> 知識庫的「料」是有的：311 個 RAG 檔案、20 個 Knowledge Hub 資料夾、25 個 board。沒有任何方式查詢它們並取回帶分數的結果。

---

## 4. 完整能力矩陣

| 領域 | 能力 | 端點 | 結果 |
|---|---|---|---|
| 對話 | 對話列表 | `conversations.search({businessUnitId})` | ✅ |
| 對話 | 對話詳情（`tcu_` id / `mode` / `is_joined` / `users[]`） | `conversations.get(id)` → `GET /v1/team_conversations/{id}` | ✅ 裸 UUID 與 `conv_` 前綴皆可 |
| 對話 | 該對話的 operator 清單 | 詳情的 `users[]` | ❌ 是團隊名冊，不是參與者（見 `ARCHITECTURE.md` §10.2） |
| 使用者 | 客服的**人名** | `loginWithOtp()` 的 `display_name`／名冊的 `users[].display_name` | ❌ **兩處都只有 email**（登入回應無此欄位；名冊實測 12/12 為 email）。見 §7.2b 與 `IMBRACE_QUESTIONS.md` H-9 |
| 對話 | ~~以對話 id 反查詳情~~ | ~~`conversations.getByConversationId`~~ | ❌ 兩種 id 形式皆回 `{data:[],total:0}`，**不要用**；改用 `conversations.get(id)` |
| 對話 | 未處理佇列／檢視計數／可邀請同事 | `getOutstanding`／`getViewsCount`／`getInvitableUsers` | ✅ |
| 訊息 | 取單一對話訊息 | `GET conversation_messages?conversation_id` | ✅（SDK 未公開此參數，需繞過） |
| 訊息 | 增量拉取 | `?since` / `?after` / `?since_id` | ❌ 參數被忽略 |
| 聯絡人 | 客戶資料 | `contacts.list` | ✅（但業務欄位填充率極低，見 `ARCHITECTURE.md` §19.1 #21） |
| Data Board | 寫入目標／冪等查詢 | `boards.list`／`boards.search` | ✅ 25 個 board |
| 知識庫 | Knowledge Hub 資料夾／RAG 檔案 | `boards.searchFolders`／`ai.listRagFiles` | ✅ 20 個資料夾、311 個檔案 |
| 知識庫 | 語意檢索（獨立端點） | 無 | ❌ |
| 罐頭訊息 | 訊息範本清單（`title`／`text`／真實 `updated_at`） | `GET cloud.imbrace.co/api/channel-service/v2/message_templates?business_unit_id=` | ✅ 可用。`business_unit_id` 吃 **`pub_` 開頭的第四種識別碼**，可由 `GET /api/platform/v1/business_units` 的 `public_id` 程式化取得（見 §4.1） |
| AI | provider／agent 設定 | `ai.listProviders`／`ai.listAiAgents` | ✅ 2 個 provider、27 個 agent |
| AI | 自由格式推論／向量化／平台內建建議 | `ai.complete`／`ai.embed`／`messageSuggestion` | ❌ 404 |
| AI | Agent 推論 | `aiAgent.streamChat` | ✅ 路由通，11/27 agent 可用 |
| 附件 | `image`／`pdf` 原始檔 URL | 訊息 `content.url` | ✅ 有，但無描述／OCR，客戶上傳時無檔名 |
| 附件 | 舊資料型 `file` 內容 | 訊息 `content` | ❌ 只有 `{name, media_id}`，無 url，來源不明 |
| 頻道／組織 | 頻道設定／目前使用者 | `channel.list`／`account.getAccount` | ✅ |
| 組織 | 角色判定 | `organizations.list` | 🔒 API Key 401 ／ ✅ Access Token |

> 唯一被 access token 解鎖的能力是角色判定，與「以客服個人 token 執行」的設計一致。

### 4.1 罐頭訊息（message templates）— 端點形狀已收斂，決定不納入建議卡

**2026-08-27 實測**（`npm run spike:templates`，原始輸出 `scripts/spike/out/17-*.json`）。
與 `contact/files` 同一條 host（`cloud.imbrace.co`），同樣不在 `@imbrace/sdk` 的公開型別中。

| # | 問題 | 結果 |
|---|---|---|
| 17a | 端點在我方憑證下可用 | ✅ `200`——gateway 憑證吃得動 cloud host，不需另外處理認證 |
| 17b | `business_unit_id` 吃哪一種 id | ✅ **`pub_` 開頭的第四種識別碼**（本組織為 `pub_d0cdedb8…`，`total=1`）。另外三個候選全部回 `200` 但 `0` 筆 |
| 17c | 去掉 `fields=title` 後拿得到內容本體 | ✅ **拿得到**，內容在 `text` 欄位 |
| 17d | `limit`／`skip` 分頁確實生效 | ❓ 全量僅 1 筆，樣本不足——需後台建 ≥2 則範本才能分辨「分頁生效」與「參數被忽略」 |

#### 🚨 第四種識別碼：`business_unit_id` 吃的是 `pub_`，且同名欄位裝不同東西

這是 §9.3「三種識別碼」的續集，而且更難察覺：

| 來源 | 欄位名 | 實際值 | 用途 |
|---|---|---|---|
| `channel.list()` | `bu_id` | `bu_d6204caa…` | SDK 的 `conversations.search({ businessUnitId })`（**現行程式碼用的就是這個，正確**） |
| `channel.list()` | `bot_id` | `pub_486c5cab…` | 官方帳號／Bot 實體（全組織 40 個 channel 共用同一個） |
| **`message_templates` 回應** | **`bu_id`** | **`pub_d0cdedb8…`** | channel-service 的 `business_unit_id` 參數 |

**同一個欄位名 `bu_id`，在 SDK 與 channel-service 裡裝的是兩種不同前綴的識別碼**；
而 channel-service 要的那個 `pub_d0cdedb8…` **在任何既有 SDK 回應裡都找不到**——
`channel.list()` 的 40 筆全部掃過都沒有它，目前唯一來源是官方介面的瀏覽器 Network 面板
（已記入 `.env.local` 的 `SPIKE_PUBLIC_ID`）。

實測時把 `bu_`／`org_`／`pub_486c5cab`（Bot）三種都傳過，回應**一模一樣**都是
`200 {data:[],total:0}`，沒有 400、沒有任何錯誤訊息。首跑因此把「0 筆」誤記為
「這個 business unit 沒有範本」，是使用者指出實際參數值後才發現。

> **規則**：打 `channel-service/**` 時 **MUST NOT** 重用 `resolveBusinessUnitId()` 的回傳值
> （那是 `bu_`），且 **MUST NOT** 以「回 200」當作 id 正確的證據——要看 `total`。
> 已在 `server/services/business-unit.ts` 的檔頭加註警告。

#### 範本的資料形狀（`total=1` 的實測樣本）

```
id / _id / public_id   mtemp_20260824061530_681jn1   ← 三個欄位同值，可直接當白名單 id
bu_id                  pub_d0cdedb8…                 ← 注意：裝的是 pub_ 值
title                  （標題）
text                   （內容本體）                    ← 建議卡真正需要的欄位
category               { id: 'cat_…', name: '…' }     ← 受控詞彙，有 id
categories             []
template_language      'zh'
created_at/updated_at  2026-08-24T06:15:30.283Z      ← **真實時間戳，不需從檔名硬解**
```

**對建議卡的價值比原先預估更高**：`updated_at` 是平台直接給的真實時間戳，
不像 RAG 知識庫檔案得用檔名正則猜（`specs/002-suggestion-knowledge-search/research.md` #2，
且經常解不出來只能是 `null`）。若日後納入，`FR-009` 的「超過 12 個月標示過舊」在範本這條路徑上
是**可靠**的。`id` 三個欄位同值也讓白名單核對單純。

**順帶測到的組織結構**（`scripts/spike/out/17-channel-list.json`，40 個 channel）：

- **`bot_id` 全組織只有一個**：40 個 channel 的 `bot_id` 全部是同一個 `pub_486c5cab…`。
  這與 `03-operators-snapshot.json` 裡那個名為 Bot 的 `pub_` operator 是同一個 id。
- **`bu_id` 只出現在 40 個中的 2 個**；其餘 38 個 channel 根本沒有這個欄位。
  `businessUnitId()`（`scripts/spike/lib/harness.ts`）取的是「第一個有 `bu_id` 的 channel」，
  因此它代表的並不是整個組織。
- 這也意味 **`pub_` 是「發布主體／官方帳號」層級的實體**，不是某個 AI 流程——見下方對 H-3b 的影響。

#### `pub_` id 現在有 API 可程式化取得了（2026-08-27 二次實測，new-17f）

`GET https://cloud.imbrace.co/api/platform/v1/business_units` 回傳 `data[].public_id`，
與 message_templates 唯一查得到資料的那個 id **完全一致**（`pub_d0cdedb8…`）：

```json
{
  "data": [{
    "object_name": "business_unit",
    "id": "pub_d0cdedb8-…", "public_id": "pub_d0cdedb8-…",
    "organization_id": "org_edd11025-…", "name": "TPIsoftware", …
  }],
  "total": 1
}
```

推翻先前「只能從瀏覽器 Network 面板抄」的結論——`resolveBusinessUnitId()`（SDK 的 `bu_`）與
這支新端點（channel-service 的 `pub_`）**都能各自程式化取得**，不再需要任何寫死的環境變數或人工抄值。
`.env.local` 的 `SPIKE_PUBLIC_ID` 現在只是 spike 腳本的候選來源之一（其餘來源含這支新端點），
非唯讀正式程式碼的依賴。

#### `text` 確實含 `{{變數}}` 佔位符（2026-08-27 三次實測，new-17g）

使用者在後台唯一的那則範本裡加入 `{{tel}}` 後重跑 `npm run spike:templates`：**偵測到 1 個
相異佔位符 `{{tel}}`**。腳本只抓佔位符語法本身（正則 `/\{\{\s*([\w.]+)\s*\}\}/g`），不擷取、
不印出、不寫入 fixture 周圍的範本全文——`text` 是客服話術，憲法 1.5「日誌不得輸出訊息全文」
在 spike 產出上同樣適用；`scripts/spike/out/17-templates-full.json` 上的 `text` 欄位仍是
`redactText()` 產出的長度＋雜湊指紋，沒有任何字面內容外洩。

**這代表罐頭訊息若要納入建議卡，MUST 先決定佔位符的處置**，三個選項各有取捨：

| 選項 | 說明 | 疑慮 |
|---|---|---|
| ① 交給 `requiresData` | 佔位符名稱（`tel`）進 `SuggestionCard.requiresData`，客服送出前自行填入 | 需要能可靠解析 `{{...}}` → 人類可讀標籤的對應（`tel`→「電話」還好認，但變數命名規則未知，可能有 `{{ord_no}}` 之類的縮寫） |
| ② 排除含佔位符的範本 | 生成階段先過濾，含 `{{...}}` 的範本不進白名單 | 簡單但可能排掉大量範本——只有一則樣本，無法估計真實範本庫裡有多少比例含佔位符 |
| ③ 就地代換 | 用對話上下文（如客戶電話）填入佔位符 | 可行性存疑：客服對話中不一定有對應的結構化資料（`tel` 這類欄位客戶未必留過），且變數命名規則未知前無法做通用對應邏輯 |

目前**沒有足夠樣本**判斷哪個選項可行——僅一則範本、一種佔位符，無法推論全體範本庫的佔位符
使用比例與命名規則。若後續 feature 要納入，建議先向 iMBrace 詢問範本佔位符的完整規格
（合法變數清單、命名慣例），而非僅憑這一筆樣本設計。

**17d（分頁）仍未收斂**：範本數仍只有 1 則，需後台建 ≥2 則後重跑 `npm run spike:templates`
即可收斂（腳本不需再改）。

**對 H-3b 的影響（✅ 2026-08-29 已處置）**：H-3b 原本問的是「`pub_` 前綴是否即代表 AI workflow」。
既然 `pub_` 實為 publisher 實體 id，那個問法的標的一開始就偏了——該問的是「同一個 publisher 送出的
訊息，哪些真的送達客戶、哪些是 workflow 內部中繼訊息」。**H-3b 已於 `docs/IMBRACE_QUESTIONS.md`
撤回**（附錄 A），其中「`from` 還可能出現哪些前綴」這個仍有價值的部分併入 H-3c 第 ③ 小題。
⚠️ 這**不影響撞單防護的現行行為**：`from: pub_…` 仍代表「不是真人客服送的」，該攔還是要攔。

**2026-08-27 決策：不納入建議卡，改列為輸入框旁獨立功能的候選方向。**
原本評估的動機是：`specs/002-suggestion-knowledge-search` 的建議卡在知識庫未命中時會退化成
「AI 即時生成、無來源引用」的通用建議（FR-004），罐頭訊息這批人工維護、已審核的文字理論上
可作為憲法 4.3 白名單的第二個來源。但建議卡的職責是「系統主動判斷後產生的完整回覆」，範本是
「客服主動挑選的現成文字」，兩者使用情境不同，且佔位符的處置未收斂（見上）——不因技術可行就
納入。範本更適合做成**輸入框旁的獨立快速插入功能**（鄰近夾帶檔案按鈕）。

> ⚠️ **2026-08-31 訂正：畫布上的「常用回覆」按鈕已經不存在了。**
> 本段原本寫「與設計稿 `docs/wireframe/03-workspace_lightTheme.png` 已畫出的『常用回覆』按鈕吻合」——
> 那張截圖是 08-28 版；畫布 08-31 版**已把「常用回覆」與字數一併移除**，該位置現在是
> **夾帶檔案按鈕**（`docs/DESIGN_TOKENS.md` §8.4）。實作側也早已裁定兩者都不做
> （`M2-UI-PARITY.md` D-10）。
>
> 這**不影響本節的實測結論** —— 端點形狀、`pub_` id 裝配路徑、佔位符取捨都照舊有效，
> 變的只是「設計稿上有沒有一顆對應的按鈕」。此獨立功能仍未排入任何里程碑；
> 屆時要做的話，等於是**在畫布上新開一個元素**，不是實作既有設計。

---

## 5. 方案評估

### 方案 A — 純 iMBrace（採用為第一階段）

| 項目 | 現況 |
|---|---|
| AI 推論 | ✅ 透過 AI Agent（11/27 可用） |
| 結構化輸出 | ✅ agent + prompt，4/4 次可 `JSON.parse` |
| 引用來源 | 🟡 可解析，但是自由文字 |
| 相關度分數 | ❌ 無——唯一真正做不到的一項 |
| 檢索品質調校 | ❌ 不在我方手上 |

prompt 掛在平台 AI Agent 後台，離開程式碼版控，與理想的「prompt 集中管理」設計有落差，但不影響功能可行性。**摘要、情緒、建議卡的文字內容都做得出來；做不出來的只有「分數」與「檢索品質可調校」。**

### 方案 B — iMBrace 管對話層、viki 管 AI 層（介面預留，非現階段採用）

| 層 | 系統 | 負責 |
|---|---|---|
| 對話 | iMBrace | conversations、messages、presence、JOIN/LEAVE、Data Board 寫入 |
| AI | viki | 知識庫（chunk 顆粒度、同義詞）、LLM 推論、引用歸因、guardrail |

viki 補的正好是方案 A 缺的兩項：`answer-attribution` 提供 SOP 引用 + 分數，`knowledgeStore` 提供可調的 chunk/同義詞。附帶好處：技術棧一致（同為 Nuxt）、可地端部署（對話內容不出境）、實作成本低（viki 前端建好知識庫與 AI 助理後打 public API 即可）。

### 方案 C — 自建 AI 層（不採用）

直接接地端模型 + 自建 chunk/向量檢索/歸因。避免多一個系統，但等於重造 viki 已完成的能力，估 M2+M3 多 8–12 人日。

---

## 6. 建議

**採方案 A 為第一階段實作，方案 B（viki）是介面預留的備援，不是預定的第二階段。**

方案 A 只缺「檢索分數」與「檢索品質調校手段」，其餘皆已驗證可行，沒有理由現在就預先承諾換系統。是否切換取決於 iMBrace 對 RAG 檢索品質（`IMBRACE_QUESTIONS.md` §0-3f）的回覆結果，而非時程排定。

```
現在：對話層與 AI 層皆先接 iMBrace，KnowledgeProvider / AIProvider 收斂所有呼叫

依 iMBrace 回覆二擇一（介面不變，只換實作）
  可用   → 沿用 iMBrace；score 有值時顯示信心度，無值時留空
  不可用 → 換上 VikiKnowledgeProvider / VikiAIProvider；score 開始有值
```

信心度這個 UI 欄位不隨方案拿掉——它綁定「有沒有真實分數來源」而非「用哪個方案」，這樣兩個方案才能無縫切換。這正是「所有尚未確定規格的外部依賴都必須藏在 provider 介面之後」的價值兌現點（`ARCHITECTURE.md` §8）。

架構細節（provider 介面、輪詢成本、AI 管線、知識庫）一律以 `ARCHITECTURE.md` §8/§9.3/§11/§12 為準，此處不重複。

---

## 7. 應向 iMBrace 確認（優先序已依實測收斂）

| 優先 | 問題 | 為何 |
|---|---|---|
| 🔴 | `/v3/ai/completions`、`/v3/ai/embeddings` 是未部署還是未對外開放？有無計畫？ | 決定方案 A 是否還有機會 |
| 🔴 | 兩個 AI provider 目前皆不可用，可否修復？ | 決定 Agent 路徑可用數量 |
| 🔴 **最優先** | **RAG 檢索品質可否調校？**（chunk 大小／top-k／中文斷詞／同義詞）實測問「電梯困人」未命中同名 SOP 檔（`IMBRACE_QUESTIONS.md` 0-3f） | **唯一可能讓建議卡整個上不了線的變數**——調不動則觸發換上 viki（§6） |
| 🟠 | 有無任何檢索 API 可回傳條目 ID + 相關度分數？（0-3c） | ⚠️ **2026-08-29 由 🔴 降為 🟠**：降級方案已落地——`confidence` 改為 nullable，無分數時 UI 留空，不用模型自評頂替（憲法 4.4）。因此本題已不阻塞開發，只影響「是否更換知識庫來源」的決策。缺檢索品質（0-3f）才是不能降級的那一項 |
| 🟠 | `messages` 是否支援增量拉取？ | 輪詢成本與 API 壓力 |
| 🟠 | `role` 的值域為何？ | 主管強制介入的權限判定 |
| 🟠 | `from` 的 `pub_` 前綴是否即為 AI workflow？ | 撞單防護的正確性 |
| 🟠 | 圖片／PDF 是否已由平台做描述／OCR？`content.url` 是否有時效？ | 決定 vision／文件分析的實作細節與快取時機 |
| 🟡 | `GET .../contact/{contact_id}/files` 是否為正式支援介面？ | 決定「客戶歷史附件」功能能否依賴此端點 |

完整問題清單見 `docs/IMBRACE_QUESTIONS.md`。

---

## 附錄 A：如何重現

```bash
cp .env.example .env.local        # 填 IMBRACE_ENV=stable 與 IMBRACE_EMAIL
npm run spike:auth                # 寄出 OTP
npm run spike:auth -- <驗證碼>     # 取得 acc_ token，寫回 .env.local

npx tsx scripts/spike/06-capability-map.ts    # 能力矩陣
npm run spike:boundary                        # API Key vs Access Token
```

全部唯讀。原始結果見 `scripts/spike/out/`。

## 附錄 B：修正歷程（摘要，僅供追溯）

本文歷經兩輪推翻性更正，正文已全部改為更正後的結論，此處僅記錄變化本身：

1. **2026-08-25**：初版僅抽測少數 agent 便外推「27 個 agent 全部無法推論、AI 層 6 項全不可用」。逐一實測 27 個後推翻——11 個可用，structured output 與引用來源皆可行。§1、§3②、§3③、§5 全面改寫。
2. **2026-08-26**：初版認為「附件內容全部拿不到」，實際上僅 398 則歷史訊息中 0 則 `image`／`pdf` 樣本，屬外推。用真實對話重測後，`image`／`pdf` 皆有可用 url，只是缺描述；只有非圖片/PDF 的舊資料型 `file` 真的拿不到內容。§1、§4、§7 同步更新。
