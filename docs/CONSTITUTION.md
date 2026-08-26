# AgentCopilot 專案憲法

> 本文件定義**不可違反的架構約束**。所有實作（含 AI agent 產生的程式碼）都必須遵守。
>
> 導入 GitHub Spec Kit 時，將本文件複製至 `.specify/memory/constitution.md`，
> 使後續每一個 feature 的 `/plan` 都自動受這些約束規範。
>
> 完整架構說明見 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
>
> 版本：v1.0 ｜ 2026-08-24

---

## 第一條：安全邊界

### 1.1 憑證絕不進入瀏覽器

- `IMBRACE_API_KEY`、access token、AI 金鑰、`SESSION_SECRET`、`WEBHOOK_SECRET` **一律只存於 server-side `runtimeConfig`**
- **`runtimeConfig.public` 底下不得放置任何秘密** —— 該區內容會直接打包進瀏覽器
- 瀏覽器只持有 httpOnly 的 session cookie，內含不可逆的 session id

### 1.2 SDK 僅在 server 使用

- **`server/` 以外的任何位置不得 `import '@imbrace/sdk'`**
- 前端一律透過 `server/api/**` 的 BFF 端點存取 iMBrace

### 1.3 不建立全域 SDK 單例

- 每個請求依 session 中的 token 建立 client
- 理由：所有操作必須以個別客服身分執行，否則 JOIN 與訊息送出的歸屬錯亂，稽核軌跡失去意義

### 1.4 Webhook 必須驗簽

- HMAC 驗簽 + 時間戳容忍（±5 分鐘）+ event id 去重，**三者缺一不可**
- 規格未取得前，webhook endpoint 不得對外開放

### 1.5 日誌不得輸出訊息全文

- 對話內容含客戶個資
- 日誌、監控、錯誤回報一律只留 id 與雜湊

---

## 第二條：外部依賴必須抽象

### 2.1 未定規格的依賴，一律藏在 provider 介面之後

| 介面 | 隔離什麼 |
|---|---|
| `ConversationEventSource` | JOIN / LEAVE 事件來源（輪詢 → webhook） |
| `MessageSource` | 訊息來源（輪詢 → webhook / WS） |
| `KnowledgeProvider` | 知識庫檢索（靜態 → Boards RAG → 官方 API） |
| `StateStore` / `EventBus` | 狀態儲存（記憶體 → Redis） |

### 2.2 替換實作時，上層邏輯不得修改

若替換某個 provider 需要改動 `SessionManager`、AI pipeline 或任何 API 路由，代表抽象邊界劃錯了，應先修正邊界。

### 2.3 `StateStore` 與 `EventBus` 的所有方法必須是 async

即使第一版是記憶體實作。

> 理由：若寫成同步的 `map.get()`，日後換 Redis 需修改數十個呼叫點；先寫成 `await store.get()`，換實作只需一天。

---

## 第三條：Copilot 不得拖垮主線

### 3.1 最高原則

> **任何 AI 或知識庫故障發生時，客服必須還能看對話、還能回覆。**

### 3.2 具體要求

- AI 分析失敗 → **該區塊**顯示錯誤與重試，其他區塊照常運作
- 知識庫失敗 → 建議降級為無引用版本，並明確標示
- 一律**靜默降級**：不使用全頁錯誤畫面、不彈 modal 打斷工作

### 3.3 唯一允許阻斷使用者的情境

**撞單偵測**（送出前發現他人已回覆客戶）。

理由：重複回覆客戶的傷害，遠大於多按一次按鈕的成本。

除此之外，任何故障都不得阻斷工作流程。

---

## 第四條：AI 輸出必須可驗證

### 4.1 一律使用 structured output，絕不解析自由文字

### 4.2 所有 AI 輸出必須經 Zod schema 驗證後才進入系統

### 4.3 `sopId` 必須經白名單後驗

