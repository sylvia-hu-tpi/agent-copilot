# Specification Quality Checklist: 結案摘要與人審面板

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-03
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

### 三項待拍板皆已收斂（2026-09-03）

| 原問題 | 決議 | 落點 |
|---|---|---|
| 冪等鍵：覆蓋還是並存 | **冪等單位＝草稿**；同一對話多筆結案**並存**（兩種成因：不同時間的多次服務、同一次服務多位客服各自結案）。憲法 5.3 的 MAJOR 修憲 MUST 在開工前完成 | FR-030／FR-030a／FR-030b |
| 交接摘要的去向 | **本規格不做**。畫布、i18n、元件都沒有它的落點；`ARCHITECTURE.md` §18 M3 的該項驗收 MUST 正式改判為延後 | 「明確排除」表、FR-016a、「文件改判義務」 |
| 全程情緒最低點怎麼算 | 「全程」是錯的措辭。範圍改為**本次涵蓋區間**，起點由客服從既有 `closedAt` 候選中選定；區間內評分點不齊時留空並標示，不阻塞本規格 | FR-021 系列、FR-022 系列 |

### 涵蓋區間的推導過程（保留理由，避免日後被「簡化」掉）

被逐一排除的三種自動推導方式，各有一個具體的反例：

1. **客服自己的 JOIN 時間** —— 同一次服務的多位客服 JOIN 時間不同，會產出不同區間；且客戶通常在客服 JOIN 前就已把訴求講完。
2. **時間間隔（gap）規則** —— 反例：客戶昨天 17:35 發言、今天 10:15 才有人接（空檔 16 小時 40 分）仍是同一區間。門檻訂 24 小時對、訂 12 小時錯，而該值無法從證據推導。
3. **客戶那一輪發言的第一則** —— 客服回過話但**沒有結案**時，客戶隔天追問仍屬同一輪，此規則會誤切。

`closedAt` 之所以是對的：「有沒有結案」本身就是「上一輪有沒有結束」的定義，是事實而非推測。

### 刻意保留的偏離

- **spec 內出現兩處程式碼／檔案位置的引用**（`conversation.exitHint` 與 `useConversationView.ts` 的結案出口）。
  規格一般不提實作位置，但這兩處是本規格要結清的那筆帳的落點本身（使用者輸入列為 MUST），
  拿掉會讓 FR-002 無從驗證。它們是可追溯性錨點，不是實作處方。
- **SC-004 沿用既有的摘要 10 秒門檻而非另訂新值**，並明文禁止「因為達不到就放寬」。
- **FR-021a～FR-021g 只定行為與資訊，不定版面** —— 涵蓋區間選擇器在畫布 artboard 2a 上不存在，
  比照交接摘要的同一標準，MUST 先進 Design 畫布。這是刻意不在規格裡替設計做決定。

### 進 `/speckit-plan` 前的外部前置

1. ✅ **憲法 5.3 的 MAJOR 修憲**（含 5.1 的標的改寫）—— **已於 2026-09-03 完成，發布為 v4.0.0**。
   連帶落點（`ARCHITECTURE.md` 八處、`IMBRACE_QUESTIONS.md` D-2、`specs/003` 提案節點、
   `specs/001` FR-015 補註、附錄 C、`.specify/memory/constitution.md` 同步）皆已結清。
2. ⚠️ **涵蓋區間選擇器的設計稿** —— 尚未進畫布。阻塞 UI 實作，**不阻塞**行為定義與後端。
