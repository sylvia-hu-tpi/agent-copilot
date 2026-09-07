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

**人工驗收，無自動化替代。** 給受測者看中欄上方狀態列的兩顆按鈕與 `conversation.exitHint`
那一行文案，在**按下之前**請他們說出「哪一個會留下紀錄」。3/3 通過才算過。

⚠️ FR-003 逐字要求「重新驗證而非再次結案」—— 這條 MUST 在 `tasks.md` 有獨立任務。

✅ **狀態（2026-09-07）：已執行並通過，3/3**，見 §6.4。⚠️ 受測者代號與逐字回答未留存，
因此本項的證據是「使用者回報 3/3」而非可重播的紀錄。本節保留的是「複驗時怎麼做」——
素材：截圖只裁到兩顆按鈕 ＋ 那行文案（不含對話 ID、服務模式列、presence、訊息內容，
任一項都會把受測者的注意力導開或直接洩題）；狀態條件：受測者看到的畫面 MUST 是**已接手、
未進入結案流程**（沒接手則該行文案根本不顯示，按下結案後按鈕會換成「取消結案／結案中…」）；
問句逐字：「這是客服系統裡一條對話的上方。你現在要離開這條對話。這兩顆按鈕，哪一個會在系統裡
留下紀錄？為什麼？」一人一場、不解釋「紀錄」是什麼、記下回答原話。

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
  ⚠️ **並確認過期標記 MUST NOT 憑空出現** —— 切到別的對話、切到別的瀏覽器分頁、
  斷網重連，這三個動作都會讓 pipeline 重建、`messages.appended` 整批重送
  （§9.5 ③）。**沒有人發訊息就不該出現「對話有新內容」**，而觸發它的是離開畫面的
  動作、不是對話本身，客服事後完全對應不起來（2026-09-07 回報並修正）。
- **重新整理頁面**：等同取消結案 —— 回到 JOIN 狀態、面板照常展開、
  第 6 區塊不見、Board 上沒有紀錄（FR-040、US1 AC#5）。
  ⚠️ **各區塊 MUST 沿用既有分析結果** —— 摘要不出現「更新中」、內容不變；
  僅當有客戶發言尚未被摘要涵蓋時補跑一次摘要，其餘區塊不重跑。連續重新整理 2～3 次都應如此。
  ⚠️ 本項的措辭於 2026-09-07 訂正（原為「各區塊重新分析」，是 M2 時代的殘留）——
  006 之後結案不再停止分析（FR-005），**照舊措辭打叉會把正確行為判成失敗**。

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

---

## 6. 驗收紀錄（2026-09-04 落地）

> ⚠️ **本節只記「實際跑過的結果」，未跑過的一律標成「⬜ 待執行」而不是留白。**
> 留白會被下一個人讀成「跑過了、只是忘了寫」—— 那正是 003 SC-007 在 2026-08-28 被
> 「結案而非驗證」的同一個形狀（`specs/003-analysis-trigger-policy/tasks.md` T052 的 SC-007 一列）。
> ⚠️ 該項已於 **2026-09-07** 由本規格的 SC-005 補驗通過，見 §6.4。

### 6.1 綠燈基線

| 指令 | 結果 | 備註 |
|---|---|---|
| `npm run typecheck` | ✅ 通過 | `nuxt typecheck` ＋ `tsc -p tsconfig.scripts.json` |
| `npm test` | ✅ **53 檔 671 項全數通過** | 落地前為 43 檔 559 項 |
| `npm run build` | ✅ 通過 | |
| `npm run smoke` | ✅ M0＋M1 兩支全數通過 | 含三支結案端點的 401 與憑證外洩掃描 |
| `grep -rn "@imbrace/sdk" app/ shared/` | ✅ 無違規 | 唯一命中是 `app/utils/operator-id.ts` 的**註解**（說明為何不 import），憲法 1.2 守衛未被破壞 |

> ⚠️ **上表是 2026-09-04 落地當時的數字。** §6.8 六項與其後的修正各自補了測試，
> 2026-09-07 全部重跑仍全綠：`typecheck` ✅、`npm test` **58 檔 726 項** ✅、`build` ✅、
> `smoke`（`flow` ＋ `realtime`）✅。⚠️ 則數會隨後續 commit 再變 —— 有疑慮時重跑，不要引用這個數字。

