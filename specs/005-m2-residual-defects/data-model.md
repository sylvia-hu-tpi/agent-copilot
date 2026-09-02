# Phase 1 — 資料模型：M2 遺留缺陷與量測補強

**Spec**: [spec.md](./spec.md) ｜ **Research**: [research.md](./research.md) ｜ **日期**: 2026-09-02

> 本規格**不新增任何持久化實體**，也不新增 SSE 事件型別。
> 下列四項全部是既有形狀的修改，外加一個 server-only 的稽核事件（不進 `shared/`）。

---

## §1 連線登記（`PollingCredential`）—— `server/services/credentials.ts`

### 形狀變更

| | 現況 | 變更後 |
|---|---|---|
| registry 形狀 | `Map<orgId, Map<operatorId, Cred>>` | `Map<orgId, Map<connectionId, Cred>>` |
| 唯一性單位 | **客服身分** | **每一次登記**（research.md #1） |
| 新增欄位 | — | `connectionId: string`、`clientId: string`、`lastSeenAt: number` |

```
PollingCredential {
  connectionId  string   // server 端 crypto.randomUUID()，本筆登記的鍵
  clientId      string   // 前端分頁 id，僅供定址（⚠️ 不唯一，見下）
  operatorId    string
  orgId         string
  accessToken   string   // ⚠️ 永不離開 server、永不進日誌（憲法 1.1／1.5）
  activity      'foreground' | 'background'
  registeredAt  number
  lastSeenAt    number   // FR-005a 的存活時間戳
}
```

### 不變式

- **I-1**：一條 SSE 連線 ⟺ 恰好一筆登記。連線建立時新增，`stream.onClosed()` 時移除。
  登記若被 TTL 誤剔（背景分頁的心跳被瀏覽器節流），**下一拍心跳 MUST 把它重建**
  —— 心跳是 **upsert**，不是純更新（research.md #3a）。重建的那一筆 `connectionId` 另產，
  改由心跳的生命週期擁有：連線關閉後心跳停止，≤45 秒由惰性回收清掉。
- **I-2**：`borrowCredential()` 只回傳 `now - lastSeenAt <= CREDENTIAL_TTL_MS` 的登記；
  逾期者在讀取當下剔除（惰性回收，research.md #4）。
- **I-3**：`hasForegroundOperator(orgId)` ＝ 該組織**任一**未逾期登記的 `activity === 'foreground'`。

### ⚠️ `clientId` 不是唯一鍵

瀏覽器「複製分頁」會連同 `sessionStorage` 一起複製，兩條連線因此可能帶同一個 `clientId`
（`app/stores/stream.ts` 的 `resolveClientId()`）。因此：

- **定址（心跳、activity）** 以 `(orgId, operatorId, clientId)` 命中的**全部**登記為對象；
- **移除** 只以 `connectionId` 為準。

把這兩件事搞混（例如心跳「取一筆」更新）會讓另一條活著的連線在 45 秒後被回收，
而且不報錯 —— 症狀就是本規格要修的那個症狀。

---

## §2 Copilot session 的觀察者（`CopilotSession.watchers`）—— `server/state/types.ts`

### 形狀變更

```
- watchers: string[]                                   // 去重的 operatorId
+ watchers: Array<{ operatorId: string, connectionId: string }>   // 每條連線一筆
```

`watchers` 全 repo 只被 `server/services/session-manager.ts` 讀寫（已確認無前端消費者，
也不隨任何 SSE 事件外流），改形狀不影響對外契約。

### 不變式（FR-004 的驗收核心）

> **I-4**：`session.watchers.length === pipelines().get(conversationId).refs`
> 在每一次 attach／release **完成後**都成立。

這條等式就是 spec 說的「同一件事只有一個真相」。它是可執行的斷言，不是敘述 ——
測試對「同一客服兩條連線」「兩位客服各一條」「異常中斷」三組情境逐一驗它。

- **I-5**：`deleteCopilotSession()` 只在 `watchers` 歸零時發生；歸零 ⟺ `refs` 歸零（由 I-4）。
- **I-6**：同一 `connectionId` 對同一對話至多一筆 —— `attach()` 一條連線一個對話只呼叫一次。

