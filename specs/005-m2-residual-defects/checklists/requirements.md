# Specification Quality Checklist: M2 遺留缺陷與量測補強

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-02
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- **與 003 相同的刻意取捨**：四則 User Story 的敘述保留了函式與欄位層級的細節
  （`registerCredential()`、`session.watchers`、`pipeline.refs`、`SENTIMENT_CHUNK_SIZE`）。
  那不是需求敘述，而是**缺陷的證據鏈** —— US1 的整個論證是「同一個函式裡兩個計數器
  對同一件事給出不同答案」，抽掉識別項之後這句話就只剩「系統有時會出錯」，
  下一個讀者無從判斷修對了沒有。需求本體（FR-001～FR-021 及 2026-09-02 clarify 新增的 FR-005a／FR-015a／FR-018a／FR-020a）維持技術中立：
  講「每次登記各自唯一」而不是「用 Symbol 當鍵」、講「呼叫者識別」而不是 `user_id`、
  講「來源識別碼」而不是 `sopId`。

- **範圍問題於 2026-09-02 全數與使用者裁定，無待決項目**。先是兩個範圍決定：
  ① 恢復時補算的範圍 → 補齊所有未涵蓋的客戶發言（不是只補本次故障期間失敗的批次，
     也不是沿用冷啟動的 50 則上限）；
  ② 杜撰引用的處置 → 強化傳入的封閉命中清單＋建立可重複量測，
     **不**加第二段重試（維持 004 定案的靜默行為）。
  同日 `/speckit-clarify` 再收斂五題，逐題記於 spec 的 `## Clarifications`：
  補算上限（每輪 3 批）、15 秒門檻維持不動、稽核證據只留伺服器端具名事件、
  憑證登記需存活兜底（FR-005a）、量測口徑 n=45（FR-018a）。

- **識別項出現在需求本體的範圍，於 2026-09-02 clarify 後略為擴大**，理由與上一條同族：
  FR-009 的「3 批」若不寫出它對齊 `SENTIMENT_CONCURRENCY`，讀者無從判斷這個數字是不是拍腦袋的；
  FR-005a 的存活兜底若不指名 presence 既有的心跳＋TTL，「比照既有模式」就沒有可比照的對象，
  而該條的整個論證正是「presence 有、憑證沒有」。**判準沿用 003 的取捨：
  抽掉識別項之後那句話還站得住，就抽掉；站不住的，那個識別項就是需求的一部分。**

- **FR-015／FR-015a 的兩條約束來自跨專案比對**（2026-09-02，與 SysTalk.Red 的 session 對照）：
  ① **標準輸出 MUST 是完整集合**，額外落點只能是拷貝 —— 對方以 log 級別分流讓標準輸出成為子集，
     自陳代價是「日後接任何只收標準輸出的集中式平台都得改程式」。這條線現在劃，之後接 Loki 才真的零改動。
  ② **要防的是「開檔」不是「寫入」** —— 對方 2026-09-01 的 SIT 事故是 log 目錄 `mkdirSync` EACCES
     發生在啟動最前段、早於任何 error handling，造成服務無限重啟。**日誌落不了地卻賠掉整個服務**，
     正是憲法 3.1 的反例而兇手是日誌自己。原本寫的「寫入失敗靜默吞掉」包錯了位置。

- **SC-006 刻意寫成「不承諾改善」**。004 SC-002 的 80% 未達，最強的槓桿是建議卡 agent 的
  system prompt 與選型，兩者都在 iMBrace 後台、不在本 repo。把「拉到 90%」寫成本規格的
  成功判準，會變成一條實作端無論做什麼都可能不通過的門檻 —— 那不是嚴格，是錯置責任。
  本規格承諾的是「答得出為什麼沒有引用」，那件事完全在 repo 內。

- **US4 是四則裡唯一產出「數字」而非「功能」的**。它刻意不預先承諾會調高並行度：
  FR-019 把採用判準寫死成「總時間改善**且**失敗率未上升」，正是因為 2026-09-01 那次
  由 1 改 3 的經驗顯示這兩件事可能同時往反方向動，而畫面上只看得到偶發紅字。

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
