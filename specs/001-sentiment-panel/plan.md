# Implementation Plan: 情緒面板（摘要卡與情緒 Sparkline）

**Branch**: `001-sentiment-panel` | **Date**: 2026-08-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-sentiment-panel/spec.md`

## Summary

客服 JOIN 對話後，系統自動產生並持續更新兩個並呈區塊——結構化摘要卡與情緒 sparkline——取代客服自行讀完整段歷史的空窗期。兩區塊各自獨立成功／失敗；AI 分析故障時僅該區塊降級（顯示錯誤與重試），訊息流與 Composer 完全不受影響（憲法 3.1、3.2）。技術路徑：擴充既有 `CopilotSession`（`server/state/types.ts`）與 SSE 事件契約（`shared/types/events.ts`）以承載摘要／情緒的內容與逐區塊狀態；新增 `AIProvider` 介面與 `MockAIProvider` 實作（依 `ARCHITECTURE.md` §8.2b，M2 先以 mock 完成 UI，真實 `ImbraceAgentProvider` 為後續任務）；新增伺服端分析管線負責冷啟動／增量觸發、debounce、逐區塊重試與退避；前端新增 `SummaryCard.vue`／`SentimentGauge.vue` 與對應 composable 消費既有 SSE 串流。

## Technical Context

**Language/Version**: TypeScript，Node ≥ 24（Nuxt 4，`ssr: false` + 完整 Nitro BFF）

**Primary Dependencies**: Nuxt 4 / Vue 3 / Pinia（既有）；Zod（AI 輸出驗證，憲法 4.2）；`@imbrace/sdk`（僅 server，本功能不直接呼叫，透過既有 `server/services/imbrace.ts` 防腐層）；`@nuxtjs/i18n`（新文案集中管理，憲法 8.5）。不新增圖表庫——情緒 sparkline 手刻 SVG（`ARCHITECTURE.md` §14.5，資料量小，深色模式與動畫更好控）

**Storage**: 沿用既有 `StateStore` 抽象（`server/state/types.ts`）的記憶體實作模式，但摘要與情緒序列**不掛在 `CopilotSession` 上**——2026-08-26 訂正：原設計掛在 `CopilotSession`，但該物件的生命週期由 watcher refcount 管理（`watchers.length === 0` 即整組刪除，見 `server/services/session-manager.ts` `releasePipeline()`），與 FR-010「客服切走再切回，分析結果須保留」直接衝突。改為在 `StateStore` 新增 `getAnalysisState`／`setAnalysisState` 方法，操作一個以 `conversationId` 為鍵、與 `CopilotSession` 完全獨立的資料集（`CopilotAnalysisState`，見 data-model.md），生命週期採 sliding TTL（2 小時，每次讀寫皆續期），不受 watcher 數量影響，比照既有 `presence` 的 `Expiring<T>` 雙軌淘汰模式（`server/state/memory-store.ts`）。不寫入 Data Board（結案摘要屬 M3，非本功能範圍）

**Testing**: Vitest（單元測試：重試/退避策略、附件輪的中性標記邏輯、Zod schema 驗證；對假 gateway 的整合測試沿用 `test/mock-gateway.ts` 模式）；`npm run smoke:realtime` 需相應擴充以涵蓋 `summary.updated` / `sentiment.updated` 事件的收斂

**Target Platform**: Node server（Docker → K8s，單副本沿用記憶體 `StateStore`）；瀏覽器端為客服操作的 console 頁面（`app/pages/c/[conversationId].vue`）

**Project Type**: 單一 Nuxt 應用內建 Nitro BFF（非前後端分離的兩個專案）——沿用 `app/`（前端）／`server/`（BFF）／`shared/`（共用型別）三層既有結構

**Performance Goals**: JOIN 後 90% 情況 3 秒內面板區塊出現並標示分析中（SC-001）；90% 情況下摘要 10 秒內、情緒 15 秒內呈現實質內容，兩者皆同時適用冷啟動與增量更新（SC-005；⚠️ 2026-09-01 由單一的 10 秒拆為兩個門檻，且摘要那一半**實測未達、列為已知落差** —— 拆分理由與三輪證據見 `spec.md` SC-005，此處不重述）；增量分析的模型輸入僅含既有摘要與新訊息，不含完整歷史（FR-004，效果以輸入內容驗證而非延遲時間推論）

**Constraints**: 任何 AI 故障 MUST NOT 阻斷訊息流或 Composer（憲法 3.1、3.2；SC-002 要求 100%）；暫時性失敗（單次呼叫逾時 15s／5xx）指數退避自動重試至多 2 次（1s → 4s）、總預算 ≤ 40 秒，非暫時性失敗（含認證失敗、請求無效、Zod 驗證失敗）不自動重試（FR-014）；429 不進入區塊層級重試迴圈，在全域退避佇列（M3）建立前直接轉錯誤狀態，以免逐區塊各自重試形成風暴（FR-014）；情緒 sparkline 僅繪最近 50 點，但全部評分點須保留供全量統計使用（FR-015）；情緒異常示警僅在標籤達「挫折」或「生氣」時觸發，且 MUST 以顏色＋圖示＋文字三者並呈（FR-003、憲法 8.1）

**Scale/Scope**: 僅涵蓋客服正在聚焦查看的單一對話；背景對話（已 JOIN 但未聚焦）的持續分析與徽記提醒不在本次規格範圍內（spec.md Assumptions；對應憲法 6.2 的前景/背景分級將於後續多對話切換功能落地）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 條 | 適用性 | 檢核結果 |
|---|---|---|
| **一、安全邊界** | 本功能不直接處理憑證；AI 呼叫走既有防腐層模式 | ✅ 通過。摘要／情緒內容仍屬客戶對話個資，日誌與監控 MUST NOT 輸出全文（1.5）——分析管線的錯誤記錄需遵守，已納入 research.md 決策 |
| **二、外部依賴的抽象邊界** | 新增 `AIProvider` 介面 | ✅ 通過。介面定義於 `shared/types/copilot.ts`，M2 僅接 `MockAIProvider`，未來換 `ImbraceAgentProvider`／`VikiAIProvider` 只需換裝配點（2.1、2.2）。`StateStore` 新增 `getAnalysisState`／`setAnalysisState` 方法（比照既有 `addPresence` 的 TTL 傳參模式），從 day 1 即為 async（2.3 已滿足），不改動既有方法簽名（2026-08-26 訂正：原設計誤寫為擴充 `CopilotSession`／沿用 `setCopilotSession`，已改為獨立於 `CopilotSession` 的新方法，見 Storage 一節與 data-model.md） |
| **三、Copilot 不得拖垮主線** | 本功能的核心約束 | ✅ 通過，且是本規格 P1 使用者故事的直接體現。FR-006／FR-007／FR-014 對應 3.1、3.2；未新增任何刻意阻斷情境，3.3 封閉集合不變 |
| **四、AI 輸出必須可驗證** | 摘要與情緒序列皆為 AI 產物 | ✅ 通過。4.1 structured output＋4.2 Zod 驗證於 `shared/types/copilot.ts` 的 schema 落地；4.5 事實不得推測——摘要的 `keyFacts`／`attempted`／`openIssues` 不得由模型杜撰工單編號等，缺資料時循既有 `requiresData` 精神處理（本功能摘要卡本身無需此欄位，情緒與摘要皆為觀察性輸出而非承諾性輸出，風險較低，仍以 Zod 擋掉格式外資料） |
| **五、AI 產物寫入正式紀錄** | 不適用 | 本功能不寫入 Data Board（結案摘要屬 M3） |
| **六、資源使用** | 6.2／6.3 | ✅ 通過。6.2：本規格範圍即僅前景對話（見 Scale/Scope）；6.3：增量分析回傳 patch（FR-004）。6.5（快取）不適用——附件文字化管線已排除本次範圍，延後至 M3（見 spec.md FR-013、Assumptions，2026-08-26 訂正） |
| **七、協同與資料一致性** | 不直接涉及 JOIN／送出訊息邏輯 | 不適用（本功能不改動 `composer-block.ts`、撞單檢查等既有機制，僅消費其存在的事實以確保「不阻斷」） |
| **八、介面與無障礙** | 8.1／8.2／8.3／8.5 | ✅ 通過。8.1：情緒示警三者並呈（FR-003）；8.2：重試按鈕須可鍵盤操作；8.3：本功能不涉及訊息流虛擬滾動，不影響既有實作；8.5：新文案入 i18n |
| **九、渲染與部署** | 不涉及 `nuxt.config.ts` 或部署形態變更 | 不適用 |

無違反項目，**Complexity Tracking 表留空**。

**Phase 1 設計後複查**：`data-model.md`／`contracts/` 產出的新設計決策（`SentimentMarker` 判別聯集、`retry-policy.ts` 獨立模組、`summary.updated`/`sentiment.updated` 整塊覆蓋式事件、`/copilot/retry` 非同步 202 端點）皆未新增外部依賴、未新增刻意阻斷情境、未繞過 Zod 驗證或 PII 記錄原則。上表結論不變，無需修訂。

## Project Structure

### Documentation (this feature)

```text
specs/001-sentiment-panel/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── copilot-sse-events.md
│   └── copilot-retry-api.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
shared/types/
├── copilot.ts                          # NEW — ConversationSummary、SentimentPoint、
│                                        #        SentimentMarker、AnalysisBlockStatus、AIProvider 介面
└── events.ts                           # MODIFIED — CopilotEvent 新增 summary.updated / sentiment.updated

