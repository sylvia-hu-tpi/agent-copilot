# Implementation Plan: 建議卡與知識庫快查

**Branch**: `002-suggestion-knowledge-search` | **Date**: 2026-08-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-suggestion-knowledge-search/spec.md`

## Summary

客服 JOIN 對話後，系統依對話內容與知識庫檢索結果自動產生建議回覆卡，可一鍵帶入 Composer（帶入後
仍受既有撞單檢查約束）；並提供獨立的知識庫自然語言快查，結果可插入回覆或展開內容。兩者的 AI／
知識庫呼叫故障時各自獨立降級，不阻斷訊息流與 Composer（憲法 3.1、3.2）。本功能同時是憲法 6.2
v3.0.0（背景對話跑受限子集＋節流，而非完全不跑）**第一個真正落地的實作**——追蹤既有程式碼發現
「切走即停」的根因不在分析邏輯，而在 SSE 控制通道把「presence 是否可見」與「Copilot 管線是否
存續」耦合在同一個判斷式裡（見 research.md #8），因此本功能的技術路徑分兩條主線：

1. **建議卡／知識庫快查本身**：新增 `KnowledgeProvider`／`AgentKnowledgeProvider`（真實解析
   `RAGknowledge` 工具輸出，非結構化陣列，需自行切分 chunk，見 research.md #1）、擴充
   `AIProvider.suggest()`、白名單後驗（憲法 4.3，整卡捨棄而非欄位丟棄）、`SuggestionBlock` 併入
   既有 `CopilotAnalysisState` 與 SSE 整塊覆蓋模式；知識庫快查則刻意**不**套用同一套持久化＋SSE
   模式，改用一次性 request/response 端點（見 research.md #7）。
2. **多對話背景運算的基礎設施修正**（FR-019～FR-021）：修正 `presence.post.ts`／
   `useConversationView.ts` 裡「切走即當作 unwatch」的判斷錯誤、新增 `StateStore` 對「JOIN 了哪些
   對話」的持久追蹤（供 SSE 重連復原背景 watch）、重用 `PollingMessageSource` 既有的前景/背景
   聚合邏輯做並行節流與 debounce 分級。這條主線的變更面比表面上的 FR 描述更底層，但都是對既有
   基礎設施的補丁，不新增平行機制（見 research.md #8、#9）。

## Technical Context

**Language/Version**: TypeScript，Node ≥ 24（Nuxt 4，`ssr: false` + 完整 Nitro BFF）

**Primary Dependencies**: 沿用既有 Nuxt 4 / Vue 3 / Pinia / Zod / `@imbrace/sdk`（僅 server）/
`@nuxtjs/i18n`；不新增套件——知識庫結果的 UI 沿用手刻元件模式（比照 `SentimentGauge.vue` 不引圖表庫
的既有決策）

**Storage**: 沿用 `specs/001-sentiment-panel` 建立的 `CopilotAnalysisState`（2 小時 sliding TTL，
獨立於 watcher refcount）模式，新增 `suggestionBlock` 欄位併入同一筆記錄（見 data-model.md §3.1）；
另新增一份**不設 TTL**的 JOIN 持久追蹤（`StateStore.listJoinedConversations`，見 data-model.md
§3.2）——這是本功能唯一新增的持久化資料形狀，其餘沿用既有結構

**Testing**: Vitest（單元：`RAGknowledge` 輸出解析、白名單整卡捨棄、背景並行節流、
`presence.post.ts` 的 `away+joined` 分流；整合：對假 gateway 的知識庫/建議卡端到端）；
`npm run smoke:realtime` 需擴充涵蓋 `suggestion.updated` 事件與多對話背景更新場景（見
quickstart.md US4）

**Target Platform**: 同既有——Node server（單副本記憶體 `StateStore`）；瀏覽器端 console 頁面

**Project Type**: 單一 Nuxt 應用內建 Nitro BFF，沿用 `app/`／`server/`／`shared/` 三層結構

**Performance Goals**: JOIN 後 90% 情況 3 秒內建議卡區塊出現並標示產生中，**20 秒**內完整呈現
（SC-001；⚠️ 2026-08-29 由 10 秒改寫，理由見 002 spec SC-001 註記——原「與 001 的摘要/情緒門檻對齊」
自此不再成立，摘要／情緒維持 10 秒，只有建議卡是 20 秒）；知識庫快查 90% 情況
**20 秒**內回應（SC-002a）且 100% 在 **35 秒**內落定（SC-002b）——⚠️ 2026-08-29 由單一的 25 秒
拆為兩條，理由見 002 spec SC-002b 註記（本行原寫「10 秒」，是 2026-08-27 改為 25 秒時漏改的
過期數字，一併訂正）；背景對話不受此門檻約束（SC-007，改以「切回時已更新」為驗收依據，非延遲
時間）

**Constraints**: 沿用 001 已定案的 **AI** 呼叫重試/退避數值（15s 逾時、1s→4s 退避、40s 總預算、
429 不重試）；**知識庫檢索另設兩個逾時值**——`KNOWLEDGE_SEARCH_TIMEOUT_MS = 30_000`（快查／US2）
與 `SUGGESTION_RETRIEVAL_TIMEOUT_MS = 8_000`（建議卡生成前的檢索／US1），逾時一律走 `degraded`
降級而非重試（檢索失敗時 FR-004 允許以空集合續行，重試只會再等一次）。
⚠️ **2026-08-29：`SUGGESTION_RETRIEVAL_TIMEOUT_MS` 已於 004 刪除**，建議卡路徑改與快查共用
`KNOWLEDGE_SEARCH_TIMEOUT_MS`（004 FR-003）；本段以下描述的是兩段式落地前的現況。
⚠️ **2026-08-27 依實測修訂**：原本只有單一的 8 秒（推導自 SC-002 當時的 10 秒門檻，留 2 秒給 BFF 往返
與渲染）。實測九次取樣最快 13.0 秒、最慢 24.9 秒（⚠️ **2026-08-29 訂正**：加大樣本後為最快 9.4 秒、中位 11.9 秒、p90 16.9 秒、最慢 20.1 秒，原「沒有任何一次低於 13 秒」已被推翻；**但「8 秒 100% 逾時」的結論不變且更確定（0/12）**，詳見 `server/services/knowledge/agent-knowledge-provider.ts` 的常數註解），8 秒在生產路徑上 100% 逾時，SC-002 的門檻已改寫
為 25 秒（⚠️ **2026-08-29 再修訂**：25 秒源自 n=9 的最慢值 24.9 秒，而該筆出自已排除的
`qwen.qwen3-vl-235b-a22b`；且 25 秒比 `KNOWLEDGE_SEARCH_TIMEOUT_MS` 的 30 秒**短**，使 SC-002
自己那句「逾時上限 MUST 短於此門檻」從未成立。現已拆為 SC-002a 的 20 秒與 SC-002b 的 35 秒，
30 < 35 使該 MUST 恢復有效——見 002 spec SC-002b 註記）。
兩條路徑之所以**必須**用不同數字：快查是客服主動發起、畫面有骨架的同步查詢，等 20 秒
可接受；建議卡走「先檢索再生成」的串行流程且受 SC-001 的 10 秒約束，若也用 30 秒會讓建議卡遲到
30 秒（⚠️ 2026-08-29：SC-001 已改為 20 秒，且 004 FR-003 以「第二段等檢索 30 秒」取代這個 8 秒短逾時；本段描述的是兩段式落地前的現況）。取樣數據與完整理由見 `server/services/knowledge/agent-knowledge-provider.ts` 的常數註解；新增背景並行上限
`BACKGROUND_CONCURRENCY_LIMIT = 10`（§11.2 建議值）與背景 debounce（明顯長於前景 1 秒，建議 8 秒，
FR-021）；建議卡數量上限 3–5 張（`docs/ARCHITECTURE.md` §14.6）**於 prompt 落實，不做事後截斷**
（FR-001）；建議卡內容 MUST NOT 逐字串流（FR-026，與 4.3「顯示前驗證」不相容）；
「AI 是否正在自動回覆」一律取 `controlFromMode(mode).aiReplies`，MUST NOT 另寫 `mode === 'hybrid'`
（FR-016，§10.2／§10.6 的靜默失效地雷）

**Scale/Scope**: 涵蓋客服**所有已 JOIN**的對話（不限前景聚焦），這是與 001（僅前景）最主要的
範圍差異，也是本功能複雜度的主要來源

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 條 | 適用性 | 檢核結果 |
|---|---|---|
| **一、安全邊界** | 不直接處理憑證；新增兩個 AI Agent 呼叫走既有防腐層模式 | ✅ 通過。建議卡文字、知識庫片段仍屬客戶對話個資／企業內部文件，日誌 MUST NOT 輸出全文（1.5）——`analyzeSuggestions()`／`AgentKnowledgeProvider` 的錯誤記錄比照 `specs/001-sentiment-panel/research.md` #6 只記分類與狀態碼 |
| **二、外部依賴的抽象邊界** | 新增 `KnowledgeProvider` 實作、擴充 `AIProvider` | ✅ 通過。`KnowledgeProvider` 介面定義於 `shared/types/knowledge.ts`，`AgentKnowledgeProvider` 為唯一實作（不做 `StaticSopProvider`，見 research.md #4 決策，之後要換 `VikiKnowledgeProvider` 只需換裝配點）；`StateStore` 新增的三個方法（2.1 表）皆為 async（2.3 已滿足）；新方法不改動既有簽章 |
| **三、Copilot 不得拖垮主線** | 本功能兩條主線皆以此為最高原則 | ✅ 通過。FR-012／FR-013／FR-025 對應 3.1/3.2；知識庫快查的 JOIN 門檻（FR-025）不是新的刻意阻斷情境——它與「未 JOIN 時 Composer 唯讀」同一性質（功能本身需要前提條件，不是故障降級），3.3 封閉集合不變 |
| **四、AI 輸出必須可驗證** | 建議卡、知識庫檢索皆為 AI/檢索產物 | ✅ 通過且是本規格 FR-002～FR-004、FR-022 的核心。4.3 白名單後驗**整卡捨棄**（research.md #6，比 001 的欄位級容錯更嚴格，因為此處捨棄的是「引用是否存在」這種正確性問題，不是「格式是否合法」）；4.4 `confidence`／`KnowledgeHit.score` 皆為 nullable，無真實依據不填充；4.5 `requiresData` 承接事實缺口 |
| **五、AI 產物寫入正式紀錄** | 不適用 | 本功能不寫入 Data Board（結案摘要屬 M3） |
| **六、資源使用** | 6.2 是本功能第二條主線的直接對象 | ✅ 通過（依 v3.0.1），且是憲法 v3.0.0 修訂後**第一個落地驗證「背景跑受限子集＋節流」是否可行**的功能。6.2 的兩道節流（並行上限、較長 debounce）皆已納入設計（research.md #9）；「MUST NOT 略過檢索」＋可稽核證據 `knowledgeSearch.ran`（v3.0.1）見 data-model.md §1.1——v3.0.0 原措辭「MUST NOT 以空的檢索結果執行」與 FR-004 牴觸，已於 2026-08-27 修訂；6.3（patch）不新增額外違反；6.5（附件快取）不適用——本功能不新增附件處理路徑，`Message.text` 沿用既有文字化結果 |
| **七、協同與資料一致性** | 不改動 JOIN／LEAVE／送出訊息的核心邏輯，但新增 `StateStore` 對 JOIN 狀態的持久追蹤 | ✅ 通過。新增的 `addJoinedConversation`/`removeJoinedConversation` 是**旁側記錄**（供背景 watch 復原用），不影響 7.1（JOIN 非排他鎖）、7.2（送出前樂觀併發檢查，本功能的一鍵帶入/插入為回覆送出時完整複用，FR-006）的既有行為；7.3（JOIN 去重）不受影響 |
| **八、介面與無障礙** | 8.1／8.2／8.4／8.5 | ✅ 通過。8.1：本功能無新增僅靠顏色表達的狀態（信心度/過舊提醒皆為文字＋圖示）；8.2：一鍵帶入/插入為回覆需可鍵盤操作；**8.4 是本功能第一次出現「非使用者輸入、程式主動要覆蓋草稿」的場景**（FR-018），新增確認流程見 research.md #11；8.5：新文案入 i18n |
| **九、渲染與部署** | 不涉及 `nuxt.config.ts` 或部署形態變更 | 不適用 |

**Complexity Tracking 表留空**——本功能沒有需要偏離憲法或既有架構模式而需另外辯護的項目；
research.md #8/#9 的多對話基礎設施修正雖然改動面較廣，但性質是「修正既有機制裡兩處判斷錯誤」，
不是新增平行機制，不構成 2.2 意義下的「邊界劃錯」。

**Phase 1 設計後複查**：`data-model.md`／`contracts/` 的新設計決策（`SuggestionBlock` 併入既有
`CopilotAnalysisState`、知識庫快查刻意不套用 SSE/持久化模式、`StateStore.listJoinedConversations`
不設 TTL、白名單以獨立函式而非 Zod `.refine()` 實作）皆未新增外部依賴、未新增刻意阻斷情境、未繞過
Zod 驗證或 PII 記錄原則、未違反 2.4（沒有為規格已定案的依賴──如 Zod──另包一層）。上表結論不變。

## Project Structure

### Documentation (this feature)

```text
specs/002-suggestion-knowledge-search/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/            # Phase 1 output
│   ├── copilot-suggestion-events.md
│   ├── knowledge-search-api.md
│   └── presence-watch-control.md
└── tasks.md              # Phase 2 output (/speckit-tasks，NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
shared/types/
├── copilot.ts                              # MODIFIED — SuggestionCard、SuggestionBlock、
│                                            #            AIProvider.suggest() 擴充
├── knowledge.ts                            # NEW — KnowledgeHit、KnowledgeProvider、
│                                            #        KnowledgeSearchRequest/Response
└── events.ts                               # MODIFIED — CopilotEvent 新增 suggestion.updated

