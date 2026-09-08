# AgentCopilot 開發指引

> iMBrace 平台 Conversations 模組的即時客服輔助擴充
>
> 版本：v1.0 ｜ 制定日期：2026-08-24 ｜ 狀態：M2 完成（`m2-done`，2026-09-03），M3 進行中（`specs/006` 已交付，尚未合回 `main`）
>
> 本文件只保留**目前有效**的架構決策與規格。被推翻的推論收在**附錄 B**，
> 只在正文用不到的量測數字收在**附錄 C**，正文不重複。
>
> **未完成／未通過／已知落差的索引在 §19.3**，各項的正典敘述留在原章節。
> ⚠️ **章節編號是穩定介面**（程式碼註解與 `CONSTITUTION.md` 直接引用），移除項目時留缺不遞補。

---

## 目錄

1. [專案概述](#1-專案概述)
2. [核心決策摘要](#2-核心決策摘要)
3. [技術選型](#3-技術選型)
4. [系統架構與資料流](#4-系統架構與資料流)
5. [目錄結構](#5-目錄結構)
6. [Nuxt 設定](#6-nuxt-設定)
7. [認證與 Session](#7-認證與-session)
8. [抽象層：Provider 介面](#8-抽象層provider-介面)
9. [即時機制與輪詢策略](#9-即時機制與輪詢策略)
10. [多客服協同與撞單防護](#10-多客服協同與撞單防護)
11. [AI 分析管線與資料契約](#11-ai-分析管線與資料契約)
12. [知識庫](#12-知識庫)
13. [Data Board 持久化與結案摘要](#13-data-board-持久化與結案摘要)
14. [UI 與設計系統](#14-ui-與設計系統)
15. [錯誤處理與降級](#15-錯誤處理與降級)
16. [部署與安全](#16-部署與安全)
17. [監控指標](#17-監控指標)
18. [開發階段切分與驗收](#18-開發階段切分與驗收)
19. [已知風險與待確認事項](#19-已知風險與待確認事項)
20. [工程慣例](#20-工程慣例)

---

## 1. 專案概述

### 1.1 要解決的問題

iMBrace 平台的 Conversations 模組允許客服瀏覽所有進行中的對話，並按下 **JOIN** 按鈕介入 AI workflow，改由真人接手對話。

但真人接手的那一刻，是資訊斷層最嚴重的時刻：客服必須在數秒內讀完可能長達數十輪的對話、判斷客戶情緒、找出適用的 SOP、組織出得體的回覆。這段空窗直接決定了客戶體驗。

**AgentCopilot 就是要消除這段空窗。**

### 1.2 核心功能

| 功能 | 說明 |
|---|---|
| 對話摘要 | JOIN 當下自動擷取完整對話紀錄並產出結構化摘要（意圖、已知事實、已嘗試處理、待解問題） |
| 客戶情緒提示 | 逐輪情緒評分與趨勢曲線，異常時主動示警 |
| AI 語意即時建議 | 依對話上下文產生可直接送出的回覆建議，引用具體 SOP 條目與信心度 |
| 知識庫自然語言快查 | 客服以自然語言詢問，即時檢索 SOP 與知識庫 |
| 一鍵帶入 | 建議回覆一鍵填入輸入框，送出前做撞單檢查 |
| 結案摘要 | 結案時產生摘要，**經客服編輯確認**後寫入 Data Board。⚠️ 不是「自動產生後寫入」——人審是規則本身（憲法 5.1）。交接摘要已於 `specs/006-closure-handoff-summary` 確認不實作（§13.4 ②） |

### 1.3 產品形態

**獨立 Web Console。** 客服在 AgentCopilot 中完成完整工作流程：瀏覽對話列表、JOIN、閱讀訊息、接受建議、回覆、LEAVE。iMBrace 官方介面仍可並行使用，兩邊狀態透過 webhook 與輪詢保持同步。

> **為何不做 Chrome Extension**：擴充功能需依賴 iMBrace 官方頁面的 DOM 結構，該結構隨時可能改版而導致功能全毀。獨立 Console 只依賴公開 API，穩定性高出一個量級。

---

## 2. 核心決策摘要

| 決策項 | 結論 | 關鍵理由 |
|---|---|---|
| 框架 | **Nuxt 4** | 需要 BFF 層保護憑證與集中 prompt；Nitro 讓前後端同一份專案，免維護兩個 repo |
| 渲染模式 | **`ssr: false` + `nuxt build`（node-server preset）** | 登入後才用的內部工具，零 SEO、資料全動態，SSR 無收益卻帶來 hydration 與 token 同步的麻煩 |
| 認證 | **OTP 取得 access token，存於 BFF session** | 憑證不進瀏覽器；JOIN／回覆能正確歸屬到個別客服，保留稽核軌跡 |
| 即時機制 | **輪詢 + SSE；webhook 規格到位後替換** | iMBrace SDK 無公開推播機制。以 provider 抽象隔離，換來源時上層不動 |
| 輪詢頻率 | **前景 3s／背景 30s**（§9.2） | `since`／`after`／`since_id` 全部被忽略，每次全量取回；回應無 rate limit 標頭可自我調節。取保守值，待書面規格再定案 |
| Presence | **四來源合併**：自家 SSE + `u_` 前綴反推 + 對話 `mode` + webhook（M4）（§10.2） | `users[]` 不可用（實測為團隊名冊）。`mode ∈ {manual, hybrid}` 代表有人能送出訊息，JOIN 時立刻跳動、成本為零，補上原本最痛的盲區 |
| AI 來源 | **iMBrace AI Agent（第一階段）**，介面留待替換 | `ai.complete()`／`ai.embed()`／`messageSuggestion` 皆 404，但 `aiAgent.streamChat` 有 11/27 個 agent 可用，JSON 結構化輸出 4/4 次可解析 |
| 知識庫 | **透過掛知識庫的 AI Agent**，`KnowledgeProvider` 抽象不變 | 無獨立檢索端點，但 agent 的 SSE `tool-output-available` 事件吐出檔名與 chunk 原文。仍缺相關度分數與檢索品質調校手段 |
| 持久層 | **iMBrace Data Boards（業務資料）+ 記憶體／Redis（熱狀態）** | Boards 是 CRM 資料庫，不適合高頻寫入的 session 狀態 |
| 分散式狀態 | **介面 day-1 設計為 async，M4 換 Redis 實作** | SSE 連線表、presence、輪詢鎖在多副本下必須共享 |
| 多對話 | **分頁籤切換，背景重算情緒與建議卡、不重算摘要** | 客服未 LEAVE 即代表客戶可能仍在發言，背景不重算會讓切回時從頭等待；成本改由並行上限與較長 debounce 控制（憲法 6.2，v3.0.0 修訂） |
| 部署 | **單容器 image；SIT 走單機 compose ＋ nginx TLS 終端，K8s 留 M4**（§16.1、§18 M3.5） | 單副本、記憶體狀態下，K8s 的前置（namespace、ingress、Jenkins deploy job）換不到任何東西；image 與 env 鍵清單兩種形態共用，之後上 K8s 沒有丟棄式工作。HTTPS 是登入的硬前提（cookie `Secure`），反向代理必須對 SSE 關緩衝 |

---

## 3. 技術選型

### 3.1 核心

| 項目 | 選擇 | 備註 |
|---|---|---|
| 框架 | Nuxt 4（`ssr: false`） | |
| 語言 | TypeScript（strict） | |
| 執行環境 | **Node.js 24 LTS**（Krypton） | 見 §3.3 |
| 伺服器 | Nitro（`node-server` preset） | |
| iMBrace | `@imbrace/sdk` | **僅在 server 端使用** |
| 狀態管理 | Pinia | `auth` / `conversations` / `stream` / `closure` |
| 樣式 | Tailwind CSS v4 | |
| 元件庫 | Nuxt UI | v4 起 Pro 已併入主套件，125+ 元件全免費 MIT，商用無需額外授權 |
| 圖示 | `@nuxt/icon` + Lucide | 按需載入；由 `@nuxt/ui` 內建註冊，不另列 modules |
| 深色模式 | `@nuxtjs/color-mode` | 由 `@nuxt/ui` 內建。切換入口是頂列的主題鈕（`app/layouts/console.vue`，畫布規格見 `DESIGN_TOKENS.md` §8.1）。⚠️ `preference: 'light'` 是**刻意覆寫**模組預設的 `'system'`（使用者裁示：首次進入固定淺色）；持久化走模組的 `localStorage`，我方不另外存（守衛 `test/theme-toggle.test.ts`） |
| i18n | `@nuxtjs/i18n`，預設 `zh-TW` | 第一版即導入 |
| 工具函式 | VueUse | `useVirtualList`、`useEventSource`、`useDebounceFn` |
| 驗證 | Zod | API 邊界與 AI 輸出的 schema 驗證 |
| 快取／pub-sub | Redis（M4） | `ioredis` |

### 3.2 明確不採用

| 不採用 | 原因 |
|---|---|
| 圖表庫（ECharts / Chart.js） | 情緒 sparkline 資料量極小，手刻 SVG polyline 即可，深色模式與動畫更好控 |
| SSR / SSG | 見決策摘要 |
| 前端直連 `@imbrace/sdk` | 官方文件明載核心操作須在 server 端執行；憑證不得進入瀏覽器 |
| WebSocket（自建雙向） | 即時需求是單向推播，SSE 更簡單、原生支援自動重連。補齊漏訊靠對帳，見 §9.5 |

### 3.3 Node 版本選擇

**採用 Node.js 24 LTS（Krypton）。**

| 版本 | 狀態 | 支援終止 | 評估 |
|---|---|---|---|
| Node 22 (Jod) | Maintenance | 2027-04 | ❌ 已進入維護期，只收關鍵修補 |
| **Node 24 (Krypton)** | **Active LTS** | **2028-04** | ✅ **採用** |
| Node 26 | Current（2026-10 轉 LTS） | 2029-04 | ⏳ 尚未穩定，不適合生產基準 |

**實際效益**：AsyncLocalStorage 改用 AsyncContextFrame，效能提升（Nitro 大量依賴 ALS，本專案是高頻小請求型態，直接落在熱路徑）；`require(esm)` 穩定，降低與 CJS 套件混用的建置摩擦；`node:sqlite` 穩定，可作為本機開發免跑 Redis 的 `StateStore` 選項。

Node 26 轉 LTS 後不建議立即跟進，Node 24 支援至 2028-04 時間充裕，建議 2027 Q1 再評估。Docker base image 使用 `node:24-alpine`。

---

## 4. 系統架構與資料流

### 4.1 整體架構

```
┌──────────────────────────────────────────────────────────────┐
│                        瀏覽器（SPA）                           │
│   對話列表 │ 訊息流 │ Composer │ Copilot 面板 │ 知識庫快查      │
│                          ▲                                    │
└──────────────────────────┼────────────────────────────────────┘
                 HTTP API  │  SSE（單向推播）
┌──────────────────────────┼────────────────────────────────────┐
│                    Nitro BFF (server/)                        │
│                                                               │
│   ┌────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│   │ Auth /     │  │ SessionMgr   │  │ AI Pipeline        │    │
│   │ Session    │  │ （每對話一個）│  │ 摘要/情緒/建議/結案 │    │
│   └────────────┘  └──────┬───────┘  └─────────┬──────────┘    │
│                          │                     │               │
│   ┌──────────────────────┴─────────────────────┴───────────┐   │
│   │  Provider 抽象層                                        │   │
│   │  ConversationEventSource │ MessageSource │ Knowledge    │   │
│   └──────────────────────┬─────────────────────────────────┘   │
│                          │                                      │
│   ┌──────────────────────┴─────────────────────────────────┐   │
│   │  StateStore / EventBus   (M0–M3 記憶體 → M4 Redis)      │   │
│   └────────────────────────────────────────────────────────┘   │
└──────────────────────────┬────────────────────────────────────┘
                           │ @imbrace/sdk
┌──────────────────────────┼────────────────────────────────────┐
│                      iMBrace 平台                              │
│  conversations │ messages │ aiAgent.streamChat │ boards       │
│  Knowledge Hub（僅能經 agent 間接檢索）                        │
│  webhook（JOIN/LEAVE，規格未定）                               │
│  ⚠️ ai.complete / ai.embed / messageSuggestion 皆 404，不存在   │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 JOIN 事件的完整資料流

⚠️ 下圖是 **M4 webhook 到位後**的目標形狀；M1–M3 的 ① 由本地快路徑（我方客服按下 JOIN）與清單輪詢（§9.3.1）取代。

```
  iMBrace 平台                        AgentCopilot
 ┌──────────────┐
 │ 客服按 JOIN  │
 └──────┬───────┘
        │ ① webhook（server → server）
        ▼
  ┌─────────────────────────────────────────────┐
  │ POST /api/hooks/imbrace/conversation        │
  │   驗簽 → 時間戳檢查 → event id 去重          │
  │   → 解析 operator / conversation / channel  │
  └──────┬──────────────────────────────────────┘
         │ ② 建立 CopilotSession
         ▼
  ┌──────────────────────┐   ③ 拉全量歷史
  │  SessionManager      │─────────────────────▶ messages.list()
  │  key: conversationId │   ④ 冷啟動分析
  │  refcount: 訂閱者數   │─────────────────────▶ AI：摘要 + 情緒 + 建議
  └──────┬───────────────┘   ⑤ 知識庫檢索
         │                 ─────────────────────▶ KnowledgeProvider
         │ ⑥ EventBus.publish(`operator:${id}`)
         ▼
  ┌──────────────────────┐
  │ GET /api/stream (SSE)│ ═══▶ 瀏覽器自動開啟該對話的 Copilot 面板
  └──────────────────────┘
         ▲
         │ ⑦ MessageSource 持續訂閱 → 新訊息 → 增量分析 → 推播
```

### 4.3 JOIN 的雙路徑與去重

JOIN 有兩個來源，**同一個動作可能兩邊都收到**：

| 來源 | 路徑 | 延遲 |
|---|---|---|
| 在 AgentCopilot 按 JOIN | 本地快路徑：`conversations.join()` → 立刻建 session → 立刻廣播 | 即時 |
| 別人在 iMBrace 官方介面按 JOIN | Webhook → EventBus → 廣播 | 秒級 |

**必須去重**：以 `conversationId + operatorId` 為鍵，10 秒時間窗內視為同一事件。

> 未實作去重的後果：面板閃爍兩次、AI 分析重複執行（成本翻倍）、presence 出現重複項目，且極難追查。

---

## 5. 目錄結構

以實際檔案為準（2026-09-08 快照）；標 **（M3.5）**／**（M4）** 的尚未建立，隨對應功能一起產生。⚠️ 此樹只列與架構決策相關的檔案，不是完整清單——要知道現在有什麼，`ls` 比讀這裡準。

```
AgentCopilot/
├── nuxt.config.ts                   # §6：ssr:false、.env 橋接、typeCheck 關閉的理由
├── Dockerfile / .dockerignore       # （M3.5）§16.1；.dockerignore MUST 排除 .env* 與 scripts/spike/out/
├── deploy/                          # （M3.5）§16.1 單機 compose 形態：docker-compose.sit.yml、nginx.conf、
│                                    # agent-copilot.env.example（鍵清單、值全空）、redeploy.sh、verify-image.sh、README.md
├── config/
│   └── categories.ts                # 結案分類受控詞彙（specs/006）
│   （supervisors.yaml —— 主管 email 白名單，隨主管接管功能建立，尚未建立）
├── app/
│   ├── layouts/                     # default（登入／選組織）、console（頂欄 + 三欄工作區）
│   ├── pages/                       # login、organization（§5.1 ①）、index、c/[conversationId]
│   ├── components/
│   │   ├── conversation/            # Sidebar、MessageList（虛擬滾動）、MessageBubble、Composer、
│   │   │                            # PresenceBar、ModeSelect、CollisionDialog（撞單攔截）、ResizeHandle…
│   │   └── copilot/                 # PanelHeader、BlockShell、SummaryCard、SentimentGauge（手刻 SVG）、
│   │                                # SuggestionList/Card（一鍵帶入）、KnowledgeSearch（inline）、
│   │                                # ClosureBlock、ClosureScopePicker、ClosureCustomStart（specs/006）
│   ├── composables/                 # useConversationView、useCopilotSession、useCopilotPanel、
│   │                                # useKnowledgeSearch、useDraft（草稿存 localStorage）、usePaneSize…
│   ├── stores/                      # auth、conversations、stream（SSE 連線 + 重連 + 對帳，§9.5）、closure
│   └── utils/                       # message-merge（§9.5 ③ 的去重）、operator-id…
├── server/
│   ├── api/
│   │   ├── auth/                    # otp、login、organization（保留 refresh_token）、reselect-organization、me、logout
│   │   ├── conversations/
│   │   │   ├── index.get.ts         # list / search
│   │   │   ├── [id].get.ts
│   │   │   └── [id]/
│   │   │       ├── join.post.ts / leave.post.ts / mode.post.ts   # §10.6 同一支平台端點
│   │   │       ├── knowledge-search.post.ts                      # 自然語言快查
│   │   │       ├── copilot/retry.post.ts                         # 單一區塊手動重試
│   │   │       └── closure/                                      # 結案摘要（specs/006）—— ⚠️ 三支
│   │   │           ├── scopes.post.ts   # 涵蓋區間候選（面板開啟時）
│   │   │           ├── draft.post.ts    # 產生草稿（改區間／重新產生都走這支）
│   │   │           └── commit.post.ts   # 寫入 Data Board（⚠️ 唯一會寫正式紀錄的端點）
│   │   ├── messages/                # index.get（since=<messageId> 對帳）、index.post（送出，含撞單檢查）
│   │   ├── connection/beat.post.ts  # 連線心跳（005 FR-005a）
│   │   ├── presence.post.ts         # 上報 viewing / composing
│   │   ├── stream.get.ts            # SSE
│   │   ├── health.get.ts
│   │   └── hooks/imbrace/conversation.post.ts   # （M4）webhook 收口
│   ├── sources/
│   │   ├── types.ts                 # Provider 介面（§8.1）
│   │   ├── conversation-list-poller.ts  # 第一層：清單輪詢（§9.3.1）
│   │   ├── polling-message-source.ts    # 第二層：逐對話輪詢 + 共享訂閱
│   │   ├── message-fetch.ts         # 取數策略（raw-conversation-id，§9.3）
│   │   ├── mappers.ts               # 防腐層：識別碼正規化、發送者判別、附件
│   │   └── webhook-event-source.ts  # （M4）
│   ├── services/
│   │   ├── imbrace.ts               # SDK client factory ＋ 所有 SDK 不一致的防腐層（CLAUDE.md 地雷 3）
│   │   ├── copilot-runtime.ts       # 每組織一份 runtime（清單輪詢、憑證借用）
│   │   ├── copilot-analysis.ts      # 分析管線 barrel（摘要 + 對外入口 + debounce）
│   │   ├── analysis-state.ts / analysis-dedupe.ts / blocks/{sentiment,suggestion}.ts   # §18 M2「分析管線拆檔」
│   │   ├── session-manager.ts / session-registry.ts   # CopilotSession 生命週期 + 以 connectionId 計數
│   │   ├── viewer-joined.ts         # 左欄「我 JOIN 的對話」判定快取（§10.2.1a）
│   │   ├── directory.ts / presence.ts / credentials.ts / conversation-context.ts
│   │   ├── ai/                      # index（裝配、缺憑證退回 Mock）、imbrace-agent-provider、
│   │   │                            # mock-ai-provider、schemas（Zod）、retry-policy（FR-014）
│   │   ├── knowledge/               # index、agent-knowledge-provider、mock-knowledge-provider、resolve-search
│   │   └── closure/                 # board-repository（冪等寫入）、board-schema（§13.3）、period、
│   │                                # sentiment-range、cited-sops、readonly-fields、config
│   ├── state/                       # types（StateStore / EventBus 介面）、memory-store、memory-bus；（M4）redis-*
│   └── utils/                       # session、session-signature、dedupe、citation-audit、redact、validate…
├── shared/types/                    # copilot（AI 契約）、conversation、events（SSE）、knowledge、auth
├── scripts/
│   ├── setup-closure-board.ts       # npm run board:setup / board:verify（§13.3）
│   └── spike/                       # 實測腳本；out/ 為原始產出（gitignored）
└── docs/                            # 文件地圖見 CLAUDE.md
```

### 5.1 登入流程的三個實作約束

實作 `server/api/auth/*` 前必讀，皆為實測後確認的行為，不照著寫症狀是 401 而非明確報錯。

**① 是三段式，不是兩段式 —— 且第三段要有自己的畫面**

```
① client.requestOtp(email)                  → 寄出驗證碼          … login.vue
② client.loginWithOtp(email, otp)           → login_acc_ token
                                              + organizations[]   … login.vue
③ selectOrganization(organizationId)        → acc_ token          … organization.vue
```

第 ② 步一次回傳 token 與組織清單，不需再呼叫 `organizations.list()`。

**決策：第 ③ 步一律顯示選擇畫面，即使 `organizations[]` 只有一筆。** 理由：客服看得到自己正要以哪個組織身分進入系統（之後所有 JOIN、回覆、稽核軌跡都掛在這個身分上，靜默替他選會讓誤入錯組織難以察覺）；未來支援跨組織切換不必補新流程；單筆時畫面成本極低。

`organization.vue` 是獨立路由而非 `login.vue` 的第三步，因為此時 `login_acc_` token 已存在 BFF session，重新整理頁面不該把使用者踢回輸 email。

**② 必須用 `client.*` 便利方法，不可用 `client.auth.*`**

| ❌ 底層方法 | ✅ 便利方法 | 為何 |
|---|---|---|
| `auth.authenticate()` | `client.loginWithOtp()` | 前者只回傳資料、不保存 token，後續呼叫等於未認證，會 401 |
| `auth.exchangeAccessToken()` | `client.selectOrganization()` | 前者要求請求本身帶 `x-organization-id`；後者會先 `setOrganizationId` 再呼叫 |

**③ `selectOrganization()` 會丟棄 `refresh_token`**

便利方法只保留 `token`。若要讓客服在 8 小時 session 內不被迫重跑 OTP，`organization.post.ts` 必須改走手動流程：先 `setOrganizationId`，再自行呼叫 exchange 端點並把 `refresh_token` 一起存進 session。實作範本見 `scripts/spike/00-auth.ts`。

---

## 6. Nuxt 設定

正典是 `nuxt.config.ts` 本身（含每一項設定的理由註解），本節不複製一份會過期的副本。只有四件事**必須先知道**：

1. **`ssr: false` + `nitro.preset = 'node-server'`**，以 `nuxt build`（不是 `nuxt generate`）建置、`node .output/server/index.mjs` 啟動。這不等於靜態網站：`server/api/**` 完全正常運作，得到的是「SPA 前端 + 完整 Node BFF」。
2. **`typescript.typeCheck: false` 不是放鬆**——專案路徑含空白（`03 FE products`），Nuxt 把路徑未加引號傳給 vue-tsc 會裂成三段（TS5083）。型別檢查改由 `npm run build` 先跑 `npm run typecheck` 串接。
3. **秘密只在 server 端 `runtimeConfig`，預設值一律空字串**，實際值由執行環境的 `NUXT_*` 注入；`nuxt.config.ts` 會把 `.env.local` 的 `IMBRACE_*` 橋接成 `NUXT_*`（spike 腳本與 Nuxt 共用同一份）。填進預設值會被烘進 `.output`（憲法 1.1、§16.2）。五個 agent 的 `assistant_id` 與結案 board 的 **id**（不是名稱）也走這裡。
4. **`@nuxt/icon` 與 `@nuxtjs/color-mode` 不列在 `modules`**，`@nuxt/ui@4` 已內建註冊，重複列會警告。`colorMode.preference = 'light'` 是刻意覆寫（§3.1）。

---

## 7. 認證與 Session

### 7.1 登入流程

iMBrace 的 OTP 登入是三段式（✅ 已實測跑通）：

```
① client.requestOtp(email)                 → 寄出驗證碼
② client.loginWithOtp(email, otp)          → login_acc_ token + organizations[]（含 role）
③ client.selectOrganization(organizationId) → acc_ token（+ refresh_token）
```

> **必須用 `client.*` 的便利方法，不可用底層的 `client.auth.*`**——理由見 §5.1②。若需保留 `refresh_token`（`selectOrganization` 會丟棄它），參考 `scripts/spike/00-auth.ts` 的手動流程。

**已實測確認**：
- `organizations[]` 帶 `role`（實測值 `admin`）與 `is_admin`（實測值 `false`）——主管判定可望沿用平台角色，但兩欄位語意不一致，值域待確認（H-5）
- 第 ③ 步回傳 `refresh_token` → token 可續期，客服不會在工作中被迫重跑 OTP
- `organizations.list()` 僅 access token 可呼叫，API Key 會 401 → 印證「以客服個人 token 執行」的設計是對的

**UI 對應**：第 ①② 步在 `login.vue`，第 ③ 步在獨立的 `organization.vue`，一律顯示選擇畫面（理由見 §5.1①）。

**全部在 Nitro 執行**，瀏覽器只拿到一個 session cookie。

```ts
// server/api/auth/organization.post.ts（概念示意）
const { token: accessToken, refresh_token } = await client.auth.exchangeAccessToken(orgId)

// token 存 server 端 session store，不回傳給瀏覽器
await store.setSession(sessionId, {
  operatorId, operatorName, orgId,
  accessToken,                        // ⚠️ 永不離開 server
  expiresAt: Date.now() + 30 * 86400_000,
})

setCookie(event, 'ac_session', signed(sessionId), {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: 8 * 3600,                   // 滑動視窗，比 token TTL 短得多
})
```

### 7.2 Session 政策

| 項目 | 設定 | 理由 |
|---|---|---|
| Cookie | `httpOnly` + `Secure` + `SameSite=Lax` + 簽章 | 防 XSS 竊取、防 CSRF。webhook 是 server-to-server，不受 SameSite 影響 |
| Cookie 內容 | 僅 session id（不可逆） | access token 一律留在 server |
| Session TTL | **8 小時滑動視窗** | 客服常共用工作站，30 天 token 直接對應到瀏覽器是高風險 |
| Token 過期 | 偵測 401 → 清 session → 導回登入 | **URL 保留 `conversationId`，登入後回到原處** |

### 7.2b 客服的顯示名稱 —— **平台沒有人名，只有 email**

> ⚠️ **實測結論（2026-08-31）**：探測過的兩個來源都拿不到客服的人名。這不是對應寫錯，而是資料本身就沒有。

| 來源 | 欄位 | 實測 |
|---|---|---|
| `loginWithOtp()` 的回應 | `display_name`／`name` | **兩個欄位都不存在** → `server/services/imbrace.ts` 退回 `email` |
| `conversations.get()` 的 `users[]`（團隊名冊） | `display_name` | **12/12 全部是 email 格式**（`scripts/spike/out/03-operators-snapshot.json`，兩個對話的樣本，經 `scrubPii()` 全數命中 email 規則） |

**影響三個位置**，全都是客服彼此辨識的關鍵處：頂列的「我是誰」、presence 列的「誰在這個對話裡」（`server/services/directory.ts`）、訊息泡泡上的真人客服姓名。

#### 三條處理原則

1. **MUST NOT 從 email 推導人名。** `agent.lin@company.com` → 「Lin」在同名同姓、共用信箱、非英文名字的情況下都會產生錯的名字 —— 而**認錯同事**正是撞單防護（§10.4）與 presence（§10.2）最不能出錯的地方。這與「查不到名字時用通稱、不可編一個名字」（`directory.ts`）是同一條規則。
2. **頭像縮寫可以用 email，那是縮寫不是名字。** `avatarLabel()` 取前兩碼只是一個視覺錨點，不宣稱那是誰的姓名，因此不受上一條約束。
   ⚠️ 頂列（`app/layouts/console.vue`）的**身分區因此只放頭像**，姓名／email 文字收進下拉選單（「只放頭像」講的是身分這一格，不是整個右上角：頭像左側分隔線外還有主題切換鈕，見 `DESIGN_TOKENS.md` §8.1）。畫布畫的是頭像＋常駐姓名，但我們沒有人名可放，把一串 email 攤在頂列上既佔寬度、又讓「身分」看起來像一個沒設定好的欄位。這是刻意偏離畫布的決定。
3. **這是待對方回覆的問題，不是待實作的功能** —— 見 `IMBRACE_QUESTIONS.md` **H-9**。若對方回覆「設計上就只有 email」，我方改為**明示地**顯示 email（例如加上「以帳號顯示」的說明），而不是繼續讓它看起來像一個名字。

### 7.3 SDK Client Factory

每個請求依 session 中的 token 建立 client：

```ts
// server/services/imbrace.ts
export function clientForSession(session: Session) {
  return new ImbraceClient({
    accessToken: session.accessToken,
    env: useRuntimeConfig().public.imbraceEnv,
  })
}
```

> **不要建立全域單例 client。** 每位客服的操作必須以自己的身分執行，否則 `join()` 與訊息送出的歸屬會全部錯亂，稽核軌跡失去意義。

---
## 8. 抽象層：Provider 介面

這是整份架構最重要的設計。**所有尚未確定規格的外部依賴，都必須藏在一個 provider 介面之後。** 如此一來，iMBrace 的 webhook 與 Knowledge API 開通與否，都不會阻塞開發進度——屆時只需替換實作，上層邏輯一行不動。

### 8.1 事件與訊息來源

```ts
// server/sources/types.ts

export interface JoinEvent {
  eventId: string
  type: 'join' | 'leave'
  conversationId: string
  operator: { id: string; name: string }
  channel: string
  /** 該對話當前的完整 operator 清單（若來源提供） */
  currentOperators?: Array<{ id: string; name: string }>
  occurredAt: string
}

/** JOIN / LEAVE 事件來源 */
export interface ConversationEventSource {
  start(): Promise<void>
  stop(): Promise<void>
  on(evt: 'join' | 'leave', handler: (e: JoinEvent) => void): void
}

export type Unsubscribe = () => void

/** 訊息來源（共享訂閱，以 conversationId 為鍵做 refcount） */
export interface MessageSource {
  subscribe(
    conversationId: string,
    onNew: (messages: Message[]) => void,
    opts?: { priority: 'foreground' | 'background' },
  ): Unsubscribe

  /** 立即拉取一次（手動重新整理、對帳用） */
  fetchSince(conversationId: string, sinceMessageId?: string): Promise<Message[]>
}
```

**實作對照表**

| 介面 | M1 實作 | M4 實作（規格到位後） |
|---|---|---|
| `ConversationEventSource` | **本地快路徑**（我方客服按下 JOIN） | `WebhookEventSource` |
| `MessageSource` | `PollingMessageSource` | `WebhookMessageSource` 或 `WsMessageSource` |
| （新增）對話變動偵測 | `ConversationListPoller` | webhook 取代，但**保留為對帳輪詢**（§9.4） |

> ⚠️ **輪詢路徑下無法得知「官方介面同事 JOIN」的身分。** `users[]` 是團隊名冊而非對話參與者（§10.2），diff 它只會得出「整個團隊同時 JOIN 了每個對話」這種假結果，因此 M1 不假裝有這樣一個事件來源：我方客服 JOIN 靠本地快路徑（知道是誰）；官方介面同事 JOIN 只能靠 `mode ∈ {manual, hybrid}` 知道「有人能送」，指不出名字；同事發言後才能靠 `u_` 前綴反推身分。`mappers.diffOperators()` 因此沒有可用輸入，僅保留給 spike 蒐證。

### 8.2 知識庫

```ts
export interface KnowledgeHit {
  /** 僅供系統內部白名單核對（憲法 4.3）使用，不對客服顯示 */
  id: string
  title: string
  snippet: string
  /** 檢索分數（非模型自評）。iMBrace 路徑無分數來源，一律為 null；
   *  換上 viki 的 answer-attribution 後才會有值。UI 依 null 與否決定顯示與否，不得估算填充 */
  score: number | null
  /** 條目最後更新日期；iMBrace 路徑可能無法可靠取得，為 null 時不觸發過舊提醒（見 §12.4①） */
  updatedAt: string | null
  sourceRef: { type: 'knowledge' | 'docIQ' | 'board' | 'static'; ref: string }
}
```

> ⚠️ **介面上沒有「條目編號」欄位，不要再加回來。** iMBrace 知識庫沒有編號制度（檔案就是一般
> 檔案）；設計稿上的「SOP #12」「SOP #47」是示範文案，不是平台欄位。要顯示編號只能自行杜撰
> （例如取檔案 id 的短版本），對客服沒有資訊價值。**來源僅以 `title` 顯示，`id` 純供白名單核對，
> 不進 UI。** 是否有正式編號制度已列 `IMBRACE_QUESTIONS.md` 0-3g，有的話再評估恢復。

```ts
export interface KnowledgeProvider {
  search(query: string, opts?: { topK?: number; channel?: string }): Promise<KnowledgeHit[]>
}
```

| 順位 | 實作 | 狀態 |
|---|---|---|
| 1 | `AgentKnowledgeProvider` | ✅ **採用** —— 透過掛載 Knowledge Hub 的 AI Agent 查詢。可取得引用來源（檔名＋chunk 原文），但 `score` 恆為 `null` |
| 備援 | `VikiKnowledgeProvider` | 🟡 介面已預留，未實作。**2026-09-07 決策：本期不換入，且與 `IMBRACE_QUESTIONS.md` 0-3f（RAG 品質）的回覆脫鉤**——不論 0-3f 怎麼回覆都不換。重啟條件見 §18 M3 驗收第一條；日後換上即可取得真實 `score`，介面不用改 |
| 備案 | `BoardsSearchProvider` | 🟡 未採用——`boards.search()` 為 Meilisearch 相容關鍵字檢索，有條目 ID，屬關鍵字非語意 |
| 開發期 | `MockKnowledgeProvider` | ✅ 缺 `IMBRACE_API_KEY`／`IMBRACE_ORGANIZATION_ID`／`IMBRACE_KNOWLEDGE_AGENT_ID` 任一時由 `useKnowledgeProvider()` 自動退回並印警告。**僅供本機開發**，正式環境出現該行警告即為設定錯誤 |
| — | ~~`StaticSopProvider`~~（讀 `config/sop.yaml`） | ❌ **已撤銷**（2026-08-28，`specs/002` plan.md）—— `MockKnowledgeProvider` 已完整承擔離線 fallback，多一條讀 yaml 的路徑不增加任何能力。`config/sop.yaml` 因此不會建立 |
| — | ~~`BoardsRagProvider`~~／~~`LocalVectorProvider`~~ | ❌ 已撤銷——`processEmbedding()` 之後無檢索 API；`ai.embed()` 回 404 |

> 無論最終選哪一條，`KnowledgeProvider` 介面本身不變——這正是抽象層的目的：外部能力邊界未定時，開發不必停下來等。

### 8.2b AI 推論（摘要／情緒／建議卡／結案）

摘要、情緒分析、建議卡、結案摘要收斂到單一介面（正典 `shared/types/copilot.ts`），讓 iMBrace AI Agent 與 viki 的切換只需換一個實作：

```ts
export interface AIProvider {
  summarize(input: { history: Message[]; previousSummary?: ConversationSummary }): Promise<ConversationSummary>
  analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]>
  narrateSentiment(input: { points: Array<Pick<SentimentPoint, 'score' | 'label' | 'drivers'>> }): Promise<SentimentNarrative>
  suggest(input: { history: Message[]; knowledgeHits: KnowledgeHit[]; aiReplies: boolean }): Promise<SuggestionCard[]>
  summarizeClosure(input: { history: Message[]; vocabulary: ClosureVocabulary; signal?: AbortSignal }): Promise<…>   // specs/006
}
```

> ### `narrateSentiment()` 的三條硬性規則
>
> 它產出情緒區塊的一段走勢文字摘要（畫布 2a「近 3 輪情緒持續上升…建議先安撫語氣…」）。
> 這是**唯一一個被允許失敗而不影響所屬區塊狀態**的 AI 呼叫：
>
> 1. **輸入是評分結果，不是訊息原文。** 走勢與建議可以從 `score`／`label`／`drivers` 推出來；
>    重送一次全部訊息只是把同一批個資再送一趟，prompt 也長好幾倍（憲法 1.5 的精神）。
> 2. **分數先發、敘述後補。** 折線與示警是有時效的，MUST NOT 為了一段散文多等一次 AI 往返。
>    `finishSentimentSuccess()` 先發 `ready`（`narrative: null`），`narrateSentimentTrend()` 完成後再發一次。
> 3. **失敗一律吞掉，`sentimentBlock` 維持 `ready`。** 分數與示警是這個區塊的主體。
>
> ⚠️ 另有一條資料規則：**新的評分點落地時 `narrative` MUST 歸零**。敘述描述的是「當時那條時間軸」，
> 多了幾點之後「近 3 輪持續上升」可能已經不成立——留著舊敘述是在畫面上放一句可能已經錯了的斷言。

⚠️ `summarizeClosure()` **刻意不收 `knowledgeHits`**：結案 agent 的 system prompt 逐字要求「不要輸出 citedSopIds，由系統填入」，`ClosureDraft.citedSops` 由呼叫端直接以檢索命中填入，檢索與這支呼叫因此完全獨立、可並行。`history` 是**涵蓋區間內**的訊息，不是全對話（§13.4 ④）。

| 順位 | 實作 | 狀態 |
|---|---|---|
| 1 | `ImbraceAgentProvider` | ✅ `server/services/ai/imbrace-agent-provider.ts`——呼叫 `aiAgent.streamChat`，五個 agent 由使用者於 iMBrace 後台手動建立，`assistant_id` 存於 `.env.local`（`IMBRACE_{SUMMARY,SENTIMENT,SUGGESTION,KNOWLEDGE,CLOSURE}_AGENT_ID`）。結構化輸出靠 prompt（非平台原生 `response_format`），Zod 驗證 + 重試 + 降級見 §11.7 與下方「JSON 抽取」。⚠️ `narrateSentiment()` 與 `analyzeSentiment()` **共用同一個情緒 agent**，只是 prompt 不同——另開一個 agent 會多一個「忘了建就整段安靜消失」的相依。迴歸檢查：`npm run spike:verify-provider`（走完 JSON 抽取 → 欄位組裝 → Zod 全路徑） |
| 開發期／降級 | `MockAIProvider` | ✅ `useAIProvider()` 缺 `IMBRACE_API_KEY`／組織 id／agent id 任一項時自動退回並印警告（`server/services/ai/index.ts`） |
| 備援 | `VikiAIProvider` | 🟡 介面已預留，未實作——打 viki public API，`SuggestionCard.confidence` 會開始有真實值 |

> `AIProvider` 與 `KnowledgeProvider` 合起來，是「所有 AI 相關外部依賴」的唯一收斂點。

#### ⚠️ agent 的 system prompt 也不在版本控制裡，而它的措辭會直接改變折線的形狀

五個 agent 的 `personality_role`／`core_task`／`model_id` 都在 **iMBrace 後台**，repo 只存 `assistant_id`。
快照在 `docs/AGENT_PROMPTS.md`，由 `npm run spike:agent-prompts` 抓線上值逐字元比對，不一致就以非零離開並指出差在第幾行（約 1 秒）。
單向流程：**改後台 → `npm run spike:agent-prompts -- --write` → commit（寫清楚為什麼改）**。
⚠️ 那份 md 是**快照不是設定檔**——改它不會改變任何 agent 的行為。

**它解決的是本節最貴的問題**：後台被改動時，症狀只會出現在量測數字上，而量測數字有很多種解釋（附錄 C-3 記著一次誤讀）。
**量測數字是間接證據，快照 diff 是直接證據；先跑這支再決定要不要重量。**

現行情緒 prompt 有三組**不可拿掉**的規則，各自解決一個實際症狀（證據 `npm run spike:sentiment-dispersion`，數據附錄 C-3）：

| 規則 | 沒有它會怎樣 |
|---|---|
| 判斷 MUST 參考同批的前後文，特別留意語氣客套但問題未解決的句子 | 逐則孤立判斷會把「好，那我再等等」判成 85／`calm`，在兩則抱怨之間拉出一個 55 分落差的假尖峰並觸發示警 |
| 絕對分數帶（`calm` 80–100 … `angry` 0–19） | 模型改拿同批其他訊息當相對基準，同一則訊息換一個批次就差 25 分 —— 折線在**每個批次邊界**都會出現假斷層 |
| 兩條 tie-breaker（`concerned`／`frustrated`、`frustrated`／`angry` 拿不定主意時取輕的那級） | 界線上的句子會在重跑之間翻面，客服看到的示警圖示在 ⚠️ 與 🔥 之間跳——`isSentimentAlerting()` 只分有無示警（`frustrated` 與 `angry` 都算），開關本身穩定，翻面影響的是等級（`--warn`＋⚠️ 對 `--danger`＋🔥，001 FR-003 要求可區分）。取捨是讓真正該顯示 🔥 的少一些，換取圖示不在重跑之間跳；實測補上後 24-A 兩輪皆 0/6 翻面 |

⚠️ 分數帶 MUST 與 `SENTIMENT_BANDS`（`shared/types/copilot.ts`）同一組——折線的分帶上色吃的是同一份定義（§14.5）。後台改了而這裡沒改，只會安靜地讓顏色與 agent 的判斷不一致。

> ⚠️ **不要用程式碼去補批次之間的接縫——已經試過並移除了。** 曾為 `analyzeSentiment()` 加上 `priorPoints`（把前一批尾端的評分帶進下一批的 prompt）。
> 它是在「只加了看上下文、還沒加絕對分數帶」的中間狀態加的，補完 prompt 之後同一個量測**差距落在雜訊內**（3.6 對 3.9 分），該參數與其測試已整個移除。
> 「批次之間沒有上下文」這個直覺很強，日後很容易有人再加一次。**要加之前先跑 `spike:sentiment-dispersion` 看 24-B 的偏離現在是多少**——
> 若仍是個位數，那個洞不存在（前情還帶著一條隱性正確性規則：MUST 排除本批自己的訊息，否則手動重試會參考到自己上次的答案而永遠翻不了案）。

#### ⚠️ agent 背後的模型不在版本控制裡

`model_id` 同樣只在後台。`docs/AGENT_PROMPTS.md` 的快照記得「現在是什麼」，**記不得「為什麼換」**——下表是變更理由的唯一去處，**MUST 在每次變更後更新**。現值以 `npm run spike:agent-prompts` 為準，MUST NOT 靠人工記錄（`chatAi.listAiAgents()` 的 `model_id` 欄位才是模型；`model` 欄位是用途分類如 `rag`）。

| agent | 模型（2026-09-08 快照） | 變更紀錄 |
|---|---|---|
| `AgentCopilot_摘要_agent` | `google.gemma-3-27b-it` | 未變更 |
| `AgentCopilot_情緒評分_agent` | `openai.gpt-oss-20b-1:0` | 2026-08-28 由 `gemma-3-27b` 改為此值，純粹為了延遲（附錄 C-1）：兩者合規與標籤正確率同為 8/8，gemma 中位 ≈ 10.5 秒、最慢 12.7 秒，乘上平台漂移 36% 即破 FR-014 的 15 秒。代價是輸出失去決定性（同批重跑 ±10 分） |
| `AgentCopilot_建議回覆_agent` | `google.gemma-3-27b-it` | 2026-08-29 曾暫時改為 `gpt-oss-20b` 做 A／B，**當日已換回**（附錄 C-2）：n=15 下兩者中位數只差 8ms，gemma 變異度小 3.6 倍、第二段引用覆蓋 15/15 對 3/5 |
| `AgentCopilot_知識庫檢索_agent` | `us.amazon.nova-pro-v1:0` | 變更時間不明——2026-08-27 交接筆記記為 `qwen.qwen3-32b-v1:0`，08-28 實讀已是 nova-pro，中間無任何紀錄。這張表就是在那次失去紀錄之後建立的；據 qwen3-32b 量到的數字不得再視為現行效能資料 |
| `AgentCopilot_結案摘要_agent` | `google.gemma-3-27b-it` | 2026-09-04 建立（specs/006） |

> **逾時是被最慢值打死的，不是中位數。** 平台延遲實測會隨時間漂移約 36%（同模型同輸入，30 分鐘內 7.5 秒 ↔ 10.2 秒）。**這條原則適用於本文所有延遲判斷。**

⚠️ **`gemma-3-27b` 並非全面不可用。** 它**不能**用於知識庫檢索（缺原生 function calling，見 §12.4 ②-2），但在**不呼叫工具**的摘要／情緒／建議卡／結案上完全正常，情緒任務上甚至是候選裡輸出最穩定的。

**建議卡的兩段 MUST 共用同一個 agent，不要拆成兩個。** 「第一段要快、第二段要引用準，所以掛不同模型」這個直覺沒有標的：實測沒有更快的模型可放第一段（附錄 C-2）。拆開唯一剩下的槓桿是「第一段用更短的 prompt」，但第一段已經是短的那份（`knowledgeHits: []`），要再縮只能動後台 prompt——不可版控、無法在 CI 重現，且兩份 prompt 各自漂移會讓第二段整批替換第一段時語氣不一致，客服會直接看見。**回頭重議的條件**：實測到在建議卡任務上確實更快的模型。

#### 延遲門檻與逾時常數：現行決定

| 常數 | 值 | 決定理由 |
|---|---|---|
| FR-014 共用單次逾時／退避／總預算（`retry-policy.ts`） | **15 秒／1s→4s／40 秒** | **一字不動**。放寬會把摘要／情緒／第一段的失敗偵測一起延後，代價由每一條路徑在所有時段支付；降級時段中位 52 秒，放到 20 或 45 秒都一樣救不回。⚠️ 若日後真的把**共用**逾時提到 20 秒，退避預算 MUST 同步提到 ≥45 秒（`1+20+4+20`）；per-call-site 的覆寫常數不觸發這條連動 |
| `SUGGESTION_STAGE2_CALL_TIMEOUT_MS`（`blocks/suggestion.ts`） | **20 秒** | 第二段以 `maxRetries: 0` 呼叫、不進重試迴圈，改它不牽動 FR-014 三數。實測最慢 13.0 秒對 15 秒只剩 13% 餘裕，平台漂移 36% 即逾時，而第二段逾時是**靜默**落成「未引用知識庫」（004 FR-003） |
| `SUGGESTION_STAGE1_CALL_TIMEOUT_MS`（同檔） | **20 秒** | 2026-09-02：SC-001 的 20 秒門檻配 15 秒共用逾時在重試路徑上**數學上不可達**（15＋1＋下一次 ≈9.7 秒必破 20；14/14 個破 20 秒的樣本都含 `retrying`，0 例外）。數字**直接取自判準本身**——超過預算才完成的呼叫繼續等沒有收益。修後「第一段從未發布」由 9/30 降到 3/30。代價（刻意接受）：連續失敗到底的偵測由約 50 秒變約 65 秒，期間顯示「重試中」而非空白。40 秒預算不需跟著改：第二次失敗時 elapsed ≈21 秒 < 40，重試鏈仍走得完 |
| `SENTIMENT_CONCURRENCY`（`blocks/sentiment.ts`） | **3** | 見下方「並行度」。**被量測過並經裁決的數字，不是沒人動過的預設值** |
| `SENTIMENT_CHUNK_SIZE` | **6** | §11.8 ②，已接受的取捨 |
| `SENTIMENT_BACKFILL_MAX_MESSAGES` | **18**（＝ 6 × 3） | 恰好 = `SENTIMENT_CONCURRENCY` 的一波（005 FR-009，T050 複查維持）。⚠️ 若真的調了並行度，這個數字 MUST 重算 |
| `KNOWLEDGE_SEARCH_TIMEOUT_MS` | **30 秒** | §12.4 ②-2；快查與建議卡共用，不得另立短逾時 |
| 001 SC-005／002 SC-001 門檻 | 摘要 **10 秒**／情緒 **15 秒**／首批建議卡 **20 秒**（皆 p90） | 三者目前皆【未達標·已安置】，數字**不放寬**，理由與重新判定條件見 §18 M2 |

⚠️ 兩個 20 秒**數值相同純屬巧合，MUST NOT 合併成一個常數**：第二段的 20 來自「實測最慢＋漂移餘裕」，第一段的 20 來自「SC-001 的預算」。合併會讓其中一個理由在下次調整時靜默消失。
⚠️ 跟著當次量測調出來的常數會在下一次漂移時失效——情緒的 15 秒門檻就是這樣失守的；取自判準的常數才是結構性的。
⚠️ 這些逾時槓桿只在平台正常時段有效：降級時段原始呼叫本身就遠超 20 秒。

#### 並行度掃描跑完了：3 是量過的，4／5 兩列同時變差（情緒的成本模型）

情緒每 `SENTIMENT_CHUNK_SIZE` 則切一批，總時間 ≈ **⌈批次數 ÷ 並行度⌉ 波 × 每波 max-of-N**。三件事已實測定案（數據附錄 C-6、C-7）：

1. **一波要等最慢的那一批**，max-of-3 ≈ 單次的 80 百分位，用中位數估會低估。3 批一波實測中位 11.4 秒，而單次中位只有 7.3 秒——差的就是 max-of-3。
2. **並行度本身會抬高單次延遲**（並行 1 → 3：中位 +12%、p90 +19%），但**不外溢**——同一輪的摘要與建議卡第一段沒有跟著變。max-of-N 取分佈上緣，受抬高的影響比中位數更大。
3. **正式掃描（2026-09-03，`npm run spike:sentiment-concurrency`，每檔位三輪 n=45、輪換順序、同一時段、序列取樣）**：檔位 4／5 在**總時間與單次失敗率兩列上同時比 3 差**——區塊 15 秒 p90 通過率 91% → 84% / 82%，單次破 15 秒率 3.8% → 6.4% / 10.6%。005 FR-019 的判準是「總時間改善**且**單次失敗率未上升」，這次連第一個條件都沒過。⚠️ **中位數是陷阱**：檔位 4 的中位比 3 快（6.6 vs 7.6 秒），但判準是 p90，並行度改善的是順利的那些、惡化的是尾巴，而 SC-005 判的正是尾巴。

✅ **裁決（2026-09-03，使用者）：`SENTIMENT_CONCURRENCY` 維持 3。** 要翻案 MUST 附上同口徑的新掃描，且兩列一起看；MUST NOT 用公式外推。反方向也不要動：並行 1 的情緒通過率只有 33%。

⚠️ **實際在飛的批次數會超過設定值，且調高檔位是自我增強的迴圈**：`withRetry()` 的 `Promise.race([fn(), timeout])`（`server/services/ai/retry-policy.ts`）逾時只是不再等它，**被放棄的呼叫仍在平台側跑**，重試又佔一個名額，實際負載 ＝ 設定值 ＋ 尚未落地的放棄呼叫數。檔位越高 → 破 15 秒率越高 → 被放棄的呼叫越多 → 實際負載又更高（檔位 3 量到峰值並發 4 的樣本，正是有呼叫破 15 秒的那幾個）。

#### 量測規程（每一條都是踩過才寫下的）

1. **判準的口徑 MUST 與條文逐字對齊。** 條文寫「第一批**可用的**卡」，腳本曾量「第一段自己發布」——兩者只在 004 FR-006a 的 abort 路徑上不等價，而那類樣本全部是慢的；未落地的樣本也曾被排除出分母（失敗率越高分數越好看）。2026-09-01 的 SC-001 因此由 83%／86%／71% 重算為 **67%／40%／33%**。`spike:progressive` 已改以 `firstCardsMs` 為判準、未落地計入分母、`stage1` 降為診斷欄位並**刻意移除其 `pass`**（同一個鍵在新舊檔裡意思不同，寧可讓舊讀法直接壞掉）。
2. **單輪 n=15 判不動任何 p90 門檻。** `ceil(0.9 × 15) = 14`，一個樣本就決定通過與否；相隔 30 分鐘的兩輪結論可以相反（摘要 93% → 53%、情緒 73% → 93% → 67%，附錄 C-8）。**MUST NOT 用單輪打勾或取消打勾**；翻案要兩次獨立時段的 n=45 都過。同理 n=5 的模型比較給出過兩個被 n=15 推翻的結論（附錄 C-2），比較 MUST 在同一時間窗內背靠背跑。
3. **隔離單次量測 MUST NOT 用來預測驗收**，理由是**輸入長度**，不是管線競用：隔離腳本用 8 則合成對話，管線的樣本混了 33 則與 50 則真實對話；相同長度下兩者幾乎一致（附錄 C-9）。「管線內競用」這個歸因已被把 `SENTIMENT_CONCURRENCY` 設回 1 的對照實驗推翻——摘要與第一段都沒有改善。連帶：「摘要的落差 repo 內沒有槓桿補得回來」重新成立（摘要是單次呼叫，沒有並行度可調）。
4. **同一次「爆發」不是對每個驗收項都是失敗。** 一組排除規則套到三個指標上要逐項確認：排除某輪的 3 個異常樣本後 SC-001 與摘要變好、情緒反而變差（那 3 筆的情緒全部達標）。
5. **時段本身就是結論。** 摘要 agent 同一天量到中位 6.3／52.1／11.1 秒三種分佈（附錄 C-5），我方沒有任何方式預先知道現在是哪一種；判斷「現在是哪一種時段」時 MUST 重跑，不要引用舊表。量測前 MUST 跑 `spike:agent-prompts` 排除 prompt 漂移，並標註時段（005 FR-020）。
6. **spike 失敗證明不了生產環境該次分析失敗**：spike 直接呼叫 provider，不經 `withRetry()`；生產路徑一律包在裡面。
7. **量測工具 MUST 共用正式路徑的抽取邏輯，MUST NOT 自己抄一份。** 18 號腳本曾自抄簡化版（漏了「找第一個 `{`／`[` 切掉開場白」），把摘要 agent 判成 0/15 不合規，而該 agent 一直正常；更危險的是註解寫著「比照正式路徑」。`extractLeadingJson()` 與 `buildSuggestionPrompt()` 已從 `ImbraceAgentProvider` 匯出供 spike 使用。
8. **要偵測的訊號與 agent 自身擺動同量級時，n=3 也不夠**——同一支 probe 在 n=3 下兩次給出方向相反的結論。先把 n 加大到能分辨，再談結論。
9. ⏳ **未證實的假設：背靠背量測會互相污染。** `callWithTimeout()` 不會取消底層呼叫（探針量到第二段原始耗時 102／62／48 秒，逾時卻是 20 秒），每次逾時都留下一個仍在消耗平台容量的呼叫；兩次被判為「平台降級」的觀測都出現在密集量測之中。冷卻 58 分鐘的一輪沒有重現爆發，但那只是方向一致的單一觀測。證實或推翻前，規程為**兩輪之間至少留 30 分鐘冷卻，且樣本要跨不同時段**。

#### 每次 AI 呼叫的 `user_id`：衛生問題，不是效能解方

SDK 的 `streamChat()` 在 `body.user_id` 缺席時會先 `POST /ai-agent/chat-client/auth/user` 取 id（隔離量測中位 54ms，20/20 同一個 id，附錄 C-4）。已於 2026-09-02 由 `callAgent()` 帶上，id 由防腐層 `resolveAiClientUserId()` 取一次並 process-local 快取；取得失敗不快取、退回「不帶、讓 SDK 自己查」的舊路徑（行為不變只是沒省到）。
⚠️ **它是 AI 服務的 client user id，與客服身分無關**——provider 拿不到 `operatorId` 是刻意的；填錯不會報錯，只會讓 AI 服務端的用量統計掛到錯的人身上。`test/ai-user-id.test.ts` 斷言請求 payload **只多了這一個欄位**。⛔ 54ms 補不上任何延遲門檻的缺口，MUST NOT 用「傳 vs 不傳」比端到端（σ ≈ 849ms 下要偵測 300ms 差異需 n≈100+）。

#### JSON 抽取：模型會在合法 JSON 前後加開場白／自我總結，即使 prompt 明確禁止

穩定出現、不是隨機偶發：前面加「Okay, I will...」或後面加「我已完成摘要...」。逼 prompt 100% 守規矩不可靠；正確做法是程式碼層面容錯：找文字中第一個 `{`／`[` 作為 JSON 起點，用 `JSON.parse` 錯誤回報的失敗位置切掉後面多餘的文字（`ImbraceAgentProvider` 的 `extractLeadingJson()`）。這個技巧對任何要求 iMBrace AI Agent 輸出結構化 JSON 的呼叫都通用。

#### ❌ 杜撰引用的成因不是「沒看到清單」—— 封閉清單量完前後零改善（2026-09-03）

`specs/005` US3：先取基線、再在 `buildSuggestionPrompt()` 加一段**顯式封閉清單**、再以同一組 15 段對話 × 3 輪重量（`npm run spike:citation-quality`，口徑 FR-017）：**杜撰率 21%（9/43）→ 21%（9/42），最終取得引用 84% → 82%，零改善**（完整表附錄 C-10）。

**原因已經查出來了**：被擋下的字串全是 `TC-ACC-007`、`TC-DEV-001` 這種**有結構的 SOP 編號**，而**知識庫文件的內文裡本來就寫著它們**（實測逐字對上）；我方交給模型的 `id` 卻是 `knowledge-fallback-<hex>`（`agent-knowledge-provider.ts` 的 `hashFilename()`：`folder_info` 比對不到檔案時的**代用 id**）。**模型不是憑空捏造，是在「我方的代用 id」與「文件自己的正式編號」之間選了後者**——對一個叫 `sopId` 的欄位來說那甚至比較合理。給它一份代用 id 的封閉清單並沒有回答它面對的問題，所以清單加了也不會動。

⚠️ 這推翻了 004 留下的描述「憑空造一個長得像 id 的字串」。**引用本結論時 MUST 用這一版。**
⚠️ 舊記載的「杜撰率 44%」出自 2026-08-29 的 n≈9，已由 n=43 的固定口徑取代（21%）。

**可動的槓桿因此換了位置**，三個候選皆需另立任務：① 讓 `sopId` 帶的就是文件的正式編號——要 iMBrace 先確認有沒有正式 SOP 編號制度（`IMBRACE_QUESTIONS.md` 0-3g ②，這個實測讓那一題從錦上添花變成主線）；② 把 `hashFilename()` 的代用 id 佔比壓下來（先查 `folder_info` 為什麼比對不到）；③ 在後台建議卡 prompt 規定「`sopId` 只抄檢索結果的 `id` 欄位，不得抄文件內文出現的任何編號」——在 iMBrace 後台，不在本 repo。

⚠️ **封閉清單的程式碼刻意保留不回退。** 它零改善但也零代價，而它是「模型看得到清單仍不照著填」這個結論的唯一證據。
⚠️ 「某幾段對話特別容易杜撰」這條 004 留下的線索在 n=45 口徑下沒有站住（n=3／段，分布變化在雜訊內）。

### 8.3 狀態與事件匯流排

> **關鍵規則：這兩個介面的所有方法從 day 1 就必須是 async。** 若寫成同步的 `map.get()`，M4 換 Redis 時要修改數十個呼叫點；先寫成 `await store.get()`，換實作只需一天。

```ts
// server/state/types.ts

export interface StateStore {
  getSession(id: string): Promise<Session | null>
  setSession(id: string, s: Session): Promise<void>
  deleteSession(id: string): Promise<void>

  getCopilotSession(convId: string): Promise<CopilotSession | null>
  setCopilotSession(s: CopilotSession): Promise<void>

  addPresence(convId: string, op: PresenceEntry): Promise<void>
  removePresence(convId: string, operatorId: string): Promise<void>
  listPresence(convId: string): Promise<PresenceEntry[]>

  acquirePollLock(convId: string, ttlMs: number): Promise<boolean>
  releasePollLock(convId: string): Promise<void>

  seen(eventKey: string, ttlMs: number): Promise<boolean>
}

export interface EventBus {
  publish(topic: string, payload: unknown): Promise<void>
  subscribe(topic: string, handler: (payload: unknown) => void): Unsubscribe
}
```

**Topic 命名慣例**

| Topic | 用途 |
|---|---|
| `operator:{operatorId}` | 推播給特定客服（JOIN 通知、跨對話提醒） |
| `conversation:{conversationId}` | 推播給所有正在檢視該對話的人（新訊息、presence、分析結果） |

⚠️ **換掉 `StateStore` 涵蓋不到分析管線的八份 process-local 狀態**（各模組自己的 `new Map()`／`Set`，不在 `StateStore` 裡也沒有 `globalThis` 鍵），清單見 §18 M2「分析管線拆檔」的 📌 註記，M4 驗收另有一條。

---
## 9. 即時機制與輪詢策略

### 9.1 核心設計：共享訂閱

> **輪詢以 `conversationId` 為鍵做共享訂閱（reference counting），不是以使用者為鍵。**

三位客服同時檢視同一對話 → 只輪詢一次，結果 fan-out 給三個 SSE 連線。訂閱數歸零即停止輪詢。多副本部署時，需搭配 `acquirePollLock()` 確保同一對話只有一個副本在輪詢。

### 9.2 自適應頻率

| 對話狀態 | 輪詢間隔 |
|---|---|
| 前景聚焦 + 已 JOIN | **3s** |
| 前景聚焦 + 觀察中 | **5s** |
| 背景 + 已 JOIN | **15s** |
| 背景 + 觀察中 | **30s** |
| 連續 5 次無新訊息 | 指數退避，上限 **60s** |
| 出現新訊息 | 立刻跳回最快檔 |
| 瀏覽器分頁 `hidden` | 全部降至 **30s** 以上 |

> 撞單防護的有效性不靠輪詢頻率——真正有效的是 §10.4 的送出前樂觀併發檢查，那一層在按下送出的當下才比對版本，不受輪詢延遲影響。輪詢只影響「畫面上多久看到同事的訊息」，3 秒已足夠，API 壓力卻少一半。此表為暫定值，待 iMBrace 提供書面 rate limit 規格後定案；在那之前的原則是「取保守值」——撞到未知上限的後果遠比慢 1.5 秒嚴重。

### 9.3 取數方式與成本評估

**取數方式已定案**：`GET /v1/conversation_messages?conversation_id=<id>`——後端強制要求 `conversation_id`（不帶會 400），只是 SDK 的 `messages.list()` 未公開此參數。實作見 `server/sources/message-fetch.ts` 的 `raw-conversation-id` 策略。**但不支援增量拉取**，已實測 `since`／`after`／`since_id`／`from_created_at`／`start_time`／`created_at_gt` 等八種寫法全部被忽略。

> ### ⚠️ 對話有三種識別碼 —— 本專案最容易靜默出錯的地方
>
> | 來源 | 欄位 | 範例 | 是什麼 |
> |---|---|---|---|
> | `conversations.search()` | `id` | `b6f76f09-…` | 對話 id，裸 UUID |
> | 訊息 | `conversation_id` | `conv_b6f76f09-…` | 同一個對話，帶前綴 |
> | `conversations.get()` | `id` / `_id` | `tcu_6cd3cee1-…` | **不是對話 id**——是 team_conversation 這筆關聯記錄自己的 id。該物件另有 `conversation_id` 欄位，那才是對話 id |
>
> 查詢端點 `?conversation_id=` 兩種形式都接受，所以打得通不代表比得對。傳錯不會有型別錯誤，只會靜默不作用或比對永遠不相等——這個坑已造成過兩次實際損害：`precisionOf()` 曾把 100% 正確的取數判成 0%，差點誤判 M1 被阻塞；`toConversation()` 若取錯欄位，同一對話經 `search()` 與 `get()` 會得到兩個不同的鍵，症狀是「訊息進來了但面板沒反應」，極難追查。
>
> **`{id}` 這個路徑參數同時吃對話 id 與 `tcu_` id**，平台自行解析——`conversations.get(id)`（`GET /v1/team_conversations/{id}`）兩種形式皆可查到完整詳情；`conversations.getByConversationId()` 反而兩種形式都回空（`{data:[],total:0}`），不要用。**正規形式取裸 UUID**，一律經 `mappers.normalizeConversationId()` / `sameConversation()` 轉換。實作見 `server/services/imbrace.ts` 的 `getConversationDetail()`。

以 §9.2 頻率估算，20 位客服 × 平均 3 對話、共享訂閱後約 **9.4 req/s**，但每個請求的 payload 是全量而非增量（單一對話最多 398 則訊息），這才是真正的成本所在。**必要的緩解措施（前三項 M1 已完成，第 4 項仍未實測）**：

1. `limit=N` 只取最新 N 則（N=50）——✅ 已確認訊息預設由新到舊排序，`limit=N` 直接就是最新 N 則，不需 `sort` 或 `skip=total-N`
2. 本地以 `lastMessageId` 比對，只把新增部分推給前端（SSE payload 仍是增量的）
3. 並發控制——**每個對話同一時間只有一個 in-flight 請求**（`polling-message-source.ts` 的 `inFlight` 旗標；這是正確性不是最佳化，重疊的兩次取數會讓錨點比對亂掉）。沒有全域上限，穩態成本由 §9.3.1 的清單輪詢壓下來
4. ⏳ `ETag` / `If-None-Match` 探測——**尚未實測**，後端是否支援未知，不列入 M1 已完成範圍

> `skip` 亦實測有效，可正常分頁回補歷史——首次載入若需完整歷史，走 `skip` 分頁而非一次全量。

### 9.3.1 清單輪詢：成本降一個量級

`conversations.search()` 的清單 payload 帶 `last_message_at` 與 `updated_at`，**兩者都會即時更新**（實測送出訊息後同一取樣週期內 ≤2 秒跳動）。因此輪詢架構改為兩層：

```
第一層（永遠在跑）：conversations.search()  ← 1 個請求，涵蓋全部對話
                         │
                         ├─ last_message_at 變了 → 該對話有新訊息
                         └─ updated_at 變了      → 該對話的狀態變了（JOIN/LEAVE/mode）
                         │
第二層（只在變動時）： conversation_messages?conversation_id=…&limit=N
```

| | 舊模型（逐對話輪詢） | 新模型（清單輪詢） |
|---|---|---|
| 穩態（無人說話） | ≈ 9.4 req/s | **≈ 0.33 req/s**（1 次 / 3 秒） |
| 有訊息時 | 同上 | 0.33 + 每則訊息 1 次 |
| 對話數增加的影響 | 線性增加 | **不變** |

這同時解決了新訊息偵測、JOIN／LEAVE 偵測、以及 §9.1 共享訂閱要解決的「同一對話被多人重複輪詢」——第一層本來就只有一份。

> ⚠️ 仍要保留第二層的 `lastMessageId` 比對——`last_message_at` 只說「有新東西」，不說「新了幾則」。且**`last_message_at` 實測填充率僅 83%**，部分對話為 `(無)`，這些對話須退回逐對話輪詢。
>
> 輪詢仍不是瓶頸，AI 呼叫才是（延遲見 §8.2b）。
> ⚠️ **第一層的間隔在「排下一拍」的那一刻就固定了，之後不會自己重評。**
> 而這一層只在「該組織有人連線」時才真的取數（沒人時 `borrowCredential()` 回 null，
> 直接回空陣列且不報錯）——兩者相乘會生出一個安靜的空窗：runtime 由**最先到的請求**建立
> （JOIN 這類寫入請求也會建），那一刻 SSE 連線往往還沒登記憑證，於是第一拍取不到數，
> 並照**背景 30 秒**排下一拍。客服隨後連上線、分頁切回前景都不會讓它變快。
>
> 因此憑證登記與「切回前景」都必須叫醒第一層（`ConversationListPoller.wake()`，
> 由 `credentials.ts` 的 `onCredentialUpgrade()` 通知）。
> ⚠️ **兩層在前景都是 3 秒**，第一層整場沒跑的症狀會被第二層完美掩蓋，要到對話轉背景
> （第二層降到 15 秒）才露出來 —— **改動任一層的頻率前要記得這件事**。

對應追問項見 `IMBRACE_QUESTIONS.md` B-1（有無推播機制、現行輪詢頻率是否可接受）與 G-2（rate limit 規格）。

### 9.4 換成 webhook 後仍要保留對帳輪詢

Webhook 會漏、會亂序、會重送。生產環境必須保留低頻對帳輪詢，比對本地 `lastMessageId` 與遠端，補上遺漏的訊息。省略此機制的後果是「偶爾少一則訊息」——最難重現、最難追查的一類 bug。

機制**現在就存在**：被第一層清單輪詢涵蓋的對話，第二層只以 `POLL_RECONCILE_MS`（30 秒）做對帳，即時性由 `poke()` 提供（`polling-message-source.ts` 的 `effectiveIntervalMs()`）。M4 換成 webhook 後 MUST 保留這一層，不得因為「有推播了」把它拿掉。

### 9.5 SSE 契約

正典為 `shared/types/events.ts`，此處為摘要（區塊型別見 `shared/types/copilot.ts`）：

```ts
export type CopilotEvent =
  | { type: 'session.opened';      conversationId: string; reason: 'join' | 'resume' }
  | { type: 'session.closed';      conversationId: string; reason: 'leave' | 'resolved' }
  | { type: 'messages.appended';   conversationId: string; messages: Message[] }
  | { type: 'presence.updated';    conversationId: string; presence: PresenceSnapshot }
  | { type: 'control.updated';     conversationId: string; control: ConversationControl }
  | { type: 'conversation.updated';conversationId: string; lastMessageAt?: string }
  | { type: 'summary.updated';     conversationId: string; summary: SummaryBlock }      // M2
  | { type: 'sentiment.updated';   conversationId: string; sentiment: SentimentBlock }  // M2
  | { type: 'suggestion.updated';  conversationId: string; suggestion: SuggestionBlock } // M2
  | { type: 'stream.heartbeat';    at: string }
```

**① `presence.updated` 的 payload 不是純 `PresenceEntry[]`**——§10.2 的第三個來源（`mode`）只知道「有人能送出訊息」，指不出是誰，塞不進以 operatorId 為鍵的陣列：

```ts
interface PresenceSnapshot {
  operators: PresenceEntry[]      // ①SSE 與 ②訊息反推 —— 皆具名
  unidentifiedActor: boolean      // ③mode —— 有人能送，但無法指名
  mode: ConversationMode | null
}
```

**② 斷線補齊不靠 `Last-Event-ID`，靠對帳。** 「已送出事件」的儲存放在單一副本記憶體裡，M4 上多副本後重連到別的副本就補不到——那正是「偶爾少一則訊息」這類最難追查的 bug。改採**對帳式補齊**：前端重連後以自己的 `lastMessageId` 打 `GET /api/messages?conversationId=…&since=…` 重新對帳，與 §9.4「webhook 上線後仍要保留對帳輪詢」同一原則——**真相一律回源頭取，不依賴傳輸層的可靠性假設。** 事件仍帶 `id`，但只用於排序與除錯。

**③ `messages.appended` 不代表「有新訊息」，去重責任在消費端。** 該事件會整批重送已知訊息——pipeline 每次因 `{priority, joined}` 改變被拆掉重建（分頁切到背景、切到別的對話、SSE 重連），輪詢錨點就歸零，於是整段歷史被當成新訊息推上來，**而對話本身什麼都沒發生**。凡要回答「有沒有新訊息」的消費端 MUST 以自己的去重結果為準，MUST NOT 以「事件到了」代替。這個坑踩過兩次：訊息列表當年為此去重了，結案的過期標記沒跟上，症狀是「按下結案後憑空冒出『對話有新內容，建議重新產生』且抓不到規律」（2026-09-07 修，見 `app/utils/message-merge.ts`）。

**④ 代理層的要求不在本契約裡，但沒做對本契約整個失效**：TLS 終端／反向代理 MUST 對 `/api/stream` 關閉回應緩衝、read timeout 大於 25 秒的心跳，見 §16.1 前提 2。症狀是連得上但永遠沒有事件，不報錯。

---

## 10. 多客服協同與撞單防護

### 10.1 必須接受的前提

> **AgentCopilot 攔不住任何人在 iMBrace 官方介面按 JOIN，因此任何「鎖」都是假的。**

iMBrace 目前不設計 JOIN 的排他鎖，本專案也不打算加。正確策略不是防止碰撞，而是**讓碰撞在造成傷害前被看見**。三層防線，重要性由低到高：

### 10.2 第一層：Presence

SSE 連線時上報 `viewing: conversationId`，server 維護 `conversation → operators` 對應。對話頂端即時顯示「王大明 正在檢視・李小華 正在輸入…」。

```ts
type PresenceState = 'viewing' | 'composing' | 'joined'
```

走自家 SSE，延遲 < 200ms，不依賴 iMBrace。**`Conversation.users[]` 不能作為 presence 來源**——它是團隊名冊不是對話參與者：兩個不同對話回傳同一批 14 人，含 `is_bot: true` 與 `team_user_role: observer`，且 JOIN/LEAVE 全程數量不變（完整驗證過程見附錄 B）。

**真正可用的第四來源是 `mode` 欄位**：JOIN 時 `null → manual`，LEAVE 時 `manual → automation`，雙向正確且在清單 payload 中，一次清單輪詢（§9.3.1）即可得知所有對話有沒有真人在處理，成本為零。

```ts
// 正確的判定：是否有他人可能送出訊息
const someoneElseCanSend = mode === 'manual' || mode === 'hybrid'
```

`mode` 回答的不是「有沒有人在」，而是「有沒有人能送出訊息」——`automation` 對「真的沒人」與「有人但選了 Automation Only（唯讀）」無法區分，但唯讀者送不出訊息，不構成撞單風險。UI 文案不可寫成「目前沒有其他人在看」，那是超出資料能支持的宣稱。

**presence 四來源**：

| # | 來源 | 涵蓋 | 延遲 | 能否指出「是誰」 |
|---|---|---|---|---|
| ① | 自家 SSE 上報 | 只涵蓋我方使用者 | < 200ms | ✅ 可，高可信度 |
| ② | 訊息 `u_` 前綴反推（N 分鐘窗口，預設 10） | 官方介面的同事 | 一個輪詢週期 | ✅ 可，但只在發言後才可見 |
| ③ | `mode ∈ {manual, hybrid}` | 涵蓋所有「能送出訊息」的人 | 一個清單輪詢週期 | ❌ 只知道「有人」，不知道是誰 |
| ④ | JOIN/LEAVE webhook | 全涵蓋 | 即時 | 待規格（M4） |

**UI 必須誠實標示來源差異**：

```
王大明 正在輸入…              ← ① 即時，確定在線，具名
李小華 3 分鐘前回覆過          ← ② 推測，可能已離開，具名
有同事正在處理                ← ③ 只知道有人，無法指名，無頭像可放
```

② 不可顯示成「正在檢視」——「曾經發言」不等於「現在還在」，誤導比不顯示更糟。③ 不可寫成「目前沒有其他人在看」或捏造姓名。**空狀態是常態，不是例外**——① 在單人使用時為空、② 在無人發言時為空，設計上要讓「無人／未知」看起來正常，而不是壞掉。

#### 10.2.1 左欄清單能知道「誰在裡面」到多少 —— `npm run spike:join-visibility`（2026-09-01）

§10.2 的四來源是為**中欄的 PresenceBar** 設計的（那裡有 SSE，且能排除自己）。
**左欄清單是另一回事**：它一次要標 N 則對話，而清單 payload 的資訊比詳情少。
實測 16 筆（`scripts/spike/out/23-list-join-fields.json`）：

| 清單欄位 | 有值嗎 | 語意 |
|---|---|---|
| `mode` | 10/16（其餘為 `null`） | 同 §10.2 ③。`null` ＝ 從未 JOIN 過 |
| `is_agent_joined` | 10/16（其餘為 `null`，**沒有任何一筆是 `false`**） | 「**曾經**有人 JOIN 過」。單向黏著，見 §「presence 的其他候選欄位」 |
| `is_joined`（我的視角） | **0/16 —— 清單完全沒有這個欄位** | 只有單筆 `conversations.get()` 才有 |

⚠️ **也沒有「只列出我 JOIN 的」這種端點。** SDK 的 `getViewsCount()` 註解逐字寫著
「Count conversations per view (**all/joined/yours**)」，`list()` 也有一個未說明的 `type?: string` ——
實測 `getViewsCount()` 回的是 **status** 分組（`{active: 12, open: 4}`），
`list({type:'all'|'joined'|'yours'})` 三種全回 **0 筆**。可用的清單端點只有
`search({ businessUnitId })`。這是「§ SDK 型別與實際 API 不一致」的又一例（`out/23-views.json`）。

兩欄的組合恰好把對話分成三類（實測分布：6／9／1）：

| `mode` | `is_agent_joined` | 意思 |
|---|---|---|
| `null` | `null` | 從未有人 JOIN 過 |
| `automation` | `true` | 曾經有人 JOIN，**現在沒人**（或有人但選了 Automation Only ← §10.2 的盲區） |
| `manual`／`hybrid` | `true` | **現在有人**且能送出訊息 |

⚠️ **`is_agent_joined` 不能拿來顯示「無客服在此」。** 本次再次實測 LEAVE 後它仍是 `true`
（`mode` 正確轉回 `automation`、`is_joined` 正確轉 `false`）—— 與 §「presence 的其他候選欄位」
從 spike 12 得到的結論一致，兩次獨立實測同向。

⚠️ **左欄標不出「你在此對話中」，也標不出「是哪位同事」。**
前者需要 `is_joined`（清單沒有），後者需要參與者清單（`users[]` 是團隊名冊）。
因此左欄第二行的 presence 措辭**只能是不指名、也不區分是不是自己的說法**
（見 `DESIGN_TOKENS.md` §8.2 的偏離說明）。

#### 10.2.1a 「標出我 JOIN 的每一則」怎麼做的

正典程式碼在 `server/services/viewer-joined.ts`，那裡的檔頭有完整的成本模型與盲區清單，
**這一節只放不看程式碼也必須知道的三件事**：

1. **候選集合是 `mode ∈ {manual, hybrid}`，不是 `is_agent_joined`。**
   後者單向黏著、只增不減（上表），上線幾個月後會趨近全部對話，等於退化成「查每一列」。
   而「現在有人在」量的是**團隊規模 × 每人並行數**，與一天進來幾則無關 ——
   一天 500 則、10 位客服每人同時開 3 則，候選仍是 30。
2. **刻意不設 TTL**（2026-09-01 使用者以「上線後一天可能上百則」為由裁定）。
   失效訊號是 `mode` 變動（清單輪詢免費偵測）＋ 我方自己的 JOIN／LEAVE／切換 mode
   （寫穿快取）＋ 開啟對話時回填。**穩定狀態的額外呼叫是 0** ——
   前景清單輪詢 3 秒一次，全部命中快取。
3. **`Conversation.viewerJoined` 的 `undefined` 不等於 `false`。**
   單輪解析有上限（`VIEWER_JOINED_RESOLVE_LIMIT`），排不進來的留到下一輪。
   UI MUST 用 `=== true` 判斷 —— 反推會在還沒解析完的瞬間說出我們還不知道的結論。

⚠️ **不可改用 `store.listJoinedConversations()` 單獨兜** —— 那份記錄在記憶體裡，
重啟／HMR 後歸零，也記不到官方介面的 JOIN（同一個家族的不同步已經害過一次，
見 `conversation-context.ts::isViewerJoined()` 的註解）。它在新設計裡是**快路徑**，
不是真相來源。

⚠️ **`joinedConversations` 與「判定快取」是兩個不同的東西，不可合併**：
前者只記得住 `true`，後者必須連「答案是 false」都記得住 ——
否則同事的對話每一輪都會再向平台問一次，那正是這個快取要避免的成本。

**僅存的盲區**：`automation` 對「真的沒人」與「有人但純觀察」無法區分——但這不構成撞單風險。`IMBRACE_QUESTIONS.md` A-1 要求 webhook payload 附帶完整 operator 清單，就是為了補上這個 presence 語意上的缺口（非撞單防護所需）。在 webhook 到位前，撞單防護仍以 §10.4 的送出前檢查兜底——那一層本來就是真正有效的防線。

### 10.3 第二層：JOIN 意圖廣播（advisory lock）

按 JOIN 前先送 `intent:join` 到 EventBus，立刻廣播給其他人。他人畫面上該對話的 JOIN 按鈕變灰並顯示「王大明 正在加入…」，但仍可強制點擊（因為我們無權真的阻擋）。這是勸告式而非強制式的鎖。

### 10.4 第三層：送出前的樂觀併發檢查 ← 真正有效的一層

> **關鍵認知：「一鍵帶入」≠「送出」。真正的傷害不是兩個人都 JOIN，而是兩個人都回覆了客戶。**

因此把防線放在送出的那一刻：

```ts
// 帶入建議時記錄版本錨點
const baseMessageId = session.lastMessageId

// 送出前檢查
const since = await messageSource.fetchSince(conversationId, baseMessageId)

// ⚠️ 必須以 sender.type 判斷，不可用 direction —— AI workflow 的自動回覆同樣是 outbound，
// 若以 direction 判斷，AI 在客服組字期間回了一句就會觸發假警報
const byOtherAgent = since.filter(
  m => m.sender.type === 'agent' && m.sender.id !== me.operatorId,
)
// 協作模式下，AI 也是撞單對象。只在 AI 真的會自動回覆時才列入檢查
// （Manual Mode 下 AI 不會送出，列入檢查就是製造假警報，見 §10.5 / §19.1 #12）
const byAi = control.aiReplies
  ? since.filter(m => m.sender.type === 'ai')
  : []

if (byOtherAgent.length > 0) {
  // 「李小華 在 4 秒前已回覆客戶，你的內容可能重複」
  // → [↓ 先看最新訊息] [我已確認，仍要送出] [捨棄草稿]
} else if (byAi.length > 0) {
  // 「AI 在 2 秒前已自動回覆，請確認內容是否衝突」
  // → [↓ 先看最新訊息] [我已確認，仍要送出] [捨棄草稿]
}
```

以 `lastMessageId` 作為版本號的樂觀併發控制。**假警報比沒有警報更糟**——客服學會忽略提示後，真正的撞單也會被一併略過。

> ⚠️ **`byAi` 目前會誤把 workflow 的內部中繼訊息當成真正回給客戶的回覆。** 同一個 `pub_` workflow 會在同一對話裡送出兩種訊息，API 上完全無法區分：一種是真的送達客戶的回覆文字，另一種是 `{"route":"T1"}` 這類節點間的內部路由訊息，客戶可能根本收不到，但 `Message` 物件上沒有任何旗標能分辨。**暫行做法**：`sender.type === 'ai'` 且 `text` 整段可解析為 JSON 物件／陣列時，視為內部訊息並排除。這是啟發式判斷，不是規格——若 iMBrace 的正式回覆格式混入自由文字會失效。已列為對 iMBrace 的 P1 追問（`IMBRACE_QUESTIONS.md` H-3c）。**串接 `byAi` 邏輯前務必先確認這個啟發式是否還成立。**

**此機制不需要任何平台端支援，M1 即可實作，且是整套協同設計中唯一真正能防止客戶收到重複回覆的一層。**

### 10.5 第四個競爭者：AI 本身

> **已確認**：JOIN 時預設進入 Manual Mode（AI 關閉），因此「AI 與真人同時運作」**不是預設狀態**。但客服可隨時切到 **Hybrid Mode**，此時 AI 仍持續自動回覆——**本節整段只在 Hybrid 模式下適用**（見 §10.6、§19.1 #12）。

在 Hybrid 模式下，真人組織一則回覆需 20–40 秒；AI 回覆只需 1–2 秒。只要客戶在這段窗口內說了任何一句話，AI 幾乎必然搶先回覆，客服送出時可能重複 AI 已說過的內容、與 AI 說法矛盾、或承接一個已被帶往別處的話題。**因此協作模式（Hybrid Mode）下的撞單防護不是輔助功能，而是產品可用性的前提**——反過來說，Manual Mode 下把 AI 列入撞單檢查就是製造假警報（§10.4）。

**協作模式必須補的三項設計**：

**① Composer 上方常駐 AI 活動指示**——事後攔截是補救，不夠，客服需要在打字當下就知道 AI 動了：

```
┌──────────────────────────────────────────────┐
│ ⚡ AI 協作中 — AI 仍會自動回覆客戶              │
│ ⚠ AI 在 3 秒前已回覆：「請稍候，正在為您查詢…」  │
└──────────────────────────────────────────────┘
│ [輸入區]                                [送出] │
```

第二行僅在「AI 剛回覆」且「客服正在組字」時出現，明顯但不奪取焦點。

**② 建議卡需要「失效」狀態**——新訊息進來時必須重新評估既有建議卡，被 AI 搶先說掉的標示為「AI 已回覆類似內容」並降級或移除。

**③ 建議生成的 prompt 必須知道「AI 也在場」**——`control.aiReplies === true` 時，prompt 須明確告知模型當前為協作模式，要求產生補位性質的建議（情緒安撫、權限內的破例、明確承諾、升級處理），而非重複 AI 已能處理的例行說明。若忽略此點，客服會發現「這張卡的內容 AI 兩秒前剛說過」，很快就不再看建議卡。

### 10.6 服務模式與主管接管

**平台已有三種模式**——這不是我們要自行發明的功能，iMBrace 官方介面的 Composer 上方就有這個下拉選單。按下 JOIN 時預設為 Manual Mode，之後客服可隨時切換：

| 官方介面選項 | 官方說明文字 | AI 自動回覆 | 客服可送出 |
|---|---|---|---|
| **Manual Mode** | Chats 1-on-1, automation is off | ✗ | ✓ |
| **Automation Only** | Replies automatically, you can only view | ✓ | **✗（唯讀）** |
| **Hybrid Mode** | Replies automatically, and you can also send messages | ✓ | ✓ |

**API 對應**：`conversations.get()` 與清單 payload 的 `mode` 欄位——未 JOIN 為 `null`，Manual 為 `manual`，Hybrid 為 `hybrid`，Automation Only 為 `automation`。LEAVE 後回到 `automation`（與「有人但選 Automation Only」同值，見 §10.2 的歧義說明）。

> ⚠️ **`mode` 是對話層級的共用狀態，不是每個客服各自的偏好。** 任一位客服切換模式，其他所有人（含我方）都會跟著改變：我方 Composer 不可快取 mode，必須跟著輪詢更新；同事把模式切成 Automation Only 時，我方的 Composer 也會被停用——這不是 bug，但畫面必須說清楚原因。

**資料模型：兩個正交維度**——平台的三種模式恰好是兩個布林維度的三種有效組合：

```ts
// shared/types/conversation.ts —— 正典在程式碼，此處為摘要
export interface ConversationControl {
  /** AI 是否自動回覆 —— 為 true 時 AI 是撞單對象之一（§10.5） */
  aiReplies: boolean
  /** 客服能否送出 —— Automation Only 時為 false，平台端也會拒絕 */
  agentCanSend: boolean
  /** 產生上述兩維度的平台 mode，供 UI 顯示與除錯 */
  mode: ConversationMode | null
  lock: null | {                      // 誰能回覆（我方自訂，平台無此概念）
    by: string                        // operatorId
    name: string
    at: string
  }
}

/** 平台 mode → 兩維度。⚠️ `null`（從未 JOIN）視同 automation */
export function controlFromMode(mode, lock = null): ConversationControl
```

| 平台 mode | `aiReplies` | `agentCanSend` |
|---|---|---|
| `manual` | `false` | `true` |
| `automation` | `true` | `false` |
| `hybrid` | `true` | `true` |
| （兩者皆 false） | — | 平台無此模式，我方也不應產生 |

客服切到 Manual → `aiReplies = false`；主管按「強制介入」→ `aiReplies = false` + `lock = { by: 主管 }`。

**對 Composer 設計的硬性約束**：① Composer 上方必須有模式指示，與官方介面一致——客服會在兩邊切換工作，同一對話顯示不同狀態會直接誤送；② `Automation Only` 時 Composer 必須停用，不能只是送出後失敗；③ `Hybrid` 是撞單真正會發生的模式，§10.5「AI 是第四個競爭者」只在此模式下適用，不是預設情況（見 §19.1 #12）；④ mode 可能隨時被改變，是輪詢要偵測的一級狀態，§9.3.1 的清單輪詢已涵蓋（`updated_at` 會跳動）。

**寫入方式：切換模式與 JOIN 是同一支端點**：

```
POST /channel-service/v1/team_conversations/_join
{ "team_conversation_id": "tcu_042cae1b-…", "mode": "hybrid" }
```

這正是 SDK `conversations.join()` 打的端點，只是型別沒有把 `mode` 宣告出來（靠索引簽章傳入即可）。JOIN = 這支端點帶 `mode: 'manual'`；切換模式 = 對已 JOIN 的對話再打一次同一支端點，換不同的 mode。實作見 `server/services/imbrace.ts` 的 `joinConversation()` / `setConversationMode()` / `leaveConversation()`。

> ⚠️ **兩個不照著寫就會失敗的地方**：① 識別碼必須是 `tcu_` 開頭的 team_conversation id，不是對話 id——兩者都是 UUID 形狀，傳錯不會有型別錯誤，平台對錯誤 id 可能只是靜默不作用，症狀是「按了 JOIN 但沒反應」，ACL 的 `assertTeamConversationId()` 會當場擋下。② `tcu_` id 只有 `conversations.get()` 會回傳，清單 payload 沒有，因此「從對話列表按 JOIN」必須先取一次詳情才拿得到識別碼——這是 M1 實作對話列表時要預先安排的一次額外請求。③ SDK 型別把 `conversation_id` 宣告成必填，但實際 API 只要 `{ team_conversation_id, mode }`，此不一致已由 ACL 的 `joinBody()` 單點吸收。

**這個鎖的邊界（必須誠實標示）**：

| 範圍 | 能否強制 |
|---|---|
| AgentCopilot 內的其他客服 | ✅ 能——Composer 唯讀 + **送出 API 拒絕**（不可只在前端 disable） |
| 直接使用 iMBrace 官方介面的客服 | ❌ **擋不住** |

介面上必須明示此邊界，不可讓主管誤以為已完全接管。**可能的強化手段**：主管強制介入時一併呼叫 `conversations.removeTeamMember()` 將其他客服移出對話，但被移除者是否可自行重新 JOIN，需向 iMBrace 確認（`IMBRACE_QUESTIONS.md` H-4）。

**稽核要求**：主管強制介入必須留下稽核紀錄——誰、何時、哪個對話、中斷了誰。這是有勞資敏感性的操作，缺乏紀錄時任何爭議都無從釐清。

**角色權限來源（建議，尚未定案）**：強烈建議不要在 AgentCopilot 自建角色權限系統——客服的身分、團隊歸屬、主管關係已在 iMBrace 上管理，自建第二套的代價是新人到職須建兩次、離職帳號須記得兩邊都關、稽核軌跡分散兩處。

| 順位 | 做法 | 說明 |
|---|---|---|
| 1 | 沿用 iMBrace 角色 | 需確認 access token 能否取得角色／團隊（見 H-5） |
| 2 | 極簡白名單 | `config/supervisors.yaml`（尚未建立，隨主管接管功能）列主管 email，第一版足夠，明確是暫時方案 |
| 3 | 自建角色管理頁 | 最後手段，待確實出現多角色、多權限組合需求時再評估 |

### 10.7 刻意阻斷使用者的情境

協同相關的主動阻斷只有兩種：**撞單偵測**（重複回覆客戶的傷害遠大於多按一次按鈕）與**主管鎖定**（見 §10.6）。加上 token 過期需重新登入（§15.2），全系統共三種，構成憲法 3.3 的封閉集合。除此之外，任何故障都不得阻斷工作流程（憲法第三條）。

---

## 11. AI 分析管線與資料契約

### 11.1 觸發策略

| 階段 | 觸發時機 | 送給模型的內容 | 產出 |
|---|---|---|---|
| **冷啟動** | JOIN 事件 | 全量歷史（或近 N 輪 + 更早的壓縮摘要） | 摘要、情緒序列、首批建議 |
| **增量（前景）** | 新訊息，debounce 1s | 既有摘要 + 新訊息（不重送歷史） | 摘要 patch、追加情緒點、重算建議 |
| **增量（背景）** | 新訊息，debounce 明顯長於前景；受並行上限節流 | 新訊息（不重送歷史、不含既有摘要） | 追加情緒點、重算建議（**不產出摘要 patch**，見 §11.2） |
| **不觸發** | 客服自己送出的訊息 | — | 僅更新畫面訊息流 |
| **不觸發** | 每 20 秒的 presence 心跳（`{priority, joined}` 未變） | — | 完全 no-op：不重新 attach、不送快照、不補跑 |
| **不觸發** | 同一批訊息在同一區塊已經失敗過 | — | 維持 error 狀態，**不自動重跑** |
| **不觸發** | 該對話已無任何人 JOIN（客服按下離開／結案之後） | — | 停止排入新的分析（執行中的不中斷） |
| **手動** | 使用者點「重新分析」／「全部重試」 | 全量 | 該區塊（或全部 error 區塊）重算 |

> ⚠️ **後三列（`specs/003-analysis-trigger-policy`）擋的是一個實測約 3,780 次 AI 呼叫／小時／對話
> 的無限重試迴圈**，成因**三處都是判斷寫在錯的那一層**，不是缺少機制。改動這三處前先讀懂為什麼：
> ① `createWatchRegistry.watch()` 不可對心跳與真實變化走同一條路（`attach()` 帶有送快照＋補跑的副作用）；
> ② 分析失敗時 `sentimentBlock.timeline` 與 `summaryBlock.summary.basedOnMessageId` 都不推進，
>    同一批訊息因此永遠被判定為「尚未涵蓋」；
> ③ `runIncremental()` 的門檻不可寫成「分析狀態存不存在」—— 分析狀態有 2 小時 sliding TTL、LEAVE 不會清掉它。
>
> **失敗之後只有三件事能讓它再跑**：客服手動重試、出現新的客戶發言而形成新的一批（自癒）、重新 JOIN 走冷啟動。
> **刻意不加第二層自動退避重試**（60 秒→5 分鐘方案已於釐清階段否決）—— 自癒靠的是「客戶還在說話」，
> 對話真的沉寂時本來就沒有重算的價值。

### 11.2 前景／背景分級（成本控制的核心）

```
前景聚焦的對話  → 完整 pipeline：摘要 + 情緒 + 建議生成 + 知識庫檢索
背景對話        → 情緒 + 建議生成 + 知識庫檢索，並產出徽記提醒
                  ⚠️ 不跑對話摘要 —— 摘要是給人看的，人不在就不必更新
                  受並行上限與較長 debounce 節流（憲法 6.2）
切換至某背景對話 → 情緒與建議卡已在背景更新，立即顯示，不得重新產生讓客服再等一次；
                  對話摘要於此時才補跑（補跑期間標示「更新中」，不得留白）
```

**成本控制的槓桿是節流，不是停跑。** 背景並行上限（`BACKGROUND_CONCURRENCY_LIMIT = 10`）與明顯長於前景的 debounce（背景 8 秒對前景 1 秒，`copilot-analysis.ts`）兩者合起來承擔成本控制；超過上限者只累積訊息計數，待名額釋出或客服聚焦時才處理。

> ⚠️ **不要把背景改回「不跑建議卡、不查知識庫」**（憲法 v3.0.0 已否決）。客服 JOIN 對話 A 後切去
> 回應 B，A 的客戶通常仍在發言，切回時就會面對一批過時建議卡且要從頭再等 5～12 秒。
> **摘要是唯一仍不在背景跑的項目**，理由是它的讀者不在現場。

### 11.3 快取

**沒有結果快取，靠版本錨點判定「同一狀態不重複呼叫模型」**：摘要以 `summaryBlock.summary.basedOnMessageId`、情緒以時間軸高水位找出「尚未涵蓋」的客戶發言，沒有新發言就不排分析（§11.1）；同一區塊在飛時的重複觸發由 `analysis-dedupe.ts` 以 `${conversationId}:${block}` 合併。因此同一狀態重跑不會得到不同結果，「重新產生」按鈕給不出系統做不到的承諾（§19.1 #20）。

### 11.4 訊息型別（多模態）

```ts
// shared/types/conversation.ts

/** ⚠️ `unknown` 是安全預設值：未知的 `from` 前綴一律歸此，不得預設為 `ai`（§19.1 #13） */
export type SenderType = 'customer' | 'ai' | 'agent' | 'unknown'

export interface Message {
  id: string
  conversationId: string
  at: string
  sender: {
    type: SenderType          // ⚠️ 撞單防護與對話分段皆依賴此欄位
    id?: string               // agent 時為 operatorId
    name?: string
  }
  /** 統一的可分析文字：原文或附件描述 */
  text: string
  attachments?: Attachment[]
}

export interface Attachment {
  id: string
  kind: 'image' | 'pdf' | 'file'
  filename: string
  url?: string
  /** 我方產生的文字化內容（vision／文件分析） */
  transcript?: string
  /** transcript 的來源，供成本控制與品質判斷 */
  transcriptSource?: 'platform' | 'ours' | 'none'
}
```

**為何 `sender.type` 是必要的**：撞單防護需區分同事回覆與 AI 自動回覆（§10.4）；對話分段的分界為 `mode` 切換為 `manual` 的時刻；情緒分析只在 `sender.type === 'customer'` **且該訊息含文字**的訊息上產生情緒點（純附件輪不評分，見 §11.5 註解）；客服自己送出的訊息不觸發重新分析（§11.1）。

**附件範圍（依實測樣本，非理論型別清單）**：

| 型別 | 現況 | MVP 範圍 |
|---|---|---|
| `image` | ✅ 有 url；平台未提供描述/OCR；`caption` 樣本皆為空 | **納入**——自建 vision 分析 |
| `pdf` | ✅ 有 url；平台未提供描述/OCR；`caption` 僅客服上傳時有值（=原始檔名），客戶上傳為空 | **納入**——自建 vision／文件分析 |
| `file`（舊資料，非圖片/PDF） | ❌ `content` 只有 `{name, media_id}`，無 url。客戶端上傳介面無法產生此型別，來源待查 | 排除——僅顯示檔名，標示「無法預覽」 |
| 語音 | iMBrace 平台不支援語音訊息 | 排除——無適用對象 |

**處理原則**：① 一律先文字化再進 AI 管線，`Message.text` 是唯一分析輸入；② 文字化結果必須快取，一張圖／一份 PDF 只分析一次，絕不可在每次全量分析時重複送原始檔案給模型；③ `caption`／檔名不可靠——客戶上傳時該欄位目前樣本皆為空，而客戶上傳才是真實場景主力，vision／文件分析是必要的，不是錦上添花；④ 來源固定為我方產生（`transcriptSource` 恆為 `'ours'`）；⑤ 送哪個模型走 §8.2b 的 `AIProvider`，需挑選支援 vision 的 agent；⑥ `content.url` 的時效與存取權限僅少量樣本觀察（皆未加簽章），上線前需更多驗證，否則快取時機點可能抓錯（`IMBRACE_QUESTIONS.md` H-2d）。

> 附件清單的取得**不需要額外端點**——既有的訊息取數路徑（§9.3）過濾 `type ∈ {image, pdf}` 即可。曾發現一個非 SDK 公開的 `/contact/{id}/files` 端點，但範圍是聯絡人層級（所有對話的附件）而非單一對話，**不得**用來當作「這個對話的附件清單」，僅可能用於未來的「客戶歷史附件」功能，詳見 §19.1 #11。

### 11.5 資料契約（前後端共用）

```ts
// shared/types/copilot.ts

/**
 * 情緒單點：每「一輪含文字的客戶發言」產生一點。
 * ⚠️ 客戶該輪若只有附件而無文字，MUST NOT 產生此結構——「上傳檔案」是中性動作，
 * 給定分數會在走勢上拉出與實情不符的轉折（例如客戶正在生氣時出現假性好轉）。
 * 該輪改以下方 `SentimentMarker` 呈現於時間軸，不參與折線與示警判定（規格 FR-012）。
 * 附件仍須文字化並納入摘要卡的事實來源（規格 FR-013，實作延後至 M3，見 §18）。
 *
 * ⚠️ 時間軸的型別**不是**單純的 `SentimentPoint[]`，而是
 * `SentimentTimelineEntry[] = SentimentPoint | SentimentMarker` 的判別聯集（`kind` 為判別欄位）。
 * 純附件輪「存在於時間軸」但「不是分數點」，勉強塞進 `score: null` 會讓消費端
 * （折線邏輯、示警判定、§14.6 的全量統計）到處要多一層 null 檢查。
 */
export interface SentimentPoint {
  kind: 'point'
  messageId: string
  at: string                    // ISO8601
  score: number                 // 0–100，越低越負面
  label: 'calm' | 'neutral' | 'concerned' | 'frustrated' | 'angry'
  drivers: string[]             // 造成此分數的關鍵詞／事件，供人快速理解
}

/** 純附件（無文字）客戶發言的中性標記——不參與折線與示警判定，但 MUST NOT 從時間軸消失（FR-012） */
export interface SentimentMarker {
  kind: 'attachment_only'
  messageId: string
  at: string
}

export type SentimentTimelineEntry = SentimentPoint | SentimentMarker

/** 對話摘要（冷啟動與增量共用同一結構） */
export interface ConversationSummary {
  /**
   * 摘要正文（畫布 2a「對話摘要」的主體）。
   * ⚠️ 選填 —— 見下方「⚠️ narrative／topics 為什麼必須是選填」。
   */
  narrative?: string
  /** 主題標籤（「發票未收到」「地址確認」），最多 4 個、每個 ≤ 16 字。同樣選填 */
  topics?: string[]
  intent: string                // 客戶主要意圖
  keyFacts: string[]            // 已確認的事實（如「已重啟設備 ×3」）
  attempted: string[]           // 已嘗試但無效的處理
  openIssues: string[]          // 尚未解決的點
  riskFlags: Array<'churn' | 'escalation' | 'compliance' | 'vip' | 'repeat_contact'>
  advice: string                // 一句話行動建議
  updatedAt: string
  basedOnMessageId: string      // 版本錨點，用於增量與快取
}
```

> ⚠️ **`narrative`／`topics` 為什麼必須是選填，而且驗不過時要轉 `undefined` 而非拋錯**
>
> 這兩個欄位的**輸出定義寫在 iMBrace 後台 `AgentCopilot_摘要_agent` 的 system prompt 裡，
> 不在這個 repo**（repo 內的 prompt 只有一句「請摘要以下客服對話」＋語言規則）。也就是說
> **一個 repo 外、任何人都能改的設定，決定了這兩個欄位存不存在** —— 標成必填的話，後台一被
> 改回舊版（或模型回了空字串、回了不是陣列的 `topics`）就會整份摘要驗不過 → 摘要區塊轉 `error`。
>
> 因此 `schemas.ts` 讓這兩個欄位走 `z.unknown().transform()`：**任何驗不過的值一律轉成
> `undefined`，不拋錯**；UI 在 `narrative` 缺值時退回以 `intent` 當正文。
> ⚠️ 這與 `intent`／`advice` 用 `.min(1)`（空字串視同分析失敗）**刻意不同** ——
> 那兩個是摘要的主體，沒有它們這份摘要本來就沒有意義；`narrative`／`topics` 是版面的加分項。
>
> ✅ 後台 prompt 目前**確實在回這兩個欄位**（`npm run spike:verify-provider`，`out/16-provider-runs.json`；
> 2026-09-02 重跑 `summarize()` **3/3 帶齊**，實例 `topics=["網路斷線","數據機"]`，
> 長度與張數都在 `SUMMARY_TOPIC_MAX_*` 上限內），不需要去後台補 prompt。
> ⚠️ **這個結論的保存期限取決於 repo 外的設定。** 兩層防護：
> `npm run spike:agent-prompts` 會直接看出摘要 agent 的 `core_task` 少了這兩個欄位的定義
> （1 秒、直接證據）；`spike:verify-provider` 則從輸出反推（它刻意把 `narrative`／`topics`
> 分開計數、不與 `summaryOk` 合併，正是為了讓「欄位安靜消失」現形）。
> 動到摘要欄位、或懷疑正文變短時，**先跑前者**。

```ts
/** 建議回覆卡 */
export interface SuggestionCard {
  id: string
  sopId: string | null          // 必須來自檢索結果，不得杜撰；無引用時為 null
  sopTitle: string | null
  text: string                  // 可直接帶入的回覆全文（繁中、客服語氣）
  /** 0–100；無真實分數來源時為 null，UI 留空不顯示，不得估算填充。見 §11.6② */
  confidence: number | null
  rationale: string             // 為何建議這句（供客服判斷，不隨文字帶入）
  tone: 'apologetic' | 'informative' | 'retention' | 'closing' | 'escalating'
  requiresData: string[]        // 需客服補上的實際資料，如「工單編號」
}

/** 結案摘要（客服按下「結案」觸發——不由對話狀態變更觸發，見 §13.4 ②；經人審後寫入 Data Board） */
export interface ClosureSummary {
  recordId: string              // 主鍵（獨立識別碼）——⚠️ 主鍵不是 conversationId（憲法 5.3）
  draftId: string               // 產生本筆的摘要草稿 id，冪等寫入的依據（憲法 5.3）
  conversationId: string        // ⚠️ 可重複的索引，不是唯一鍵——同一對話會有多筆
  periodStart: string           // 本次涵蓋區間的起點（§13.4 ④）
  periodMessageCount: number | null  // 本次涵蓋的訊息則數。⚠️ null ＝ 超過 500 則的掃描上限、數不完（**不是 0 則**）
  /** 這個 periodStart 是怎麼來的。⚠️ 光靠時間戳事後分不出「選了某次結案」與「客服自己打的時間」 */
  periodOrigin: 'closure' | 'first' | 'custom'
  channel: string
  contactId: string
  operators: string[]
  joinedAt: string              // 對應 Board 的 joined_at
  closedAt: string              // 對應 Board 的 closed_at
  summary: string
  intent: string
  category: string              // 受控詞彙，見 config/categories.ts

  // ── 以下三項對應介面上的三個標籤（意圖／處理結果／情緒結果）──
  resolution: 'resolved' | 'workaround' | 'escalated' | 'unresolved' | 'customer_abandoned'
  /** 實際採取的行動，與 resolution（狀態）分開。如「已建立工單」「已派工」 */
  actionsTaken: string[]        // 受控詞彙
  /** 情緒結果的語意標籤，供介面直接顯示 */
  sentimentOutcome: 'appeased' | 'satisfied' | 'still_negative' | 'escalated'

  /*
    ── 數值供報表統計使用，不直接顯示於介面 ──

    ⚠️ **四個數值欄一律 `number | null`**（specs/006 FR-022b）。
       非 nullable 的型別會逼實作者在「區間內評分點不齊」時填 0，而那正是 FR-022b
       逐字禁止的事 —— 且填了 0 之後**不會有任何錯誤**，只會讓報表把留空當成最低分。
       實測未設定的 `Number` 欄位回讀為 `null`，與 `0` 明確可分（`spike:board-write` 006-E4），
       因此「留空」的表達方式是**不送該欄位**。
    ⚠️ 三個 sentiment 值 MUST **同時**有值或**同時**為 null，部分有值是實作錯誤。
  */
  sentimentStart: number | null
  sentimentEnd: number | null
  sentimentTrough: number | null  // 本次涵蓋區間內的最低點——不可只取 sparkline 繪出的最近 N 點，也不可跨越區間邊界取到前幾輪服務的谷底（§13.4 ④、§14.6）
  /** 情緒留空的原因與實際涵蓋範圍。有值即代表上面三個是 null。對應 Board 的 period_sentiment_note */
  sentimentNote: string | null

  citedSopIds: string[]
  followUps: Array<{ action: string; owner?: string; dueHint?: string }>
  confidence: number | null      // 無真實依據時為 null（憲法 4.4）
  reviewedBy: string | null     // 未經人審為 null
  reviewedAt: string | null
}
```

### 11.6 Prompt 設計四條硬規則

**① 建議卡的 `sopId` 不得杜撰。** 流程必須是：檢索知識庫 → 將 `KnowledgeHit[]` 作為上下文提供給模型 → 要求 `sopId` 只能自 hits 的 id 中選擇 → 後端再驗證一次，不在白名單者直接丟棄該卡。僅靠 prompt 交代是不夠的，必須有程式層的後驗。

⚠️ **前景建議卡是兩段式（004），「先檢索、再生成」不是唯一的流程形狀。**
第一段**不等檢索**、以空的 `knowledgeHits` 先生成一批可用的卡（白名單集合為空，因此任何帶
`sopId` 的卡都會被整卡捨棄——本條規則在第一段是**更嚴格**地成立）；檢索有命中時，第二段
以那批命中**重新生成整批**並自動換上。⚠️ 第二段是「重新生成」而**不是**為第一段的卡補掛來源——
補掛會讓卡片文字與來源的因果關係是假的（那批文字生成當下並沒有看過任何 SOP），
正是憲法 4.5 要防的事。白名單集合一律是**該次呼叫當下傳入的 hits**，兩段各驗各的。

**② `confidence` 不得由模型憑空給定，沒有真實依據時必須是 `null`，不得估算填充。** 有檢索分數時應為 `confidence = f(檢索分數, 模型自評, 上下文完整度)` 並於後端校準。若 `KnowledgeHit.score` 為 `null`（目前的 iMBrace 路徑就是如此），`confidence` 必須整體為 `null`，不得用模型自評頂替。UI 依此欄位是否為 `null` 決定顯示或留空——這讓 AI 來源從 iMBrace 換成 viki（`answer-attribution` 提供真實分數）時，`confidence` 自然開始出現數值，不需要另外改介面。**寧可留空，也不要顯示一個沒有依據的數字**——信心度一旦失準，客服很快就會學會忽略它，整個功能即告廢棄。

**③ 增量分析回傳 patch，不回傳全量。** 送 `previousSummary + newMessages`，要求僅回傳變動欄位，除了省 token，也避免摘要每次被整段重寫導致畫面一直跳動。

**④ 事實不得推測。** 明確禁止模型編造工單編號、時間、金額、政策內容。`requiresData` 欄位即為此設計：模型察覺自身缺乏資料時應標示出來，交由客服填寫。

### 11.7 其他約束

- 全部使用 **structured output / tool use**，**絕不解析自由文字**
- 所有輸出以 **Zod schema 驗證**後才進入系統
- `category` 使用**受控詞彙**（`config/categories.ts`），不得由模型自由生成
- 輸出語言為繁體中文，語氣須符合客服規範
- 溫度設低（建議 0.2–0.3）

### 11.8 情緒面板已知限制

三項限制，**性質不同因此拆開處置** —— 包成一包會讓已經有結論的那一項永遠看起來像沒做完：

| # | 是什麼 | 處置 |
|---|---|---|
| ① 冷啟動只看最新 50 則 | 功能缺口（與 FR-001「完整歷史」的字面有落差） | **與 ③ 合併立案**，獨立追蹤、不阻擋里程碑開工 |
| ② 情緒批次大小是機率賭注 | **不是待辦** —— 使用者早已拍板接受 | **已接受的取捨**，見下方 |
| ③ 分析結果沒有真正持久化 | 需要先拍板保留期限（隱私姿態） | 同 ① |

⚠️ ①③ 歸在**決策批次**而非驗收清單：要先拍板（隱私姿態）才動得了。

**① 冷啟動只看得到最新 50 則訊息，未涵蓋「完整歷史」**——`join.post.ts` 的 `fetchLatest()`
不帶 `limit` 參數，預設只抓最新 50 則（`DEFAULT_MESSAGE_LIMIT`）。對話可長達 398 則
（§9.3 實測上限），超過 50 則的對話，摘要卡與情緒走勢實際上看不到更早的內容，與
FR-001「依該對話當下的**完整歷史**」的字面要求有落差。客服在畫面上手動「載入更多訊息」
（`useConversationView.ts` 的 `loadOlder()`）純粹是給訊息流顯示用，**不會**回頭觸發分析——
`GET /api/messages` 端點對分析管線沒有任何副作用。

**② 情緒分析批次大小是機率賭注，非保證值 —— ✅ 已接受的取捨，不是待辦。**
真實對話 16 則客戶發言，單次呼叫（不分批）實測延遲 12.7～29.9 秒，遠超 FR-014 的 15 秒單次
逾時。已改為每批固定 6 則（`SENTIMENT_CHUNK_SIZE`），但延遲不是單純隨則數線性增加、平台本身
有明顯波動 —— 4 則批次 3 次都在 8.5～9.7 秒，6 則批次量到 10.0～**18.6 秒**（超過 15 秒門檻），
8 則批次曾連續三次嘗試全部逾時。**沒有一個批次大小能保證「絕對不逾時」；已決定接受「偶爾需要
客服手動重試」這個下限，6 是取捨後的中間值。**

> ⚠️ **再談批次大小時 MUST 用新的成本模型。** 「切小＝總時間變長」這個直覺已經失效 ——
> 批次改為有上限的並行（`SENTIMENT_CONCURRENCY`）後，總耗時隨 ⌈批次數 ÷ 並行度⌉ 而非批次數。
> 「批次越小、單次逾時機率越低」不變，因此「6」這個取捨的依據仍然成立。

**③ 分析結果沒有真正持久化，無法跨客服／跨伺服器重啟共用**——`CopilotAnalysisState`
（`server/state/memory-store.ts`）目前是記憶體 + 2 小時滑動 TTL，設計目的是「客服切換
對話框回來還看得到既有結果」（FR-010），不是永久保存。這代表：同一個對話換一位客服
JOIN，即使訊息內容完全沒變，也會觸發全新的冷啟動分析——重複耗用 AI 呼叫，且以
messageId 為粒度都是重算，不是只算真正新增的部分。

> ⚠️ 伺服器重啟後的空白面板是**另一件事，且已修**（`sendAnalysisSnapshotAndResume()` 對已 JOIN
> 的連線補跑 `recoverColdStart()`，見 §18 M2「已修的缺陷」）。本項是持久化，不是復原。

**①③ 的立案內容**：
把情緒評分點（含摘要所依賴的歷史）以 messageId 為 key 做真正的持久化快取，會同時讓
「冷啟動不受 50 則上限限制」（未涵蓋的舊訊息判斷為「尚未分析過」即可依需要補做分析，
而非整段重來）與「跨客服／跨重啟不必重算已分析過的訊息」一起成立。範圍不小——需要新的
持久化層（`server/state/types.ts` 已預留 M4 Redis 的介面設計方向，但 Redis 目前完全未建置）、
重新設計資料粒度（現在是「一個對話一份 JSON」，需要改成「以訊息為單位」），且情緒
評分的 `drivers` 欄位本質是客戶原話摘出的關鍵詞（憲法 1.5 適用範疇）——**現行 2 小時
TTL 某種程度上是天然的資料最小化，改成永久持久化是刻意的隱私姿態改變，需要明確拍板
保留期限，不能當作單純的效能優化順手做掉**。

⚠️ **立案範圍只有 ①③。MUST NOT 因為 ② 同處一節就把它一起拉進來重議** —— 它是已拍板的取捨。

---

## 12. 知識庫

### 12.1 現況

iMBrace SDK 文件中沒有 Knowledge / DocIQ 的查詢 API——`reference/` 底下僅有 ai-agent、workflow、board、campaign、communication、channel、contact；`sdk/document-ai/` 是抽取導向（`processDocument()` 從 PDF 抽結構化欄位），非檢索導向，無語意搜尋、無章節 ID、無信心度。而建議卡上「SOP 3.2 安撫圓場｜信心度 92%」這種呈現，必須有能回傳條目 ID 與分數的檢索 API 才能實現。

### 12.2 因應方式

架構上以 `KnowledgeProvider` 隔離（見 §8.2）。**候選路徑（`AgentKnowledgeProvider` 為現行實作，其餘為備援）**：

| 路徑 | 狀態 | 說明 |
|---|---|---|
| 掛 Knowledge Hub 給 AI Agent 再問它 | ✅ **採用** | 平台已有 311 個 RAG 檔案、20 個 Knowledge Hub。可取得引用來源，但取不到分數（§0-3c 仍待 iMBrace 回覆） |
| `VikiKnowledgeProvider` | 🟡 介面已預留，未實作 | viki 前端先建好知識庫與 AI 助理後，打其 public API 即可取得回覆，`answer-attribution` 附帶真實分數。⚠️ **2026-09-07 決策：暫不換入**，且與 0-3f 的回覆脫鉤（見 §18 M3 驗收第一條） |
| `boards.search(boardId, {q, filter, limit})` | 🟡 備案，未採用 | Meilisearch 相容關鍵字檢索，有條目 ID，屬關鍵字非語意 |
| `MockKnowledgeProvider` | ✅ 開發期 | 缺憑證／agent id 時自動退回並印警告，僅供本機開發（`server/services/knowledge/index.ts`） |
| ~~`StaticSopProvider`~~ | ❌ 已撤銷 | 原規劃讀 `config/sop.yaml`；2026-08-28 由 002 決定不做，離線 fallback 由 `MockKnowledgeProvider` 承擔 |
| ~~自建向量檢索~~ | ❌ 已排除 | 依賴的 `ai.embed()` 回 404 |

無論分數取不取得到，介面上的「信心度」欄位都不拿掉——`KnowledgeHit.score` 與 `SuggestionCard.confidence` 皆為 nullable，iMBrace 路徑無分數時 UI 留空，換上 viki 後自然回填有值（見 §8.2、§11.6②）。但**引用來源不可省**（指「來源真實存在、可白名單核對」，不是要顯示一套正式編號——iMBrace 沒有 SOP 編號制度，介面僅顯示來源標題，見 §8.2），否則憲法 4.3（`sopId` 白名單後驗）失去依據，模型將可能杜撰不存在的 SOP，此為產品品質的底線。無論最終選哪一條，替換 provider 即可，上層不動。

### 12.3 知識庫快查 UX

依 `demo_agentCopilot02.png`，快查是**右欄中的常駐 inline 面板**，而非彈出式 Command Palette：

```
┌─────────────────────────────────────────┐
│  知識庫自然語言快查                       │
│  ┌───────────────────────────────────┐  │
│  │ 🔍 訊號異常代碼 重複斷線           │  │
│  └───────────────────────────────────┘  │
│  訊號強度異常代碼對照表          2026/05 │
│  重複斷線客訴優先工單建立流程    2026/03 │
└─────────────────────────────────────────┘
```

**採 inline 而非 modal 的理由**：客服不需離開對話視線即可查詢，modal 會遮蔽訊息流與建議卡。

**設計要點**：結果顯示 `title` + `updatedAt`，不顯示分數（分數只用於排序）、**不顯示獨立編號**（§8.2）；條目過舊（建議門檻 12 個月）標示提醒，`updatedAt` 為 `null` 時不觸發此提醒；結果可「插入為回覆」或「展開全文」；輸入需 debounce（建議 300ms）。

**第一版只做 inline 面板。** `Ctrl/Cmd + K` 的 Command Palette 可作為後續增強，非必要功能。

### 12.4 知識庫快查已知限制

三項刻意不解決的限制，比照 §11.8 的做法留待後續評估：

**① `RAGknowledge` 工具回傳的是未結構化的 chunk 拼接字串，不是逐筆命中陣列。** §8.2 的
`KnowledgeHit[]` 介面草案假設平台會回傳結構化陣列；實測（`scripts/spike/out/11-宏宏企業-knowledge-raw.json`）顯示 `tool-output-available` 的 `output.result` 是單一字串，多筆命中以重複的
`[Source: 檔名]` 標記串接。`AgentKnowledgeProvider` 需自行正則切分，每個 `[Source: X]` 段落視為
一筆 `KnowledgeHit`。詳見 `specs/002-suggestion-knowledge-search/research.md` #1。

**② 知識庫檔案沒有「最後修改時間」中繼資料，也沒有正式的 SOP 編號制度。** `folder_info` 裡的檔案
清單只有 `id`／`name`，`remarks` 恆為 `null`；檔名本身可能含日期片段（如 `_V1_20250925_`）但這是
啟發式擷取，不是平台保證欄位。`KnowledgeHit.updatedAt` 因此是 `string | null`，擷取不到時前端
顯示「更新日期未知」而非觸發過舊提醒。**介面不顯示獨立的「編號」欄位**（§8.2）。
編號制度已列 `IMBRACE_QUESTIONS.md` 0-3g。詳見
`specs/002-suggestion-knowledge-search/research.md` #2、`spec.md` Assumptions。

**②-1 兩條會靜默出錯的解析規則（已實作並有測試，不要改回去；重新取樣跑 `npm run spike:contract`）**：
① **檔名的版本片段大小寫混用** —— 同一個資料夾的 9 個檔案裡有 2 個寫成小寫 `_v1_20200926_`
（分隔符也從 `-` 換成 `_`）。擷取正則 MUST 不分大小寫，否則那些檔案會靜默拿到
`updatedAt: null`、標題還留著版本後綴。
② **agent 可能先呼叫 `folderContentsTool` 再呼叫 `RAGknowledge`**，同一條 SSE 因此會出現
**兩個 `tool-output-available`**，第一個沒有 `result`／`folder_info`。MUST 靠
`toolCallId → toolName` 對照表反查（事件本身不帶 `toolName`）；取「第一個」會靜默解析出空結果。

**②-2 檢索本身需要 9～23 秒（且量到一次逾 30 秒），而且能不能檢索取決於「模型 ＋ prompt 措辭」兩個條件。**
兩件事分開講：

*能不能檢索*：`google.gemma-3-27b-it` 這類沒有原生 function calling 的模型**不論 prompt 怎麼寫
都不會真的呼叫 `RAGknowledge`**，只會把工具呼叫當文字印出來（```` ```tool_code ```` 區塊或
`<thinking>` 敘述），SSE 裡完全沒有 `tool-output-available`，於是快查恆為 0 命中且不報錯。
即使換上支援的模型（`us.amazon.nova-pro-v1:0`、`qwen.qwen3-32b-v1:0`），**命令式的 prompt
（「請在知識庫中搜尋…最相關的段落」）一樣會讓模型去描述工具呼叫而非執行**——改成自然提問
（「請查詢知識庫回答下列問題，並在回答最後列出你參考了哪些文件」）才會真的呼叫。
⚠️ 後者是**我方程式碼的缺陷**，不是平台設定問題，措辭寫死在 `buildKnowledgePrompt()`
並附有「改動前必須重測」的警語。

*要多久*（`us.amazon.nova-pro-v1:0`，兩組量測）：

| 量測 | 樣本 | 區間 | 30 秒涵蓋率 |
|---|---|---|---|
| `spike:knowledge-latency`（合成查詢） | n=12 | 9370～20080ms、中位 11907、p90 16929 | 12/12 |
| `spike:progressive`（004 T032，4 段真實對話） | n=10 | 13.9～**22.9 秒**、中位 18.4 秒 | **9/10** |

⚠️ **以真實對話那組為準**：`KNOWLEDGE_SEARCH_TIMEOUT_MS` 會真的觸發，這不是理論上的可能性。
同組織不掛知識庫的 agent 單純回一句話只要 2.6～3.8 秒，所以慢的是檢索而非推論；8 秒則 **0/12** 命中。
逾時當下的降級行為經實測**完全正確**：建議卡序列仍是 `analyzing → ready/pending → ready/none`，
`status` 維持 `ready`、第一段的卡照常可用，沒有轉 error（004 FR-003／002 FR-004）。
⚠️ 但 002 SC-002b 的「100% 在 35 秒內落定」在現行平台**已有反例**：逾時那次落定於 30.0 秒
仍在 35 秒內，那是因為逾時上限恰好擋住了它 —— **若上限放寬，那一次會超出**。

⚠️ **快查與建議卡 MUST 共用同一個 `KNOWLEDGE_SEARCH_TIMEOUT_MS = 30_000`，不要再給建議卡
另立短逾時。** 曾以「建議卡是串行流程、受 SC-001 門檻約束」為由立過 8 秒版本，而上表證明
**8 秒在生產路徑上 100% 逾時** —— 它的實際效果是「建議卡永遠拿不到引用」，不是保護門檻。
004 把建議卡改成兩段式後檢索不再擋在生成前面，30 秒可以承受；該常數已刪除，並由
`test/contract-guards.test.ts` 守著防止復活（連 `= KNOWLEDGE_SEARCH_TIMEOUT_MS` 的別名也不行
—— 別名日後照樣會被改成別的數字）。延遲本身仍列在 `IMBRACE_QUESTIONS.md` 0-3h。

**③「展開全文」無法保證涵蓋整份文件。** 平台沒有獨立的「取得檔案完整內容」端點，`RAGknowledge`
即使把 `document_file_ids` 限定為單一檔案，回傳的仍可能只是該檔案內 top-K 相關片段，不是全文。
MVP 做法是把限定檔案後拿到的所有片段依序串接顯示，並誠實標示「本次可取得的相關內容，可能未涵蓋
完整文件」，不宣稱是真正的全文。詳見 `specs/002-suggestion-knowledge-search/research.md` #3。

---

## 13. Data Board 持久化與結案摘要

### 13.1 分層原則

> **Data Boards 是 CRM 資料庫，不是低延遲 KV。高頻寫入會出問題。**

| 資料 | 存放位置 | 理由 |
|---|---|---|
| Session 狀態、輪詢游標、presence | 記憶體 → Redis | 高頻讀寫、可重建、重啟即棄無妨 |
| 情緒逐輪分數（進行中） | 記憶體 → Redis | 每則訊息都在變，寫 Board 會打爆 API |
| **結案摘要** | **Data Board** | 業務資產，需可查詢與製作報表。交接摘要不存在（未實作，§13.4 ②） |
| 建議採納紀錄、SOP 命中 | Data Board（可延後至 M4+） | 供後續模型優化回饋 |

### 13.2 可用的 Board API

```
boards.create() / createField() / bulkUpdateFields()   # 定義 schema
boards.createItem() / updateItem() / getItem()          # 記錄 CRUD
boards.listItems() / search()                           # 查詢
boards.createSegment()                                  # 儲存篩選視圖
boards.exportCsv()                                      # 報表匯出
boards.linkItems()                                      # 關聯至 Contact
```

### 13.3 Board Schema：`AgentCopilot_ClosureSummary`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `record_id` | text（**主鍵**） | 獨立識別碼。⚠️ 主鍵**不是** `conversation_id`（憲法 5.3） |
| `draft_id` | text | 產生本筆的摘要草稿 id，**冪等寫入的依據**（同一份草稿至多一筆） |
| `conversation_id` | text（**可重複的索引**） | 用途是查出「這通對話歷來的所有結案紀錄」，不是唯一鍵 |
| `period_start` | datetime | 本筆涵蓋區間的起點 |
| `period_message_count` | number | 本筆涵蓋的訊息則數。⚠️ 與 `period_start` 一起，是事後唯一能看出「這份報告涵蓋了什麼」的依據。**留空 ＝ 超過 500 則的掃描上限，不是 0 則** |
| `period_origin` | select | `closure` / `first` / `custom` —— 這個起點是怎麼來的。⚠️ 光靠 `period_start` 事後分不出「客服選了某次結案」與「客服自己打了一個時間」，而那是完全不同的兩件事 |
| `channel` | text | LINE / Web / WhatsApp… |
| `contact_id` | text | 可 `linkItems()` 關聯至 Contact board |
| `operators` | text[] | 參與過的所有客服 |
| `joined_at` / `closed_at` | datetime | |
| `summary` | long text | |
| `intent` | text | |
| `category` | select | 受控詞彙 |
| `resolution` | select | resolved / workaround / escalated / unresolved / customer_abandoned |
| `actions_taken` | text[] | 受控詞彙。**與 `resolution` 分開**——前者是做了什麼，後者是結果狀態 |
| `sentiment_outcome` | select | appeased / satisfied / still_negative / escalated |
| `sentiment_start` / `sentiment_end` / `sentiment_trough` | number | 供報表統計，不直接顯示於介面。⚠️ **留空 ＝ 區間內評分點不齊，不是 0 分**（實測未設定的 Number 回讀為 `null`，與 0 可分）。三者 MUST 同時有值或同時留空 |
| `period_sentiment_note` | text | 情緒留空的原因與實際涵蓋範圍。有值即代表上面三欄是留空 |
| `cited_sops` | text[] | |
| `follow_ups` | long text（JSON） | |
| `confidence` | number | 留空 ＝ 無真實依據（憲法 4.4）。⚠️ 結案摘要沒有檢索分數可依據，目前恆為留空 |
| `reviewed_by` | text | 未經人審為空 |
| `reviewed_at` | datetime | |

> 欄位需先透過 `createField()` 在平台上建立。✅ 已落地為 `scripts/setup-closure-board.ts`
> （`npm run board:setup` 建立／補欄、`npm run board:verify` 只比對且有落差即非零離開）。
> ⚠️ 欄位 id **MUST 由 `boards.get()` 反查**，MUST NOT 取 `createField()` 的回傳值 ——
> SDK 註解寫著它「直接回傳 field」，實測回的是**整個 board**；照它做的話所有欄位
> 共用同一把 id、寫入互相覆蓋，而**平台照樣回 200**（`spike:board-write` 006-E2a）。
>
> ⚠️ 本表與 §11.5 的 `ClosureSummary` 必須逐欄對得上——少建一欄不會報錯，只會讓該維度在報表裡永遠是空的。

**欄位對照**：`operators`／`summary`／`intent`／`category`／`resolution`／`actions_taken`／`sentiment_outcome`／`sentiment_start|end|trough`／`cited_sops`／`follow_ups`／`confidence`／`reviewed_by|at` 一一對應 `ClosureSummary` 的同名欄位（camelCase → snake_case）；`joined_at`／`closed_at` 對應 `joinedAt`／`closedAt`。

⚠️ 本表、§11.5、`shared/types/copilot.ts` 的 `ClosureSummary`、`server/services/closure/board-schema.ts` 是**同一份事實的四個副本**，改任一處 MUST 四處同步——`npm run board:verify` 只能抓平台與 `board-schema.ts` 的落差，抓不到文件與型別。四個數值欄 MUST 保持 `number | null`：非 nullable 會逼實作者填 0，報表會把「留空」讀成「最低分」，且不會報錯。

### 13.4 四個設計陷阱

**① AI 產物寫入正式 CRM，必須經人審。** 摘要生成後先進入可編輯的確認面板，客服修改確認後才 `createItem()`（憲法 5.1）。若確實需要自動寫入，必須標記 `reviewed_by = null`，使其可於事後被稽核篩出（憲法 5.2）。⚠️ **目前沒有任何自動寫入路徑**，`specs/006-closure-handoff-summary` 不交付這種路徑。

**② LEAVE ≠ 結案 —— 但交接摘要目前不實作。** 立論仍然成立：多客服情境下，你 LEAVE 了但其他人仍在，那一段服務值得留點東西給下一位。原本因此規劃兩種產出：

| 類型 | 觸發 | 內容 | 狀態 |
|---|---|---|---|
| 交接摘要 | LEAVE | 我這段處理了什麼、下一位要接什麼——對話仍進行中 | ❌ **不實作**（無型別、無端點） |
| **結案摘要** `ClosureSummary` | 客服按下「結案」（**只有**這一種觸發） | 完整的意圖／分類／處理結果／情緒起訖／後續動作 | ✅ 由 `specs/006-closure-handoff-summary` 交付 |

> ⚠️ **交接摘要確認不實作**（2026-09-03，`specs/006-closure-handoff-summary`）。理由是**它沒有設計落點** ——
> 畫布 artboard 2a／`DESIGN_TOKENS.md` §7.2 的右欄六個區塊沒有它，結案流程的三張設計稿沒有它，
> i18n 與元件裡沒有任何「交接／轉接」字串。它只曾存在於本文件的紙上規劃。
> `PLATFORM_CAPABILITY.md` §2 那列「AI 轉接摘要／左欄」是 **demo 畫面上 iMBrace 平台自己的功能**，不是我方的 Copilot 面板。
> **重啟條件**：畫布補上該區塊，或出現實際的多客服交接需求。
> 在那之前「離開對話」＝純粹退出，不產生摘要、不寫入任何紀錄。

> 「結案」不限於獨立的結案按鈕——也可以是 LEAVE 流程中「同時結束對話」的選項。無論哪種 UI 呈現，只要目的是結束本次服務並留下結案紀錄，就走同一條結案路徑與同一份 `ClosureSummary` schema。
>
> ⚠️ **結案不變更平台上的對話狀態，也不由狀態變更觸發**（2026-09-03 裁決）。觸發條件**只有**客服按下「結案」；寫入 Data Board 成功後的最後一步**只是 LEAVE**（與「離開對話」相同的呼叫），對話在平台上的狀態維持原樣。MUST NOT 改成 `updateStatus() → resolved`：
> 理由：改對話狀態的能力已由 spike 28（`scripts/spike/28-delete-conversation-permission.ts`）實測存在，但可改的狀態有多種，
> 「結案應對應哪一種」尚未討論，貿然選一種會在平台端留下不可逆的狀態。整項延後另議（`specs/006-closure-handoff-summary` Clarifications）。

**③ 冪等的單位是「摘要草稿」，不是對話（憲法 5.3，v4.0.0）。** 同一份草稿寫入幾次都只對應一筆（防的是「寫入逾時後客服重按」）；除此之外的每一次結案各自**並存**。主鍵是 `record_id`，`conversation_id` 是可重複的索引。

平台不保證唯一鍵約束（實測 5 個 board 未見唯一鍵欄位型別，`scripts/spike/out/09-board-field-types.json`），因此流程是：**寫入前以 `draft_id` 查詢 → 決定 `createItem` / `updateItem` → 寫入後回查確認該筆確實存在**。⚠️ 最後那一步不可省——收到 200 不等於紀錄真的建立了，而「畫面顯示成功、Board 上其實沒有」是不會報錯的。

> **同一通對話有多筆結案紀錄是正常的**，成因有兩種：① 不同時間的多次服務（同一位 LINE@ 客戶的聊天室長期存在）；② 同一次服務、多位客服交叉服務或中途轉手，各自寫一份。MUST NOT 改成「覆蓋而非新增」——那會在①銷毀服務歷史、在②洗掉同事的工作成果。

**④ 一筆結案紀錄只描述「一次服務」，區間 MUST 隨紀錄寫入。** 一個對話（例如 LINE@ 的一位客戶）是長期存在的，可能被服務過很多次。`summary`／`intent`／`sentiment_start|end|trough` 全部只在同一個涵蓋區間內才有意義。

該區間**由客服在人審面板上選定**，候選是該對話最近 5 筆結案紀錄的 `closed_at`（每一筆代表「上一輪服務在此結束」），外加墊底的「從第一則對話起算」。⚠️ **三種自動推導方式都試過、都會出錯**，不要重新提案：

| 推導方式 | 反例 |
|---|---|
| 客服自己的 JOIN 時間 | 同一次服務的多位客服 JOIN 時間不同，會產出不同區間；且客戶通常在客服 JOIN 前就已把訴求講完 |
| 時間間隔（gap）門檻 | 客戶昨天 17:35 發言、今天 10:15 才有客服接手（空檔 16 小時 40 分）仍是同一區間。門檻訂 24 小時對、訂 12 小時錯，而該值無法從證據推導 |
| 客戶那一輪發言的第一則 | 客服回過話但**沒有結案**時，客戶隔天追問仍屬同一輪，此規則會誤切成新一輪 |

`closed_at` 之所以是對的：**「有沒有結案」本身就是「上一輪有沒有結束」的定義**，是事實而非推測。詳細行為見 `specs/006-closure-handoff-summary` FR-021 系列。

---

## 14. UI 與設計系統

### 14.1 佈局

加上側欄後為三欄結構：

```
┌────────┬──────────────────────┬─────────────────────┐
│ Sidebar│   對話視窗（中欄）     │  Copilot 面板（右欄）│
│        │                      │                     │
│ 對話   │  PresenceBar         │ ① 客戶情緒提示       │
│ 列表   │  ─────────────       │  ─────────────      │
│        │  MessageList         │ ② AI 語意即時建議    │
│ 已JOIN │  （虛擬滾動）         │  （建議卡 ×N）       │
│ 徽記   │                      │  ─────────────      │
│        │                      │ ③ 知識庫自然語言快查 │
│        │  ─────────────       │  ─────────────      │
│ 可收合 │  Composer            │ ④ AI 階段對話紀錄    │
│        │  （送出前撞單檢查）    │  ─────────────      │
│        │                      │ ⑤ 結案摘要自動填入   │
└────────┴──────────────────────┴─────────────────────┘
         ↑ 可拖曳調寬 ↑        ↑ 可拖曳調寬 ↑
```

- Sidebar 可收合；中／右欄之間可拖曳調寬（不同客服對「對話 vs 建議」的比重偏好差異很大）；右欄可暫時全屏（閱讀長 SOP 時需要）；分欄寬度存於 `localStorage`

> 右欄的六個區塊以 §14.1.1 為準，本圖與該節必須一致。**「AI 轉接摘要」不在右欄**——依 demo 對照它屬於左欄（見 `PLATFORM_CAPABILITY.md` §2）。
>
> 右欄現已有正式設計稿（畫布 artboard **2a**，逐字規格見 `DESIGN_TOKENS.md` §7）：展開態寬度 **420px**（可拖曳 320–720px）、支援載入骨架與「準備結案」態。⚠️ **一般狀態是五個區塊**（①～⑤）；第六區塊「結案摘要自動填入」只在結案流程中出現，見 §14.1.1。
>
> ⚠️ **右欄的可見性不是「永遠都在」。**
> 依 `specs/003-analysis-trigger-policy`，**客服未 JOIN 該對話時右欄整欄不呈現**（連收合鈕一起消失），
> 中欄延伸至可用寬度；JOIN 時自動展開並提供收合鈕，收合狀態以「每位客服、每個對話」為粒度
> 存 `localStorage`。伺服器端亦不把三個分析事件推給未 JOIN 的連線。
> 規則見該規格 FR-016～FR-017b，視覺見畫布 artboard **1c** 的「未接手」與「Copilot 面板收合」兩個狀態
> （`DESIGN_TOKENS.md` §0 的 1c 狀態表）。⚠️ 備存截圖已於 2026-09-03 刪除，不要再用檔名引用畫面。

### 14.1.1 右欄的區塊與捲動

依 `demo_agentCopilot02.png`（後由畫布 artboard 2a 確認，見 `DESIGN_TOKENS.md` §7.2），右欄自上而下共**六個區塊**，依處理中的使用頻率排：① 客戶情緒提示（處理中最常看）② **對話摘要**（接手前必讀）③ AI 語意即時建議（處理中最常用）④ 知識庫自然語言快查（隨時可能用）⑤ AI 階段完整對話紀錄（可折疊，偶爾回顧）⑥ 結案摘要自動填入（只在結案時使用）。

> ⚠️ **⑥ 的「只在結案時使用」是硬性的 —— 未進入結案流程時 MUST 完全不呈現該區塊。**
> 兩個理由：① 常駐會讓「這個區塊」與「結案按鈕」的關係曖昧不明；② 區塊若常駐就得在某個時機
> 產生內容，等於每個對話都多跑一次 AI 呼叫，而絕大多數對話不會在那一刻結案。
> 結案流程本身屬 M3，行為定案見 `specs/003-analysis-trigger-policy` 的「Session 2026-08-28 補充」
> 與 `tasks.md` 附錄；視覺見畫布 artboard **1c** 的「結案中」狀態與 artboard **2b**（結案摘要區塊的狀態矩陣）。

**摺疊行為**：畫布採「區塊可折疊」**加**「階段感知」的組合，不是兩者擇一 —— 各區塊平時各自可
折疊；一旦進入結案流程，⑥ **移到面板最上方**並展開可編輯，其餘區塊**全部**收合成單行。
逐項行為見 `DESIGN_TOKENS.md` §7.4。

> ⚠️ **⑥ 是置頂，不是「收合其他區塊讓它顯眼」**（使用者裁示，與 `DESIGN_TOKENS.md` §7.2「`order` 由階段決定」一致）。
> 既然 ⑥ 平時完全不呈現，它出現時就是一個憑空冒出來的新元素，置頂才不會讓人在面板中間找它；
> 「靠收合其他區塊」預設了 ⑥ 本來就在原位，前提不成立。

折疊狀態是否記憶到 `localStorage` 設計稿未規範，仍是開發端判斷。

### 14.1.2 AI 階段完整對話紀錄

此區塊將 JOIN 之前 AI 與客戶的往來以高密度形式呈現，供客服快速回顧。標題列顯示總則數（可折疊）；每則標示發送者（客戶／AI／客服），依 `Message.sender.type` 判斷；附件呈現：`image`／`pdf` 顯示縮圖或檔案圖示＋vision／文件分析產生的描述（`caption` 不可靠，見 §11.4），舊資料型 `file` 僅顯示檔名＋「無法預覽」，語音無適用對象；此區塊與中欄訊息流資料來源相同，僅呈現密度不同，不需額外 API。

> ⚠️ **不可用 JOIN 時間點做「AI 階段 / 真人階段」的分段。** JOIN 之後 AI 仍持續運作（見 §10.5），真正的分界是 `mode` 切換為 `manual` 的時刻。**正確做法**：以每則訊息各自的 `sender.type` 標示，時間分段僅作為輔助視覺提示。

### 14.2 多對話切換

側欄列出所有已 JOIN 的對話，每個都有獨立 `CopilotSession` 在背景運作；未聚焦的對話若有新訊息或情緒惡化，顯示徽記提醒；背景對話重算情緒與建議卡但不重算摘要，且受並行上限與較長 debounce 節流（見 §11.2、憲法 6.2）。

#### ⚠️ 切換對話會讓整個對話頁 remount —— 任何「跨對話應該不變」的 UI 狀態不能放元件內

`<NuxtPage>` 預設的 key 是**把路由參數代入後的路徑**（Nuxt 的 `generateRouteKey` →
`interpolatePath`，見 `node_modules/nuxt/dist/pages/runtime/utils.js`）。因此 `/c/A` 換到
`/c/B` 就是換了一個 key：`pages/c/[conversationId].vue` 連同它底下的左欄、中欄、右欄
**整棵 unmount／remount**，元件內的 `ref` 一律回到初始值。

2026-09-01 實機驗收因此發現一個症狀完全不像路由問題的 bug：**左欄收起某一天的日期區間後，
點另一則對話，收起來的區間全部彈開**。收合邏輯本身沒有錯，是整個左欄被重建了。

判斷準則：**這個狀態是「這一次使用」的，還是「這一個對話」的？**

| 狀態 | 該放哪 | 已有的例子 |
|---|---|---|
| 跨對話應保持（這一次使用） | 模組層 `ref`（重新整理歸零）或 `localStorage`（跨 session） | 日期區間收合（模組層，`Sidebar.vue` 檔首）；左右欄寬與收合（`localStorage`） |
| 每個對話各自一份 | 元件內 `ref` —— remount 正是它要的行為 | 草稿、Copilot 面板狀態、SSE 訂閱 |

⚠️ **不要用 `definePageMeta({ key })` 去阻止 remount。** 那會讓上表第二列的狀態全部跨對話
殘留（切到別的對話還看得到上一則的草稿），代價遠大於它解決的問題。
`test/sidebar-group-collapse-persist.test.ts` 同時守著這兩件事。

### 14.3 設計基調

參考 `docs/demo_agentCopilot01.png`：clean SaaS 風——藍色主色、白底卡片、大圓角、清楚的區塊標題。情緒色階：綠 → 黃 → 橙 → 紅。卡片：白底 + 細邊框 + 輕微 elevation。

### 14.4 無障礙：情緒不可只靠顏色表達

> ⚠️ 約 8% 男性有紅綠色覺辨識困難。若「焦慮偏高」只用紅色線條表示，對他們就是資訊遺失。

**情緒狀態必須同時具備：顏色 + 圖示 + 文字標籤。** demo 圖右上的「⚠ 焦慮偏高」標籤做法是正確的，必須保留。其他要求：所有互動元素可鍵盤操作、「一鍵帶入」提供鍵盤快捷鍵、文字對比度符合 WCAG AA。

### 14.5 情緒 Sparkline

手刻 SVG，不引圖表庫：

```vue
<!-- SentimentGauge.vue 概念 -->
<svg viewBox="0 0 320 52" fill="none">   <!-- 等比縮放，MUST NOT 用 preserveAspectRatio="none" -->
  <defs>
    <!-- 分帶漸層：由 y=6（score 100）到 y=42（score 0），每一級兩個同 offset 的 stop -->
    <linearGradient :id="gradId" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="42">
      <template v-for="g in GRADIENT_STOPS" :key="g.key">
        <stop :offset="g.from" :style="{ stopColor: g.color }" />
        <stop :offset="g.to" :style="{ stopColor: g.color }" />
      </template>
    </linearGradient>
  </defs>
  <polyline
    :points="points"
    fill="none"
    :stroke="`url(#${gradId})`"
    stroke-width="2"
    stroke-linecap="round"
    vector-effect="non-scaling-stroke"
  />
</svg>
```

資料量小（每輪一點），效能無虞；深色模式只需換 CSS 變數；新點加入時做平滑過渡動畫；搭配文字說明。

#### 折線的顏色吃 `score`，不吃 `label`

折線**依分數帶上色**：線落在哪一級就是哪一級的顏色，換色點落在線真正跨過界線的位置
（不是落在資料點上）。分數帶是 `SENTIMENT_BANDS`（`shared/types/copilot.ts`）：
`calm` 80–100 ／ `neutral` 60–79 ／ `concerned` 40–59 ／ `frustrated` 20–39 ／ `angry` 0–19，
與情緒 agent 的 system prompt 裡那份絕對標準同一組（見 §11 「agent 的 system prompt 也不在版本控制裡」）。

三件事必須一起記，否則各自都會**靜默**做錯：

1. **`gradientUnits` MUST 是 `userSpaceOnUse`。** 預設的 `objectBoundingBox` 依折線自己的外框
   分佈顏色，變成「最高的那點永遠綠、最低的永遠紅」——語意相反；水平線的外框高度是 0，
   整條線會直接消失。
2. **`stop-color` MUST 寫在 `style` 裡。** presentation attribute 不做 `var()` 代換，
   `stop-color="var(--active)"` 是無效值，靜默退回黑色。⚠️ 畫布逐字就是屬性寫法，
   這一處**刻意不照抄**（畫布在自己的渲染器裡有效，瀏覽器裡沒有）。
3. **色票取自量表 bar 的 `SCALE`，不另抄一份。**「下面那條 bar 就是這張圖的圖例」是分帶
   上色唯一的正當性；兩邊各寫一組，總有一天只有一邊被改，而那天不會有型別錯誤或測試失敗。

⚠️ **示警不再染折線。** 先前 `strokeColor` 會在示警時把整條線染成 `--warn`／`--danger`，
與分帶上色是兩套會打架的規則：示警有遲滯（最新一點已回到「擔憂」時仍持續示警），
此時整條紅線與線本身的高度互相矛盾。示警改由 pill 單獨承擔，顏色＋圖示＋文字三者仍並呈
（FR-003、憲法 8.1）。⚠️ `strokeColor` MUST NOT 回來（`test/sentiment-band-stroke.test.ts` 守著）。

⚠️ 量表 bar 的「普通」用 `--info`＋`--navy-soft`，**不是** `--text-2`＋無底色：後者的底色與
走勢圖框同值（在 bar 上像破了個洞），且無彩度的灰夾在四個有彩度的顏色中間會被讀成
「停用／沒有資料」。⚠️ 不要改用 `--navy-2` —— 它在深色主題對 `--surface-2` 只有 3.02:1，
當文字達不到 WCAG AA 4.5:1（`--info` 是 9.82:1／8.54:1）。

### 14.6 效能

訊息流使用虛擬滾動（`useVirtualList`）；建議卡數量上限 3–5 張，超過需捲動；情緒 sparkline 僅**繪製**最近 50 點（specs/001-sentiment-panel FR-015 已定案，非僅建議值）。

> ⚠️ 「只畫 50 點」不等於「只留 50 點」。評分點本身必須全數保留——`ClosureSummary.sentimentTrough` 要的是**本次涵蓋區間內**的最低點，若只留最近 50 點，它會安靜地算成「近期最低點」，而且要到寫進 Data Board 之後才會被發現。保留成本極低（每點只有分數、標籤與幾個關鍵詞），真正昂貴的是產生它的 AI 呼叫，那筆錢已經花了。詳見 `specs/001-sentiment-panel/spec.md` FR-015。

#### ⚠️ 虛擬滾動的高度契約 —— 一個沒有任何自動檢查看得見的地雷

`useVirtualList` 用 `itemHeight(index)` 決定 wrapper 的高度與每一列的位移。
**估算偏高或偏低都會壞，而且症狀完全不同，兩種都不會報錯**：

| 偏誤 | 症狀 |
|---|---|
| **低估** | 實際內容溢出 wrapper ⇒ 容器的 `scrollHeight` 永遠比 wrapper 宣告的大 ⇒ 每往下捲一點就渲染出更多內容、`scrollHeight` 又長高 ⇒ **永遠捲不到底**，「回到最新訊息」按鈕永遠不消失 |
| **高估** | wrapper 宣告的高度大於實際內容 ⇒ **底部留下一大段空白**（約等於「每列高估量 × 列數」，300 則時是數百 px） |

> 2026-08-31 一天之內兩個方向各踩過一次：先是改了 `MessageBubble` 的版面（發送者列補代號／pill、
> 附件改成圖示卡）而沒回頭調常數 → 低估；接著把常數往上調過頭 → 高估。

**因此「寧可高估」是錯的，沒有安全的偏誤方向。** 現行作法是**量測回饋**：
渲染後量每一列的 `offsetHeight` 存進一個 `shallowRef` 的 Map，`itemHeight()` 優先讀它
（`totalHeight`／`offsetTop` 都是 `computed`，讀響應式資料就會自己重算）。
估算只服務「還沒渲染過」的列 —— 那只影響捲軸長度，不影響視窗內的正確性。
⚠️ **欄寬改變時 MUST 清掉量測結果**（文字會重新斷行），而左右兩欄都可拖曳（§14.1）。

> ⚠️ **這一類 bug 對 `typecheck`／`vitest`／`smoke` 完全隱形** —— jsdom 沒有版面計算，
> `offsetHeight` 恆為 0，量不出任何東西。唯一的檢查方式是**真的用眼睛看**。
> 動到 `MessageBubble.vue` 的版面之後，請實際捲一個長對話到底部確認。

### 14.7 i18n

第一版即導入 `@nuxtjs/i18n`，預設 `zh-TW`。即使目前只有繁中，文案集中管理對客服系統仍然重要——事後補 i18n 是最痛的重構之一。

---

## 15. 錯誤處理與降級

### 15.1 最高原則

> **Copilot 是輔助，不得拖垮主線。** 任何 AI 或知識庫故障發生時，客服都必須還能看對話、還能回覆。

### 15.2 降級策略表

| 故障 | 降級策略 | 阻斷使用者？ |
|---|---|---|
| SDK 讀取超時 | 保留舊訊息流，頂部黃條「連線不穩，重試中」，指數退避 | ❌ 否 |
| AI 分析失敗 | 暫時性失敗（單次呼叫逾時 15s／5xx）先指數退避自動重試最多 2 次（1s → 4s）、總預算 40 秒，區塊顯示「重試中 (n/2)」；**429 不在此列**（見下方 Rate limit 列）；其餘錯誤（含 Zod 驗證失敗）或重試用盡後顯示「暫時無法分析 [重試]」。其他區塊照常運作。數值定案見 `specs/001-sentiment-panel/spec.md` FR-014。⚠️ 情緒分析對長對話會分批呼叫，批次大小是機率取捨、非保證不逾時，實測仍會偶爾觸發此列的重試/錯誤路徑——見 §11.8② | ❌ 否 |
| 知識庫失敗 | 建議卡降級為無 SOP 引用的通用建議，並明確標示「未引用知識庫」 | ❌ 否 |
| SSE 斷線 | 指數退避重連（1s → 30s）；重連後以本地 `lastMessageId` 對帳補齊（不靠 `Last-Event-ID`，見 §9.5）；斷線期間切 HTTP 輪詢 fallback | ❌ 否 |
| Token 過期（401） | 清 session 導回登入，URL 保留 `conversationId`，登入後回到原處 | ✅ 是（但無痛） |
| Rate limit（429） | **目標狀態**：全域退避 + 佇列，禁止重試風暴。**現況**：rate limit 書面規格未到（`IMBRACE_QUESTIONS.md` G-2），佇列參數無從設計，故 429 直接轉錯誤狀態供手動重試——只保證「不製造重試風暴」這個下限。全域佇列已列入 §18 M3 驗收 | ❌ 否 |
| 送出訊息失敗 | 樂觀 UI 標記「傳送失敗 [重試]」，草稿存 `localStorage` 絕不遺失 | ❌ 否 |
| Webhook 重送／亂序 | event id 冪等去重 + 30s 對帳輪詢補漏 | ❌ 否 |
| **撞單偵測（別人已回覆）** | 攔下並提示，提供 [↓ 先看最新訊息] [我已確認，仍要送出] [捨棄草稿] | ✅ **是（刻意的）** |

### 15.3 說明

**刻意阻斷是一個封閉集合，只有三種**（憲法 3.3）：① 撞單偵測（上表最後一列）——重複回覆客戶的傷害遠大於多按一次按鈕；② 主管強制介入鎖定（§10.6，送出 API 必須實際拒絕）；③ token 過期需重新登入（上表 401 那列，無從降級）。

其餘所有**故障**一律靜默降級：在對應區塊呈現清楚但不干擾的狀態，不使用全頁錯誤畫面、不彈出 modal 打斷工作。新增第四種刻意阻斷需修憲。

> ⚠️ **「重試用盡之後」MUST 停在 error 等人按，不得被下一輪整輪重跑覆蓋掉** —— 否則客服看到
> 的是永遠在「重試中」跳動的區塊，手動重試按鈕多數時候根本按不到。那一輪的重試預算
> （001 FR-014，最多 2 次、1s→4s、總預算 40 秒）不受此影響。完整觸發策略見 §11.1。

---

## 16. 部署與安全

### 16.1 部署形態

Docker 多階段建置 → `node .output/server/index.mjs`。**image 的形狀**（2026-09-08，M3.5）：`node:24.x-alpine` 鎖精確版本、禁 `:latest`；執行階段只複製 `.output`；`USER node`；只監聽 3000；設定值全部由 `NUXT_*` 環境變數在執行期注入，同一份 image 跨環境不重建。建置與推送走公司 Jenkins 的 `select-to-build-image` pipeline（加一個 case），推 Docker Hub `systalk/agent-copilot`，tag 用 commit 短 sha 這類不可變標籤。

> ⚠️ **`.dockerignore` MUST 排除 `.env*`（只放行 `.env.example`）與 `scripts/spike/out/`。** 前者是因為 `nuxt.config.ts` 在建置時會 `loadEnvFile`，本機憑證會被讀進建置程序；後者裝著真實對話樣本，可能含個資。兩者都不會報錯，只會安靜地把不該進 image 的東西帶進去。

**兩個所有環境都適用的前提**：

1. **瀏覽器到本服務之間 MUST 是 HTTPS。** session cookie 的 `Secure` 旗標（§7.2）是建置期決定（`server/utils/session.ts` 的 `secure: !import.meta.dev`），純 HTTP 下瀏覽器會丟掉 cookie，症狀是「OTP 驗證成功但下一頁又回到登入」。因此任何環境都需要一個 TLS 終端，「demo 先走 HTTP」不是選項——那不是偏好，是登不進去。
2. **TLS 終端就是反向代理，它 MUST 對 `/api/stream` 關閉回應緩衝，並把 read timeout 拉到大於心跳間隔**（`STREAM_HEARTBEAT_MS`，25 秒）。代理一開緩衝，SSE 會連得上但永遠收不到事件，不報錯。nginx 對應 `proxy_buffering off`、`proxy_cache off`、`proxy_http_version 1.1`、清空 `Connection` 標頭、`proxy_read_timeout` 遠大於 25 秒；K8s nginx ingress 對應 `proxy-buffering: "off"` 與 `proxy-read-timeout` 兩個 annotation。

**兩種部署形態**：

| 形態 | 適用 | 組成 |
|---|---|---|
| **單機 compose**（M3.5，SIT demo） | 單副本、記憶體狀態 | 一台有 Docker 的 VM；`deploy/docker-compose.sit.yml` 跑 `app` ＋ `proxy`（nginx：TLS 終端與上述 SSE 設定，設定檔進版控）；設定值走 `env_file`，鍵清單在 `deploy/agent-copilot.env.example`（進版控、值全空，部署現場複製後才填值）；換版為 `pull` ＋ `up -d`，刻意不設 `pull_policy`，少了 `pull` 就不會換版。healthcheck 用 node 自己發請求——alpine 沒有 curl／wget |
| **K8s**（M4） | 多副本 | iMBrace 提供 K8s 安裝文件，若能同集群部署可省一段網路跳躍。⚠️ **一旦多副本，Redis 即為必需品**（§8.3），且 §18 M2 那八份 process-local 狀態要逐一處置。ingress 承擔 TLS 與 SSE 設定；Secret 以 `--from-env-file` 直接吃同一份鍵清單 |

**單副本的部署策略 MUST 是 Recreate**（或等價的先停後起）：session 與分析狀態在記憶體，兩個實例並存會出現「隨機被登出」與重複輪詢。部署現場的操作步驟不寫在本文件，見 repo 內 `deploy/README.md`。

> 為什麼 SIT 不直接上 K8s：見附錄 B「部署形態」。

### 16.2 秘密管理

> **`IMBRACE_API_KEY`、AI 金鑰、`SESSION_SECRET`、`WEBHOOK_SECRET` 一律只放 server-side `runtimeConfig`，絕不進 `runtimeConfig.public`。**

`public` 底下的內容會直接打包進瀏覽器，一次疏忽即外洩。此條列為專案憲法約束。

### 16.3 Webhook 安全

三者缺一不可：① HMAC 驗簽——未驗簽的 endpoint 等於開放任何人偽造 JOIN 事件；② 時間戳容忍 ±5 分鐘，防重放；③ event id 去重，冪等。可行時追加來源 IP 白名單。具體規格待 iMBrace 提供，見 `IMBRACE_QUESTIONS.md`。

### 16.4 稽核與 PII

**稽核軌跡**（客服系統的合規需求）：誰在何時 JOIN、送出什麼、採納哪張建議卡。

**PII 處理**：日誌絕不可輸出訊息全文（含客戶個資），只留 id 與雜湊；客製 AI 若送往外部 LLM，對話內容出境需事先確認公司資安政策；錯誤回報／監控工具同樣不得挾帶訊息內容。

### 16.5 環境

| 環境 | 用途 |
|---|---|
| local | 開發，缺憑證時自動退回 `MockKnowledgeProvider` + mock AI |
| **SIT**（M3.5） | 公司內網單機 compose，給客戶 demo。⚠️ **對接的仍是 iMBrace `stable`，也就是正式客戶資料**——iMBrace 尚未提供 sandbox（`IMBRACE_QUESTIONS.md`「測試資源」一題未回）。demo 的 JOIN、送訊息、結案寫入都是真寫入；結案 MUST 寫進 demo 專用 Board（另跑一次 `npm run board:setup`），demo 用的組織與對話要事先選定並讓客戶知情 |
| staging | 對接 iMBrace 測試環境——**尚不存在**，取決於 sandbox 是否提供 |
| production | `env: 'stable'` |

以 `runtimeConfig` 切換，不寫死於程式碼。

---

## 17. 監控指標

| 指標 | 意義 |
|---|---|
| 活躍 CopilotSession 數 | 系統負載 |
| 輪詢 QPS | 對 iMBrace API 的壓力 |
| AI 呼叫量 / P95 延遲 / 失敗率 | 成本與體驗 |
| SSE 連線數 | 在線客服數 |
| Webhook 接收數 / 失敗數 / 去重命中數 | 事件來源健康度 |
| **撞單攔截次數** | **反過來證明本功能的實際效益，特別有價值** |
| 建議卡採納率 | 建議品質；亦為模型優化的回饋訊號 |
| 知識庫檢索命中率 | 知識庫覆蓋度 |

健康檢查端點：`GET /api/health`

---

## 18. 開發階段切分與驗收

> **設計目標：M0–M3 完全不依賴任何未定的外部 API。** webhook 規格到位時，已有一個能跑的完整系統，剩下只是替換 provider 實作。

### M0 — 地基

**內容**：Nuxt 骨架、`ssr: false` + Nitro 設定、OTP 三段式登入、BFF session、SDK client factory、`StateStore` / `EventBus` 介面 + 記憶體實作（API 全 async）

**驗收** ✅ **已全數通過**（`npm run build && npm run smoke`，`test/auth-flow.test.ts`）：能以 OTP 登入並選擇組織（一律出現選擇畫面）；重新整理 `organization.vue` 不會被踢回輸 email；session 中確實存有 `refresh_token`；能列出對話清單；access token 不出現在任何前端資源或網路回應中。

> 超出原驗收清單、但一併完成的項目：`StateStore` / `EventBus` 介面與記憶體實作、對話識別碼正規化（§9.3）、JOIN / LEAVE / mode 切換的防腐層（§10.6）。

**外部依賴**：無

---

### M1 — 對話主線

**內容**：對話列表、訊息流（虛擬滾動）、Composer、join / leave；Presence 四來源合併（§10.2）；SSE 管線 + 自動重連；`MessageSource` 抽象 + `PollingMessageSource` + 共享訂閱 + 自適應頻率（§9.2）；只取最新 N 則 + 本地 `lastMessageId` 比對（§9.3）；送出前樂觀併發檢查；JOIN 雙路徑去重。

**驗收** ✅ **全數通過**（8/8，皆為可重跑的自動化驗證，見 `npm run smoke`、`test/`；tag `m1-done`）：
- [x] 兩個瀏覽器開同一對話：A 送出後 B 在 4 秒內看到
- [x] B 帶入草稿準備送出時，若 A 已回覆，必須被攔截並提示
- [x] 三個瀏覽器檢視同一對話時，該對話只被輪詢一次
- [x] 分頁切至背景後，輪詢頻率確實下降至 30s 以上
- [x] SSE 斷線後能自動重連並補齊斷線期間的訊息
- [x] 單次輪詢不會每次都取回整串對話
- [x] PresenceBar 在無人時顯示正常空狀態
- [x] `u_` 反推的同事標示為「N 分鐘前回覆過」，不可標示成「正在檢視」

> 「4 秒」量的是哪條路徑、以及哪些驗收能自動化、哪些必須真實瀏覽器，見附錄 B。

**外部依賴**：無

> **本階段刻意接受的暫行方案**（不阻塞，待 iMBrace 回覆後再定案）：presence 有盲區（同事在官方介面 JOIN 但未發言時看不到，由 §10.4 兜底）、輪詢頻率取保守值。

---

### M2 — Copilot 核心

**內容**：對話摘要、情緒 sparkline、建議卡、一鍵帶入、知識庫自然語言快查（inline 面板，§12.3；由 M3 併入——快查與建議卡共用同一個 `KnowledgeProvider` 裝配）；前景／背景分級、debounce、快取；知識庫採 `AgentKnowledgeProvider`（§8.2）。
**不含**客戶資料卡（§19.1 #21）、語音與舊資料型 `file` 附件、圖片／PDF 的 vision 分析（皆延至 M3）。

**規格**：`specs/001`～`004`（共押 `m2-004-done`）、`005-m2-residual-defects`（65/65，`m2-005-done`）。
✅ **`m2-done` 已於 2026-09-03 建立（使用者裁定收尾），M2 正式結束。** 押 tag 當下的真實狀態：手動驗收皆已通過（003 T052、005 T058）；綠燈基線 `typecheck`／`vitest` 559／`build`／`smoke` 126 項；**三條時效門檻仍為【未達標·已安置】**，刻意不阻擋。

> ⚠️ **押 tag 前最後一次窄審修掉三個靜默失效缺陷**（情緒補算取歷史失敗時 `sentimentGap` 被清掉、建議卡檢索失敗被誤記為「命中 0 筆」導致重試永不再檢索、背景並行名額被少算而突破上限），三者都在各 spec 驗收「全數通過」**之後**才被找出來，落點正是「後面的 spec 動到前面 spec 的程式碼」那個橫向交會處，而縱向的 spec 驗收不負責那裡。**M3 收尾時 MUST 比照辦理：綠燈基線之外，另審一次跨 spec 的熱點檔案。**

#### 驗收

> ⚠️ **勾選符號的意義：`[x]` ＝「已處置」，不等於「已達標」。** 三條時效門檻的數字**沒有達標，也沒有被放寬**；它們標成 **⚠️【未達標·已安置】**，代表「成因已定位、我方槓桿已用盡、已對外回報、且已指定後續由誰在什麼條件下重新判定」。**看到那個標記就 MUST 讀完該項的處置說明，MUST NOT 當成通過。** 一直空在那裡不會讓數字變好，只會讓「還沒決定」與「決定了不擋」永遠分不出來。

**時效與行為**（⚠️ 第 2～4 項的順序被 `scripts/spike/21-progressive-citations.ts` 以「驗收第 N 項」引用，不要重排）

- [x] JOIN 後 3 秒內面板區塊出現並標示分析中（不要求該時點已有實質內容）—— `analyzing` 事件在任何 AI 呼叫 resolve 之前就發布，時點不取決於模型延遲（`test/copilot-analysis.test.ts`）
- [x] ⚠️【未達標·已安置】JOIN 後 **15 秒**內**情緒**的實質內容呈現（90 百分位）
      **最近量測**：2026-09-02 三輪合併 **35/45 ＝ 78%**（單輪 73% / 93% / 67%）；2026-09-03 掃描的檔位 3 量到 41/45 ＝ 91%，**經裁決不改判**（使用者，2026-09-03）——單次延遲兩天幾乎相同、差別只在尾巴，一次 91% 不足以翻掉一次 78%。
      **成因**：依批次數拆開很明確——1 批、2 批全過（9/9、9/9），3 批 12/17、5 批 5/9 破；一波要等最慢的那一批（max-of-3 ≈ 單次 80 百分位），且情緒 agent 單次中位由 6.6 秒（09-01）穩定變成 7.3 秒（09-02，四個獨立量測吻合）。**失守的原因是餘裕不足，不是門檻訂錯**：15 秒對 2 波原本只剩約 15% 餘裕，而平台自身漂移約 36%。
      **槓桿已用盡**：門檻由 10 秒改為 15 秒時同步改了程式（`SENTIMENT_CONCURRENCY = 3`，中位由 16.9 秒降到 7.7 秒；依序送出時 10 秒只在客戶發言 ≤ 6 則時成立）；並行度經 n=45 三檔位掃描證明是**負**槓桿（§8.2b）。
      ⚠️ 15 秒**不是對所有長度成立**：50 則客戶發言（9 批＝3 波）約 20 秒會破，這個門檻買到的是「常見長度有明確承諾」。
      📌 **處置**：門檻**不放寬**；已對外回報 `IMBRACE_QUESTIONS.md` **0-4**。**重新判定的條件**：兩次獨立時段的 n=45 皆達 90%（一次不算），或 0-4 得到可承諾的 p90／SLA。判定歸屬 M4。
- [x] ⚠️【未達標·已安置】JOIN 後 10 秒內**摘要**的實質內容呈現（90 百分位）
      **最近量測**：2026-09-02 三輪合併 **33/45 ＝ 73%**（單輪 93% / 53% / 73%）。隔離單次量測 19/20 ＝ 95%，落差來自輸入長度而非管線競用（§8.2b 量測規程 3）。
      **成因**：模型延遲的尾巴，摘要是單次呼叫，**repo 內從一開始就沒有槓桿**。
      📌 **處置**：門檻維持 10 秒**不放寬**——SC-005 不擋任何執行路徑（會擋的是 FR-014 的 15 秒單次逾時），放寬只是把判準改成會通過；而這條門檻守的正是 001 的價值主張「客服不必重讀完整歷史」，摘要 25 秒才出現時客服早已自己開始讀了。已對外回報 0-4（附上同一天內中位 6.3／52.1／11.1 秒這組數字）。**重新判定的條件**：同上。
- [x] ⚠️【未達標·已安置】JOIN 後 **20 秒**內首批建議卡呈現（90 百分位）
      **最近量測**：2026-09-02 三輪合併 **39/45 ＝ 87%**（單輪 93% / 80% / 87%）。
      **本項與另外兩條不同——它曾有一個 repo 內的成因並且已經修掉**：20 秒門檻配 15 秒共用逾時在重試路徑上不可達 → `SUGGESTION_STAGE1_CALL_TIMEOUT_MS = 20_000`（§8.2b），修完由 33～67% 拉到 87%，「第一段從未發布」的樣本由 9/30 降到 3/30。剩下的差距才是 agent 推論延遲。
      ⚠️ **MUST NOT 調到 30 秒、也 MUST NOT 調回 10 秒**——20 秒是從 10 秒放寬時經過裁決的數字（建議卡 agent 單次 p90 就有 10.31 秒，10 秒在現行平台必然不過；20 秒對 p90 有近一倍餘裕，漂移 36% 後仍在內）。
      ⚠️ 此處量的是**第一批可用的卡**；帶 SOP 來源的版本由 004 第二段換上，落定上限 50 秒是另一個門檻——目前仍通過，但 2026-09-02 已出現第一次破線（42 個落定樣本中 1 個 52.5 秒，另有 3 個從未落定），**餘裕正在被吃掉，MUST 繼續盯這一列**。
      📌 **處置**：門檻維持 20 秒；剩餘差距併入 0-4。**重新判定的條件**：同上。
- [x] 一鍵帶入可用，且帶入後仍會做撞單檢查（`test/suggestion-send-path.test.ts`：insert 與手動輸入寫進同一個 `draft.text`，介面上不存在可略過檢查的參數）
- [x] 背景對話重算情緒與建議卡但**不重算摘要**，且並行數未超過上限（憲法 6.2；`test/copilot-analysis.test.ts`，斷言 `BACKGROUND_CONCURRENCY_LIMIT` 滿載時超額對話不執行、也不顯示為錯誤）
- [x] 切換至背景對話時立即顯示已更新的情緒與建議卡，僅摘要於此時補跑並標示「更新中」（`stream.get.ts` attach 時先送快照再 `catchUpSummaryIfStale()`；`SummaryCard.vue` 於 `ready → analyzing` 保留舊內容疊加「更新中」）
- [x] 知識庫快查回傳含標題與更新日期（或「更新日期未知」）的結果，不顯示獨立編號；空白查詢不觸發呼叫；「查無結果」與「尚未輸入查詢」視覺可區分（`test/knowledge-search-api.test.ts`）
- [x] AI 失敗時訊息流與 Composer 完全可用（2026-08-28 實測：三區塊全數失敗逾 20 分鐘期間，中欄照常收發、草稿在離開對話後仍保留）
- [x] 建議卡的 `sopId` 不在白名單即整卡丟棄。⚠️ 「通過」指**防線有效**，不是模型不會杜撰——杜撰率 **21%**、最終取得引用 **82%**（n=45 固定口徑，成因與槓桿見 §8.2b「杜撰引用的成因」；引用本項數字 MUST 用這組，舊的 44% 只是 n≈9 的歷史脈絡）。每一次引用落定在生產路徑發 `suggestion.citation.audited`（`server/utils/citation-audit.ts`，六值 `outcome`，一行 NDJSON），`npm run spike:citation-quality` 讀它算杜撰率。最強的槓桿（建議卡 agent 的 prompt 與選型）在 iMBrace 後台
- [x] `confidence` 無真實分數來源時留空，不得以模型自評頂替（§11.6②；`forceNullConfidence()` 在 Zod 之後強制覆寫，`test/suggestion-whitelist.test.ts`）
- [x] Copilot 面板可見性依 003 FR-016～FR-017b：未 JOIN 時整欄不呈現、JOIN 時展開可收合、收合狀態 per 客服 per 對話存 `localStorage`，且伺服器不推分析事件給未 JOIN 的連線（`test/stream-analysis-visibility.test.ts`、`smoke:realtime`；真實環境以兩個不同帳號在 stable 驗過）。
      **重跑時**：MUST NOT 以同一帳號兩分頁替代；「未 JOIN 端收不到」MUST 用 DevTools 的 EventStream 從**連線建立起**確認——只在前端隱藏而伺服器照推時，畫面看起來一模一樣
- [x] SC-001：注入 AI 故障後靜置 10 分鐘且無新發言，分析嘗試不超過 1 輪（對照修正前約 30 輪）。⚠️ 這項**只有故障注入驗得出來**，自動化全綠不代表止血成功
- [x] SC-002：離開或結案後 5 秒內不再有新分析事件，中欄與草稿不受影響（`smoke:realtime` ⑥）

**UI 與設計核對**（規格正典為 `docs/DESIGN_TOKENS.md`；刻意偏離畫布之處與理由見 `docs/DESIGN_FEEDBACK.md`）

- [x] 中欄標題列、Copilot 面板（artboard 2a）各區塊、面板 header（42px 固定列，「全部重試」只在有區塊失敗時出現）、左側清單與中欄各元件已對照畫布 artboard 1c／2a 及其狀態變體核實完成。⚠️ 中欄的對話標頭與服務模式是**兩個各自帶 `border-bottom` 的區塊**——包在同一個 `<header>` 裡會讓中間那條分隔線整條不見
- [ ] **Composer 的夾帶檔案按鈕**（M3 範圍，卡在 `IMBRACE_QUESTIONS.md` H-6c 附件送出流程未知）。**刻意不放 disabled 佔位鈕**——按了不會有任何變化的按鈕比沒有按鈕更像壞掉。⚠️ 日後補這顆按鈕時**要一起改版面**：畫布是上下兩列（`textarea` 在上、工具列在下，中間一條 `border-top`），實作目前是左右一列

**未修的缺陷與未歸屬項目**（節名保留供 `specs/005` 引用；內容已全數關閉或歸屬）

- 三條真實環境缺陷（`registerCredential()` 雙分頁、`session.watchers` 雙分頁、自動恢復不補算失敗批次）與順帶挖出的 `runBlockDeduped()` rerun 缺陷，皆由 `specs/005` 關閉；守衛 `test/connection-counting.test.ts`、`test/sentiment-backfill.test.ts`。設計要點在程式碼註解（`credentials.ts`、`session-registry.ts`、`blocks/sentiment.ts`）：連線計數以 server 端 `connectionId` 為鍵（不是 `clientId`——複製分頁會共用 `sessionStorage`）、`POST /api/connection/beat` 每 20 秒 upsert 而 TTL 45 秒、補算錨點是 `timeline[0]` 而非 `lastCoveredMessageId()`。**留下的兩條已知限制／行為**：① 同區塊三次以上併發時，中間那些觸發會被最新的覆蓋（合併語意的本意；debounce 已先把 1 秒內的爆量聚成一批）；② `session.opened` 的 `reason` 在同一客服第二個分頁由 `join` 變 `resume`（無前端消費者）。
- 平台清單預設排序的分頁邊界、第一層背景輪詢的分頁能力：**歸屬 M4**（證據與關閉條件記在 M4 那兩條）。

**分析管線拆檔**（三刀已於 2026-09-02／09-03 切完，純搬移；以下是**切完之後仍然有效的常設約束**）

`server/services/copilot-analysis.ts` 原為 1773 行，病灶不是行數，而是**九份互不相干的模組層可變狀態共用同一個作用域**。**切線依據（MUST NOT 改成別的）**：誰擁有哪一份執行期狀態；「新程式碼該放哪個檔案」用同一條判準——它要碰哪一份 `Map`，就寫在那個檔案裡。守衛 `test/contract-guards.test.ts`「每一份執行期狀態只由擁有它的檔案碰」（其 `OWNERSHIP` 表推導自模組層 `Map`／`Set`，比對前剝掉註解與字串）。

| 檔案 | 擁有的執行期狀態 |
|---|---|
| `analysis-state.ts` | `stateLocks` |
| `analysis-dedupe.ts` | `analysisInFlight`／`analysisRerunPending` |
| `blocks/suggestion.ts` | `suggestionTails`／`suggestionTailDone` |
| `blocks/sentiment.ts` | **無**——`resolveHistory` 是裝配點（函式變數），不是狀態容器 |
| `copilot-analysis.ts`（barrel：摘要 ＋ 對外入口 ＋ debounce） | `coldStartRecoveries`／`backgroundInFlight`／`debounceTimers` |

- `blocks/summary.ts` **確定不切**：摘要沒有自己的執行期狀態，barrel 的形狀就是終點。行數要知道就跑 `wc -l`，本文件不維護。
- **新增管線檔的檔頭 MUST 加上 `@analysis-pipeline` 標記**——`contract-guards` 靠它認定管線成員，決定「不得 import `copilot-runtime.ts`」與「不得被管線外值 import」兩條守衛的涵蓋範圍。**MUST NOT 改回用檔名 regex 判定**：第一版 `analysis-[a-z-]+\.ts` 當天被 `analysis-stage2.ts`（帶數字）與 `analysisSentiment.ts` 打穿且零訊號。
- **搬移的真實成本是註解的交叉引用**：註解超過三分之一，大量用「上方／下方／本檔」這類位置相對指路詞。搬完 MUST `grep -n "上方\|下方\|上面\|下面\|本檔" <新檔>` 逐條改成明確符號名，**且與搬移放同一個 commit**。日誌前綴維持 `[copilot-analysis]`，MUST NOT 改成 `[sentiment]`——日誌字串是可觀測行為的一部分。

> 📌 **M4 要回頭處理**：上表那八份 `Map`／`Set` 全部是 process-local 的，不像 `copilot-runtime.ts` 用 `Symbol.for` 掛 `globalThis`，也不在 `StateStore` 裡——§8.3 的「M4 換 Redis」**涵蓋不到它們**。多副本下 `stateLocks` 保護不到另一個副本的寫入、`suggestionTails` 的世代計數各副本各一份、`analysisInFlight` 的去重完全失效（同一個對話在兩個副本上各跑一次分析，不會有任何錯誤）。每個檔案的檔頭各自寫著自己那一份的後果。**M4 規劃多副本時 MUST 逐一處置這八份**，不能假設換掉 `StateStore` 就結束了。

**已修的缺陷**（只留仍然有效的取捨）

- `runColdStart()` 重啟復原缺口：平台側的 JOIN 是持久的，`CopilotAnalysisState` 卻只由 `join.post.ts` 建立 → 伺服器重啟後面板永遠空白、無日誌、不報錯。修法：`sendAnalysisSnapshotAndResume()` 對已 JOIN 的連線補跑 `recoverColdStart()`。⚠️ 代價（重啟後每個已 JOIN 且有連線的對話各跑一次冷啟動）**刻意接受**；M4 換 Redis 後此路徑不再觸發。

**外部依賴**：無

---

### M3 — 知識庫與結案

**內容**：結案摘要 ＋ 人審面板（`specs/006-closure-handoff-summary`，交接摘要不實作，§13.4 ②）；`board-repository` 冪等寫入；Data Board schema setup script；**圖片與 PDF 附件的 vision／文件分析**（§11.4、§19.1 #11——平台無內建 OCR，自建管線預估 5～10 人日；`specs/001` FR-013 已列為排除範圍）；**429 全域退避佇列**（待 G-2 書面 rate limit 規格）；知識庫 provider 是否換成 `VikiKnowledgeProvider`（⚠️ 僅指「換 provider」這個決策，快查功能本身已隨 M2 落地）。

**驗收**：
- [ ] ~~若換上 `VikiKnowledgeProvider`：`score`／`confidence` 開始出現真實數值~~ —— **不適用，MUST NOT 打勾**（勾起會讓下一個人以為換過了）。**2026-09-07 使用者決策：本期不換入，且與 0-3f 的回覆脫鉤**——0-3f 仍在等待回覆，但它的答案不再是這一條的觸發器。重啟條件：`score`／`confidence` 恆為 `null` 真的擋到某個使用情境，或 viki 側先建好知識庫與 AI 助理。`KnowledgeProvider` 介面不變，換入成本仍只是一個實作類別
- [x] 摘要可編輯後才寫入 Board —— `app/components/copilot/ClosureBlock.vue` ＋ `server/api/conversations/[id]/closure/commit.post.ts`；`test/closure-commit-guard.test.ts` 掃描全 repo 只有寫入按鈕會呼叫 commit
- [x] 中欄出口文案 `conversation.exitHint`（「離開＝僅退出不寫入・結案＝產生摘要供確認後寫入」）與實際行為一致 —— `closeConversation()` 只開結案面板，寫入成功後才 LEAVE（006 T033 逐句對照）。✅ 003 SC-007（3 位未參與者按下之前皆說得出哪一個會留下紀錄）於 2026-09-07 實測通過 3/3；受測者代號與逐字回答未留存，要複驗時素材與問句在 `specs/006/quickstart.md` §2 SC-005
- [x] 同一份草稿重複寫入只留一筆；同一對話的多次結案各自並存（`test/closure-idempotency.test.ts`：同一 draftId 重試 10 次恰好 1 筆、兩份草稿 2 筆並存）。⚠️ 原條文「重複觸發為覆蓋而非新增」方向是錯的（憲法 v4.0.0、§13.4 ③）
- [x] 按下「結案」產生結案摘要 —— ⚠️ 觸發條件不是對話狀態變更，結案也不變更平台對話狀態（§13.4 ②）
- [ ] ~~LEAVE 產生交接摘要，兩者不混用~~ —— **不適用**（交接摘要不實作，§13.4 ②）。「不混用」在只有一種摘要時自動成立卻什麼都沒驗到，勾起會讓下一個人以為驗過了
- [x] 結案摘要的涵蓋區間由客服選定，且區間與則數隨紀錄寫入（`ClosureScopePicker.vue` ＋ `period_start`／`period_message_count`／`period_origin`；§13.4 ④ 已列三種自動推導的反例，不要重新提案）
- [ ] 圖片／PDF 附件能顯示縮圖與描述文字，且同一份檔案不重複送給模型（結果需快取）—— ⚠️【卡外部回覆·已安置 2026-09-08】縮圖與下載已有，缺的是描述文字（vision）。重啟條件：E-3（合規）、H-2d（URL 時效）、0-1（可用模型）三題得到回覆
- [ ] 圖片／PDF 的描述不得依賴 `caption` 欄位 —— ⚠️【卡外部回覆·已安置 2026-09-08】與上一條同進退
- [ ] **429 由全域退避佇列統一處理**，摘要／情緒分析與輪詢等呼叫端不再各自重試；`classifyFailure()` 的 `'rate-limited'` 分類改接佇列，並回頭修訂 `specs/001-sentiment-panel/spec.md` FR-014 的 429 分支與 Assumptions —— ⚠️【卡外部回覆·已安置 2026-09-08】現況「429 直接轉錯誤、不重試」是刻意的下限（§15.2），重啟條件：G-2 書面 rate limit 規格

> 結案相關各條的手動驗收於 2026-09-07 第二輪通過（第一輪走查是在有六個缺陷的畫面上進行的，`specs/006/quickstart.md` §6.4.2、§6.8）。綠燈基線 2026-09-07：`typecheck` ✅、`vitest` 58 檔 726 項 ✅、`build` ✅、`smoke` ✅。
>
> ⚠️ **M3 尚未完成，MUST NOT 因為結案那幾條齊了就押 `m3-done`**：仍有四條未勾，皆不屬 `specs/006` 範圍——① Viki provider（本期不換）；②③ 附件 vision／文件分析；④ 429 全域佇列（卡 G-2 🔴）。②③④ **於 2026-09-08 決定安置**（比照 M2「未達標·已安置」）：三者卡的都是 `IMBRACE_QUESTIONS.md` 尚無回覆的題目，不進 M3.5、不開 007，重啟條件寫在各條。安置完成後押 `m3-done` 由使用者裁定，是 M3.5 的前提。收尾時 MUST 比照 M2：綠燈基線之外另審一次跨 spec 的熱點檔案。

**外部依賴**：Data Board schema 需先建立（✅ `npm run board:setup`）；429 全域佇列需 `IMBRACE_QUESTIONS.md` G-2 的書面 rate limit 規格。

---

### M3.5 — SIT 展示就緒

**為什麼有這一段**：`IMBRACE_QUESTIONS.md` 的題目截至 2026-09-08 全部沒有回覆，M3 剩餘的三條與 M4 的多數項目卡的都是同一批回覆，而專案必須先進到能在公司 SIT 環境對客戶 demo 的狀態。本段只收「不依賴任何外部回覆就能關閉」的項目：把 M4 的「Docker 部署」提前為單容器、單副本形態；Redis、多副本、webhook 整批留在 M4。**不開 spec**——比照 M0／M1，地基工作直接開發（§20.4）。

**內容**：`Dockerfile` ＋ `.dockerignore`；`deploy/`（單機 compose、nginx TLS 終端、env 鍵清單、換版與 image 檢查腳本、部署步驟）；Jenkins build pipeline 的 case；demo 專用 Data Board；SIT 走查。部署形態與兩個前提見 §16.1，環境定位見 §16.5。

**前提**：`specs/006` 已合回 `main`（✅ 2026-09-08）；M3 的 ②③④ 已安置並押 `m3-done`。

**驗收**（全部可在本 repo 內關閉）：
- [ ] image 從 `main` 建置，容器以 `USER node` 啟動，`GET /api/health` 回 200
- [ ] image 內不含 `.env*` 與 `scripts/spike/out/`（`deploy/verify-image.sh` 掃描；這兩條不會報錯，只會靜默帶進去，見 §16.1）
- [ ] 本機以 `deploy/docker-compose.sit.yml` 同一份組成（app ＋ nginx）走完：登入、列表、JOIN、摘要／情緒／建議卡三區塊、送出、結案寫入。⚠️ VM 沒有任何本機測不到的東西，除了網路位置——交付前 MUST 先在本機通過
- [ ] SIT 上以 HTTPS 完成同一條走查；結案寫入落在 demo 專用 Board（`npm run board:setup` 另建，id 進 env），MUST NOT 寫進客戶的正式 Board
- [ ] SSE 穿過 nginx：JOIN 後面板有事件進來、閒置 ≥ 2 分鐘連線不斷（驗 §16.1 前提 2；代理 timeout 設錯時症狀是連得上但沒事件）
- [ ] 換版走 `deploy/redeploy.sh`（`pull` ＋ `up -d`），image 以不可變 tag（commit 短 sha）指定；`develop` 這類可變標籤 MUST NOT 用於 SIT
- [ ] demo 前 `npm run spike:agent-prompts` 無漂移（§8.2b：量測數字是間接證據，快照 diff 是直接證據）
- [ ] 可選，需使用者決定，未決前 MUST NOT 自行納入：清單分頁防禦（M4 那條的 ② 分頁，先查 demo 組織的對話數，> 100 才做）；主管強制介入白名單版（§10.6 順位 2，從未被任何里程碑認領）

**外部依賴**：公司 SI 提供 VM、對外連線（iMBrace 兩個網域與 Docker Hub 的 443）、內網主機名稱與憑證。⚠️ 這些是環境，不是 iMBrace 的回覆——本段刻意設計成一題都不用等。

> ⚠️ **記憶體狀態的代價在這裡第一次真的付出**：每次換版所有客服被登出、分析結果歸零（§8.3、§18 M2 那八份 process-local）。demo 前不換版即可，但這是 M4 換 Redis 的直接證據，不要在 SIT 上用「多開一個副本」擋負載——那會直接觸發 §16.1 說的「隨機被登出」。

---

### M4 — 生產化

**內容**：Redis 實作換入（`RedisStateStore` / `RedisEventBus`）；`WebhookEventSource` 接入（規格到位後）+ HMAC 驗簽；30s 對帳輪詢；監控指標；K8s 多副本部署（單容器 image、compose 單副本形態與 `/api/health` 已於 M3.5 交付，§16.1）。

**驗收**：
- [ ] **雙副本部署下：webhook 打到 A 副本、客服 SSE 連在 B 副本，仍能推達**
- [ ] 雙副本下同一對話只有一個副本在輪詢
- [ ] 偽造簽章的 webhook 請求被拒絕
- [ ] 重送的 webhook 事件不會造成重複分析
- [ ] rolling deploy 後，客服的 session 與分析結果不遺失
- [ ] **第一層清單輪詢在對話數 > `LIST_PAGE_SIZE`（100）的組織下不漏對話** —— 二擇一即可：
      ① webhook 到位，第一層不再負責偵測新訊息（此時本項自動成立）；
      **或** ② `copilot-runtime.ts` 的 `fetchConversationList()` 取得分頁能力（`skip` 分頁或改查 `_outstanding`，兩者成本模型差很多，需先有實際資料才決定得了）。
      ⚠️ **MUST NOT 因為 webhook 未到位就跳過本項**——條文寫成二擇一正是為了讓它不依賴外部規格也關得掉。
      ⚠️ 與下一條是同一個風險的兩面，**一起關閉**：側欄的 `BACKGROUND_COVERAGE` 也鎖在同一個 100，兩者的安全性都取決於「有新訊息的對話會不會被排到前 100 筆」
- [ ] **平台清單預設排序的分頁邊界已驗證**。已量到的部分（2026-09-01，`npm run spike:list-order`，n=18，`out/22-*.json`）：`last_message_at` 完全遞減（9 組可比對，填充率 78%）、`updated_at` 也完全遞減（17 組）、`created_at` 僅 53%。實務上前兩者都代表「新活動往前排」，故現況安全。
      ⚠️ **仍不得關閉，理由有二**：① 樣本 18 筆遠小於門檻的 100，驗到的是**排序方向**，不是**分頁邊界**；② `last_message_at` 與 `updated_at` 兩者都 100% 遞減，仍分不出排序鍵是哪一個，MUST NOT 寫成「已證明排序鍵是 `last_message_at`」。關閉條件：一個對話數 > 100 的組織，或平台提供排序參數
- [ ] **M2 那三條時效門檻已在生產環境重新量測並做出最終判定**（摘要 10 秒／情緒 15 秒／建議卡第一段 20 秒，皆 90 百分位）。數字與處置說明在 §18 M2，此處**刻意不重述**。
      **關閉條件（三者任一）**：① 兩次獨立時段的 n=45 皆達 90%；② `IMBRACE_QUESTIONS.md` **0-4** 得到可承諾的 p90／SLA，據以重訂門檻；③ 明確裁定「不達標但不阻擋上線」，並在此寫下理由。
      ⚠️ **MUST NOT 用「放寬到通過為止」關閉本項**。生產環境重測 MUST 標註時段並先跑 `npm run spike:agent-prompts`（§8.2b）。
- [ ] **分析管線的八份 process-local 狀態已逐一處置** —— 清單與各自的失效後果記在 §18 M2「分析管線拆檔」的 📌 註記。⚠️ 這一項 MUST NOT 被上面那條「雙副本下同一對話只有一個副本在輪詢」吸收——那條管的是**輪詢**，而去重與世代失效時輪詢完全正常，只是同一個對話在兩個副本上各跑一次分析，**不報錯**

**外部依賴**：webhook 規格

> ⚠️ 第一項驗收標準（雙副本 webhook 跨實例推達）是最容易被跳過、上線後最容易爆的一項，務必寫死在驗收清單中。

---
## 19. 已知風險與待確認事項

| 標記 | 意義 |
|---|---|
| ✅ 已解除 | 風險消失或降至可忽略 |
| 🟢 大幅緩解 | 風險仍在但已找到可行解，殘餘影響可接受 |
| 🔵 已確認 | 風險確實存在，因應方式已定 |
| 🟡 待實測／部分確認 | 仍有殘餘未知 |
| 🔴 高優先 | 影響架構方向或核心功能能否成立 |
| ⚪ 未變動 | 尚未取得新證據 |

### 19.1 風險表

編號是穩定識別項（程式碼註解直接引用 `#11`、`#12`、`#13`），已解除者保留列、不遞補。

| # | 風險 | 狀態 | 因應 |
|---|---|---|---|
| 1 | 無獨立的知識檢索 API | 🔵 已確認（部分緩解） | 無 query／retrieve 端點；改為 agent 的 SSE `tool-output-available` 事件解析 `RAGknowledge` 輸出，可取得檔名與 chunk 原文 |
| 2 | Webhook payload 規格未定 | 🔵 已確認為 M1 的硬限制 | 輪詢路徑答不出「是誰」JOIN 了；M1 用本地快路徑＋`mode` 的匿名訊號，具名 operator 清單須等 webhook（`IMBRACE_QUESTIONS` A-1） |
| 3 | Presence 無可靠來源 | 🟢 大幅緩解 | `users[]` 是團隊名冊不可用；真正的解是 `mode` 欄位（§10.2），僅 `automation` 的歧義仍存在但不構成撞單風險 |
| 4 | Webhook 簽章機制未知 | ⚪ | 上線前必須取得規格（A-3），否則 endpoint 不得對外開放 |
| 5 | SDK 無訊息層級推播 | 🔵 已確認 | 自適應頻率 + 共享訂閱；持續向 iMBrace 爭取 WS（B-1） |
| 6 | 無相關度分數可用（iMBrace 路徑） | 🔵 已確認，因應方式已定 | `confidence` 改為 nullable，非整個拿掉——無分數時留空，換上 viki 後自然回填，UI 不必重做（§8.2、§11.6） |
| 7 | 多副本狀態共享 | ⚪ | 介面 day-1 async；M4 換 Redis。⚠️ 分析管線的八份 process-local 狀態不在 `StateStore` 裡，M4 要逐一處置（§18 M2） |
| 8 | ~~Nuxt UI Pro 授權~~ | ✅ 已解除 | v4 起 Pro 已併入主套件，125+ 元件全免費 MIT，商用無需額外授權 |
| 9 | 對話內容送外部 LLM | 🔵 已確認會擴大到影像 | 自建 vision／文件分析（§11.4）已定案，出境範圍**確定**從文字擴大到圖片與 PDF；實作在 M3（§18 M3）。合規政策待 iMBrace 回覆（E-3），送出前須先確認公司資安政策 |
| 10 | Data Board 欄位型別限制 | 🔵 已實測並落地 | `npm run board:setup`／`board:verify`；陷阱（`createField()` 回整個 board、唯一鍵不保證、`sort` 被靜默忽略）記在 §13.3、§13.4 ③ 與 `board-schema.ts` |
| 11 | 附件內容依型別而定 | 🟢 已用真實對話驗證 | `image`／`pdf` 皆有直接可用 url，只是缺描述與（客戶上傳時的）檔名，已納回 MVP；舊資料型 `file` 仍拿不到內容且來源不明，維持排除；`contact/files` 端點範圍為聯絡人層級，不得當對話附件清單用。細節見附錄 B |
| 12 | JOIN 後 AI 是否仍自動回覆 | 🟢 已釐清 | JOIN 時預設 Manual（AI 關閉），非預設情況；Hybrid 模式下撞單真實存在，§10.5 只在此模式適用 |
| 13 | ~~訊息發送者身分無法區分~~ | ✅ 已解除 | `from` 前綴判別：`con_`客戶／`u_`真人客服／`pub_`AI，398 則覆蓋率 100%。**未知前綴一律歸 `unknown`，不得預設為 `ai`**——預設成 `ai` 會讓撞單檢查把來源不明的訊息當成 AI 回覆。`pub_` 的內部訊息判斷見 #24 |
| 14 | 知識庫條目時效性 | 🔵 已確認 | `KnowledgeHit.updatedAt` 為 `string \| null`，擷取自檔名的版本片段（啟發式，§12.4 ②）；`null` 時顯示「更新日期未知」、不觸發過舊提醒 |
| 15 | 主管強制介入擋不住官方介面 | ⚪ | 介面誠實標示邊界；`removeTeamMember()` 實際效力待確認（H-4） |
| 16 | 角色權限來源未定 | 🟡 部分解除，尚未定案 | `OrganizationMembership` 帶 `role`（實測 `admin`）／`is_admin`（實測 `false`），可望沿用平台角色。**但兩欄位語意不一致、值域未知（H-5 仍待答）**，「哪個值代表能強制介入他人對話」尚無答案；在那之前 §10.6 的順位 2（設定檔白名單）仍是實際做法 |
| 17 | 無平台層的 structured output 保證 | 🟡 已緩解 | `ai.complete()` 404，改走 agent 路徑：純靠 prompt 實測 4/4 次可直接 `JSON.parse`，仍須自建 Zod 驗證 + 重試 + 降級（§8.2b「JSON 抽取」） |
| 18 | `messageSuggestion` 端點不存在 | 🔵 已確認 | 端點回 404，建議卡完全自建，引用來源從 `RAGknowledge` 工具輸出解析 |
| 19 | **RAG 檢索品質不可調校** | 🔴 已確認，最高優先 | 問「電梯困人」未命中同名 SOP 檔，chunk 大小／top-k／中文斷詞／同義詞全不在我方手上。已列 P0 追問（0-3f）。⚠️ **2026-09-07 起 0-3f 的回覆不再是「換 viki」的觸發器**（§8.2、§18 M3），本期不換；可動的槓桿只剩對方調校 |
| 20 | AI 回應延遲 | 🔵 已確認 | 漸進顯示：**骨架先出、各區塊獨立載入**（3 秒骨架 + 各區塊實質內容門檻，§18 M2）。⚠️ 「建議卡串流顯示」與「提供『重新產生』」已撤銷（`specs/002` FR-023／FR-024／FR-026）：串流與 §11.6 ① 的「顯示前驗證 `sopId`、驗不過整張捨棄」不相容；「重新產生」受 §11.3 版本錨點約束，同一狀態不會產生不同結果 |
| 21 | 客戶資料幾乎是空的 | 🟡 已確認，決策：MVP 拿掉 | `email`／`phone_number`／`company_name` 等填充率皆 0%，`display_name` 是代號非人名。MVP 階段直接拿掉客戶資訊卡 |
| 22 | ~~`messages.list()` 無法過濾對話~~ | ✅ 已解除 | `raw-conversation-id` 策略 precision 100%；`since` 類參數不支援，但訊息由新到舊排序，`limit=N` 即最新 N 則（§9.3） |
| 23 | ~~無法由 API 設定對話 mode~~ | ✅ 已解除 | `POST /v1/team_conversations/_join` 帶 `{team_conversation_id, mode}` 可寫入，與 JOIN 同一端點（§10.6） |
| 24 | workflow 的內部中繼訊息與真正回給客戶的回覆無法區分 | 🔴 已確認，仍是啟發式暫解 | 撞單防護的 `byAi`（§10.4）可能誤把內部訊息當真實回覆，觸發假警報。暫行做法：純 JSON 視為內部訊息並排除（`test/workflow-internal.test.ts`），非規格。已列 P1 追問（H-3c） |

### 19.2 目前最需要收斂的事

| 優先 | 事項 | 為何是它 |
|---|---|---|
| 🔴 1 | **#19 RAG 檢索品質不可調校** | 唯一可能讓「建議卡」整個上不了線的變數。已列 P0 追問；本期不換 viki，槓桿只在對方手上 |
| 🔴 2 | **G-2 rate limit 規格** | M3 的 429 全域佇列、§9.2 輪詢頻率定案都卡在它 |
| 🟠 3 | **#24 workflow 內部中繼訊息判斷** | 撞單防護目前用「純 JSON 視為內部訊息」的啟發式，不是規格 |
| 🟠 4 | **0-4 三個 agent 的推論延遲** | 三條時效門檻的最終判定（M4）繫於此 |
| 🟡 5 | **#11 附件 URL 的時效與授權（H-2d）、H-6c 附件送出流程** | 前者卡 M3 的 vision 管線快取時機，後者卡 Composer 夾帶按鈕 |

**待向 iMBrace 確認的完整清單見 `docs/IMBRACE_QUESTIONS.md`**（可直接轉貼給對方）。
**SDK 靜態分析的完整結果見 `docs/SDK_FINDINGS.md`**。

### 19.3 未完成與已知落差的索引

> ⚠️ **本表只有指標，沒有結論**——同一組證據寫兩個地方，就會有一個先過期。每一項的正典敘述在「正典位置」欄指的章節裡。

| 類別 | 項目 | 正典位置 |
|---|---|---|
| 未達標·已安置（**不是未決**） | 摘要 10 秒、情緒 15 秒、建議卡第一段 20 秒——三項皆未達 90%，門檻一律**不放寬**；成因為平台側 agent 推論延遲、我方槓桿已用盡、已對外回報 0-4、最終判定歸屬 M4 | §18 M2、§18 M4、§8.2b |
| 待拍板（已與里程碑脫鉤） | 分析結果的持久化 ＋ 冷啟動的 50 則上限（同一個立案，涉及隱私姿態） | §11.8 ①③ |
| 卡外部回覆·已安置（M3 剩餘） | 圖片／PDF 的 vision／文件分析（兩條，卡 E-3／H-2d／0-1）；429 全域退避佇列（卡 G-2）。2026-09-08 決定安置、不進 M3.5、不開 007；重啟條件＝對應題目得到回覆 | §18 M3 |
| 進行中 | M3.5「SIT 展示就緒」：image、`deploy/` 單機 compose、SIT 走查；⚠️ 對接的是 `stable` 正式資料 | §18 M3.5、§16.1、§16.5 |
| 不適用（刻意不勾） | 換入 `VikiKnowledgeProvider`（本期不換，與 0-3f 脫鉤）；LEAVE 交接摘要（不實作） | §18 M3、§8.2、§13.4 ② |
| M4 前必須處置 | 分析管線的八份執行期狀態皆為 process-local，**不在 `StateStore` 裡**，換 Redis 涵蓋不到 | §18 M2、§8.3 |
| 未驗證 | 平台清單排序的**分頁邊界**（需要對話數 > 100 的組織）；第一層輪詢的分頁能力（**一起關閉**） | §18 M4 |
| 未實測 | `ETag`／`If-None-Match` 是否可用 | §9.3 ④ |
| 未證實的假設 | 背靠背量測會互相污染（被放棄的呼叫仍在平台側跑）；在證實前量測規程為兩輪之間 ≥30 分鐘冷卻、跨時段 | §8.2b 量測規程 9 |
| 設計張力（非缺陷） | 正式路徑每 6 則切一批，落在分數帶界線上的句子會因批次組成而在 `frustrated`／`angry` 之間移動，示警圖示跟著在 ⚠️ 與 🔥 之間變。這是 prompt 規則「參考同批前後文」的必然代價；固定批次下是穩的 | §8.2b、附錄 C-3 |
| 餘裕正在被吃掉 | 建議卡第二段落定 50 秒的門檻仍通過，但已出現第一次破線；MUST 繼續盯 | §18 M2 建議卡那條 |
| 未建立 | `config/supervisors.yaml`（隨主管接管功能）。`sop.yaml` 不在此列——該路徑已撤銷 | §5、§10.6 |
| UI 缺口 | Composer 的夾帶檔案按鈕（卡在 H-6c，**刻意不放 disabled 佔位鈕**） | §18 M2 |
| 啟發式暫解 | `byAi` 的「純 JSON ＝ 內部訊息」（H-3c）；`updatedAt` 從檔名擷取版本片段（0-3g） | §10.4、§12.4 ② |
| 待對方回覆 | 見 §19.1 風險表與 `IMBRACE_QUESTIONS.md` 待答清單 | §19.1／§19.2 |

---

## 20. 工程慣例

### 20.1 命名與程式碼約束

**兩者的正典都在 [`CONSTITUTION.md`](./CONSTITUTION.md)，本文件不重複列出。**

- 命名慣例（檔案、元件、composable、API 路由、SSE 事件、EventBus topic、分支、commit）→ 憲法附錄 A
- 程式碼約束 → 憲法一至九條

> ⚠️ **不要再在本文件複製一份約束清單。** v1 時期曾有一份編號不同的「八條憲法」，讓程式碼註解裡的條號對不起來（憲法 v2.0.0 廢止）——那正是「多一個地方描述同一件事，就多一個會過期的地方」的實例。

### 20.3 Git

- Conventional Commits，內文說明**為什麼**
- 功能分支 `feat/<milestone>-<slug>`
- 里程碑完成打 tag（`m0-done`、`m1-done`、`m2-done`…），**tag 一旦建立就不移動**；細則見 `CLAUDE.md`

### 20.4 GitHub Spec Kit 導入

**分階段導入，不建議第一天全面套用。**

```
docs/CONSTITUTION.md
        │
        └──▶ .specify/memory/constitution.md   ← 專案憲法

M0 / M1  地基     → 直接開發，不走 Spec Kit（避免儀式成本）
M2 起的功能單元   → 走 /specify → /clarify → /plan → /tasks → /implement
                    · 情緒面板     · 建議卡與一鍵帶入
                    · 知識庫快查   · 結案摘要與人審面板
```

**為何適合**：Spec Kit 的 `/clarify` 階段會強制把規格缺口顯性標記出來。本專案天生就有大量未定規格（見 §19），而每個未定的外部依賴剛好對應一個 provider 介面——很乾淨的切分。

**為何不全套**：M0／M1 本質上是地基，硬寫成 user story 會產生大量儀式性文件卻無對應的決策價值。

**實務提醒**：產出的 `tasks.md` 顆粒度偏細，建議跑完 `/plan` 後人工快速掃過 tasks 再 `/implement`，勿全自動放行。

---

## 附錄 A：本文件的維護

- 架構決策變更時，同步更新 §2 決策摘要與對應章節
- iMBrace 規格確認後，更新 §19 與 `IMBRACE_QUESTIONS.md`，並將對應 provider 從「待實作」改為「已實作」
- Spec Kit 的憲法來源是 `CONSTITUTION.md`（見其附錄 B.4），不是本文件；但本文件的決策變更常會連帶觸發修憲

### 推翻既有結論時的必要步驟

**改動任何實測結論後，必須 grep 舊說法**——同一個結論常散落在決策摘要、詳細章節、里程碑驗收、風險表、對外問題清單多個地方，改完一處容易誤以為全改完了：

```bash
grep -rn "<舊結論的關鍵措辭>" docs/
grep -rn "<舊證據的數字>" docs/
grep -rn "<題號>" docs/IMBRACE_QUESTIONS.md   # 對外文件是否還在問已解決的問題
```

**`IMBRACE_QUESTIONS.md` 要特別小心**——它會離開這個 repo，內容過期不只是不準確，而是浪費對方時間並稀釋其他真正待答問題。自行解決的問題要明確撤回並附上解法，不是默默刪掉。

**`docs/meeting-draft/` 底下的檔案不得被正典文件引用**——那是本機 gitignored 的會議草稿，隨時會變動；正典文件要引用其結論，須把結論本身寫進正典文件，而非連過去。

同類風險也存在於 `docs/DESIGN_TOKENS.md`，但形態不同：那是「衍生文件與外部活動來源（Claude Design 畫布）脫鉤」，具體判斷時機見該文件自己的附錄。

> 本節的摘要版已寫進專案根目錄的 `CLAUDE.md`，會自動載入每個 session 的 context。

---

## 附錄 B：重大決策修訂紀要

曾被推翻的關鍵結論，只留**會被重新提案、或解釋了正文某個數字**的那些；正文只保留最終結論。

**Presence 與 `users[]`（§10.2）**：初版誤判 `Conversation.users[]` 是「該對話的 operator 清單」。第一次量測看到 12/12 全空，其實是量錯位置（`conversations.search()` 輕量 payload 裡本來就是 `null`）；用詳情端點 `get()` 重測後確實有 14 人，但兩個不同對話回傳同一批人，且含 `is_bot: true` 與 `team_user_role: observer`——證實是團隊名冊。若照第一次的「理由」去補救，會走向完全錯誤的「等 webhook 補清單」路線；量測位置錯誤造成的假結論，危險之處不在結論本身，而在它推導出的下一步。

**presence 的其他候選欄位（§10.2）——都測過，都不能用**：`is_joined` 雙向正確，但**是「我」的視角**（以該客服的 token 查詢），看不到同事；`is_agent_joined` **單向黏著**——JOIN 時 `null → true`，LEAVE 後維持 `true` 不回復，代表「曾經有人加入」而非「現在有人在」（兩次獨立實測同向）；`is_presence` 全程 `false`，語意不明。四個候選中只有 `mode` 雙向正確且看得到同事。

**`users[]` 的第二個受害者：發送者判別（§19.1 #13）**：`mappers.ts` 初版靠比對 `users[]` 反推發送者，`users[]` 為空時會把**所有 `u_` 真人客服誤判為 AI**，撞單防護直接失效。已改為 `from` 前綴判別（`senderTypeOf`）。⚠️ 這一項不因「`users[]` 其實有值」而緩解——它是團隊名冊，拿來反推發送者一樣是錯的。

**`mode` 的資料模型（§10.6）**：曾同時存在兩套不相容的定義（`aiReplies`/`agentCanSend` 布林對 vs. `aiMode: 'collab' | 'human_only'` 列舉）。四個 `mode` 值全數實測後，Automation Only 時「AI 會回、客服不能送」證實兩維度互相獨立，單一列舉表達不了。

**對話識別碼（§9.3）**：`precisionOf()` 初版以字串完全相等比對，但對話清單給裸 UUID、訊息帶 `conv_` 前綴，導致「取回 70 則全部正確的訊息」被算成 precision 0%，一度誤判 M1 可能被阻塞。改用 `sameConversation()` 後真實 precision 是 100%。

**`messages.list()` 過濾與增量拉取（風險 #22）**：「無法依對話過濾」是同一個量測錯誤的延伸；但 `since`／`after` 等八種寫法測完後確認真的不支援增量拉取，不是量測問題。

**對話 mode 寫入端點（風險 #23）**：「SDK 無 mode 寫入端點」是錯的——由官方介面的網路請求直接觀察到 `POST /v1/team_conversations/_join` 帶 `mode` 即可寫入，只是 SDK 型別沒有宣告該欄位。

**附件內容可否取得（風險 #11）**：最早只測過 4 則歷史 `file` 型訊息（`content` 只有 `{name, media_id}`），外推到「所有附件都拿不到內容」。之後用真實對話補測 `image`（1 則）與 `pdf`（2 則）後推翻——兩者 `content` 都有直接可用的 url，只是平台不提供描述／OCR，且客戶上傳時連 `caption` 都沒有（只有客服上傳的 PDF 才帶檔名）。過程中發現的非 SDK 公開端點 `/contact/{id}/files` 是在「聯絡人資料」彈窗觸發的，範圍是聯絡人層級，因此明確排除用它列出「當前對話」的附件；`14-contact-files.ts` 的 `H-2f-alt` 已驗證兩者是同一個 channel-service 後端。

**M1「4 秒內看到」的預算從哪來（§18 M1）**：這個數字量的是**客戶回覆**那條路徑——客戶的訊息不經我方 API，只能靠第一層清單輪詢發現（實測 `last_message_at` ≤2 秒更新，端到端約 1 秒）。我方客服送出時 `poke()` 的捷徑（約 40ms）快得多，**不能拿它當驗收依據**。日後調整輪詢頻率，門檻是前者。

**M1 驗收方法論**：原判「兩瀏覽器即時同步」與「斷線補齊」只能靠真實瀏覽器人工驗證。真正需要瀏覽器的只有 `EventSource` 本身（瀏覽器原生，不是我方程式碼），拆開後我方負責的部分全都可自動化：跨 session 的送出與接收、斷線與補齊由 `test/realtime-http.ts` 對建置後的 Nitro 用兩個獨立 cookie jar + `fetch` 手動解析 SSE 驗證；重連時機與退避策略由 `test/nuxt/stream-store.test.ts` 注入假斷線驗證。驗證測試本身也需要被信任——第一項檢查即為「兩位客服是不同的 operator」，避免共用 operatorId 讓 presence 自我排除與撞單過濾被測成假陽性。

**M2「3 秒」的語意（§18 M2）**：原驗收寫「JOIN 後 3 秒內出現摘要與首批建議」，讀起來像要求 3 秒內產出實質內容，而 AI 單次呼叫中位就有 5 秒。經 `specs/001` clarify 收斂為兩條：3 秒衡量「面板已出現並標示分析中」，實質內容另訂門檻（摘要 10 秒、情緒 15 秒、建議卡 20 秒，皆 90 百分位）且允許逐欄漸進填入；切回已 JOIN 的對話時必須先顯示上次保留的結果而非重新 loading。

**純附件輪不產生情緒點（§11.4、§11.5）**：原本只寫「情緒分析只在 `sender.type === 'customer'` 的訊息上產生情緒點」。客戶只傳圖片而不打字時若照樣給分，等於從「上傳檔案」這個中性動作推論情緒——客戶正在生氣時傳一張截圖，走勢會拉出一段看似好轉的折線。已改為純附件輪不產生評分點，只在時間軸留中性標記。⚠️ 這**不**代表附件不必文字化——文字化結果仍是摘要卡的事實來源，只是該管線延後至 M3。

**部署形態（§16.1，2026-09-08）**：§16.1 原本只寫「Docker → K8s」。為 SIT demo 評估時先傾向沿用 viki 的 K8s ＋ Jenkins deploy 路線，理由是「與 SIT 慣例一致、compose 之後要重做」。同日參考 red-ap 後推翻：公司的 SIT 同時存在單機 compose 的先例；image 與 env 鍵清單兩種形態共用，compose 沒有丟棄式工作；對 SI 最少工、對我方掌控度最高的都是 compose。K8s 因此明確歸 M4 多副本。附帶釐清兩個曾被當成「之後再說」的前提：HTTPS 是登入的必要條件而非偏好（cookie `Secure` 為建置期決定），反向代理對 SSE 的緩衝設定是會靜默失效的一級風險。

**`sendTextMessage()` 回應形狀（H-6a，已撤回）**：原評估「送出成功後必須立刻把版本錨點推到新訊息」理由過度陳述。撞單檢查的版本錨點實際取自 `GET /v1/conversation_messages` 的真實訊息 id，與送出端回應無關；唯一可能用到送出回應 id 的 `advanceAnchor()`／`copilotSessionOf()`／`seed()` 匯出後從未被任何呼叫端使用（`server/state/types.ts`、`session-manager.ts` 有註記）。除非有人開始真的依賴 `CopilotSession.lastMessageId`，才需重新評估。

---

## 附錄 C：實測量測數據

> 正文用不到、但重跑一次要花成本的原始量測。**引用前先確認條件仍成立**（模型、system prompt 與平台延遲都會漂移）。模型與 prompt 用 `npm run spike:agent-prompts` 一秒就能確認是否仍是量測當時的那一份；平台延遲沒有這種快照，只能重量。原始輸出在 `scripts/spike/out/`（gitignored，不在本機時以本附錄為準）。

### C-1 情緒 agent 的模型比較（2026-08-28，`spike:agent-latency`，各 n=8，背靠背同一時間窗）

| | `gemma-3-27b` | `gpt-oss-20b`（採用） |
|---|---|---|
| 延遲範圍 | 7850～12666ms | **4743～9210ms** |
| 中位數 | ≈ 10.5 秒 | **≈ 5.4 秒** |
| 最慢 | 12666ms | **9210ms** |
| 距 FR-014 的 15 秒門檻 | 2.3 秒（18%） | **5.8 秒（63%）** |
| schema 合規／標籤正確 | 8/8、8/8 | 8/8、8/8 |
| 輸出決定性 | 連分數都完全一致 | 分數漂移 ±10、drivers 偶爾從缺 |

### C-2 建議卡 agent 的模型比較（2026-08-29，背靠背同一時間窗）

**第一段**（`suggestion`，無知識庫命中，prompt 571 字）：

| | `gemma-3-27b`（採用，n=15） | `gpt-oss-20b`（n=15） |
|---|---|---|
| 中位數 | **9209ms** | 9217ms |
| 平均 | 9540ms | 9131ms |
| 標準差 | **849ms** | **3042ms**（3.6 倍） |
| 最快／最慢 | 8597／**11756ms** | 5216／18130ms |
| p90（nearest-rank） | **10310ms** | 10439ms |
| 10 秒內比例 | **11/15＝73%** | 9/15＝60% |
| 超過 15 秒 | **0/15** | 1/15 |
| schema 合規 | 15/15 | 15/15 |

**第二段**（`suggestion-kb`，帶 3 筆命中，prompt 879 字）：

| | `gemma-3-27b`（採用，n=15） | `gpt-oss-20b`（n=5） |
|---|---|---|
| 中位數 | **10025ms** | 11877ms |
| 最快／最慢 | 9474／**13032ms** | 6822／21204ms |
| 超過 15 秒（整批失敗） | **0/15** | 2/5 |
| schema 合規 | 15/15 | 5/5 |
| 三筆 SOP 全數引用 | **15/15** | **3/5** ⛔ |

⚠️ 這組數據的 n=5 版本給出過兩個錯的結論（gpt-oss 快 32%、gemma 第二段約兩成機率整批失敗），放大到 n=15 後兩個都不成立。gemma 第二段的輸出另外**極度穩定**：15 次全部產出同樣的三張卡、引用同樣三筆 SOP。prompt 長度確實有效（571 字對 879 字＝中位 9209 對 10025ms，約 2.6ms/字）。

**四個 agent 的同日延遲基準**（各 n=15／知識庫 n=12，同一時間窗，模型皆由 API 驗證；知識庫那列取自 004 T032 的 n=10 真實對話）——當時判定 FR-014 15 秒是否放寬的依據：

| agent | 模型 | 中位數 | 最慢 | 距 15 秒門檻 | 合規 |
|---|---|---|---|---|---|
| 摘要 | `gemma-3-27b` | 6286ms | 7646ms | 7.4 秒（49%） | 15/15 |
| 情緒評分 | `gpt-oss-20b` | 4555ms | 9190ms | 5.8 秒（39%） | 15/15 |
| 建議卡・第一段 | `gemma-3-27b` | 9209ms | 11756ms | 3.2 秒（21%） | 15/15 |
| 建議卡・第二段 | `gemma-3-27b` | 10025ms | 13032ms | **2.0 秒（13%）** ⚠️ | 15/15 |
| 知識庫檢索 | `nova-pro` | 11907ms | **22870ms** ⚠️ | （逾時另計 30 秒） | 30 秒涵蓋率 9/10 |

⚠️ 摘要 agent 另曾出現罕見尖峰（42.9 秒、以及一次撞上 SDK 的 30 秒 HTTP 逾時），基準量測沒有重現，但 MUST NOT 據此認定問題已消失。

### C-3 情緒 prompt 改版的離散度（2026-09-01 首測、2026-09-02 重測，`spike:sentiment-dispersion`）

- 起因是「走勢圖分數與顏色變化滿大」的回報。**刻度不穩的猜測被實測推翻**：同一則重測擺動 ≤ 5 分、label 零次翻面、`score` 與 `label` 的分級 18/18 一致。抖動不是雜訊，是模型對某些句子的判斷本來就那樣。
- 逐則孤立判斷下，「好，那我再等等」三次全部判成 85／`calm`，折線成為 `55 → 70 → 55 → 85 → 30 → 10`；改成「參考同批前後文」後該則為 45／`concerned`，最大相鄰落差由 55 分降到 35 分。
- **批次組成的影響（24-B）**：只加上下文、還沒加絕對分數帶時，同一則單獨成批與併入六則批次差到 **25 分**且 label 會翻；補上分數帶與 tie-breaker 之後掉到 **3.6 分**。同一個量測下 `priorPoints`（帶前一批尾端評分）是 **3.6 對 3.9，差距在雜訊內**。
- `frustrated`／`angry` 界線上的句子（「我要申訴，順便問一下解約要怎麼辦」）三次跑出 30／30／10，**擺動 20 分且 label 翻面**——這是補上該條 tie-breaker **之前**的數字。
- **2026-09-02 重測**：24-A 仍 **0/6 翻面**、擺動 ≤ 10 分，24-D 仍 18/18 一致，24-C 3/3 回物件。但 **24-B 的批次邊界平均偏離由 3.6 分升到 11.7 分**，幾乎全部來自同一則界線句子：併入整批 11.7 分（`angry`）、自成一批 37.0 分（`frustrated`），單則偏離 25.3 分；同輪另外兩則只差 4.7 與 5.0 分。
- ⚠️ **24-B 變大並不代表分數帶失效——這個誤讀已經發生過一次。** 當日核對過情緒 agent 的 system prompt 全文：分數帶在、「參考同批前後文」在、兩條 tie-breaker 也在。真正的成因是**規則本身**：prompt 要求判斷某一則時必須參考同批前後文，而 24-B 量的正是上下文敏感度——只要那條規則有效，界線句子的 24-B 就不可能是 0。那句同時命中兩級關鍵詞（「要求投訴或求償」→ `angry`、「威脅離開」→ `frustrated`）。**因果只成立一個方向**：分數帶失效會讓這個數字變大；數字變大卻不足以反推分數帶失效。

### C-4 其他一次性量測

| 量測 | 結果 |
|---|---|
| 平台延遲的時間漂移 | 同模型同輸入，30 分鐘內 7.5 秒 ↔ 10.2 秒（≈ 36%）；40 分鐘後重量，建議卡第二段最慢 12092 → 16891ms（+40%） |
| `POST /ai-agent/chat-client/auth/user`（`spike:userid`，n=20） | 中位 54ms、p90 64ms、最慢 572ms（冷連線）、σ 114ms；**20/20 同一個 id**；傳入 `user_id` 後輸出照常 5/5 |
| 不掛知識庫的 agent 單純回一句話 | 2.6～3.8 秒（對照組：慢的是檢索，不是推論） |
| 8 秒知識庫逾時 | **0/12 命中**（見 §12.4 ②-2） |
| 建議卡第一段原始單次分佈（2026-09-02，`spike:agent-latency -- suggestion 20`，不經 `withRetry()`） | 中位 9.68 秒、最慢 18.42 秒、20/20 在 20 秒內、**2/20 超過 15 秒**（舊設定下會被砍掉重來變成約 26 秒） |

### C-5 摘要 agent 同一天內的三種分佈（2026-08-29、2026-09-01，`spike:agent-latency -- summary <n>`，同一份輸入）

| 量測 | 中位數 | 最慢 | 破 15 秒門檻 | 完全失敗 |
|---|---|---|---|---|
| 2026-08-29 基準（n=15） | 6286ms | 7646ms | 0/15 | 0 |
| 2026-09-01 第一次（n=15） | **52122ms** | 127247ms | **11/15** | **5/15** |
| 2026-09-01 重測（n=6） | 11068ms | 49701ms | 1/6 | 0 |

降級是暫時的（重測就回到 11 秒等級），但也不是回到原狀——11 秒是基準的 1.75 倍。這組數字附在 `IMBRACE_QUESTIONS.md` 0-4。

### C-6 情緒批次：依序 vs. 並行 3（2026-09-01，`spike:progressive -- --repeat 3`，同一組 6 段真實對話，2／6／17／25 則客戶發言）

| 量測 | 第 1 輪（依序） | 第 2 輪（依序） | 第 3 輪（**並行 3**） |
|---|---|---|---|
| 情緒 中位／p90／最慢 | 16.9／27.5／31.0 秒 | 15.9／27.8／30.0 秒 | **7.7／12.7／14.4 秒** |
| 情緒 10 秒內 | 6/15 | 6/14 | 11/15 |
| 摘要 中位／p90／最慢 | 7.6／24.8／45.3 秒 | 10.8／28.7／30.6 秒 | 10.0／49.8／49.9 秒 |
| 摘要 10 秒內 | 8/15 | 5/14 | 6/14 |

⚠️ 同一份報表的「建議卡第一段 p90 28.7／28.8／29.3 秒」與 SC-001 83%／86%／71% **已因口徑缺陷作廢**（§8.2b 量測規程 1），正確值 67%／40%／33%。

| 批次 | 客戶發言 | 依序中位 | 並行中位 | 10 秒內（並行） |
|---|---|---|---|---|
| 1 批 | 2–6 則 | 5.5 秒 | 6.0 秒 | 6/6 |
| 3 批 | 17 則 | 19.2 秒 | **8.1 秒** | 5/6 |
| 5 批 | 25 則 | 27.5 秒 | **12.7 秒** | 0/3 |

並行化的單次呼叫 n=39：中位 6.6 秒、p90 8.3 秒、最慢 11.7 秒、破 15 秒 0 次、失敗 0 次。

**三輪合併（2026-09-02，n=45，門檻 15 秒）依批次數拆解**：

| 批次 | 波數 | n | 中位 | 最慢 | 15 秒內 |
|---|---|---|---|---|---|
| 1 批 | 1 | 9 | 4.6 秒 | 7.6 秒 | **9/9** ✅ |
| 2 批 | 1 | 9 | 8.1 秒 | 12.6 秒 | **9/9** ✅ |
| 3 批 | 1 | 17 | **11.4 秒** | 25.8 秒 | 12/17 ❌ |
| 5 批 | 2 | 9 | **14.7 秒** | 21.2 秒 | 5/9 ❌ |

各列 `n` 加總 44 而非 45：3 批另有 1 筆情緒始終沒回報，進得了合併分母卻算不出中位。情緒單次呼叫三輪合併 n=131：中位 7299ms、p80 9245ms、p90 12584ms、最慢 22851ms、破 15 秒 5 次。

### C-7 並行度：對照實驗與正式掃描

**對照（2026-09-02，`SENTIMENT_CONCURRENCY` 設回 1，同一組六個對話 `--repeat 3`）**——情緒單次呼叫：

| | n | 中位 | p90 | 最慢 | 破 15 秒 |
|---|---|---|---|---|---|
| 並行 3 | 131 | 7299ms | 12584ms | 22851ms | 5 |
| 並行 1 | 42 | 6411ms | 10246ms | 12496ms | 0 |

並行 1 的情緒區塊只有 5/15 ＝ 33%（中位 22.2 秒）；摘要與第一段沒有跟著改善（摘要 ≤10 秒 13/15、第一段中位 11.5 秒 vs 並行 3 的 10.3 秒）。

**正式掃描（2026-09-03 02:56–04:00，`spike:sentiment-concurrency`，`out/26-sentiment-concurrency*.json`，每檔位三輪 n=45，輪換順序 3,4,5／4,5,3／5,3,4，每檔位各開子行程、序列執行；對話為 005 的固定 15 段，`out/005-fixed-conversations.json`）**：

| 檔位 | 區塊總時間（001 SC-005，15 秒 p90） | 中位 | p90 | 最慢 | 未落地 |
|---|---|---|---|---|---|
| **3（現行）** | **41/45 ＝ 91%** ✅ | 7571ms | **14436ms** | 30090ms | 0 |
| 4 | 38/45 ＝ 84% ❌ | 6563ms | 25043ms | 29329ms | 2 |
| 5 | 37/45 ＝ 82% ❌ | 7029ms | 23266ms | 44493ms | 2 |

| 檔位 | 單次呼叫 n | 失敗 | **破 15 秒** | 中位 | p90 | 峰值並發 |
|---|---|---|---|---|---|---|
| **3（現行）** | 106 | **0（0%）** | **4（3.8%）** | 7168ms | **10945ms** | 4 |
| 4 | 109 | 2（1.8%） | 7（6.4%） | 7240ms | 13195ms | 4 |
| 5 | 113 | 1（0.9%） | **12（10.6%）** | 7123ms | 15060ms | 5 |

時段標註（FR-020）：本機凌晨、無平台降級公告，單次中位 7.1～7.2 秒與 2026-09-02 的 7.31／7.32／7.37 秒吻合，非降級樣本。

### C-8 單輪 n=15 的擺動（2026-09-02，本機 10:29／10:58／12:05，`out/21-progressive-citations-*.json`）

| 驗收項 | 第 1 輪 | 第 2 輪 | 第 3 輪 | **合併 n=45** |
|---|---|---|---|---|
| SC-001 首批卡 ≤20 秒 | 14/15 ＝ 93% ✅ | 12/15 ＝ 80% ❌ | 13/15 ＝ 87% ❌ | **39/45 ＝ 87% ❌** |
| SC-005 摘要 ≤10 秒 | 14/15 ＝ 93% ✅ | **8/15 ＝ 53%** ❌ | 11/15 ＝ 73% ❌ | **33/45 ＝ 73% ❌** |
| SC-005 情緒 ≤15 秒 | 11/15 ＝ 73% ❌ | **14/15 ＝ 93%** ✅ | 10/15 ＝ 67% ❌ | **35/45 ＝ 78% ❌** |

第二輪的 3 個失敗樣本集中在該輪第 1 圈的前三個目標（檢索 30 秒逾時、第二段單次實際跑了 102 秒與 48 秒）。排除那 3 筆後（分母 42）：SC-001 39/42 ＝ 93%、摘要 33/42 ＝ 79%、情緒 32/42 ＝ 76%——情緒反而變差，因為那 3 筆的情緒（10.4／14.7／8.1 秒）全部達標。第 3 輪（冷卻 58 分鐘）15 個樣本全部產出建議卡、慢樣本不再叢集。建議卡第二段落定 p90：2026-09-01 三輪 32.8／34.9／43.8 秒；2026-09-02 36.5 秒（42 個落定樣本中 1 個 52.5 秒，3 個從未落定）。

### C-9 延遲與對話長度（2026-09-02，四輪 n=60 依對話則數分組）

| 對話則數 | 摘要中位 | 第一段中位 |
|---|---|---|
| 2 則 | 4.9 秒 | 5.1 秒 |
| **8 則**（＝隔離量測的長度） | **6.2 秒** | **10.3 秒** |
| 33 則 | 8.0 秒 | 11.3 秒 |
| 50 則 | 8.5 秒 | 14.0 秒 |

相關係數：摘要 r ＝ 0.31、第一段 r ＝ 0.48。相同長度（8 則）下隔離與管線幾乎一致：第一段隔離中位 9.7 秒 vs 管線 10.3 秒；摘要隔離 5.2 秒 vs 管線 6.2 秒。摘要隔離量測 19/20 ＝ 95%（`spike:agent-latency -- summary 20`）對端到端 73%。

### C-10 杜撰引用：封閉清單前後（2026-09-03 02:08–02:53，`spike:citation-quality`，固定 15 段 × 3 輪；分母 ＝ `hitCount > 0` 且 `outcome ∉ {no-cards, failed}`）

| | 分母 | 含杜撰的生成 | 杜撰率 | 杜撰字串總數 | 卡片級捨棄率 | 最終取得引用 |
|---|---|---|---|---|---|---|
| 基線（改 prompt 前） | 43 | 9 | **21%** | 13 | 11.1%（104/117） | 84%（38/45） |
| 封閉清單（改 prompt 後） | 42 | 9 | **21%** | 12 | 9.8%（111/123） | 82%（37/45） |

逐對話分布：基線是 5 段對話貢獻全部杜撰、另外 10 段一次都沒有（最高那段 3/3）；改動後變成 8 段各 1～2 次。n=3／段，變化在雜訊內。
