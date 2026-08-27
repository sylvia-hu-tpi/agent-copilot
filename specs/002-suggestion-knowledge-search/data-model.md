# Phase 1 Data Model: 建議卡與知識庫快查

沿用 `specs/001-sentiment-panel/data-model.md` 已定案的 `AnalysisBlockStatus`／整塊覆蓋式區塊／
`CopilotAnalysisState` 模式，本文件只列**新增與修改**的型別。既有 `ConversationSummary`／
`SentimentPoint`／`SentimentMarker`／`SummaryBlock`／`SentimentBlock` 不重複列出。

## 1. `shared/types/copilot.ts`（MODIFIED）

### 1.1 `SuggestionCard`（新增，形狀對照 `docs/ARCHITECTURE.md` §11.5 草案，欄位語意依 research.md #2/#6 訂正）

```ts
export interface SuggestionCard {
  id: string
  /** 必須來自本次 knowledgeHits 集合，經白名單後驗；無引用時為 null（FR-004） */
  sopId: string | null
  /** 清理過的知識庫來源標題；sopId 為 null 時亦為 null（見 research.md #2） */
  sopTitle: string | null
  /** 可直接送出的回覆全文（繁中、客服語氣） */
  text: string
  /** 0–100；無真實依據時為 null，UI 留空不顯示，不得估算填充（憲法 4.4） */
  confidence: number | null
  /** 為何建議這句，供客服判斷，不隨「一鍵帶入」帶入 Composer */
  rationale: string
  tone: 'apologetic' | 'informative' | 'retention' | 'closing' | 'escalating'
  /** 需客服補上的實際資料，如「工單編號」；缺乏資料時 MUST NOT 推測填入（憲法 4.5） */
  requiresData: string[]
  /**
   * 這張卡是否已被同事或 AI 的後續回覆搶先說掉（FR-015、US4）。
   * `null` = 尚未評估過重複性（例如卡片剛產生）；有值時代表已完成一次重複性判定。
   */
  supersededBy: { kind: 'agent' | 'ai', messageId: string } | null
}

export interface SuggestionBlock {
  status: AnalysisBlockStatus
  retryAttempt?: number
  firstFailureAt?: string
  /** 依生成順序排列；面板上限 3–5 張見 ARCHITECTURE §14.6，超過以捲動呈現，本欄位不截斷 */
  cards: SuggestionCard[]
  /**
   * 本次生成依據的知識庫檢索是否為空（FR-004 的「未引用知識庫」與 FR-019 的
   * 「MUST NOT 以空檢索結果產生建議卡」是兩個不同語意——前者可能命中但模型判斷無關，
   * 後者是檢索本身沒跑或失敗。此欄位記錄的是**後者**：knowledgeHits.length === 0
   * 且非因為呼叫失敗導致，供邊界情境（spec.md Edge Cases 第 3 條，白名單全捨棄）判斷用。
   */
  knowledgeHitCount: number
  updatedAt: string
}
```

### 1.2 `AIProvider` 介面擴充

```ts
export interface AIProvider {
  summarize(input: { history: Message[], previousSummary?: ConversationSummary }): Promise<ConversationSummary>
  analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]>
  /** 新增（本功能）——knowledgeHits 由呼叫端先查好傳入，agent 只能從其中選 sopId（§11.6①） */
  suggest(input: {
    history: Message[]
    knowledgeHits: KnowledgeHit[]
    /** Hybrid 模式下 AI 也在自動回覆（FR-016），prompt 需知悉並以補位性質為優先 */
    aiReplies: boolean
  }): Promise<SuggestionCard[]>
}
```

## 2. `shared/types/knowledge.ts`（NEW）

```ts
export interface KnowledgeHit {
  /** 僅供系統內部 FR-003 白名單核對使用，MUST NOT 顯示於 UI（見 research.md #2 二次訂正） */
  id: string
  /** 清理過的來源檔名，是對客服顯示的唯一來源識別方式——不另設「編號」欄位 */
  title: string
  /** 本次檢索命中的內容片段原文——「插入為回覆」的帶入單位，非條目全文（FR-022） */
  snippet: string
  /** 檢索分數；iMBrace 路徑恆為 null（無分數來源），見憲法 4.4 同一原則 */
  score: number | null
  /** ISO8601；無法從來源可靠推得時為 null（研究 #2），null 時 UI 不觸發 FR-009 過舊提醒 */
  updatedAt: string | null
  sourceRef: { type: 'knowledge', ref: string }
}

export interface KnowledgeProvider {
  search(query: string, opts?: { topK?: number, channel?: string }): Promise<KnowledgeHit[]>
}
```

## 3. `server/state/types.ts`（MODIFIED）

### 3.1 `CopilotAnalysisState` 新增欄位

```ts
export interface CopilotAnalysisState {
  conversationId: string
  summaryBlock: SummaryBlock
  sentimentBlock: SentimentBlock
  /** 新增（本功能） */
  suggestionBlock: SuggestionBlock
}
```

不新增第二個 sliding-TTL 資料集——`suggestionBlock` 與既有兩塊共用同一筆
`CopilotAnalysisState`、同一個 `getAnalysisState`/`setAnalysisState`、同一個 2 小時 TTL，理由與
`summaryBlock`/`sentimentBlock` 當初的決策一致（見 `specs/001-sentiment-panel/research.md` #5）：
三者的生命週期完全相同，沒有理由拆開。

