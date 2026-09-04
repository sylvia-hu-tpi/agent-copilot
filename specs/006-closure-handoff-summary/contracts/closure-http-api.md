# 契約：結案流程的三支 BFF 端點

**Spec**: [../spec.md](../spec.md) ｜ **Date**: 2026-09-03

> 三支端點**全部無狀態**：草稿只活在瀏覽器分頁裡（FR-040、data-model §0）。
> 這份契約的每一條規則，幾乎都是在防同一類事故 —— **不報錯但做錯事**。

---

## 0. 共通

| 項目 | 規則 |
|---|---|
| 路徑前綴 | `/api/conversations/[id]/closure/…` |
| 認證 | 沿用既有 session cookie；**寫入以客服自己的 token 執行**（憲法 1.3） |
| 權限 | 沿用既有 JOIN 判定，**不新增權限模型**（FR「未曾 JOIN 過的人按下結案」、憲法 7.6） |
| 錯誤形狀 | 沿用既有 `createError({ statusCode, statusMessage, data })` |
| 憑證 | 任何回應與錯誤訊息 **MUST NOT** 含 token／API key（FR-035）。`npm run smoke` 逐一掃描 |
| SSE | **不新增任何事件型別**（research #17） |

---

## 1. `POST /api/conversations/[id]/closure/scopes`

取得涵蓋區間的候選清單。**面板開啟時呼叫一次**；重試時再呼叫。

### Request

```jsonc
{}   // 無 body。conversationId 取自路徑
```

### Response 200

```jsonc
{
  "candidates": [
    {
      "start": "2026-09-02T14:30:00.000Z",
      "origin": "closure",
      "messageCount": 25,
      "truncated": false,
      "label": { "category": "發票補寄", "reviewedByName": "林佩君",
                 "closedAt": "2026-09-02T14:30:00.000Z" }
    }
    // …最多 5 筆，時間降冪…
  ],
  "fallback": {                       // 「從第一則對話起算」，永遠存在、永遠墊底
    "start": "2026-03-06T09:12:00.000Z",
    "origin": "first",
    "messageCount": 398,
    "truncated": false
  },
  "overflowCount": 3,                 // 未列出的更早結案筆數；0 代表沒有
  "defaultIndex": 0,                  // 預設選中的候選索引；-1 代表落到 fallback
  "firstMessageAt": "2026-03-06T09:12:00.000Z",  // 自訂起算時間的可選下界
  "baselineAt": "2026-09-03T10:15:00.000Z",      // 面板開啟時刻，FR-034 用
  "closureBaseline": ["rec_a1", "rec_b2"]        // 此刻已存在的紀錄 id，FR-034 用
}
```

### 硬性規則

- **R1.1（FR-021b）** `candidates` MUST 時間降冪；`fallback` MUST 是獨立欄位而非陣列最後一筆 ——
  分開才不會有「排序寫錯就把安全網排到中間」的可能。
- **R1.2（FR-021d）** `defaultIndex` MUST 指向**最上面 `messageCount > 0`** 的候選；
  全部為 0 時回 `-1`（落到 `fallback`）。⚠️ MUST NOT 單純回 `0`。
- **R1.3（FR-021c、data-model §1）** 每個候選 MUST 帶 `messageCount`；
  掃描上限（500）內數不完時 `messageCount: null` ＋ `truncated: true`。
  ⚠️ **`null` MUST NOT 序列化成 `0`** —— 0 則的候選不可選，而數不完的候選可選。
- **R1.4（FR-021h）** 查詢失敗時 MUST 回 **502**，**MUST NOT** 回一個只有 `fallback` 的 200。
  「Board 查不到」與「這個對話從未結案」在畫面上是完全不同的兩件事，
  前者要重試按鈕、後者要「預設從第一則起算」的告知（FR-021e）。
  ⚠️ 用 200 帶空陣列表達失敗，會讓長期客戶的報告安靜地涵蓋整個聊天室歷史。
- **R1.5（FR-034）** `baselineAt` 與 `closureBaseline` 由前端原樣保存並在 commit 時帶回。
  server 端**不記** —— 記了就等於 server 端存了結案流程的狀態（data-model §0）。
