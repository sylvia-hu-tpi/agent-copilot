# 契約：Data Board schema 與 setup script

**Spec**: [../spec.md](../spec.md) ｜ **Research**: [../research.md](../research.md) ｜ **Date**: 2026-09-03

> `ARCHITECTURE.md` §13.3 逐字寫著這句話，本份契約整份都是它的展開：
>
> > **少建一欄不會報錯，只會讓該維度在報表裡永遠是空的。**

---

## 1. Board

| 項目 | 值 |
|---|---|
| 名稱 | `AgentCopilot_ClosureSummary` |
| 執行期識別 | 環境變數 `IMBRACE_CLOSURE_BOARD_ID`（research #4） |
| 建立方式 | `npm run board:setup` |
| 驗證方式 | `npm run board:verify` |

⚠️ 執行期 **MUST NOT 用名稱查找 board**。名稱不是唯一鍵，同名 board 會讓寫入靜默落到錯的地方，
而 Board 是正式 CRM —— 寫錯的紀錄不會有任何錯誤訊息。

---

## 2. 欄位清單（**這份表就是 `--verify` 的比對來源**）

| Board 欄位 | 型別 | `ClosureSummary` | 留空語意 |
|---|---|---|---|
| `record_id` | ShortText（主鍵） | `recordId` | — |
| `draft_id` | ShortText | `draftId` | — |
| `conversation_id` | ShortText（**可重複索引**） | `conversationId` | — |
| `period_start` | Date | `periodStart` | — |
| `period_message_count` | Number | `periodMessageCount` | — |
| `period_origin` | SingleSelection | `periodOrigin` | 🆕 本規格新增（research #21） |
| `channel` | ShortText | `channel` | — |
| `contact_id` | ShortText | `contactId` | — |
| `operators` | LongText（JSON 陣列） | `operators` | — |
| `joined_at` | Date | `joinedAt` | — |
| `closed_at` | Date | `closedAt` | — |
| `summary` | LongText | `summary` | — |
| `intent` | ShortText | `intent` | — |
| `category` | SingleSelection | `category` | 白名單外 → 留空 |
| `resolution` | SingleSelection | `resolution` | — |
| `actions_taken` | MultipleSelection | `actionsTaken` | — |
| `sentiment_outcome` | SingleSelection | `sentimentOutcome` | — |
| `sentiment_start` | Number | `sentimentStart` | **留空 ＝ 評分點不齊**（FR-022b） |
| `sentiment_end` | Number | `sentimentEnd` | 同上 |
| `sentiment_trough` | Number | `sentimentTrough` | 同上 |
| `period_sentiment_note` | ShortText | `readonly.sentimentNote` | 🆕 情緒留空的原因與實際涵蓋範圍 |
| `cited_sops` | LongText（JSON 陣列） | `citedSopIds` | — |
| `follow_ups` | LongText（JSON） | `followUps` | — |
| `confidence` | Number | `confidence` | 留空 ＝ 無真實依據（憲法 4.4） |
| `reviewed_by` | ShortText | `reviewedBy` | **留空 ＝ 未經人審**（憲法 5.2） |
| `reviewed_at` | Date | `reviewedAt` | — |

### 型別選擇的三條理由（research #6、#7，✅ 2026-09-03 已實測）

- **`Number` 與「留空」**：✅ 實測未設定的 `Number` 回讀為 **`null`**，與 `0` 明確可分
  （`006-E4`）。因此 FR-022b 的「留空」＝ **不送該欄位**，退路（改用 `ShortText` 存數值字串）
  **不需要動用**。
- **`MultipleSelection` 只給封閉值域**：`actions_taken` 的值來自 `config/categories.ts`，
  選項在 setup 時一併建立。
