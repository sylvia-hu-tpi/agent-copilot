# Implementation Plan: 建議卡的漸進式知識庫引用

**Branch**: `004-progressive-citations` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-progressive-citations/spec.md`

## Summary

建議卡從「先檢索（8 秒逾時）、再生成」的串行流程改為兩段式：JOIN 後**同時**啟動不帶知識庫的第一段
生成與 30 秒的知識庫檢索；第一段落地即顯示（標示「尚未引用知識庫」），檢索有命中時以命中結果**重新
生成整批**第二段並自動整批換上（區塊層級提示），無命中／失敗／逾時則維持第一段內容並把標示落定為
「未引用知識庫」。背景對話不走兩段式（刻意不一致，FR-013）。

技術路徑只有一條主線：在既有 `analyzeSuggestionsOnce()` 內分岔（research.md #1），第二段以鎖外的
「尾巴」執行並用世代計數擋過期結果（#2）；`withRetry()` 加 `maxRetries`／`signal` 兩個選項讓第二段
「不重試」與第一段「被第二段取消」都是明示的呼叫端選擇，001 FR-014 的三個數字不動（#4）。
`SuggestionBlock` 加 `citation`／`basedOnMessageId`／`provenance` 三欄，`status` 五態機與 SSE 事件型別
都不變（#6、#7）。**不新增 provider、不改 `AIProvider`／`KnowledgeProvider` 介面、不新增持久化形狀。**

## Technical Context

**Language/Version**: TypeScript，Node ≥ 24（Nuxt 4，`ssr: false` + 完整 Nitro BFF）

**Primary Dependencies**: 沿用既有 Nuxt 4 / Vue 3 / Pinia / Zod / `@imbrace/sdk`（僅 server）/
`@nuxtjs/i18n`；不新增套件

**Storage**: 沿用 `CopilotAnalysisState`（2 小時 sliding TTL），`suggestionBlock` 加三個欄位；
新增一份 **server-only 執行期**狀態 `suggestionTails`（模組層級 Map，比照 003 的 `analysisInFlight`），
不進 `StateStore`（data-model.md §4）

**Testing**: Vitest（單元：`withRetry` 新選項、兩段序列的每一種交錯、呼叫次數上限；nuxt：提示的轉移推導
與淡出）；`npm run smoke:realtime` 擴充一個在 `AC_SMOKE_KNOWLEDGE_DELAY_MS` 下觀察 `pending → cited`
的場景（quickstart.md）

**Target Platform**: 同既有——Node server（單副本記憶體 `StateStore`）；瀏覽器端 console 頁面

**Project Type**: 單一 Nuxt 應用內建 Nitro BFF，沿用 `app/`／`server/`／`shared/` 三層結構

**Performance Goals**: 第一批卡 JOIN 後 90% 在 **20 秒**內（002 SC-001 建議卡門檻，2026-08-29 由 10 秒
修訂；3 秒骨架不變）；且第一段 p90 不比實作前差（004 SC-001）——第一段的輸入與現況相同
（`knowledgeHits: []`），差別只在不再等 8 秒檢索，理論上只會更快。第二段最晚 JOIN 後 45 秒
（30 秒檢索 ＋ 15 秒生成）；SC-002 知識庫有內容時 ≥ 90% 最終取得 `cited`

**Constraints**:
- **001 FR-014 的 15s／1s→4s／40s 三數不動**；第一段沿用，第二段 `maxRetries: 0`（004 FR-014）。
  第二段的單次逾時以獨立常數 `SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 15_000` 承載——
  ⚠️ **research.md #5 建議改為 20 秒**（第二段不進重試迴圈，改它不牽動退避預算；15 秒對實測最慢
  13.0 秒只剩 13% 餘裕，平台漂移 36% 即逾時且**靜默**落成 `none`，直接侵蝕 SC-002）。
  spec 字面是 15 秒，本 plan 不自行推翻，tasks.md 列為實作前確認項。
- 檢索逾時**只有一個數字** `KNOWLEDGE_SEARCH_TIMEOUT_MS = 30_000`；`SUGGESTION_RETRIEVAL_TIMEOUT_MS`
  刪除且以契約守衛防止復活（research.md #8）。
- 建議卡 AI 呼叫次數：前景每批最壞 1 ＋ 2（第一段重試）＋ 1 ＝ 4，背景 1；以 `provenance` 可稽核（SC-005）。
- `runBlockDeduped()` 的鎖只涵蓋第一段——第二段若在鎖內，新一批客戶發言的分析會被舊尾巴拖慢最多 45 秒
  （research.md #2）。
- 建議卡內容 MUST NOT 逐字串流（FR-010，沿用 002 FR-026）；兩段各自整批驗證後才顯示。
- 背景對話 `mode: 'single'`，程式碼註解 MUST 寫明刻意不一致的理由（FR-013）。
- 「AI 是否正在自動回覆」一律 `controlFromMode(mode).aiReplies`（002 FR-016 的地雷，兩段都要帶）。

**Scale/Scope**: 與 002 相同（客服所有已 JOIN 的對話）；前景兩段式讓每批訊息的建議卡呼叫最多翻倍
（1 → 2，重試另計），背景不變——背景並行上限 10 個對話正是 FR-013 省下的量

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 條 | 適用性 | 檢核結果 |
|---|---|---|
| **一、安全邊界** | 不碰憑證；新增的日誌只有世代號、`citation` 轉移、失敗分類 | ✅ 通過。第二段失敗的日誌比照既有 `logFailure()`（1.5：只記分類與狀態碼，不記卡片文字） |
| **二、外部依賴的抽象邊界** | `AIProvider.suggest()`／`KnowledgeProvider.search()` 簽章**不變** | ✅ 通過。兩段只是同一個 `suggest()` 帶不同 `knowledgeHits`；`MockAIProvider`／`MockKnowledgeProvider` 不需要懂兩段（2.2：換 provider 仍只改裝配點）。`withRetry()` 的新選項是 AI 呼叫的共用工具，不是 provider 介面 |
| **三、Copilot 不得拖垮主線** | 第二段失敗／逾時的處置 | ✅ 通過且是 FR-003 的核心：第二段任何失敗都**靜默**維持第一段（3.2「知識庫失敗 → 降級為無引用版本並明確標示」）；不新增任何刻意阻斷情境（3.3 封閉集合不變） |
| **四、AI 輸出必須可驗證** | 兩段都是模型輸出 | ✅ 通過。兩段各自 Zod（4.2）→ 白名單整卡捨棄（4.3，第二段以第二段的 hits 為白名單）→ `confidence` 歸零（4.4）。**4.5 是本功能存在的理由**：第二段重新生成而非為第一段補掛來源，讓卡片文字與來源的因果關係真實成立（spec Clarifications Q1） |
| **五、AI 產物寫入正式紀錄** | 不適用 | 不寫 Data Board |
| **六、資源使用** | 6.2 的「MUST NOT 略過檢索」與背景節流 | ✅ 通過。每批仍恰好發出一次檢索（`knowledgeSearch.ran` 恆 `true`）；背景維持單段且沿用並行上限與 debounce；前景多一次呼叫是 spec 明示接受的成本，且有上限與稽核（FR-014／SC-005）。6.3（patch）：SSE 仍整塊覆蓋，是既有慣例，不新增違反 |
| **七、協同與資料一致性** | 不動 JOIN／LEAVE／送出；FR-008 的 Composer 保護 | ✅ 通過。`useCopilotSession` 只覆蓋 `suggestions` ref，Composer 草稿走 `useDraft()`（localStorage）與元件自身狀態，兩者無共用路徑；以契約守衛（不得 import `useDraft`）守住。LEAVE 時 `cancelPendingAnalysis()` 一併 abort 尾巴（003 FR-013 的延伸：沒人 JOIN 就不花第二段的錢） |
| **八、介面與無障礙** | 8.1／8.5 | ✅ 通過。更新提示與「檢索中」標頭皆為圖示＋文字，`role="status"`（8.1）；新文案入 i18n（8.5）；不新增互動元素（8.2 不受影響）；8.4 由 FR-008 反向保證（程式主動更新 MUST NOT 碰草稿） |
| **九、渲染與部署** | `suggestionTails` 是單副本執行期狀態 | ✅ 通過，限制與 003 的 `analysisInFlight` 相同：9.2 換 Redis 前只有單副本，屆時尾巴登記需一併搬（已在 data-model.md §4 註明） |

**Complexity Tracking 表留空**——沒有需要偏離憲法的項目。唯一的「例外」是 004 FR-014 對 001 FR-014
「暫時性失敗 MUST 自動重試」的例外（第二段不重試），那是 spec 層級的規則衝突，不是憲法違反；
處置是在 001 spec 的 FR-014 加一行指向 004（tasks 列入）。

**Phase 1 設計後複查**：`data-model.md`／`contracts/` 的決策（`citation` 三值與 `status` 正交、
尾巴在鎖外＋世代計數、`withRetry` 加選項而非繞過、提示由消費端轉移推導、刪除短逾時常數）皆未新增
外部依賴、未新增持久化形狀、未新增刻意阻斷情境、未繞過 Zod 或白名單。上表結論不變。

## Project Structure

### Documentation (this feature)

```text
specs/004-progressive-citations/
├── plan.md              # This file
├── research.md          # Phase 0 output（#1～#11）
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── progressive-suggestion-events.md
└── tasks.md             # Phase 2 output (/speckit-tasks，NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
shared/types/
├── copilot.ts                              # MODIFIED — SuggestionBlock 加 citation／basedOnMessageId／provenance
└── knowledge.ts                            # MODIFIED — search() 註解：建議卡路徑改共用 KNOWLEDGE_SEARCH_TIMEOUT_MS