### 6.2 逐條 SC

| SC | 狀態 | 依據 |
|---|---|---|
| **SC-001** 只有寫入按鈕會呼叫 commit | ✅ 自動化通過 | `test/closure-commit-guard.test.ts`：`/closure/commit` 在 `app/**` 恰好出現一次，且在 `app/stores/closure.ts` |
| **SC-002** 同一份草稿重試 10 次恰好一筆 | ✅ 自動化通過 | `test/closure-idempotency.test.ts`：前次逾時（紀錄已建立）→ 後續走 update → Board 上 1 筆、內容為第 10 版、第 10 次 `created === false`。另驗兩份草稿 2 筆並存、`q` 命中他人紀錄時仍走 create（`update` 呼叫 0 次） |
| **SC-003** 四種失敗形態畫面顯示成功 0 次 | ✅ 自動化通過 | repository 層 `test/closure-write-failures.test.ts`（逾時／4xx／**真 5xx**／回查不存在各 10 次）＋ store 層 `test/nuxt/closure-store-failures.test.ts`（四種的狀態轉移**完全相同**，只有 `failKind` 不同）。5xx 那組 `create` 被打 **40 次**（10 × 4），證明重試耗盡後仍是失敗 |
| **SC-004** 等待期間 100% 誠實 | ✅ 自動化通過 | `test/nuxt/closure-wait-honesty.test.ts`：三種區間長度共 20 次，完成前 `status` 從未是 `ready`；`closure.*` 文案掃描無「N 秒／約 N」承諾；`generating` 期間 `canCancel === true` 且 `cancel()` 使在途請求 `AbortSignal.aborted === true` |
| **SC-005** 3 位未參與者說得出兩個出口的差別 | ✅ **通過（2026-09-07，3/3）** | 3 位受測者在按下之前皆說得出哪一個會留下紀錄。⚠️ 曾於 2026-09-04 被決定放行（未執行），該狀態已由本次實測取代 —— 連帶 003 SC-007 也由「結案而非驗證」轉為**驗證通過**。⚠️ 受測者代號與逐字回答未留存，見 6.4 |
| **SC-006** LEAVE 不寫入 | ✅ 自動化通過 | `test/closure-leave-no-write.test.ts`：LEAVE 20 次 → Board `create`／`update`／`search` 皆 0 次、`summarizeClosure()` 0 次；003 SC-002 重跑 20/20 |
| **SC-006a** 涵蓋區間四情境各 5 次 | ✅ 自動化通過 | `test/closure-scope-selection.test.ts`：含「跨夜同一段服務不得被切開」的**反例**與「截斷是逐個候選」的斷言 |
| **SC-006b** 區間內情緒數值 | ✅ 自動化通過 | `test/closure-sentiment-range.test.ts`：`trough` ≠ 全局最低；「部分有值」窮舉 25 個起點皆不可能出現；`null` 不進 body 而 `0` 進 body |
| **SC-007** setup script 指得出缺漏 | ✅ **自動化 ＋ 真實環境皆通過** | `test/closure-board-verify.test.ts`：**逐欄窮舉** 26 欄，移除任一欄都被指出。真實環境的執行紀錄見 6.4 |
| **SC-008** 文案與行為落差為 0 | ✅ 已對照（見 6.3） | |

### 6.3 FR-002／SC-008 的文案對照結論（T033）

逐句對照 `i18n/locales/zh-TW.json` 與 T029 之後的實際行為：

- `conversation.exitHint`「離開＝僅退出不寫入 · 結案＝產生摘要供確認後寫入」
  → ✅ **現在成立**。`closeConversation()` 只開面板，寫入成功後才 LEAVE。
- `conversation.closing`「結案中…」→ ✅ 語意不變（標題列的結案中標示）。
- `conversation.closeFailed`「結案失敗」→ ❌ **已刪除**。
  它的舊語意是「`closeConversation()` 裡那次 LEAVE 失敗」，而那條路徑在 006 之後不存在。
  新的對應是 `closure.scopesError`「無法載入結案紀錄」。
  ⚠️ **刪掉而不是改寫**：那個鍵在 `app/**` 已無人引用，留著就是第二筆帳。

### 6.4 人工驗收（T046 ✅ 已執行｜T052 ✅ 2026-09-07 通過｜T053、T054 ✅ 2026-09-07 第二輪重跑通過）

