# Implementation Plan: M2 遺留缺陷與量測補強

**Branch**: `feat/m2-copilot-panel` ｜ **Date**: 2026-09-02 ｜ **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-m2-residual-defects/spec.md`

## Summary

四類項目的共通點是**全部不會報錯**，因此本計畫的每一項技術決策都以「壞掉時什麼會變紅」為判準。

- **US1（雙分頁）**：憑證登記與 `session.watchers` 的唯一性單位由「客服身分」改為
  **server 端產生的 `connectionId`**（research.md #1），並補上**連線層級**的心跳＋TTL 存活兜底
  （新端點 `POST /api/connection/beat`，#3）。⚠️ 該心跳是 **upsert**：命中 0 筆時重新登記
  （#3a）—— 只抄 presence 的 45／20 秒而不抄它的 upsert 語意，背景分頁的計時器節流
  會讓兜底自己重現 US1 的原始缺陷。FR-004 以一條可執行的等式
  `watchers.length === pipeline.refs` 驗收。⚠️ **`leave.post.ts` 一行不動** —— 主動離開與關閉分頁
  今天天然是兩條路（#6），本計畫只改後者，並補一條守衛防止日後被「統一」。
- **US2（補算）**：缺口的**篩選**沿用既有的 `newCustomerMessagesSince()`（對整條 timeline 做差集），
  改的是**把它接到恢復路徑上**（#7）；⚠️ 抓取錨點是 **`timeline[0].messageId`**，
  **不是** `lastCoveredMessageId()` —— 後者是高水位，中段失敗後會被後續成功批次推過缺口，
  以它為錨點就永遠撈不到中段缺口（data-model §3「抓取範圍」）；歷史經 `setHistoryResolver()` 注入（比照 `setJoinedResolver()`，#10）；
  以 `CopilotAnalysisState.sentimentGap` 這個布林讓無缺口的正常路徑**零額外往返**（#9）；
  ⚠️ 缺口的**左界是時間軸第一個點**，不回頭補冷啟動 50 則視窗之前的訊息（#8）。
- **US3（引用品質）**：`buildSuggestionPrompt()` 加一份**顯式封閉清單**（#13），
  `whitelistFilter()` 一行不改（FR-014）；新增具名事件 `suggestion.citation.audited`
  放在**管線外**的 `server/utils/citation-audit.ts`（#15，這樣量測腳本才 import 得到），
  標準輸出為完整集合、額外落點是 JSONL 且**開檔**失敗只降級（#16）。
- **US4（量測）**：`SENTIMENT_CONCURRENCY` 改為模組載入時讀 env，掃描以
  **每檔位一個子行程**進行（#19 —— 同一行程內無法切換並行度）；量測核心重用
  `spike:progressive` 已經在記的兩列數據（#20）；`callAgent()` 帶上 AI 服務的
  client user id（**不是客服的 operatorId**，#21）。

**不新增**：provider 介面、SSE 事件型別、前端 UI 欄位、分析管線成員檔。

## Technical Context

**Language/Version**: TypeScript，Node ≥ 24（Nuxt 4，`ssr: false` + 完整 Nitro BFF）

**Primary Dependencies**: 沿用既有 Nuxt 4 / Vue 3 / Pinia / Zod / `@imbrace/sdk`（僅 server）/
`@nuxtjs/i18n`；**不新增任何套件**

**Storage**: 沿用 `CopilotAnalysisState`（2 小時 sliding TTL）與 `CopilotSession`。
`CopilotSession.watchers` 改形狀、`CopilotAnalysisState` 加一個 server-only 布林
（`sentimentGap`）。憑證登記維持 process-local `Map`（不進 `StateStore`，與現況相同）。

**Testing**: vitest（單元 + 對假 gateway 的整合測試）＋ `test/contract-guards.test.ts`（契約守衛）
＋ `npm run smoke`（HTTP route 與 cookie 往返、憑證外洩掃描）＋ `scripts/spike/*`（真實環境量測）

**Target Platform**: 單副本 Node server（`nuxt build` + `node-server` preset）

**Project Type**: Web application（Nuxt 4 前端 + Nitro BFF，同一個 repo）

**Performance Goals**: 不放寬任何既有門檻。情緒 15 秒 p90 **維持不動**（FR-020a），
其去留等 FR-018 掃描結果出來後再議。FR-021 省下每次 AI 呼叫的一趟往返（實測 54ms）。

**Constraints**:
- 補算 MUST NOT 讓 AI 呼叫量脫離「客戶發言次數」這個上界（003 SC-001）。
- 存活兜底的訊號 MUST 由**對側**（瀏覽器）發出 —— server 端心跳在半開連線下恆真；
  且該心跳 MUST 是 **upsert**（命中 0 筆時重新登記），否則背景分頁的計時器節流
  會讓兜底自己重現 US1 的原始缺陷（research.md #3a）。
- 稽核證據 MUST 落在生產路徑、MUST 不含 PII、標準輸出 MUST 是完整集合。
- 量測樣本 MUST NOT 並行取得（並行度正是被量的變數）：FR-018 的掃描約 1 小時，
  FR-017 的基線與改動後各約 21 分鐘，量測總時數約 **1 小時 40 分**。

**Scale/Scope**: 4 則 User Story、**26 條 FR**（FR-001～FR-021 ＋ 5 條 clarify 新增的
`a` 尾綴：FR-005a／006a／015a／018a／020a）、**9 條 SC**（SC-001～008 ＋ SC-002a）。
影響 **14 個既有檔案**、新增 **7 個檔案**（1 支 route、1 支 util、2 支 spike、3 支測試）。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 條 | 適用性 | 檢核結果 |
|---|---|---|
| **一、安全邊界** | 動到憑證登記；新增稽核日誌 | ✅ 通過。1.1：新端點 body 只有 `clientId`、回應只有 `{ ok: true }`，**不回傳也不接受任何 token**；`accessToken` 仍只存在 server 端 `Map`。1.3：借用的憑證仍**只用於唯讀輪詢**，本規格不新增任何寫入路徑；`user_id` 是 **AI 服務的 client user id、與客服身分無關**，不是操作歸屬（research.md #21）。1.5：稽核事件不含訊息全文與知識庫標題，且以**型別守**（`text?: never`）而非 review 保證；`invalidSopIds` 是模型憑空造的字串、非客戶內容，且另有**機械式**收斂（> 64 字元改記雜湊）而非只靠論證，理由與界的選法寫進契約 |
| **二、外部依賴的抽象邊界** | `AIProvider`／`KnowledgeProvider`／`MessageSource`／`StateStore` 簽章 | ✅ 通過。四個 provider 介面**全部不變**。`setHistoryResolver()` 是既有 `setJoinedResolver()` 的同型注入點（用來繞開「管線不得 import `copilot-runtime`」的守衛），**不是新的 provider 介面** —— 2.4 明文禁止對已定案依賴另包一層，這裡包的是相依方向，不是依賴本身。`user_id` 的取得與快取關在防腐層 `imbrace.ts`（SDK 繞道不得散落到 route） |
| **三、Copilot 不得拖垮主線** | US1 正是主線自己這一側破的；FR-015a 的降級 | ✅ 通過，且是 US1 的存在理由：3.1「AI 故障時客服 MUST 還能看對話」——雙分頁缺陷讓客服**連新訊息都收不到**，破口在主線。3.2：補算失敗維持該區塊 `error` ＋ 手動重試，其他區塊照常。**FR-015a 是 3.1 的一個反例的直接對策**：日誌落不了地 MUST NOT 賠掉服務（開檔失敗降級為只寫標準輸出）。3.3：不新增任何刻意阻斷情境，封閉集合不變 |
| **四、AI 輸出必須可驗證** | 4.3 的白名單流程 | ✅ 通過。FR-013 強化的正是 4.3 流程裡「**要求模型只能從 hits 的 id 中選擇**」那一步（把散在每筆 hit 的 id 收成一份顯式封閉清單）；4.3 的「後端再驗證一次」＝ `whitelistFilter()`，**一行不改**（FR-014）。4.2 的 Zod 驗證順序不變。4.4：`confidence` 的 null 規則不動。4.5：不改 `requiresData` 的處置 |
| **五、AI 產物寫入正式紀錄** | 不適用 | 本規格不寫入 Data Board |
| **六、資源使用** | 6.1 訂閱歸零即停止；6.2 背景節流 | ✅ 通過，且 **US1 修的正是 6.1 的判斷錯誤**：現行「訂閱數歸零」以客服身分計，第二個分頁存在時就已經算錯。6.2：背景並行上限與 debounce 不動；補算受**每輪 18 則缺口訊息（＝3 批）**上限（FR-009）且**不自行續排**，呼叫量的上界仍是「客戶發言次數」。6.4／6.5：不動訊息拉取與附件快取。FR-021 是純減法（少一趟往返） |
| **七、協同與資料一致性** | JOIN／LEAVE／presence 的傳播 | ✅ 通過。`leave.post.ts` **一行不動**；主動離開的傳播（`removeJoinedConversation()` ＋ 廣播 `control.updated`）不經 `watchers`，與連線計數天然分離（research.md #6）。7.3 的 JOIN 去重、7.2 的樂觀併發檢查皆不受影響。⚠️ presence 的 TTL／心跳**不動** —— 新的連線層級心跳是**另一支端點**，兩者回答的是不同問題（「有沒有人在看這個對話」vs「這條連線還在不在」），刻意不共用 |
| **八、介面與無障礙** | 前端只加一支心跳 | ✅ 通過。不新增 UI 元素、不新增文案（8.1／8.2／8.5 不受影響）；8.4 草稿保護不受影響（不碰 Composer 路徑） |
| **九、渲染與部署** | 9.2 多副本前需 Redis | ✅ 通過，限制與現況相同。⚠️ `watchers`（進 `StateStore`）與 `pipeline.refs`（process-local）的等式 I-4 **只在單副本成立** —— 這是既有落差（§18 M2 已盤點的八份 process-local 狀態同一家族），本規格不擴大也不解決，但 I-4 的測試 MUST 標明它驗的是單副本 |

### Complexity Tracking

| 偏離 | 為何需要 | 否決的簡單做法 |
|---|---|---|
| `SENTIMENT_CONCURRENCY` 開放 env 覆寫，與 `SENTIMENT_CHUNK_SIZE` 的「MUST NOT 有任何生產路徑改從外部覆寫」原則不一致 | FR-018 要求對 3／4／5 三個檔位各跑 n=45；並行度是 module-level `const`，**同一行程內無法切換**，掃描必須換行程，而換行程只能靠 env 傳遞 | ①「讓量測腳本自己複製一份並行邏輯」—— 違反本專案已吃過虧的「量測工具比正式路徑寬鬆會漏掉真的缺陷」；②「改成每次呼叫時讀的可變值」—— 那才是真的在生產路徑上開旋鈕。折衷是：只在**模組載入時**讀一次，並新增守衛斷言設定檔 MUST NOT 設定它 |

其餘項目皆無需偏離憲法。

**Phase 1 設計後複查**：`data-model.md`／兩份 `contracts/` 的決策
（連線層級三分、`sentimentGap` 布林、稽核事件放管線外、標準輸出為完整集合）
皆未新增外部依賴、未新增 provider 介面、未新增刻意阻斷情境、未繞過 Zod 或白名單、
未新增分析管線成員檔。上表結論不變。

## Project Structure

### Documentation (this feature)

```text
specs/005-m2-residual-defects/
├── plan.md                            # 本檔
├── research.md                        # Phase 0：22 項技術決策
├── data-model.md                      # Phase 1：四項既有形狀的修改
├── quickstart.md                      # Phase 1：驗證指南
├── contracts/
│   ├── connection-lifecycle.md        # US1：連線／分頁／客服三層與八條不變式（I-1～I-8）
│   └── citation-audit-event.md        # US3：具名事件（＝ SC-005 的驗收形式）
├── checklists/requirements.md         # 既有
├── spec.md                            # 既有
└── tasks.md                           # Phase 2 輸出（/speckit-tasks，本指令不產生）
```

### Source Code (repository root)

```text
server/
├── api/
│   ├── connection/
│   │   └── beat.post.ts               # 🆕 US1：連線層級存活心跳（FR-005a）
│   ├── stream.get.ts                  # ✏️ 產生 connectionId；登記與 attach 帶上它
│   └── presence.post.ts               # ✏️ setCredentialActivity() 加 clientId
├── services/
│   ├── credentials.ts                 # ✏️ US1 主場：登記改以 connectionId 為鍵、TTL 惰性回收
│   ├── session-manager.ts             # ✏️ US1：watchers 改連線計數；FR-004 的等式
│   ├── copilot-analysis.ts            # ✏️ US2：缺口計算、setHistoryResolver()、env 並行度
│   ├── copilot-runtime.ts             # ✏️ US2：載入時注入 history resolver
│   ├── analysis-state.ts              # ✏️ US2：sentimentGap 的三態轉移掛點
│   ├── blocks/suggestion.ts           # ✏️ US3：三條落定路徑發出稽核事件
│   ├── ai/imbrace-agent-provider.ts   # ✏️ US3：封閉清單；US4：callAgent 帶 user_id
│   └── imbrace.ts                     # ✏️ US4：AI client user id 的取得與快取（防腐層）
├── state/types.ts                     # ✏️ watchers 形狀、sentimentGap 欄位
└── utils/
    └── citation-audit.ts              # 🆕 US3：具名事件（⚠️ 管線外，量測腳本 import 得到）

app/
└── stores/stream.ts                   # ✏️ US1：連線建立後啟動 20 秒連線層級心跳
                                       #    （⚠️ 刻意不掛在 useConversationView.ts —— 那支的
                                       #      presence 心跳以「進入某個對話」為前提，
                                       #      而連線心跳必須與有沒有進入對話無關）

test/
├── contract-guards.test.ts            # ✏️ sentimentGap 不得進 shared/；env 不得設並行度；LEAVE 不得併入連線計數
├── connection-counting.test.ts        # 🆕 US1：八條不變式
├── sentiment-backfill.test.ts         # 🆕 US2：缺口、左界、空 timeline、18 則上限、零成本
└── citation-audit.test.ts             # 🆕 US3：六種 outcome、PII 型別守與長度收斂、開檔失敗降級

scripts/spike/
├── 26-sentiment-concurrency.ts        # 🆕 US4：檔位掃描（per-tier 子行程、三輪輪換）
└── 27-citation-quality.ts             # 🆕 US3：杜撰率與逐對話分布（n=45）
```

**Structure Decision**：沿用既有的 Nuxt 4 單一 repo 結構（`app/` 前端、`server/` Nitro BFF、
`shared/` 兩端共用型別、`test/` vitest、`scripts/spike/` 真實環境量測）。
本規格不新增任何目錄層級，唯一的新目錄是 `server/api/connection/`（Nitro 的檔案路由慣例）。

⚠️ **`server/utils/citation-audit.ts` 放在管線外是刻意的**：拆檔守衛禁止「管線外值 import
管線內部檔」，稽核模組若放進管線，FR-017 的量測腳本就 import 不到它，
唯一的繞法是從 barrel re-export —— 那等於把稽核塞進分析管線的對外介面。

⚠️ **本規格不新增分析管線成員檔**，因此 `@analysis-pipeline` 標記與
`test/contract-guards.test.ts` 的**狀態擁有權表都不需要動**。
（唯一新增的狀態 `sentimentGap` 是 `CopilotAnalysisState` 的欄位，不是模組層 Map，
走的是「`shared/` 不得出現」那條守衛，不是擁有權那條。）

## 與拆檔第三刀的先後關係

`docs/ARCHITECTURE.md` §18 M2「分析管線拆檔」登記的第三刀
（`blocks/sentiment.ts`，約 350 行）**觸發條件是「005 的情緒改動落地之後」**，不是時程。

情緒目前刻意留在 barrel 未切，正是因為 US2 要改情緒的批次邏輯 ——
重構與 feature 撞在同一個 diff 裡兩邊都不可讀，「行為零變更」也就無從斷言。
**因此順序是：005 US2 先落地 → 才切第三刀。** 本計畫不執行第三刀。
