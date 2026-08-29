# Data Model: 建議卡的漸進式知識庫引用

**Feature**: `004-progressive-citations` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

本功能**不新增實體**，只在 `SuggestionBlock`（`shared/types/copilot.ts`，002 data-model.md §1.1）
上加三個欄位，並新增一份 server-only 的執行期狀態。`SuggestionCard` 一字不改。

## 1. `SuggestionBlock` 擴充

```ts
export interface SuggestionBlock {
  status: AnalysisBlockStatus            // 不變：empty / analyzing / retrying / ready / error
  retryAttempt?: number                  // 不變
  firstFailureAt?: string                // 不變
  cards: SuggestionCard[]                // 不變
  knowledgeSearch: { ran: boolean, hitCount: number }   // 不變（語意見 §3）
  updatedAt: string                      // 不變

  /**
   * 知識庫引用狀態（004 FR-002／FR-003／Key Entities）。與 `status` 正交：
   *   - 'pending' → 第一段已顯示，第二段仍在等檢索（最多 30 秒）＋生成（最多 20 秒）
   *   - 'cited'   → 這批卡是**餵入命中結果**生成的（第二段，或背景／命中已在手的單段）。
   *                 個別卡片仍可能 sopId 為 null（模型判斷該卡不需引用），以卡片的 sopTitle 分辨
   *   - 'none'    → 最終狀態：檢索無命中、失敗、逾時，或第二段失敗／全數遭白名單捨棄。
   *                 cards 維持第一段內容（FR-003）
   * 初始（empty／首次 analyzing）為 'none'——尚無卡片時這個欄位沒有語意，取不會誤導的值。
   */
  citation: 'pending' | 'cited' | 'none'

  /**
   * 這批卡依據到哪一則客戶訊息（`batchAnchor()`，與 `ConversationSummary.basedOnMessageId` 同語意）。
   * ⚠️ **僅供稽核與 UI**；第二段的過期判定用執行期的世代計數（research.md #2），MUST NOT 拿這個
   *    欄位做控制——手動重試會用同一個錨點再跑一次，錨點比對會放行舊尾巴。
   */
  basedOnMessageId: string | null

  /**
   * FR-014／SC-005 的稽核證據：這批卡由哪一段產出、第一段自動重試了幾次。
   *   - 前景第一段落地：{ stage: 1, stage1RetryAttempt: n }
   *   - 第二段落地：    { stage: 2, stage1RetryAttempt: n }（沿用第一段的 n，讓「這批訊息總共呼叫幾次」
   *                      ＝ 1 + n + 1 可以從單一 block 讀出）
   *   - 背景／命中已在手的單段：{ stage: 2, stage1RetryAttempt: 0 }（沒有第一段）
   * 上限可驗證：前景每批最壞 1 + 2 + 1 = 4 次（004 FR-014）。
   */
  provenance: { stage: 1 | 2, stage1RetryAttempt: number }
}
```

`emptySuggestionBlock()`（`app/composables/useCopilotSession.ts`）與 `initialState()`
（`server/services/copilot-analysis.ts`）同步補上預設值：
`citation: 'none'`、`basedOnMessageId: null`、`provenance: { stage: 1, stage1RetryAttempt: 0 }`。

## 2. 狀態轉移

`status` 的五態機（002 data-model.md §7）**不變**。以下是 `citation` 疊在其上的轉移，
以前景兩段式為主線：

```
                     beginAnalyzing()
 (任何狀態) ──────────────────────────────▶ status: analyzing, citation: 保留不動（卡片若有則保留）
                                                    │
                          第一段落地（白名單後）     │            第一段 withRetry 用盡
                     ┌──────────────────────────────┴───────────────────────────┐
                     ▼                                                          ▼
   status: ready, citation: 'pending', provenance.stage=1            status: error（既有路徑）
                     │                                                          │ 客服按重試 →
     ┌───────────────┼──────────────────────────┐                               │ 新世代；若命中已在手
     │               │                          │                               │ 走單段（research #3）
     ▼               ▼                          ▼                               ▼
  檢索 hits>0     檢索 0 筆／失敗／30s 逾時    新世代啟動（新客戶發言、重試）    （回到上方）
  → 第二段單發       │                          │
     │               │                          └─▶ 舊尾巴：世代不符，丟棄；abort 未送出的呼叫
     ├─ 成功且有卡 ──┼──────────▶ status: ready, citation: 'cited', cards ← 第二段, provenance.stage=2
     │               │
     └─ 失敗／20s 逾時／全數捨棄 ─┴──▶ status: ready, citation: 'none', cards 不動, provenance 不動
```

**第一段仍在自動重試（status: retrying）時第二段先落地**（FR-006a）：
直接寫入 `ready / 'cited'`，並 abort `stage1Abort`；第一段若已在飛且之後落地，
以世代內的 `citedLanded` 旗標擋下不寫入。畫面從「重試中 (n/2)」直接變成帶引用的卡＋提示。