> ⚠️ **T046 已於 2026-09-04 執行完畢（使用者知情後），紀錄見 6.4.1。**
> 其餘三項**無法自動化**：它們驗的是「人讀不讀得懂」「一條不存在的路徑真的不存在」
> 與「真實瀏覽器 ＋ 真實 AI 的整段流程」。
>
> ✅ **T052 已於 2026-09-07 實際執行並通過（3/3）** —— 3 位受測者在按下之前皆說得出
> 「離開不留紀錄／結案會留紀錄」。它曾於 2026-09-04 被決定放行（訪談未執行），
> **那個狀態已由本次實測取代**：SC-005 與 003 SC-007 至此都是「驗證通過」。
> ⚠️ **受測者代號與逐字回答未留存**（使用者回報結果），因此這條的證據不可重播 ——
> 日後若 PM／SA 要複驗，素材與問句見 §2 SC-005，不必重新準備。

| 任務 | 內容 | 為什麼不能自動化 |
|---|---|---|
| **T052**（SC-005）✅ **2026-09-07 通過（3/3）** | 找 **3 位未參與本專案**的人，只給看兩顆按鈕與 `conversation.exitHint`，**在按下之前**請他們說出「哪一個會留下紀錄」—— 3 位皆答對。⚠️ 曾於 2026-09-04 被決定放行（未執行），已由本次實測取代；受測者代號與逐字回答未留存 | 驗的是「沒看過規格的人讀不讀得懂」，任何自動化都會偷看到答案 |
| **T053**（US1 AC#3）✅ **2026-09-07 通過** | 開啟結案面板後**完全不操作**放置 10 分鐘，確認 Board 上沒有任何紀錄 | 驗的是「沒有閒置自動寫入路徑」—— 一條不存在的路徑無法用測試證明不存在，只能實際等 |
| **T054** ✅ **2026-09-07 通過** | 走查 §3 步驟 1～8 ＋「中途要驗的三件事」 | 需要真實瀏覽器與真實 AI |

#### 6.4.1　T046 執行紀錄（✅ 2026-09-04，`IMBRACE_ENV=stable`，使用者知情後執行）

`IMBRACE_CLOSURE_BOARD_ID=265c78a1-4840-4c49-a12b-b5b2903c5c11`（已寫進 `.env.local`）

| 步驟 | 輸出 | 離開碼 |
|---|---|---|
| ① `board:setup` 首跑 | **失敗** —— 建 board 成功、建到第 6 欄（`period_origin`，第一個 SingleSelection）時 400。見下方「首跑抓到的事」 | 1 |
| ② 修正後 `board:setup` | 補建 21 欄 → `✅ 26 個欄位齊全`／`結果：通過` | 0 |
| ③ `board:setup` 再跑一次（驗 B1 冪等） | **一欄都沒補**，直接 `✅ 26 個欄位齊全` | 0 |
| ④ `board:verify` | `✅ 26 個欄位齊全`／`結果：通過` | 0 |
| ⑤ 刪掉 `sentiment_trough` 後 `board:verify` | `❌ 缺少 1 個欄位：- sentiment_trough (Number)`／`結果：不通過（缺 1、型別不符 0、選項不符 0、無選項 0，共 1 項）` | **1** |
| ⑥ `board:setup` 補回該欄 → `board:verify` | `✅ 26 個欄位齊全`／`結果：通過` | 0 |

⑤ 就是 SC-007 的驗收證據：**逐欄指名**（不是只說「不通過」）＋ **非零離開碼**。
④ 的通過同時代表選項比對是有效的 —— `optionMismatch` 與 `optionsEmpty` 都是 0，
表示 26 欄的選項讀得回來且與 `config/categories.ts` 逐字相符。

**首跑抓到的事（第四條 SDK 落差，已寫進契約 §2）**：
SDK 的 `CreateFieldInput` 宣告 `options?: unknown[]`，但**平台不吃這個 key，且是靜默忽略**
（回 200、欄位建起來了、就是沒有選項）。正確的是 `data: [{ value: '…' }]`。

⚠️ 這同時**訂正了 spike 29 留下的一個錯誤推論**：它送 `options`、回讀時讀不到選項，
結論被寫成「平台不回選項」。真正的原因是它送錯 key。兩者的差別很重要 ——
前者會讓 `--verify` 的選項比對變成一項「驗不了的事」（B4 就此失效），
後者是一個**修得掉**的落差。`diffBoardFields()` 的 `optionsUnreadable`（不計入不通過）
因此改名為 `optionsEmpty` 並**計入不通過**。