server/
├── state/
│   ├── types.ts                            # MODIFIED — CopilotAnalysisState 新增 suggestionBlock；
│   │                                        #            StateStore 新增 addJoinedConversation／
│   │                                        #            removeJoinedConversation／
│   │                                        #            listJoinedConversations
│   └── memory-store.ts                     # MODIFIED — 上述三個方法的記憶體實作（不設 TTL）
├── sources/
│   ├── types.ts                            # MODIFIED — MessageSource 新增 getPriority()
│   └── polling-message-source.ts           # MODIFIED — 暴露既有 aggregateState() 的優先度查詢
├── services/
│   ├── knowledge/
│   │   ├── agent-knowledge-provider.ts     # NEW — 解析 RAGknowledge tool-output-available（研究 #1）
│   │   ├── mock-knowledge-provider.ts      # NEW — 測試/離線用固定樣本
│   │   └── index.ts                        # NEW — 裝配入口，比照 server/services/ai/index.ts
│   ├── ai/
│   │   ├── mock-ai-provider.ts             # MODIFIED — 新增 suggest()
│   │   ├── imbrace-agent-provider.ts       # MODIFIED — 新增 suggest()，需 suggestionAgentId
│   │   ├── index.ts                        # MODIFIED — 新增 IMBRACE_SUGGESTION_AGENT_ID 裝配
│   │   └── schemas.ts                      # MODIFIED — SuggestionCardSchema／parseSuggestionCards()
│   ├── copilot-analysis.ts                 # MODIFIED（大幅擴充）——
│   │                                        #   analyzeSuggestions()、whitelistFilter()、
│   │                                        #   catchUpSummaryIfStale()、背景並行節流、
│   │                                        #   runIncremental/scheduleIncremental 新增 priority 參數
│   └── session-manager.ts                  # MODIFIED — 呼叫 scheduleIncremental 前查詢 getPriority()
├── api/
│   ├── conversations/[id]/
│   │   ├── join.post.ts                    # MODIFIED — 呼叫 addJoinedConversation
│   │   ├── leave.post.ts                   # MODIFIED — 呼叫 removeJoinedConversation
│   │   ├── knowledge-search.post.ts        # NEW — FR-007～FR-011、FR-025
│   │   └── copilot/retry.post.ts           # MODIFIED — block 合法值新增 'suggestions'
│   ├── presence.post.ts                    # MODIFIED — away+joined 語意修正（研究 #8）
│   └── stream.get.ts                       # MODIFIED — 連線建立時復原背景 watch；attach() 支援
│                                            #            優先度升級（不再被 watched.has() 擋下）