### ⚠️ 連帶的行為變更：`session.opened` 的 `reason`

`isResume` 現行判準是 `session.watchers.length > 1`。去重時「同一客服的第二個分頁」是 `false`，
改成連線計數後變 `true`。新語意＝「這個對話在我 attach 之前已經有人在看」。
`reason` 目前無前端消費者，但這是**行為變更**，MUST 在 tasks 與 CHANGELOG 層級明說。

### ⚠️ M4 的已知落差（不因本規格惡化）

`watchers` 進 `StateStore`（M4 換 Redis 後跨副本），`pipeline.refs` 是 process-local `Map`。
多副本下 I-4 只在**單一副本內**成立。這是既有落差（`docs/ARCHITECTURE.md` §18 M2
「分析管線拆檔」的八份 process-local 狀態同一個家族），本規格不解決，
但 I-4 的測試 MUST 標明它驗的是單副本。

---

## §3 情緒涵蓋範圍（`CopilotAnalysisState.sentimentGap`）—— `server/state/types.ts`

### 新增欄位

```
CopilotAnalysisState {
  ...
+ sentimentGap: boolean     // server-only。true ＝ 已知有未涵蓋的客戶發言待補
}
```

### 生命週期

| 事件 | `sentimentGap` |
|---|---|
| 情緒批次失敗（`finishBlockError('sentiment')`） | → `true` |
| 補算後確認已無未涵蓋發言 | → `false` |
| 補算後仍有剩餘（超過每輪 3 批上限） | 維持 `true` |
| 冷啟動 / 手動重試成功且涵蓋到最新 | → `false` |

### 缺口的定義（FR-007／FR-008，⚠️ 含左界）

> 缺口 ＝ { m ∈ 歷史 : m 是客戶發言 ∧ m.at > timeline[0].at ∧ m.id ∉ timeline 的 messageId 集合 }

**左界是 `timeline[0]`，不是對話的第一則訊息。** 冷啟動一次只吃最近
`DEFAULT_MESSAGE_LIMIT = 50` 則，更早的訊息是刻意不看的、不是缺口
（理由與後果見 research.md #8）。

### 抓取範圍（⚠️ 與缺口的「集合定義」是兩件事）

上面定義的是缺口**是哪些訊息**；這裡定義**要去撈哪一段歷史**才看得到它們。

> **抓取錨點 ＝ `timeline[0].messageId`**，即 `resolveHistory(conversationId, timeline[0].messageId)`。

⚠️ **MUST NOT 用 `lastCoveredMessageId()` 當錨點。** 它回傳 timeline 的**最後**一筆（高水位）；
中段批次失敗後，後續成功的批次會把高水位推到缺口**之後**，以它為錨點就永遠撈不到中段缺口
—— US2 的每一項任務都做完，卻一則也沒補到，而且沒有任何東西會變紅
（測試若把缺口造在尾端也會通過，見 tasks T021 的情境要求）。

`timeline[0]` 本身已被涵蓋，`fetchSince()` 回的是它**之後**的訊息，左界天然成立。
錨點若已被擠出最近 50 則視窗，`fetchSince()` 依既有約定回傳整批，
而 `newCustomerMessagesSince()` 對整條 timeline 做差集，正好吃得下這個形狀。

### 不變式

> ⚠️ 本組刻意用 **S-** 前綴。`I-1`～`I-8` 已被
> [contracts/connection-lifecycle.md §6](./contracts/connection-lifecycle.md) 的連線不變式佔用，
> 兩組同號會讓「測試對應哪一條」在 US1／US2 之間指錯人。

- **S-1**：`sentimentGap === false` 時，恢復路徑 **MUST NOT** 取歷史，行為與現況逐字相同（FR-012）。
- **S-2**：單輪補算的批次數 ≤ 3（＝ `SENTIMENT_CHUNK_SIZE × 3` ＝ 18 則客戶發言，FR-009）。
- **S-3**：補算 **MUST NOT** 自行排下一輪（FR-009／FR-010，003 SC-001 優先）。
- **S-4**：補算只擴充 `analyzeSentimentBatch()` 的輸入。摘要與建議卡的輸入不變（research.md #11）。

### ⚠️ 為什麼這不是被禁止的「第四種狀態」

