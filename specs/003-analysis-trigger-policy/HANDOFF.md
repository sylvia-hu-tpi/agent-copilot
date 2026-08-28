# 交接筆記 —— M2 收尾（002／003／004）

> ⚠️ **這是一份有時效的滾動快照。做完一段就把該段刪掉**，不要讓它變成第四個描述同一件事的地方
> （`CLAUDE.md` 的核心警告）。正典結論都已寫進各自的 spec、`docs/ARCHITECTURE.md`、
> `docs/CONSTITUTION.md` 與 `docs/IMBRACE_QUESTIONS.md`，這裡**只放三件事**：
> 現況、未完成、接下來要做什麼。
>
> **最後更新：2026-08-28**

---

## 1. 現況

分支 `feat/m2-copilot-panel`，**未押任何 tag**。
⚠️ `origin/feat/m2-copilot-panel` 已推到 `c7774f9`（003 的四個 commit 都在遠端了）；
此後的 commit 尚未 push。先前本檔記為「未 push」是錯的。

| 規格 | 狀態 |
|---|---|
| 001 | implement 完成，`m2-001-done` 已押 |
| 002 | implement 完成（32 項全打勾）。**完整人工驗收未做**，SC-001 真實環境計時從未執行 |
| 003 | **implement 完成，53／55 打勾**。未勾的兩項都是需要真人的驗收（見下） |
| 004 | 只有 spec + checklists，**plan 未跑** |

### 003 交付了什麼

修正 2026-08-27 於真實環境（iMBrace 平台中斷期間）發現的無限重試缺陷，實測換算約
**3,780 次 AI 呼叫／小時／對話**。三處根因**都不是缺少機制，而是判斷寫在錯的那一層**：

1. `watch()` 對「每 20 秒的 presence 心跳」與「真的有變化」走同一條路，而 `attach()` 帶有
   「送快照 ＋ 補跑分析」的副作用 → 註冊表記住上次的 `{priority, joined}`，相同即 no-op。
2. 分析失敗時 `sentimentBlock.timeline` 不推進，同一批訊息永遠被判為「尚未涵蓋」→
   失敗批次記憶，鍵為「區塊 ＋ 該批最後一則**客戶**訊息 id」（那個鍵就是自癒的支點）。
3. `runIncremental()` 的門檻問的是「分析狀態存不存在」，而狀態有 2 小時 sliding TTL、
   LEAVE 不會清 → 改問 `MessageSource.isJoined()`（對話層級聚合，FR-014 因此不需額外邏輯）。

面板側：未接手時**整欄不渲染**；伺服器端兩條送出路徑都擋（即時推播的 `forward()`，
以及走 `send()` **不經** `forward()` 的連線快照 —— 只擋一條等於沒擋）。

**四個 commit**：`ba54ac0`（server 三處判斷）→ `8d810f0`（前端面板與兩個出口）→
`01cf765`（測試守衛與 smoke 擴充）→ `c7774f9`（正典文件同步）。

**驗證狀態**：`npm run typecheck` ✅、`npm test` 304 項全過 ✅、`npm run build` ✅、
`npm run smoke` 兩支全過 ✅（新增場景 ⑥：離開後 5 秒內分析事件實測 **0 則**）。

⚠️ **但「全綠」不等於止血成功** —— 003 的三個缺陷都不會報錯。自動化那一半的證據是
`test/analysis-trigger-integration.test.ts`：注入恆失敗的 AIProvider 後**數 AI 實際被呼叫幾次**
（30 次心跳後 attach 一次都沒走到；就算強迫 30 次 attach 全跑，呼叫量一樣不增加）。
真實環境那一半仍未做，見下。

### worktree 目前的未提交變更

`agentcopilot-b4` 修 `released` 文件落差與登記 credentials 缺陷的 **6 個檔尚未 commit**：
`docs/ARCHITECTURE.md`、`specs/003-analysis-trigger-policy/` 的 `spec.md`／`plan.md`／
`tasks.md`／`research.md`／`data-model.md`。

⚠️ 動這份筆記時 MUST `git add -- specs/003-analysis-trigger-policy/HANDOFF.md` 明確指定檔案，
**不要 `git add -A`**，免得把那 6 個檔掃進不相干的 commit。

---

## 2. 未完成事項

### 需要真人、無法自動化的驗收

- **T052（003）** —— 其中 **US1-A：真實環境注入故障、靜置 10 分鐘、統計呼叫次數**，
  是 **SC-001 唯一的真實環境證據**，不可省略。其餘：US2-B 面板消失逐項清單、
  US2-C 兩瀏覽器（用 EventStream 確認未 JOIN 端真的收不到，**含連線當下的快照**）、
  US2-E 收合不等於離開（切換對話與重新整理後偏好仍在）、SC-007 找一位**未參與本規格**的
  同事讀「離開對話／結案」文案、以及**同一位客服開兩個分頁在其中一個按下離開**（T032a）。