- **R1.6（research #9，2026-09-03 實測）** 候選的過濾與排序 **MUST 在 server 端本地做**，
  **MUST NOT** 依賴 `boards.search()` 的 `filter` 或 `sort`：
  - `filter` 實測**被靜默忽略**（回整批、不報錯）→ 用 `q: '<conversationId>'` 粗篩後
    **逐字比對 `conversation_id`**。
  - `sort` 實測**欄位被忽略**（拿不存在的欄位排會得到相同順序），實際依建立時間排 →
    **本地依 `closed_at` 降冪**。
  - `overflowCount` **MUST** 由本地比對後的筆數算出，**MUST NOT** 用 `estimatedTotalHits`
    （那是 `q` 的命中數，不是該對話的結案紀錄數）。
  ⚠️ `sort` 這條特別容易漏：結案紀錄的建立順序**通常**等於 `closed_at` 順序，
  要到有人補登或時鐘不同步才分岔 —— 屆時客服拿到排錯的候選而畫面上看不出來。

---

## 2. `POST /api/conversations/[id]/closure/draft`

以指定區間取快照並產生草稿。**改區間、按「重新產生」都呼叫這一支。**

### Request

```jsonc
{
  "periodStart": "2026-09-02T14:30:00.000Z",
  "periodOrigin": "closure"          // 'closure' | 'first' | 'custom'
}
```

⚠️ **MUST NOT 接受任何訊息內容**（research #11）。前端只說「從哪裡起算」，
訊息一律由 server 自己取 —— 讓前端送內容等於開一條可竄改送給 AI 的對話內容的路。

### Response 200

`ClosureDraft`（見 data-model §2）。`draftId` **由本端點以 `crypto.randomUUID()` 產生**。

### 硬性規則

- **R2.1（FR-020）** 訊息快照 MUST 在**本次請求內**取得。
  每次呼叫 ＝ 一次新快照 ＝ 一個新 `draftId`。
- **R2.2（FR-021g）** 改區間時前端 MUST 呼叫本端點，MUST NOT 沿用舊草稿的內容。
  ⚠️ 由前端保證；server 端無從分辨。因此前端的 store 在 `periodStart` 變更時
  MUST 先把 `draft` 清空再發請求 —— 保留舊內容會讓改區間期間畫面上顯示的是舊區間的摘要。
- **R2.3（FR-022、FR-022a）** `readonly.sentiment*` MUST 只由**區間內**的
  `CopilotAnalysisState.sentimentBlock.timeline` 的 point 算出。
  ⚠️ **MUST NOT 讀 `sentimentBlock.stats.lowestScore`** —— 那是整條時間軸的最低點。
- **R2.4（FR-022b）** 區間起點未被 timeline 涵蓋時，三個數值 MUST 一起為 `null`
  且 `sentimentNote` MUST 有值。三者部分有值是實作錯誤。
- **R2.5（FR-015、憲法 4.6）** 模型回的受控詞彙不在 `config/categories.ts` 白名單內時，
  **該欄位留空**（空字串／空陣列），MUST NOT 寫入模型自由生成的值。
- **R2.6（FR-046）** 產生失敗 MUST 回 **502**，MUST NOT 回一份欄位全空的 200。
- **R2.7（憲法 4.3）** `citedSopIds` MUST 經白名單後驗；不在檢索命中內者丟棄該 id。
- **R2.8（憲法 1.5）** 錯誤訊息與日誌 MUST NOT 含訊息全文。
- **R2.9（FR-046a、SC-004）** 本端點**不設固定秒數上限** —— 耗時由涵蓋區間長度決定
  （實測短區間中位數 9.4 秒，長區間逾 1 分鐘可接受）。
  對應地，前端在等待期間 MUST 誠實：MUST NOT 顯示會過期的時間承諾、
  MUST NOT 在完成前顯示完成訊號、**MUST 全程可取消**（FR-040a）。
  ⚠️ 取消 MUST 真的中止在途的 AI 呼叫（比照 `server/services/blocks/suggestion.ts` 的
  `tailAbort`），MUST NOT 只是把畫面關掉 —— 後者的呼叫照送、錢照付、結果無人看，且不會報錯。

