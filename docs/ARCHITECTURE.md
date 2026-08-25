# AgentCopilot 開發指引

> iMBrace 平台 Conversations 模組的即時客服輔助擴充
>
> 版本：v1.0 ｜ 制定日期：2026-08-24 ｜ 狀態：藍圖定案，待開發

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
| 即時機制 | **第一版輪詢 + SSE；一週後換 webhook** | iMBrace SDK 目前無公開推播機制。以 provider 抽象隔離，換來源時上層不動 |
| AI 來源 | ~~混合：iMBrace 內建 + 自訂 prompt~~ → **全部自訂 prompt 打 `ai.complete()`** | ⚠️ **2026-08-25 修正**：`messageSuggestion` 回傳型別是 `{ suggestions: string[] }`，無信心度、無 SOP 引用，無法支撐建議卡的呈現（見 §19 #18）。它只能當低品質 fallback |
| 知識庫 | ~~第一版 Boards RAG~~ → **`KnowledgeProvider` 抽象，第一版自建向量檢索** | ⚠️ **2026-08-25 修正**：SDK 只有 `processEmbedding`（建立），**沒有檢索 API**。改用已公開的 `ai.embed()` 自建索引，SOP 量小足以在記憶體／Redis 算 cosine，且分數自控（見 §19 #1） |
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
| 執行環境 | **Node.js 24 LTS**（Krypton） | 見 §3.3 版本選擇說明 |
| 伺服器 | Nitro（`node-server` preset） | |
| iMBrace | `@imbrace/sdk` | **僅在 server 端使用** |
| 狀態管理 | Pinia | `auth` / `conversations` / `sessions` / `presence` |
| 樣式 | Tailwind CSS v4 | |
| 元件庫 | Nuxt UI | ⚠️ 部分進階元件屬 Pro，商用需確認授權 |
| 圖示 | `@nuxt/icon` + Lucide | 按需載入 |
| 深色模式 | `@nuxtjs/color-mode` | Nuxt UI 內建 |
| i18n | `@nuxtjs/i18n`，預設 `zh-TW` | 第一版即導入 |
| 工具函式 | VueUse | `useVirtualList`、`useEventSource`、`useDebounceFn` |
| 驗證 | Zod | API 邊界與 AI 輸出的 schema 驗證 |
| 快取／pub-sub | Redis（M4） | `ioredis` |

### 3.2 明確不採用

| 不採用 | 原因 |
|---|---|
| 圖表庫（ECharts / Chart.js） | 情緒 sparkline 資料量極小，手刻 SVG polyline 即可。引入圖表庫是殺雞用牛刀，深色模式與動畫反而更難控 |
| SSR / SSG | 見決策摘要 |
| 前端直連 `@imbrace/sdk` | 官方文件明載核心操作須在 server 端執行；且憑證不得進入瀏覽器 |
| WebSocket（自建雙向） | 本專案的即時需求是單向推播（server → client），SSE 更簡單、原生支援重連與 `lastEventId` 補拉 |

### 3.3 Node 版本選擇

**採用 Node.js 24 LTS（Krypton）。** 判斷依據（時間基準：2026-08）：

| 版本 | 狀態 | 支援終止 | 評估 |
|---|---|---|---|
| Node 22 (Jod) | Maintenance（2025-10 起） | 2027-04 | ❌ 已進入維護期，只收關鍵修補。新專案不應以此為基準 |
| **Node 24 (Krypton)** | **Active LTS** | **2028-04** | ✅ **採用** |
| Node 26 | Current（預計 2026-10 轉 LTS） | 2029-04 | ⏳ 目前仍為 Current，不適合作為生產基準 |

**Node 24 對本專案的實際效益**（非僅版本較新）：

- **AsyncLocalStorage 改用 AsyncContextFrame 實作，效能明顯提升。** Nitro 大量依賴 ALS（`useRuntimeConfig()`、event context、unctx），而本專案是高頻小請求型態 —— 輪詢、SSE 長連線、presence 上報都會穿過 ALS。這是直接落在熱路徑上的改進。
- **`require(esm)` 已穩定。** Nuxt 4 / Nitro 生態為 ESM-first，此特性可大幅降低與 CJS 相依套件（含 `@imbrace/sdk`，模組格式待實測）混用時的建置摩擦。
- **`node:sqlite` 已穩定。** 未來若希望本機開發時免跑 Redis container，可作為 `StateStore` 的輕量持久化實作選項。

**升級規劃**：Node 26 預計 2026-10 轉 Active LTS，但不建議立即跟進。Node 24 支援至 2028-04，時間充裕；建議待 26 轉 LTS 並穩定數月後（約 2027 Q1）再評估。

> Docker base image 使用 `node:24-alpine`。若公司對 base image 有統一規範，以規範為準並在此註記例外。

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
│  conversations │ messages │ ai / messageSuggestion │ boards    │
│  Knowledge / DocIQ │ webhook（JOIN/LEAVE，一週後開通）          │
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

### 4.3 JOIN 的雙路徑與去重（重要）

JOIN 有兩個來源，**同一個動作可能兩邊都收到**：

| 來源 | 路徑 | 延遲 |
|---|---|---|
| 在 AgentCopilot 按 JOIN | 本地快路徑：`conversations.join()` → 立刻建 session → 立刻廣播 | 即時 |
| 別人在 iMBrace 官方介面按 JOIN | Webhook → EventBus → 廣播 | 秒級 |

**必須去重**：以 `conversationId + operatorId` 為鍵，10 秒時間窗內視為同一事件。

> 未實作去重的後果：面板閃爍兩次、AI 分析重複執行（成本翻倍）、presence 出現重複項目。這類 bug 在開發期不易察覺，上線後極難追查，務必在 M1 就處理。

---

## 5. 目錄結構