流程：先檢索知識庫 → 將 hits 作為上下文提供 → 要求模型只能從 hits 的 id 中選擇 → **後端再驗證一次**，不在白名單者直接丟棄該建議卡。

> 僅靠 prompt 交代是不夠的，必須有程式層的後驗。

### 4.4 `confidence` 不得由模型憑空給定，沒有真實依據時必須是 `null`

有檢索分數時必須是 `f(檢索分數, 模型自評, 上下文完整度)` 並經後端校準。
**檢索分數（`KnowledgeHit.score`）不存在時，`confidence` 必須整體為 `null`，不得用模型自評頂替。**
UI 依此欄位是否為 `null` 決定顯示或留空——這讓 AI 來源在 iMBrace（無分數）與 viki（有分數）之間切換時，不需要另外改介面，見 `docs/ARCHITECTURE.md` §8.2b、§11.6②。

> 信心度一旦失準，客服很快就會學會忽略它，整個功能即告廢棄。這比留空更嚴重——寧可留空，也不要顯示一個沒有依據的數字。

### 4.5 事實不得推測

禁止模型編造工單編號、時間、金額、政策內容。缺乏資料時應填入 `requiresData` 欄位交由客服補上。

### 4.6 受控詞彙不得由模型自由生成

`category` 等統計用欄位必須取自 `config/categories.yaml`，否則寫入 Data Board 後無法製作報表。

---

## 第五條：AI 產物寫入正式紀錄必須經人審

### 5.1 結案／交接摘要寫入 Data Board 前，必須經客服編輯確認

### 5.2 若確有自動寫入需求，必須標記 `reviewed_by = null`

使其可於事後被稽核篩出。

### 5.3 冪等

同一對話重複產生摘要必須**覆蓋**而非新增。以 `conversation_id` 為唯一鍵，寫入前先 `search()` 再決定 `createItem` / `updateItem`。

---

## 第六條：資源使用

### 6.1 輪詢以 conversationId 為鍵共享訂閱

三位客服檢視同一對話 → **只輪詢一次**，結果 fan-out。訂閱數歸零即停止。

多副本部署時須以 `acquirePollLock()` 確保跨副本唯一。

### 6.2 完整 AI 分析僅在前景聚焦的對話執行

背景對話只跑輕量情緒分類，不生成建議卡、不查知識庫。

> 使用者看不到的東西不需要即時算好。

### 6.3 增量分析回傳 patch，不回傳全量

除了省 token，也避免摘要被整段重寫導致畫面跳動。

### 6.4 增量拉取

訊息一律以 `since=<messageId>` 拉取，不做全量。

### 6.5 媒體文字化結果必須快取

一張圖只做一次視覺分析、一段語音只做一次 STT，結果隨 message 永久保存。

**絕不可在每次全量分析時重複送原始媒體給模型** —— 這是成本失控最快的路徑。

AI 管線的輸入一律是 `Message.text`（原文／轉錄／圖片描述），不直接處理原始媒體。

---

## 第七條：協同與資料一致性

### 7.1 不得讓使用者誤判保護範圍

AgentCopilot 攔不住任何人在 iMBrace 官方介面操作。

**JOIN 不實作排他鎖** —— 策略是讓碰撞在造成傷害前被看見，而非防止碰撞。

**主管強制介入是唯一的真鎖，但強制力僅及於 AgentCopilot 內部**：
- 送出 API 必須實際拒絕（不可只在前端 disable）
- **介面必須明示「官方介面不受此鎖限制」**

> 讓主管誤以為已完全接管，比沒有鎖更危險。

### 7.2 送出前必須做樂觀併發檢查

以 `lastMessageId` 為版本錨點。這是唯一真正能防止客戶收到重複回覆的機制。

**判斷條件必須以 `sender.type` 為準，不得使用 `direction`。**

AI workflow 的自動回覆同樣是 outbound。以 direction 判斷會把 AI 回覆誤判為同事回覆，產生假警報。

