# AgentCopilot 開發指引

> iMBrace 平台 Conversations 模組的即時客服輔助擴充
>
> 版本：v1.0 ｜ 制定日期：2026-08-24 ｜ 狀態：M1 完成，M2 進行中
>
> 本文件只保留**目前有效**的架構決策與規格。實測過程中被推翻的推論、
> 逐步修正的敘事，已集中收攏至文末**附錄 B：重大決策修訂紀要**，正文不重複。

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
| 交接／結案摘要 | LEAVE 或結案時自動產生摘要，人審後寫入 Data Board |

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
| 多對話 | **分頁籤切換，背景持續監控但只跑輕量分析** | 完整 AI 分析僅在前景聚焦的對話執行，成本自然收斂 |

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
| 狀態管理 | Pinia | `auth` / `conversations` / `sessions` / `presence` |
| 樣式 | Tailwind CSS v4 | |
| 元件庫 | Nuxt UI | v4 起 Pro 已併入主套件，125+ 元件全免費 MIT，商用無需額外授權 |
| 圖示 | `@nuxt/icon` + Lucide | 按需載入 |
| 深色模式 | `@nuxtjs/color-mode` | Nuxt UI 內建 |
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

> 未實作去重的後果：面板閃爍兩次、AI 分析重複執行（成本翻倍）、presence 出現重複項目，且極難追查，務必在 M1 就處理。

---

## 5. 目錄結構

```
AgentCopilot/
├── nuxt.config.ts
├── app/
│   ├── layouts/
│   │   ├── default.vue              # 登入／選組織頁（未進工作區前）
│   │   └── console.vue              # 頂欄 + 側欄 + 三欄工作區
│   ├── pages/
│   │   ├── login.vue                # ①寄 OTP → ②驗證 OTP（見 §7.1）
│   │   ├── organization.vue         # ③選擇組織 —— 一律顯示，即使只有一個
│   │   ├── index.vue                # 對話列表
│   │   └── c/[conversationId].vue   # 主工作區
│   ├── components/
│   │   ├── conversation/
│   │   │   ├── MessageList.vue      # 虛擬滾動訊息流
│   │   │   ├── MessageBubble.vue
│   │   │   ├── Composer.vue         # 輸入框 + 送出前撞單檢查
│   │   │   └── PresenceBar.vue      # 誰在看／誰在輸入
│   │   ├── copilot/
│   │   │   ├── SummaryCard.vue
│   │   │   ├── SentimentGauge.vue   # 手刻 SVG sparkline
│   │   │   ├── SuggestionList.vue
│   │   │   ├── SuggestionCard.vue   # 含「一鍵帶入」
│   │   │   ├── KnowledgeSearch.vue  # inline 面板
│   │   │   └── ClosurePanel.vue     # 結案摘要人審面板
│   │   └── common/
│   ├── composables/
│   │   ├── useCopilotStream.ts      # SSE 連線 + 自動重連 + 重連後對帳（§9.5）
│   │   ├── useCopilotSession.ts     # 單一對話的 copilot 狀態
│   │   ├── usePresence.ts
│   │   └── useDraft.ts              # 草稿保存於 localStorage
│   └── stores/
│       ├── auth.ts
│       ├── conversations.ts
│       ├── sessions.ts
│       └── presence.ts
├── server/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── otp.post.ts          # client.requestOtp(email)
│   │   │   ├── login.post.ts        # client.loginWithOtp() → 回傳 organizations[]
│   │   │   ├── organization.post.ts # 手動 exchange（保留 refresh_token）
│   │   │   ├── me.get.ts
│   │   │   └── logout.post.ts
│   │   ├── conversations/
│   │   │   ├── index.get.ts         # list / search
│   │   │   ├── [id].get.ts
│   │   │   ├── [id]/join.post.ts
│   │   │   ├── [id]/leave.post.ts
│   │   │   └── [id]/status.patch.ts
│   │   ├── messages/
│   │   │   ├── index.get.ts         # 支援 since=<messageId> 增量拉取
│   │   │   └── index.post.ts        # 送出（含撞單檢查）
│   │   ├── copilot/
│   │   │   ├── analyze.post.ts      # 手動重新分析
│   │   │   ├── knowledge.post.ts    # 自然語言快查
│   │   │   ├── handover.post.ts     # 交接摘要
│   │   │   └── closure.post.ts      # 結案摘要（產生 / 確認寫入）
│   │   ├── presence.post.ts         # 上報 viewing / composing
│   │   ├── stream.get.ts            # SSE
│   │   ├── health.get.ts
│   │   └── hooks/
│   │       └── imbrace/
│   │           └── conversation.post.ts   # webhook 收口
│   ├── sources/
│   │   ├── types.ts                 # Provider 介面定義
│   │   ├── conversation-list-poller.ts  # 第一層：清單輪詢（§9.3.1）
│   │   ├── polling-message-source.ts
│   │   ├── webhook-event-source.ts  # 骨架先備好
│   │   ├── message-fetch.ts         # 取數策略（raw-conversation-id，§9.3）
│   │   ├── mappers.ts               # 防腐層：識別碼正規化、發送者判別、附件
│   │   ├── agent-knowledge-provider.ts  # M2（§8.2）
│   │   └── static-sop-provider.ts
│   ├── services/
│   │   ├── imbrace.ts               # SDK client factory（依 session token）
│   │   ├── session-manager.ts       # CopilotSession 生命週期 + refcount
│   │   ├── board-repository.ts      # Data Board 讀寫（冪等）
│   │   └── ai/
│   │       ├── summarize.ts
│   │       ├── sentiment.ts
│   │       ├── suggest.ts
│   │       ├── closure.ts
│   │       └── prompts/             # prompt 集中管理，與程式邏輯分離
│   ├── state/
│   │   ├── types.ts                 # StateStore / EventBus 介面
│   │   ├── memory-store.ts
│   │   ├── memory-bus.ts
│   │   ├── redis-store.ts           # M4
│   │   └── redis-bus.ts             # M4
│   ├── utils/
│   │   ├── session.ts               # cookie session
│   │   ├── signature.ts             # webhook HMAC 驗簽
│   │   ├── dedupe.ts                # event 去重
│   │   └── retry.ts                 # 指數退避
│   └── middleware/
│       └── auth.ts
├── shared/
│   └── types/
│       ├── copilot.ts               # AI 輸出契約（前後端共用）
│       ├── conversation.ts
│       └── events.ts                # SSE 事件型別
├── config/                          # ⚠️ 三個檔案皆尚未建立，隨對應功能一起產生
│   ├── sop.yaml                     # StaticSopProvider 資料（M2）
│   ├── categories.yaml              # 結案分類受控詞彙（M3）
│   └── supervisors.yaml             # 主管 email 白名單（隨主管接管功能）
└── docs/
    ├── ARCHITECTURE.md              # 本文件
    ├── IMBRACE_QUESTIONS.md         # 待向 iMBrace 確認的清單
    └── CONSTITUTION.md              # Spec Kit 憲法
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

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-08-24',

  // SPA 模式，但保留完整 Nitro server
  ssr: false,

  nitro: {
    preset: 'node-server',
  },

  modules: [
    '@nuxt/ui',
    '@nuxt/icon',
    '@nuxtjs/color-mode',
    '@nuxtjs/i18n',
    '@pinia/nuxt',
    '@vueuse/nuxt',
  ],

  i18n: {
    defaultLocale: 'zh-TW',
    locales: [{ code: 'zh-TW', file: 'zh-TW.json' }],
    strategy: 'no_prefix',
  },

  runtimeConfig: {
    // ⚠️ 以下僅存在於 server，絕不可移入 public
    imbraceApiKey: '',
    imbraceOrganizationId: '',
    sessionSecret: '',
    webhookSecret: '',
    aiApiKey: '',
    redisUrl: '',

    public: {
      appName: 'AgentCopilot',
      imbraceEnv: 'stable',
    },
  },

  // ⚠️ 實際的 nuxt.config.ts 是 `typeCheck: false`，不是筆誤——本專案路徑含空白
  //    （`03 FE products`），vue-tsc 的路徑處理會出錯。型別檢查改由 build script
  //    串接（`npm run typecheck`），並未放鬆，理由詳見 nuxt.config.ts 的註解。
  typescript: { strict: true, typeCheck: false },
})
```

