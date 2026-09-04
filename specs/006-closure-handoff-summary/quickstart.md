# Quickstart：結案摘要與人審面板的驗證指南

**Spec**: [spec.md](./spec.md) ｜ **Plan**: [plan.md](./plan.md) ｜ **Date**: 2026-09-03

> 本檔只講**怎麼證明它會動**。欄位形狀看 [data-model.md](./data-model.md)，
> 端點規則看 [contracts/closure-http-api.md](./contracts/closure-http-api.md)，
> Board schema 看 [contracts/closure-board-schema.md](./contracts/closure-board-schema.md)。

---

## 0. 前置作業（兩項在 repo 外，MUST 先確認）

| # | 項目 | 怎麼確認 | 沒有它會怎樣 |
|---|---|---|---|
| ① | **`AgentCopilot_結案摘要_agent`** 已在 iMBrace 後台建立，`IMBRACE_CLOSURE_AGENT_ID` 已寫進 `.env.local` | `npm run spike:agent-prompts` 印出五個 agent 而非四個 | 真 AI 路徑跑不了。⚠️ **US1～US3 的驗收改用 `MockAIProvider` 仍可全數完成**（research #1） |
| ② | **Data Board 已建立**，`IMBRACE_CLOSURE_BOARD_ID` 已寫進 `.env.local` | `npm run board:verify` 離開碼 0 | 寫入路徑跑不了 |

```bash
npm run board:setup      # 建立 Board 與全部欄位，印出 IMBRACE_CLOSURE_BOARD_ID
npm run board:verify     # 只比對、不寫入；缺欄以非零離開
```

⚠️ **`IMBRACE_ENV=stable` 是正式環境**（`CLAUDE.md`）。`board:setup` 會在真實組織建立一個 Board。
第一次執行前 MUST 讓使用者知情。

---

## 1. 綠燈基線（每次提交前）

```bash
npm run typecheck && npm test
```

動到 `server/api/**`、`server/services/closure/**` 時**一併跑**：

```bash
npm run build && npm run smoke
```

⚠️ `smoke` 會掃描每個回應確認憑證不外洩 —— FR-035 的自動化驗收就靠它。

---

## 2. 逐條 SC 的驗證方式

### SC-001 ／ SC-006：只有人按下寫入才會有紀錄

```bash
npx vitest run test/closure-commit-guard.test.ts test/closure-leave-no-write.test.ts
```

- 前者斷言 `commit` 端點只被寫入按鈕的處理函式呼叫（契約 R3.1 的守衛）。
- 後者對 `/leave` 觸發 20 次，斷言 Board 端 `createItem` 呼叫次數為 **0**，
  且 003 SC-002（離開後 5 秒內不再產生新分析）仍 20/20 通過。

**人工複驗（US1 AC#3）**：開啟結案面板後**完全不操作**放置 10 分鐘，
確認 Board 上沒有任何紀錄。⚠️ 這條沒有自動化替代品 —— 它驗的是「沒有閒置自動寫入路徑」。

### SC-002：同一份草稿重試 10 次仍恰好一筆

```bash
npx vitest run test/closure-idempotency.test.ts
```

假 gateway 對前 9 次寫入注入逾時（但**實際建立紀錄**），第 10 次成功。
斷言：`draft_id` 對應的紀錄恰好 1 筆，且內容是**最後一次**送出的版本（FR-030c）。

⚠️ 同一份測試 MUST 另含 US2 AC#3 的反面：兩份**不同** `draftId` 寫入同一對話 → **2 筆並存**、
先寫那筆內容未被更動。兩個斷言放同一檔，是為了讓「把冪等鍵改回 `conversation_id`」
這個改動一定會弄紅其中一邊。

### SC-003：四種失敗形態，畫面顯示成功 0 次

```bash
npx vitest run test/closure-write-failures.test.ts test/nuxt/closure-store-failures.test.ts
```

四種各注入 10 次（逾時、4xx、5xx、200 但回查不存在），分兩層：
repository 層（`test/`）斷言 `commitClosure()` 拋錯、`failKind` 正確、錯誤帶 `reqId`（FR-035a）；
store 層（`test/nuxt/`，因為它 import `app/stores/closure.ts`）斷言 store 回到 `ready`、
`draft` 內容逐欄未變、條目仍在（面板不關）、沒有任何 `/leave` 呼叫。