⚠️ **`beginAnalyzing()` MUST NOT 把 `citation` 重設為 `'none'`**（2026-08-29 `/speckit-analyze` 修訂，
原本此處寫的是「→ `citation: 'none'`」）。理由：`beginAnalyzing()` 的既有行為是 spread、**保留舊卡片**
（`{ ...state.suggestionBlock, status: 'analyzing' }`）。那些被保留下來、畫面上仍看得到的卡若是上一輪
第二段的產出，它們**確實有 SOP 依據**；把 `citation` 打回 `'none'` 會讓卡片來源列在新一輪期間顯示
「未引用知識庫」，客服讀到的標示與事實不符（SC-004）。因此程式碼**不需要任何改動**——既有的 spread
正是要的行為，本節原本的敘述才是錯的。新一輪的 `citation` 由該輪自己的第一段／第二段落地時覆寫。
（更新提示不受影響：消費端在收到 `status === 'analyzing'` 時即清除 `suggestionCitedAt`，見契約 §3。）

**不變量**（測試以此斷言）：
1. 同一世代內，`citation` 只會 `'pending' → 'cited'` 或 `'pending' → 'none'` 各一次，不會來回。
2. `citation: 'cited'` 的 block MUST NOT 被同世代的 `'pending'` 或 `'none'` 覆蓋。
3. `status: 'ready' && citation: 'pending'` 時 MUST 有卡片（`cards.length > 0`）——
   第一段白名單後若為空，仍 `'pending'`（第二段可能補上），UI 顯示「本次未產生建議」＋檢索中。
4. `knowledgeSearch.ran` 在建議卡路徑上恆為 `true`（憲法 6.2：兩段式仍每批發出一次檢索）。

## 3. `knowledgeSearch` 在兩段式下的語意

| 時點 | `knowledgeSearch` | `citation` |
|---|---|---|
| 第一段落地、檢索未回 | `{ ran: true, hitCount: 0 }`（檢索已送出＝已跑；命中數尚未知） | `'pending'` |
| 檢索回來 n>0，第二段成功 | `{ ran: true, hitCount: n }` | `'cited'` |
| 檢索回來 n>0，第二段失敗／全數捨棄 | `{ ran: true, hitCount: n }` | `'none'` ← **模型杜撰引用或第二段逾時的訊號**，日誌分辨 |
| 檢索 0 筆／失敗／逾時 | `{ ran: true, hitCount: 0 }` | `'none'` |

002 data-model.md §7 那張「`ready && cards.length === 0`」對照表維持有效；新增的 `citation` 只是讓
「`hitCount: 0`」在「還沒回來」與「回來是零」之間可分辨。

## 4. Server-only 執行期狀態：`suggestionTails`

```ts
// server/services/copilot-analysis.ts（模組層級，比照 analysisInFlight／backgroundInFlight）
interface SuggestionTail {
  generation: number                 // 每次 analyzeSuggestionsOnce() 啟動 +1
  stage1Abort: AbortController       // 第二段在「檢索有命中」時 abort()：擋第一段尚未送出的重試（FR-006a）
  tailAbort: AbortController         // 新世代啟動／cancelPendingAnalysis() 時 abort()：擋尚未送出的第二段呼叫
  citedLanded: boolean               // 第二段已寫入；同世代後到的第一段結果不得覆蓋（FR-006a）
  done: Promise<void>                // 尾巴結束（成功、放棄、丟棄皆算）；awaitSuggestionTail() 供測試
  lastRetrieval?: { anchor: string | null, hits: KnowledgeHit[], at: string }   // research.md #3 備忘
}
const suggestionTails = new Map<string /* conversationId */, SuggestionTail>()
```

⚠️ **兩個 controller MUST NOT 合併成一個**（2026-08-29 `/speckit-analyze` 修訂，原設計只有一個 `abort`）。
它們的觸發者與標的相反：`stage1Abort` 由**第二段自己**在成功路徑上觸發（檢索有命中時），標的是第一段；
`tailAbort` 由**外部**（新世代、LEAVE）觸發，標的是第二段。共用一個的後果是——第二段一開始就把它
abort 掉，之後 LEAVE 呼叫 `abort()` 完全是 no-op，第二段的 AI 呼叫照送、錢照付、結果無人看，
而**不會有任何錯誤**。第二段的 `withRetry` MUST 傳 `signal: tail.tailAbort.signal`，
且送出前 MUST 檢查 `tailAbort.signal.aborted`（已在飛的 HTTP 仍取消不了——SDK 未暴露 signal，
見 research.md #2；abort 能省下的是「還沒送出」的那一次）。

- **MUST NOT 進 `CopilotAnalysisState`**：它是控制流狀態，不是分析結果；進了 state 就會隨
  `suggestion.updated` 流到瀏覽器（`publishBlock()` 送整個 block），比照 003 對 `failedBatches`
  的處理原則（`test/contract-guards.test.ts` 契約 1.1）。新增守衛：`shared/` 不得出現 `suggestionTails`
  與 `citedLanded`。