> **`ssr: false` 的常見誤解**：這不等於靜態網站。只要用 `nuxt build`（而非 `nuxt generate`）並以 `node .output/server/index.mjs` 啟動，`server/api/**` 的所有路由完全正常運作。你得到的是「SPA 前端 + 完整 Node BFF」。

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
  id: string
  /** 顯示用的條目編號，如 SOP #12 */
  code: string
  title: string
  snippet: string
  /** 檢索分數（非模型自評）。iMBrace 路徑無分數來源，一律為 null；
   *  換上 viki 的 answer-attribution 後才會有值。UI 依 null 與否決定顯示與否，不得估算填充 */
  score: number | null
  /** 條目最後更新日期，介面需顯示；過舊條目應標示提醒 */
  updatedAt: string
  sourceRef: { type: 'knowledge' | 'docIQ' | 'board' | 'static'; ref: string }
}

export interface KnowledgeProvider {
  search(query: string, opts?: { topK?: number; channel?: string }): Promise<KnowledgeHit[]>
}
```

**實作優先序**：第一階段採 `AgentKnowledgeProvider`（iMBrace）。是否換成 `VikiKnowledgeProvider` 取決於 iMBrace 對 RAG 檢索品質的回覆（`IMBRACE_QUESTIONS.md` §0-3f），不是時程排定的第二階段，見 `PLATFORM_CAPABILITY.md` §6。

| 順位 | 實作 | 狀態 |
|---|---|---|
| 1 | `AgentKnowledgeProvider` | ✅ **M2 採用** —— 透過掛載 Knowledge Hub 的 AI Agent 查詢。可取得引用來源（檔名＋chunk 原文），但 `score` 恆為 `null` |
| 備援 | `VikiKnowledgeProvider` | 🟡 介面已預留，未實作——若 #19 RAG 品質調不動，換上此實作即可取得真實 `score`，介面不用改 |
| 備案 | `BoardsSearchProvider` | 🟡 未採用——`boards.search()` 為 Meilisearch 相容關鍵字檢索，有條目 ID，屬關鍵字非語意 |
| 開發期 | `StaticSopProvider` | ✅ 讀 `config/sop.yaml`（尚未建立，M2），開發期與離線 fallback |
| — | ~~`BoardsRagProvider`~~／~~`LocalVectorProvider`~~ | ❌ 已撤銷——`processEmbedding()` 之後無檢索 API；`ai.embed()` 回 404 |

> 無論最終選哪一條，`KnowledgeProvider` 介面本身不變——這正是抽象層的目的：外部能力邊界未定時，開發不必停下來等。

### 8.2b AI 推論（摘要／情緒／建議卡）

與知識庫檢索同理，摘要、情緒分析、建議卡生成也收斂到單一介面，讓 iMBrace AI Agent 與 viki 的切換只需換一個實作：

```ts
export interface AIProvider {
  summarize(input: { history: Message[]; previousSummary?: ConversationSummary }): Promise<ConversationSummary>
  analyzeSentiment(input: { messages: Message[] }): Promise<SentimentPoint[]>
  suggest(input: { history: Message[]; knowledgeHits: KnowledgeHit[] }): Promise<SuggestionCard[]>
}
```

| 順位 | 實作 | 狀態 |
|---|---|---|
| 1 | `ImbraceAgentProvider` | ✅ **M2 採用** —— 呼叫 `aiAgent.streamChat`，結構化輸出靠 prompt（4/4 次可 `JSON.parse`），Zod 驗證 + 重試 + 降級不可省（見 §11.7） |
| 開發期 | `MockAIProvider` | ✅ M2 UI 先行完成用，回傳固定樣本資料 |
| 備援 | `VikiAIProvider` | 🟡 介面已預留，未實作——打 viki public API，`SuggestionCard.confidence` 會開始有真實值 |

> `AIProvider` 與 `KnowledgeProvider` 合起來，是「所有 AI 相關外部依賴」的唯一收斂點——不管未來走 iMBrace 還是 viki，上層都不用重寫。

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
3. 並發控制——同時 in-flight 請求上限 5
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
> 輪詢仍不是瓶頸，AI 呼叫才是——實測 AI 單次呼叫中位數 5.0 秒、最慢 12.2 秒，見 §11.2。

對應追問項見 `IMBRACE_QUESTIONS.md` B-2、G-2。

### 9.4 換成 webhook 後仍要保留對帳輪詢

Webhook 會漏、會亂序、會重送。生產環境必須保留低頻對帳輪詢（每 30s），比對本地 `lastMessageId` 與遠端，補上遺漏的訊息。省略此機制的後果是「偶爾少一則訊息」——最難重現、最難追查的一類 bug，務必在 M4 一併實作。

### 9.5 SSE 契約

正典為 `shared/types/events.ts`。M1 已實作的部分：

```ts
export type CopilotEvent =
  | { type: 'session.opened';      conversationId: string; reason: 'join' | 'resume' }
  | { type: 'session.closed';      conversationId: string; reason: 'leave' | 'resolved' }
  | { type: 'messages.appended';   conversationId: string; messages: Message[] }
  | { type: 'presence.updated';    conversationId: string; presence: PresenceSnapshot }
  | { type: 'control.updated';     conversationId: string; control: ConversationControl }
  | { type: 'conversation.updated';conversationId: string; lastMessageAt?: string }
  | { type: 'stream.heartbeat';    at: string }
  // M2 加入：summary.updated / sentiment.appended / suggestions.updated / analysis.failed
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
  // → [仍要送出] [捨棄] [重新產生建議]
} else if (byAi.length > 0) {
  // 「AI 在 2 秒前已自動回覆，請確認內容是否衝突」
  // → [仍要送出] [捨棄] [重新產生建議]
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
| **增量** | 新訊息，debounce 1s | 既有摘要 + 新訊息（不重送歷史） | 摘要 patch、追加情緒點、重算建議 |
| **不觸發** | 客服自己送出的訊息 | — | 僅更新畫面訊息流 |
| **手動** | 使用者點「重新分析」 | 全量 | 全部重算 |

### 11.2 前景／背景分級（成本控制的核心）

```
前景聚焦的對話  → 完整 pipeline：摘要 + 情緒 + 建議生成 + 知識庫檢索
背景對話        → 僅輕量情緒分類，產出徽記提醒
                  不生成建議卡、不查知識庫
切換至某背景對話 → 先顯示上次保留的結果，再補跑一次完整分析（補跑期間標示「更新中」，不得留白）
```

**使用者看不到的東西不需要即時算好。** 成本自然收斂到「同時只有一個對話在跑完整 AI」。另設背景 session 上限（建議 10），超過者只累積訊息計數，不做任何分析。

### 11.3 快取

快取鍵 `{conversationId}:{lastMessageId}`。同一狀態不重複呼叫模型。

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
 * 附件仍須文字化並納入摘要卡的事實來源（規格 FR-013，2026-08-26：實作延後至 M3，見 §18）。
 *
 * ⚠️ **2026-08-26 訂正**（specs/001-sentiment-panel 落地時新增）：情緒時間軸的型別
 * 不是單純的 `SentimentPoint[]`，而是 `SentimentTimelineEntry[] = SentimentPoint | SentimentMarker`
 * 的判別聯集——`kind` 為判別欄位。原因見 specs/001-sentiment-panel/research.md #3：
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
  intent: string                // 客戶主要意圖
  keyFacts: string[]            // 已確認的事實（如「已重啟設備 ×3」）
  attempted: string[]           // 已嘗試但無效的處理
  openIssues: string[]          // 尚未解決的點
  riskFlags: Array<'churn' | 'escalation' | 'compliance' | 'vip' | 'repeat_contact'>
  advice: string                // 一句話行動建議
  updatedAt: string
  basedOnMessageId: string      // 版本錨點，用於增量與快取
}

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

