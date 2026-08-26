# Phase 1 Data Model: 情緒面板（摘要卡與情緒 Sparkline）

型別定義位置：`shared/types/copilot.ts`（新檔）。既有型別（`Message`、`SenderType` 等）沿用 `shared/types/conversation.ts`，不重複定義。

## AnalysisBlockStatus

摘要卡與情緒 sparkline 共用同一組狀態列舉，對應 FR-009、FR-011、FR-014。

```ts
export type AnalysisBlockStatus =
  | 'empty'      // 尚無可供分析內容（FR-009）——例如剛 JOIN 且客戶尚無發言
  | 'analyzing'  // 首次分析進行中（FR-011）
  | 'retrying'   // 暫時性失敗後自動重試中，need 附帶重試次數（FR-014）
  | 'ready'      // 已有可顯示內容（可能是漸進呈現中的部分欄位，FR-011）
  | 'error'      // 自動重試用盡或非暫時性失敗，等待手動重試（FR-006、FR-008）
```

**狀態轉移**（單一區塊，摘要與情緒各自獨立一份）：

```
empty ──(客戶發出可分析內容)──▶ analyzing
analyzing ──(成功)──▶ ready
analyzing ──(暫時性失敗)──▶ retrying
analyzing ──(非暫時性失敗)──▶ error
retrying ──(重試成功)──▶ ready
retrying ──(重試仍失敗 且 次數<2 且 未逾40秒)──▶ retrying
retrying ──(次數用盡 或 逾40秒 或 非暫時性 或 429)──▶ error
error ──(客服手動重試，FR-008)──▶ analyzing
ready ──(新的增量分析觸發，FR-004)──▶ analyzing   ⚠️ 已顯示內容不清空，見下方「呈現規則」
```

**呈現規則（非狀態機本身，但實作 UI 時必須遵守）**：`ready → analyzing` 的轉移期間，畫面 MUST 保留前一次的內容繼續顯示，只疊加「更新中」提示（呼應 spec.md Edge Cases 與 FR-010 的「補跑期間標示更新中」），不得清空重回空白載入畫面。

## SummaryBlock

摘要卡的完整資料信封，對應 SSE `summary.updated` 事件的 payload 與（若有）REST 讀取端點的回應形狀。

```ts
export interface SummaryBlock {
  status: AnalysisBlockStatus
  retryAttempt?: number          // status === 'retrying' 時的當前次數（1 或 2），對應 FR-014「重試中 (1/2)」
  summary: ConversationSummary | null   // status 為 empty/analyzing（首次）/error（從未成功過）時可能為 null
  updatedAt: string              // ISO8601，本次區塊狀態變化的時間
}
```

## ConversationSummary

沿用 `docs/ARCHITECTURE.md` §11.5 已定案的形狀，原樣落地，不在本功能重新設計：

```ts
export interface ConversationSummary {
  intent: string
  keyFacts: string[]
  attempted: string[]
  openIssues: string[]
  riskFlags: Array<'churn' | 'escalation' | 'compliance' | 'vip' | 'repeat_contact'>
  advice: string
  updatedAt: string
  basedOnMessageId: string       // 版本錨點，用於增量與快取（§11.3）
}
```

**驗證規則**：所有欄位經 Zod schema 驗證後才進入 `SummaryBlock`（憲法 4.2）；`intent`／`advice` 為必要字串（不可為空字串，空字串視同分析失敗，轉 `error`）；`keyFacts`／`attempted`／`openIssues` 為字串陣列，允許空陣列（代表「目前沒有」，非缺陷）；`riskFlags` 僅接受列舉內的值，模型輸出列舉外字串時該筆 flag 直接丟棄（不得讓整份摘要因單一欄位格式錯誤而全部失敗，但需記錄供觀察）。

## SentimentBlock

情緒面板的完整資料信封，對應 SSE `sentiment.updated` 事件的 payload。

```ts
export interface SentimentBlock {
  status: AnalysisBlockStatus
  retryAttempt?: number
  /** 全量時間軸（含分數點與純附件標記），依時間排序。前端自行取最近 50 點繪 sparkline（FR-015） */
  timeline: SentimentTimelineEntry[]
  /** 依全量 timeline 算出的統計值，供未來全程回顧使用；不受「僅繪最近 50 點」影響（FR-015） */
  stats: { lowestScore: number | null, lowestAt: string | null }
  updatedAt: string
}
```

## SentimentTimelineEntry = SentimentPoint | SentimentMarker

```ts
export interface SentimentPoint {
  kind: 'point'                  // 判別欄位，供聯集型別窄化
  messageId: string
  at: string
  score: number                  // 0–100，越低越負面
  label: 'calm' | 'neutral' | 'concerned' | 'frustrated' | 'angry'
  drivers: string[]              // ⚠️ 屬客戶對話個資，不得進日誌（research.md #6）
}

export interface SentimentMarker {
  kind: 'attachment_only'        // 純附件（無文字）客戶發言（FR-002、FR-012）
  messageId: string
  at: string
}

export type SentimentTimelineEntry = SentimentPoint | SentimentMarker
```

> `kind` 判別欄位是本功能對 `ARCHITECTURE.md` §11.5 原始 `SentimentPoint` 形狀的必要擴充（原形狀無此欄位，因原文未處理純附件輪的情境，見 research.md #3）。落地時需同步更新 §11.5 的型別範例並 grep 是否有其他文件仍引用舊形狀（`CLAUDE.md` 的正典修改後 grep 規則）。

**驗證規則**：`score` 經 Zod 限制在 0–100 閉區間；`label` 僅接受列舉內字串；純附件輪由伺服端依 `Message.attachments` 非空且 `Message.text` 為空字串直接產生 `SentimentMarker`，**不送進模型**（無文字可分析，送了也只是浪費一次呼叫）——因此 `SentimentMarker` 不經 AI 輸出驗證流程，是管線判斷後直接建構的。

