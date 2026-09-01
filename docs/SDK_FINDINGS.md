# SDK 靜態分析結果

> 對象：`@imbrace/sdk@1.4.0`（公開於 npm，MIT）｜方法：通讀 `.d.ts` 型別定義，不需憑證
>
> **這是 spike 的第 0 階段，型別層分析。** 型別只能回答「API 表面是否存在」，
> 不能回答「資料實際填不填得滿」——後者一律以 `scripts/spike/` 的 live probe 與
> `docs/ARCHITECTURE.md`／`docs/PLATFORM_CAPABILITY.md` 的實測結論為準。
> 本文列的型別層推論，**多數已被 live 實測推翻或補完**，詳見附錄。

---

## 現狀速覽（型別層結論 vs. 目前的權威結論）

| 型別層原始推論 | 目前狀態 | 權威來源 |
|---|---|---|
| `ai.complete()` 無 `response_format` → structured output 做不到 | 🟡 部分成立：該端點根本 404；改走 agent + prompt，4/4 次可 `JSON.parse` | `ARCHITECTURE.md` §19.1 #17、§8.2b |
| `messageSuggestion` 僅回字串陣列，無信心度／引用 | ✅ 成立，且更糟：端點本身 404 | `ARCHITECTURE.md` §19.1 #18 |
| `messages.list()` 無 `conversation_id`／`since` | 🟡 部分成立：`conversation_id` 用 `?conversation_id=` 繞過 SDK 可用（precision 100%）；`since` 類參數確實不支援 | `ARCHITECTURE.md` §9.3 |
| 知識庫 RAG 缺「檢索」端點 | ✅ 成立：無獨立檢索端點；但可透過 agent 的 SSE 事件取得引用來源 | `ARCHITECTURE.md` §8.2、§12.2 |
| `conversation.users[]` 提供對話 operator 清單 | ❌ **推翻**：實測為團隊名冊，非對話參與者 | `ARCHITECTURE.md` §10.2 |
| `OrganizationMembership` 帶 `role`／`is_admin` | ✅ 成立，可望沿用平台角色（值域待確認） | `ARCHITECTURE.md` §10.6 |
| `auth.exchangeAccessToken()` 回傳 `refresh_token` | ✅ 成立 | `ARCHITECTURE.md` §7.1 |
| `Environment` 型別含 `sandbox` | ✅ 成立 | — |
| `getViewsCount()` 的 view 是 all／joined／yours（SDK 註解逐字如此） | ❌ **推翻**：實測回的是 **status** 分組 `{active, open}`；`list({type})` 四種型別全回 0 筆 —— **沒有「只列出我 JOIN 的」這條路** | `ARCHITECTURE.md` §10.2.1、`out/23-views.json` |

> 📌 **唯一該記住的方法論教訓**：型別宣告只說「有這個欄位」，不說「這個欄位是什麼意思」。
> `users[]` 是最典型的例子——欄位存在、有值、型別完全對，但語意跟預期完全不同。
> 之後任何只靠型別層做的判斷，動工前都要先跑對應的 live probe。

---

## 型別層答不了、需要 live 驗證的項目

| # | 問題 | probe | 現況 |
|---|---|---|---|
| C-2 | RAG 檢索的相關度分數 | `04` | 🔴 仍未解決，見 `IMBRACE_QUESTIONS.md` 0-3c |
| ~~H-3~~ | 發送者身分 | `01` | ✅ 已解決 |
| H-2 | 附件文字化 | `02`、`14` | 🟡 主體已解決（`image`／`pdf` 有 url，平台不做描述→自建 vision）；**H-2d（URL 時效與授權）仍待 iMBrace 回覆**，見 `IMBRACE_QUESTIONS.md` |
| ~~B-2~~ | 增量拉取 | `03` | ✅ 已確認不支援，有繞法 |
| ~~E-2~~ | structured output | `05` | ✅ 已確認可用（prompt 層） |

---

## 對估算的影響

> ⚠️ **這是 2026-08-25 型別分析當下的估算快照，不是目前進度。** M0／M1 皆已完成並通過驗收
> （見 `ARCHITECTURE.md` §18），M1 那一列僅供追溯當初的判斷是否準確。