/** 交接摘要（LEAVE 觸發，對話仍進行中） */
export interface HandoverSummary {
  conversationId: string
  operatorId: string
  periodStart: string
  periodEnd: string
  whatIDid: string[]
  currentState: string
  nextActions: string[]
  cautions: string[]            // 下一位接手者要注意的地雷
}

/** 結案摘要（updateStatus → resolved 或手動觸發，寫入 Data Board） */
export interface ClosureSummary {
  conversationId: string
  channel: string
  contactId: string
  operators: string[]
  joinedAt: string              // 對應 Board 的 joined_at
  closedAt: string              // 對應 Board 的 closed_at
  summary: string
  intent: string
  category: string              // 受控詞彙，見 config/categories.yaml（尚未建立，M3）

  // ── 以下三項對應介面上的三個標籤（意圖／處理結果／情緒結果）──
  resolution: 'resolved' | 'workaround' | 'escalated' | 'unresolved' | 'customer_abandoned'
  /** 實際採取的行動，與 resolution（狀態）分開。如「已建立工單」「已派工」 */
  actionsTaken: string[]        // 受控詞彙
  /** 情緒結果的語意標籤，供介面直接顯示 */
  sentimentOutcome: 'appeased' | 'satisfied' | 'still_negative' | 'escalated'

  // ── 數值供報表統計使用，不直接顯示於介面 ──
  sentimentStart: number
  sentimentEnd: number
  sentimentTrough: number       // 全程最低點——需以全量評分點計算，不可只取 sparkline 繪出的最近 N 點（§14.6）