- **`operators`／`cited_sops` 用 `LongText`**：✅ 實測可原樣往返 JSON 陣列字串（`006-E6`）。
  ⚠️ **選它的理由已於 2026-09-03 更換**：原本是怕開放值域的值被 `MultipleSelection` 丟棄，
  但實測顯示**平台會照收**選項清單外的值（`006-E5`）。仍然用 `LongText` 的新理由是：
  改用 `MultipleSelection` 會讓每個新的客服 id／SOP id 都被記進該欄位的**選項清單**，
  清單隨資料無限成長 —— 那是把 schema 當資料用。

### ⚠️ 欄位 id 的取得方式（`006-E2a`，本規格最危險的一條）

寫入用的是**欄位 id**，而它 **MUST 由 `boards.get()` 反查，MUST NOT 取 `createField()` 的回傳值**。

SDK 對 `createField()` 的註解逐字寫著「data-board returns the field directly (unlike legacy
backend which returned the full Board)」—— **那句是錯的**，它回的是**整個 board**，
`_id` 是 board id。照它實作的話，所有欄位會拿到同一把 id、寫入互相覆蓋，
而**平台照樣回 200**：只有最後一個欄位有值，其餘全 `null`，沒有任何錯誤訊息或型別錯誤。

⚠️ 另注意平台回應**一律包一層 `{ data: ... }`**，SDK 型別沒有反映。

### ⚠️ 選項的送法：`data: [{ value }]`，不是 `options`（2026-09-04 真實環境實測）

`npm run board:setup` 首跑時發現的第四條 SDK 落差，與上面三條同一個家族：

- SDK 的 `CreateFieldInput` 宣告的是 `options?: unknown[]` —— **平台不吃這個 key，
  而且是靜默忽略**：回 200、欄位建起來了、**就是沒有選項**。
- 正確的是 `data: [{ value: '…' }]`。物件的 key 是 **`value`**；
  送 `{ name }` 或 `{ name, color }` 會 400（`ZodError: expected string, path data.N.value`）。
- 這樣建立的欄位，`boards.get()` **會**回選項，放在 `data: [{ id, _id, value }]` 裡。

⚠️ **這一條同時訂正了 `spike:board-write`（29）留下的一個錯誤推論。**
那支 spike 送的是 `options`，回讀時讀不到選項，於是結論被寫成「平台不回選項」——
**真正的原因是它送錯 key，那個欄位根本沒有選項。**
兩者的差別很重要：前者會讓 `--verify` 的選項比對變成一項驗不了的事（B4 失效），
後者則是一個**修得掉**的落差。
症狀是「分類欄位在 Board 上是個沒有選項的下拉選單」，而寫入照樣成功
（實測平台會照收清單外的值，006-E5）—— 又一條不報錯的靜默失效。

✅ 2026-09-04 已於正式環境驗證：26 欄以 `data: [{ value }]` 建立後，
`npm run board:verify` 的選項比對通過（`optionMismatch` 與 `optionsEmpty` 皆為 0）。

⚠️ **本表與 `ARCHITECTURE.md` §13.3、`shared/types/copilot.ts` 的 `ClosureSummary` 是同一份事實的三個副本。**
依 FR-052 與 CLAUDE.md 的規則，改任一處 MUST 三處同步。驗法：

```bash
grep -n "period_origin\|period_sentiment_note" docs/ARCHITECTURE.md shared/types/copilot.ts \
  scripts/setup-closure-board.ts specs/006-closure-handoff-summary/contracts/closure-board-schema.md
#   → 四個檔案都要命中
```

---

## 3. setup script

`scripts/setup-closure-board.ts`，以 `clientForApiKey()` 執行
（`server/services/imbrace.ts` 該函式的註解逐字寫著「僅用於不需歸屬到特定客服的背景作業，
例如 Data Board schema setup script」—— 這是它唯一的正當用途）。

### 兩種模式

| 指令 | 行為 | 離開碼 |
|---|---|---|
| `npm run board:setup` | Board 不存在 → 建立；已存在 → 只補**缺少**的欄位 | 0 ／ 非 0 |
| `npm run board:verify` | 只比對、不寫入 | 齊全 0 ／ 有缺 **非 0** |