```
AgentCopilot/
├── nuxt.config.ts
├── app/
│   ├── layouts/
│   │   ├── default.vue              # 登入頁
│   │   └── console.vue              # 頂欄 + 側欄 + 三欄工作區
│   ├── pages/
│   │   ├── login.vue                # OTP 兩段式登入
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
│   │   │   ├── KnowledgeSearch.vue  # Command Palette
│   │   │   └── ClosurePanel.vue     # 結案摘要人審面板
│   │   └── common/
│   ├── composables/
│   │   ├── useCopilotStream.ts      # SSE 連線 + 自動重連 + lastEventId
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
│   │   │   ├── otp.post.ts          # auth.signinEmailRequest
│   │   │   ├── login.post.ts        # auth.authenticate
│   │   │   ├── organization.post.ts # auth.exchangeAccessToken
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
│   │   ├── polling-event-source.ts
│   │   ├── polling-message-source.ts
│   │   ├── webhook-event-source.ts  # 骨架先備好
│   │   ├── boards-rag-provider.ts
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
├── config/
│   ├── sop.yaml                     # StaticSopProvider 資料
│   └── categories.yaml              # 結案分類受控詞彙
└── docs/
    ├── ARCHITECTURE.md              # 本文件
    ├── IMBRACE_QUESTIONS.md         # 待向 iMBrace 確認的清單
    └── CONSTITUTION.md              # Spec Kit 憲法
```

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

  typescript: { strict: true, typeCheck: true },
})
```

> **`ssr: false` 的常見誤解**：這不等於靜態網站。只要用 `nuxt build`（而非 `nuxt generate`）並以 `node .output/server/index.mjs` 啟動，`server/api/**` 的所有路由完全正常運作。你得到的是「SPA 前端 + 完整 Node BFF」。

---

## 7. 認證與 Session

### 7.1 登入流程

iMBrace 的 OTP 登入是三段式（✅ 已對照 SDK 型別確認，方法名以下方為準）：

```
① auth.signinEmailRequest(email)          → 寄出驗證碼
② auth.authenticate({ email, otp })       → accessToken + organizations[]（含 role / is_admin）
③ auth.exchangeAccessToken(organizationId) → { token, refresh_token }
```

> **2026-08-25 更新**（見 `docs/SDK_FINDINGS.md`）：
> - 第 ② 步**一次回傳 token 與組織清單**，不需再呼叫 `organizations.list()`
> - `organizations[]` 帶 `role?: string` 與 `is_admin?: boolean` → **主管判定可沿用平台角色**（§19 #16）
> - 第 ③ 步回傳 `refresh_token` → **token 可續期**，客服不會在工作中被迫重跑 OTP

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

這是整份架構最重要的設計。**所有尚未確定規格的外部依賴，都必須藏在一個 provider 介面之後。**

如此一來，iMBrace 的 webhook 與 Knowledge API 開通與否，都不會阻塞開發進度 —— 屆時只需替換實作，上層邏輯一行不動。

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
| `ConversationEventSource` | `PollingEventSource` | `WebhookEventSource` |
| `MessageSource` | `PollingMessageSource` | `WebhookMessageSource` 或 `WsMessageSource` |

> `PollingEventSource` 透過定期 `conversations.list()` 比對 team member 變化來推斷 JOIN／LEAVE。有數秒延遲且不夠精確，僅作為過渡方案。

### 8.2 知識庫

```ts
export interface KnowledgeHit {
  id: string
  /** 顯示用的條目編號，如 SOP #12 */
  code: string
  title: string
  snippet: string
  score: number                    // 檢索分數（非模型自評）
  /** 條目最後更新日期，介面需顯示；過舊條目應標示提醒 */
  updatedAt: string
  sourceRef: { type: 'knowledge' | 'docIQ' | 'board' | 'static'; ref: string }
}

export interface KnowledgeProvider {
  search(query: string, opts?: { topK?: number; channel?: string }): Promise<KnowledgeHit[]>
}
```

**實作優先序**

| 順位 | 實作 | 狀態 |
|---|---|---|
| 1 | `LocalVectorProvider` | ✅ **第一版採用** —— `ai.embed()` 自建索引，分數自控（詳見 §12.2） |
| 2 | `BoardsSearchProvider` | ✅ 可實作 —— `boards.search()`，Meilisearch 相容關鍵字檢索，有條目 ID |
| 3 | `StaticSopProvider` | ✅ 可實作 —— 讀 `config/sop.yaml`，開發期與離線 fallback |
| — | ~~`BoardsRagProvider`~~ | ❌ **2026-08-25 撤銷** —— `processEmbedding()` 之後沒有檢索 API |
| — | `ImbraceKnowledgeProvider` | ⏳ 待 API 開通（若日後開放，替換即可）|

### 8.3 狀態與事件匯流排

> **關鍵規則：這兩個介面的所有方法從 day 1 就必須是 async。**
>
> 若一開始寫成同步的 `map.get()`，M4 換 Redis 時要修改數十個呼叫點。先寫成 `await store.get()`，換實作只需一天。這個成本差距是現在就該付的小代價。

```ts
// server/state/types.ts

export interface StateStore {
  // Session
  getSession(id: string): Promise<Session | null>
  setSession(id: string, s: Session): Promise<void>
  deleteSession(id: string): Promise<void>

  // Copilot session（每對話一個）
  getCopilotSession(convId: string): Promise<CopilotSession | null>
  setCopilotSession(s: CopilotSession): Promise<void>

  // Presence
  addPresence(convId: string, op: PresenceEntry): Promise<void>
  removePresence(convId: string, operatorId: string): Promise<void>
  listPresence(convId: string): Promise<PresenceEntry[]>

  // 多副本協調
  acquirePollLock(convId: string, ttlMs: number): Promise<boolean>
  releasePollLock(convId: string): Promise<void>

