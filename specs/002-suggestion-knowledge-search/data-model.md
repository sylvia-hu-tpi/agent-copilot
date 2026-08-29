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
  /**
   * 依生成順序排列。張數上限 3–5 張（ARCHITECTURE §14.6）於**生成階段**落實
   * （prompt 明示上限，FR-001），此欄位不做事後截斷——截掉的卡片已經付出過 AI 呼叫成本。
   */
  cards: SuggestionCard[]
  /**
   * 本次生成所依據的知識庫檢索「發生了什麼」（憲法 6.2 v3.0.1 要求的可稽核證據）。
   *
   * ⚠️ 這裡**必須是兩個欄位**，不能只留一個計數：
   *   - `ran: false`              → 根本沒查（憲法 6.2 禁止的情形，正常路徑不該出現）
   *   - `ran: true,  hitCount: 0` → 查了但 0 命中，或呼叫失敗後以空集合續行（FR-004 允許的誠實降級）
   *   - `ran: true,  hitCount: n` → 有命中；模型仍可能判斷全部無關而不引用
   * 早期版本只有 `knowledgeHitCount: number`，前兩種情形都得到 0、無法分辨——
   * 而 FR-004 與憲法 6.2 的處置方式完全不同，那個欄位承擔不起它被賦予的職責。
   */
  knowledgeSearch: { ran: boolean, hitCount: number }
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
  /**
   * @param opts.fileId 限定在單一檔案內檢索（「展開全文」用，research.md #3）
   * @param opts.timeoutMs 逾時上限；預設 KNOWLEDGE_SEARCH_TIMEOUT_MS（快查用，見 plan.md Constraints）。
   *                       ⚠️ 建議卡生成的檢索 MUST 明確傳入 SUGGESTION_RETRIEVAL_TIMEOUT_MS，
   *                       MUST NOT 沿用這個預設 —— 那條路徑受 SC-001 的 10 秒約束，
   *                       沿用快查的長逾時會讓建議卡遲到（見該常數註解）。
   *                       （⚠️ 2026-08-29：SC-001 已改為 20 秒，且 004 FR-003 以「第二段等檢索 30 秒」取代這個 8 秒短逾時；本段描述的是兩段式落地前的現況）
   */
  search(query: string, opts?: { topK?: number, fileId?: string, timeoutMs?: number }): Promise<KnowledgeHit[]>
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
  /** 有值時 query 沿用原查詢字串，但限定在該 sourceRef.ref 對應的檔案內搜尋（「展開全文」，FR-010） */
  expandRef?: string
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeHit[]
  /**
   * 檢索呼叫失敗或逾時（憲法 3.1／3.2：這支端點 MUST NOT 回 5xx）。
   * 前端據此顯示「知識庫服務暫時無法使用」＋重試，而非「查無相關結果」——
   * 兩者都會是 `hits: []`，少了這個欄位就無法區分。
   */
  degraded?: boolean
}
```

## 6. 驗證規則

| 欄位 | 規則 | 對應 FR／憲法 |
|---|---|---|
| `SuggestionCard.sopId` | 非 null 時必須存在於呼叫當下 `knowledgeHits` 的 `id` 集合，否則整卡捨棄（不只清空此欄位） | FR-003、憲法 4.3 |
| `SuggestionCard.confidence` | `knowledgeHits` 全數 `score === null` 時（iMBrace 路徑恆如此）本欄位 MUST 為 `null`，不得由模型自評頂替。⚠️ **MUST 由後端在寫入 `CopilotAnalysisState` 前強制歸零**——Zod schema 只能宣告 `.nullable()`（允許數字通過），擋不住模型自評；只靠 prompt 交代等同沒有規則 | FR-002、憲法 4.4 |
| `SuggestionCard.requiresData` | 模型無法確認的具體資料（工單編號、金額等）MUST 走此欄位，不得直接編入 `text` | FR-002、憲法 4.5 |
| `SuggestionCard.tone` | 僅接受列舉值；列舉外一律視為該卡驗證失敗（整卡跳過，非單欄位丟棄——`tone` 是必要展示欄位，不像 `riskFlags` 可安全省略） | 憲法 4.6 精神延伸 |
| `KnowledgeHit.updatedAt` | 無法從檔名可靠擷取時為 `null`；為 `null` 時 MUST NOT 觸發 FR-009 過舊提醒，UI 顯示「更新日期未知」 | FR-009、憲法 4.5 |
| `KnowledgeSearchRequest.query` | 空白或僅空白字元時，端點 MUST 回傳 **200 `{ hits: [] }`**（不是 400——那是「尚未查詢」，不是用戶端錯誤）且不呼叫 `KnowledgeProvider`；前端 MUST 在送出前先擋（debounce 300ms 後仍為空白則不送），並依「是否曾送出過非空白查詢」而非 `hits.length` 決定顯示哪個空狀態 | FR-008、contracts/knowledge-search-api.md |
| `CopilotAnalysisState.suggestionBlock.knowledgeSearch.ran` | 每次建議卡生成（前景或背景）MUST 為 `true`；`false` 代表略過了檢索，是憲法 6.2 禁止的路徑 | FR-019、憲法 6.2 v3.0.1 |
| `CopilotAnalysisState.suggestionBlock` | `priority === 'background'` 的增量分析**仍然**重算此欄位（與 `summaryBlock` 不同，後者背景時不重算） | FR-019、憲法 6.2 |

## 7. 狀態轉換：`SuggestionBlock.status`

沿用 `SummaryBlock`/`SentimentBlock` 完全相同的五態機（`empty → analyzing → ready`，
失敗分支 `analyzing/retrying → error`，手動重試 `error → retrying → ready`），額外規則：

- 冷啟動（JOIN）與前景/背景增量皆會重新進入 `analyzing`（建議卡不像摘要在背景被跳過）。
- 進入 `ready` 前必經 FR-003 白名單過濾——若過濾後 `cards.length === 0`（本次候選全數因引用不在
  白名單而被捨棄），狀態仍為 `ready`（不是 `error`），`cards: []`。

  `ready && cards.length === 0` 這個組合底下實際有兩種語意，UI MUST 依 `knowledgeSearch.hitCount`
  區分（`status === 'empty'` 的「尚無資料」FR-014 是第三種，由 `status` 本身區分，不在此列）：

  | `knowledgeSearch` | 語意 | UI |
  |---|---|---|
  | `{ ran: true, hitCount: 0 }` | 知識庫沒有相關內容，模型也未產出通用建議 | 「本次未產生建議」中性狀態 |
  | `{ ran: true, hitCount: n > 0 }` | 有命中，但候選卡片的引用全數不在白名單而被捨棄（Edge Cases 第 3 條） | 「本次未產生建議」中性狀態＋不得顯示被捨棄卡片的任何殘餘內容 |

  兩者對客服的呈現可以一致（都是中性空狀態，都不是錯誤），但**日誌與稽核 MUST 能分辨**——
  後者代表模型正在杜撰引用，是需要調 prompt 的訊號；前者只是知識庫沒這題。

## 8. 背景並行狀態（不進 `StateStore`，純記憶體、無需持久化）

```ts
// server/services/copilot-analysis.ts 內部模組狀態，globalThis-keyed（HMR 安全，比照既有單例）
const BACKGROUND_CONCURRENCY_LIMIT = 10
const backgroundInFlight = new Set<string>() // conversationId
```

不持久化的理由：這是「此時此刻正在執行哪些背景 AI 呼叫」的執行期狀態，程序重啟後所有進行中的
呼叫本來就會中斷重來，持久化它沒有意義（性質上類似既有 `debounceTimers` Map，同樣不持久化）。
