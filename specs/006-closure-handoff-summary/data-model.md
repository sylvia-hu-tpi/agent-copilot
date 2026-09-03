# Phase 1 資料模型：結案摘要與人審面板

**Spec**: [spec.md](./spec.md) ｜ **Research**: [research.md](./research.md) ｜ **Date**: 2026-09-03

> 本規格有**四個實體**，分別住在四個生命週期完全不同的地方。
> 把它們畫在同一張表上是最容易犯的錯 —— 下面第 0 節先把「誰住哪裡」定死，
> 因為後面每一條規則都是從這張表推出來的。

## 0. 四個實體與它們的住所

| 實體 | 住在哪 | 生命週期 | 誰看得到 |
|---|---|---|---|
| **涵蓋區間** `ClosurePeriod` | 隨草稿與紀錄各存一份 | 隨其宿主 | — |
| **結案摘要草稿** `ClosureDraft` | **瀏覽器分頁的 Pinia store** | 開面板 → 寫入成功／取消／重新整理 | 只有這個分頁 |
| **正式結案紀錄** `ClosureSummary` | **Data Board** | 永久 | 全組織 |
| **受控詞彙** | `config/categories.ts`（版本控制內） | 隨 repo | 全部 |

⚠️ **草稿 MUST NOT 出現在 server 端的任何儲存**（`StateStore`、process-local Map、
`CopilotAnalysisState` 都不行）。三支端點全部無狀態：草稿的唯一持有者是那個分頁。
這不是效能取捨，是 FR-040 的實作方式 —— 只要 server 端存了一份，
「重新整理等同取消」就得靠**額外的清理邏輯**成立，而那條邏輯漏掉時不會報錯。

⚠️ **草稿與 `SummaryBlock`／`SentimentBlock`／`SuggestionBlock` 是不同家族。**
那三個由分析管線產生、經 SSE 推播、存在 `CopilotAnalysisState` 裡。
結案草稿一項都不是。**MUST NOT 為了「一致性」把它加進 `CopilotAnalysisState`** ——
那三個 Block 的 SSE 事件送的是整個 Block，加進去就會把草稿推播給每一條連線，
而型別檢查不會響（`failedBatches`／`sentimentGap` 兩次踩過同一顆地雷，
`test/contract-guards.test.ts` 有對應守衛）。

---

## 1. `ClosurePeriod` —— 涵蓋區間

新增於 `shared/types/copilot.ts`。

```ts
/** 這一份結案報告描述的那一段服務（§13.4 ④、FR-021 系列） */
export interface ClosurePeriod {
  /** 區間起點的時間戳（ISO8601）。實際起點是「此時點之後的第一則訊息」 */
  start: string
  /**
   * 這個 start 是怎麼來的 —— ⚠️ 光靠 `start` 這個時間戳事後分不出來，
   * 而「客服選了某次結案」與「客服自己打了一個時間」是完全不同的兩件事（FR-021e-1）。
   */
  origin: 'closure' | 'first' | 'custom'
  /** 區間內的訊息則數。⚠️ 掃描上限（500）內數得完才有值；數不完為 null，見下方「則數的三種值」 */
  messageCount: number | null
  /** 掃描上限截斷時為 true —— UI 逐字呈現「超過 500 則」（憲法 4.5：不猜） */
  truncated: boolean
}
```

### 則數的三種值 —— 三者 MUST 可區分

| `messageCount` | `truncated` | 意義 | UI 逐字 |
|---|---|---|---|
| `0` | `false` | 這個候選之後真的沒有新訊息 | 「0 則」，該列**不可選**（畫布 §7.5） |
| `n > 0` | `false` | 確切則數 | 「{n} 則」，`n > 150` 轉 `--warn` 色 |
| `null` | `true` | 超過掃描上限，數不完 | 「超過 500 則」 |

⚠️ **`null` MUST NOT 被當成 0**。0 則的候選不可選（FR-021d 的預設跳過），
數不完的候選則是**可選且通常是客服真正要的那一個**（長期客戶的「從第一則起算」）。
兩者混淆會讓長期客戶完全結不了案，而畫面上只會顯示一個灰掉的選項。

