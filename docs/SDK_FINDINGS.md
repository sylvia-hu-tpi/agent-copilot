# SDK 靜態分析結果

> 對象：`@imbrace/sdk@1.4.0`（公開於 npm，MIT）
> 方法：解開套件、通讀全部 `.d.ts` 型別定義與部分 `.js` 實作
> 日期：2026-08-25 ｜ **不需憑證即可得出**

這份是 spike 的**第 0 階段**。型別能回答「API 表面是否存在」，
但無法回答「實際資料是否填得滿」—— 後者由 `scripts/spike/` 的 live probe 驗證。

---

## 一、直接推翻既有規劃的發現 🔴

### 1. `ai.complete()` 不支援 structured output

```ts
CompletionInput = { model, messages, temperature, maxTokens, metadata, stream }
//  ❌ 沒有 response_format ／ tools ／ tool_choice
```

**衝突**：§11.7 明訂「全部使用 structured output / tool use，**絕不解析自由文字**」，
憲法第 4 條要求「AI 輸出必須經 Zod 驗證」。

**但**：模型清單 `WorkflowAgentModel` 帶有 `is_toolCall_available` 旗標，
代表底層模型支援，只是 SDK 型別未公開。額外欄位能否 passthrough 到後端 → `05-ai-structured.ts` 實測。

**若確認不支援**：改為 prompt 要求 JSON + Zod 驗證 + 失敗重試，M2 +1~2 人日。

---

### 2. `messageSuggestion` 只回傳字串陣列

```ts
MessageSuggestionResponse = { suggestions: string[] }
//  ❌ 沒有信心度、沒有 SOP 引用來源
```

**衝突**：§2 決策摘要寫「建議回覆先用 `messageSuggestion`」，
但 demo 畫面上的「SOP 3.2 安撫圓場｜信心度 92%」**無法由此產生**。

**影響**：建議卡從「接平台 API」變成「完整自建」（檢索 + 自訂 prompt + 後端校準）。
這是 M2 中被低估的一塊。`messageSuggestion` 只能當低品質 fallback。

---

### 3. `messages.list()` 沒有 `conversation_id`，也沒有 `since`

```ts
list(params?: { type?, q?, limit?, skip? })
//  → GET /v1/conversation_messages
```

**衝突**：§9 整套輪詢策略（1.5 秒／增量拉取／共享訂閱）都建立在
「取某對話自 `lastMessageId` 之後的新訊息」之上。

**候選解**（`03-incremental.ts` 實測）：
- `list({ q: convId })` —— 若 `q` 能當 conversation 過濾器
- 繞過 SDK 直接帶 `?conversation_id=` —— 後端很可能支援，SDK 只是沒公開
- 全量取回本地過濾 —— 最後手段，1.5 秒輪詢下頻寬代價高

**若只剩最後一條**：§9.2 的自適應頻率表必須整個重算。

---

### 4. 知識庫 RAG 缺「檢索」那一步

```
✅ boards.uploadFile()            建檔
✅ aiAgent.processEmbedding()     建 embedding
❌ （沒有任何 query / retrieve / semanticSearch）
```

全套 `.d.ts` 搜尋 `knowledge|semantic|retriev` 只找到建立與列檔，沒有查詢。
§12.2 規劃的 `BoardsRagProvider` 少了最後一哩路。

**但發現兩條可行替代路徑**：

| 路徑 | 可行性 | 說明 |
|---|---|---|
| `boards.search(boardId, {q, filter, limit})` | ✅ | Meilisearch 相容，**有條目 ID**，可滿足憲法第 5 條的白名單後驗。但是關鍵字非語意，同義詞會漏。分數需確認能否開啟 `showRankingScore` |
| **`ai.embed({model, input[]})` 自建向量檢索** | ✅ **建議** | embed API 已公開。SOP 數量級小（數百條），離線建索引 + 記憶體/Redis cosine 即可，**分數完全自控**，§11.6 的 confidence 校準公式可完整實作 |
| 掛 Knowledge Hub 給 AI Agent 再問它 | ❌ | 回傳自由文字，無條目 ID 與分數，違反憲法第 5 條 |

