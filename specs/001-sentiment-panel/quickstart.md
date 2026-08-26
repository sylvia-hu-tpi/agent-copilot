# Quickstart: 情緒面板驗證指南

驗證本功能是否符合 spec.md 的三個使用者故事與五條成功標準，全程可在本機以 `MockAIProvider` 完成，不需要真實 iMBrace／AI 憑證。

## 前置準備

```bash
npm install
npm run typecheck && npm test     # 先確認既有基準綠燈，再開始開發
```

本功能開發期間 `AIProvider` 一律使用 `server/services/ai/mock-ai-provider.ts`（見 research.md #4），裝配點在既有的 provider 工廠（比照 `KnowledgeProvider` 的裝配方式，見 `ARCHITECTURE.md` §8.2）。

## 情境一：JOIN 後看到摘要卡與情緒 sparkline（User Story 1）

1. `npm run dev` 啟動本機開發伺服器。
2. 以測試帳號登入（沿用既有 `test/mock-gateway.ts` 的假 gateway 模式，或本機 `.env.local` 指向的測試組織）。
3. 開啟一段已有多輪客戶／AI 往來歷史的對話，按下 JOIN。
4. **預期**：3 秒內畫面出現摘要卡與情緒 sparkline 區塊並標示「分析中」（SC-001）；10 秒內兩區塊呈現實質內容（SC-005）；情緒 sparkline 的點數對應歷史上「含文字」的客戶發言輪數，純附件輪呈現為時間軸上的中性標記而非分數點（FR-012）。
5. 換一段目前完全沒有客戶發言的對話重複步驟 3–4，**預期**：兩區塊呈現明確的「尚無資料」狀態（FR-009），非空白、非錯誤外觀。

## 情境二：對話進行中的增量更新（User Story 2）

1. 延續情境一已 JOIN 的對話。
2. 用另一個瀏覽器分頁／測試腳本模擬客戶發送一則新訊息（可用 `test/mock-gateway.ts` 或既有的 realtime 測試手法注入）。
3. **預期**：摘要卡與情緒 sparkline 在 10 秒內反映新訊息（SC-005 同一門檻）；檢查伺服端送給 `AIProvider.summarize()` 的實際輸入（可在 `MockAIProvider` 加臨時 log 或直接斷點），確認只包含既有摘要與新訊息，**不含**完整歷史（FR-004 的驗收方式是檢查輸入內容，不是量測延遲）。
4. 改由客服本人（測試帳號）送出一則回覆，**預期**：兩區塊 MUST NOT 因此觸發重新分析（FR-005）——可觀察 SSE 事件流無新的 `summary.updated`／`sentiment.updated`。
5. 模擬客戶連續發言使情緒標籤落至「挫折」或「生氣」等級，**預期**：下一次面板更新即以顏色＋圖示＋文字三者並呈方式示警（FR-003、SC-003），且該轉折不需客服手動重新整理即可見。

## 情境三：AI 故障時不阻斷主線（User Story 3，本功能驗收重點）

1. 讓 `MockAIProvider` 依測試開關回傳失敗（`summarize()` 或 `analyzeSentiment()` 拋出逾時/5xx 類錯誤）。
2. JOIN 一段對話，**預期**：僅失敗的那一個區塊顯示「暫時無法分析」與重試選項；另一區塊（若成功）、訊息流、Composer 輸入框皆正常可用（FR-006、FR-007）。
3. 在分析仍進行中（尚未回應成功或失敗）時，於 Composer 輸入文字並送出，**預期**：送出不因面板分析狀態被阻擋或延遲（FR-007、SC-002 應為 100%）。
4. 量測自動重試時序（FR-014）——不要只「觀察」，要能給出通過／不通過的判定：
   - 讓 `MockAIProvider` 對指定區塊連續三次拋出 5xx，並在每次被呼叫時記下 `Date.now()`。
   - **通過判準**：共 3 次呼叫（首次 + 2 次重試）；第 1、2 次呼叫的間隔 ≈ 1 秒、第 2、3 次 ≈ 4 秒（容許 ±300ms，涵蓋事件迴圈抖動）；自首次失敗至轉入 `error` 的總時間 ≤ 40 秒；`retrying` 期間兩個區塊皆顯示「重試中 (n/2)」而非「分析中」。
   - 再讓 provider 拋出 401（認證失敗）與一個不符 Zod schema 的輸出，**預期**：兩者皆 **0 次**重試、直接轉 `error`（FR-014 非暫時性）。
   - 最後讓 provider 拋出 429，**預期**：**0 次**重試、直接轉 `error`——M2 不在區塊層級重試 429（全域退避佇列屬 M3，見 spec.md Assumptions）。
   - 精確時序斷言以 `test/ai-retry-policy.test.ts` 的假時鐘為準；本步驟只做端到端的粗略確認，機器負載重時 ±300ms 容差可能不足，此時以單元測試結果為準。
5. 呼叫 `POST /api/conversations/{id}/copilot/retry`（`{"block":"summary"}` 或 `{"block":"sentiment"}`），**預期**：回應 202；隨後該區塊重新走一次分析並透過 SSE 更新，另一區塊內容不受影響（FR-008）。對一個非 `error` 狀態的區塊呼叫應回應 409。

## 自動化測試對照

| 驗證項目 | 測試檔 |
|---|---|
| 重試/退避策略（三類失敗分類、指數退避 1s → 4s、單次逾時 15s、40 秒預算） | `test/ai-retry-policy.test.ts` |
| 純附件輪的中性標記（不產生分數點、時間軸不消失） | `test/sentiment-attachment-turn.test.ts` |
| 冷啟動/增量觸發、debounce、送模型的輸入為 patch 而非全量 | `test/copilot-analysis.test.ts` |
| Zod schema 驗證（`ConversationSummary`、`SentimentPoint` 邊界值） | 併入 `test/copilot-analysis.test.ts` 或獨立檔，視實作時份量而定 |

```bash
npm run typecheck && npm test
```

涉及 `server/api/**` 的新端點（`retry.post.ts`）與 SSE 事件擴充時，依 `CLAUDE.md` 指示一併跑：

```bash
npm run build && npm run smoke
```

`smoke:realtime` 需相應擴充以涵蓋 `summary.updated`／`sentiment.updated` 事件的收斂驗證（見 plan.md Testing 一節），這部分屬於實作階段的任務，不在本 quickstart 涵蓋範圍內。
