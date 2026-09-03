# Contract: `POST /api/conversations/[id]/copilot/retry`

對應 FR-008：客服對失敗區塊手動觸發重試，且只重新運算該區塊，不影響另一區塊已顯示的內容。

## Request

```
POST /api/conversations/{conversationId}/copilot/retry
Content-Type: application/json

{ "block": "summary" | "sentiment" }
```

**驗證**（`server/utils/validate.ts` 既有的 Zod 驗證慣例）：

- `conversationId`：沿用 `server/utils/conversation-param.ts` 既有的路徑參數解析與驗證。
- `block`：僅接受 `'summary' | 'sentiment'`，其他值回 400。

**授權**：沿用既有 session 驗證中介層（比照 `server/api/messages/index.post.ts` 的模式）——僅要求呼叫者持有有效 session；不要求呼叫者是該對話的 JOIN 者本人（面板對所有正在檢視該對話的客服共享同一份 `CopilotAnalysisState`，任何看得到錯誤狀態的人都應該按得到重試，比照該對話本身的協同精神，不另設「誰能重試」的權限層）。

## Behavior

1. 讀出該對話的 `CopilotAnalysisState`（`StateStore.getAnalysisState()`，見 data-model.md；與 `CopilotSession` 是不同物件）。
2. 若目標區塊當前 `status` 不是 `'error'`，回應 409（避免重複觸發同一次仍在進行中的分析；`analyzing`／`retrying` 狀態下再按重試沒有意義，因為系統本來就在跑）。
3. 若為 `'error'`，觸發 `copilot-analysis.ts` 對該區塊重新執行一次完整分析流程（等同冷啟動的該區塊部分，使用當前對話全量歷史，而非增量），並回應 202（非同步——結果透過既有 SSE 事件送達，本端點本身不等待分析完成才回應，避免客服的重試按鈕被迫等待最長 40 秒的重試預算）。

## Response

| 狀態碼 | 情境 |
|---|---|
| 202 Accepted | 已接受重試請求，結果將透過 `summary.updated` / `sentiment.updated` SSE 事件送達 |
| 400 Bad Request | `block` 參數無效 |
| 404 Not Found | 對話不存在，或該對話尚無 `CopilotAnalysisState`（從未 JOIN 或分析從未觸發過） |
| 409 Conflict | 目標區塊目前不是 `error` 狀態，重試請求被忽略 |
| 401 Unauthorized | Session 過期，比照既有其他 API 的 401 處理（前端導回登入，保留 `conversationId`，憲法 3.3③） |

## 為何不做成同步等待結果

若端點同步等到分析完成才回應，客服按下重試後最長要等 40 秒（FR-014 的重試預算）才有 UI 回饋，這本身就違反了「AI 故障不得拖慢主線」的精神——即使這次是使用者主動觸發、不是被動阻斷。非同步＋SSE 推播讓「重試中」狀態能立即反映在 UI 上（202 回應後，下一個 `summary.updated`／`sentiment.updated` 事件很快就會是 `status: 'analyzing'`），與冷啟動、增量更新走同一套狀態呈現邏輯，前端不需要為「手動重試」另寫一套等待邏輯。