  // 去重
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

三位客服同時檢視同一對話 → **只輪詢一次**，結果 fan-out 給三個 SSE 連線。訂閱數歸零即停止輪詢。

多副本部署時，需搭配 `acquirePollLock()` 確保同一對話只有一個副本在輪詢，否則 API 呼叫量會乘上副本數。

### 9.2 自適應頻率

| 對話狀態 | 輪詢間隔 |
|---|---|
| 前景聚焦 + 已 JOIN | **1.5s**（防撞單，此處不可省） |
| 前景聚焦 + 觀察中 | 3s |
| 背景 + 已 JOIN | 5s |
| 背景 + 觀察中 | 10s |
| 連續 5 次無新訊息 | 指數退避，上限 15s |
| **出現新訊息** | **立刻跳回最快檔** |
| 瀏覽器分頁 `hidden` | 全部降至 10s 以上 |

### 9.3 成本評估

20 位客服 × 平均 3 個對話 = 60 個活躍對話，共享訂閱後約 **12 req/s**。

**輪詢不是瓶頸，AI 呼叫才是。** 見 §11.2 的前景／背景分級策略。

補充最佳化：
- **增量拉取** —— 只取 `since lastMessageId` 之後的訊息，不做全量
- **並發控制** —— 同時 in-flight 請求上限 5，避免瞬間尖峰觸發 rate limit

> ⚠️ **2026-08-25：上述成本評估的前提尚未成立。**
>
> `@imbrace/sdk@1.4.0` 的 `messages.list()` 簽章是 `{ type?, q?, limit?, skip? }` ——
> **既沒有 `conversation_id`，也沒有 `since`**（見 §19 #19）。
>
> 三種候選取數策略已實作於 `server/sources/message-fetch.ts`，由 `scripts/spike/03-incremental.ts` 實測。
> **若最終只能「全量取回、本地過濾」，本節的 12 req/s 與整張 §9.2 頻率表都必須重算。**
> 屆時的緩解方向：加大輪詢間隔、改以 `limit + sort=desc` 只取最新 N 則再比對 `lastMessageId`。

### 9.4 換成 webhook 後仍要保留對帳輪詢

Webhook 會漏、會亂序、會重送。生產環境必須保留**低頻對帳輪詢（每 30s）**，比對本地 `lastMessageId` 與遠端，補上遺漏的訊息。

> 省略此機制的後果是「偶爾少一則訊息」—— 這是最難重現、最難追查的一類 bug。務必在 M4 一併實作。

### 9.5 SSE 契約

```ts
// shared/types/events.ts
export type CopilotEvent =
  | { type: 'session.opened';    conversationId: string; reason: 'join' | 'resume' }
  | { type: 'session.closed';    conversationId: string; reason: 'leave' | 'resolved' }
  | { type: 'messages.appended'; conversationId: string; messages: Message[] }
  | { type: 'summary.updated';   conversationId: string; summary: ConversationSummary }
  | { type: 'sentiment.appended';conversationId: string; point: SentimentPoint }
  | { type: 'suggestions.updated';conversationId: string; cards: SuggestionCard[] }
  | { type: 'presence.updated';  conversationId: string; operators: PresenceEntry[] }
  | { type: 'control.updated';   conversationId: string; control: ConversationControl }
  | { type: 'analysis.failed';   conversationId: string; stage: string; message: string }
```

每則事件都帶 `id`，供斷線重連時以 `Last-Event-ID` 補拉。

---

## 10. 多客服協同與撞單防護

### 10.1 必須接受的前提

> **AgentCopilot 攔不住任何人在 iMBrace 官方介面按 JOIN，因此任何「鎖」都是假的。**

iMBrace 目前不設計 JOIN 的排他鎖，本專案也不打算加。正確策略不是防止碰撞，而是**讓碰撞在造成傷害前被看見**。

三層防線，重要性由低到高：

### 10.2 第一層：Presence

SSE 連線時上報 `viewing: conversationId`，server 維護 `conversation → operators` 對應。對話頂端即時顯示「王大明 正在檢視・李小華 正在輸入…」。

```ts
type PresenceState = 'viewing' | 'composing' | 'joined'
```

走自家 SSE，延遲 < 200ms，不依賴 iMBrace。

> ⚠️ **盲區**：presence 只看得到「有開 AgentCopilot 的人」。同事若在官方介面 JOIN，需等 webhook 才知道。因此已在 `IMBRACE_QUESTIONS.md` 中要求 webhook payload 包含**完整 operator 清單**，而非僅觸發者。

### 10.3 第二層：JOIN 意圖廣播（advisory lock）

按 JOIN 前先送 `intent:join` 到 EventBus，**立刻**廣播給其他人。他人畫面上該對話的 JOIN 按鈕變灰並顯示「王大明 正在加入…」，但**仍可強制點擊**（因為我們無權真的阻擋）。

這是勸告式而非強制式的鎖。

### 10.4 第三層：送出前的樂觀併發檢查 ← 真正有效的一層

> **關鍵認知：「一鍵帶入」≠「送出」。真正的傷害不是兩個人都 JOIN，而是兩個人都回覆了客戶。**

因此把防線放在送出的那一刻：

```ts
// 帶入建議時記錄版本錨點
const baseMessageId = session.lastMessageId

// 送出前檢查
const since = await messageSource.fetchSince(conversationId, baseMessageId)

// ⚠️ 必須以 sender.type 判斷，不可用 direction
const byOtherAgent = since.filter(
  m => m.sender.type === 'agent' && m.sender.id !== me.operatorId,
)
// 協作模式下，AI 也是撞單對象
const byAi = control.aiMode === 'collab'
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

以 `lastMessageId` 作為版本號的樂觀併發控制（optimistic concurrency）。

> ⚠️ **不可用 `direction === 'outbound'` 判斷。**
>
> AI workflow 的自動回覆同樣是 outbound。若以 direction 判斷，AI 在客服組字期間回了一句就會觸發假警報。
>
> **假警報比沒有警報更糟** —— 客服學會忽略提示後，真正的撞單也會被一併略過。

**此機制不需要任何平台端支援，M1 即可實作，且是整套協同設計中唯一真正能防止客戶收到重複回覆的一層。**

### 10.5 第四個競爭者：AI 本身

> **已確認**：按下 JOIN 之後，AI workflow **仍持續自動回覆**。必須另外按下「切換為全真人模式」才會停止。
>
> 換言之，**JOIN 後的預設狀態是「AI 與真人同時運作」**。

#### 為何這使撞單成為預設情況而非邊緣情況

```
t=0s     客服按 JOIN
t=0–8s   讀摘要、看情緒提示
t=8–15s  挑建議卡、一鍵帶入
t=15–30s 微調文字
t=30s    送出
```

真人組織一則回覆需 **20–40 秒**；AI 回覆只需 **1–2 秒**。

只要客戶在這段窗口內說了任何一句話，AI 幾乎必然搶先回覆。客服送出時可能：
- 重複 AI 剛說過的內容
- 與 AI 的說法矛盾（AI 說「請稍候」，客服說「已為您建立工單」）
- 承接一個已被 AI 帶往別處的話題

**因此協作模式下的撞單防護不是輔助功能，而是產品可用性的前提。**

#### 協作模式必須補的三項設計

**① Composer 上方常駐 AI 活動指示**

事後攔截（送出前檢查）是補救，不夠。客服需要在打字的當下就知道 AI 動了：

```
┌──────────────────────────────────────────────┐
│ ⚡ AI 協作中 — AI 仍會自動回覆客戶              │
│ ⚠ AI 在 3 秒前已回覆：「請稍候，正在為您查詢…」  │
└──────────────────────────────────────────────┘
│ [輸入區]                                [送出] │
```

第二行僅在「AI 剛回覆」且「客服正在組字」時出現，明顯但不奪取焦點。

**② 建議卡需要「失效」狀態**

客服帶入建議卡時，卡片基於當時的對話。若 AI 隨後說了類似的話，該卡已過期卻仍安靜留在畫面上。

新訊息進來時必須**重新評估既有建議卡**，被 AI 搶先說掉的標示為「AI 已回覆類似內容」並降級或移除。

**③ 建議生成的 prompt 必須知道「AI 也在場」**

> 協作模式下，真人的價值恰在於 AI 做不到的事 —— 同理、破例、承諾、決策。

`aiMode === 'collab'` 時，prompt 須明確告知模型當前為協作模式，要求產生**補位性質**的建議（情緒安撫、權限內的破例、明確承諾、升級處理），而非重複 AI 已能處理的例行說明。

若忽略此點，客服會發現「這張卡的內容 AI 兩秒前剛說過」，很快就不再看建議卡。

### 10.6 服務模式與主管接管

介面提供**兩顆**控制按鈕，作用不同：

| 按鈕 | 誰可操作 | 效果 |
|---|---|---|
| 切換為全真人模式 | 一般客服 | 停止該對話的 AI 自動回覆 |
| **主管強制介入** | **僅主管** | 停止 AI，**且鎖定其他客服** —— 只有該主管可回覆 |

#### 資料模型：兩個正交維度

不要建模成三種模式列舉，會綁死組合（例如「主管接管但保留 AI 協助」將無法表達）：

```ts
// shared/types/conversation.ts
export interface ConversationControl {
  aiMode: 'collab' | 'human_only'    // AI 是否自動回覆
  lock: null | {                      // 誰能回覆
    by: string                        // operatorId
    name: string
    at: string
  }
}
```

- 客服按「切換為全真人模式」 → `aiMode = 'human_only'`
- 主管按「強制介入」 → `aiMode = 'human_only'` + `lock = { by: 主管 }`

兩個動作、一個資料結構。日後新增組合不必改結構。

#### 這個鎖的邊界（必須誠實標示）

> ⚠️ 這是全系統**唯一的真鎖**，但它的強制力有明確邊界：

| 範圍 | 能否強制 |
|---|---|
| AgentCopilot 內的其他客服 | ✅ 能 —— Composer 唯讀 + **送出 API 拒絕**（不可只在前端 disable） |
| 直接使用 iMBrace 官方介面的客服 | ❌ **擋不住** |

**介面上必須明示此邊界**，不可讓主管誤以為已完全接管。否則主管以為安全，卻有客服從官方介面照樣回覆 —— 這比沒有鎖更糟。

**可能的強化手段**：主管強制介入時一併呼叫 `conversations.removeTeamMember()` 將其他客服移出對話。但被移除者是否可自行重新 JOIN，需向 iMBrace 確認（見 `IMBRACE_QUESTIONS.md` H-4）。

#### 稽核要求

> **主管強制介入必須留下稽核紀錄：誰、何時、哪個對話、中斷了誰。**

這是有勞資敏感性的操作。缺乏紀錄時，任何爭議都無從釐清。這不是技術需求，是保護所有相關人員的需求。

#### 角色權限來源（建議，尚未定案）

**強烈建議不要在 AgentCopilot 自建角色權限系統。**

客服的身分、團隊歸屬、主管關係已在 iMBrace 上管理。自建第二套的代價：
- 新人到職須在兩系統各建一次
- **離職帳號須記得兩邊都關** ← 最容易出事之處
- 稽核軌跡分散兩處
- 權限不一致時無從判斷以何者為準

**建議優先序**：

| 順位 | 做法 | 說明 |
|---|---|---|
| 1 | **沿用 iMBrace 角色** | 需確認 access token 能否取得使用者角色／團隊（見 H-5） |
| 2 | **極簡白名單** | `config/supervisors.yaml` 列主管 email，環境設定管理。第一版足夠，且明確是暫時方案 |
| 3 | 自建角色管理頁 | **最後手段**，待確實出現多角色、多權限組合需求時再評估 |

### 10.7 唯一刻意阻斷使用者的情境

主動阻斷操作的情況只有兩種：

1. **撞單偵測** —— 重複回覆客戶的傷害，遠大於多按一次按鈕的成本
2. **主管鎖定** —— 見 §10.6

除此之外，任何故障都不得阻斷工作流程（見憲法第三條）。

---

## 11. AI 分析管線與資料契約

### 11.1 觸發策略

| 階段 | 觸發時機 | 送給模型的內容 | 產出 |
|---|---|---|---|
| **冷啟動** | JOIN 事件 | 全量歷史（或近 N 輪 + 更早的壓縮摘要） | 摘要、情緒序列、首批建議 |
| **增量** | 新訊息，debounce 1s | 既有摘要 + 新訊息（**不重送歷史**） | 摘要 patch、追加情緒點、重算建議 |
| **不觸發** | 客服自己送出的訊息 | — | 僅更新畫面訊息流 |
| **手動** | 使用者點「重新分析」 | 全量 | 全部重算 |

### 11.2 前景／背景分級（成本控制的核心）

```
前景聚焦的對話  → 完整 pipeline：摘要 + 情緒 + 建議生成 + 知識庫檢索
背景對話        → 僅輕量情緒分類，產出徽記提醒
                  不生成建議卡、不查知識庫
切換至某背景對話 → 才補跑一次完整分析（1–2 秒 loading 完全可接受）
```

這符合直覺：**使用者看不到的東西不需要即時算好。** 成本自然收斂到「同時只有一個對話在跑完整 AI」。

另設背景 session 上限（建議 10），超過者只累積訊息計數，不做任何分析。

### 11.3 快取

快取鍵 `{conversationId}:{lastMessageId}`。同一狀態不重複呼叫模型。

### 11.4 訊息型別（多模態）

```ts
// shared/types/conversation.ts

export type SenderType = 'customer' | 'ai' | 'agent'

export interface Message {
  id: string
  conversationId: string
  at: string
  sender: {
    type: SenderType          // ⚠️ 撞單防護與對話分段皆依賴此欄位
    id?: string               // agent 時為 operatorId
    name?: string
  }
  /** 統一的可分析文字：原文、語音轉錄、或圖片描述 */
  text: string
  attachments?: Attachment[]
}

export interface Attachment {
  id: string
  kind: 'image' | 'audio' | 'video' | 'file'
  filename: string
  url?: string
  /** 語音時長（秒） */
  durationSec?: number
  /** 平台端或我方產生的文字化內容（STT 轉錄 / 圖片描述 / OCR） */
  transcript?: string
  /** transcript 的來源，供成本控制與品質判斷 */
  transcriptSource?: 'platform' | 'ours' | 'none'
}
```

**為何 `sender.type` 是必要的**

| 用途 | 說明 |
|---|---|
| **撞單防護** | 必須區分「同事回覆」與「AI 自動回覆」，見 §10.4 |
| **對話分段** | 「AI 階段」與「真人階段」的分界為 JOIN 時間點，UI 需分段呈現 |
| **情緒分析** | 只在 `sender.type === 'customer'` 的訊息上產生情緒點 |
| **增量分析觸發** | 客服自己送出的訊息不觸發重新分析（見 §11.1） |

**多模態處理原則**

介面顯示對話中包含圖片附件與語音訊息，且兩者都已被理解（AI 回應「已收到照片，指示燈顯示訊號異常」；語音旁直接顯示轉錄文字）。

1. **一律先文字化再進 AI 管線。** `Message.text` 是唯一的分析輸入，附件的 `transcript` 在取得訊息時就填入。
2. **文字化結果必須快取。** 一張圖只做一次 vision 分析、一段語音只做一次 STT，結果隨 message 永久保存。**絕不可在每次全量分析時重複送原始媒體給模型** —— 這是成本失控最快的路徑。
3. **來源優先序**：平台端已提供 → 直接用；平台端未提供 → 我方補做並標記 `transcriptSource: 'ours'`。
4. **已知限制**：語音僅取轉錄文字，音調中的情緒訊號會遺失。第一版接受此限制，必要時可在 `drivers` 中標註「此輪為語音訊息」提醒客服自行聆聽。

> ⚠️ **平台端是否已提供 STT 與圖片描述，直接決定 M2 的工作量級距。** 見 `IMBRACE_QUESTIONS.md` H-2。

### 11.5 資料契約（前後端共用）

```ts
// shared/types/copilot.ts

/** 情緒單點：每「一輪客戶發言」產生一點 */
export interface SentimentPoint {
  messageId: string
  at: string                    // ISO8601
  score: number                 // 0–100，越低越負面
  label: 'calm' | 'neutral' | 'concerned' | 'frustrated' | 'angry'
  drivers: string[]             // 造成此分數的關鍵詞／事件，供人快速理解
}

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
  confidence: number            // 0–100
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
  summary: string
  intent: string
  category: string              // 受控詞彙，見 config/categories.yaml