| 項目 | 原估 | 目前 | 備註 |
|---|---|---|---|
| M1 對話主線 | 12–18 人日 | ✅ 已完成 | 當初維持原估——`users[]` 捷徑不成立，改走 `mode` 欄位 + 本地快路徑 |
| M2 Copilot 核心 | 12–16 人日 | 16–22 ↑ | 建議卡需完整自建；structured output 靠 prompt，需自建重試機制。⚠️ 2026-08-26 訂正：原本此欄的圖片／PDF vision 分析人日已移出本里程碑（延後至 M3，見下列），本區間尚未針對移出後重新拆算，實際可能偏低於 16–22 |
| M3 知識庫與結案 | 10–14 人日 | 12–16 ↑ | RAG 檢索走 `AgentKnowledgeProvider` 或 `VikiKnowledgeProvider`，皆不需自建索引（原規劃的自建向量檢索已撤銷）。⚠️ 2026-08-26 由 M2 移入：圖片／PDF vision／文件分析自建管線，`docs/IMBRACE_QUESTIONS.md` H-2a／H-2b 已確認平台無內建 OCR，預估額外 **+5～10 人日**，本區間尚未重新加總 |

---

## 附錄：型別層推論的原始內容（僅供追溯）

<details>
<summary>展開查看每項推論當初的完整型別依據與推理過程</summary>

### `ai.complete()` 不支援 structured output

```ts
CompletionInput = { model, messages, temperature, maxTokens, metadata, stream }
//  ❌ 沒有 response_format ／ tools ／ tool_choice
```

型別上看不到 `response_format`，但 `WorkflowAgentModel` 帶 `is_toolCall_available` 旗標，代表底層模型支援，只是 SDK 型別未公開。live 驗證後：該端點根本 404，此路線整個不成立；改走 agent + prompt 才是正解。

### `messageSuggestion` 只回傳字串陣列

```ts
MessageSuggestionResponse = { suggestions: string[] }
```

無信心度、無來源引用。live 驗證後發現不只如此——端點本身 404，連當 fallback 都做不到。

### `messages.list()` 沒有 `conversation_id`，也沒有 `since`

```ts
list(params?: { type?, q?, limit?, skip? })
```

型別上看不到對話過濾參數。live 驗證後：繞過 SDK 直接帶 `?conversation_id=` 可用且後端強制要求（precision 100%）；但 `since`／`after`／`since_id` 等八種寫法確認皆被忽略。

### 知識庫 RAG 缺「檢索」那一步

```
✅ boards.uploadFile()            建檔
✅ aiAgent.processEmbedding()     建 embedding
❌ （沒有任何 query / retrieve / semanticSearch）
```

原本評估兩條替代路徑：`boards.search()`（Meilisearch 相容關鍵字檢索，live 驗證未受影響，仍是備案）與 `ai.embed()` 自建向量檢索（**live 驗證回 404，此路撤銷**）。第三條路徑——「掛 Knowledge Hub 給 AI Agent 再問它」——型別層原判為 ❌（回傳自由文字、無條目 ID 與分數），但 **live 驗證推翻此判斷**：agent 的 SSE `tool-output-available` 事件會吐出檔名與 chunk 原文，可以解析出引用來源（只是分數仍拿不到）。這條路後來成為 M2 實際採用的 `AgentKnowledgeProvider`。

### `conversation.users[]` 已提供完整 operator 清單（型別層推論，已被推翻）

```ts
interface Conversation { …; users: SimpleUser[] }   // { id, display_name, avatar_url }
```

型別層原本判定這是「這個對話的 operator 清單」，若成立可讓 `PollingEventSource` 靠 diff `users[]` 推斷 JOIN/LEAVE，M1 完全不被 webhook 規格阻塞。**live 驗證徹底推翻**：兩個不同對話回傳同一批 14 人，含 `is_bot: true` 與 `team_user_role: observer`，JOIN/LEAVE 全程數量不變——是團隊名冊，不是對話參與者。`mappers.diffOperators()` 因此沒有可用輸入；presence 的正確來源改為 `mode` 欄位（見 `ARCHITECTURE.md` §10.2）。

### 認證流程方法名（與文件假設不同，結構相同）

| 假設方法名 | SDK 實際方法名 |
|---|---|
| `requestOtp(email)` | `auth.signinEmailRequest(email)` |
| `loginWithOtp(email, code)` | `auth.authenticate({ email, otp })`（同時回傳組織清單） |
| `selectOrganization(orgId)` | `auth.exchangeAccessToken(orgId)` |

三段式結構本身正確，僅方法名需更新（實作改用 `client.*` 便利方法，見 `ARCHITECTURE.md` §7.1）。

</details>
