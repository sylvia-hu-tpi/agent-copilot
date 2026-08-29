# Quickstart: 建議卡的漸進式知識庫引用

驗證本功能端到端行為的手動與自動化路徑。欄位與序列見 `data-model.md`／`contracts/`，本文件只列
**怎麼跑、預期看到什麼**。

## 前置準備

```bash
npm install
npm run typecheck && npm test      # 提交前的最低門檻
npm run build && npm run smoke     # 動到 server/api/**（stream.get.ts 的重連快照）時必跑
```

- 缺 `IMBRACE_*_AGENT_ID` 時退回 Mock provider：`MockKnowledgeProvider` 零延遲回兩筆命中，
  前景兩段會在同一秒內先後落地（`pending` → `cited`），畫面上只看得到最後的 `cited`。
  要在本機**看見**兩段，設 `AC_SMOKE_KNOWLEDGE_DELAY_MS=3000`（只對 Mock 生效，research.md #10）。
- ⚠️ `IMBRACE_ENV=stable` 是正式環境（CLAUDE.md）：對真實對話 JOIN 前先確認對象，並讓使用者知情。

## 自動化測試對照表

| 檔案 | 涵蓋範圍 |
|---|---|
| `test/copilot-analysis.test.ts`（擴充） | 前景兩段序列（contracts §2 每一列各一個 case）；`suggest()` 呼叫次數上限（1 + 重試 + 1 ≤ 4，第二段 0 次重試）；檢索 0 筆／失敗／30 秒逾時 → `none` 且 cards 不動；第二段全數遭白名單捨棄 → `none`；新世代丟棄舊尾巴；第一段 retrying 中第二段先落地 → `cited` 且第一段後到不覆蓋；命中已在手 → 單段無 `pending`；背景 `runIncremental` → 單段、等滿檢索；**第二段整批換卡後搶答標記仍在（FR-015）**；**LEAVE 後尾巴不再送出第二段呼叫且登記被移除**；卡數上限 ≤ 5（FR-012）；`awaitSuggestionTail()` |
| `test/ai-retry-policy.test.ts`（擴充） | `maxRetries: 0` 不重試且不觸發 `onRetry`；`signal` 在退避等待中 abort → `RetryAbortedError`；已在飛的呼叫不受 abort 影響；三個既定數值不變 |
| `test/contract-guards.test.ts`（擴充） | `server/` 不得出現 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`；`shared/` 不得出現 `suggestionTails`／`citedLanded`；`useCopilotSession.ts` 不得 import `useDraft`（FR-008） |
| `test/stream-analysis-visibility.test.ts`（擴充） | 重連快照：`pending` 且無尾巴 → 改送 `none`；有尾巴 → 照送 `pending` |
| `test/nuxt/suggestion-citation-cue.test.ts`（新） | `pending → cited` 轉移觸發提示（圖示＋文字、`role="status"`）、5 秒淡出、快照不觸發、切換對話清除；`pending` 標頭與卡片文案 |
| `test/realtime-http.ts`（擴充，`npm run smoke:realtime`） | 在 `AC_SMOKE_KNOWLEDGE_DELAY_MS` 下，SSE 觀察到 `ready/pending` 早於 `ready/cited`；⚠️ **不含 SC-003 的行為驗證**——此 harness 沒有瀏覽器，量不到 Composer，只能斷言「兩則事件之間不存在任何非 `suggestion.updated` 的對話事件」這個**弱代理** |

> ⚠️ **SC-003（Composer 100% 不被更動）沒有端到端自動化**，這是刻意取捨，不是漏做。
> 現有的三層防護是：① `test/contract-guards.test.ts` 的**靜態**守衛（`useCopilotSession.ts` 不得
> import `useDraft`）；② `test/realtime-http.ts` 的弱代理（上表）；③ **quickstart US2 的手動場景**——
> 唯一真正驗到「帶入後多打字、第二段到達、Composer 一字不變」的地方。
> 本文件原本在上表宣稱 smoke 涵蓋 SC-003，與 tasks.md T024 的自陳互相矛盾，2026-08-29 訂正。

## 手動驗證場景（對照 spec.md Acceptance Scenarios）

### US1：先拿到可用的建議，再拿到有依據的建議（P1）

1. 以測試帳號登入，開啟一段**知識庫有相關內容**的對話（例如問到既有 SOP 主題），按下「加入對話」。
   同時開 DevTools → Network → `stream` 的 EventStream 分頁計時。
2. **預期**：3 秒內建議卡區塊出現並標示產生中；**20 秒內**（90 百分位）第一批卡完整呈現，
   區塊標頭顯示「尚未引用知識庫・檢索中」，每張卡的來源列為「尚未引用知識庫」。
   → 這一步就是 SC-001 的驗收本身，刻意不進自動化（Mock 量不到真延遲，同 002 的取捨）。
3. **預期**：JOIN 後最晚 50 秒內（實測多半 20～30 秒）區塊閃現「已更新為有 SOP 依據的版本」提示
   （圖示＋文字，約 5 秒淡出），卡片整批換成帶 `sopTitle` 的版本；EventStream 上看到
   `ready/pending` → `ready/cited` 兩則。
4. 重複 JOIN 10 段不同對話，統計拿到 `cited` 的比例 → SC-002 要求 ≥ 90%（知識庫有內容的前提下）。
5. 換一段**知識庫沒有相關內容**的對話重做 1～2：第一批卡出現後，標頭在檢索回來時由「檢索中」消失、
   卡片來源列變為「未引用知識庫」，**卡片內容一字不變**（EventStream 上 `ready/none` 的 `cards`
   與前一則相同）。MUST NOT 出現錯誤狀態、MUST NOT 出現重試按鈕。

### US2：更新不得悄悄抽換內容（P1）

1. JOIN 後在第一批卡出現、提示尚未出現時，對任一張卡按「一鍵帶入」，再在 Composer 裡多打幾個字。
2. **預期**：第二批到達（提示閃現、卡片換掉）時，Composer 內容**完全不變**（含你多打的字）；
   重新整理頁面後草稿仍在（憲法 8.4）。
3. **預期**：第二批到達後，面板上**沒有**第一批的任何一張卡（含剛帶入過的那張），
   卡數不超過 5 張。

### US3：背景對話（P2）

1. JOIN 對話 A，切到對話 B（A 變背景）。從客戶端對 A 送一則新訊息。
2. **預期**：伺服器日誌／EventStream 上 A 只出現一次 `ready`（`cited` 或 `none`），
   **沒有** `pending`；`suggest()` 只被呼叫一次（可從 `provenance.stage1RetryAttempt === 0 &&
   stage === 2` 讀出）。
3. 切回 A：立即看到既有卡片（不空白、不從頭產生）；若檢索仍在跑，標頭顯示更新中。

### 邊界：第一段失敗、檢索仍在等

1. 用 Mock：`AC_SMOKE_FORCE_SUGGEST_FAILURE=1 AC_SMOKE_KNOWLEDGE_DELAY_MS=5000` 啟動，JOIN。
2. **預期**：區塊轉 error＋重試按鈕（第一段用盡）。等 5 秒以上再按重試。
3. **預期**（先把 `AC_SMOKE_FORCE_SUGGEST_FAILURE` 移除再按）：直接出現 `cited` 的卡，
   **沒有** `pending`（命中已在手，research.md #3）。

## 延遲基準（plan 前已量，不需重量）

`docs/ARCHITECTURE.md` §8.2b：第一段 p90 10.31 秒（n=15）、第二段最慢 13.0 秒（n=15）、
檢索中位 11.9／p90 16.9／最慢 20.1 秒（n=12）。要重量：
`npm run spike:agent-latency -- suggestion 15`、`-- suggestion-kb 15`、`npm run spike:knowledge-latency`。
⚠️ 延遲比較 MUST NOT 以 n=5 下結論（§8.2b 的方法論教訓）。