app/
├── composables/
│   ├── useCopilotSession.ts                # MODIFIED — 訂閱 suggestion.updated
│   ├── useKnowledgeSearch.ts                # NEW — debounce 300ms、loading/error/hits
│   ├── useOverwriteConfirm.ts              # NEW — 草稿覆蓋確認，一鍵帶入／插入為回覆共用
│   │                                        #        （FR-018、憲法 8.4，研究 #11）
│   └── useConversationView.ts              # MODIFIED — 切換對話時送出真實 viewerJoined（研究 #8）
├── components/copilot/
│   ├── SuggestionCard.vue                  # NEW
│   ├── SuggestionList.vue                  # NEW
│   └── KnowledgeSearch.vue                 # NEW
└── pages/c/[conversationId].vue            # MODIFIED — 掛載建議卡／知識庫快查區塊

test/
├── agent-knowledge-provider.test.ts        # NEW
├── suggestion-whitelist.test.ts            # NEW
├── suggestion-send-path.test.ts            # NEW — 帶入內容送出仍走撞單檢查，無繞過路徑（SC-004）
├── copilot-analysis.test.ts                # MODIFIED（擴充）
├── catch-up-summary.test.ts                # NEW
├── presence-away-joined.test.ts            # NEW
├── stream-reconnect-background.test.ts     # NEW
├── knowledge-search-api.test.ts            # NEW
├── message-source.test.ts                  # MODIFIED — getPriority() 的聚合規則
└── realtime-http.ts                        # MODIFIED — smoke:realtime 場景擴充（US3 故障隔離、
                                             #            US4 背景更新）