⚠️ 順帶修掉的第二件事：首跑失敗時 board 已經建好，但 id 還沒印出來 ——
執行的人手上沒有它，只能回平台 UI 翻。這與 `spike:board-write` 那次留下孤兒 board
是**同一個形狀**（「印出 id 的前提是後面每一步都成功」）。
setup script 現在**建立成功就立刻印出 id**。

⚠️ **走查期間 MUST NOT 編輯 `server/**`** —— Nitro 熱重啟會清空 process-local session，
所有分頁跳回登入頁，症狀酷似產品缺陷。

#### 6.4.2　T053／T054 執行紀錄（✅ 2026-09-07 第二輪重跑，`IMBRACE_ENV=stable`）

第一輪（2026-09-04）在有缺陷的畫面上進行，§6.8 六項修完後依該節要求重跑。
走查對話 `conv_b28f568a-…`（TWN#GW4772，第一輪也用過，故 Board 上會出現第二筆＝US2 AC#3 預期）。
事前基線：`board:verify` 26 欄齊全離開碼 0、`typecheck`／`test`／`build`／`smoke` 全綠、
Board 事前快照 **2 筆**（皆為 2026-09-04 第一輪留下）。

| 項目 | 結果 |
|---|---|
| **T053**（US1 AC#3） | ✅ 閒置 12 分鐘（≥ 10）。第 10 分鐘與「重新整理後」各一次快照，兩次都是 **2 筆**，id 與 `created_at` 逐字未變。第 5 分鐘那次未執行 —— 那是便利檢查，不是驗收條件 |
| **T054 步驟 1～8c** | ✅ 全數通過。步驟 6（編輯過欄位、尚未寫入）Board 仍 2 筆；步驟 8 寫入後 3 筆、內容是改過之後的、`reviewed_by`／`reviewed_at`／`period_start`／`period_origin` 有值；8c 把畫面上的則數與 Board 的 `period_message_count` 逐字比對相符 |
| **T054 中途三件事** | ✅ A（送訊息：輸入框不鎖、摘要不自動更新只出過期標記）、A2（過期時「重新產生」為主要鍵）、B（Sidebar「未完成的結案」標記）、C／C2／C3（重新整理等同取消，且各區塊**沿用既有結果不重跑**）全數通過 |

⚠️ **第一次嘗試走到步驟 4b 被 dev server 重啟打斷**（`nuxi prepare` 移除 `.nuxt/dist`，
process-local session 全空 → 所有分頁被導去 `/login`）。那是一次非計畫的「取消」路徑，
Board 確認仍 2 筆 —— 但那只是 FR-011 的**旁證，不等於步驟 6 通過**，因為步驟 6 驗的是
「編輯過欄位、但還沒按寫入」那一刻。修掉當時發現的問題後**從步驟 1 完整重跑**，上表是重跑結果。
**重跑走查期間 MUST NOT 跑 `typecheck`／`build`／`smoke`，也不要編輯 `server/**`。**

⚠️ **C2 的判準當時與 §3 的字面不同。** §3 與 spec.md US1 AC#5 原寫「各區塊重新分析」，
那是 M2 時代（結案先 LEAVE、停止分析，重新整理必然冷啟動）的殘留；006 之後分析從未停止，
正確行為是**沿用既有結果**。走查依更正後的判準判定。
**三處措辭已於 2026-09-07 一併訂正**（`spec.md` US1 AC#5、§3、`tasks.md` T054），
兩者不再有落差 —— 下一輪走查照字面驗即可。

##### 走查之後補修的一項（不在上表的通過範圍內）

⚠️ **「對話有新內容，建議重新產生」會憑空出現** —— 使用者於走查後回報並修正（2026-09-07）。
走查的 B 那格只驗 Sidebar 標記，而誤報的觸發動作**正是 B 的動作**，因此該格的 ✅ 沒有涵蓋它。