spec 的 Assumption 排除的是「這個區塊分析到**第幾批**」這種進度狀態
（`SENTIMENT_CHUNK_SIZE` 註解裡刻意迴避的那一種，會與 analyzing／retrying／error 三態機衝突）。
`sentimentGap` 記的是**有沒有缺口**，與區塊狀態正交：
`ready` 且 `sentimentGap === true` 是完全合法且常見的組合（自癒成功但還沒補完）。

### 守衛

比照 `failedBatches`：**MUST NOT 出現在 `shared/` 底下任何檔案**
（`test/contract-guards.test.ts` 契約 1.1 的同一條守衛，本規格新增一個 `sentimentGap` 的對應項）。
三個分析事件送的是整個 Block，欄位一旦被塞進 Block 就會隨 SSE 流到瀏覽器，而 typecheck 不會響。

---

## §4 本次可用來源清單（Citable Source Set）—— 無新形狀

`KnowledgeHit[]` 不變。本規格只改**它在 prompt 裡的呈現**：
由「每筆 hit 的第一行帶 id」加上一份**顯式的封閉清單列舉**（FR-013、research.md #13）。

- 生成端（`buildSuggestionPrompt()`）：新增封閉清單段落。
- 後驗端（`whitelistFilter()`）：**一行不改**（FR-014）。

⚠️ 兩端的集合 MUST 是**同一個 `hits` 陣列**。第二段若用第一段的空集合，
所有帶 `sopId` 的卡都會被整卡捨棄而 `status` 仍是 `ready` ——
這個坑已寫在 `generateSuggestionCards()` 的註解裡，本規格不得讓它復活。

---

## §5 引用稽核事件 —— `server/utils/citation-audit.ts`（新檔，管線**外**）

完整欄位與語意見 [contracts/citation-audit-event.md](./contracts/citation-audit-event.md)。
此處只記它在資料層的三條性質：

- **P-1**：server-only。**MUST NOT** 進 `shared/`、**MUST NOT** 進任何 SSE 事件、
  **MUST NOT** 加任何前端欄位（spec Clarifications Q3 的裁定）。
- **P-2**：不含 PII（憲法 1.5）。型別上把 `text`／`title`／`snippet` 標成 `never`，
  讓「順手記進去」在 `npm run typecheck` 就過不了（research.md #17）。
  ⚠️ 型別守擋不到 `invalidSopIds`（它是 `string[]`，內容由模型自由生成），
  因此該欄位另有一道**機械式**收斂：> 64 字元者改記雜湊，見
  [contracts/citation-audit-event.md §1](./contracts/citation-audit-event.md)。
- **P-3**：**完整集合 MUST 出現在標準輸出**；額外落點只能是它的拷貝（FR-015）。

---

## §6 並行度常數 —— `SENTIMENT_CONCURRENCY`

```
- const SENTIMENT_CONCURRENCY = 3
+ const SENTIMENT_CONCURRENCY = Number(process.env.SENTIMENT_CONCURRENCY ?? 3)
```

- 只在**模組載入時**讀一次 → 同一行程內不可變 → 掃描必須 per-tier 子行程（research.md #19）。
- **守衛**：新增契約測試，斷言 `.env.example` 與 `nuxt.config.ts` 等設定檔
  **MUST NOT** 設定 `SENTIMENT_CONCURRENCY`。這道門只為量測而開，
  被生產環境誤用的症狀是「某個環境的情緒延遲莫名其妙不一樣」，沒有任何錯誤訊息。
- ⚠️ `SENTIMENT_CHUNK_SIZE` **不比照辦理**，維持「MUST NOT 有任何生產路徑改從外部覆寫」。

---

## §7 AI 呼叫者識別 —— `user_id`

不是持久化實體，是防腐層（`server/services/imbrace.ts`）的一份 process-local 快取：

```
aiClientUserId: string | null    // 取一次後快取；spike 19 已驗證多次取得一致
```

⚠️ 它是 **AI 服務的 client user id，與客服身分無關**。
填成客服的 `operatorId` 會讓 AI 服務端的用量統計掛到錯的人身上，且不會有任何錯誤
（憲法 1.3 管的是寫入歸屬，本項不觸及該條，但這個註解 MUST 寫在程式碼裡）。
