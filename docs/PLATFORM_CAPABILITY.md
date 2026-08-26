# iMBrace 平台能力邊界與方案評估

> 全部為 **stable 環境（= `app-gatewayv2.imbrace.co`，即正式環境）的實測結果**，非文件宣稱。
> 測試日期：2026-08-25 ｜ 全程唯讀 ｜ 探針：`scripts/spike/06-capability-map.ts`、`07-auth-boundary.ts`

---

## ⚠️ 2026-08-25 下午更正：本文 §1、§3②、§5 的結論已被後續實測推翻

本文原先寫「27 個 agent 全部無法推論、AI 層 6 項全不可用」。
**那是抽測少數 agent 後外推的錯誤結論。**

逐一實測 27 個 agent 後的正確結果：**11 個可實際完成推論**，其中 4 個掛了知識庫且能檢索；
JSON 結構化輸出 4/4 次可解析；引用來源可從 SSE 事件解析取得。

最新且正確的能力盤點已併入本文以下各節的更正（見 §1、§3②、§3③）。
本文保留原始（已推翻）內容供追溯，閱讀時請以各節的更正標註為準。

---

## 1. 結論（⚠️ 已被推翻，見上方更正）

~~**iMBrace 能完整支撐 demo 的左欄與中欄（對話層），但右欄 Copilot 面板的每一項依賴目前都不可用。**~~

實際情形：對話層 15 項全可用；AI 層**部分可用** ——
`ai.complete` / `ai.embed` / `messageSuggestion` 確實 404，
但 **AI Agent 路徑（`aiAgent.streamChat`）有 11/27 可用**，且能做知識庫檢索與 JSON 輸出。

仍然成立的缺口有：**無相關度分數**、**檢索品質不可調校**、**舊資料型 `file`（非圖片/PDF）附件內容取不到**。

> ⚠️ **2026-08-26 再更正（第二次）**：「附件內容取不到」原本以為對所有附件型別都成立，
> 但當時 `image`／`pdf` 型別 0 個實測樣本，是外推。用真實對話（圖片 1 則、PDF 2 則）重測後，
> `image`**與** `pdf`（PDF 是獨立型別，不等於 `file`）的 `content` 都帶有直接可用的 URL，
> 只是平台未做描述／OCR，且客戶上傳時連檔名（`caption`）都沒有。
> **只有真正的 `file` 型（歷史資料裡的 4 則樣本，非圖片/PDF）拿不到內容**，
> 且客戶端上傳介面本身只接受圖片與 PDF，這 4 則 `file` 樣本的來源反而成了新的待查項。
> `image`／`pdf` 已納回 MVP。詳見 `ARCHITECTURE.md` §19.1 #11、§11.4。

```
✅ 對話 / 訊息 / 聯絡人 / Data Board / 知識庫檔案來源 / 頻道 ── 15 項全可用
✅ AI 推論（透過 AI Agent）─────────────────────────── 11/27 agent 可用
✅ image／pdf 型附件（有 url，僅缺描述與檔名）────────── 2026-08-26 新增
❌ ai.complete / ai.embed / messageSuggestion ──────── 404（此結論不變）
❌ 相關度分數、檢索品質調校、舊資料型 file 附件內容 ──── 仍不可得
```

**憑證權限已排除。** 用 API Key 與客服本人的 access token 各測一遍，
404 的那三個端點兩者表現完全一致 —— 是部署缺失，不是權限問題。

---

## 2. Demo 功能對照

依 `demo_agentCopilot01.png` / `02.png` 逐項對到實測能力：

| Demo 功能 | 位置 | 需要的能力 | 現況 |
|---|---|---|---|
| 對話列表、訊息流、presence | 左/中欄 | conversations + messages | ✅ |
| AI 階段完整對話紀錄 | 右欄 ④ | messages（同一份資料，不需額外 API） | ✅ |
| 一鍵寫入 CRM | 右欄 ⑤ | Data Board createItem/search | ✅ |
| **AI 轉接摘要** | 左欄 | LLM 推論 | ❌ |
| **客戶情緒提示** | 右欄 ① | LLM 推論 | ❌ |
| **AI 語意即時建議（SOP 3.2·92%）** | 右欄 ② | LLM + 語意檢索 + **引用歸因** | ❌ |
| **知識庫自然語言快查** | 右欄 ③ | 語意檢索 | ❌ |
| **結案摘要自動填入** | 右欄 ⑤ | LLM 推論 | ❌ |

---

## 3. AI 層的三種失敗形態 —— 必須分開看

這三種的性質完全不同，混為一談會導出錯誤結論。

### ① 端點根本不存在（架構性）