⚠️ 5xx 是**真注入**（`failWith.create = 503`）：SDK 對 5xx 寫死退避重試 3 次、約 7 秒且不可關閉，
因此 10 次以不同 `draftId` 並行、該組 timeout 放寬到 15 秒，並額外斷言 `create` 被呼叫 40 次
（重試耗盡後仍是失敗，不是被吞成成功）。MUST NOT 以 4xx 代替 —— 那會讓 SC-003 的 5xx 一格從未被驗到。

另斷言 `failKind` 的分派（FR-032c）：前三種為 `failed`（畫布 B7），
第四種為 `unverified`（畫布 B8）。⚠️ 但四種的 **store 狀態轉移必須完全相同** ——
`failKind` 只切文案與按鈕；若測試發現 `unverified` 走了不同的狀態路徑，那就是 FR-032c 要防的事。

⚠️ **第四種是本規格最重要的一條測試**（契約 R3.5）。假 gateway 的 `createItem` 回 200，
`getItem` 回 404。少了這條，「Board 上其實沒有」永遠不會被發現。

### SC-004：等待期間 100% 誠實（**不是**秒數門檻）

```bash
npx vitest run test/nuxt/closure-wait-honesty.test.ts
```

任意 20 次產生（涵蓋短、中、長三種區間）中，斷言三個 0：
畫面顯示「已完成」而實際未完成 **0** 次、顯示會過期的時間承諾 **0** 次、
產生期間無法取消 **0** 次（FR-046a、FR-040a）。

⚠️ **固定秒數門檻已於 2026-09-03 撤銷**（spec.md SC-004 有完整理由）——
結案摘要的耗時由涵蓋區間長度決定，訂任何秒數都是錯的口徑。
容量規劃參考值：短區間（9 則）中位數 9.4 秒（`spike:closure-agent`，n=8）；
長區間逾 1 分鐘可接受。**這個數字 MUST NOT 回頭變成驗收門檻。**

⚠️ **但寫入路徑仍有硬門檻**（FR-032a，30 秒），且它是 FR-040a「寫入中不可取消」的成立前提：

```bash
npx vitest run test/closure-write-timeout.test.ts test/nuxt/closure-store-failures.test.ts
```

假 gateway 讓寫入永不回應，斷言 30 秒內轉為失敗（repository 層）、草稿仍在、
`writing` 期間取消鍵鎖住、落定後恢復可用（store 層，在 `test/nuxt/`）。
⚠️ 少了這條，客服會被困在一個既不能取消、也不會自己結束的狀態裡。

### SC-005：3 位未參與者說得出兩個出口的差別（＝重跑 003 SC-007）

**人工驗收，無自動化替代。** 給受測者看中欄底部的兩顆按鈕與 `conversation.exitHint`
那一行文案，在**按下之前**請他們說出「哪一個會留下紀錄」。3/3 通過才算過。

⚠️ FR-003 逐字要求「重新驗證而非再次結案」—— 這條 MUST 在 `tasks.md` 有獨立任務。

### SC-006a：涵蓋區間四個代表情境各 5 次、正確率 100%

```bash
npx vitest run test/closure-scope-selection.test.ts
```

四個情境（對照 spec.md SC-006a）：

| # | 情境 | 期望 |
|---|---|---|
| ① | 同一聊天室的第 N 次服務 | 選中最近一次 `closedAt`，不含前幾輪 |
| ② | 同事五分鐘前剛結案（0 則），我也要結案 | 預設**跳過** 0 則那列，落到下一個；0 則那列不可選但看得見 |
| ③ | 客戶昨天 17:35 發言、今天 10:15 才有人接 | 同一區間，不因跨天被切開 |
| ④ | 該對話從未被結案過 | 落到「從第一則起算」，並顯示 FR-021e 的告知 |

⚠️ ③ 是**反例測試**：它證明實作沒有偷偷加上時間間隔（gap）門檻。
gap 規則會在這個情境下切錯，而切錯不會報錯（§13.4 ④）。

### SC-006b：每筆紀錄帶區間，且以該區間重算情緒數值一致

```bash
npx vitest run test/closure-sentiment-range.test.ts
```

造一條**跨兩個區間**的 timeline，前一區間含全局最低分。斷言：
`sentimentTrough` 等於**本區間內**的最小值，**不等於** `sentimentBlock.stats.lowestScore`。

⚠️ 這條測試的存在理由是它會抓到一個型別檢查抓不到的錯：
兩個值都是 `number`，寫錯只會讓報表把「近期最低點」當成「本次最低點」（FR-022a）。

同一檔另含 FR-022b：timeline 未涵蓋 `periodStart` 時，三個數值**一起**為 `null`
且 `sentimentNote` 有值；斷言 `null` 與 `0` 在寫入 body 中可區分。

### SC-007：setup script 可重跑、驗證模式指得出缺漏