server/
├── services/
│   ├── ai/
│   │   └── retry-policy.ts                 # MODIFIED — WithRetryOptions 加 maxRetries／signal；RetryAbortedError
│   ├── knowledge/
│   │   ├── agent-knowledge-provider.ts     # MODIFIED — 刪除 SUGGESTION_RETRIEVAL_TIMEOUT_MS 與其註解
│   │   └── mock-knowledge-provider.ts      # MODIFIED — 讀 AC_SMOKE_KNOWLEDGE_DELAY_MS（僅 Mock 路徑）
│   ├── knowledge/index.ts                  # MODIFIED — 裝配 Mock 時帶入 searchDelayMs
│   └── copilot-analysis.ts                 # MODIFIED（核心）——
│                                            #   analyzeSuggestionsOnce(mode) 兩段分岔、suggestionTails、
│                                            #   世代計數、SUGGESTION_STAGE2_CALL_TIMEOUT_MS、
│                                            #   awaitSuggestionTail()（測試用）、
│                                            #   cancelPendingAnalysis() 一併 abort 尾巴、
│                                            #   initialState() 補新欄位預設
└── api/
    └── stream.get.ts                       # MODIFIED — 重連快照：pending 且無尾巴 → 改送 none（契約 §4）

app/
├── composables/
│   └── useCopilotSession.ts                # MODIFIED — emptySuggestionBlock 補欄位；
│                                            #            suggestionCitedAt（pending→cited 轉移推導，5 秒淡出）
└── components/copilot/
    ├── SuggestionList.vue                  # MODIFIED — 「檢索中」標頭、更新提示（role="status"）
    └── SuggestionCard.vue                  # MODIFIED — 接收 citation，pending 時來源列文案不同