根因與 §6.8 的 N-1 是**同一條契約的兩個症狀**：`messages.appended` 不代表「有新訊息」
（會整批重送，見 `docs/ARCHITECTURE.md` §9.5 ③），而 pipeline 每次因 `{priority, joined}`
改變被拆掉重建就會重送 —— 切分頁、切對話、SSE 重連都會觸發，**對話本身什麼都沒發生**。
訊息列表當年為此去重了，結案的過期標記沒跟上。已改為以去重結果（`added > 0`）為條件，
守衛見 `test/message-merge-stale.test.ts` 與 `test/nuxt/closure-stale-lifecycle.test.ts`。

複驗（2026-09-07，使用者執行）：切分頁／切對話／斷網重連／靜置對照組四項皆不再誤報，
客戶發真實訊息時仍正確標記。§3「切走再回來」已補上這條檢查 —— **下一輪走查該格的範圍比這一輪大**。

### 6.5 §4 跨 spec 熱點複審結果（T055）

| 檔案 | 驗法 | 結果 |
|---|---|---|
| `app/composables/useConversationView.ts` | `leave()` 與 `closeConversation()` 仍是兩個獨立函式 | ✅ 兩者各自存在（003 FR-022a）；M3 銜接註解已改寫為「兩件事都移到寫入成功後的 LEAVE」 |
| `server/services/copilot-analysis.ts` | `grep -n "closing\|closure"` | ✅ **零結果** —— 沒有為結案新增第二個門檻條件 |
| `test/contract-guards.test.ts` | `git diff main` 只有新增 | ✅ 唯一的刪除行是 `import { readdirSync, readFileSync }`，換成加了 `existsSync` 的同一行；既有守衛一條都沒被弱化 |
| `shared/types/conversation.ts` | `PresenceState` 仍是三值 | ✅ `'viewing' \| 'composing' \| 'joined'`；`closing` 是 `PresenceEntry` 的獨立欄位，並有守衛與行為測試各一 |

### 6.6 落地時發現並修正的兩件事（記錄以免重犯）

1. **回查失敗被歸成 `failed` 而非 `unverified`。**
   平台對「查不到」回 404，SDK 把非 2xx 一律拋成例外 —— 讓它逸出到外層 catch 就變成
   「CRM 未收到，可直接重試」，但事實正好相反：`createItem` 已經回了 200，紀錄可能真的在。
   照那個提示重試會在正式 CRM 上產生第二筆。**由 SC-003 的第四種形態抓到。**

2. **受控詞彙的選項用錯 key，而且是靜默失效。** 見 6.4.1 —— 由 T046 在真實環境抓到，
   同時訂正了 spike 29 的一個錯誤推論。**自動化測試抓不到這一條**：假 gateway 是照
   我方的假設寫的，兩邊一起錯就一起通過。這是「spike 的結論要以原始產出為準」
   （`CLAUDE.md`）之外的另一半 —— **spike 自己也可能問錯問題**。

3. **`hangMs` 注入讓假 gateway 關不掉。**
   `close()` 原本只 destroy 連線、沒有 `clearTimeout`，`server.close()` 因此要等到
   60 秒後才回。症狀是「`afterEach` 卡住」，與「被測程式碼真的沒落定」在紅字上一模一樣。

### 6.7 已知落差（新增兩項）

除 §5 既有的四項外，本次落地新增兩項：

| 落差 | 現況 | 為什麼不猜 |
|---|---|---|
| `readonly.joinedAt` 不是真正的 JOIN 時間 | 取 `CopilotSession.createdAt`（＝第一條連線開始檢視這個對話的時刻）；取不到時退回 `periodStart` | 平台沒有給「這位客服何時 JOIN」的時間戳，`StateStore` 也沒有記（JOIN 紀錄是一個 Set，presence 的 `at` 每 20 秒被心跳刷新）。⚠️ 退回 `now` 會讓每一份重啟後的報告都寫著「剛剛才加入」，而那是編造的（憲法 4.5） |
| ~~US1 AC#5 的「各區塊重新分析」措辭已過期~~ ✅ **2026-09-07 已訂正，不再是落差** | 三處（`spec.md` US1 AC#5、本檔 §3「重新整理頁面」、`tasks.md` T054）已一併改為「**沿用既有分析結果**；僅當有客戶發言尚未被摘要涵蓋時補跑一次摘要，其餘區塊不重跑」，並各自附上訂正理由 | 舊措辭是 M2 時代的殘留 —— 當時結案會先 LEAVE、停止分析，重新整理必然冷啟動；006 之後分析從未停止（FR-005）。⚠️ 留著它的代價不是不精確而是**會誘導出假修正**：照舊措辭驗收會把正確行為判成失敗，下一個人可能因此去「修好」一個不存在的問題。⚠️ T057 的 grep 沒抓到它 —— 關鍵詞是「先 leave／停止分析／結案即停止分析」，漏掉「重新分析」這個說法 |