---

## 二、比預期樂觀的發現 🟢

### 5. `conversation.users[]` 已提供完整 operator 清單

```ts
interface Conversation { …; users: SimpleUser[] }   // { id, display_name, avatar_url }
```

**這是最重要的好消息。** `IMBRACE_QUESTIONS.md` 的 **A-1**（webhook 是否附帶
完整 operator 清單）被列為 P0，因為它決定 presence 有無盲區 ——
**但在輪詢路徑下我們已經可以自己拿到**。

**影響**：
- `PollingEventSource` 靠 diff `users[]` 推斷 JOIN/LEAVE 完全可行（已實作於 `mappers.diffOperators`）
- Presence 對「未開 AgentCopilot 的同事」**不再是永久盲區**（風險 #3 大幅降級）
- **M1 不被 webhook 規格阻塞** —— 這正是抽象層設計想達成的效果

### 6. 角色資訊可能可沿用平台

```ts
interface OrganizationMembership { …; role?: string; is_admin?: boolean }
```

`auth.authenticate()` 回傳的 organizations 帶 `role` / `is_admin`。
若實際有值，**H-5 解決，風險 #16（自建權限系統的離職同步缺口）解除**。

### 7. Token 可續期

`auth.exchangeAccessToken()` 回傳 `{ token, refresh_token }` —— **有 refresh_token**（F-2）。
客服不會在工作中被迫重跑 OTP。

### 8. 有 sandbox 環境

```ts
type Environment = 'develop' | 'sandbox' | 'stable' | 'prodv2'
```

G-1 解決。spike 與開發期可全程走 `sandbox`，不碰生產資料。

### 9. 認證流程與文件描述一致（方法名不同）

| §7.1 假設 | SDK 實際 |
|---|---|
| `requestOtp(email)` | `auth.signinEmailRequest(email)` |
| `loginWithOtp(email, code)` | `auth.authenticate({ email, otp })` ← 同時回傳組織清單 |
| `selectOrganization(orgId)` | `auth.exchangeAccessToken(orgId)` |

三段式結構正確，僅需更新 §7.1 的方法名。

---

## 三、型別無法回答、必須 live 驗證的 🟡

| # | 問題 | 為何型別答不了 | probe |
|---|---|---|---|
| H-3 | 發送者身分區分 | `from: string` 是單一字串，值域未知 | `01` |
| H-2 | 語音／圖片文字化 | `MessageType` 無 audio、`MessageContent` 無 transcript，但**後端可能回傳型別外的欄位** | `02` |
| B-2 | 增量拉取 | 需實測後端是否接受未公開參數 | `03` |
| C-2 | 檢索分數 | Meilisearch 分數需查詢時開啟 | `04` |
| E-2 | structured output | 需實測額外欄位能否 passthrough | `05` |

> **H-2 特別註記**：`MessageContent` 有 `caption` 欄位，但那是**使用者附的說明文字**，
> 不是 AI 產生的描述 —— 兩者不可混用。`02-multimodal.ts` 會掃描原始 JSON
> 尋找型別定義外的可疑欄位（`transcript|stt|ocr|description|…`）。

---

## 四、對估算的影響

| 項目 | 原估 | 調整後 | 原因 |
|---|---|---|---|
| M1 對話主線 | 12–18 人日 | **12–16** ↓ | `users[]` 已提供 operator 清單，PollingEventSource 比預期單純 |
| M2 Copilot 核心 | 12–16 人日 | **16–22** ↑ | 建議卡需完整自建（發現 2）＋ structured output 可能需重試機制（發現 1） |
| M3 知識庫與結案 | 10–14 人日 | **12–16** ↑ | RAG 檢索需自建（發現 4），但 `ai.embed` 可用，非最壞情況 |

**H-2 仍是最大的未爆彈** —— 若平台未做文字化，M2 再 +5~10 人日。
這也是為什麼 `SPIKE_CONVERSATION_ID` 一定要挑含語音與圖片的對話。