i18n/locales/zh-TW.json                     # MODIFIED — citationPending／citedUpdated／noKnowledgeRefPending

test/
├── copilot-analysis.test.ts                # MODIFIED（擴充）— 兩段序列、呼叫次數上限、世代丟棄、FR-006a
├── ai-retry-policy.test.ts                 # MODIFIED — maxRetries: 0、signal abort
├── contract-guards.test.ts                 # MODIFIED — 三條新守衛（research.md #8、data-model §4、契約 §3）
├── stream-analysis-visibility.test.ts      # MODIFIED — 重連快照的 pending 修正
├── nuxt/suggestion-citation-cue.test.ts    # NEW
└── realtime-http.ts                        # MODIFIED — smoke:realtime 的 pending→cited 場景

specs/001-sentiment-panel/spec.md           # MODIFIED — FR-014 加一行：004 第二段為明示例外
docs/ARCHITECTURE.md                        # MODIFIED — §8.2b「FR-014 的裁決」落定；§11／§12 建議卡流程改為兩段式
```

**Structure Decision**: 不新增任何檔案於 `server/`——兩段式是既有建議卡管線的**行為變更**，不是新
能力；唯一的新檔是一支 nuxt 測試。所有控制流（世代、尾巴、abort）都收在 `copilot-analysis.ts`，
與 003 把去重／失敗記憶／JOIN 門檻收在同一檔的理由相同：這些機制互相咬合，拆開會讓「誰擋了誰」
要跨檔追。
