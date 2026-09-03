# Implementation Plan: 結案摘要與人審面板

**Branch**: `feat/m3-closure-summary`（spec 目錄 `specs/006-closure-handoff-summary`）
｜ **Date**: 2026-09-03 ｜ **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-closure-handoff-summary/spec.md`

## Summary

本規格是**第一個會寫入正式 CRM 的功能**，因此每一項技術決策的判準都是
「壞掉時什麼會變紅」——而 Data Board 的特性剛好相反：**少一欄、多一筆、寫錯區間，全都不會報錯**。

- **US1（人審面板）**：`closeConversation()` 由「先 leave → 停止分析 → 隱藏面板」改為
  **只開面板**（research #16）——LEAVE 移到寫入成功之後（FR-033）。這使 FR-005
  「結案期間分析照常執行、門檻維持 003 FR-012 的單一條件」**靠刪掉一行就自動成立**，
  不必為結案新增任何分析門檻。三支端點（`scopes`／`draft`／`commit`）**全部無狀態**，
  草稿只活在瀏覽器分頁的 Pinia store（FR-040 的實作方式，不是效能取捨）。
  唯讀欄位**收在巢狀的 `readonly` 物件裡**、且寫入時由 server 重算，
  讓 FR-010a 不必依賴「前端每個欄位都記得加 disabled」。
- **US2（冪等）**：冪等鍵是 **`draft_id`**，`draftId` 由 **server 在產生草稿時**產生
  ——「重新產生 ＝ 新草稿 ＝ 新 id」與「重試 ＝ 同一份 ＝ 同一個 id」的差別完全由它承載。
  寫入固定三步 `search(draft_id)` → `create`／`update` → **`getItem` 回查**（憲法 5.3、FR-031）。
- **US3（失敗不得顯示成功）**：四種失敗形態在前端**共用同一條路徑**（回 `ready` ＋掛錯誤），
  沒有獨立的 `writeFailed` 狀態（data-model §5）。第四種（200 但回查不存在）是本規格
  最重要的一條測試——少了它，「Board 上其實沒有」永遠不會被發現。
- **US4（schema script）**：`--verify` **同時比對名稱、型別與受控詞彙的選項**
  ——只比名稱的話，`sentiment_trough` 被建成 ShortText 一樣不會報錯（契約 B3、B4）。

**⚠️ 前置實測已完成（2026-09-03）**：`spike:board-write`（29）與 `spike:closure-agent`（31）
已跑，**10 項假設中 3 項被推翻，且三項全部是不報錯的靜默失效** ——
`createField()` 回的是整個 board 不是 field（SDK 註解寫反）、`search(filter:)` 被忽略、
`search(sort:)` 的欄位被忽略。三項都已反映在下方的 Constraints 與兩份契約。
確認的兩項是好消息：六種欄位型別皆可建，且未設定的 `Number` 回讀為 `null`（FR-022b 成立）。
結案 agent 8/8 合格、受控詞彙 0 挑錯，**模型維持 `gemma-3-27b`**。

**⚠️ 最重要的發現（research #1）**：**iMBrace 後台的四個 agent 沒有一個產得出 `ClosureSummary`。**
摘要 agent 的 `core_task` 逐字寫死了 `ConversationSummary` 的九個欄位，與結案摘要沒有交集。
因此需要**在後台新增第五個 agent** `AgentCopilot_結案摘要_agent` ——
這是本規格唯一一項 repo 外的前置作業。緩解：`MockAIProvider.summarizeClosure()`
讓 **US1～US3 的整條路徑（面板、編輯、冪等、四種失敗）在沒有該 agent 時仍可完整開發與驗收**，
真 agent 只影響摘要內容品質。

**不新增**：SSE 事件型別、provider 介面（`AIProvider` 加一個方法，不是新介面）、
權限模型、刻意阻斷情境、相依套件、對外契約（平台側對話狀態不動）。

## Technical Context

**Language/Version**：TypeScript，Node ≥ 24（Nuxt 4，`ssr: false` ＋ 完整 Nitro BFF）

**Primary Dependencies**：沿用既有 Nuxt 4 / Vue 3 / Pinia / Zod / `@imbrace/sdk`（僅 server）/
`@nuxtjs/i18n` / `@nuxt/ui`；**不新增任何套件**（受控詞彙設定檔改用 `.ts` 而非 `.yaml` 正是為此，research #19）

**Storage**：
- **正式紀錄** → Data Board（`AgentCopilot_ClosureSummary`），本規格第一次使用
- **草稿** → 瀏覽器分頁的 Pinia store，**不進 `localStorage`、不進 `StateStore`、不進 `CopilotAnalysisState`**
- **情緒數值來源** → 既有的 `CopilotAnalysisState.sentimentBlock.timeline`（2 小時 sliding TTL），唯讀

**Testing**：vitest（單元 ＋ 對假 gateway 的整合測試）＋ `test/contract-guards.test.ts`（新增四條守衛）
＋ `npm run smoke`（HTTP route／cookie 往返／憑證外洩掃描）＋ `scripts/spike/*`（真實環境實測與量測）

**Target Platform**：單副本 Node server（`nuxt build` ＋ `node-server` preset）

**Project Type**：Web application（Nuxt 4 前端 ＋ Nitro BFF，同一個 repo）

**Performance Goals**：**分成兩個性質相反的預算，MUST NOT 互相污染**（research #20）。
- **摘要產生：不設固定秒數門檻**（2026-09-03 裁示，SC-004 已改寫）。耗時由涵蓋區間長度決定，
  訂任何秒數都是錯的口徑。改以「等待期間 100% 誠實」驗收（FR-046a），且**全程可取消**。
  參考值：短區間（9 則）中位數 9.4 秒（`spike:closure-agent`，n=8）；長區間逾 1 分鐘可接受。
- **寫入路徑：30 秒硬逾時**（FR-032a）。工作量固定為三次 Board 呼叫（實測次秒級），
  正是該有門檻的那一類。⚠️ 它是 FR-040a「寫入中不可取消」的**成立前提** ——
  兩者缺一，客服會被困在既不能取消也不會自己結束的狀態裡。

⚠️ **MUST NOT 為了搶時間就先用預設區間跑一次 AI**——客服改選區間時那次必定被丟棄。

**Constraints**：
- 寫入 MUST 以**發起者自己的 session token** 執行（憲法 1.3）；`clientForApiKey()` 只用於 setup script。
- 冪等 MUST 由「寫入前查詢 ＋ 寫入後回查」共同保證，**MUST NOT 假設平台會擋重複**
  （實測 5 個 board `uniqueSeen: 0`）。
- ⚠️ **MUST NOT 依賴 `boards.search()` 的 `filter` 或 `sort`** —— 2026-09-03 實測**兩者都被靜默忽略**
  （`filter` 回整批；`sort` 拿不存在的欄位排會得到相同順序，實際依建立時間排）。
  過濾與排序一律用 `q` 粗篩後**本地**做（research #8／#9）。
- ⚠️ **欄位 id MUST 由 `boards.get()` 反查**，MUST NOT 取 `createField()` 的回傳值
  （SDK 註解寫反了，實際回的是整個 board；照它做會讓所有欄位共用同一把 id 而平台照樣回 200，
  research #5）。
- 寫入端點 **MUST NOT 接觸任何訊息取數路徑**——否則 FR-020 的快照語意會靜默失效（契約 R3.3）。
- `sentimentTrough` **MUST NOT** 取 `sentimentBlock.stats.lowestScore`（FR-022a）。
- 情緒三數值的「留空」與「0」在紀錄上 MUST 可區分（FR-022b）。
- 結案狀態 MUST NOT 持久化（FR-040）——這與憲法 8.4 的關係見下方 Constitution Check 第八條。

**Scale/Scope**：4 則 User Story、**53 條 FR**（FR-001～005、010～019、020～022b、030～035、
040～047b、050～052，含 20 條字母尾綴）、**10 條 SC**（SC-001～008 ＋ SC-006a／006b）。
新增 **3 支 route**、**1 支 setup script**、**2 支 spike**、
**1 個 Pinia store**、**1 份設定檔**、**4 個前端元件**；影響約 **12 個既有檔案**。
另有 **4 筆文件改判義務**（`categories.yaml` 三處落點、`period_origin` 三處落點，＋ `IMBRACE_QUESTIONS.md` D 段與 `DESIGN_FEEDBACK.md` D 段**已完成**）。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 條 | 適用性 | 檢核結果 |
|---|---|---|
| **一、安全邊界** | 新增三支端點與一支 setup script，皆碰憑證 | ✅ 通過。**1.1**：三支端點的回應只含草稿與紀錄內容，無 token；`IMBRACE_CLOSURE_BOARD_ID`／`IMBRACE_CLOSURE_AGENT_ID` 進 server-side `runtimeConfig`，**MUST NOT 進 `runtimeConfig.public`**。**1.2**：Board API 全部關在 `server/services/imbrace.ts` 的防腐層與 `server/services/closure/board-repository.ts`，route 不直接碰 SDK；既有守衛 `grep -rn "@imbrace/sdk" app/ shared/` 必須維持零結果。**1.3**：結案寫入是**寫入操作**，MUST 以客服自己的 session token 執行，**MUST NOT** 借用登記處的輪詢憑證——否則 `reviewed_by` 的稽核軌跡會指向錯的人，而那正是本規格的產品價值本體。`clientForApiKey()` 只用於 setup script（該函式註解逐字寫著這個用途）。**1.5**：`period_sentiment_note` 是系統產的說明文字、不含客戶原話；日誌只記 `draftId`／`recordId`，**MUST NOT** 記草稿內容——`summary`／`intent` 是客戶對話個資 |
| **二、外部依賴的抽象邊界** | `AIProvider` 加一個方法；Board 是新的外部依賴 | ✅ 通過。`AIProvider` 加 `summarizeClosure()` 是**既有介面的擴充**，不是新 provider——`MockAIProvider` 與 `ImbraceAgentProvider` 各補一份實作，組裝點不變（**2.2**）。**Board 刻意不包 provider 介面**：**2.4** 明文禁止對已定案依賴另包一層，而 Data Board 是 iMBrace 的既定產品、不在「規格未定」之列；隔離已由防腐層（`imbrace.ts`）承擔。`board-repository.ts` 是**倉儲**不是 provider——它有唯一實作、不為替換而存在。**2.3** 不適用（未新增 `StateStore`／`EventBus` 方法） |
| **三、Copilot 不得拖垮主線** | 結案期間的輸入框、服務模式、故障呈現 | ✅ 通過。**3.1**：FR-042 逐字要求結案期間**輸入框 MUST NOT 被鎖定**——這正是 3.1「還能看對話、還能回覆」的落點。⚠️ FR-043 的「服務模式唯讀」看似阻斷，但服務模式是**設定項**、不在 3.1 的保護標的內（2026-08-28 拍板，spec.md Edge Cases 已記錄）。**3.2**：候選查詢失敗（FR-021h）、摘要產生失敗（FR-046）、寫入失敗（FR-032）三者一律**該區塊顯示錯誤與重試**，其餘五個區塊照常運作；MUST NOT 用全頁錯誤或 modal 打斷。**3.3**：**不新增任何刻意阻斷情境**——FR-034 的他人結案提示逐字寫明是**告知而非攔截**，MUST NOT 做成需要額外確認的攔截，封閉集合維持三項不變 |
| **四、AI 輸出必須可驗證** | 新增一條 AI 路徑（第五個 agent） | ✅ 通過。**4.1／4.2**：`summarizeClosure()` 的輸出經 Zod schema 驗證後才進系統，schema 落在既有的 `server/services/ai/schemas.ts`。**4.3**：`citedSopIds` 走既有的白名單後驗，不在檢索命中內者丟棄該 id。**4.4**：`confidence` 無真實依據時為 `null`——⚠️ §11.5 現行把 `ClosureSummary.confidence` 標為 `number`，落地時 MUST 改為 `number \| null`（data-model §3）。**4.5**：`sentiment*` 在評分點不齊時**留空**，MUST NOT 以現有點的最低值頂替（FR-022b）；則數數不完時顯示「超過 500 則」而非猜一個數字。**4.6**：受控詞彙取自 `config/categories.ts`，白名單外的值該欄位留空並要求客服選擇——⚠️ 設定檔用 `.ts` 而非條文寫的 `.yaml`，見下方 Complexity Tracking |
| **五、AI 產物寫入正式紀錄** | **本規格就是這一條的落點** | ✅ 通過，且是本規格的存在理由。**5.1**：FR-010／FR-011／FR-012 三條合起來即為條文本身——摘要先以可編輯形式呈現、只在明確按下時寫入、寫入的是編輯後版本。**5.2**：**本規格不交付任何自動寫入路徑**；FR-014 保留「日後若有，MUST 標 `reviewed_by = null`」的規則，Board 的 `reviewed_by` 允許留空正是為此。**5.3**：冪等單位是**草稿**——以 `draft_id` 比對，**MUST NOT** 是 `conversation_id`；⚠️ 實測 `filter` 被平台靜默忽略，因此比對 MUST 在**本地**做（research #8）；主鍵 `record_id` 獨立，`conversation_id` 是可重複索引；三步流程（查詢 → 寫入 → 回查）逐字落實於契約 R3.4／R3.5。⚠️ 同一對話多筆並存的兩種成因（多次服務、多位客服）各有一條會紅的測試 |
| **六、資源使用** | 新增一條 AI 路徑與一次歷史掃描 | ✅ 通過。**6.1**：不動輪詢訂閱；⚠️ FR-005 讓結案期間**仍維持 JOIN**，訂閱數本來就沒歸零，不影響「歸零即停止」。**6.2**：結案摘要**只在客服明確按下時**產生一次，不進背景重算、不受背景節流管轄——它不是分析管線的成員。⚠️ 也因此 **MUST NOT** 為了搶時間而預先產生（research #20），那會讓每個對話都多跑一次 AI 呼叫，正是 §14.1.1 拒絕讓第 6 區塊常駐的同一個理由。**6.4**：則數掃描沿用既有的 `skip` 分頁路徑（平台不支援增量），並有 500 則上限。**6.5**：不碰附件路徑 |
| **七、協同與資料一致性** | LEAVE 時機改變；presence 加一個欄位 | ✅ 通過。**7.1**：**MUST NOT 阻擋兩位客服同時結案**（FR-045），與「JOIN 不是排他鎖」同一原則——策略仍是讓碰撞被看見而非防止碰撞。**7.2**：不碰送出路徑與樂觀併發檢查。**7.3**：不碰 JOIN 去重。**7.5**：`reviewed_by`／`reviewed_at` 由 server 依 session 填、**MUST NOT** 取自 request body（契約 R3.6）——從 body 取等於讓稽核欄位可偽造。**7.6**：**不新增權限模型**，誰能結案沿用既有 JOIN 判定，不引入角色概念。⚠️ presence 新增的是 `PresenceEntry.closing: boolean`，**不是** `PresenceState` 的第四個值——理由與 `joined` 不併進 `state` 完全相同（research #18） |
| **八、介面與無障礙** | 新增第 6 區塊與涵蓋範圍選擇器 | ✅ 通過。**8.1**：0 則的候選以 `circle-slash-2` icon ＋ `cursor:not-allowed` ＋ 灰底表達，**不只靠顏色**；則數 > 150 的 `--warn` 色**同時**有數字本身，顏色只是強化。**8.2**：候選清單以 `role="button"` ＋ `tabIndex` ＋ `aria-expanded` 實作（`DESIGN_TOKENS.md` §7.4 的逐字規格），0 則列 `tabIndex:-1` 讓鍵盤跳過；自訂起算時間彈窗為 `role="dialog"` ＋ Esc 關閉。**8.3**：不碰訊息流虛擬滾動。**8.5**：所有新文案進 i18n。⚠️ **8.4 與 FR-040 的表面衝突**：8.4「草稿絕不遺失」的標的是 **Composer 草稿**（客服自己打的字，遺失無從復原）；結案草稿是**模型產物**，重按一次即可重生且尚未寫入任何紀錄，FR-040 因此逐字要求「重新整理等同取消，且不需任何清理或補償動作」。**這不是偏離，是兩個不同的標的**——但 MUST 寫進 `app/stores/closure.ts` 的檔頭註解，否則下一個人看到「草稿」就會依 8.4 加上持久化，而那會讓 FR-040 靜默失效 |
| **九、渲染與部署** | 新增環境變數與一支 setup script | ✅ 通過，限制與現況相同。**9.1**：不動 `nuxt.config.ts` 的渲染設定（只加兩個 `runtimeConfig` 鍵）。**9.2**：⚠️ **本規格不新增任何 process-local 狀態**——欄位 id 快取是純衍生的唯讀快取（TTL 10 分鐘、失效只是多一次呼叫），不是狀態；草稿住在瀏覽器。因此多副本前的 Redis 前置條件**不因本規格擴大** |

### Complexity Tracking

| 偏離 | 為何需要 | 否決的簡單做法 |
|---|---|---|
| **受控詞彙設定檔用 `config/categories.ts`，而憲法 4.6 與 §11.5／§11.7 逐字寫的是 `config/categories.yaml`** | 這份清單有四個消費者（AI prompt、server 後驗、面板選單、setup script 的選項建立）。`.ts` 換到一件 `.yaml` 換不到的東西：`RESOLUTIONS satisfies readonly ClosureSummary['resolution'][]` 讓「設定檔值域」與「型別字面聯集」的分岔**在 typecheck 就會紅**。而 `resolution`／`sentimentOutcome` 的值域本來就寫死在 §11.5 的型別裡，兩處分岔是必然會發生的事 | ① `.yaml` ＋ 新增 `yaml` 套件：照抄條文最省事，但換來一個相依、一份執行期解析，且失去上述編譯期保證，一致性得靠一條可能被漏寫的測試；② `.json`：無註解、無型別，且 `import ... with { type: 'json' }` 在 tsx／Nitro／vitest 三個載入器下行為不一致（本專案路徑含空白，載入器問題已吃過虧） |

⚠️ **這項偏離帶有文件改判義務**：條文提到的檔名出現在三處
（`CONSTITUTION.md` 4.6、`ARCHITECTURE.md` §11.5、§11.7），落地時 MUST 一併訂正。
依 CLAUDE.md 的規則，驗法是 `grep -rn "categories.yaml" docs/` 必須零結果。
⚠️ **改的是條文括號內的指標，不是規則本身**（規則是「受控詞彙 MUST 取自設定檔」，不變），
因此依附錄 B.1 屬 PATCH 級訂正，不是修憲。

其餘項目皆無需偏離憲法。

**Phase 1 設計後複查**：`research.md` 的 24 項決策、`data-model.md` 的四個實體與狀態機、
兩份 `contracts/` 的規則，皆未新增 provider 介面、未新增 SSE 事件、未新增刻意阻斷情境、
未新增權限模型、未繞過 Zod 或白名單後驗、未新增相依套件、未擴大多副本的既有落差。
唯一新增的 AI 路徑（第五個 agent）走既有的 `AIProvider` 介面與既有的 schema 檔。上表結論不變。

## Project Structure

### Documentation (this feature)

```text
specs/006-closure-handoff-summary/
├── plan.md                            # 本檔
├── research.md                        # Phase 0：24 項決策（5 項待實測已全部跑完）
├── data-model.md                      # Phase 1：四個實體、驗證規則、前端狀態機
├── quickstart.md                      # Phase 1：逐條 SC 的驗證方式
├── contracts/
│   ├── closure-http-api.md            # 三支 BFF 端點與 11 條硬性規則
│   └── closure-board-schema.md        # Board 欄位表（＝ --verify 的比對來源）＋ setup script
├── checklists/requirements.md         # 既有
├── spec.md                            # 既有
└── tasks.md                           # Phase 2 輸出（/speckit-tasks，本指令不產生）
```

### Source Code (repository root)

```text
config/
└── categories.ts                      # 🆕 受控詞彙白名單（憲法 4.6、FR-015）
                                       #    ⚠️ 四個消費者共用；含編譯期一致性斷言

shared/types/
├── copilot.ts                         # ✏️ ClosureDraft／ClosurePeriod／ClosureSummary
                                       #    ＋ AIProvider.summarizeClosure()
└── conversation.ts                    # ✏️ PresenceEntry.closing（⚠️ PresenceState 三值不動）

server/
├── api/conversations/[id]/closure/
│   ├── scopes.post.ts                 # 🆕 候選清單＋則數（FR-021 系列）
│   ├── draft.post.ts                  # 🆕 取快照＋產生草稿（FR-020、FR-022）
│   └── commit.post.ts                 # 🆕 冪等寫入＋回查（FR-030～FR-035）
│                                      #    ⚠️ MUST NOT 接觸任何訊息取數路徑
├── services/
│   ├── closure/
│   │   ├── board-repository.ts        # 🆕 Board CRUD ＋ 三步冪等（憲法 5.3）
│   │   ├── period.ts                  # 🆕 候選推導、則數掃描（上限 500）、起點解析
│   │   └── sentiment-range.ts         # 🆕 區間內三數值（⚠️ 不得讀 stats.lowestScore）
│   ├── imbrace.ts                     # ✏️ Board API 的防腐層包裝（SDK 繞道不得散落）
│   ├── ai/
│   │   ├── imbrace-agent-provider.ts  # ✏️ summarizeClosure()（第五個 agent）
│   │   ├── mock-ai-provider.ts        # ✏️ summarizeClosure()（US1～US3 靠它驗收）
│   │   └── schemas.ts                 # ✏️ ClosureDraft 的 Zod schema（憲法 4.2）
│   └── presence.ts                    # ✏️ closing 欄位的聚合（FR-045，SHOULD）
└── api/presence.post.ts               # ✏️ 接收 closing

app/
├── stores/closure.ts                  # 🆕 tab-local 結案狀態
│                                      #    ⚠️ MUST NOT localStorage（FR-040 vs 憲法 8.4，見檔頭）
├── components/copilot/
│   ├── ClosureBlock.vue               # 🆕 第 6 區塊（畫布 2a ⑥；⚠️ 未結案時整塊不存在）
│   ├── ClosureScopePicker.vue         # 🆕 涵蓋範圍選擇器（畫布 2b／DESIGN_TOKENS §7.5）
│   └── ClosureCustomStart.vue         # 🆕 自訂起算時間彈窗（role="dialog" ＋ Esc）
├── components/conversation/
│   └── ClosureLeaveFailedBanner.vue   # 🆕 C1：已寫入但離開失敗（DESIGN_TOKENS §8.5）
├── composables/useConversationView.ts # ✏️ closeConversation() 只開面板；M3 銜接註解改寫
├── composables/useCopilotPanel.ts     # ✏️ 結案時 ⑥ 置頂、其餘收合；來回還原（§7.4）
├── pages/c/[conversationId].vue       # ✏️ 面板組裝、常駐橫幅、寫入後 LEAVE
└── components/conversation/Sidebar.vue # ✏️ 「有未完成的結案」標記（FR-041）

scripts/
├── setup-closure-board.ts             # 🆕 建立／驗證 Board（FR-050～FR-052）
└── spike/
    ├── 29-board-write-path.ts         # ✅ 已跑：research #5／#6／#7／#8／#9
    │                                  #    ⚠️ 唯一有寫入副作用的 spike，見下方
    ├── 31-closure-agent-shape.ts      # ✅ 已跑：research #2（唯讀）
    └── 30-closure-latency.ts          # 🆕 三段時間預算量測（容量規劃用，非驗收門檻）

test/
├── contract-guards.test.ts            # ✏️ 三條新守衛（見下）
├── closure-idempotency.test.ts        # 🆕 SC-002：重試 10 次 1 筆；兩份草稿 2 筆並存
├── closure-write-failures.test.ts     # 🆕 SC-003：四種失敗形態各 10 次
├── closure-scope-selection.test.ts    # 🆕 SC-006a：四個代表情境
├── closure-sentiment-range.test.ts    # 🆕 SC-006b：區間內最低點、留空與 0 可區分
├── closure-commit-guard.test.ts       # 🆕 SC-001：只有寫入按鈕呼叫 commit
└── closure-leave-no-write.test.ts     # 🆕 SC-006：LEAVE 20 次、寫入 0 次

i18n/locales/zh-TW.json                # ✏️ 結案面板全部文案（憲法 8.5）
nuxt.config.ts                         # ✏️ IMBRACE_CLOSURE_BOARD_ID／_AGENT_ID 的 runtimeConfig 橋接
```

**Structure Decision**：沿用既有的 Nuxt 4 單一 repo 結構
（`app/` 前端、`server/` Nitro BFF、`shared/` 兩端共用型別、`config/` 設定、
`test/` vitest、`scripts/spike/` 真實環境實測）。
新增兩個目錄層級：`server/api/conversations/[id]/closure/`（Nitro 檔案路由慣例）與
`server/services/closure/`（三個模組合計約 500 行，放進既有的扁平 `services/` 會讓
Board 相關邏輯與分析管線混在同一層）。

⚠️ **`server/services/closure/` 刻意**不**是分析管線的成員**。它不受 `@analysis-pipeline`
標記管轄、不進 `test/contract-guards.test.ts` 的狀態擁有權表、不參與背景節流 ——
結案摘要只在客服明確按下時產生一次，把它掛進管線會讓它跟著背景重算跑，
而那正是 §14.1.1 拒絕讓第 6 區塊常駐的同一個理由（每個對話多跑一次 AI 呼叫）。

### `test/contract-guards.test.ts` 新增的四條守衛

| 守衛 | 掃描什麼 | 防的事故 |
|---|---|---|
| G1 | `commit.post.ts` 不得出現訊息取數（`fetchLatest`／`fetchSince`／`/api/messages`） | FR-020 的快照被實作成「送出時取最新」——取最新與取快照的型別完全相同 |
| G2 | `server/services/closure/**` 不得出現 `lowestScore` | FR-022a 的區間最低點被算成 sparkline 的近期最低點——兩者都是 `number` |
| G3 | `app/stores/closure.ts` 不得出現 `localStorage` | FR-040 的「重新整理等同取消」被憲法 8.4 的直覺推翻 |
| G4 | `server/services/closure/**` 不得出現 `filter:`／`sort:` | 平台對這兩個參數是**靜默忽略**：回的是合法的 200 ＋ 一批合法但沒過濾／沒排序的紀錄 |

## 執行順序：前置作業已完成

```
✅ ① spike 29（Board 寫入路徑實測）  ──┐
✅ ② 後台新增第五個 agent ＋ 快照     ──┼─▶ ③ setup script ＋ 建 Board ──▶ ④ US1 ▶ US2 ▶ US3
✅ ③ spike 31（agent 結構，n=8）      ──┘                                        │
                                                                                ▼
                                                                          ⑤ SC-005 人工驗收
```

- **①②③ 已於 2026-09-03 完成。** 三項被推翻的假設已反映進 research／兩份契約／本檔，
  因此 Board 欄位表在**正式建立之前**就已定案 —— 這正是先跑 spike 的目的。
- **④ 不被第五個 agent 阻塞**：`MockAIProvider` 可完整支撐面板、編輯、冪等與四種失敗形態的驗收。
- **⑤ SC-005 MUST 是獨立任務**：FR-003 逐字要求「重新驗證而非再次結案」，
  而 003 那次正是因為沒有獨立落點才被結案掉的。
- ⚠️ **`spike:board-write` 保留在 repo 內供日後回歸**，但它有寫入副作用：
  不帶 `--yes` 只印計畫，且清除改為**依名稱前綴掃描**（不依賴任何一步成功 ——
  首跑正是在取 id 那步失敗而在正式環境留下一個 board）。

## 本規格的文件改判義務（落地時一併處理）

依 CLAUDE.md「正典文件修改後必須 grep 舊說法」，本規格產生兩筆新的改判義務
（spec.md 原有的七筆已於 2026-09-03 全部完成）：

| # | 落點 | 現況 | 要改成 | 驗法 |
|---|---|---|---|---|
| 1 | `CONSTITUTION.md` 4.6、`ARCHITECTURE.md` §5／§11.5／§11.7／§19.3 | `config/categories.yaml`（尚未建立） | ✅ **已完成**：`config/categories.ts`，憲法發布為 **v4.0.1**（PATCH 級指標訂正，非修憲），附錄 C 已留紀錄、`.specify/memory/` 已同步 | `grep -rn "categories.yaml" docs/` 零結果 ✅ |
| 2 | `ARCHITECTURE.md` §13.3 欄位表、§11.5 `ClosureSummary` | 無 `period_origin`／`period_sentiment_note`；`sentiment*`／`confidence` 為 `number` | 補兩欄；四個數值欄改 `number \| null` | `grep -n "period_origin" docs/ARCHITECTURE.md shared/types/copilot.ts scripts/setup-closure-board.ts` 三處命中 |

| 3 | `docs/IMBRACE_QUESTIONS.md` D 段 | 「四項限制，我們會先自行實測」 | ✅ **已完成**：D-1／D-4 自行解決並撤回、新增 D-5（`filter`／`sort` 被靜默忽略）🟠、待答清單同步 | — |
| 4 | `docs/DESIGN_FEEDBACK.md` | 無結案流程章節 | ✅ **已完成**：D-1（缺取消鍵）／D-2（載入文案不適用）／D-3（缺寫入失敗狀態）／D-4（`writing` 鎖住取消） | — |

⚠️ 第 2 筆的 `sentiment*: number → number \| null` 特別容易漏：
型別不改的話，實作者會被逼著填 0，而 FR-022b 逐字禁止那件事——
且填了 0 之後**不會有任何錯誤**，只會讓報表把留空當成最低分。
