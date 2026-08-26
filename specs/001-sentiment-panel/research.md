# Phase 0 Research: 情緒面板（摘要卡與情緒 Sparkline）

本功能大部分的架構決策在 `docs/ARCHITECTURE.md`（§8.2b、§11、§14、§15）與 `docs/CONSTITUTION.md`（第三、四、六、八條）已定案；本文件只記錄**本功能新增、既有正典文件未直接回答**的實作決策。已定案項目不重複列出，直接於 plan.md／data-model.md 引用章節號。

## 1. 逐區塊狀態如何透過 SSE 表達

**Decision**: 在 `CopilotEvent`（`shared/types/events.ts`）新增兩個事件，各自攜帶完整的區塊狀態信封：

```ts
| { type: 'summary.updated', conversationId: string, summary: SummaryBlock }
| { type: 'sentiment.updated', conversationId: string, sentiment: SentimentBlock }
```

`SummaryBlock` / `SentimentBlock` 內含 `status: AnalysisBlockStatus`（`'empty' | 'analyzing' | 'retrying' | 'ready' | 'error'`）與對應內容欄位（見 data-model.md）。同一事件型別承載「狀態＋內容」，不拆成 `summary.updated` 與 `summary.status.changed` 兩種事件。

**Rationale**: FR-009／FR-011／FR-014 要求 UI 能分辨「尚無資料」「分析中」「重試中」「就緒」「錯誤」五種狀態，且需在同一次面板更新內同時看到內容與狀態（SC-003：異常示警需在下一次面板更新內被看見，不能狀態事件與內容事件分兩次到才拼得出完整畫面）。單一事件型別可讓前端 reducer 保持簡單（收到即整塊覆蓋該區塊的顯示狀態），且與既有 `CopilotEvent` 的其他成員（如 `control.updated`）的「一個事件＝一個完整快照」風格一致。

**Alternatives considered**：
- 拆成內容事件＋狀態事件兩種：會產生順序耦合（狀態事件先到還是內容事件先到）與競態視窗，且與既有事件慣例不一致，予以否決。
- 用 HTTP 輪詢取代 SSE 推播區塊狀態：與 §9 即時機制的既有設計（一切狀態變化走 `conversation:{id}` topic 推播）矛盾，且會重新引入輪詢延遲，否決。

## 2. 重試／退避策略的實作位置與參數

**Decision**: 新增 `server/services/ai/retry-policy.ts`，提供一個純函式 `classifyFailure(error) → 'transient' | 'rate-limited' | 'permanent'` 與一個 `withRetry(fn, opts)` 執行器。

**規範性數值一律以 `spec.md` FR-014 為唯一權威來源**，本檔不再重述可能過期的副本；實作與測試皆引用該處：單次呼叫逾時 15 秒、退避 1s → 4s、自首次失敗起算總預算 40 秒（含執行時間）、最多 2 次重試。逾預算或次數用盡即轉 `error`。`copilot-analysis.ts` 呼叫 `AIProvider` 時統一經過此執行器包裹。

`classifyFailure()` 刻意回傳三值而非二值：`'rate-limited'`（429）在 M2 的處置與 `'permanent'` 相同（直接轉 `error`、不自動重試），但兩者的**原因**不同，M3 全域退避佇列建立時只有 `'rate-limited'` 會改接佇列。若現在為省事而把 429 併入 `'permanent'`，M3 將無從辨識哪些失敗該進佇列——這正是 `IMBRACE_QUESTIONS.md` G-2 書面規格到位後最容易被漏掉的接縫。

**Rationale**: FR-014 明確區分暫時性（單次逾時／5xx）、rate limit（429）與非暫時性失敗（含 Zod 驗證失敗），且要求重試進度可視（「重試中 (1/2)」），與單純的「失敗就顯示錯誤」邏輯不同，需要獨立、可單元測試的策略模組而非散落在呼叫端各自 try/catch。獨立模組也符合憲法 2.4 的反面教訓——不是為了抽象而抽象，而是因為這段邏輯本身有非平凡的狀態機（判別 → 退避 → 計數 → 逾預算轉態），值得有自己的測試（`test/ai-retry-policy.test.ts`）。

**Alternatives considered**：
- 直接複用 `app/stores/stream.ts` 既有的 SSE 重連退避邏輯：兩者退避的對象不同（一個是連線層級的重連，一個是單次 AI 呼叫層級的重試），耦合會讓修改其中一個時意外影響另一個，否決；但退避數列的**參數選擇**（先短後長、加上上限）沿用相同直覺。
- 全部交給 `AIProvider` 實作內部自行重試：會讓 `MockAIProvider` 與未來 `ImbraceAgentProvider` 各自重複實作退避邏輯，且無法統一套用 FR-014 的「總預算 ≤ 40 秒」上限（跨兩次呼叫的預算需要在呼叫方累計），否決。

## 3. 附件唯一輪（無文字）在情緒序列中的資料形狀

**Decision**: 情緒時間軸的型別不是單純的 `SentimentPoint[]`，而是 `SentimentTimelineEntry[]`，其中 `SentimentTimelineEntry = SentimentPoint | SentimentMarker`：

```ts
export interface SentimentMarker {
  messageId: string
  at: string
  kind: 'attachment_only'
}
```

`SentimentGauge.vue` 繪製 sparkline 時只取 `SentimentPoint`（有 `score`）的子集連線，`SentimentMarker` 僅在時間軸上渲染一個中性圖示，不參與折線與示警判定。