- **T037（003）** —— 依 quickstart US3 手動走一次自癒路徑（注入故障 → 解除 → 新發言 →
  自動恢復），確認全程零手動操作。
- **002 的 SC-001（3 秒／10 秒真實環境計時）從未執行過**（002 `tasks.md` T069）。

### 待使用者裁決

- **知識庫 agent 的模型未定案**：停在 `qwen.qwen3-32b-v1:0`（實測 20.5／13.0／18.6 秒、
  3 筆命中，可用）；`us.amazon.nova-pro-v1:0` 實測相當（13.1／16.7／17.1 秒）。兩者皆可。
  ⚠️ `google.gemma-3-27b-it` **不可用** —— 無原生 function calling，不論 prompt 怎麼寫都只會
  把工具呼叫印成文字，**而且一切看起來都正常**（不報錯、型別正確，只是永遠 0 命中）。
  判斷方式：**看 SSE 有沒有 `tool-output-available` 事件，沒有就是根本沒呼叫。**
  ⚠️ 當初的檢索延遲診斷腳本寫在 session scratchpad、**不在 repo 裡，已經沒了**；
  若要重測（例如 004 落地後），值得收成 `scripts/spike/18-knowledge-latency.ts`
  ＋ `npm run spike:knowledge-latency`。
- **`registerCredential()` 的雙分頁缺陷**（003 implement 過程中發現，**刻意不併入 003**）：
  同一位客服關掉其中一個分頁，會讓**仍開著的那個分頁**的輪詢完全停擺，且不報錯。
  已登記為 `docs/ARCHITECTURE.md` M2 驗收的一條未打勾項（含機制、症狀與修法方向）。
  **決定：不現在開 spec**，等 004 結束後回頭檢視 M2 驗收清單的剩餘工項時自然開出 005。
- **`/speckit-implement` 沒有 commit 這個步驟**：`.claude/skills/speckit-implement/SKILL.md`
  只在 L109-112 碰 git（判斷是不是 git repo 好決定要不要建 `.gitignore`）、L175 要求打勾，
  **執行點上沒有任何「建立 commit」的指令**。全檔唯二提到 `commit` 的 L32／L197 是
  hook 名稱的轉換範例（`speckit.git.commit` → `/speckit-git-commit`），而那條路徑**只在
  `.specify/extensions.yml` 存在時才會走到 —— 本 repo 沒有這個檔**，等於整條 commit 路徑
  在這裡是死的。這才是 003 跑完三個 phase 卻零 commit 的根因（不是健忘，是指令沒出現在
  該出現的地方；`CLAUDE.md` 有寫，但那是全域規範，不在執行點上）。
  兩條可選修法：① 該 skill 加一步「phase 完成 → `/commit-split`」；② 建 `.specify/extensions.yml`
  並註冊 `after_implement` hook。⚠️ **尚未決定，且在決定前不要動那個檔** —— 它正在被使用。

---

## 3. 接下來的順序

1. **commit 掉 worktree 上那 6 個檔**（`agentcopilot-b4` 的 `released` 文件同步與
   credentials 缺陷登記）。
2. **004 走完 plan → tasks → implement。**
   ⚠️ 004 的 plan 之所以必須等 003 落地，是**設計相依**而非驗收順序：004 的 FR-006
   （第二段不得覆蓋更新的結果）、FR-011（不得繞過既有去重）、FR-014（AI 呼叫上限 2 次）
   全都踩在 003 才建立的**同區塊併發去重與失敗批次記憶**上，FR-013 的背景優先度判定
   則走 003 已改的 `watch()`。相依是單向的：003 不依賴 004。**現在 003 已落地，可以動了。**
3. **完整人工驗收**（002 的 SC-001 計時、003 的 T037／T052、004 的 US2 六個檢查點與
   US4 多對話）。⚠️ 排在最後是因為 003 已改動 `attach()` 的觸發時機與 LEAVE 行為、
   004 會改建議卡的產出時序 —— 先驗等於驗一份即將被改掉的程式碼。
4. 通過後才押 **`m2-004-done`**（002／003／004 共押一個，中間不各自押，這是刻意的）。
   ⚠️ **該 tag 的 annotation MUST 反映「US2 曾經完全不可用、2026-08-27 才修好」** ——
   002 曾押的 `m2-002-done` 已依使用者決定刪除（未曾 push，遠端無殘留），
   那段歷史**沒有別的落點**。
   ⚠️ tag 一旦建立就不移動；「落後 HEAD」是它的正常狀態，也正是它的用途。

---

## 給接手者的一句話

**003 的三個缺陷都不會報錯，測試全綠不代表修好了。** T052 的人工驗收不可省略 ——
這與 2026-08-27 那晚的教訓是同一句話的兩個版本：自動化全綠不等於功能存在，
也不等於缺陷已消失。