---

## 3. `POST /api/conversations/[id]/closure/commit`

寫入 Data Board。**本規格唯一會寫入正式紀錄的端點。**

### Request

```jsonc
{
  "draftId": "…",
  "periodStart": "…", "periodOrigin": "closure", "periodMessageCount": 25,
  "summary": "…", "intent": "…", "category": "…",
  "resolution": "resolved", "actionsTaken": ["…"],
  "sentimentOutcome": "appeased", "citedSopIds": ["…"], "followUps": [],
  "baselineAt": "…", "closureBaseline": ["rec_a1"]
}
```

### Response 200

```jsonc
{
  "recordId": "rec_c3",
  "reviewedBy": "u_…", "reviewedAt": "2026-09-03T10:22:31.000Z",
  "created": true,                    // false ＝ 命中既有草稿紀錄，走 update（FR-030c）
  "reqId": "8f2c-41",                 // FR-035a：三步寫入在日誌裡的串接鍵，畫面 meta 列顯示
  "newClosuresSincePanelOpen": [      // FR-034，可能為空陣列
    { "operatorName": "林佩君", "closedAt": "2026-09-03T10:20:00.000Z" }
  ]
}
```

### 硬性規則

- **R3.1（FR-011、憲法 5.1）** 本端點 **MUST 只由客服明確按下寫入時呼叫**。
  MUST NOT 有任何自動觸發路徑（閒置逾時、離開、產生完成皆不可）。
  ⚠️ 這條無法由 server 端保證，因此 `test/contract-guards.test.ts` MUST 掃描：
  除了寫入按鈕的處理函式外，前端不得有第二處呼叫此端點。
- **R3.2（FR-012）** 寫入內容 MUST 是 request body 帶來的（＝客服編輯後的）版本。
- **R3.3（FR-020）** 本端點 **MUST NOT 接觸任何訊息取數路徑**（research #11）。
  ⚠️ 契約守衛掃描本檔不得 import／呼叫訊息取數。
  這是「快照被實作成送出時取最新」那條路徑唯一會紅的地方。
- **R3.4（FR-030、FR-030c、憲法 5.3）** 順序固定為
  `search(draft_id)` → `create` 或 `update` → `getItem` 回查。
  命中 ≥ 2 筆時取**最早建立**的那一筆更新，並記一行警告日誌。
- **R3.5（FR-031）** 回查不到 MUST 當作**失敗**（502），MUST NOT 因為寫入回了 200 就報成功。
- **R3.6（FR-013）** `reviewed_by`／`reviewed_at` **由 server 依 session 填**，
  MUST NOT 取自 request body —— 從 body 取等於讓稽核欄位可偽造。
- **R3.7（FR-010a）** `operators`／`joinedAt`／`sentiment*`／`channel`／`contactId`
  **由 server 重新計算**，request body 帶來的一律忽略。
  ⚠️ 這是唯讀欄位「真的唯讀」的實作方式 —— 只靠前端 disabled 是擋不住的，
  而被改掉之後 SC-006b 的重算驗證會永遠對不起來。
- **R3.8（FR-032）** 任何失敗 MUST 回非 2xx。前端據此保留草稿、不關面板、不離開對話。
- **R3.9（FR-033）** 本端點 **MUST NOT** 呼叫 LEAVE，也 MUST NOT 變更平台對話狀態。
  LEAVE 由前端在收到 200 之後另外呼叫既有的 `/leave`。
  ⚠️ 串在一起的話，LEAVE 失敗就無從表達「紀錄已寫入、只是還沒離開」那個狀態。
- **R3.10（FR-034）** `newClosuresSincePanelOpen` 只列 `closureBaseline` 中**沒有**的紀錄。
  ⚠️ 它是**告知**不是攔截：即使非空，紀錄仍 MUST 照常寫入並回 200。
  面板開啟當下就存在的結案 MUST NOT 出現在這裡 —— 客服在候選清單上已經看過一次了。
- **R3.11（FR-035）** 錯誤訊息 MUST NOT 洩漏憑證。
- **R3.14（FR-035a）** MUST 於請求進入時產生 `reqId`，三步各記一行日誌帶著它，
  並在**成功與失敗**的回應中都回傳（失敗時放進 `data`）。
  ⚠️ MUST NOT 只在出錯時產生 —— 那樣看不到出錯之前的兩步，而 B8 要判斷的正是那兩步。