> 假警報比沒有警報更糟 —— 客服學會忽略提示後，真正的撞單也會被一併略過。

### 7.3 JOIN 事件必須去重

雙來源（本地快路徑 + webhook）會收到同一動作。以 `conversationId + operatorId` 為鍵，10 秒時間窗內視為同一事件。

### 7.4 Webhook 上線後仍須保留對帳輪詢

每 30 秒比對本地與遠端的 `lastMessageId`，補上遺漏訊息。

> Webhook 會漏、會亂序、會重送。省略對帳的後果是「偶爾少一則訊息」—— 最難重現、最難追查的一類 bug。

### 7.5 主管強制介入必須留稽核紀錄

紀錄誰、何時、對哪個對話、中斷了誰。

> 這是有勞資敏感性的操作。缺乏紀錄時任何爭議都無從釐清 —— 這是保護所有相關人員的需求，不只是技術需求。

### 7.6 不得自建帳號角色權限系統

優先沿用 iMBrace 的角色設定；無法取得時使用設定檔白名單。

> 自建第二套權限系統的最大風險是**離職帳號漏關**。兩套系統必然出現同步落差，而稽核軌跡分散會使問題無從追查。

---

## 第八條：介面與無障礙

### 8.1 情緒狀態不得只靠顏色表達

必須同時具備**顏色 + 圖示 + 文字標籤**。

> 約 8% 男性有紅綠色覺辨識困難。「焦慮偏高」若只用紅線表示，對他們就是資訊遺失。

### 8.2 所有互動元素可鍵盤操作

客服以打字為主，滑鼠切換成本高。「一鍵帶入」必須有鍵盤快捷鍵。

### 8.3 訊息流必須使用虛擬滾動

### 8.4 草稿絕不遺失

Composer 內容持續保存至 `localStorage`，送出失敗、斷線、重新整理都不得清空。

### 8.5 文案集中於 i18n

即使目前只有繁體中文。客服系統的用語需能統一調整。

---

## 第九條：渲染與部署

### 9.1 `ssr: false`，但以 `nuxt build` + `node-server` preset 部署

不得使用 `nuxt generate` —— 會失去 `server/api/**`。

### 9.2 多副本部署必須先換上 Redis 實作

單副本才可使用記憶體實作。上 K8s 前，`RedisStateStore` 與 `RedisEventBus` 為必要條件。

> 否則 webhook 打到 A 副本、客服 SSE 連在 B 副本，推播直接失效。

---

## 第十條：文件同步

### 10.1 架構決策變更時，必須同步更新

- `ARCHITECTURE.md` §2 決策摘要與對應章節
- 本憲法（若涉及約束變更）

### 10.2 iMBrace 規格確認後，必須更新

- `ARCHITECTURE.md` §19 已知風險
- `IMBRACE_QUESTIONS.md` 標記已解決
- 對應 provider 的實作狀態

---

## 附錄：命名慣例

| 對象 | 慣例 | 範例 |
|---|---|---|
| 檔案 | kebab-case | `session-manager.ts` |
| Vue 元件 | PascalCase | `SuggestionCard.vue` |
| Composable | `use` 前綴 | `useCopilotSession.ts` |
| 型別／介面 | PascalCase，不加 `I` 前綴 | `CopilotSession` |
| API 路由 | RESTful + Nitro method 後綴 | `[id]/join.post.ts` |
| SSE 事件 | `名詞.動詞過去式` | `summary.updated` |
| EventBus topic | `類型:id` | `conversation:abc123` |

---

## 附錄：違反憲法時的處理

若實作過程中發現某條約束確實不合理或無法達成：

1. **不要默默繞過** —— 繞過的約束會在上線後以 bug 的形式出現
2. 在 PR 或 spec 中明確提出，說明衝突點
3. 討論後修正憲法，並同步更新 `ARCHITECTURE.md`
4. 憲法變更需留下版本紀錄