  citedSopIds: string[]
  followUps: Array<{ action: string; owner?: string; dueHint?: string }>
  confidence: number
  reviewedBy: string | null     // 未經人審為 null
  reviewedAt: string | null
}
```

### 11.6 Prompt 設計四條硬規則

**① 建議卡的 `sopId` 不得杜撰。** 流程必須是：先檢索知識庫 → 將 `KnowledgeHit[]` 作為上下文提供給模型 → 要求 `sopId` 只能自 hits 的 id 中選擇 → 後端再驗證一次，不在白名單者直接丟棄該卡。僅靠 prompt 交代是不夠的，必須有程式層的後驗。

**② `confidence` 不得由模型憑空給定，沒有真實依據時必須是 `null`，不得估算填充。** 有檢索分數時應為 `confidence = f(檢索分數, 模型自評, 上下文完整度)` 並於後端校準。若 `KnowledgeHit.score` 為 `null`（目前的 iMBrace 路徑就是如此），`confidence` 必須整體為 `null`，不得用模型自評頂替。UI 依此欄位是否為 `null` 決定顯示或留空——這讓 AI 來源從 iMBrace 換成 viki（`answer-attribution` 提供真實分數）時，`confidence` 自然開始出現數值，不需要另外改介面。**寧可留空，也不要顯示一個沒有依據的數字**——信心度一旦失準，客服很快就會學會忽略它，整個功能即告廢棄。

**③ 增量分析回傳 patch，不回傳全量。** 送 `previousSummary + newMessages`，要求僅回傳變動欄位，除了省 token，也避免摘要每次被整段重寫導致畫面一直跳動。

**④ 事實不得推測。** 明確禁止模型編造工單編號、時間、金額、政策內容。`requiresData` 欄位即為此設計：模型察覺自身缺乏資料時應標示出來，交由客服填寫。

### 11.7 其他約束

- 全部使用 **structured output / tool use**，**絕不解析自由文字**
- 所有輸出以 **Zod schema 驗證**後才進入系統
- `category` 使用**受控詞彙**（`config/categories.yaml`，尚未建立，M3），不得由模型自由生成
- 輸出語言為繁體中文，語氣須符合客服規範
- 溫度設低（建議 0.2–0.3）

---

## 12. 知識庫

### 12.1 現況

iMBrace SDK 文件中沒有 Knowledge / DocIQ 的查詢 API——`reference/` 底下僅有 ai-agent、workflow、board、campaign、communication、channel、contact；`sdk/document-ai/` 是抽取導向（`processDocument()` 從 PDF 抽結構化欄位），非檢索導向，無語意搜尋、無章節 ID、無信心度。而建議卡上「SOP 3.2 安撫圓場｜信心度 92%」這種呈現，必須有能回傳條目 ID 與分數的檢索 API 才能實現。

### 12.2 因應方式

架構上以 `KnowledgeProvider` 隔離（見 §8.2）。**候選路徑（`AgentKnowledgeProvider` 為 M2 實作，其餘為備援）**：

| 路徑 | 狀態 | 說明 |
|---|---|---|
| 掛 Knowledge Hub 給 AI Agent 再問它 | ✅ **M2 採用** | 平台已有 311 個 RAG 檔案、20 個 Knowledge Hub。可取得引用來源，但取不到分數（§0-3c 仍待 iMBrace 回覆） |
| `VikiKnowledgeProvider` | 🟡 介面已預留，未實作 | viki 前端先建好知識庫與 AI 助理後，打其 public API 即可取得回覆，`answer-attribution` 附帶真實分數。若 #19 RAG 品質調不動，換上此實作即可 |
| `boards.search(boardId, {q, filter, limit})` | 🟡 備案，未採用 | Meilisearch 相容關鍵字檢索，有條目 ID，屬關鍵字非語意 |
| `StaticSopProvider` | ✅ 開發期 | 讀 `config/sop.yaml`（尚未建立，M2），離線 fallback |
| ~~自建向量檢索~~ | ❌ 已排除 | 依賴的 `ai.embed()` 回 404 |

無論分數取不取得到，介面上的「信心度」欄位都不拿掉——`KnowledgeHit.score` 與 `SuggestionCard.confidence` 皆為 nullable，iMBrace 路徑無分數時 UI 留空，換上 viki 後自然回填有值（見 §8.2、§11.6②）。但**引用來源（SOP 編號）不可省**，否則憲法 4.3（`sopId` 白名單後驗）失去依據，模型將可能杜撰不存在的 SOP，此為產品品質的底線。無論最終選哪一條，替換 provider 即可，上層不動。

### 12.3 知識庫快查 UX

依 `demo_agentCopilot02.png`，快查是**右欄中的常駐 inline 面板**，而非彈出式 Command Palette：

```
┌─────────────────────────────────────────┐
│  知識庫自然語言快查                       │
│  ┌───────────────────────────────────┐  │
│  │ 🔍 訊號異常代碼 重複斷線           │  │
│  └───────────────────────────────────┘  │
│  訊號強度異常代碼對照表   SOP #12 · 2026/05│
│  重複斷線客訴優先工單建立流程 SOP #47 · 2026/03│
└─────────────────────────────────────────┘
```

**採 inline 而非 modal 的理由**：客服不需離開對話視線即可查詢，modal 會遮蔽訊息流與建議卡。

**設計要點**：結果顯示 `title` + `code` + `updatedAt`，不顯示分數（分數只用於排序）；條目過舊（建議門檻 12 個月）標示提醒；結果可「插入為回覆」或「展開全文」；輸入需 debounce（建議 300ms）。

**第一版只做 inline 面板。** `Ctrl/Cmd + K` 的 Command Palette 可作為後續增強，非必要功能。

---

## 13. Data Board 持久化與結案摘要

### 13.1 分層原則

> **Data Boards 是 CRM 資料庫，不是低延遲 KV。高頻寫入會出問題。**

| 資料 | 存放位置 | 理由 |
|---|---|---|
| Session 狀態、輪詢游標、presence | 記憶體 → Redis | 高頻讀寫、可重建、重啟即棄無妨 |
| 情緒逐輪分數（進行中） | 記憶體 → Redis | 每則訊息都在變，寫 Board 會打爆 API |
| **結案／交接摘要** | **Data Board** | 業務資產，需可查詢與製作報表 |
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
| `conversation_id` | text（**唯一鍵**） | 冪等寫入的依據 |
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
| `sentiment_start` / `sentiment_end` / `sentiment_trough` | number | 供報表統計，不直接顯示於介面 |
| `cited_sops` | text[] | |
| `follow_ups` | long text（JSON） | |
| `confidence` | number | |
| `reviewed_by` | text | 未經人審為空 |
| `reviewed_at` | datetime | |

> 欄位需先透過 `createField()` 在平台上建立。建議寫一支一次性 setup script 置於 `scripts/`，讓環境可重建。
>
> ⚠️ 本表與 §11.5 的 `ClosureSummary` 必須逐欄對得上——少建一欄不會報錯，只會讓該維度在報表裡永遠是空的。

**欄位對照**：`operators`／`summary`／`intent`／`category`／`resolution`／`actions_taken`／`sentiment_outcome`／`sentiment_start|end|trough`／`cited_sops`／`follow_ups`／`confidence`／`reviewed_by|at` 一一對應 `ClosureSummary` 的同名欄位（camelCase → snake_case）；`joined_at`／`closed_at` 對應 `joinedAt`／`closedAt`。

### 13.4 三個設計陷阱

**① AI 產物寫入正式 CRM，必須經人審。** 摘要生成後先進入可編輯的確認面板（`ClosurePanel.vue`），客服修改確認後才 `createItem()`。若確實需要「LEAVE 自動觸發寫入」，必須標記 `reviewed_by = null`，使其可於事後被稽核篩出。

**② LEAVE ≠ 結案。** 多客服情境下，你 LEAVE 了但其他人仍在，因此拆成兩種產出：

| 類型 | 觸發 | 內容 |
|---|---|---|
| **交接摘要** `HandoverSummary` | LEAVE | 我這段處理了什麼、下一位要接什麼——對話仍進行中 |
| **結案摘要** `ClosureSummary` | `updateStatus()` → resolved，或手動按鈕 | 完整的意圖／分類／處理結果／情緒起訖／後續動作 |

兩者 schema 不同，不可混用。

> 「手動按鈕」不限於獨立的結案按鈕——也可以是 LEAVE 流程中「同時結束對話」的選項（例如客服按下 LEAVE 時，UI 詢問是否一併結案）。無論哪種 UI 呈現，只要目的是把該對話標記為已結束，就走同一條 `updateStatus() → resolved` 路徑與同一份 `ClosureSummary` schema；若設計成緊跟著 LEAVE 自動觸發（不經額外詢問），仍必須依①標記 `reviewed_by = null` 供事後稽核。

**③ 冪等。** 同一對話重複產生摘要必須覆蓋而非新增。以 `conversation_id` 為唯一鍵，寫入前先 `search()`，再決定 `createItem` 或 `updateItem`。

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

> 右欄的五個區塊以 §14.1.1 為準，本圖與該節必須一致。**「AI 轉接摘要」不在右欄**——依 demo 對照它屬於左欄（見 `PLATFORM_CAPABILITY.md` §2）。
>
> 右欄現已有正式設計稿（畫布 artboard **2a**，逐字規格見 `DESIGN_TOKENS.md` §7）：展開態寬度 380px（可拖曳 320–520px）、五區塊皆可折疊、支援載入骨架與「準備結案」收合態。

### 14.1.1 右欄的區塊與捲動

依 `demo_agentCopilot02.png`（後由畫布 artboard 2a 確認，見 `DESIGN_TOKENS.md` §7.2），右欄自上而下共五個區塊：① 客戶情緒提示（處理中最常看）② AI 語意即時建議（處理中最常用）③ 知識庫自然語言快查（隨時可能用）④ AI 階段完整對話紀錄（可折疊，偶爾回顧）⑤ 結案摘要自動填入（只在結案時使用）。

> ✅ **2026-08-26 已由設計稿定案，以下「問題／建議做法」段落已解決，保留是為了記錄決策脈絡**：
> 2a 採用的是「區塊可折疊」+「階段感知」的組合，不是兩者擇一——五區塊平時各自可折疊；一旦偵測到「準備結案」，
> 其餘四區塊自動收合成單行，只留 ⑤ 結案摘要維持展開可編輯（不是把 ⑤ 置頂，是收合其他區塊讓 ⑤ 顯眼）。
> 細節（含「進行中」與「準備結案」兩種狀態的逐項行為）見 `DESIGN_TOKENS.md` §7.4。折疊狀態是否要記憶到
> `localStorage`，設計稿未規範，仍是開發端判斷。

<details>
<summary>下方為決策前的原始問題記錄（已解決，僅供脈絡參考）</summary>

**問題**：全部展開後右欄很長，「處理中」與「結案中」需要的區塊完全不同。**建議做法**（開發階段擇一）：區塊可折疊 + 記憶折疊狀態（實作簡單，先做這個），或階段感知排序（JOIN 中 → ①②③ 優先；按下「準備結案」→ ⑤ 置頂）。

</details>

### 14.1.2 AI 階段完整對話紀錄

此區塊將 JOIN 之前 AI 與客戶的往來以高密度形式呈現，供客服快速回顧。標題列顯示總則數（可折疊）；每則標示發送者（客戶／AI／客服），依 `Message.sender.type` 判斷；附件呈現：`image`／`pdf` 顯示縮圖或檔案圖示＋vision／文件分析產生的描述（`caption` 不可靠，見 §11.4），舊資料型 `file` 僅顯示檔名＋「無法預覽」，語音無適用對象；此區塊與中欄訊息流資料來源相同，僅呈現密度不同，不需額外 API。

> ⚠️ **不可用 JOIN 時間點做「AI 階段 / 真人階段」的分段。** JOIN 之後 AI 仍持續運作（見 §10.5），真正的分界是 `mode` 切換為 `manual` 的時刻。**正確做法**：以每則訊息各自的 `sender.type` 標示，時間分段僅作為輔助視覺提示。

### 14.2 多對話切換

側欄列出所有已 JOIN 的對話，每個都有獨立 `CopilotSession` 在背景運作；未聚焦的對話若有新訊息或情緒惡化，顯示徽記提醒；背景對話僅跑輕量情緒分類（見 §11.2）。

### 14.3 設計基調

參考 `docs/demo_agentCopilot01.png`：clean SaaS 風——藍色主色、白底卡片、大圓角、清楚的區塊標題。情緒色階：綠 → 黃 → 橙 → 紅。卡片：白底 + 細邊框 + 輕微 elevation。

### 14.4 無障礙：情緒不可只靠顏色表達

> ⚠️ 約 8% 男性有紅綠色覺辨識困難。若「焦慮偏高」只用紅色線條表示，對他們就是資訊遺失。

**情緒狀態必須同時具備：顏色 + 圖示 + 文字標籤。** demo 圖右上的「⚠ 焦慮偏高」標籤做法是正確的，必須保留。其他要求：所有互動元素可鍵盤操作、「一鍵帶入」提供鍵盤快捷鍵、文字對比度符合 WCAG AA。

### 14.5 情緒 Sparkline

手刻 SVG，不引圖表庫：

```vue
<!-- SentimentGauge.vue 概念 -->
<svg :viewBox="`0 0 ${w} ${h}`" preserveAspectRatio="none">
  <polyline
    :points="points"
    fill="none"
    :stroke="strokeByLatestScore"
    stroke-width="2"
    stroke-linecap="round"
  />