---

## 2. `ClosureDraft` —— 結案摘要草稿

新增於 `shared/types/copilot.ts`。這是**人審的標的**，也是**冪等寫入的單位**（憲法 5.3）。

```ts
export interface ClosureDraft {
  /**
   * 冪等鍵。**由 server 在產生草稿時以 `crypto.randomUUID()` 產生**，前端只負責帶回來。
   *
   * ⚠️ 「重新產生」MUST 得到新的 `draftId`（那是一份新草稿，US2 AC#2）；
   *    「寫入逾時後重試」MUST 沿用同一個（那是同一份草稿，US2 AC#1）。
   *    兩者的差別完全由 draftId 承載 —— 前端若自己產生，這條規則就散在前端各處。
   */
  draftId: string
  conversationId: string
  period: ClosurePeriod

  // ── 可編輯欄位（FR-010a）────────────────────────────────────
  summary: string
  intent: string
  category: string                  // 受控詞彙，白名單選擇
  resolution: ClosureResolution     // 受控詞彙
  actionsTaken: string[]            // 受控詞彙（多選）
  sentimentOutcome: ClosureSentimentOutcome  // 受控詞彙
  citedSopIds: string[]
  followUps: Array<{ action: string, owner?: string, dueHint?: string }>

  // ── 唯讀欄位（FR-010a）——由系統計算，客服 MUST NOT 能改 ──
  readonly: ClosureDraftReadonly
}

/**
 * ⚠️ **唯讀欄位刻意收在一個巢狀物件裡，不與可編輯欄位平鋪。**
 *    平鋪的話，「哪些可改」只存在於 UI 元件的判斷式裡 —— 少寫一個 disabled
 *    不會報錯，只會讓客服改掉一個他不該改的值，而 SC-006b 的重算驗證
 *    從此永遠對不起來（FR-010a 逐字點名這個後果）。
 *    收成一個物件後，寫入端點只要「整個 readonly 重新由 server 算」即可，
 *    前端送什麼都不影響結果。
 */
export interface ClosureDraftReadonly {
  operators: string[]
  joinedAt: string
  closedAt: string | null           // 寫入當下才有值
  /** 三者同區間（FR-022）；區間內評分點不齊時**三個一起**為 null（FR-022b） */
  sentimentStart: number | null
  sentimentEnd: number | null
  sentimentTrough: number | null
  /** 情緒留空的原因與實際涵蓋範圍（FR-022b）。有值即代表上面三個是 null */
  sentimentNote: string | null
  channel: string
  contactId: string
  confidence: number | null
}
```

### 驗證規則

| 欄位 | 規則 | 違反時 |
|---|---|---|
| `category`／`resolution`／`actionsTaken`／`sentimentOutcome` | MUST ∈ `config/categories.ts` 的白名單 | 模型給的值不在白名單 → **該欄位留空**並要求客服選擇（憲法 4.6、FR-015）。MUST NOT 寫入模型自由生成的值 |
| `summary`／`intent` | 非空字串 | 模型回空 → 整份草稿視為產生失敗（FR-046），比照 `ConversationSummary` 的 `intent.min(1)` |
| `citedSopIds` | 白名單後驗（憲法 4.3） | 不在檢索命中內者**丟棄該 id**，不丟棄整份草稿 |
| `sentimentStart/End/Trough` | 三者**同時**有值或**同時**為 null | 只有部分有值 → 視為實作錯誤，三者一律轉 null 並填 `sentimentNote` |
| `followUps[].action` | 非空字串 | 丟棄該筆 |

⚠️ **AI 產出經 Zod 驗證後才進入系統（憲法 4.2）**，schema 落在
`server/services/ai/schemas.ts`（與既有三個 schema 同一處，不另開檔案）。

---

## 3. `ClosureSummary` —— 正式結案紀錄

已定義於 `docs/ARCHITECTURE.md` §11.5（尚未落到程式碼）。本規格落地時 **MUST 一併新增 `periodOrigin` 一欄**（research #21）。