server/
├── state/
│   ├── types.ts                        # MODIFIED — 新增 CopilotAnalysisState 型別與
│   │                                    #            StateStore.getAnalysisState／setAnalysisState
│   │                                    #            （不擴充 CopilotSession，見 2026-08-26 訂正）
│   └── memory-store.ts                 # MODIFIED — 比照既有 `presence` 的 Expiring<T> 雙軌淘汰模式
│                                        #            （讀取時惰性淘汰＋定期掃除）新增 analysisStates
│                                        #            Map，sliding TTL 2 小時
├── services/
│   ├── ai/
│   │   ├── mock-ai-provider.ts         # NEW — AIProvider 的 mock 實作（M2 UI 先行）
│   │   └── retry-policy.ts             # NEW — FR-014 的暫時性/非暫時性判別與退避時序
│   └── copilot-analysis.ts             # NEW — 冷啟動／增量觸發、debounce（§11.1）、
│                                        #        呼叫 AIProvider、寫回 CopilotSession、publish SSE
└── api/conversations/[id]/copilot/
    └── retry.post.ts                   # NEW — 手動重試單一區塊（FR-008）

app/
├── composables/
│   └── useCopilotSession.ts            # NEW — 訂閱 summary.updated / sentiment.updated，
│                                        #        暴露逐區塊 status 供元件使用
├── components/copilot/
│   ├── SummaryCard.vue                 # NEW
│   └── SentimentGauge.vue              # NEW — 手刻 SVG sparkline（§14.5）
└── pages/c/[conversationId].vue        # MODIFIED — 掛載情緒面板於右欄

test/
├── ai-retry-policy.test.ts             # NEW — FR-014 重試/退避單元測試
├── sentiment-attachment-turn.test.ts   # NEW — FR-012 純附件輪的中性標記單元測試
└── copilot-analysis.test.ts            # NEW — 冷啟動/增量觸發、debounce、patch-only 輸入驗證
```

**Structure Decision**: 沿用專案既有的單一 Nuxt 應用三層結構（`app/` 前端、`server/` Nitro BFF、`shared/` 共用型別），不引入新的頂層目錄或子專案。本功能新增的檔案分佈於既有的 `services/`、`components/`、`composables/` 慣例位置，符合憲法附錄 A 命名慣例（PascalCase 元件、`use` 前綴 composable、kebab-case 檔名）。

## Complexity Tracking

*(無違反項目，本表留空)*