</svg>
```

資料量小（每輪一點），效能無虞；深色模式只需換 CSS 變數；新點加入時做平滑過渡動畫；搭配文字說明。

### 14.6 效能

訊息流使用虛擬滾動（`useVirtualList`）；建議卡數量上限 3–5 張，超過需捲動；情緒 sparkline 僅**繪製**最近 50 點（specs/001-sentiment-panel FR-015 已定案，非僅建議值）。

> ⚠️ 「只畫 50 點」不等於「只留 50 點」。評分點本身必須全數保留——`ClosureSummary.sentimentTrough` 要的是**全程**最低點，若只留最近 50 點，它會安靜地算成「近期最低點」，而且要到 M3 寫進 Data Board 之後才會被發現。保留成本極低（每點只有分數、標籤與幾個關鍵詞），真正昂貴的是產生它的 AI 呼叫，那筆錢已經花了。詳見 `specs/001-sentiment-panel/spec.md` FR-015。

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
| AI 分析失敗 | 暫時性失敗（單次呼叫逾時 15s／5xx）先指數退避自動重試最多 2 次（1s → 4s）、總預算 40 秒，區塊顯示「重試中 (n/2)」；**429 不在此列**（見下方 Rate limit 列）；其餘錯誤（含 Zod 驗證失敗）或重試用盡後顯示「暫時無法分析 [重試]」。其他區塊照常運作。數值定案見 `specs/001-sentiment-panel/spec.md` FR-014 | ❌ 否 |
| 知識庫失敗 | 建議卡降級為無 SOP 引用的通用建議，並明確標示「未引用知識庫」 | ❌ 否 |
| SSE 斷線 | 指數退避重連（1s → 30s）；重連後以本地 `lastMessageId` 對帳補齊（不靠 `Last-Event-ID`，見 §9.5）；斷線期間切 HTTP 輪詢 fallback | ❌ 否 |
| Token 過期（401） | 清 session 導回登入，URL 保留 `conversationId`，登入後回到原處 | ✅ 是（但無痛） |
| Rate limit（429） | **目標狀態**：全域退避 + 佇列，禁止重試風暴。**M2 現況**：rate limit 書面規格未到（`IMBRACE_QUESTIONS.md` G-2），佇列參數無從設計，故 429 直接轉錯誤狀態供手動重試——只保證「不製造重試風暴」這個下限。全域佇列已列入 §18 M3 驗收 | ❌ 否 |
| 送出訊息失敗 | 樂觀 UI 標記「傳送失敗 [重試]」，草稿存 `localStorage` 絕不遺失 | ❌ 否 |
| Webhook 重送／亂序 | event id 冪等去重 + 30s 對帳輪詢補漏 | ❌ 否 |
| **撞單偵測（別人已回覆）** | 攔下並提示，提供 [仍要送出] [捨棄] [重新產生] | ✅ **是（刻意的）** |

### 15.3 說明

**刻意阻斷是一個封閉集合，只有三種**（憲法 3.3）：① 撞單偵測（上表最後一列）——重複回覆客戶的傷害遠大於多按一次按鈕；② 主管強制介入鎖定（§10.6，送出 API 必須實際拒絕）；③ token 過期需重新登入（上表 401 那列，無從降級）。

其餘所有**故障**一律靜默降級：在對應區塊呈現清楚但不干擾的狀態，不使用全頁錯誤畫面、不彈出 modal 打斷工作。新增第四種刻意阻斷需修憲。

---

## 16. 部署與安全

### 16.1 部署形態

Docker 多階段建置 → `node .output/server/index.mjs`。iMBrace 提供 K8s 安裝文件，若能同集群部署可省一段網路跳躍，延遲會明顯改善。

> ⚠️ **一旦上 K8s 多副本，Redis 即為必需品**（見 §8.3）。單副本才可使用記憶體實作。

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
| local | 開發，可用 `StaticSopProvider` + mock AI |
| staging | 對接 iMBrace 測試環境 |
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

> **設計目標：M0–M3 完全不依賴任何未定的外部 API。** 一週後 webhook 規格到位時，已有一個能跑的完整系統，剩下只是替換 provider 實作。

### M0 — 地基

**內容**：Nuxt 骨架、`ssr: false` + Nitro 設定、OTP 三段式登入、BFF session、SDK client factory、`StateStore` / `EventBus` 介面 + 記憶體實作（API 全 async）

**驗收** ✅ **已全數通過**（`npm run build && npm run smoke`，`test/auth-flow.test.ts`）：能以 OTP 登入並選擇組織（一律出現選擇畫面）；重新整理 `organization.vue` 不會被踢回輸 email；session 中確實存有 `refresh_token`；能列出對話清單；access token 不出現在任何前端資源或網路回應中。

> 超出原驗收清單、但一併完成的項目：`StateStore` / `EventBus` 介面與記憶體實作、對話識別碼正規化（§9.3）、JOIN / LEAVE / mode 切換的防腐層（§10.6）。

**外部依賴**：無

---

### M1 — 對話主線

**內容**：對話列表、訊息流（虛擬滾動）、Composer、join / leave；Presence 四來源合併（§10.2）；SSE 管線 + 自動重連；`MessageSource` 抽象 + `PollingMessageSource` + 共享訂閱 + 自適應頻率（§9.2）；只取最新 N 則 + 本地 `lastMessageId` 比對（§9.3）；送出前樂觀併發檢查；JOIN 雙路徑去重。

**驗收** ✅ **全數通過**（8/8，皆為可重跑的自動化驗證，見 `npm run smoke`、`test/`）：
- [x] 兩個瀏覽器開同一對話：A 送出後 B 在 4 秒內看到
- [x] B 帶入草稿準備送出時，若 A 已回覆，必須被攔截並提示
- [x] 三個瀏覽器檢視同一對話時，該對話只被輪詢一次
- [x] 分頁切至背景後，輪詢頻率確實下降至 30s 以上
- [x] SSE 斷線後能自動重連並補齊斷線期間的訊息
- [x] 單次輪詢不會每次都取回整串對話
- [x] PresenceBar 在無人時顯示正常空狀態
- [x] `u_` 反推的同事標示為「N 分鐘前回覆過」，不可標示成「正在檢視」

> 驗收方法論（真實瀏覽器 vs. 自動化測試如何拆分）與 `sendTextMessage()` 回應形狀（H-6a）的風險評估，詳見附錄 B。**結論**：H-6a 目前無任何程式碼路徑依賴，不影響功能。

**外部依賴**：無

> **本階段刻意接受的暫行方案**（不阻塞，待 iMBrace 回覆後再定案）：presence 有盲區（同事在官方介面 JOIN 但未發言時看不到，由 §10.4 兜底）、輪詢頻率取保守值。

---

### M2 — Copilot 核心

**內容**：摘要卡、情緒 sparkline、建議卡、一鍵帶入；前景／背景分級、debounce、快取；AI 可先用 mock provider，UI 先行完成；知識庫先用 `StaticSopProvider`，之後接 `AgentKnowledgeProvider`（§8.2）；**不含**客戶資料卡（§19.1 #21）、舊資料型 `file` 附件內容與語音、**圖片與 PDF 附件的 vision／文件分析**（2026-08-26 訂正：原列於本里程碑，經 `specs/001-sentiment-panel` 的 `/speckit-analyze` 發現 tasks.md 完全未落實此項且預估 5～10 人日，決策延後至 M3，見下方）。

**驗收**：
- [ ] JOIN 後 3 秒內面板區塊出現並明確標示分析中（此條不要求該時點已有實質內容）
- [ ] JOIN 後 10 秒內摘要四欄、情緒走勢與首批建議的實質內容完成呈現（90 百分位），內容可逐欄漸進填入
- [ ] 一鍵帶入可用，且帶入後仍會做撞單檢查
- [ ] 背景對話不跑完整 AI（可由監控指標驗證）
- [ ] 切換至背景對話時，先立即顯示上次保留的結果（不得空白或從頭載入），再於背景補跑完整分析
- [ ] AI 失敗時，訊息流與 Composer 仍完全可用
- [ ] 建議卡的 `sopId` 若不在檢索結果白名單中，該卡被丟棄
- [ ] `confidence` 無真實分數來源時顯示為留空，不得顯示模型自評的替代數字（§11.6②）

**外部依賴**：無

---

### M3 — 知識庫與結案

**內容**：依 #19 RAG 品質的回覆結果，定案知識庫來源（沿用 `AgentKnowledgeProvider` 或換上 `VikiKnowledgeProvider`，見 §8.2、§12.2）；知識庫快查（inline 面板，見 §12.3）；交接摘要 / 結案摘要 + 人審面板；`board-repository` 冪等寫入；Data Board schema setup script；**圖片與 PDF 附件的 vision／文件分析**（§11.4、§19.1 #11；2026-08-26 由 M2 移入——iMBrace 平台已確認無內建 OCR，`docs/IMBRACE_QUESTIONS.md` H-2a／H-2b，自建管線預估 5～10 人日；`specs/001-sentiment-panel` FR-013 已同步訂正為排除範圍，見該檔 Assumptions）；**429 全域退避佇列**（待 G-2 書面 rate limit 規格到位——在此之前 M2 一律讓 429 直接轉錯誤狀態，見 §17 韌性表）。

**驗收**：
- [ ] 自然語言快查能回傳含 SOP 編號的結果；分數欄位依實際 provider 有值則顯示、`null` 則留空
- [ ] 建議卡能正確引用真實 SOP 條目
- [ ] 摘要可編輯後才寫入 Board
- [ ] 重複觸發摘要為覆蓋而非新增
- [ ] LEAVE 產生交接摘要、resolved 產生結案摘要，兩者不混用
- [ ] 圖片／PDF 附件能顯示縮圖與描述文字，且同一份檔案不重複送給模型（結果需快取）
- [ ] 圖片／PDF 的描述不得依賴 `caption` 欄位
- [ ] **429 由全域退避佇列統一處理**，摘要／情緒分析與輪詢等呼叫端不再各自重試；`classifyFailure()` 的 `'rate-limited'` 分類改接佇列，並回頭修訂 `specs/001-sentiment-panel/spec.md` FR-014 的 429 分支與 Assumptions

**外部依賴**：Data Board schema 需先建立；429 全域佇列需 `IMBRACE_QUESTIONS.md` G-2 的書面 rate limit 規格

---

### M4 — 生產化

**內容**：Redis 實作換入（`RedisStateStore` / `RedisEventBus`）；`WebhookEventSource` 接入（規格到位後）+ HMAC 驗簽；30s 對帳輪詢；監控指標、健康檢查；Docker / K8s 部署。

**驗收**：
- [ ] **雙副本部署下：webhook 打到 A 副本、客服 SSE 連在 B 副本，仍能推達**
- [ ] 雙副本下同一對話只有一個副本在輪詢
- [ ] 偽造簽章的 webhook 請求被拒絕
- [ ] 重送的 webhook 事件不會造成重複分析
- [ ] rolling deploy 後，客服的 session 與分析結果不遺失

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

| # | 風險 | 狀態 | 因應 |
|---|---|---|---|
| 1 | 無獨立的知識檢索 API | 🔵 已確認（部分緩解） | 無 query／retrieve 端點；改為 agent 的 SSE `tool-output-available` 事件解析 `RAGknowledge` 輸出，可取得檔名與 chunk 原文 |
| 2 | Webhook payload 規格未定 | 🔵 已確認為 M1 的硬限制 | 輪詢路徑答不出「是誰」JOIN 了；M1 用本地快路徑＋`mode` 的匿名訊號，具名 operator 清單須等 webhook（`IMBRACE_QUESTIONS` A-1） |
| 3 | Presence 無可靠來源 | 🟢 大幅緩解 | `users[]` 是團隊名冊不可用；真正的解是 `mode` 欄位（§10.2），僅 `automation` 的歧義仍存在但不構成撞單風險 |
| 4 | Webhook 簽章機制未知 | ⚪ | 上線前必須取得規格，否則 endpoint 不得對外開放 |
| 5 | SDK 無訊息層級推播 | 🔵 已確認 | 自適應頻率 + 共享訂閱；持續向 iMBrace 爭取 WS |
| 6 | 無相關度分數可用（iMBrace 路徑） | 🔵 已確認，因應方式已定 | `confidence` 改為 nullable，非整個拿掉——無分數時留空，換上 viki 後自然回填，UI 不必重做（§8.2、§11.6） |
| 7 | 多副本狀態共享 | ⚪ | 介面 day-1 async；M4 換 Redis |
| 8 | ~~Nuxt UI Pro 授權~~ | ✅ 已解除 | v4 起 Pro 已併入主套件，125+ 元件全免費 MIT，商用無需額外授權 |
| 9 | 對話內容送外部 LLM | 🔵 已確認會擴大到影像 | 自建 vision／文件分析（§11.4）已定案，出境範圍**確定**從文字擴大到圖片與 PDF，不再是「可能」；實作時程 2026-08-26 由 M2 移至 M3（見 §18 M3）。合規政策待 iMBrace 回覆（E-3），送出前須先確認公司資安政策 |
| 10 | Data Board 欄位型別限制 | ⚪ | M3 前先實測，setup script 可重跑 |
| 11 | 附件內容依型別而定 | 🟢 已用真實對話驗證 | `image`／`pdf` 皆有直接可用 url，只是缺描述與（客戶上傳時的）檔名，已納回 MVP；舊資料型 `file` 仍拿不到內容且來源不明，維持排除；`contact/files` 端點範圍為聯絡人層級，不得當對話附件清單用。細節與驗證過程見附錄 B |
| 12 | JOIN 後 AI 是否仍自動回覆 | 🟢 已釐清 | JOIN 時預設 Manual（AI 關閉），非預設情況；Hybrid 模式下撞單真實存在，§10.5 只在此模式適用 |
| 13 | ~~訊息發送者身分無法區分~~ | ✅ 已解除 | `from` 前綴判別：`con_`客戶／`u_`真人客服／`pub_`AI，398 則覆蓋率 100%。**未知前綴一律歸 `unknown`，不得預設為 `ai`**——預設成 `ai` 會讓撞單檢查把來源不明的訊息當成 AI 回覆。僅 `pub_` 語意細節與內部訊息判斷見 #24 |
| 14 | 知識庫條目時效性 | ⚪ | `KnowledgeHit.updatedAt` 顯示於介面，過舊者標示提醒 |
| 15 | 主管強制介入擋不住官方介面 | ⚪ | 介面誠實標示邊界；`removeTeamMember()` 實際效力待確認（H-4） |
| 16 | 角色權限來源未定 | 🟡 部分解除，尚未定案 | `OrganizationMembership` 帶 `role`（實測 `admin`）／`is_admin`（實測 `false`），可望沿用平台角色。**但兩欄位語意不一致、值域未知（H-5 仍待答）**，「哪個值代表能強制介入他人對話」尚無答案；在那之前 §10.6 的順位 2（設定檔白名單）仍是實際做法 |
| 17 | 無平台層的 structured output 保證 | 🟡 已緩解 | `ai.complete()` 404，改走 agent 路徑：純靠 prompt 實測 4/4 次可直接 `JSON.parse`，仍須自建 Zod 驗證 + 重試 + 降級 |
| 18 | `messageSuggestion` 端點不存在 | 🔵 已確認 | 端點回 404，建議卡完全自建，引用來源從 `RAGknowledge` 工具輸出解析 |
| 19 | **RAG 檢索品質不可調校** | 🔴 已確認，最高優先 | 問「電梯困人」未命中同名 SOP 檔，chunk 大小／top-k／中文斷詞／同義詞全不在我方手上。已列 P0 追問 iMBrace（§0-3f）；調不動則觸發換上 viki |
| 20 | AI 回應延遲 5～12 秒 | 🔵 已確認 | 中位數 5.0s、最慢 12.2s、首字 2.2s。M2 須做漸進顯示：骨架先出、各區塊獨立載入、建議卡串流顯示、提供「重新產生」 |
| 21 | 客戶資料幾乎是空的 | 🟡 已確認，決策：MVP 拿掉 | `email`／`phone_number`／`company_name` 等填充率皆 0%，`display_name` 是代號非人名。MVP 階段直接拿掉客戶資訊卡 |
| 22 | ~~`messages.list()` 無法過濾對話~~ | ✅ 已解除 | `raw-conversation-id` 策略 precision 100%；`since` 類參數不支援，但訊息由新到舊排序，`limit=N` 即最新 N 則（§9.3） |
| 23 | ~~無法由 API 設定對話 mode~~ | ✅ 已解除 | `POST /v1/team_conversations/_join` 帶 `{team_conversation_id, mode}` 可寫入，與 JOIN 同一端點（§10.6） |
| 24 | workflow 的內部中繼訊息與真正回給客戶的回覆無法區分 | 🔴 已確認，仍是啟發式暫解 | 撞單防護的 `byAi`（§10.4）可能誤把內部訊息當真實回覆，觸發假警報。暫行做法：純 JSON 視為內部訊息並排除，非規格。已列 P1 追問（`IMBRACE_QUESTIONS.md` H-3c） |

### 19.2 目前最需要收斂的事

| 優先 | 事項 | 為何是它 |
|---|---|---|
| 🔴 1 | **#19 RAG 檢索品質不可調校** | 唯一可能讓「建議卡」整個上不了線的變數。已列 P0 追問 iMBrace；調不動則觸發換上 viki |
| 🟠 2 | **#24 workflow 內部中繼訊息判斷** | 撞單防護目前用「純 JSON 視為內部訊息」的啟發式，不是規格 |
| 🟡 3 | **#11 附件 URL 的時效與授權，`contact/files` 端點合法性** | 目前樣本數小，URL 是否有時效仍未驗證；`contact/files` 未經 iMBrace 確認是否為正式介面（已確定不影響對話附件清單的實作） |

**待向 iMBrace 確認的完整清單見 `docs/IMBRACE_QUESTIONS.md`**（可直接轉貼給對方）。
**SDK 靜態分析的完整結果見 `docs/SDK_FINDINGS.md`**。

---

## 20. 工程慣例

### 20.1 命名與程式碼約束

**兩者的正典都在 [`CONSTITUTION.md`](./CONSTITUTION.md)，本文件不重複列出。**

- 命名慣例（檔案、元件、composable、API 路由、SSE 事件、EventBus topic、分支、commit）→ 憲法附錄 A
- 程式碼約束 → 憲法一至九條

> ⚠️ 本節在 v1 時期曾另有一份「八條憲法」清單，編號與 `CONSTITUTION.md` 的十條完全不同，
> 造成程式碼註解裡「憲法第 5 條」與「憲法 4.3」指向同一規則卻對不起來。
> 該清單已於憲法 v2.0.0 廢止 —— **不要再在本文件複製一份約束清單**，
> 那正是「多一個地方描述同一件事，就多一個會過期的地方」的實例。

### 20.3 Git

- Conventional Commits，內文說明**為什麼**
- 功能分支 `feat/<milestone>-<slug>`

### 20.4 GitHub Spec Kit 導入

**分階段導入，不建議第一天全面套用。**

```
docs/CONSTITUTION.md
        │
        └──▶ .specify/memory/constitution.md   ← 專案憲法