- **R3.15（FR-032c）** 失敗回應 MUST 讓前端分得出**兩種呈現**：
  `data.failKind: 'failed' | 'unverified'`。`unverified` 專指「寫入回 200 但回查不存在」，
  其餘（逾時、4xx、5xx）一律 `failed`。
  ⚠️ **兩者的狀態機出口相同**（前端一律回 `ready` ＋ 保留草稿），差異只在文案與按鈕 ——
  前端 MUST NOT 為此開第二條狀態路徑。
- **R3.12（FR-032a）** 本端點 MUST 有 **30 秒硬逾時**（涵蓋三步的總和），逾時依 R3.8 回非 2xx。
  ⚠️ **這是 FR-040a「寫入中不可取消」的成立前提。** 兩者 MUST 一起實作 ——
  只做「不可取消」而沒有上界，客服會被困在一個既不能取消、也不會自己結束的狀態裡。
  ⚠️ 這個門檻 **MUST NOT 被 SC-004 的「不設固定秒數」波及**：那條講的是摘要產生
  （工作量隨區間變動），寫入的工作量固定為三次呼叫，正是該有門檻的那一類。
- **R3.13（research #8，2026-09-03 實測）** 冪等查詢 **MUST NOT** 用 `filter`（實測被靜默忽略），
  改為 `q: '<draftId>'` **＋ 本地逐字比對 `draft_id`**。
  ⚠️ **本地比對 MUST NOT 省略**：`q` 是全文檢索不是精確比對，少了它，
  「查有既有紀錄」會退化成「隨便抓一筆看起來像的」，接著 `updateItem` 會去改到
  **別人的結案紀錄** —— 不報錯，而且被改掉的是同事的工作成果。

---

## 4. 四種失敗形態的對照（US3、SC-003）

| 形態 | server 行為 | HTTP | `failKind` | 前端呈現 |
|---|---|---|---|---|
| 逾時（30 秒，R3.12） | 不重試（客服自己決定要不要重按） | 504 | `failed` | 畫布 **B7**「寫入 CRM 失敗」 |
| 平台 4xx | 原樣轉為失敗，訊息去識別化 | 502 | `failed` | 同上 |
| 平台 5xx | 同上 | 502 | `failed` | 同上 |
| 200 但回查不存在 | **當作失敗**（R3.5） | 502 | **`unverified`** | 畫布 **B8**「寫入結果無法確認」 |

⚠️ 四種在前端 MUST 走**同一個狀態機出口**（回 `ready`、草稿逐欄保留、面板不關、不離開對話）。
`failKind` 只切換**文案與按鈕**，MUST NOT 切換狀態 —— 開第二條路徑就會有一條被漏掉，而漏掉的那條會顯示成功。

⚠️ **`unverified` 的呈現與其他三種刻意不同**，因為客服該做的事不同：
其餘三種可直接重試；`unverified` 代表平台說寫成功了，MUST 先請客服到 CRM 查驗
（畫布把這一步綁進主鈕文字：「已確認沒有，重試寫入」）。

---

## 5. 驗法（可執行）

```bash
# R3.3：寫入端點不得接觸訊息取數
grep -n "messages\|fetchLatest\|fetchSince" server/api/conversations/\[id\]/closure/commit.post.ts
#   → 必須零結果

# R2.3：草稿端點不得讀整條時間軸的最低點
grep -n "lowestScore" server/services/closure/*.ts
#   → 必須零結果

# FR-040：結案狀態不得持久化
grep -n "localStorage" app/stores/closure.ts
#   → 必須零結果

# R1.6／R3.13：不得依賴平台的 filter／sort（兩者實測皆被靜默忽略）
grep -rn "filter:\|sort:" server/services/closure/
#   → 必須零結果（要過濾與排序，一律本地做）

# 憲法 1.2：SDK 不得離開 server/
grep -rn "@imbrace/sdk" app/ shared/
#   → 必須零結果（既有守衛，本規格不得破壞）
```