  // ── 以下三項對應介面上的三個標籤（意圖／處理結果／情緒結果）──
  resolution: 'resolved' | 'workaround' | 'escalated' | 'unresolved' | 'customer_abandoned'
  /** 實際採取的行動，與 resolution（狀態）分開。如「已建立工單」「已派工」 */
  actionsTaken: string[]        // 受控詞彙
  /** 情緒結果的語意標籤，供介面直接顯示 */
  sentimentOutcome: 'appeased' | 'satisfied' | 'still_negative' | 'escalated'

  // ── 數值供報表統計使用，不直接顯示於介面 ──
  sentimentStart: number
  sentimentEnd: number
  sentimentTrough: number       // 全程最低點

  citedSopIds: string[]
  followUps: Array<{ action: string; owner?: string; dueHint?: string }>
  confidence: number
  reviewedBy: string | null     // 未經人審為 null
  reviewedAt: string | null
}
```

### 11.6 Prompt 設計四條硬規則

**① 建議卡的 `sopId` 不得杜撰。**

流程必須是：先檢索知識庫 → 將 `KnowledgeHit[]` 作為上下文提供給模型 → 要求 `sopId` 只能自 hits 的 id 中選擇 → **後端再驗證一次**，不在白名單者直接丟棄該卡。

> 僅靠 prompt 交代是不夠的，必須有程式層的後驗。

**② `confidence` 不得由模型憑空給定。**

純模型自評的信心度沒有校準，是假數字。應為：

```
confidence = f(檢索分數, 模型自評, 上下文完整度)
```

並於後端做一次校準。

> **信心度一旦失準，客服很快就會學會忽略它，整個功能即告廢棄。** 這比多花一天做校準嚴重得多。

**③ 增量分析回傳 patch，不回傳全量。**

送 `previousSummary + newMessages`，要求僅回傳變動欄位。除了省 token，也避免摘要每次被整段重寫 —— 客服會感覺畫面一直跳動。

**④ 事實不得推測。**

明確禁止模型編造工單編號、時間、金額、政策內容。`requiresData` 欄位即為此設計：模型察覺自身缺乏資料時應標示出來，交由客服填寫，而非虛構。

### 11.7 其他約束

- 全部使用 **structured output / tool use**，**絕不解析自由文字**
- 所有輸出以 **Zod schema 驗證**後才進入系統
- `category` 使用**受控詞彙**（`config/categories.yaml`），不得由模型自由生成 —— 否則寫入 Data Board 後無法統計
- 輸出語言為繁體中文，語氣須符合客服規範
- 溫度設低（建議 0.2–0.3）

---

## 12. 知識庫

### 12.1 現況

> ⚠️ **iMBrace SDK 文件中沒有 Knowledge / DocIQ 的查詢 API。**
>
> - `reference/` 底下僅有 ai-agent、workflow、board、campaign、communication、channel、contact
> - `sdk/document-ai/` 是**抽取導向**（`processDocument()` 從 PDF 抽結構化欄位），非檢索導向 —— 無語意搜尋、無章節 ID、無信心度
> - 平台側邊欄雖有 Knowledge 與 DocIQ 模組，但 SDK 未開放對應介面

而建議卡上「SOP 3.2 安撫圓場｜信心度 92%」這種呈現，**必須**有能回傳條目 ID 與分數的檢索 API 才能實現。

### 12.2 因應方式

已列入 `IMBRACE_QUESTIONS.md`，與 webhook 規格一併詢問（同一週、同一次溝通，成本最低）。

架構上以 `KnowledgeProvider` 隔離。

> ⚠️ **2026-08-25 修正**：原規劃的 `BoardsRagProvider` 流程 ——
> `boards.uploadFile() → aiAgent.processEmbedding() → 語意檢索` ——
> **最後一步不存在**。全套 `.d.ts` 搜尋 `knowledge|semantic|retriev` 只找到建立與列檔，
> 沒有任何查詢端點（見 `docs/SDK_FINDINGS.md` §4）。

**改採的實作優先序**：

| 順位 | 實作 | 可行性 | 說明 |
|---|---|---|---|
| 1 | **`LocalVectorProvider`（自建）** | ✅ **建議** | `ai.embed({model, input[]})` 已公開。SOP 量小（數百條），離線建索引 + 記憶體／Redis 算 cosine 即可。**分數完全自控**，§11.6 的 confidence 校準公式可完整實作 |
| 2 | `BoardsSearchProvider` | ✅ 可行 | `boards.search(boardId, {q, filter, limit})`，Meilisearch 相容。**有條目 ID**，足以滿足憲法第 5 條的白名單後驗。但屬關鍵字檢索非語意，同義詞會漏；分數需確認能否開啟 `showRankingScore` |
| 3 | `StaticSopProvider` | ✅ 可行 | 讀 `config/sop.yaml`，開發期與離線 fallback |
| ❌ | 掛 Knowledge Hub 給 AI Agent 再問它 | 不建議 | 回傳自由文字，無條目 ID 與分數，**違反憲法第 5 條** |

若 iMBrace 日後開放語意檢索 API，替換 provider 即可，上層不動 —— 這正是抽象層的價值。

### 12.3 知識庫快查 UX

依 `demo_agentCopilot02.png`，快查是**右欄中的常駐 inline 面板**，而非彈出式 Command Palette。

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

**設計要點**
- 結果顯示 `title` + `code` + `updatedAt`，**不顯示分數**（分數只用於排序）
- 條目過舊時（建議門檻 12 個月）標示提醒 —— 客服可能依據已失效的 SOP 回覆客戶
- 結果可「插入為回覆」或「展開全文」；展開全文時右欄可暫時全屏
- 輸入需 debounce（建議 300ms），避免逐字觸發檢索

**第一版只做 inline 面板。** `Ctrl/Cmd + K` 的 Command Palette 可作為後續增強（跨對話搜尋、快速跳轉），非必要功能。

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
| `sentiment_start` / `sentiment_end` / `sentiment_trough` | number | |
| `cited_sops` | text[] | |
| `follow_ups` | long text（JSON） | |
| `confidence` | number | |
| `reviewed_by` | text | 未經人審為空 |
| `reviewed_at` | datetime | |

> 欄位需先透過 `createField()` 在平台上建立。建議寫一支一次性 setup script 置於 `scripts/`，讓環境可重建。

### 13.4 三個設計陷阱

**① AI 產物寫入正式 CRM，必須經人審。**

摘要生成後先進入**可編輯的確認面板**（`ClosurePanel.vue`），客服修改確認後才 `createItem()`。

若確實需要「LEAVE 自動觸發寫入」，必須標記 `reviewed_by = null`，使其可於事後被稽核篩出。

> 自動寫入未經確認的 AI 內容至客戶紀錄，是會出事的那種設計。

**② LEAVE ≠ 結案。**

多客服情境下，你 LEAVE 了但其他人仍在。因此拆成兩種產出：

| 類型 | 觸發 | 內容 |
|---|---|---|
| **交接摘要** `HandoverSummary` | LEAVE | 我這段處理了什麼、下一位要接什麼 —— 對話仍進行中 |
| **結案摘要** `ClosureSummary` | `updateStatus()` → resolved，或手動按鈕 | 完整的意圖／分類／處理結果／情緒起訖／後續動作 |

兩者 schema 不同，不可混用。

**③ 冪等。**

同一對話重複產生摘要必須**覆蓋**而非新增。以 `conversation_id` 為唯一鍵，寫入前先 `search()`，再決定 `createItem` 或 `updateItem`。

---

## 14. UI 與設計系統

### 14.1 佈局

加上側欄後為三欄結構：

```
┌────────┬──────────────────────┬─────────────────────┐
│ Sidebar│   對話視窗（中欄）     │  Copilot 面板（右欄）│
│        │                      │                     │
│ 對話   │  PresenceBar         │  客戶情緒提示        │
│ 列表   │  ─────────────       │  ─────────────      │
│        │  MessageList         │  AI 轉接摘要         │
│ 已JOIN │  （虛擬滾動）         │  ─────────────      │
│ 徽記   │                      │  AI 語意即時建議     │
│        │  ─────────────       │  （建議卡 ×N）       │
│ 可收合 │  Composer            │  ─────────────      │
│        │  （送出前撞單檢查）    │  知識庫自然語言快查  │
└────────┴──────────────────────┴─────────────────────┘
         ↑ 可拖曳調寬 ↑        ↑ 可拖曳調寬 ↑
