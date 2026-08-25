# iMBrace 平台能力邊界與方案評估

> 全部為 **stable 環境（= `app-gatewayv2.imbrace.co`，即正式環境）的實測結果**，非文件宣稱。
> 測試日期：2026-08-25 ｜ 全程唯讀 ｜ 探針：`scripts/spike/06-capability-map.ts`、`07-auth-boundary.ts`

---

## 1. 結論

**iMBrace 能完整支撐 demo 的左欄與中欄（對話層），但右欄 Copilot 面板的每一項依賴目前都不可用。**

而右欄就是這個產品本身。

分界線異常乾淨：

```
✅ 對話 / 訊息 / 聯絡人 / Data Board / 知識庫檔案來源 / 頻道 ── 15 項全可用
❌ 所有 AI 推論與語意檢索 ────────────────────────────── 6 項全不可用
```

**且已排除「憑證權限」這個可能性。** 用 API Key 與客服本人的 access token 各測一遍，
4 項關鍵 AI 能力**解鎖 0 項**，兩者表現完全一致。

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

### ② AI Agent 路由存在，但每個 agent 都跑不動（運維性）

`aiAgent.streamChat` → `POST /ai-agent/v2/chat` **機制正常**：
HTTP 200、`text/event-stream`、標準 Vercel-AI-SDK 事件格式（`start` / `text-delta` / `finish`）。

但組織內 27 個 agent 逐一實測，全部失敗，形態有三：

| 形態 | 範例 agent | 推測原因 |
|---|---|---|
| `Cannot convert argument to a ByteString … value 8226` | NanShan Coordinator、國泰醫院小護士 | 8226 是 `•`。provider 的 AWS 金鑰讀回來是 `AKI••••••LEF`，平台似乎把**遮罩後的值**當真值送去 Bedrock |
| `The model X does not exist or you do not have access to it` | Miru Test、企業助理 | 請求已到達 Bedrock，但該模型未在此 AWS 帳號/區域開通 |
| `Assistant is missing model_id/provider_id configuration` | Sales and Commercial Agent | agent 設定不完整 |

**這一類是 iMBrace 可以修的。** 兩個 provider（`TPI_AWSBedrock`、`bedrock-partners`）都不可用。

### ③ 即使 ② 修好，仍有一項補不上（架構性）

Agent 路徑回傳的是**串流的自由文字**：
- 沒有 structured output（違反憲法第 4 條「AI 輸出必須經 Zod 驗證」）
- **沒有帶分數的引用來源**

而 demo 的「SOP 3.2 安撫圓場｜信心度 92%」必須有能回傳**條目 ID + 相關度分數**的檢索 API。
全套 SDK 搜尋 `knowledge|semantic|retriev` 只有建立與列檔（`processEmbedding`、`listRagFiles`），
**沒有任何查詢端點**。

> 知識庫的「料」是有的：311 個 RAG 檔案、20 個 Knowledge Hub 資料夾（含「企業知識」）、25 個 board。
> 但沒有任何方式可以查詢它們並取回帶分數的結果。

---

## 4. 完整能力矩陣

| 領域 | 能力 | 端點 | 結果 |
|---|---|---|---|
| 對話 | 對話列表（左欄） | `conversations.search({businessUnitId})` | ✅ |
| 對話 | 對話詳情 + operator 清單 | `conversations.getByConversationId` | ✅ |
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

### 方案 A — 純 iMBrace

**前提**：iMBrace 修好 provider 設定（③ 之外的問題）。

即使修好，仍有兩個缺口：

| 缺口 | 影響 |
|---|---|
| 無 structured output | 摘要／情緒必須解析自由文字，違反憲法第 4 條，需自建重試與降級 |
| **無帶分數的檢索** | **建議卡的 SOP 引用與信心度做不到**，憲法第 5 條（sopId 白名單後驗）無法執行 |

且所有 prompt 必須以「平台 AI Agent」的形式管理，離開程式碼版控，
與 §11「prompt 集中管理、與程式邏輯分離」的設計衝突。

**結論：可做出降級版的摘要與情緒，但做不出 demo 的建議卡。**

### 方案 B — iMBrace 管對話層、viki 管 AI 層 ← 建議

| 層 | 系統 | 負責 |
|---|---|---|
| 對話 | iMBrace | conversations、messages、presence、JOIN/LEAVE、Data Board 寫入 |
| AI | viki | 知識庫（chunk 顆粒度、同義詞）、LLM 推論、**引用歸因**、guardrail |

viki 補的正好是 iMBrace 缺的每一項：

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

### 方案 C — 不引入 viki，在 AgentCopilot 的 Nitro 內自建 AI 層

直接接地端 Gemma3 + 自建 chunk/向量檢索/歸因。

避免多一個系統，但等於重造 `answer-attribution` 這類 viki 已完成的能力。
**估 M2 + M3 多 8–12 人日**，且檢索品質調校的經驗要重新累積。

---

## 6. 建議

**採方案 B，但分兩階段落地：**

```
階段一（不等任何人，立刻可做）
  M0 / M1 照原訂計畫走 —— 對話層完全不受影響，15 項能力都可用
  ├─ 登入、對話列表、訊息流、presence
  ├─ SSE 管線、共享訂閱輪詢
  └─ 撞單防護（sender 前綴判別已驗證，覆蓋率 100%）

階段二（AI 層）
  以 KnowledgeProvider / AI Provider 介面隔離，先接 viki
  └─ 若 iMBrace 日後補上 completions + 帶分數的檢索，替換實作即可
```

**這正是 §8「所有尚未確定規格的外部依賴都必須藏在 provider 介面之後」的價值兌現點。**
AI 來源從「iMBrace 內建」換成「viki」，上層一行不動。

### 需要調整的架構章節

| 章節 | 現況 | 應改為 |
|---|---|---|
| §2 決策摘要 · AI 來源 | 「全部自訂 prompt 打 `ai.complete()`」 | `ai.complete` 不存在 → 改為 viki（或地端 Gemma3） |
| §2 決策摘要 · 知識庫 | 「自建向量檢索（`ai.embed`）」 | `ai.embed` 不存在 → 改為 viki knowledgeStore |
| §8.2 KnowledgeProvider | `LocalVectorProvider` 優先 | 改為 `VikiKnowledgeProvider` |
| §9.3 輪詢成本 | 假設支援增量拉取 | **不支援 `since`**，需重算頻率表 |
| §11 AI 管線 | 假設 structured output | 依 viki 的實際輸出契約重寫 |
| §12 知識庫 | Boards RAG / 自建向量 | viki knowledgeStore + answer-attribution |

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
| 🟠 | 語音／圖片是否已文字化？（現有資料只有 text 與 file，無 image/audio 樣本） | M2 工作量級距（±5–10 人日） |

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