| 端點 | API Key | Access Token |
|---|---|---|
| `POST /v3/ai/completions` | ❌ 404 | ❌ 404 |
| `POST /v2/ai/completions` | ❌ 404 | ❌ 404 |
| `POST /v3/ai/embeddings` | ❌ 404 | ❌ 404 |
| `POST /v1/message-suggestion` | ❌ 404 `Cannot POST` | ❌ 404 |

**兩種憑證皆 404 → 這個部署沒有這些路由。** 不是權限問題，換憑證無效。

後果：
- 無法用自訂 prompt 做摘要／情緒／結案（§11 整章的前提）
- 無法自建向量檢索（`ai.embed` 是先前規劃的替代方案，同樣不存在）
- `messageSuggestion` 不只是「缺信心度」，是**整個端點不存在**

### ② AI Agent 路由存在，**16/27 跑不動**（運維性）

> ⚠️ **更正**：本節原寫「每個 agent 都跑不動」。逐一實測後為 **11 個可用、16 個失敗**，
> 失敗形態的三種分類見下表；可用 agent 的完整清單存於 `scripts/spike/out/`。

`aiAgent.streamChat` → `POST /ai-agent/v2/chat` **機制正常**：
HTTP 200、`text/event-stream`、標準 Vercel-AI-SDK 事件格式（`start` / `text-delta` / `finish`）。

失敗的 16 個，形態有三：

| 形態 | 範例 agent | 推測原因 |
|---|---|---|
| `Cannot convert argument to a ByteString … value 8226` | NanShan Coordinator、國泰醫院小護士 | 8226 是 `•`。provider 的 AWS 金鑰讀回來是 `AKI••••••LEF`，平台似乎把**遮罩後的值**當真值送去 Bedrock |
| `The model X does not exist or you do not have access to it` | Miru Test、企業助理 | 請求已到達 Bedrock，但該模型未在此 AWS 帳號/區域開通 |
| `Assistant is missing model_id/provider_id configuration` | Sales and Commercial Agent | agent 設定不完整 |

**這一類是 iMBrace 可以修的。** 兩個 provider（`TPI_AWSBedrock`、`bedrock-partners`）都不可用。

### ③ 真正補不上的只有「分數」（架構性）

> ⚠️ **更正**：本節原寫「沒有 structured output、沒有引用來源」。兩者都不正確。
>
> - **結構化輸出**：實測 4/4 次可直接 `JSON.parse`（靠 prompt 達成，`response_format` 欄位為 null）
> - **引用來源**：agent 的 SSE `tool-output-available` 事件會吐出 `RAGknowledge` 工具的完整輸出，
>   含 `📁 Sources:` 檔名清單、`[Source: 檔名]` 標記的 **chunk 原文**，以及帶 `file_id` 的 `folder_info`。
>   坑：檔名是 double URL-encoded，且引用在文字裡而非結構化欄位。

**仍然成立的缺口**：

1. **沒有相關度分數** —— RAG 工具回傳純文字，無 score 欄位
   → demo 的「信心度 92%」無法對應到真實依據
2. **檢索品質不可調校** —— 實測問「電梯困人」，未命中知識庫裡的
   `金融大樓電梯困人SOP.pdf`，反而回傳「管理辦法」的火災段落。
   chunk 大小、top-k、中文斷詞、同義詞都不在我們手上。

全套 SDK 搜尋 `knowledge|semantic|retriev` 確實沒有**獨立的**查詢端點 ——
檢索只能「透過 agent」間接觸發，拿不到裸查詢結果。

> 知識庫的「料」是有的：311 個 RAG 檔案、20 個 Knowledge Hub 資料夾（含「企業知識」）、25 個 board。
> 但沒有任何方式可以查詢它們並取回帶分數的結果。

---

## 4. 完整能力矩陣

