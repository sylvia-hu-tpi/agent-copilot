# Implementation Plan: 分析管線的觸發與失敗政策

**Branch**: `feat/m2-copilot-panel`（feature 目錄 `003-analysis-trigger-policy`） | **Date**: 2026-08-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-analysis-trigger-policy/spec.md`

## Summary

修正 2026-08-27 於真實環境（iMBrace 平台中斷期間）發現的無限重試缺陷：Copilot 面板每 20 秒重跑一次
完整分析、每輪內部各自重試 2 次、客服按下 LEAVE 後仍不停止，實測換算約 3,780 次 AI 呼叫／小時／對話。

**這不是新功能，是三處判斷錯誤的修正**，而且三處都在既有機制原本就該負責的那一層：

1. **觸發時機**（FR-001～FR-004）——`createWatchRegistry.watch()` 目前對「每 20 秒的 presence 心跳」
   與「真的有變化」走同一條路：一律解除舊訂閱再 `attach()`，而 `attach()` 帶有「送快照 ＋ 補跑分析」
   的副作用。修法是讓註冊表記住上一次的 `{priority, joined}`，相同即 no-op（research.md 決策 1）。
2. **失敗政策**（FR-005～FR-011）——分析失敗時 `sentimentBlock.timeline` 與
   `summaryBlock.summary.basedOnMessageId` 都不推進，同一批訊息因此永遠被判定為「尚未涵蓋」。
   新增與三個 Block **平行**的失敗批次記憶（放頂層，避免經 SSE 外流而默默改契約，決策 2），
   並補上 FR-009 的同區塊併發去重（決策 5）。
3. **JOIN 界線**（FR-012～FR-015）——`runIncremental()` 的門檻寫的是「分析狀態存不存在」，
   而分析狀態有 2 小時 sliding TTL、LEAVE 不會清掉它。改為重用 `PollingMessageSource.aggregateState()`
   早就在算的 `joined`（新增 `MessageSource.isJoined()`，決策 3）——它天生是對話層級的，
   FR-014「同事仍 JOIN 時我的 LEAVE 不停止分析」因此不需要額外邏輯。

面板側（FR-016～FR-019）幾乎全是前端變更，零契約改動：**未 JOIN 時整欄隱藏面板**（不是保留內容
加凍結標示——原方案在「我 LEAVE、同事仍 JOIN」時必然說謊，2026-08-28 推翻，見決策 6），
可見性直接由既有的 `viewerJoined` 推出；收合狀態以「每位客服、每個對話」為粒度存 `localStorage`；
「全部重試」對每個 error 區塊各發一次既有的單區塊重試端點（決策 7）。
**伺服器端的面板變更只有 FR-016a 一項，但它有兩條路徑**：`forward()` 對未 JOIN 的連線過濾掉
三個分析事件（其餘事件一律照送，中欄不受影響），且 `sendAnalysisSnapshotAndResume()` 送出的
**分析快照同樣只給已 JOIN 的 watch** —— 快照走的是 `send()` 而非 `forward()`，只擋一條等於沒擋
（FR-003、FR-016a）。判斷資料重用決策 1 已經要新增的 `WatchRegistration.joined`。

離開與結案兩個出口（FR-020～FR-023）：本規格只交付兩個出口的**存在與文案**，加上「結案暫時
等同離開對話」的階段性行為；**整個結案流程屬 M3**（依賴尚未建立的 `config/categories.yaml`、
資料庫寫入路徑，以及一項尚未進行的修憲）。⚠️ 結案摘要 MUST 經人審後才寫入（憲法 5.1），
MUST NOT 做成「按下就自動寫」或「閒置逾時自動寫」。M3 的完整定案見 spec.md
「Session 2026-08-28 補充」（**唯一正典**，其餘文件一律指路至此、不重述）。

⚠️ **本規格的釐清過程發現一項待修憲事項**：憲法 5.3 的「以 `conversation_id` 為唯一鍵覆蓋」
與「同一對話可被不同人在不同時間結案多次」牴觸，需改為 uuid 主鍵 ＋ 以草稿 id 為冪等鍵。
**MAJOR 變更，MUST 在 M3 開工前完成，且 MUST NOT 併入本規格**（003 完全不寫入 Data Board；
憲法 B.4 建議 MAJOR 變更在里程碑交界進行，M2→M3 交界正合適）。詳見 spec.md「待修憲事項」與 tasks.md T053。

⚠️ 本規格同時修正一項**實作與既有規格的不一致**：`docs/ARCHITECTURE.md` §15 與憲法 3.2 承諾的降級
行為是「顯示錯誤狀態 ＋ 提供手動重試」，實際卻是背後自動無限重試、客服看到的是永遠在「重試中」跳動。
修完之後實作才真正符合憲法 3.2。

## Technical Context

**Language/Version**: TypeScript，Node ≥ 24（Nuxt 4，`ssr: false` + 完整 Nitro BFF）

**Primary Dependencies**: 完全沿用既有——不新增任何套件。本規格未引入新的外部呼叫路徑
（AI／知識庫／iMBrace 的呼叫點一個都沒動），只改變**何時**呼叫它們。

**Storage**: 沿用既有 `CopilotAnalysisState`（2 小時 sliding TTL），新增一個**頂層**欄位
`failedBatches`；⚠️ 刻意不放進三個 Block —— SSE 事件送的正是整個 Block，放進去會讓失敗批次記憶
自動流到瀏覽器，違反 spec.md Assumptions「不新增推播事件欄位」，且是型別檢查抓不到的違反
（research.md 決策 2、data-model.md §2）。不新增任何持久化形狀。

**Testing**: Vitest 為主，且**本規格的可測性明顯優於 002**——三個根因都落在已經抽成純函式、
可被 vitest 直接 import 的模組（`server/utils/stream-control.ts`、`server/services/copilot-analysis.ts`、
`server/sources/polling-message-source.ts`），不需要碰 Nitro auto-import。
- 單元：心跳去重（相同 `{priority, joined}` 不 attach／任一改變則 attach）、失敗批次記憶的存取與三個
  清除點、同區塊併發去重與 rerun、`isJoined()` 聚合、`forward()` 的分析事件過濾、**分析快照對未 JOIN
  連線整段跳過**、`control.updated` 觸發的對話詳情重讀、收合偏好的讀寫
- 整合：對假 gateway 的「故障注入 → 靜置 → 統計嘗試次數」（SC-001 的自動化版本）
- `npm run smoke:realtime` 需擴充「LEAVE 後不再有分析事件」（SC-002）
- ⚠️ 既有的 `test/stream-reconnect-background.test.ts`、`test/presence-away-joined.test.ts`
  直接測受影響的兩個純函式，是最可能撞到的回歸點（research.md 末節）

**Target Platform**: 同既有——Node server（單副本記憶體 `StateStore`）；瀏覽器端 console 頁面

**Project Type**: 單一 Nuxt 應用內建 Nitro BFF，沿用 `app/`／`server/`／`shared/` 三層結構

**Performance Goals**: 本規格的目標是**降低**呼叫量而非延遲：AI 完全不可用且對話無新發言時，
10 分鐘內分析嘗試不超過 1 輪（SC-001，對照現況約 30 輪／逾 600 次呼叫）；LEAVE 後 5 秒內停止（SC-002）。
既有的延遲門檻（001 的重連快照 2 秒、002 SC-001 的 3 秒／10 秒、smoke 的 4 秒）**MUST 不退步**（SC-005）。

**Constraints**:
- **不改對外契約**——不新增 SSE 事件欄位、不改重試端點的請求／回應形狀（spec.md Assumptions）
- **不加第二層自動退避重試**（FR-010，Clarifications 已否決 60 秒→5 分鐘方案）；連帶不新增任何
  「X 秒後自動重試」倒數文案
- 001 FR-014 的單輪重試預算（最多 2 次、退避 1s→4s、總預算 40 秒）**原封不動**
- **執行中的分析不中斷**——所有新門檻只擋「排入新的分析」，不中止已在飛的呼叫
- **不做樂觀 disable**——面板狀態一律由伺服器推播驅動（對價是 FR-009 的併發去重）

**Scale/Scope**: 影響所有已 JOIN 的對話與所有 SSE 連線的 `watch` 路徑。程式碼改動面窄
（6 個 server 檔、5 個 app 檔，另加 i18n）但位置關鍵——`watch()` 與 `runIncremental()` 是整條 Copilot 管線的
兩個總入口，因此回歸測試的份量大於功能實作本身。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 條 | 適用性 | 檢核結果 |
|---|---|---|
| **一、安全邊界** | 不新增憑證路徑、不新增日誌輸出點 | ✅ 通過。`failedBatches` 只存 `messageId`／時間／次數，不含訊息內容（1.5）；既有 `logFailure()` 的記錄策略不變 |
| **二、外部依賴的抽象邊界** | `MessageSource` 介面新增 `isJoined()` | ✅ 通過。`MessageSource` 是憲法 2.1 表列的我方 provider 介面，新增的是與既有 `getPriority()` 完全對稱的 getter（同一份 `aggregateState()` 的另一個欄位、同樣的「無訂閱者回安全預設」約定）。2.2 檢核：改動只落在 `polling-message-source.ts` 與測試替身，未擴散到 `SessionManager` 或 `server/api/**` 的既有職責。2.3 不適用（`MessageSource` 非 `StateStore`／`EventBus`，既有簽章即為同步）。2.4 未新增任何包裝層 |
| **三、Copilot 不得拖垮主線** | **本規格是為了讓實作真正符合這一條而存在** | ✅ 通過。3.2 承諾「AI 分析失敗 → 該區塊顯示錯誤與重試」，現況卻是背後無限重試、UI 永遠在「重試中」跳動——修正後才名實相符。3.3 封閉集合**未擴大**：未 JOIN 時隱藏面板不是「阻斷」，而是功能本身需要前提條件（與「未 JOIN 時 Composer 唯讀」、002 FR-025 知識庫快查的 JOIN 門檻同一性質），中欄的訊息流與操作完全不受影響（US2 AC#3）；沒有任何新的 modal 或全頁錯誤 |
| **四、AI 輸出必須可驗證** | 不改動任何模型呼叫、prompt、schema 或後驗邏輯 | 不適用。⚠️ 4.4 的 `confidence` 留空、4.3 的白名單後驗皆維持現狀，本規格一行未動 |
| **五、AI 產物寫入正式紀錄** | 不適用 | 不寫入 Data Board（結案摘要屬 M3） |
| **六、資源使用** | **6.2 是本規格的直接對象，方向是收緊** | ✅ 通過。6.2 要求背景對話 MUST 執行情緒與建議卡——本規格的新門檻是 `isJoined()`，背景對話仍是 JOIN 中，因此不受影響；被擋掉的是「已 LEAVE」與「同一批已失敗過」，兩者都不在 6.2 的保護範圍內。v3.0.0 明訂的兩道節流（並行上限、較長 debounce）**原樣保留**，本規格是在其上再加一道失敗門檻，不是取代。6.1（訂閱數歸零即停止）不受影響。6.2 的「MUST NOT 略過檢索」不受影響——被擋下的是整次建議卡生成，不是「生成但不檢索」 |
| **七、協同與資料一致性** | 觸及 LEAVE 後的行為，但不改 JOIN／LEAVE 本身 | ✅ 通過。`leave.post.ts` 的平台呼叫、去重（7.3）、presence 清理一行未動；本規格只改「LEAVE 之後分析要不要繼續」的判斷。7.1（JOIN 非排他鎖）不受影響——`isJoined()` 是唯讀聚合，不新增任何鎖語意 |
| **八、介面與無障礙** | 面板可見性／收合按鈕／「全部重試」／兩個離開出口 | ✅ 通過。8.1：面板的存在與否本身不是「狀態以顏色表達」的情形；「離開對話」與「結案」的差別 MUST 以文案而非僅靠視覺層級表達（SC-007）；「全部重試」的不可按狀態 MUST 同時以 `disabled`／`aria-disabled` 表達，MUST NOT 只靠降低對比度；8.2：收合按鈕與「全部重試」須可鍵盤操作，比照既有各區塊重試鈕；8.4：**面板隱藏 MUST NOT 影響 Composer 草稿**——草稿在中欄，與面板無關，但需在測試中明確覆蓋（LEAVE→面板消失→草稿仍在）；8.5：全部新文案入 i18n |
| **九、渲染與部署** | 不涉及 `nuxt.config.ts`、部署形態或狀態儲存形態變更 | 不適用 |

**Complexity Tracking 表留空**——本規格沒有需要偏離憲法或既有架構模式而另外辯護的項目。
三處修正都是「把判斷改到正確的那一層」，新增的兩個機制（失敗批次記憶、同區塊併發去重）皆附著於
既有的 `CopilotAnalysisState` 與既有的分析入口，不構成 2.2 意義下的平行機制。

**Phase 1 設計後複查**：`data-model.md`／`contracts/` 的設計決策（`failedBatches` 放頂層而非 Block 內、
`isJoined()` 對稱於 `getPriority()`、面板可見性直接由既有 `viewerJoined` 推出而不新增狀態、
`forward()` 的過濾重用同一份 `WatchRegistration.joined`、「全部重試」純前端）
皆未新增外部依賴、未新增刻意阻斷情境、未繞過 Zod 驗證或 PII 記錄原則、未擴大 3.3 的封閉集合。
上表結論不變。

⚠️ **一項需在 implement 後回頭核對的文件同步**（CLAUDE.md 第一級警告）：`docs/ARCHITECTURE.md` §11.1
的觸發策略表與 §15 的降級行為敘述，寫的是修正後才成立的行為；修正落地後應確認其敘述與實作一致，
並在 §11.1 補上「presence 心跳不觸發分析」與「失敗批次不自動重跑」兩條。詳見 quickstart.md 末節。

## Project Structure

### Documentation (this feature)

```text
specs/003-analysis-trigger-policy/
├── spec.md              # 已完成（/speckit-specify）
├── plan.md              # 本檔（/speckit-plan）
├── research.md          # Phase 0 —— 八項決策與被否決的替代方案
├── data-model.md        # Phase 1 —— failedBatches、監看登記狀態、併發去重狀態
├── quickstart.md        # Phase 1 —— 四個 US 的驗證腳本與故障注入方式
├── contracts/
│   └── analysis-trigger-contract.md   # 觸發／失敗／JOIN 界線的不變式（含「契約不變」的明文宣告）
├── checklists/          # 已完成（/speckit-specify）
└── tasks.md             # Phase 2 輸出（/speckit-tasks，本命令不產生）
```

### Source Code (repository root)

```text
server/
├── utils/
│   └── stream-control.ts          # ⚠️ 決策 1 主戰場：createWatchRegistry 記住上次的
│                                  #    {priority, joined}，相同即 no-op；restoreJoined() 也要寫入
│                                  # ⚠️ 查詢 joined MUST 是 registry 回傳物件上的方法（比照既有
│                                  #    has()）—— watched 是 closure、每條連線一份；寫成模組層
│                                  #    export 只能靠全域 Map，等於所有連線共用一份而互相污染
│                                  # ⚠️ MUST 先寫入註冊表再執行 attach 的副作用，否則 attach
│                                  #    期間的過濾會讀到「尚未登記」而誤判為未 JOIN
├── api/
│   ├── stream.get.ts              # attach() 內的**兩條**補跑路徑都改受 isJoined() 門檻：
│   │                              #    sendAnalysisSnapshotAndResume() 與 catchUpSummaryIfStale()
│   │                              # ⚠️ 分析快照本身也只送給 joined 的 watch（FR-003／FR-016a）
│   │                              # ⚠️ forward()：對未 JOIN 的連線過濾三個分析事件（FR-016a）
│   │                              # ⚠️ FR-013 的呼叫點：watchConversation() 之後若 isJoined()
│   │                              #    為 false 即 cancelPendingAnalysis()（leave.post.ts 維持不動）
│   └── conversations/[id]/
│       └── copilot/retry.post.ts  # 不改形狀；經 retryBlock() 連帶清除失敗批次記憶（FR-008）
├── services/
│   └── copilot-analysis.ts        # ⚠️ 決策 2/5/8 主戰場：failedBatches 讀寫與三個清除點、
│                                  #    per-(對話,區塊) 併發去重與 rerun、cancelPendingAnalysis()、
│                                  #    runIncremental() 的 isJoined() 門檻
├── sources/
│   ├── types.ts                   # MessageSource 介面新增 isJoined()
│   └── polling-message-source.ts  # 實作：回傳 aggregateState(entry).joined
└── state/
    └── types.ts                   # CopilotAnalysisState 新增頂層 failedBatches（server-only）

app/
├── composables/
│   ├── useCopilotSession.ts       # 新增 retryAll()
│   ├── useCopilotPanel.ts         # 新增：可見性（= viewerJoined）＋ per-對話收合偏好的讀寫
│   └── useConversationView.ts     # 兩個離開出口（離開對話／結案）的 handler；
│                                  # ⚠️ 收到 control.updated 時 MUST 重讀對話詳情 —— 否則同一位
│                                  #    客服的另一個分頁會永遠停在 joined:true，分析不會停
├── components/copilot/
│   └── PanelHeader.vue            # 新元件：COPILOT 標題列 ＋ 收合按鈕 ＋「全部重試」
│                                  # （只在有 error 時可按，與收合鈕同列，比照設計稿）
├── pages/c/[conversationId].vue   # ⚠️ v-if="view.viewerJoined.value" 整欄不渲染（FR-016）；
│                                  #    收合態改渲染窄直條（03-workspace_toggleCopilot.png）

i18n/locales/zh-TW.json            # 收合／展開、「全部重試」、兩個離開出口的文案（憲法 8.5）

test/
├── stream-control-heartbeat.test.ts    # 新增：心跳去重（FR-001、FR-002）
├── analysis-failure-memory.test.ts     # 新增：失敗批次記憶、三個清除點、rerun 仍過記憶檢查
├── analysis-join-boundary.test.ts      # 新增：isJoined() 門檻與 FR-014 對話層級
├── stream-analysis-visibility.test.ts  # 新增：未 JOIN 連線過濾三個分析事件、其餘事件照送（FR-016a）
├── contract-guards.test.ts             # 新增：shared/ 不得出現 failedBatches（契約 1.1）
├── analysis-trigger-integration.test.ts # 新增：故障注入 → 靜置 → 統計嘗試次數（SC-001）
├── stream-reconnect-background.test.ts # ⚠️ 既有，決策 1 最可能撞到
├── presence-away-joined.test.ts        # ⚠️ 既有，同上
└── nuxt/                               # ⚠️ 載入 app/ 的測試 MUST 放這裡，見下方說明
    ├── copilot-panel-collapse.test.ts  # 新增：可見性＝viewerJoined、per-對話收合偏好（FR-016/017a）
    └── copilot-retry-all.test.ts       # 新增：「全部重試」只打 error 區塊（FR-018/019）
```

⚠️ **兩支前端測試放在 `test/nuxt/` 而非 `test/`（2026-08-28 實作時訂正）**：它們直接載入
`app/composables/`，而管 `test/` 的 `tsconfig.scripts.json` 是 Node 環境、沒有 DOM 也沒有
auto-import 宣告，放在 `test/` 底下 `npm run typecheck` 必紅。`test/nuxt/` 是 Nuxt 預留的目錄，
已列在 `.nuxt/tsconfig.app.json` 的 include 裡，由 `nuxt typecheck` 以**真正的** auto-import 檢查
（既有慣例：`test/nuxt/stream-store.test.ts`；理由寫在 `tsconfig.scripts.json` 檔尾）。

**Structure Decision**：沿用既有三層結構（`app/`／`server/`／`shared/`），不新增任何目錄或分層。
新增的檔案是一個 Vue 元件（`PanelHeader.vue`）、一個 composable（`useCopilotPanel.ts`）
與八份測試——這反映本規格的性質：改動集中在既有模組的判斷式，
而非新增模組。`shared/types/` 刻意**不動**（失敗批次記憶是 server-only，見 Technical Context 的 Storage）。

## Complexity Tracking

> 本規格無憲法違反項，留空。
