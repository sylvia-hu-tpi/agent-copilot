# Contract: SSE 事件 — `summary.updated` / `sentiment.updated`

**傳輸**：既有 SSE 端點 `GET /api/stream`（`server/api/stream.get.ts`），topic `conversation:{conversationId}`（`shared/types/events.ts` 的 `conversationTopic()`）。本契約新增兩個 `CopilotEvent` 成員，其餘既有事件（`session.opened` 等）不受影響。

**信封**：與既有事件一致，包在 `CopilotEventEnvelope`（`{ id: string, event: CopilotEvent }`）內，`id` 僅供除錯排序，補齊邏輯不依賴它（見 `events.ts` 檔尾說明，本功能不改變此原則）。

## `summary.updated`

```ts
{
  type: 'summary.updated'
  conversationId: string
  summary: SummaryBlock   // 見 data-model.md
}
```

**觸發時機**：

| 情境 | 對應 spec 條目 |
|---|---|
| JOIN 冷啟動開始 | `status: 'analyzing'` 事件立即送出（先於分析完成），對應 FR-011、SC-001 |
| 冷啟動或增量分析成功 | `status: 'ready'`，`summary` 有值 |
| 客戶新訊息觸發增量（debounce 1s 後） | `status: 'analyzing'`（若前一輪已是 `ready`，前端保留舊內容疊加「更新中」，見 data-model.md 呈現規則） |
| 暫時性失敗，進入自動重試 | `status: 'retrying'`，`retryAttempt` 為 1 或 2 |
| 重試用盡／非暫時性失敗 | `status: 'error'` |
| 客服手動重試（見 `copilot-retry-api.md`） | 重新走一次 `analyzing → ready/retrying/error` |
| 對話尚無客戶發言 | `status: 'empty'`（FR-009） |

**消費端保證**：前端收到本事件時 MUST 整塊覆蓋既有 `SummaryBlock` 顯示狀態（不做 partial merge）——上一版內容是否保留由 `status` 語意決定（`analyzing` 時是否保留舊內容屬呈現規則，非本事件契約的責任）。

## `sentiment.updated`

```ts
{
  type: 'sentiment.updated'
  conversationId: string
  sentiment: SentimentBlock   // 見 data-model.md
}
```

**觸發時機**：與 `summary.updated` 對稱（冷啟動、增量、重試、手動重試、empty 狀態），差異點：

- `sentiment.timeline` 隨每次事件攜帶**全量**時間軸（非 patch）——即使伺服端內部的模型呼叫是 patch-only（憲法 6.3，只送新訊息給模型），SSE 對外仍送出合併後的完整陣列，因為前端需要完整 timeline 才能正確渲染最近 50 點與純附件標記的相對位置（FR-015）。此為「模型輸入 patch、事件輸出全量」的刻意設計，兩者不矛盾：憲法 6.3 限制的是**送給模型**的內容，不是**推播給前端**的內容。
- 純附件輪（`SentimentMarker`）不觸發 `status: 'analyzing'`（因為不送模型），但仍會出現在下一次 `sentiment.updated` 的 `timeline` 中（可能與同一批次的其他客戶文字訊息一起送出，也可能單獨送出一次「僅新增 marker」的事件）。

## Zod Schema 驗證邊界

伺服端在 publish 這兩個事件前，`summary`／`sentiment.timeline` 中屬於 AI 直接輸出的欄位（`ConversationSummary` 全部欄位、`SentimentPoint.score`/`label`/`drivers`）MUST 已通過 Zod 驗證（憲法 4.2）。`SentimentMarker` 由管線邏輯直接建構，不含 AI 輸出欄位，不需經過此驗證關卡，但仍需符合 TypeScript 型別。

## 前端整合點

`app/composables/useCopilotSession.ts` 訂閱 `useStreamStore`（既有 `app/stores/stream.ts`）已解析出的 `CopilotEvent`，過濾 `type === 'summary.updated' | 'sentiment.updated'` 且 `conversationId` 相符者，寫入該對話的區塊狀態；`SummaryCard.vue`／`SentimentGauge.vue` 純消費 composable 暴露的 reactive 狀態，不直接碰觸串流。