### 6.8 手動走查（T053／T054 期間）發現並修正的六個缺陷（2026-09-04）

⚠️ **六個之中有四個是自動化測試抓不到的類型**：它們不會報錯、不會有型別錯誤，
只會在畫面上安靜地說錯話。這一節記下來的價值在於「哪一類缺陷只有人眼抓得到」。

| # | 症狀 | 根因 | 現在守它的是 |
|---|---|---|---|
| 1 | 自訂起算後涵蓋範圍跳「超過 500 則」，而起點更晚、則數只可能更少 | `messageCount: null` 在 `ClosureScopePicker` 被賦予**兩種**意思（「超過上限」與「尚未算出」），三處呈現都只看 `=== null` | `test/closure-ui-honesty.test.ts` |
| 2 | 同一根因的第二症狀：印成「（超過 500 則 **則**）」 | 已含「則」的字串被塞進「（{n} 則）」的模板 | 同上（文案改為片語組合，結構上不可能再疊） |
| 3 | 「處理結果」「情緒結果」下拉顯示 `unresolved`／`still_negative` | `RESOLUTIONS`／`SENTIMENT_OUTCOMES` 以 `string[]` 直接餵 `USelect`，display ＝ value | 同上（含「`escalated` 在兩張表的中文 MUST 不同」一條） |
| 4 | 按下結案的**首次**產生也顯示「涵蓋範圍已改為…正在重新產生」 | 傳給選擇器的是 `status === 'generating'`，而首次產生也是這個狀態 | 同上（`regenerating` ＝ 已有草稿才算） |
| 5 | 超過 500 則的區間，草稿回報「500 則、未截斷」 | `draft.post.ts` 硬寫 `truncated: false`；Board 的 `period_message_count` 定義是「留空 ＝ 數不完」 | `test/closure-period-truncation.test.ts` |
| 6 | 摘要過期時，畫面仍把「一鍵寫入 CRM」做成最醒目的藍鍵 | 用 Nuxt UI 的 `color`／`variant` 近似畫布，而畫布刻意把「重新產生」升為主要、「仍要寫入」降為次要 —— 近似值做出了**相反的引導** | 無自動化守衛（視覺），依 `DESIGN_TOKENS.md` §7.2 ⑥ 的色票表複核 |

**同時補上的一項行為**（畫布沒有，見 `DESIGN_FEEDBACK.md` D-7）：情緒分析仍在進行時，
唯讀區改顯示「情緒分析仍在進行，此刻寫入的紀錄情緒欄位會留空」。
⚠️ 這一項驗的是**結案與分析並行**的後果：兩條路徑刻意獨立（結案不停分析、草稿不等分析），
但草稿會讀情緒時間軸算三個數值 —— 分析未回來時三數值留空，而原本的 `sentiment_note`
只描述「現在沒有」，沒說「還在算」，客服因此會把一筆十秒後就完整的紀錄寫成空白。

⚠️ **這六項修完後，T053／T054 需要重跑** —— 上一輪走查是在有缺陷的畫面上進行的。
**✅ 已於 2026-09-07 重跑完畢，結果見 §6.4.2**（重跑中又發現並修掉數項，其中「過期標記憑空出現」
是走查之後才由使用者回報的，見 §6.4.2 末段）。

### 6.9 §7.5／§1c 重新擷取（2026-09-04）

走查發現實作與畫布不一致，因此把 `docs/DESIGN_TOKENS.md` 的凍結時間點推到
**2026-09-04 版畫布**，並重新擷取兩處：§7.5（涵蓋範圍選擇器，整節重寫）與
§8 的 1c「結案中」狀態變體。⚠️ **其餘章節仍是 09-03 的擷取結果**，沒有被這次比對碰到。

比對後仍有 13 項純視覺差異未修（清單見 `DESIGN_FEEDBACK.md` 與 `DESIGN_TOKENS.md` §7.5
的逐字規格對照），已與使用者確認**逐項討論後再決定**，不一次修完。