M0 / M1  地基     → 直接開發，不走 Spec Kit（避免儀式成本）
M2 起的功能單元   → 走 /specify → /clarify → /plan → /tasks → /implement
                    · 情緒面板     · 建議卡與一鍵帶入
                    · 知識庫快查   · 交接／結案摘要
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

**`IMBRACE_QUESTIONS.md` 要特別小心**——它是唯一會離開這個 repo 的文件，內容過期不只是不準確，而是浪費對方時間並稀釋其他真正待答問題。自行解決的問題要明確撤回並附上解法，不是默默刪掉。

**`docs/meeting-draft/` 底下的檔案不得被正典文件引用**——那是本機 gitignored 的會議草稿，隨時會變動；正典文件要引用其結論，須把結論本身寫進正典文件，而非連過去。

同類風險也存在於 `docs/DESIGN_TOKENS.md`，但形態不同：那是「衍生文件與外部活動來源（Claude Design 畫布）脫鉤」，具體判斷時機見該文件自己的附錄。

> 本節的摘要版已寫進專案根目錄的 `CLAUDE.md`，會自動載入每個 session 的 context。

---

## 附錄 B：重大決策修訂紀要

以下是曾被推翻或大幅修正的關鍵結論，依主題摘要記錄，正文只保留最終結論。