docs/
├── ARCHITECTURE.md                          # MODIFIED — §18 M2/M3 內容同步、新增 §12.4（研究 #3、#12）
├── PLATFORM_CAPABILITY.md                   # MODIFIED — 罐頭訊息端點的實測結論（spike 17）
└── IMBRACE_QUESTIONS.md                     # MODIFIED — 新增檔案最後修改時間／SOP 編號制度提問（研究 #2）

scripts/spike/
└── 17-message-templates.ts                  # NEW — 罐頭訊息端點形狀實測（不影響本功能實作，
                                             #        結論供後續 feature 決定是否納入白名單來源）
```

**Structure Decision**: 沿用專案既有三層結構，不引入新頂層目錄。`server/services/knowledge/` 是
本功能唯一新增的子目錄，鏡射既有 `server/services/ai/` 的裝配模式（憲法附錄 A 命名慣例：
kebab-case 檔名、`use` 前綴 composable、PascalCase 元件）。多對話背景基礎設施的修正（研究 #8、#9）
刻意分散回既有檔案（`presence.post.ts`／`stream.get.ts`／`polling-message-source.ts`）而非集中成
一個新模組，因為這些修正本質是「修正既有機制裡的判斷錯誤」，集中成新模組反而會製造出一個看似
獨立、實則與原機制緊密耦合的假抽象。

## Complexity Tracking

*(無違反項目，本表留空)*
