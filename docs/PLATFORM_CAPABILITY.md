# iMBrace 平台能力邊界與方案評估

> **stable 環境（`app-gatewayv2.imbrace.co`，正式環境）的實測結果**，非文件宣稱。全程唯讀。
> 探針：`scripts/spike/06-capability-map.ts`、`07-auth-boundary.ts`、`02-multimodal.ts`、`14-contact-files.ts`
>
> 本文是能力矩陣與方案評估的正典。實測過程的修正歷程已移至文末附錄，正文只保留目前結論。

---

## 1. 結論

**對話層 15 項能力全可用；AI 層部分可用。**

```
✅ 對話 / 訊息 / 聯絡人 / Data Board / 知識庫檔案來源 / 頻道 ── 15 項全可用
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
| 對話 | 未處理佇列／檢視計數／可邀請同事 | `getOutstanding`／`getViewsCount`／`getInvitableUsers` | ✅ |
| 訊息 | 取單一對話訊息 | `GET conversation_messages?conversation_id` | ✅（SDK 未公開此參數，需繞過） |
| 訊息 | 增量拉取 | `?since` / `?after` / `?since_id` | ❌ 參數被忽略 |
| 聯絡人 | 客戶資料 | `contacts.list` | ✅（但業務欄位填充率極低，見 `ARCHITECTURE.md` §19.1 #21） |
| Data Board | 寫入目標／冪等查詢 | `boards.list`／`boards.search` | ✅ 25 個 board |
| 知識庫 | Knowledge Hub 資料夾／RAG 檔案 | `boards.searchFolders`／`ai.listRagFiles` | ✅ 20 個資料夾、311 個檔案 |
| 知識庫 | 語意檢索（獨立端點） | 無 | ❌ |
| AI | provider／agent 設定 | `ai.listProviders`／`ai.listAiAgents` | ✅ 2 個 provider、27 個 agent |
| AI | 自由格式推論／向量化／平台內建建議 | `ai.complete`／`ai.embed`／`messageSuggestion` | ❌ 404 |
| AI | Agent 推論 | `aiAgent.streamChat` | ✅ 路由通，11/27 agent 可用 |
| 附件 | `image`／`pdf` 原始檔 URL | 訊息 `content.url` | ✅ 有，但無描述／OCR，客戶上傳時無檔名 |
| 附件 | 舊資料型 `file` 內容 | 訊息 `content` | ❌ 只有 `{name, media_id}`，無 url，來源不明 |
| 頻道／組織 | 頻道設定／目前使用者 | `channel.list`／`account.getAccount` | ✅ |
| 組織 | 角色判定 | `organizations.list` | 🔒 API Key 401 ／ ✅ Access Token |

> 唯一被 access token 解鎖的能力是角色判定，與「以客服個人 token 執行」的設計一致。

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
| 🔴 | 有無任何檢索 API 可回傳條目 ID + 相關度分數？ | 決定建議卡信心度能否成立 |
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
