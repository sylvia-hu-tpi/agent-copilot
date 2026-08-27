# Quickstart: 建議卡與知識庫快查

驗證本功能端到端行為的手動與自動化路徑。型別與端點細節見 `data-model.md`／`contracts/`，
本文件只列**怎麼跑、預期看到什麼**。

## 前置準備

```bash
npm install
cp .env.local.example .env.local   # 若尚未建立；需補上 IMBRACE_KNOWLEDGE_AGENT_ID、IMBRACE_SUGGESTION_AGENT_ID
npm run typecheck && npm test      # 提交前的最低門檻
npm run build && npm run smoke     # 動到 server/api/**、server/sources/**、server/state/** 時必跑
```

缺少 `IMBRACE_KNOWLEDGE_AGENT_ID`／`IMBRACE_SUGGESTION_AGENT_ID` 時，`useKnowledgeProvider()`／
`useAIProvider()` 會印出警告並退回 Mock 實作——本地開發／CI 皆可在無真實憑證下跑通下列場景
（Mock 回傳固定樣本資料，行為對照見各場景備註）。

## 自動化測試對照表

| 檔案 | 涵蓋範圍 |
|---|---|
| `test/agent-knowledge-provider.test.ts` | research.md #1 的 `RAGknowledge` 輸出解析（含真實樣本 `scripts/spike/out/11-宏宏企業-knowledge-raw.json` 作為 fixture）、#2 的 `title`/`updatedAt` 衍生規則（不含編號） |
| `test/suggestion-whitelist.test.ts` | FR-003 白名單整卡捨棄（research.md #6），含「全數捨棄後仍為 `ready` 狀態」case |
| `test/copilot-analysis.test.ts`（擴充） | `runIncremental` 依 `priority` 決定是否呼叫 `analyzeSummary`；`scheduleIncremental` 依 `priority` 選擇 debounce 長度；`BACKGROUND_CONCURRENCY_LIMIT` 排隊行為 |
| `test/catch-up-summary.test.ts` | research.md #10：重新聚焦時以 `basedOnMessageId` 為錨點補跑摘要，且無新訊息時為 no-op |
| `test/presence-away-joined.test.ts` | contracts/presence-watch-control.md：`away+joined` 語意 |
| `test/stream-reconnect-background.test.ts` | 重連時背景 watch 復原、優先度升級 |
| `test/knowledge-search-api.test.ts` | contracts/knowledge-search-api.md：空白查詢不觸發呼叫、JOIN 門檻、`degraded` 降級 |

## 手動驗證場景（對照 spec.md Acceptance Scenarios）

### US1：建議卡一鍵帶入（P1）

1. 以測試帳號登入，開啟一段已有客戶發言的對話，按下「加入對話」。
2. **預期**：3 秒內面板出現建議卡區塊並標示產生中；10 秒內至少一張建議卡完整呈現，含回覆全文、
   來源（若有）、語氣分類。
3. 按下某張卡的「一鍵帶入」——**預期** Composer 出現該文字、可編輯、未自動送出。
4. 在另一個瀏覽器分頁（或請同事）先行回覆這段對話，接著在原分頁按下送出——**預期**撞單攔截提示
   出現，行為與手動輸入文字送出時一致（沿用既有撞單機制，本功能不改動它）。

### US2：知識庫快查（P2）

1. 同一對話中，於右欄知識庫快查輸入框輸入一段自然語言查詢（例如「發票補寄要多久」）。
2. **預期** debounce 300ms 後顯示結果列表，每筆含標題、更新日期（或「更新日期未知」）；
   **不**顯示原始分數數字，也不顯示獨立編號（research.md #2：iMBrace 知識庫沒有正式編號制度）。
3. 點擊「插入為回覆」——**預期** Composer 出現該筆結果**本次命中的片段原文**（非全文），未經
   AI 改寫。
4. 點擊「展開全文」——**預期**在不遮蔽訊息流的前提下顯示更多內容，並標示「本次可取得的相關內容，
   可能未涵蓋完整文件」（research.md #3 已知限制）。
5. 清空輸入框——**預期**回到「尚未輸入查詢」狀態，與「查無相關結果」視覺可區分。
6. 輸入一段刻意查不到結果的字串——**預期**明確顯示「查無相關結果」。

### US3：AI／知識庫故障降級（P1）

1. 以 `MockAIProvider`／`MockKnowledgeProvider` 的故障開關（比照
   `specs/001-sentiment-panel` 既有的 `summarizeFailure`/`sentimentFailure` 模式）模擬建議卡生成
   失敗。
2. **預期**：僅建議卡區塊顯示「暫時無法產生建議」＋重試；訊息流、Composer、知識庫快查不受影響。
3. 模擬知識庫檢索失敗但建議卡生成本身可用——**預期**建議卡改為無引用的通用建議並標示
   「未引用知識庫」。
4. 模擬知識庫快查服務失敗——**預期**快查區塊顯示錯誤＋重試，其餘區塊不受影響。

### US4：多對話背景更新（P2，本功能風險最集中的場景）

1. 客服 JOIN 對話 A，等待建議卡首次生成完成。
2. 切換側欄至對話 B 並 JOIN（A 成為背景對話）。
3. 對對話 A 注入一則新客戶發言（測試工具或請同事在官方介面代為發送）。
4. **預期**（可用 `npm run smoke:realtime` 的擴充版或手動核對 `server/services/copilot-analysis.ts`
   的日誌／`GET /api/conversations/A` 觀察）：對話 A 的情緒與建議卡在背景重新計算，**摘要不重算**。
5. 切回對話 A——**預期**立即顯示已更新的情緒與建議卡，不重新產生讓客服再等一次；摘要區塊短暫顯示
   「更新中」後補上涵蓋新發言的內容。
6. 重複步驟 2–3 直到已 JOIN 對話數達到背景並行上限（測試環境可調低
   `BACKGROUND_CONCURRENCY_LIMIT` 加速驗證）——**預期**超額對話僅累積訊息計數，不顯示為錯誤狀態，
   待有名額釋出後才補算。
7. **關鍵回歸檢查**：整個場景中途重新整理瀏覽器（模擬斷線重連）——**預期**背景對話的分析結果仍
   保留（`CopilotAnalysisState` 的 2 小時 TTL 不受 SSE 連線影響），且重新整理後對話 A／B 皆恢復
   為原本的前景／背景 watch 狀態（`contracts/presence-watch-control.md` 的重連復原機制）。

## 已知限制（驗證時預期看到、非缺陷）

- 知識庫快查的「展開全文」不保證涵蓋整份文件內容（research.md #3）。
- `KnowledgeHit.updatedAt` 對檔名不含可辨識日期片段的條目會是 `null`，顯示「更新日期未知」而非
  觸發過舊提醒（research.md #2）。
- 知識庫來源不顯示獨立編號，只顯示標題——iMBrace 平台本身沒有正式的 SOP 編號制度，硬湊一個只是
  呼應設計稿的過度設計（research.md #2）。