```bash
npm run board:setup      # 第一次：建立
npm run board:setup      # 第二次：MUST NOT 產生重複欄位
npm run board:verify     # 齊全 → 離開碼 0
# 手動在平台上刪掉一欄，再跑：
npm run board:verify     # → 逐欄印出缺少的欄位名稱，離開碼非 0
```

### SC-008：文案與行為的落差為 0

逐句對照 `conversation.exitHint`（`i18n/locales/zh-TW.json`）：

| 文案分句 | 對應行為 | 驗法 |
|---|---|---|
| 「離開＝僅退出不寫入」 | `/leave` 不產生摘要、不寫 Board | SC-006 的測試 |
| 「結案＝產生摘要供確認後寫入」 | 結案開面板 → 人審 → 明確按下才寫 | SC-001／SC-003 的測試 |

⚠️ FR-002 要求「若有任何殘餘落差，MUST 在本規格內修正其中一方」——
落地後若行為與文案仍不一致，改文案或改行為都可以，但**MUST NOT 留下第二筆帳**。

---

## 3. 端到端手動走查（最短路徑）

```bash
npm run dev
```

1. 登入 → 選一通**有客戶發言**的對話 → 「接手對話」。
2. 按「結案」→ 右欄第 6 區塊**憑空出現並置頂**，其餘五塊收合成單行（FR-047a）。
3. 檢查涵蓋範圍選擇器：候選降冪、每列有則數、安全網墊底、預設選中則數 > 0 的最上面那列。
4. **改選另一個區間** → 摘要重新產生（不得沿用舊內容，FR-021g）。
5. 改掉其中一個可編輯欄位；確認唯讀欄位（情緒三數值、參與客服、時間）**點不動**（FR-010a）。
6. 此時到 Data Board 上確認**還沒有任何紀錄**（FR-011、US1 AC#1）。
7. 按「一鍵寫入 CRM」→ 成功後自動離開對話 → 第 6 區塊消失（FR-047b）。
8. 回 Data Board 確認：內容是**改過之後**的、`reviewed_by`／`reviewed_at` 有值、
   `period_start`／`period_message_count`／`period_origin` 有值。

### 中途要驗的三件事

- **結案期間送訊息**：輸入框**不鎖**，橫幅在（FR-042）；送出後摘要**不自動更新**，
  只出現「對話有新內容，建議重新產生」（FR-020、FR-044）。
- **結案期間切走再回來**：左側清單該對話有「未完成的結案」標記（FR-041）。
- **重新整理頁面**：等同取消結案 —— 回到 JOIN 狀態、面板照常展開、
  第 6 區塊不見、各區塊重新分析、Board 上沒有紀錄（FR-040、US1 AC#5）。

⚠️ **手動走查期間 MUST NOT 編輯 `server/**`** —— Nitro 熱重啟會清空 process-local session，
所有分頁跳回登入頁，症狀酷似產品缺陷。

---

## 4. 跨 spec 熱點檔案的複審（spec.md 驗收補充要求 2）

本規格會動到 003 已定案的結案出口與分析門檻。綠燈之後 MUST 另審一次：

| 檔案 | 為什麼是熱點 | 要確認什麼 |
|---|---|---|
| `app/composables/useConversationView.ts` | `closeConversation()` 由「先 leave」改為「只開面板」 | 003 FR-022a 的「獨立行為路徑」仍成立；M3 銜接註解已改寫（research #16） |
| `server/services/copilot-analysis.ts` | FR-005：結案期間分析照常 | **沒有**為結案新增第二個門檻條件（003 FR-012 維持單一條件） |
| `test/contract-guards.test.ts` | 新增三條守衛 | 既有守衛一條都沒被弱化 |
| `shared/types/conversation.ts` | `PresenceEntry.closing` | `PresenceState` 仍是三值（research #18） |

---

## 5. 已知落差（落地後仍存在，MUST 誠實回報）

| 落差 | 現況 | 出處 |
|---|---|---|
| 長區間算不出情緒數值 | 評分點不齊時三值留空並標示涵蓋範圍 | 憲法 5.3 附註「情緒分析結果的保留期限」🔴 未拍板 |
| 429 無全域退避佇列 | 直接轉錯誤狀態供手動重試 | `IMBRACE_QUESTIONS.md` G-2 🔴 未回覆 |
| 交接摘要不存在 | `HandoverSummary` 規劃中、未實作 | §13.4 ②、FR-016a |
| 平台對話狀態不變更 | 結案 ＝ 寫入 ＋ LEAVE | spec.md「明確排除」 |