- 生命週期：對話最後一個尾巴結束後仍保留（備忘要留給手動重試用），隨程序重啟消失；
  `cancelPendingAnalysis()`（003 FR-013，LEAVE 時）MUST ① `tailAbort.abort()`——沒有人 JOIN 的對話
  不該再花第二段的錢；② **`suggestionTails.delete(conversationId)`**。
  ⚠️ **②是 2026-08-29 `/speckit-analyze` 補上的**：原設計只寫「仍保留」而沒有任何刪除條件，
  這個 Map 會隨程序生命週期逐對話累積，且每筆帶著 `lastRetrieval.hits`（知識庫全文片段）——
  對照 `CopilotAnalysisState` 有 2 小時 sliding TTL，只有它沒有任何回收。刪除點選在 LEAVE 是因為
  備忘的唯一用途是手動重試（FR-005），而 LEAVE 之後沒有人能按重試，備忘從那一刻起就沒有意義。
  殘留只剩「沒走 LEAVE 就斷線」的少數對話，隨程序重啟消失（單副本，憲法 9.2）。

## 5. `withRetry()` 選項擴充（`server/services/ai/retry-policy.ts`）

```ts
export interface WithRetryOptions {
  onRetry?: ...            // 不變
  callTimeoutMs?: number   // 不變
  budgetMs?: number        // 不變
  /** 最多自動重試次數；預設 2（001 FR-014）。第二段傳 0 —— 不重試是呼叫端的明示選擇 */
  maxRetries?: number
  /** 退避等待中或下一次呼叫送出前被 abort → 拋 RetryAbortedError；已在飛的呼叫不受影響 */
  signal?: AbortSignal
}
export class RetryAbortedError extends Error {}   // classifyFailure() 不處理它——呼叫端 MUST 在分類前攔截
```

`CALL_TIMEOUT_MS`／`BUDGET_MS`／`BACKOFF_MS` 三個數字**不動**（001 FR-014 三數綁定）。
新增常數 `SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 20_000`（`copilot-analysis.ts`），第二段的
`callTimeoutMs` 由它承載（✅ 2026-08-29 裁決為 20 秒，依 research.md #5 的對照表；
第二段 `maxRetries: 0` 不進重試迴圈，改它不牽動 001 FR-014 的三數綁定）。

## 6. 刪除

- `server/services/knowledge/agent-knowledge-provider.ts::SUGGESTION_RETRIEVAL_TIMEOUT_MS`（research.md #8）
- `shared/types/knowledge.ts` 中 `search()` 註解裡「建議卡 MUST 明確傳入 SUGGESTION_RETRIEVAL_TIMEOUT_MS」
  那三行，改為「建議卡路徑與快查共用預設 `KNOWLEDGE_SEARCH_TIMEOUT_MS`（004 FR-003）」

## 7. 驗證規則

- 兩段的卡片各自過 `parseSuggestionCards()`（Zod）→ `whitelistFilter()` → `forceNullConfidence()`，
  順序與 002 相同（FR-004）。第二段的白名單集合是**第二段呼叫當下傳入的 hits**，不是第一段的空集合。
- 第一段 `knowledgeHits: []` → `whitelistFilter()` 會捨棄任何 `sopId !== null` 的卡（模型在沒有命中時
  編造 id），這是既有行為，本功能不改。
- `provenance.stage1RetryAttempt` 取自 `withRetry()` 回傳的 `retryAttempt`。

## 8. 第二段與搶答標記（FR-015）

`suggestionBlock.cards` 有**三個寫入者**，這是本功能最容易靜默失效的地方：

| 寫入者 | 觸發 | 寫什麼 |
|---|---|---|
| `analyzeSuggestionsOnce()` 第一段 | 分析啟動 | 整批新卡（`citation: 'pending'`） |
| 尾巴的第二段 | 檢索有命中且生成成功 | **整批**新卡（`citation: 'cited'`） |
| `checkSuggestionsSuperseded()` | 同事／AI 回覆客戶（`session-manager.ts`） | 在既有卡上加搶答標記 |

第三個寫入者**不受世代與尾巴管轄**——它由訊息到達驅動，可能發生在尾巴仍在飛的任何時點。
第二段的整批覆蓋會把它剛寫上的標記一起蓋掉，而 `status` 仍是 `ready`、**不報錯**：
同事已經回過的那段內容，會以一張沒有標記的新卡重新變成「可用建議」，客服照著再回一次客戶。
憲法 7.2 要防的正是這件事。

**規則**：`publishSuggestionReady()` 在第二段落地路徑上，MUST 於發布前以**當下的對話歷史**
重新套用 `markSupersededCards()`，再送出。順序 MUST 在白名單與 `confidence` 歸零**之後**
（搶答標記是對「最終要顯示的卡」下的判斷，對已被捨棄的卡標記沒有意義）。

背景單段與「命中已在手」單段同樣適用——它們一樣是整批覆蓋。