**Presence 與 `users[]`（§10.2）**：初版誤判 `Conversation.users[]` 是「該對話的 operator 清單」。二次實測發現：① 第一次量測看到 12/12 全空，其實是量錯位置——那是 `conversations.search()` 輕量 payload 裡本來就是 `null` 的欄位；② 用詳情端點 `get()` 重測後確實有 14 人，但兩個不同對話回傳同一批人，且含 `is_bot: true` 與 `team_user_role: observer`——證實是團隊名冊，不是對話參與者。這兩次錯誤結論都指向同一個最終判斷（`users[]` 不可用），但若照第一次的「理由」去補救，會走向完全錯誤的「等 webhook 補清單」路線；量測位置錯誤造成的假結論，危險之處不在結論本身，而在它推導出的下一步。第三次實測才找到真正可用的來源——`mode` 欄位。

**presence 的其他候選欄位（§10.2）——都測過，都不能用**：除 `users[]` 外另測了三個，避免日後被重新提案。`is_joined` 雙向正確，但**是「我」的視角**（以該客服的 token 查詢），看不到同事；`is_agent_joined` **單向黏著**——JOIN 時 `null → true`，LEAVE 後維持 `true` 不回復，代表「曾經有人加入」而非「現在有人在」；`is_presence` 全程 `false`，與 JOIN 狀態無關、語意不明。四個候選中只有 `mode` 雙向正確且看得到同事。