```ts
export interface ClosureSummary {
  recordId: string
  draftId: string
  conversationId: string          // ⚠️ 可重複的索引，不是唯一鍵
  periodStart: string
  periodMessageCount: number
  periodOrigin: 'closure' | 'first' | 'custom'   // 🆕 本規格新增
  channel: string
  contactId: string
  operators: string[]
  joinedAt: string
  closedAt: string
  summary: string
  intent: string
  category: string
  resolution: 'resolved' | 'workaround' | 'escalated' | 'unresolved' | 'customer_abandoned'
  actionsTaken: string[]
  sentimentOutcome: 'appeased' | 'satisfied' | 'still_negative' | 'escalated'
  sentimentStart: number
  sentimentEnd: number
  sentimentTrough: number
  citedSopIds: string[]
  followUps: Array<{ action: string, owner?: string, dueHint?: string }>
  confidence: number
  reviewedBy: string | null
  reviewedAt: string | null
}
```

⚠️ **§11.5 現行的三個 `sentiment*: number` 與 `confidence: number` 落地時 MUST 改為 `number | null`**
—— FR-022b 要求留空，而非 nullable 的型別會逼實作者填 0，正是該條禁止的事。
這是本規格對 §11.5 的第二筆訂正（第一筆是 `periodOrigin`）。

### 冪等的三種情形（憲法 5.3、FR-030）

| 情形 | 同一個 `draftId`？ | Board 上的筆數 | 處置 |
|---|---|---|---|
| 寫入逾時後客服重按 | ✅ 是 | **恰好 1** | `search` 命中 → `updateItem` 為**當下**草稿內容（FR-030c） |
| 客服按「重新產生」後才寫入 | ❌ 否（新草稿） | **1**（舊草稿從未寫入） | 一般 `createItem` |
| 同一對話的第 N 次服務／同事各自結案 | ❌ 否 | **各自 1、並存** | 一般 `createItem`，MUST NOT 互相覆蓋 |

---

## 4. 既有形狀的修改

### 4.1 `PresenceEntry` 加一個布林（research #18，FR-045 SHOULD）

```ts
export interface PresenceEntry {
  operatorId: string
  operatorName: string
  state: PresenceState        // ⚠️ 維持三值不動
  joined: boolean
  closing: boolean            // 🆕「正在結案」
  source: PresenceSource
  at: string
}
```

⚠️ **MUST NOT 做成 `PresenceState` 的第四個值。** 理由與 `joined` 為什麼不併進 `state`
完全相同（該欄位的既有註解逐字記錄過）：結案期間打一個字，`composing` 會把 `closing` 蓋掉。

### 4.2 `AIProvider` 加一個方法（research #1）

```ts
export interface AIProvider {
  // …既有四個方法不動…
  /**
   * 結案摘要（`AgentCopilot_結案摘要_agent`）。
   *
   * ⚠️ `history` 是**涵蓋區間內的訊息**，不是全對話 —— 呼叫端已依 `period` 切好。
   *    傳全對話會讓摘要涵蓋前幾輪服務，而那不會報錯（FR-021、§13.4 ④）。
   * ⚠️ `vocabulary` 由呼叫端傳入，agent 只能從中選擇；後端另有白名單後驗（憲法 4.6）。
   */
  summarizeClosure(input: {
    history: Message[]
    vocabulary: { categories: readonly string[], resolutions: readonly string[],
                  actionsTaken: readonly string[], sentimentOutcomes: readonly string[] }
    knowledgeHits: KnowledgeHit[]
  }): Promise<ClosureDraftAiPart>
}
```

`ClosureDraftAiPart` ＝ `ClosureDraft` 去掉 `draftId`／`conversationId`／`period`／`readonly`
—— **模型只產內容欄位**，其餘一律由系統填（比照 `analyzeSentiment()` 不信任模型給的
`messageId`／`at`、`suggest()` 不信任模型給的 `id`，是同一條既有原則）。

### 4.3 `config/categories.ts`（research #19）