| 領域 | 能力 | 端點 | 結果 |
|---|---|---|---|
| 對話 | 對話列表（左欄） | `conversations.search({businessUnitId})` | ✅ |
| 對話 | 對話詳情（`tcu_` id / `mode` / `is_joined` / `users[]`） | `conversations.get(<對話 id>)` → `GET /v1/team_conversations/{id}` | ✅ **（2026-08-25 更正端點）** |
| 對話 | ~~對話詳情~~ | ~~`conversations.getByConversationId`~~ | ❌ 實測回 `{data:[],total:0}`，兩種 id 形式皆然 |
| 對話 | ~~該對話的 operator 清單~~ | ~~詳情的 `users[]`~~ | ❌ **是團隊名冊，不是參與者**（見 ARCHITECTURE §10.2）|
| 對話 | 未處理佇列 | `conversations.getOutstanding` | ✅ |
| 對話 | 各檢視計數（側欄徽記） | `conversations.getViewsCount` | ✅ |
| 對話 | 可邀請的同事 | `conversations.getInvitableUsers` | ✅ |
| 訊息 | 取單一對話訊息 | `GET conversation_messages?conversation_id` | ✅ |
| 訊息 | **增量拉取** | `?since` / `?after` / `?since_id` | ❌ 參數被忽略 |
| 聯絡人 | 客戶資料 | `contacts.list` | ✅ |
| Data Board | 結案摘要寫入目標 | `boards.list` | ✅ 25 個 |
| Data Board | 冪等查詢 | `boards.search` | ✅ |
| 知識庫 | Knowledge Hub 資料夾 | `boards.searchFolders` | ✅ 20 個 |
| 知識庫 | 已建索引的 RAG 檔案 | `ai.listRagFiles` | ✅ 311 個 |
| 知識庫 | **⭐ 語意檢索** | 無此端點 | ❌ |
| AI | provider 設定 | `ai.listProviders` | ✅ 2 個（金鑰遮罩） |
| AI | 已設定的 agent | `ai.listAiAgents` | ✅ 27 個 |
| AI | **⭐ 自由格式推論** | `ai.complete` | ❌ 404 |
| AI | **⭐ 向量化** | `ai.embed` | ❌ 404 |
| AI | **⭐ 平台內建建議** | `messageSuggestion` | ❌ 404 |
| AI | **⭐ Agent 推論** | `aiAgent.streamChat` | ⚠️ 路由通、agent 全壞 |
| 頻道 | 頻道設定（取 bu_id） | `channel.list` | ✅ |
| 組織 | 目前使用者 | `account.getAccount` | ✅ |
| 組織 | **角色判定** | `organizations.list` | 🔒 API Key ／ ✅ Access Token |

> **唯一被 access token 解鎖的能力是角色判定** —— 這正好對應 H-5，
> 且與 §7.3「以客服個人 token 執行」的設計一致。

---

## 5. 方案評估

> ⚠️ **2026-08-26 更新**：本節原始評估寫於 §1/§3 更正之前，把「無 structured output、無引用來源」列為方案 A 的缺口——這兩項在後續逐一實測 27 個 agent 後已被推翻（見 §3③）。以下為更正後的版本。

### 方案 A — 純 iMBrace（採用為第一階段）

| 項目 | 現況 |
|---|---|
| AI 推論 | ✅ 透過 AI Agent（11/27 可用） |
| 結構化輸出 | ✅ prompt 層可達成（4/4 次可 `JSON.parse`）——非 `ai.complete()` 的 `response_format`，是 agent + prompt 達成 |
| 引用來源 | 🟡 可從 SSE `tool-output-available` 解析出檔名與 chunk 原文，但是自由文字，需自行 parse `[Source: …]` |
| 相關度分數 | ❌ 無 —— 目前唯一真正做不到的一項 |
| 檢索品質調校 | ❌ chunk 大小、top-k、中文斷詞、同義詞皆不在我方手上 |

prompt 仍掛在平台 AI Agent 後台，離開程式碼版控，與 §11「prompt 集中管理」的理想設計有落差，但不影響功能可行性。

**結論：摘要、情緒、建議卡的文字內容都做得出來；做不出來的只有「分數」與「檢索品質可調校」這兩項。**

### 方案 B — iMBrace 管對話層、viki 管 AI 層（介面預留，非現階段採用）

| 層 | 系統 | 負責 |
|---|---|---|
| 對話 | iMBrace | conversations、messages、presence、JOIN/LEAVE、Data Board 寫入 |
| AI | viki | 知識庫（chunk 顆粒度、同義詞）、LLM 推論、**引用歸因**、guardrail |

viki 補的正好是方案 A 缺的兩項：

| viki 模組 | 對應缺口 |
|---|---|
| `business-logic/knowledgeStore/{document,synonym,web}` | 語意檢索、chunk 切分、同義詞擴展 |
| **`ai-assistant/answer-attribution.ts`** | **「事後歸因：以答案為基準，篩出真正相關的引用 chunk」** —— 即 SOP 引用 + 分數 |
| `ai-assistant/llm-guardrail.service.ts` | 輸出防護 |
| `llm-model` + OpenSearch | 地端 Gemma3 + 向量檢索 |

