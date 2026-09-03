# Specification Quality Checklist: 建議卡的漸進式知識庫引用

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-27
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

三個原標記為 `[NEEDS CLARIFICATION]` 的決策已於 2026-08-28 由使用者裁示，皆採推薦選項並記入
spec.md 的 Clarifications：第二段重新呼叫 AI 生成整批新卡（不為既有卡片補掛來源）、第一段卡片
整批替換不保留、背景對話不走兩段式。

「問題背景」一節保留了常數名稱與實測數字，理由同 003：本規格存在的唯一理由就是那組數字，
抽掉之後讀者無從判斷取捨是否成立。需求本體（FR 各條）維持技術中立。

### 實作後補記（2026-08-29）

- **`SUGGESTION_STAGE2_CALL_TIMEOUT_MS` 裁決為 20 秒**（T011）。第二段以 `maxRetries: 0` 呼叫、
  不進重試迴圈，因此改它不牽動 001 FR-014 的 15s／1s→4s／40s 三數綁定；沿用 15 秒對第二段
  實測最慢 13.0 秒只剩 13% 餘裕，而第二段逾時是**靜默**落成「未引用知識庫」，會無聲侵蝕 SC-002。
  `docs/ARCHITECTURE.md` §8.2b 的「FR-014 的裁決留到 004」一段已改寫為此結果。
- **`/speckit-analyze` 兩輪共 27 項修正已全數落盤**：第一輪 14 項（憲法 6.2 澄清為 v3.0.2、
  002 SC-002 拆為 SC-002a／SC-002b、兩個 `AbortController` 拆分、新增 FR-015、
  `mode` → `strategy` 改名…），第二輪 13 項（**新增 FR-003a 的兩條收斂規則**、FR-015 的回覆來源
  改由 `checkSuggestionsSuperseded()` 於訊息抵達當下留存、FR-005 的判準含 0 筆命中…）。
  兩輪都在動工前完成，實作階段未再發現規格層級的矛盾。
- **實作階段推翻的一項任務敘述**：T024 原要求 smoke 以「兩則事件之間不存在任何非
  `suggestion.updated` 的對話事件」作為 SC-003 的弱代理。實測該斷言恆紅且驗錯對象
  （`messages.appended` 與冷啟動的 summary／sentiment 本來就會落在中間，與 Composer 無關）；
  改寫為「兩則之間恰好一則 `suggestion.updated`」同樣恆紅（第二層輪詢會另起一輪分析）。
  最終**不做假斷言**：smoke 只印一行說明，SC-003 由 `test/contract-guards.test.ts` 的靜態守衛
  與 quickstart US2 的手動場景各守一半。理由與兩種失敗寫法都記在 `test/realtime-http.ts` 的註解裡。

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