> ⚠️ **此判別式僅在本功能範圍內成立，M3 實作附件文字化後必須回頭檢查**：本功能範圍不含附件內容文字化（FR-013 已延後至 M3，見 spec.md Assumptions），因此 `Message.text` 對純附件輪維持平台原始值（實務上為空字串）。但 `docs/ARCHITECTURE.md` §11.4 現行設計是「文字化結果寫回 `Message.text`」（`shared/types/conversation.ts` 的欄位註解也是同樣語意：「統一的可分析文字：原文，或附件的 vision／文件分析描述」）——若 M3 依此設計實作，純附件輪的 `Message.text` 將不再是空字串，本判別式會失效並把「已文字化的附件輪」誤判為含文字發言（因而錯誤產生 `SentimentPoint` 而非 `SentimentMarker`，違反 FR-002／FR-012）。M3 落地文字化管線時，MUST 改用不受文字化影響的判別依據（例如 mapper 層另外輸出一個「客戶是否原始有輸入文字」的顯式旗標，貫穿到 `copilot-analysis.ts` 的過濾邏輯），MUST NOT 沿用「`Message.text === ''`」這個判別式。

## 示警判定（衍生邏輯，非獨立實體）

不落地為資料型別，而是前端／後端共用的純函式（`shared/utils/` 或 `shared/types/copilot.ts` 內的 helper）：

```ts
export function isSentimentAlert(label: SentimentPoint['label']): boolean {
  return label === 'frustrated' || label === 'angry'
}
```

對應 FR-003、spec.md Assumptions 的「以標籤絕對等級判定，不採單輪下降幅度」決策。

## CopilotAnalysisState（獨立於 CopilotSession，`server/state/types.ts`）

> **2026-08-26 訂正**：原設計把 `summaryBlock`／`sentimentBlock` 直接掛在既有 `CopilotSession` 介面上。
> 但 `CopilotSession` 的生命週期由 watcher refcount 管理——`server/services/session-manager.ts`
> 的 `releasePipeline()` 在 `watchers.length === 0` 時會呼叫 `store.deleteCopilotSession()`
> **整組刪除**該對話的 `CopilotSession`。客服切離對話（沒有任何人在看）是完全正常的操作，
> 一旦兩者共用同一個物件，切走就會把尚在進行或剛完成的 AI 分析成果一併刪除，
> 客服切回時看到的會是從零開始的 cold start，直接違反 FR-010「切走再切回，結果 MUST 被保留」。
>
> 因此摘要／情緒資料改為**完全獨立於 `CopilotSession` 的新資料集**，不受 watcher 數量影響、
> 也不因客服切走而被清除。`CopilotSession` 本身維持原樣（僅供輪詢與去重使用），不新增任何欄位。

```ts
export interface CopilotAnalysisState {
  conversationId: string
  summaryBlock: SummaryBlock
  sentimentBlock: SentimentBlock
  /** debounce 計時器用的最後一次觸發時間戳（epoch ms），非對外欄位，供 copilot-analysis.ts 內部使用 */
  lastAnalysisTriggerAt?: number
}
```

`StateStore`（`server/state/types.ts`）新增兩個方法，與既有 `getCopilotSession`／`setCopilotSession` 平行但完全不共用底層資料：

```ts
getAnalysisState(convId: string): Promise<CopilotAnalysisState | null>
/** ttlMs：sliding TTL，每次呼叫皆以當下時間重新起算到期時間 */
setAnalysisState(s: CopilotAnalysisState, ttlMs: number): Promise<void>
```

**生命週期**：sliding TTL，**建議值 2 小時**——每次讀取（客服切回檢視）或寫入（新一輪分析完成）都重新起算到期時間。選擇 2 小時而非「永不過期」或「跟 watcher 數綁定」的理由：

- 對應客服在一個工作班次內於多個對話間切換、間隔數十分鐘至一兩小時再切回的常見情境（spec.md Assumptions 提及的「背景對話」情境，屬未來多對話切換功能，但本次 TTL 設計需先預留合理餘裕，避免切換頻率稍高就重演 FR-010 的 bug）。
- 記憶體實作比照既有 `presence`（`server/state/memory-store.ts` 的 `Expiring<T>` 雙軌淘汰：讀取時惰性淘汰 + 定期掃除），不會無界累積；相較於「永不過期」，2 小時上限讓「服務長時間不重啟、處理大量對話」情境下的記憶體增長有明確上界。
- 這是本次新增、之前規格未定義過的數字，非既有慣例的既定值（不可與 FR-014 的 40 秒重試預算、presence 的 45 秒心跳 TTL 混淆——三者用途完全不同）。若之後的多對話切換／背景分級功能對「多久沒人看該保留分析結果」有更精確的產品判斷，屆時應回頭修訂此值，並比照本次做法同步更新本節與 `plan.md` Storage 一節。

**初始值**（`CopilotAnalysisState` 建立時，即冷啟動觸發時）：`summaryBlock.status = 'empty'`、`sentimentBlock.status = 'empty'`，兩者 `updatedAt` 為建立時間，`timeline = []`、`summary = null`。

## Key Entities 對照（回填 spec.md）

| spec.md 用詞 | 本文件對應型別 |
|---|---|
| 摘要卡（Conversation Summary） | `ConversationSummary`（內容）＋ `SummaryBlock`（含狀態的信封） |
| 情緒評分點（Sentiment Point） | `SentimentPoint`（含分數）＋ `SentimentMarker`（純附件輪的中性標記）共同構成 `SentimentBlock.timeline` |