附帶好處：
- viki-frontend 也是 Nuxt，技術棧一致
- 支援客戶環境地端 Gemma3，**對話內容不出境**（直接解除風險 #9）
- chunk 顆粒度可調 —— SOP 文件的檢索品質可控
- **實作成本低**：viki 前端先建好知識庫與 AI 助理後，AgentCopilot 只需打其 public API 即可取得 LLM 回覆，不需額外部署

### 方案 C — 不引入 viki，在 AgentCopilot 的 Nitro 內自建 AI 層（不採用）

直接接地端 Gemma3 + 自建 chunk/向量檢索/歸因。

避免多一個系統，但等於重造 `answer-attribution` 這類 viki 已完成的能力。
**估 M2 + M3 多 8–12 人日**，且檢索品質調校的經驗要重新累積。

---

## 6. 建議（2026-08-26 更新：已依此推進開發）

**採方案 A 為第一階段實作，方案 B（viki）是介面預留的備援，不是預定的第二階段。**

方案 A 目前只缺「檢索分數」與「檢索品質調校手段」，其餘皆已驗證可行——沒有理由現在就預先承諾換系統。是否切換取決於 iMBrace 對 RAG 檢索品質（`IMBRACE_QUESTIONS.md` §0-3f）的回覆結果，而非時程排定。

```
現在
  對話層與 AI 層皆先接 iMBrace
  └─ KnowledgeProvider / AIProvider 兩個介面收斂所有 LLM 與檢索呼叫

依 iMBrace 對檢索品質／分數的回覆，二擇一（介面不變，只換實作）
  可用    → 沿用 iMBrace；score 有值時 UI 顯示信心度，無值時留空（不估算）
  不可用  → 換上 VikiKnowledgeProvider / VikiAIProvider；score 開始有值
```

信心度這個 UI 欄位本身不隨方案拿掉——它綁定「有沒有真實分數來源」而非「用哪個方案」，
這樣兩個方案才能真正無縫切換而不必再動介面一次。

**這正是 §8「所有尚未確定規格的外部依賴都必須藏在 provider 介面之後」的價值兌現點。**

> 本節原本列了一份「需要調整的架構章節」對照表，內容已同步進 `docs/ARCHITECTURE.md`
> （§2 決策摘要、§8 Provider 介面、§9.3 輪詢成本、§11 AI 管線、§12 知識庫），
> 此處不再重複列出——避免兩份文件各自漂移，細節請一律以 ARCHITECTURE.md 正文為準。

---

## 7. 應向 iMBrace 確認（優先序已依實測收斂）

| 優先 | 問題 | 為何 |
|---|---|---|
| 🔴 | `/v3/ai/completions`、`/v3/ai/embeddings` 是**未部署**還是**未對外開放**？有無計畫？ | 決定方案 A 是否還有機會 |
| 🔴 | 兩個 AI provider 目前皆不可用（遮罩金鑰被當真值送出 / 模型未開通），可否修復？ | 決定 Agent 路徑是否可用 |
| 🔴 | 有無任何檢索 API 可回傳**條目 ID + 相關度分數**？ | 決定建議卡能否成立 —— 這是 demo 的核心 |
| 🟠 | `messages` 是否支援增量拉取？（`since` 被忽略） | 輪詢成本與 API 壓力 |
| 🟠 | `role` 的值域為何？`role=admin` 但 `is_admin=false`，哪個對應「客服主管」？ | 主管強制介入的權限判定 |
| 🟠 | `from` 的 `pub_` 前綴是否即為 AI workflow？ | 撞單防護的正確性 |
| 🟠 | 圖片／PDF 是否已由平台做描述／OCR？（2026-08-26 已用真實樣本確認：目前沒有，僅回傳 url，客戶上傳時連 caption/檔名都沒有）；`content.url` 是否有時效、下載需不需要授權標頭？ | 決定 vision／文件分析的實作細節與快取時機 |
| 🟡 | `GET .../contact/{contact_id}/files` 這個非 SDK 公開的端點是否為正式支援介面？（2026-08-26 發現於「聯絡人資料」彈窗，實測可用；範圍已依此情境判斷為聯絡人層級，非單一對話——路徑本身也無 conversation id） | 決定「客戶歷史附件」功能能否依賴此端點；不影響對話附件清單（已確定不用這支端點） |

---

## 附錄：如何重現

```bash
cp .env.example .env.local        # 填 IMBRACE_ENV=stable 與 IMBRACE_EMAIL
npm run spike:auth                # 寄出 OTP
npm run spike:auth -- <驗證碼>     # 取得 acc_ token，寫回 .env.local

npx tsx scripts/spike/06-capability-map.ts    # 能力矩陣
npm run spike:boundary                        # API Key vs Access Token
```

全部唯讀。原始結果見 `scripts/spike/out/`。