```

- Sidebar **可收合**
- 中／右欄之間**可拖曳調寬** —— 不同客服對「對話 vs 建議」的比重偏好差異很大（Reka UI 的 `Splitter` 可直接使用）
- 右欄**可暫時全屏**（閱讀長 SOP 時需要）
- 分欄寬度存於 `localStorage`

### 14.1.1 右欄的區塊與捲動

依 `demo_agentCopilot02.png`，右欄自上而下共五個區塊：

```
① 客戶情緒提示        ← 處理中最常看
② AI 語意即時建議（×3）← 處理中最常用
③ 知識庫自然語言快查   ← 隨時可能用
④ AI 階段完整對話紀錄  ← 可折疊，偶爾回顧
⑤ 結案摘要自動填入    ← 只在結案時使用
```

**問題**：全部展開後右欄很長，而「處理中」與「結案中」需要的區塊完全不同。一路捲動到底才能結案，體驗不佳。

**建議做法**（開發階段決定，兩者擇一）：
- **區塊可折疊 + 記憶折疊狀態**（實作簡單，先做這個）
- **階段感知排序**：JOIN 中 → ①②③ 優先；按下「準備結案」→ ⑤ 置頂

### 14.1.2 AI 階段完整對話紀錄

此區塊將 JOIN 之前 AI 與客戶的往來以高密度形式呈現，供客服快速回顧。

- 標題列顯示總則數（如「共 18 則訊息」），**可折疊**
- 每則標示發送者（客戶／AI／客服），依 `Message.sender.type` 判斷
- 附件呈現：圖片顯示檔名與縮圖、語音顯示時長與轉錄文字（見 §11.4）
- 此區塊與中欄訊息流資料來源相同，僅呈現密度不同 —— **不需額外 API**

> ⚠️ **不可用 JOIN 時間點做「AI 階段 / 真人階段」的分段。**
>
> JOIN 之後 AI 仍持續運作（見 §10.5），該時點之後依然是混合狀態。真正的分界是 `aiMode` 切換為 `human_only` 的時刻。
>
> **正確做法**：以每則訊息各自的 `sender.type` 標示，時間分段僅作為輔助視覺提示（可在 `aiMode` 切換處加一條分隔線）。

### 14.2 多對話切換

- 側欄列出所有已 JOIN 的對話，每個都有獨立 `CopilotSession` 在背景運作
- 未聚焦的對話若有新訊息或情緒惡化，顯示**徽記提醒**
- 背景對話僅跑輕量情緒分類（見 §11.2）

### 14.3 設計基調

參考 `docs/demo_agentCopilot01.png`：clean SaaS 風 —— 藍色主色、白底卡片、大圓角、清楚的區塊標題。

**設計 token**
- `primary`：藍（沿用 demo）
- **情緒色階**：綠 → 黃 → 橙 → 紅
- 卡片：白底 + 細邊框 + 輕微 elevation

### 14.4 無障礙：情緒不可只靠顏色表達

> ⚠️ 約 8% 男性有紅綠色覺辨識困難。若「焦慮偏高」只用紅色線條表示，對他們就是**資訊遺失**。

**情緒狀態必須同時具備：顏色 + 圖示 + 文字標籤。**

demo 圖右上的「⚠ 焦慮偏高」標籤做法是正確的，**必須保留**。

其他無障礙要求：
- 所有互動元素可鍵盤操作（客服打字為主，滑鼠切換成本高）
- 「一鍵帶入」提供鍵盤快捷鍵
- 文字對比度符合 WCAG AA

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

- 資料量小（每輪一點），效能無虞
- 深色模式只需換 CSS 變數
- 新點加入時做平滑過渡動畫
- 搭配文字說明（如 demo：「近 3 輪對話情緒持續上升…」）

### 14.6 效能

- **訊息流使用虛擬滾動**（`useVirtualList`）—— 數百則訊息直接渲染會卡頓
- 建議卡數量上限 3–5 張，超過需捲動而非無限延伸
- 情緒序列僅保留最近 N 點（建議 50）用於繪圖

### 14.7 i18n

第一版即導入 `@nuxtjs/i18n`，預設 `zh-TW`。

> 即使目前只有繁中，文案集中管理對客服系統仍然重要（用語須能統一調整）。**事後補 i18n 是最痛的重構之一。**

---

## 15. 錯誤處理與降級

### 15.1 最高原則

> **Copilot 是輔助，不得拖垮主線。**
>
> 任何 AI 或知識庫故障發生時，客服都必須還能看對話、還能回覆。

### 15.2 降級策略表

| 故障 | 降級策略 | 阻斷使用者？ |
|---|---|---|
| SDK 讀取超時 | 保留舊訊息流，頂部黃條「連線不穩，重試中」，指數退避 | ❌ 否 |
| AI 分析失敗 | **該區塊**顯示「暫時無法分析 [重試]」，其他區塊照常運作 | ❌ 否 |
| 知識庫失敗 | 建議卡降級為無 SOP 引用的通用建議，並**明確標示「未引用知識庫」** | ❌ 否 |
| SSE 斷線 | 指數退避重連（1s → 30s），帶 `Last-Event-ID` 補拉；斷線期間切 HTTP 輪詢 fallback | ❌ 否 |
| Token 過期（401） | 清 session 導回登入，**URL 保留 `conversationId`**，登入後回到原處 | ✅ 是（但無痛） |
| Rate limit（429） | 全域退避 + 佇列，**禁止重試風暴** | ❌ 否 |
| 送出訊息失敗 | 樂觀 UI 標記「傳送失敗 [重試]」，草稿存 `localStorage` **絕不遺失** | ❌ 否 |
| Webhook 重送／亂序 | event id 冪等去重 + 30s 對帳輪詢補漏 | ❌ 否 |
| **撞單偵測（別人已回覆）** | 攔下並提示，提供 [仍要送出] [捨棄] [重新產生] | ✅ **是（刻意的）** |

### 15.3 說明

最後一列是**全系統唯一刻意阻斷**的情況 —— 因為重複回覆客戶的傷害，遠大於多按一次按鈕的成本。

其餘所有故障一律**靜默降級**：在對應區塊呈現清楚但不干擾的狀態，不使用全頁錯誤畫面、不彈出 modal 打斷工作。

---

## 16. 部署與安全

### 16.1 部署形態

Docker 多階段建置 → `node .output/server/index.mjs`。

iMBrace 提供 K8s 安裝文件，若能**同集群部署**可省一段網路跳躍，延遲會明顯改善（輪詢頻率高，效果顯著）。

> ⚠️ **一旦上 K8s 多副本，Redis 即為必需品**（見 §8.3）。單副本才可使用記憶體實作。

### 16.2 秘密管理

> **`IMBRACE_API_KEY`、AI 金鑰、`SESSION_SECRET`、`WEBHOOK_SECRET` 一律只放 server-side `runtimeConfig`，絕不進 `runtimeConfig.public`。**

`public` 底下的內容會直接打包進瀏覽器，一次疏忽即外洩。此條列為專案憲法約束。

### 16.3 Webhook 安全

三者缺一不可：

1. **HMAC 驗簽** —— 未驗簽的 webhook endpoint 等於開放任何人偽造 JOIN 事件
2. **時間戳容忍 ±5 分鐘** —— 防重放攻擊
3. **event id 去重** —— 冪等

可行時追加來源 IP 白名單。

具體規格待 iMBrace 提供，見 `IMBRACE_QUESTIONS.md`。

### 16.4 稽核與 PII

**稽核軌跡**（客服系統的合規需求）：誰在何時 JOIN、送出什麼、採納哪張建議卡。

**PII 處理**：
- **日誌絕不可輸出訊息全文**（含客戶個資），只留 id 與雜湊
- 客製 AI 部分若送往外部 LLM，**對話內容出境**需事先確認公司資安政策
- 錯誤回報／監控工具同樣不得挾帶訊息內容

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

> **設計目標：M0–M3 完全不依賴任何未定的外部 API。**
>
> 一週後 webhook 規格到位時，你已有一個能跑的完整系統，剩下只是替換 provider 實作。這正是整個抽象層設計的目的 —— **不讓外部進度阻塞你的進度。**

### M0 — 地基

**內容**
- Nuxt 骨架、`ssr: false` + Nitro 設定
- OTP 三段式登入、BFF session（cookie + server store）
- SDK client factory
- `StateStore` / `EventBus` 介面 + 記憶體實作（**API 全 async**）

**驗收**
- [ ] 能以 OTP 登入並選擇組織
- [ ] 能列出對話清單
- [ ] access token 不出現在任何前端資源或網路回應中

**外部依賴**：無

---

### M1 — 對話主線

**內容**
- 對話列表、訊息流（虛擬滾動）、Composer、join / leave
- Presence 上報與顯示
- SSE 管線 + 自動重連
- `MessageSource` 抽象 + `PollingMessageSource` + 共享訂閱 + 自適應頻率
- **送出前樂觀併發檢查**
- JOIN 雙路徑去重

**驗收**
- [ ] 兩個瀏覽器開同一對話：A 送出後 B 在 **2 秒內**看到
- [ ] B 帶入草稿準備送出時，若 A 已回覆，**必須被攔截並提示**
- [ ] 三個瀏覽器檢視同一對話時，該對話**只被輪詢一次**
- [ ] 分頁切至背景後，輪詢頻率確實下降
- [ ] SSE 斷線後能自動重連並補齊斷線期間的訊息

**外部依賴**：無

---

### M2 — Copilot 核心

**內容**
- 摘要卡、情緒 sparkline、建議卡、一鍵帶入
- 前景／背景分級、debounce、快取
- **AI 可先用 mock provider**，UI 先行完成
- 知識庫先用 `StaticSopProvider`

**驗收**
- [ ] JOIN 後 **3 秒內**出現摘要與首批建議
- [ ] 一鍵帶入可用，且帶入後仍會做撞單檢查
- [ ] 背景對話**不跑**完整 AI（可由監控指標驗證）
- [ ] 切換至背景對話時會補跑完整分析
- [ ] AI 失敗時，訊息流與 Composer **仍完全可用**
- [ ] 建議卡的 `sopId` 若不在檢索結果白名單中，該卡被丟棄

**外部依賴**：無

---

### M3 — 知識庫與結案

**內容**
- `LocalVectorProvider`（`ai.embed()` 自建索引 + cosine 檢索）── 見 §12.2
- SOP 離線建索引 script（`scripts/build-sop-index.ts`）
- 知識庫快查（**inline 面板**，見 §12.3；Command Palette 為後續增強）
- 交接摘要 / 結案摘要 + **人審面板**
- `board-repository` 冪等寫入
- Data Board schema setup script

**驗收**
- [ ] 自然語言快查能回傳含 SOP 編號與分數的結果
- [ ] 建議卡能正確引用真實 SOP 條目
- [ ] 摘要**可編輯後**才寫入 Board
- [ ] **重複觸發摘要為覆蓋而非新增**
- [ ] LEAVE 產生交接摘要、resolved 產生結案摘要，兩者不混用

**外部依賴**：Data Board schema 需先建立

---

### M4 — 生產化

**內容**
- Redis 實作換入（`RedisStateStore` / `RedisEventBus`）
- `WebhookEventSource` 接入（規格到位後）+ HMAC 驗簽
- 30s 對帳輪詢
- 監控指標、健康檢查
- Docker / K8s 部署

**驗收**
- [ ] **雙副本部署下：webhook 打到 A 副本、客服 SSE 連在 B 副本，仍能推達**
- [ ] 雙副本下同一對話只有一個副本在輪詢
- [ ] 偽造簽章的 webhook 請求被拒絕
- [ ] 重送的 webhook 事件不會造成重複分析
- [ ] rolling deploy 後，客服的 session 與分析結果不遺失

**外部依賴**：webhook 規格

> ⚠️ 第一項驗收標準（雙副本 webhook 跨實例推達）是**最容易被跳過、上線後最容易爆**的一項，務必寫死在驗收清單中。

---

## 19. 已知風險與待確認事項

> **2026-08-25 更新**：已完成 `@imbrace/sdk@1.4.0` 的**型別層靜態分析**（不需憑證），
> 詳見 `docs/SDK_FINDINGS.md`。下表的「狀態」欄反映最新證據等級：
>
> | 標記 | 意義 |
> |---|---|
> | ✅ 已解除 | 已有明確證據，風險消失或降至可忽略 |
> | 🔵 已確認 | 風險確實存在且已證實，因應方式已定 |
> | 🟡 待實測 | 型別層答不了，需 `scripts/spike/` 的 live probe 驗證 |
> | ⚪ 未變動 | 尚未取得新證據 |
>
> ⚠️ **型別能證明「API 表面是否存在」，不能證明「資料是否填得滿」。**
> 標為 🟡 者一律以 live probe 為準。

### 19.1 風險表

| # | 風險 | 狀態 | 影響 | 因應 |
|---|---|---|---|---|
| 1 | **Knowledge / DocIQ 無查詢 API** | 🔵 **已確認** | 建議卡的 SOP 引用與信心度無法直接取得 | 全套 `.d.ts` 只有 `processEmbedding`（建立），無任何 query／retrieve。**改採自建向量檢索**：`ai.embed()` 已公開，SOP 量小可在記憶體／Redis 算 cosine，分數完全自控。見 SDK_FINDINGS §4 |
| 2 | **Webhook payload 規格未定** | ⚪ | JOIN 偵測的精確度 | `PollingEventSource` 過渡；`WebhookEventSource` 骨架先備 |
| 3 | ~~Webhook 若無 operator 完整清單~~ | ✅ **已解除** | ~~Presence 永久盲區~~ | **`Conversation.users[]` 已提供完整 operator 清單**（`{id, display_name, avatar_url}`），輪詢路徑即可自行取得，不必依賴 webhook。已實作於 `mappers.diffOperators()`。**A-1 從 P0 降級** |
| 4 | **Webhook 簽章機制未知** | ⚪ | 無法驗簽 = 任何人可偽造 JOIN 事件 | 上線前必須取得規格，否則 endpoint 不得對外開放 |
| 5 | **SDK 無訊息層級推播** | 🔵 已確認 | 依賴輪詢，有延遲與 API 壓力 | 自適應頻率 + 共享訂閱；持續向 iMBrace 爭取 WS |
| 6 | AI 信心度校準 | 🔵 影響擴大 | 失準會導致功能被客服棄用 | `messageSuggestion` 不回傳信心度（見 #17），檢索分數需自建。**改為：自建 embedding 檢索分數 + 模型自評，後端校準** |
| 7 | 多副本狀態共享 | ⚪ | 上 K8s 後 SSE 推播直接失效 | 介面 day-1 async；M4 換 Redis |
| 8 | Nuxt UI Pro 授權 | ⚪ | 商用可能需付費 | 開發前確認授權狀況，必要時以 Tailwind 自建替代元件 |
| 9 | 對話內容送外部 LLM | 🟡 範圍可能擴大 | 資安／合規 | 若 #17 確認無 structured output、或無 vision 模型，則需外送外部服務，**出境範圍從文字擴大到語音與影像**。`05-ai-structured.ts` 會一併檢查 `is_vision_available` |
| 10 | Data Board 欄位型別限制 | ⚪ | schema 可能需調整 | M3 前先實測，setup script 可重跑 |
| 11 | **語音／圖片是否已由平台文字化** | 🟡 **待實測（最高優先）** | **決定 M2 工作量級距**，若需自建 STT 與視覺分析則 +5~10 人日 | 型別層強烈暗示「未文字化」：`MessageType` 無 `audio`、`MessageContent` 無 transcript 欄位（只有 `caption`，那是使用者附註**不是** AI 描述）。但後端可能回傳型別外欄位 → `02-multimodal.ts` 掃描原始 JSON 確認 |
| 12 | **JOIN 後 AI 仍持續自動回覆（已確認）** | ⚪ | 撞單成為預設情況而非邊緣情況 | 已列為 P0（H-1）求證單一對話暫停 API；撞單檢查須一併攔截 AI 訊息，並補上 Composer 即時警示 |
| 13 | **訊息發送者身分無法區分** | 🟡 **待實測（風險升高）** | 撞單防護產生大量誤判，功能形同虛設 | ⚠️ **`ConversationMessage.from` 是裸 `string`，沒有任何 type 判別欄位**。只能靠對照 `contact_id` 與 `users[]` 反推，AI 訊息屬**排除法推定**。若「已離開對話的客服」也落在未歸類集合中，會被誤判為 AI。`01-sender-type.ts` 蒐集 `from` 值域證據 |
| 14 | 知識庫條目時效性 | ⚪ | 客服可能依據已失效的 SOP 回覆客戶 | `KnowledgeHit.updatedAt` 顯示於介面，過舊者標示提醒 |
| 15 | **主管強制介入擋不住官方介面** | ⚪ | 主管可能誤以為已完全接管 | 介面誠實標示邊界；`removeTeamMember()` API 確實存在，但實際效力待確認（H-4） |
| 16 | ~~角色權限來源未定~~ | ✅ **多半已解除** | ~~自建權限系統的離職同步缺口~~ | **`OrganizationMembership` 帶 `role?: string` 與 `is_admin?: boolean`**，`auth.authenticate()` 即回傳。實際有值則直接沿用平台角色，不必自建。`00-auth.ts` 確認填充率 |
| 17 | 🆕 **`ai.complete()` 不支援 structured output** | 🟡 待實測 | 違反憲法第 4 條與 §11.7「絕不解析自由文字」 | `CompletionInput` 無 `response_format`／`tools`／`tool_choice`。但模型清單有 `is_toolCall_available` 旗標，額外欄位或可 passthrough → `05-ai-structured.ts` 實測三種寫法。**最壞情況**：prompt 要求 JSON + Zod 驗證 + 重試，M2 +1~2 人日 |
| 18 | 🆕 **`messageSuggestion` 無信心度與 SOP 引用** | 🔵 **已確認** | **建議卡從「接平台 API」變成「完整自建」** | 回傳型別就是 `{ suggestions: string[] }`，沒有分數也沒有來源。demo 的「SOP 3.2｜信心度 92%」無法由平台內建能力產生。**§2 決策摘要的「建議回覆先用 `messageSuggestion`」需修正**，它只能當低品質 fallback。M2 工作量顯著增加 |
| 19 | 🆕 **`messages.list()` 無 `conversation_id` 也無 `since`** | 🟡 **待實測（可能阻塞 M1）** | §9 整套輪詢策略的地基 | 簽章僅 `{type, q, limit, skip}`。三種候選解已實作於 `server/sources/message-fetch.ts`，由 `03-incremental.ts` 實測。**最壞情況**（只能全量取回本地過濾）→ §9.2 自適應頻率表必須整個重算 |

### 19.2 目前最需要收斂的三件事

| 優先 | 事項 | 為何是它 |
|---|---|---|
| 🔴 1 | **#11 語音／圖片文字化** | 唯一還能讓總工時再增 5–10 人日的變數。**必須用含語音與圖片的對話跑 `02-multimodal.ts`** |
| 🔴 2 | **#19 訊息取數策略** | 若三種策略皆不可行，M1 直接卡住，且無法靠自己解決 —— 必須問 iMBrace |
| 🔴 3 | **#13 發送者身分** | 決定撞單防護（產品核心價值）能否成立 |

**待向 iMBrace 確認的完整清單見 `docs/IMBRACE_QUESTIONS.md`**（可直接轉貼給對方）。
**SDK 靜態分析的完整結果見 `docs/SDK_FINDINGS.md`**。

---

## 20. 工程慣例

### 20.1 命名

| 對象 | 慣例 | 範例 |
|---|---|---|
| 檔案 | kebab-case | `session-manager.ts` |
| Vue 元件 | PascalCase | `SuggestionCard.vue` |
| Composable | `use` 前綴 | `useCopilotSession.ts` |
| 型別／介面 | PascalCase，不加 `I` 前綴 | `CopilotSession` |
| API 路由 | RESTful + Nitro method 後綴 | `[id]/join.post.ts` |
| SSE 事件 | `名詞.動詞過去式` | `summary.updated` |
| EventBus topic | `類型:id` | `conversation:abc123` |

### 20.2 程式碼約束（列為憲法）

1. **`server/` 以外的任何地方不得 import `@imbrace/sdk`**
2. **`runtimeConfig.public` 不得存放任何秘密**
3. **`StateStore` / `EventBus` 的所有方法必須是 async**
4. **AI 輸出必須經 Zod 驗證後才進入系統**
5. **`sopId` 必須經白名單後驗**
6. **Copilot 相關故障不得阻斷訊息流與 Composer**
7. **外部依賴必須藏在 provider 介面之後**
8. **日誌不得輸出訊息全文**

### 20.3 Git

- 目前此目錄**尚非 git repo**，開工前需 `git init`
- Conventional Commits
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

**為何適合**：Spec Kit 的 `/clarify` 階段會強制把規格缺口顯性標記出來。本專案天生就有大量未定規格（見 §19），而每個未定的外部依賴剛好對應一個 provider 介面 —— 這是很乾淨的切分。

**為何不全套**：Spec Kit 是 feature 導向，而 M0／M1 本質上是地基（Nuxt 骨架、登入、SSE 管線、抽象層），硬寫成 user story 會產生大量儀式性文件卻無對應的決策價值。

**實務提醒**：
- Spec Kit 需要 git repo，請先 `git init`
- 產出的 `tasks.md` 顆粒度偏細，建議跑完 `/plan` 後**人工快速掃過 tasks 再 `/implement`**，勿全自動放行

---

## 附錄：本文件的維護

- 架構決策變更時，同步更新 §2 決策摘要與對應章節
- iMBrace 規格確認後，更新 §19 與 `IMBRACE_QUESTIONS.md`，並將對應 provider 從「待實作」改為「已實作」
- 本文件同時是 Spec Kit 的憲法來源，變更會影響後續所有 feature 的 plan 生成