### 硬性規則

- **B1（FR-050）** 重複執行 MUST NOT 產生重複欄位、MUST NOT 變更既有資料。
  ⚠️ 實作方式是**先讀現有欄位、再算差集**，MUST NOT 無條件 `createField()`。
- **B2（FR-051）** `--verify` MUST **逐欄列出缺少的欄位名稱**並以非零離開。
  ⚠️ 只印「不通過」不夠 —— 缺哪一欄決定了報表哪一個維度是空的。
- **B3（FR-051）** 驗證 MUST 同時檢查**型別**，不只檢查名稱存在。
  ⚠️ 欄位存在但型別不對（例如 `sentiment_start` 被建成 ShortText）不會報錯，
  只會讓報表無法對它做數值統計 —— 與少建一欄的後果同級。
- **B4（FR-051）** 受控詞彙欄位的**選項**也 MUST 比對。
  ⚠️ **2026-09-03 訂正此條的理由**：原文寫「該值寫入會被平台丟棄」，**那是錯的** ——
  實測平台**會照收**選項清單外的值（`006-E5`），資料不會掉。
  真正的後果較輕但仍要修：該值不會成為 Board 上的正式選項，**報表的篩選器裡看不到它**。
- **B5** 成功時 MUST 印出 `IMBRACE_CLOSURE_BOARD_ID=<id>`，供貼進 `.env.local`。
- **B6（憲法 1.5）** MUST NOT 印出 API key 或任何 token。

---

## 4. `--verify` 的輸出形狀

```text
Board: AgentCopilot_ClosureSummary (bd_68c06c…)

✅ 24 個欄位齊全
❌ 缺少 2 個欄位：
   - period_origin        (SingleSelection)
   - period_sentiment_note (ShortText)
⚠️ 型別不符 1 個：
   - sentiment_trough     實際 ShortText，應為 Number
⚠️ 選項不符 1 個：
   - category             設定檔有「退款爭議」，Board 沒有

結果：不通過（缺 2、型別不符 1、選項不符 1）
```

離開碼非 0。⚠️ **這段輸出就是 SC-007 的驗收證據**：
「手動移除任一欄位後，驗證模式 100% 指出缺漏」。

---

## 5. 冪等寫入的 Board 端行為（憲法 5.3、FR-030）

```text
commit(draftId, content)
  │
  ├─① boards.search(boardId, { q: '<draftId>' })
  │     → **本地**逐字比對 draft_id（⚠️ filter 實測被靜默忽略，見 006-E7）
  │
  ├─② hits.length === 0 → createItem()
  │     hits.length === 1 → updateItem(hits[0]._id)      ← FR-030c：更新為當下內容
  │     hits.length >= 2  → updateItem(最早建立的那筆) ＋ 警告日誌
  │
  └─③ getItem(boardId, itemId) 回查
        找不到 或 draft_id 不符 → **失敗**（FR-031），MUST NOT 報成功
```

⚠️ **③ 不可省。** 平台不保證唯一鍵約束（實測 5 個 board，`uniqueSeen: 0`，
`out/09-board-field-types.json`），也就是說 200 不等於紀錄真的建立了 ——
而「畫面顯示成功、Board 上其實沒有」不會報錯。

⚠️ **同一通對話有多筆結案紀錄是正常的**（憲法 5.3 的兩種成因）。
① 與 ② 比對的 MUST 是 `draft_id`，**MUST NOT 是 `conversation_id`** ——
用後者會在「不同時間的多次服務」銷毀服務歷史，在「多位客服各自結案」洗掉同事的工作成果。

⚠️ **① 的本地比對 MUST NOT 省略。** `q` 是全文檢索、不是精確比對，
省掉本地比對等於「隨便抓一筆看起來像的」去 `updateItem` —— 改到的是別人的結案紀錄，
而且不會報錯。

⚠️ 整條路徑 MUST 有 **30 秒硬逾時**（FR-032a）：它是「寫入中不可取消」的成立前提。