**`users[]` 的第二個受害者：發送者判別（§19.1 #13）**：`mappers.ts` 初版靠比對 `users[]` 反推發送者，`users[]` 為空時會把**所有 `u_` 真人客服誤判為 AI**，撞單防護直接失效。已改為 `from` 前綴判別（`senderTypeOf`）。⚠️ 這一項不因「`users[]` 其實有值」而緩解——它是團隊名冊，拿來反推發送者一樣是錯的。

**`mode` 的資料模型（§10.6）**：型別文件曾同時存在兩套不相容的定義（`aiReplies`/`agentCanSend` 布林對 vs. 舊版 `aiMode: 'collab' | 'human_only'` 列舉），源自初版判斷「不要建模成列舉」是對的，但尚未確認兩個維度是否真的獨立。四個 `mode` 值全數實測後，確認 Automation Only 時「AI 會回、客服不能送」證實兩維度互相獨立，單一列舉表達不了，已統一為兩維度模型。

**對話識別碼（§9.3）**：`precisionOf()` 初版以字串完全相等比對兩個識別碼，但對話清單給裸 UUID、訊息帶 `conv_` 前綴，導致「取回 70 則全部正確的訊息」被算成 precision 0%，一度誤判整個訊息取數策略不可行、M1 可能被阻塞。修正比對邏輯（改用 `sameConversation()` 而非字串相等）後，真實 precision 是 100%。

**`messages.list()` 過濾與增量拉取（風險 #22）**：原判「無法依對話過濾」是同一個量測錯誤的延伸，修正後確認 `raw-conversation-id` 策略可行；但 `since`／`after` 等八種寫法測完後確認真的不支援增量拉取，不是量測問題。

**對話 mode 寫入端點（風險 #23）**：原判「SDK 無 mode 寫入端點」是錯的——由官方介面的網路請求直接觀察到 `POST /v1/team_conversations/_join` 帶 `mode` 參數即可寫入，且與 JOIN 是同一支端點，只是 SDK 型別沒有宣告 `mode` 欄位。

**附件內容可否取得（風險 #11）**：最早只測過 4 則歷史 `file` 型訊息（`content` 只有 `{name, media_id}`，無 url），外推到「所有附件都拿不到內容」。之後用真實對話補測 `image`（1 則）與 `pdf`（2 則）樣本後推翻——兩者 `content` 都有直接可用的 url，只是平台不提供描述／OCR，且客戶上傳時連檔名（`caption`）都沒有（只有客服上傳的 PDF 才帶檔名）。過程中也用瀏覽器 Network 面板發現一個非 SDK 公開的 `/contact/{id}/files` 端點；因為是在官方介面「聯絡人資料」彈窗中觸發的請求，判斷其範圍是聯絡人層級（該聯絡人所有對話的附件）而非單一對話，因此明確排除用它列出「當前對話」的附件——改為直接用既有的訊息取數路徑（過濾 `type ∈ {image, pdf}`），已用 `14-contact-files.ts` 的 `H-2f-alt` 驗證兩者是同一個 channel-service 後端。

**M1「4 秒內看到」的預算從哪來（§18 M1）**：這個數字量的是**客戶回覆**那條路徑——客戶的訊息不經我方 API，只能靠第一層清單輪詢發現（實測 `last_message_at` ≤2 秒更新，端到端約 1 秒）。另一條路徑是我方客服送出時 `poke()` 的捷徑（約 40ms），那條快得多，**不能拿它當驗收依據**。日後若要調整輪詢頻率，門檻是前者不是後者。

**M1 驗收方法論**：原判「兩瀏覽器即時同步」與「斷線補齊」兩項只能靠真實瀏覽器人工驗證。後來發現這個判斷只有一半對——真正需要瀏覽器的只有 `EventSource` 本身（瀏覽器原生實作，不是我方程式碼），拆開後我方負責的部分全都可自動化：跨 session 的送出與接收、斷線與補齊由 `test/realtime-http.ts` 對建置後的 Nitro 用兩個獨立 cookie jar + `fetch` 手動解析 SSE 驗證；重連時機與退避策略由 `stream-store.test.ts` 對真正的前端 store 注入假斷線驗證。驗證測試本身也需要被信任——第一項檢查即為「兩位客服是不同的 operator」，避免共用 operatorId 導致 presence 自我排除與撞單過濾被測成假陽性。

**M2「3 秒」的語意（§18 M2）**：原驗收寫「JOIN 後 3 秒內出現摘要與首批建議」，讀起來像是要求 3 秒內產出實質內容——但 §6.2 的實測是 AI 單次呼叫中位數 5.0 秒、最慢 12.2 秒，那個門檻九成達不到。經 `specs/001-sentiment-panel` 的 clarify 收斂為兩條：3 秒衡量「面板已出現並標示分析中」（客服知道系統開始為他工作），實質內容另訂 10 秒 / 90 百分位，且允許逐欄漸進填入。連帶：切回已 JOIN 的對話時必須先顯示上次保留的結果而非重新 loading（§11.2 原寫「1–2 秒 loading 完全可接受」已修正）。

**純附件輪不產生情緒點（§11.4、§11.5）**：原本只寫「情緒分析只在 `sender.type === 'customer'` 的訊息上產生情緒點」，未區分該輪有無文字。客戶只傳圖片／PDF 而不打字時若照樣給分，等於從「上傳檔案」這個中性動作推論情緒，且會在走勢上製造假訊號——客戶正在生氣時傳一張截圖，走勢會拉出一段看似好轉的折線，客服掃一眼會得到相反結論。已改為純附件輪不產生評分點，只在時間軸留中性標記；附件伴隨文字時照文字正常評分。⚠️ 這**不**代表附件不必文字化——文字化結果仍是摘要卡的事實來源，只是該管線本身的實作時程已延後至 M3（2026-08-26 訂正，見 §18 M2／M3），M2 交付範圍內附件輪的摘要卡事實來源不含附件描述。

**`sendTextMessage()` 回應形狀（H-6a）**：原始評估寫「送出成功後必須立刻把版本錨點推到新訊息，否則會被當成新訊息重複處理」，理由過度陳述。追查後發現：撞單檢查的版本錨點實際取自 `GET /v1/conversation_messages` 的真實訊息 id，與送出端回應無關；唯一可能用到送出回應 id 的 `advanceAnchor()`／`copilotSessionOf()`／`seed()` 三個機制，匯出後從未被任何呼叫端使用。因此 H-6a 目前的實際影響是零，不是「可能靜默出錯」，優先序下修為最低——除非 M2 有人開始真的依賴 `CopilotSession.lastMessageId`，才需要重新評估。
