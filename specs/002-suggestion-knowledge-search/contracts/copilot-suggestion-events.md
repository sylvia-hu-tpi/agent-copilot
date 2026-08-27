# Contract: 建議卡 SSE 事件

沿用 `specs/001-sentiment-panel/contracts/copilot-sse-events.md` 的整塊覆蓋式慣例，本文件只新增
`suggestion.updated` 這一個成員，不重複既有事件的說明。

## 事件

```ts
{ type: 'suggestion.updated', conversationId: string, suggestion: SuggestionBlock }
```

## 消費端保證（前端 `useCopilotSession.ts`）

- **整塊覆蓋**，不做 partial merge——收到即以 `evt.suggestion` 整個取代目前顯示的 `SuggestionBlock`，
  與 `summary.updated`/`sentiment.updated` 同一慣例。
- `status` 決定 UI 分支：
  - `empty` → 顯示「尚無資料」（FR-014），與「查無相關結果」「未輸入查詢」視覺上可區分（那是快查
    的狀態，不是建議卡的狀態，兩者不可混用同一組文案）。
  - `analyzing` / `retrying` → 骨架或產生中狀態，`retryAttempt` 有值時顯示「重試中 (n/2)」
    （沿用 FR-014 既有文案格式）。
  - `ready` 且 `cards.length === 0` → 顯示「本次未產生建議」的中性狀態（**不是**錯誤，也不是
    「尚無資料」——區分見 data-model.md §7）。
  - `error` → 顯示「暫時無法產生建議」＋重試按鈕，呼叫 `POST /copilot/retry { block: 'suggestions' }`
    （既有端點擴充合法值，見下一份契約）。
- 每張卡片的「一鍵帶入」呼叫端**必須**先檢查 `useDraft().text.value` 是否非空白，非空白時走
  research.md #11 的確認流程，不得直接覆蓋（憲法 8.4、FR-018）。
- `card.rationale` **MUST NOT** 隨「一鍵帶入」寫入 Composer——只有 `card.text` 會被帶入。

## 重連快照

比照既有 `sendAnalysisSnapshotAndResume()`：SSE 連線建立／重連時，若該對話已有
`CopilotAnalysisState`，一併送出目前的 `suggestionBlock`（不必等下一次變動），理由與摘要/情緒
相同——避免客服重連後在建議卡出現前空等一輪分析。

## 重試 API 契約擴充（`/copilot/retry`）

`specs/001-sentiment-panel/contracts/copilot-retry-api.md` 定義的 `block` 欄位新增合法值
`'suggestions'`：

```ts
POST /api/conversations/{id}/copilot/retry
{ block: 'summary' | 'sentiment' | 'suggestions' }
→ 202 Accepted（既有行為：非同步觸發，結果經 suggestion.updated 送達，不在此回應中）
```

重試建議卡時，`copilot-analysis.ts::retryBlock()` 的 `'suggestions'` 分支使用**全量歷史**
重新檢索知識庫並重新生成（與摘要/情緒的重試語意一致：等同冷啟動的該區塊部分），**不是**重新
評估既有卡片是否被搶答（那是 FR-015 的自動流程，不受此按鈕觸發，見 spec.md FR-024）。