### 3.2 `StateStore` 新增方法（背景 JOIN 持久追蹤，見 research.md #8）

```ts
export interface StateStore {
  // …既有方法不變…

  /** JOIN 成功時呼叫；冪等（重複呼叫同一組合不產生副作用） */
  addJoinedConversation(operatorId: string, conversationId: string): Promise<void>
  /** LEAVE 成功時呼叫 */
  removeJoinedConversation(operatorId: string, conversationId: string): Promise<void>
  /** SSE 連線建立時查詢，用於重建背景 watch（見 research.md #8 決策 4） */
  listJoinedConversations(operatorId: string): Promise<string[]>
}
```

`MemoryStateStore` 實作：`Map<operatorId, Set<conversationId>>`，**不設 TTL**——JOIN／LEAVE 是
明確操作，不是需要容忍遺漏心跳的 presence（見 research.md #8 的「Alternatives considered」）。

### 3.3 `MessageSource` 新增方法（背景並行判斷，見 research.md #9）

```ts
export interface MessageSource {
  // …既有方法不變…

  /** 該對話目前對任一位客服而言是否為前景（聚合規則同既有 aggregateState()） */
  getPriority(conversationId: string): WatchPriority
}
```

## 4. `shared/types/events.ts`（MODIFIED）

```ts
export type CopilotEvent =
  | … // 既有成員不變
  /** 建議卡整塊覆蓋式更新，比照 summary.updated/sentiment.updated */
  | { type: 'suggestion.updated', conversationId: string, suggestion: SuggestionBlock }
```

## 5. 知識庫快查的請求／回應型別（不進 `CopilotEvent`，見 research.md #7）

```ts
// shared/types/knowledge.ts（延續 §2）

export interface KnowledgeSearchRequest {
  query: string
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeHit[]
}
```

## 6. 驗證規則

| 欄位 | 規則 | 對應 FR／憲法 |
|---|---|---|
| `SuggestionCard.sopId` | 非 null 時必須存在於呼叫當下 `knowledgeHits` 的 `id` 集合，否則整卡捨棄（不只清空此欄位） | FR-003、憲法 4.3 |
| `SuggestionCard.confidence` | `knowledgeHits` 全數 `score === null` 時（iMBrace 路徑恆如此）本欄位 MUST 為 `null`，不得由模型自評頂替 | FR-002、憲法 4.4 |
| `SuggestionCard.requiresData` | 模型無法確認的具體資料（工單編號、金額等）MUST 走此欄位，不得直接編入 `text` | FR-002、憲法 4.5 |
| `SuggestionCard.tone` | 僅接受列舉值；列舉外一律視為該卡驗證失敗（整卡跳過，非單欄位丟棄——`tone` 是必要展示欄位，不像 `riskFlags` 可安全省略） | 憲法 4.6 精神延伸 |
| `KnowledgeHit.updatedAt` | 無法從檔名可靠擷取時為 `null`；為 `null` 時 MUST NOT 觸發 FR-009 過舊提醒，UI 顯示「更新日期未知」 | FR-009、憲法 4.5 |
| `KnowledgeSearchRequest.query` | 空白或僅空白字元時，端點 MUST 回傳 400 或空結果且不呼叫 `KnowledgeProvider`；前端 MUST 在送出前先擋（debounce 300ms 後仍為空白則不送） | FR-008 |
| `CopilotAnalysisState.suggestionBlock` | `priority === 'background'` 的增量分析**仍然**重算此欄位（與 `summaryBlock` 不同，後者背景時不重算） | FR-019、憲法 6.2 |

## 7. 狀態轉換：`SuggestionBlock.status`

沿用 `SummaryBlock`/`SentimentBlock` 完全相同的五態機（`empty → analyzing → ready`，
失敗分支 `analyzing/retrying → error`，手動重試 `error → retrying → ready`），額外規則：

- 冷啟動（JOIN）與前景/背景增量皆會重新進入 `analyzing`（建議卡不像摘要在背景被跳過）。
- 進入 `ready` 前必經 FR-003 白名單過濾——若過濾後 `cards.length === 0`（本次候選全數因引用不在
  白名單而被捨棄），狀態仍為 `ready`（不是 `error`），`cards: []`，UI 依 `knowledgeHitCount` 與
  `cards.length` 的組合區分「尚無資料」（FR-014）／「全數被捨棄」（Edge Cases 第 3 條）／
  「正常無建議」三種观感一致但語意不同的空狀態（详见 quickstart.md 對應場景）。

## 8. 背景並行狀態（不進 `StateStore`，純記憶體、無需持久化）

```ts
// server/services/copilot-analysis.ts 內部模組狀態，globalThis-keyed（HMR 安全，比照既有單例）
const BACKGROUND_CONCURRENCY_LIMIT = 10
const backgroundInFlight = new Set<string>() // conversationId
```

不持久化的理由：這是「此時此刻正在執行哪些背景 AI 呼叫」的執行期狀態，程序重啟後所有進行中的
呼叫本來就會中斷重來，持久化它沒有意義（性質上類似既有 `debounceTimers` Map，同樣不持久化）。