```ts
export const CATEGORIES = [ /* … */ ] as const
export const RESOLUTIONS = ['resolved', 'workaround', 'escalated',
                            'unresolved', 'customer_abandoned'] as const
export const ACTIONS_TAKEN = [ /* … */ ] as const
export const SENTIMENT_OUTCOMES = ['appeased', 'satisfied',
                                   'still_negative', 'escalated'] as const

// ⚠️ 這兩行是本檔存在的一半理由 —— 設定檔與型別分岔時 typecheck 就會紅
const _r: readonly ClosureSummary['resolution'][] = RESOLUTIONS
const _s: readonly ClosureSummary['sentimentOutcome'][] = SENTIMENT_OUTCOMES
```

---

## 5. 狀態機：結案流程（前端）

```
                    ┌──────────────────────────────────────┐
   （未進入結案）───▶│ loadingScopes  候選查詢＋則數掃描中    │
        ▲           └───────┬──────────────────────┬───────┘
        │                   │成功                  │失敗
        │                   ▼                      ▼
        │           ┌───────────────┐      ┌───────────────┐
        │           │ generating    │      │ scopesError   │──重試─┐
        │           │ AI 產生草稿中  │      │（不產生草稿）  │◀──────┘
        │           └──┬─────────┬──┘      └───────┬───────┘
        │              │成功      │失敗            │取消
        │              ▼         ▼                 │
        │        ┌──────────┐ ┌────────────┐       │
        │        │  ready   │ │ draftError │─重試─┐│
        │        │ 可編輯    │ │（不呈現空白）│◀─────┘│
        │        └──┬────┬──┘ └──────┬─────┘       │
        │  改區間／  │    │按下寫入    │取消          │
        │  重新產生  │    ▼           │             │
        │           │  ┌──────────┐   │             │
        │           │  │ writing  │   │             │
        │           │  └──┬────┬──┘   │             │
        │           │     │成功 │失敗  │             │
        │           │     │    ▼      │             │
        │           │     │  回到 ready ＋ 失敗提示   │
        │           │     │  （草稿原封不動，FR-032）│
        │           │     ▼                        │
        │           │  ┌──────────────┐            │
        └───────────┴──│ leaving → 完成 │            │
                       └──────┬───────┘            │
                              │LEAVE 失敗           │
                              ▼                    │
                    ┌────────────────────┐         │
                    │ writtenLeaveFailed │         │
                    │ 結案已完成、區塊消失 │         │
                    │ 頂端橫幅可重試離開   │         │
                    └────────────────────┘         │
                                                   ▼
                                            （回到未進入結案）
```

### 每個狀態的硬性規則

| 狀態 | MUST | MUST NOT |
|---|---|---|
| `loadingScopes` | 面板已出現、置頂 | 產生草稿 |
| `scopesError` | 顯示「無法載入結案紀錄」＋重試（FR-021h） | 以任何預設區間頂替、產生草稿 |
| `generating` | 顯示進行中 | 自動寫入 |
| `draftError` | 顯示錯誤＋重試（FR-046） | 呈現空白草稿 |
| `ready` | 輸入框不鎖、常駐橫幅在、分析照常跑 | 自動更新摘要（新訊息只顯示過期標記，FR-020／FR-044） |
| `writing` | 兩顆按鈕鎖住 | 離開對話 |
| `writtenLeaveFailed` | 第 6 區塊**已消失**（FR-047b）、頂端橫幅可重試離開 | 回退結案、把已寫入的紀錄變成孤兒（FR-033） |

⚠️ **沒有 `writeFailed` 這個狀態** —— 寫入失敗一律回到 `ready` 並掛一則錯誤（FR-032：
草稿原封不動、面板不關、不離開對話）。做成獨立狀態的話，「草稿還在不在」
就變成兩個狀態各自維護的事，而漏掉一邊不會報錯。

⚠️ **`ready` 是唯一能按下寫入的狀態。** 任何「按下結案／摘要產生完成／閒置逾時就寫入」
的路徑都違反 FR-011 —— 這是憲法第五條的落點，也是本規格的存在理由。