**Rationale**: FR-012 要求「純附件輪 MUST 仍在情緒走勢的時間軸上以可辨識的中性標記呈現，MUST NOT 讓該輪從畫面上消失」，但 FR-002 同時要求「MUST NOT 為該輪產生情緒分數點」——兩者合起來代表這一輪確實存在於時間軸，但不是一個「分數點」。若勉強塞進 `SentimentPoint`（例如給 `score: null`），會讓消費端（sparkline 折線邏輯、示警判定、FR-015 的全量統計）到處都要多一層 null 檢查，且語意上「這一輪沒有分數」與「這一輪的分數是未知/失敗」是不同的事（後者是分析失敗，屬 FR-014 的錯誤狀態，不是本情境）。用獨立型別的判別聯集（discriminated union）讓 TypeScript 在編譯期就擋掉「不小心把 marker 當 point 拿去算平均值」這類錯誤。

**Alternatives considered**：
- `score: number | null` 加註解：否決，理由如上，null 會被多處誤用或漏判。
- 完全不在時間軸呈現，只在摘要卡註記「客戶傳送了附件」：直接違反 FR-012 的「MUST NOT 讓該輪從畫面上消失」，否決。

## 4. AIProvider 實作範圍（本功能只做 Mock，不做真實 iMBrace 串接）

**Decision**: 本功能落地 `AIProvider` 介面（`summarize`、`analyzeSentiment`，`suggest` 不在本功能範圍，型別上可先省略或留待建議卡功能加入）與 `MockAIProvider`。`ImbraceAgentProvider`（真實呼叫 iMBrace AI Agent）**不在本次任務範圍**，留待後續功能（建議卡／知識庫快查上線時，屆時三者共用同一個真實 provider 呼叫路徑，一併驗證會更有效率）。

**Rationale**: `ARCHITECTURE.md` §8.2b 明訂「M2 UI 先行完成用」以 `MockAIProvider` 回傳固定樣本資料，UI 與狀態機（分析中／重試中／就緒／錯誤／空狀態）的正確性可以完全獨立於真實 AI 呼叫驗證。真實串接涉及 structured output 的 prompt 設計、Zod schema 對齊模型實際輸出、以及 §11.7 的溫度／語言設定，屬於另一個維度的工作，不應與「面板行為是否符合憲法 3.1/3.2」這個本功能的核心驗收目標綁在一起。介面（憲法 2.1／2.2）保證日後換上真實 provider 時只改裝配點。

**Alternatives considered**：
- 直接串 `ImbraceAgentProvider`：會讓本功能的驗收依賴外部 AI 服務的可用性與延遲（實測中位數 5 秒、最慢 12.2 秒，見憲法 6.2），使「10 秒門檻」「重試邏輯」的測試變得不穩定且變慢，否決；且會提前引入 prompt／Zod schema 對齊的工作量，模糊本功能邊界。

## 5. 摘要／情緒資料是否掛在 `CopilotSession` 上——是否需要改動 `StateStore` 介面

> **2026-08-26 訂正**：本節原決策為「擴充 `CopilotSession`、不改動 `StateStore` 介面」，經 `/speckit-analyze` 發現會與 FR-010 衝突後推翻，改為下方決策。

**Decision**: **需要**改動 `StateStore` 介面——新增 `getAnalysisState`／`setAnalysisState` 兩個方法，操作一個獨立於 `CopilotSession` 的新資料形狀 `CopilotAnalysisState`（詳見 data-model.md），不擴充既有 `CopilotSession` 介面，也不沿用 `setCopilotSession`。

**Rationale**: `CopilotSession` 的生命週期由 watcher refcount 管理——`server/services/session-manager.ts` 的 `releasePipeline()` 在 `watchers.length === 0` 時會整組刪除該對話的 `CopilotSession`（`store.deleteCopilotSession()`）。客服切離對話是正常操作，若摘要／情緒資料掛在同一個物件上，切走就會把分析成果一併刪除，客服切回時變成從零開始的 cold start，直接違反 FR-010「切走再切回，結果 MUST 被保留」。`server/state/types.ts` 檔頭原本預告「AI 產物於 M2 加入——屆時新增欄位即可，不需改動 StateStore 介面」，這個預告當時未考量到 watcher refcount 與分析成果生命週期不同的問題，本功能落地時一併訂正該註解。新方法比照既有 `addPresence(convId, entry, ttlMs)` 的 TTL 傳參模式，憲法 2.3（day-1 async）依然滿足。

**Alternatives considered**：維持原決策（擴充 `CopilotSession`）並改為「`releasePipeline()` 只停輪詢、不刪 session，另立 TTL 回收」——改動面更小，但 `CopilotSession` 的存在語意會從「有人在看」變成「有人在看或曾經在 TTL 內看過」，增加後續讀這個欄位的人誤解的風險；且兩案都要解「多久沒人看該回收」這個新問題，並非該替代方案獨有的優勢，故不採用。

## 6. 錯誤記錄與 PII（憲法 1.5）在分析管線中的落地

**Decision**: `copilot-analysis.ts` 的錯誤記錄（含重試失敗最終落地的 log）只記 `conversationId`、失敗分類（transient/permanent）、HTTP 狀態碼／錯誤碼，**不記錄** `Message.text`、`ConversationSummary` 內容或 `SentimentPoint.drivers`（後者本質是從客戶發言擷取的關鍵詞，同樣屬個資範疇）。

**Rationale**: 憲法 1.5「日誌不得輸出訊息全文」與其實作 `server/utils/redact.ts` 的既有原則直接適用；`drivers` 欄位容易被忽略（它看起來像「系統產生的標籤」而非「客戶原話」），特別記錄提醒實作與 code review 時注意。

**Alternatives considered**：無——這是既有憲法條文的直接套用，不存在需要權衡的替代方案。
