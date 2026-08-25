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
| 即時機制 | **第一版輪詢 + SSE；webhook 規格到位後替換** | iMBrace SDK 目前無公開推播機制。以 provider 抽象隔離，換來源時上層不動 |
| 輪詢頻率 | **前景 3s／背景 30s**（§9.2 修訂表） | ⚠️ **2026-08-25 實測**：`since`／`after`／`since_id` **全部被忽略**，每次都是全量取回；回應中**無任何 rate limit 標頭**可自我調節。取保守值，待書面規格再定案 |
| Presence | **四來源合併**：自家 SSE + `u_` 前綴反推 + **對話 `mode`** + webhook（M4）（§10.2） | ⚠️ `users[]` 不可用（實測為**團隊名冊**而非該對話參與者）。✅ **`mode ∈ {manual, hybrid}` 代表有人能送出訊息**，JOIN 時立刻跳動、不需對方發言，且在清單 payload 中（成本為零）。原本「同事已 JOIN 但未發言」的盲區已解除；`automation` 對「無人」與「有人但唯讀」仍無法區分，但唯讀者送不出訊息，不構成撞單風險 |
| AI 來源 | 🟡 **iMBrace AI Agent（第一階段）**，介面留待替換 | **2026-08-25 實測修正**：`ai.complete()`、`ai.embed()`、`messageSuggestion` 確實 404，但 **`aiAgent.streamChat` 有 11/27 個 agent 可用**，且 JSON 結構化輸出 4/4 次可解析。原記載「27 個全部無法執行」為抽測外推的錯誤結論 |
| 知識庫 | 🟡 **透過掛知識庫的 AI Agent**，`KnowledgeProvider` 抽象不變 | **2026-08-25 實測修正**：無**獨立**檢索端點（此結論不變），但 agent 的 SSE `tool-output-available` 事件會吐出 `RAGknowledge` 工具輸出，**含檔名與 chunk 原文** → 引用來源拿得到。仍缺：**相關度分數**、**檢索品質調校手段**（實測問「電梯困人」未命中同名 SOP 檔） |
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
| WebSocket（自建雙向） | 本專案的即時需求是單向推播（server → client），SSE 更簡單、原生支援自動重連。⚠️ 補齊漏訊不靠 `lastEventId`，靠對帳 —— 見 §9.5 |

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
│   │   │   ├── KnowledgeSearch.vue  # Command Palette
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
│   │   │   ├── organization.post.ts # 手動 exchange（保留 refresh_token，見下方 ③）
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

### 5.1 登入流程的三個實作約束（2026-08-25 實測後修正）

初版目錄結構寫的是「OTP 兩段式登入」且直接標註底層 SDK 方法，兩者都會導致實作出錯。
以下三點是踩過的坑，實作 `server/api/auth/*` 前必讀。

#### ① 是三段式，不是兩段式 —— 且第三段要有自己的畫面

```
① client.requestOtp(email)                  → 寄出驗證碼          … login.vue
② client.loginWithOtp(email, otp)           → login_acc_ token
                                              + organizations[]   … login.vue
③ selectOrganization(organizationId)        → acc_ token          … organization.vue
```

第 ② 步**一次回傳 token 與組織清單**，不需再呼叫 `organizations.list()`。

**決策：第 ③ 步一律顯示選擇畫面，即使 `organizations[]` 只有一筆。**

理由：
- 客服看得到自己正要以哪個組織身分進入系統 —— 之後所有 JOIN、回覆、稽核軌跡都掛在這個身分上，
  靜默替他選會讓誤入錯組織的情況難以察覺
- 未來支援跨組織切換時不必補一個新流程
- 單筆時的畫面成本極低（一張卡片 + 一顆按鈕），不值得為此寫兩條分支

`organization.vue` 是獨立路由而非 `login.vue` 的第三個步驟，
因為此時 `login_acc_` token 已存在 BFF session，重新整理頁面不該把使用者踢回輸 email。

#### ② 必須用 `client.*` 便利方法，不可用 `client.auth.*`

| ❌ 底層方法 | ✅ 便利方法 | 為何 |
|---|---|---|
| `auth.authenticate()` | `client.loginWithOtp()` | 前者**只回傳資料、不保存 token**，後續呼叫等於未認證，會 401 |
| `auth.exchangeAccessToken()` | `client.selectOrganization()` | 前者要求請求本身帶 `x-organization-id`；後者會先 `setOrganizationId` 再呼叫 |

#### ③ `selectOrganization()` 會丟棄 `refresh_token`

便利方法只保留 `token`。若要讓客服在 8 小時 session 內不被迫重跑 OTP，
`organization.post.ts` 必須改走手動流程：先 `setOrganizationId`，
再自行呼叫 exchange 端點並把 `refresh_token` 一起存進 session。

實作範本見 `scripts/spike/00-auth.ts`。

> **三者的共同後果**：登入是唯一「不照著寫就整個系統起不來」的環節，
> 且錯誤形態是 401 而非明確報錯，很難從症狀反推。M0 應優先把這段跑通並寫成整合測試。

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

iMBrace 的 OTP 登入是三段式（✅ 已實測跑通）：

```
① client.requestOtp(email)                 → 寄出驗證碼
② client.loginWithOtp(email, otp)          → login_acc_ token + organizations[]（含 role）
③ client.selectOrganization(organizationId) → acc_ token（+ refresh_token）
```

> **⚠️ 必須用 `client.*` 的便利方法，不可用底層的 `client.auth.*`。**
>
> `auth.authenticate()` 只回傳資料、**不會保存 token**，後續呼叫等於未認證會 401。
> `client.loginWithOtp()` 才會把 token 存進 `TokenManager`。
>
> 同理 `auth.exchangeAccessToken()` 需要請求本身帶 `x-organization-id`，
> `client.selectOrganization()` 會先 `setOrganizationId` 再呼叫。
> 若需保留 `refresh_token`（`selectOrganization` 會丟棄它），
> 可參考 `scripts/spike/00-auth.ts` 的手動流程。

> **2026-08-25 實測結果**：
> - 第 ② 步**一次回傳 token 與組織清單**，不需再呼叫 `organizations.list()`
> - `organizations[]` 帶 `role`（實測值 `admin`）與 `is_admin`（實測值 `false`）
>   → 主管判定**可望**沿用平台角色，但兩欄位語意不一致，值域待確認（H-5）
> - 第 ③ 步回傳 `refresh_token` → **token 可續期**，客服不會在工作中被迫重跑 OTP
> - `organizations.list()` 僅 access token 可呼叫，API Key 會 401
>   → 印證「以客服個人 token 執行」的設計是對的

> **UI 對應**：第 ①② 步在 `login.vue`，第 ③ 步在獨立的 `organization.vue`，
> **一律顯示選擇畫面**（即使只有一個組織）。理由見 §5.1 ①。

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
| `ConversationEventSource` | **本地快路徑**（我方客服按下 JOIN） | `WebhookEventSource` |
| `MessageSource` | `PollingMessageSource` | `WebhookMessageSource` 或 `WsMessageSource` |
| （新增）對話變動偵測 | `ConversationListPoller` | webhook 取代，但**保留為對帳輪詢**（§9.4） |

> ### ⚠️ 2026-08-25 修訂：`PollingEventSource` 不存在，也不會被實作
>
> 初版寫的是「`PollingEventSource` 透過定期 `conversations.list()` 比對 team member
> 變化來推斷 JOIN／LEAVE」。**這條路已被 §10.2 的二次實測封死** ——
> 它唯一可能的輸入 `users[]` 是**團隊名冊**而非對話參與者，
> diff 出來的結果會是「整個團隊同時 JOIN 了每一個對話」。
>
> **輪詢路徑下無論如何都答不出「是誰」**，因此 M1 不去假裝有一個 JOIN 事件來源：
>
> | 需求 | M1 的實際做法 |
> |---|---|
> | 我方客服 JOIN | 本地快路徑 —— 我們自己發起的，當然知道是誰。經 §4.3 去重後廣播 |
> | 官方介面同事 JOIN | **只知道「有人能送出訊息」**（`mode ∈ {manual, hybrid}`），指不出名字 |
> | 官方介面同事發言 | 訊息 `u_` 前綴反推，此時才知道是誰 |
>
> 硬要把第二列包裝成 `JoinEvent` 就得捏造一個 operator ——
> 那是 §10.2 明文禁止的事。`ConversationChange`（`server/sources/types.ts`）
> 誠實地只承載「有沒有變動」，不承載「是誰」。
>
> `mappers.diffOperators()` 因此**沒有可用輸入**，僅保留給 spike 蒐證，不得接上 presence。

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

> 🔴 **2026-08-25：實作順位待定**，取決於 iMBrace 對 `IMBRACE_QUESTIONS.md` §0-3 的回覆。

| 順位 | 實作 | 狀態 |
|---|---|---|
| ? | `AgentKnowledgeProvider` | 🔴 **最可能的方向** —— 透過掛載 Knowledge Hub 的 AI Agent 查詢。前提是 agent 可用（§0-1），且能取得引用來源（§0-3a） |
| ? | `BoardsSearchProvider` | 🟡 備案 —— `boards.search()` 為 Meilisearch 相容關鍵字檢索，**有條目 ID**。待確認能否取回分數 |
| 3 | `StaticSopProvider` | ✅ 可實作 —— 讀 `config/sop.yaml`，開發期與離線 fallback |
| — | ~~`BoardsRagProvider`~~ | ❌ 撤銷 —— `processEmbedding()` 之後沒有檢索 API |
| — | ~~`LocalVectorProvider`~~ | ❌ 撤銷 —— 依賴的 `ai.embed()` 回 404 |

> **無論最終選哪一條，`KnowledgeProvider` 介面本身不變。**
> 這正是抽象層的目的：外部能力邊界未定時，開發不必停下來等。

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

> **2026-08-25 修訂：下表已依實測放寬。** 原表是在「支援 `since` 增量拉取」的假設下訂的，
> 但實測 `since`／`after`／`since_id` **全部被忽略**（回傳筆數與全量相同），
> 且回應中**沒有任何 rate limit 標頭**可供自我調節。
> 每次輪詢都是全量取回，因此不能沿用原本的頻率。

| 對話狀態 | 輪詢間隔 | ~~原值~~ |
|---|---|---|
| 前景聚焦 + 已 JOIN | **3s** | ~~1.5s~~ |
| 前景聚焦 + 觀察中 | **5s** | ~~3s~~ |
| 背景 + 已 JOIN | **15s** | ~~5s~~ |
| 背景 + 觀察中 | **30s** | ~~10s~~ |
| 連續 5 次無新訊息 | 指數退避，上限 **60s** | ~~15s~~ |
| **出現新訊息** | **立刻跳回最快檔** | 不變 |
| 瀏覽器分頁 `hidden` | 全部降至 **30s** 以上 | ~~10s~~ |

**為何前景 JOIN 從 1.5s 放寬到 3s：**

撞單防護的有效性不靠輪詢頻率 —— 真正有效的是 §10.4 的**送出前樂觀併發檢查**，
那一層在按下送出的當下才比對版本，不受輪詢延遲影響。
輪詢頻率只影響「畫面上多久看到同事的訊息」，3 秒對此完全足夠，
而 API 壓力少一半。**寧可把預算留給真正需要即時的地方。**

> ⚠️ 此表為**暫定值**，待 iMBrace 提供書面 rate limit 規格後定案。
> 在那之前的原則是「取保守值」—— 撞到未知上限的後果（429 或被封）
> 遠比慢 1.5 秒嚴重。

### 9.3 成本評估（2026-08-25 依實測重算）

**取數方式已確定**：`GET /v1/conversation_messages?conversation_id=<id>` ——
後端**強制要求** `conversation_id`（不帶會 400），只是 SDK 的 `messages.list()` 未公開此參數。
實作見 `server/sources/message-fetch.ts` 的 `raw-conversation-id` 策略。

> ### ⚠️ 對話有三種識別碼 —— 這是最容易靜默出錯的地方
>
> | 來源 | 欄位 | 範例 | 是什麼 |
> |---|---|---|---|
> | `conversations.search()` | `id` | `b6f76f09-…` | 對話 id，裸 UUID |
> | 訊息 | `conversation_id` | `conv_b6f76f09-…` | 同一個對話，帶前綴 |
> | `conversations.get()` | `id` / `_id` | `tcu_6cd3cee1-…` | **不是對話 id** —— 是 team_conversation 這筆關聯記錄自己的 id。該物件另有 `conversation_id` 欄位，那才是對話 id |
>
> 查詢端點 `?conversation_id=` **兩種形式都接受**，所以打得通不代表比得對。
>
> #### ✅ 2026-08-25 實測：怎麼從對話 id 拿到 `tcu_` id
>
> | 呼叫 | 結果 |
> |---|---|
> | `conversations.getByConversationId(id)` | ❌ `{ data: [], total: 0 }` —— **兩種 id 形式都回空** |
> | `conversations.get(id)`（`GET /v1/team_conversations/{id}`） | ✅ 完整詳情，**裸 UUID 與 `conv_` 前綴都接受** |
>
> 也就是說 `{id}` 這個路徑參數**同時吃對話 id 與 `tcu_` id**，平台自行解析。
> 回傳物件的 `id` / `_id` 是 `tcu_`，另有 `conversation_id` 欄位為 `conv_<裸 UUID>`。
>
> ⚠️ 這推翻了先前「`get()` 只吃 `tcu_` id，要反查只能靠 `getByConversationId()`」的推論 ——
> 那是照 SDK 編譯後的 URL 組法推出來的，沒有實測。**照它寫的話所有對話都查不到詳情，
> JOIN / LEAVE / 切換 mode 全壞**，而錯誤形態是 404 而非「查詢方式錯」。
> 實作見 `server/services/imbrace.ts` 的 `getConversationDetail()`，
> 證據見 `npm run spike:write`。
>
> **正規形式取裸 UUID**，一律經 `mappers.normalizeConversationId()` / `sameConversation()` 轉換。
> 這個坑已經造成過兩次實際損害：
> ① `precisionOf()` 把 100% 正確的取數判成 0%，差點誤判 M1 被阻塞；
> ② `toConversation()` 原本取 `raw.id`，同一個對話經由 `search()` 與 `get()` 會得到兩個不同的鍵 ——
> CopilotSession、presence、EventBus topic 全部以對話 id 為鍵，症狀會是
> 「訊息進來了但面板沒反應」，極難追查。

**但不支援增量拉取**，每次都是全量。已實測 `since` / `after` / `since_id` /
`from_created_at` / `start_time` / `created_at_gt` 等**八種寫法全部被忽略**（回傳筆數與全量相同）。

以 §9.2 修訂後的頻率估算：

| 情境 | 對話數 | 間隔 | req/s |
|---|---|---|---|
| 前景聚焦（每位客服 1 個） | 20 | 3s | ≈ 6.7 |
| 背景已 JOIN | 40 | 15s | ≈ 2.7 |
| **合計**（20 位客服 × 平均 3 對話，共享訂閱後） | 60 | — | **≈ 9.4 req/s** |

比原估的 12 req/s 更低，但**每個請求的 payload 大得多**（全量而非增量）。
實測單一對話最多 398 則訊息 —— 這才是真正的成本所在。

**必要的緩解措施（M1 就要做，不可延後）：**

1. **`limit=N` 只取最新 N 則**（建議 N=50），而非整串對話
   —— ✅ **實測確認訊息預設即由新到舊排序**，`limit=N` 直接就是最新 N 則，
   不需要 `sort` 參數、也不需要 `skip=total-N`。這讓本項緩解幾乎零成本。
   首次載入才取全量（`skip` 亦實測有效，可正常分頁回補歷史）
2. **本地以 `lastMessageId` 比對**，只把新增的部分推給前端（SSE payload 仍是增量的）
3. **並發控制** —— 同時 in-flight 請求上限 5，避免瞬間尖峰觸發未知的 rate limit
4. **`ETag` / `If-None-Match` 探測** —— 若後端支援，可省下大量重複傳輸；尚未實測

### 9.3.1 ✅ 已驗證：改用清單輪詢，成本降一個量級

> **2026-08-25 實測確認**（`npm run spike:presence`，時間軸見 `scripts/spike/out/12-presence-timeline.json`）

`conversations.search()` 的清單 payload 帶 `last_message_at` 與 `updated_at`，
**兩者都會即時更新**：實測送出一則訊息後的同一個取樣週期（≤2 秒）內，
`list.last_message_at` 就從 `08-24T10:01:21` 跳到 `08-25T07:57:53.900`，
與該則訊息本身的時間戳一致。`updated_at` 另外還會在 JOIN／LEAVE 時跳動。

**因此輪詢架構改為兩層：**

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

**這同時解決了三個原本各自為政的問題**：新訊息偵測、JOIN／LEAVE 偵測、
以及 §9.1 共享訂閱要解決的「同一對話被多人重複輪詢」—— 第一層本來就只有一份。

> ⚠️ **仍要保留第二層的 `lastMessageId` 比對**。`last_message_at` 只說「有新東西」，
> 不說「新了幾則」，且時間戳相同的兩則訊息無法區分。

> ⚠️ **`last_message_at` 實測填充率僅 83%**（部分對話為 `(無)`）。
> 對這些對話必須退回逐對話輪詢，不可假設全體適用。

> **輪詢仍不是瓶頸，AI 呼叫才是。** 見 §11.2 的前景／背景分級策略。
> 實測 AI 單次呼叫中位數 **5.0 秒**、最慢 **12.2 秒**，與輪詢完全不在同一量級。

> ⚠️ 上述全部為暫定值。待 iMBrace 提供 rate limit 規格與增量拉取的正確參數後重新定案。
> 對應追問項見 `IMBRACE_QUESTIONS.md` B-2b、G-2。

### 9.4 換成 webhook 後仍要保留對帳輪詢

Webhook 會漏、會亂序、會重送。生產環境必須保留**低頻對帳輪詢（每 30s）**，比對本地 `lastMessageId` 與遠端，補上遺漏的訊息。

> 省略此機制的後果是「偶爾少一則訊息」—— 這是最難重現、最難追查的一類 bug。務必在 M4 一併實作。

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

#### ⚠️ 2026-08-25 兩處修訂

**① `presence.updated` 的 payload 不是 `PresenceEntry[]`。**

初版寫 `operators: PresenceEntry[]`，但 §10.2 的第三個來源
（`mode ∈ {manual, hybrid}`）**只知道「有人能送出訊息」，指不出是誰** ——
沒有 operatorId 也沒有名字，塞不進以 operatorId 為鍵的陣列。
硬塞就得捏造一個名字，那正是 §10.2 明文禁止的。因此改為：

```ts
interface PresenceSnapshot {
  operators: PresenceEntry[]      // ①SSE 與 ②訊息反推 —— 皆具名
  unidentifiedActor: boolean      // ③mode —— 有人能送，但無法指名
  mode: ConversationMode | null
}
```

**② 斷線補齊不靠 `Last-Event-ID`，靠對帳。**

初版寫「每則事件都帶 `id`，供斷線重連時以 `Last-Event-ID` 補拉」。
那需要一份「已送出事件」的儲存 —— 放在單一副本的記憶體裡，
**M4 上多副本後重連到別的副本就補不到**，而那正是「偶爾少一則訊息」
這類最難追查的 bug。

改採**對帳式補齊**：前端重連後以自己的 `lastMessageId` 打
`GET /api/messages?conversationId=…&since=…` 重新對帳。
這與 §9.4「webhook 上線後仍要保留對帳輪詢」是同一個原則 ——
**真相一律回源頭取，不依賴傳輸層的可靠性假設。**
事件仍帶 `id`，但只用於排序與除錯。

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

#### 2026-08-25 決策：`Conversation.users[]` 不可作為 presence 來源

原本規劃以 `users[]` 補齊「不在 AgentCopilot 但已 JOIN 的同事」。**實測後此路不通** ——
但**理由與初版寫的不同**，初版的量測位置是錯的，此處已依二次實測改寫。

| 實測 | 結果 |
|---|---|
| ~~掃 12 個對話的 `users[]`~~ | ~~12/12 全為空陣列~~ ← **量錯位置**：那是 `conversations.search()` 的輕量 payload，該處 `users` 本來就是 `null` |
| `conversations.get()` 的 `users[]` | **14 人**，含 `id`、`display_name`、`is_bot`、`teams[].team_user_role` |
| 兩個**不同**對話各自的 `users[]` | **同一批 14 人**，含 `Bot` 與 `team_user_role: observer` |

也就是說：這個欄位**不是空的，但它是「團隊名冊」而不是「這個對話的參與者」**。
拿它做 presence 會把整個團隊都標成「正在檢視」—— 比空陣列更糟。
`diffOperators()` 依然沒有可用輸入。

> ⚠️ **教訓**：初版結論（欄位是空的）與修正後結論（欄位有值但語意不對）**指向同一個決策**，
> 但若當初就照初版理由去補救，會走向「等 webhook 補 operator 清單」這條完全錯誤的路。
> 量測位置錯誤造成的假結論，危險之處不在結論本身，而在它推導出的下一步。

> ⚠️ 這同時是 `mappers.ts` 初版的致命錯誤來源 —— 舊版靠比對 `users[]` 反推發送者，
> 會把所有 `u_` 客服誤判為 AI，撞單防護直接失效。已改為前綴判別（見 `senderTypeOf`）。
> **此項不受本次修正影響**：即使 `users[]` 有值，它是團隊名冊，用來反推發送者一樣是錯的。

#### ✅ 第四個來源：`mode` 欄位（2026-08-25 實測確認）

實測方式：對一個對話依序 JOIN → 送訊息 → LEAVE，每 2 秒取樣一次所有候選欄位。

| 欄位 | JOIN 時 | LEAVE 時 | 可用性 |
|---|---|---|---|
| **`mode`** | `null` → **`manual`** | **`manual` → `automation`** | ✅ **雙向正確，且在清單 payload 中** |
| `is_joined` | `false` → `true` | `true` → `false` | 🟡 雙向正確，但**是「我」的視角**（以該客服的 token 查詢），看不到同事 |
| `is_agent_joined` | `null` → `true` | **維持 `true`（不回復）** | ❌ **單向黏著**，代表「曾經有人加入」而非「現在有人在」 |
| `is_presence` | 全程 `false` | 全程 `false` | ❌ 與 JOIN 狀態無關，語意不明 |
| `users[].length` | 維持 14 | 維持 14 | ❌ 確認為團隊名冊 |

**結論：`mode` 是目前唯一「雙向正確、且能看到同事」的平台端 presence 訊號。**
它同時出現在清單 payload 中，因此**一次清單輪詢就能得知所有對話有沒有真人在處理**，
成本為零（§9.3.1 的第一層本來就要跑）。

#### `mode` 到底回答了哪個問題（2026-08-25 二次實測定案）

四個值全部實測到，且**確認出現在清單 payload**（12 筆中 6 筆有值：`automation`×5、`manual`×1）：

| `mode` | 實測時的 `is_joined` | 意義 | **有沒有「我以外的人」能送出訊息** |
|---|---|---|---|
| `null` | — | 從未 JOIN | ❌ 沒有 |
| `manual` | `true` | 有人 JOIN，AI 關閉 | ✅ **有** |
| `hybrid` | `true` | 有人 JOIN，AI 同時開著 | ✅ **有**（且 AI 也會送） |
| `automation` | **`true` 或 `false` 都可能** | 要嘛沒人，**要嘛有人但選了 Automation Only（唯讀）** | ❌ 沒有 |

> ⚠️ **`automation` 是有歧義的** —— 實測 01:02 切到 Automation Only 時，
> `is_joined` 仍是 `true`（人還在，只是變成唯讀），mode 卻已是 `automation`，
> 與「根本沒人」完全無法區分。

**但這個歧義對我們無害，因為 `mode` 回答的不是「有沒有人在」，而是「有沒有人能送出訊息」** ——
Automation Only 的同事**送不出訊息**，撞不了單。而撞單防護要的正是後者。

```ts
// 正確的判定：是否有他人可能送出訊息
const someoneElseCanSend = mode === 'manual' || mode === 'hybrid'
```

> ⚠️ 因此 ③ 的能力要誠實描述為「**偵測可能撞單的對象**」，而非「presence」。
> 用 Automation Only 純觀察的同事在我方畫面上看不到 —— 這是已知且可接受的缺口，
> 因為他造不成撞單。**但 UI 文案不可寫成「目前沒有其他人在看」**，那是超出資料能支持的宣稱。

**這補上了 §10.2 原本最痛的盲區** —— 「同事在官方介面 JOIN 但尚未發言」。
修訂後的來源表：

| # | 來源 | 涵蓋 | 延遲 | 能否指出「是誰」 |
|---|---|---|---|---|
| ① | 自家 SSE 上報 | 只涵蓋我方使用者 | < 200ms | ✅ 可 |
| ② | 訊息 `u_` 前綴反推 | 官方介面的同事 | 一個輪詢週期 | ✅ 可（但只在發言後） |
| ③ | 🆕 **`mode ∈ {manual, hybrid}`** | 涵蓋所有「能送出訊息」的人 | 一個清單輪詢週期 | ❌ **只知道「有人能送」，不知道是誰** |
| ④ | JOIN/LEAVE webhook | 全涵蓋 | 即時 | 待規格（M4） |

> ⚠️ **③ 只能回答「有沒有人」，不能回答「是誰」。** UI 必須誠實呈現這個差別，
> 例如「有同事正在處理（無法確認身分）」，不可捏造名字，也不可因為查不到名字就不顯示 ——
> 「有人在」這個資訊本身就足以阻止撞單。

> ⚠️ **`mode` 是「AI 處理模式」而非「presence」**，兩者只是在 JOIN／LEAVE 時剛好連動。
> 若平台或使用者能獨立切換 `mode`（§10.6 把它拆成 `aiReplies` / `agentCanSend` 兩個正交維度，正是預期會如此），
> 就會出現 `mode=manual` 但實際無人在看的情況。**因此 ③ 仍不可取代 §10.4 的送出前檢查。**

**M1 採用的 presence 策略（四來源合併，不等任何外部回覆）：**

> ⚠️ 2026-08-25 修訂：此表原僅三來源，未納入上方已確認的 `mode` 訊號。已補上並重新編號。

| # | 來源 | 涵蓋 | 延遲 | 能否指出「是誰」 |
|---|---|---|---|---|
| ① | **自家 SSE 上報**（誰在 AgentCopilot 開著這個對話） | 只涵蓋我方使用者 | < 200ms | ✅ 可，高可信度 |
| ② | **訊息 `u_` 前綴反推**（最近 N 分鐘發言過的客服） | 涵蓋官方介面的同事 | 一個輪詢週期 | ✅ 可，但只在對方發言後才可見 |
| ③ | 🆕 **`mode ∈ {manual, hybrid}`** | 涵蓋所有「能送出訊息」的人 | 一個清單輪詢週期（§9.3.1，成本為零） | ❌ **只知道「有人」，不知道是誰** |
| ④ | JOIN/LEAVE webhook | 全涵蓋 | 即時 | 待規格（M4） |

`N`（②的反推窗口）預設 **10 分鐘**，可設定。

**UI 必須誠實標示來源差異** —— 這是這個設計唯一的風險點，且現在有三種而非兩種呈現：

```
王大明 正在輸入…              ← ① 即時，確定在線，具名
李小華 3 分鐘前回覆過          ← ② 推測，可能已離開，具名
有同事正在處理                ← ③ 只知道有人，無法指名，無頭像可放
```

不可把 ② 顯示成「正在檢視」——「曾經發言」不等於「現在還在」，誤導客服以為有人守著而實際沒人，比不顯示更糟。
③ 不可寫成「目前沒有其他人在看」或捏造姓名 —— `mode` 回答的是「有沒有人能送出訊息」，
不是「presence」，`automation` 值本身就對「真的沒人」與「有人但唯讀觀察」無法區分（見上方 `mode` 定案段落）。
空狀態文案只能停在「沒有偵測到其他人」這個程度，或乾脆不寫。

**空狀態是常態，不是例外。** 目前資料下 ① 在單人使用時為空、② 在無人發言時為空，
PresenceBar 大多數時候會是空的 —— 設計上要讓「無人／未知」看起來正常，而不是壞掉。

> **盲區已大幅縮小，但沒有完全解除。** 原本「同事在官方介面 JOIN 但尚未發言時完全看不到」
> 已被③解決 —— JOIN 預設進入 `manual`，`mode` 立刻跳動，不需對方發言。
> **僅存的盲區是 `automation` 的歧義**：同事切成 Automation Only 純觀察時，
> `mode` 與「真的沒人」無法區分 —— 但這不構成撞單風險，因為 Automation Only 的人送不出訊息。
> 這正是 `IMBRACE_QUESTIONS.md` 要求 webhook payload 附帶**完整 operator 清單**的原因，
> 用於補上「有沒有人在純觀察」這個 presence 語意上的資訊（非撞單防護所需）。
> 在 webhook 到位前，撞單防護仍以 §10.4 的送出前檢查兜底 —— 那一層本來就是真正有效的防線。

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
// ⚠️ 只在 AI 真的會自動回覆時才把它列為撞單對象。
// Manual Mode 下 AI 不會送出，列入檢查就是製造假警報（§10.5 / §19.1 #12）。
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

`control.aiReplies === true`（Hybrid Mode）時，prompt 須明確告知模型當前為協作模式，要求產生**補位性質**的建議（情緒安撫、權限內的破例、明確承諾、升級處理），而非重複 AI 已能處理的例行說明。

若忽略此點，客服會發現「這張卡的內容 AI 兩秒前剛說過」，很快就不再看建議卡。

### 10.6 服務模式與主管接管

#### ✅ 平台已有三種模式（2026-08-25 實測 + 官方介面確認）

**這不是我們要自行發明的功能 —— iMBrace 官方介面的 Composer 上方就有這個下拉選單。**
按下 JOIN 時預設為 Manual Mode，之後客服可隨時切換：

| 官方介面選項 | 官方說明文字 | AI 自動回覆 | 客服可送出 |
|---|---|---|---|
| **Manual Mode** | Chats 1-on-1, automation is off | ✗ | ✓ |
| **Automation Only** | Replies automatically, you can only view | ✓ | **✗（唯讀）** |
| **Hybrid Mode** | Replies automatically, and you can also send messages | ✓ | ✓ |

**API 對應**：`conversations.get()` 與**清單 payload** 的 `mode` 欄位，四個值皆已實測：

| 官方介面 | API `mode` |
|---|---|
| （未 JOIN） | `null` |
| Manual Mode | `manual` |
| Hybrid Mode | `hybrid` |
| Automation Only | `automation` |

LEAVE 後回到 `automation`（與「有人但選 Automation Only」同值，見 §10.2 的歧義說明）。

> ⚠️ **`mode` 是對話層級的共用狀態，不是每個客服各自的偏好。**
> 任一位客服切換模式，其他所有人（含我方）都會跟著改變。
> 兩個後果必須在實作時處理：
> ① 我方 Composer **不可快取 mode**，必須跟著輪詢更新；
> ② 同事把模式切成 Automation Only 時，**我方的 Composer 也會被停用** ——
> 這不是 bug，但畫面必須說清楚原因，否則客服會以為系統壞了。

#### 資料模型：兩個正交維度 —— 原判定正確，且維度已確知

初版寫「不要建模成三種模式列舉，會綁死組合」。**這個判斷是對的**，
而平台的三種模式恰好就是兩個布林維度的三種有效組合：

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

> ⚠️ **2026-08-25：這個型別曾經有兩套並存的定義。**
> 本節寫 `aiReplies` / `agentCanSend`，但 §10.4 的範例碼與 §11.6、§14.1.2
> 寫的是舊的 `aiMode: 'collab' | 'human_only'`，而程式碼裡實際是後者。
> 四個 mode 全數實測後，「AI 會不會回」與「客服能不能送」確認互相獨立
> （Automation Only 時 AI 會回、客服不能送），單一列舉表達不了 ——
> 已全面統一為本節的兩維度模型。

| 平台 mode | `aiReplies` | `agentCanSend` |
|---|---|---|
| `manual` | `false` | `true` |
| `automation` | `true` | `false` |
| Hybrid（值待確認） | `true` | `true` |
| （兩者皆 false） | — | 平台無此模式，我方也不應產生 |

- 客服切到 Manual → `aiReplies = false`
- 主管按「強制介入」 → `aiReplies = false` + `lock = { by: 主管 }`

#### ⚠️ 這對 Composer 的設計是硬性約束（M1）

1. **Composer 上方必須有模式指示**，與官方介面一致 —— 客服會在兩邊切換工作，
   同一個對話在兩處顯示不同狀態會直接造成誤送。
2. **`Automation Only` 時 Composer 必須停用**，不能只是送出後失敗。
   讓客服打完一整段話才發現送不出去，比一開始就停用更糟。
3. **`Hybrid` 是撞單真正會發生的模式** —— AI 與客服同時能送。
   §10.5「AI 是第四個競爭者」整段**只在此模式下適用**，不是預設情況（見 §19.1 #12）。
4. **mode 可能隨時被改變**（客服自己改、或從官方介面改），
   因此它是輪詢要偵測的一級狀態 —— §9.3.1 的清單輪詢已涵蓋（`updated_at` 會跳動）。

#### ✅ 寫入方式已確認：切換模式與 JOIN 是同一支端點

2026-08-25 由官方介面的網路請求實測取得：

```
POST /channel-service/v1/team_conversations/_join
{ "team_conversation_id": "tcu_042cae1b-…", "mode": "hybrid" }
```

**這正是 SDK `conversations.join()` 打的端點** —— 先前判定「SDK 無法設定 mode」是錯的，
它一直都做得到，只是 SDK 的型別沒有把 `mode` 宣告出來（靠索引簽章傳入即可）。

因此：

- **JOIN** = 這支端點帶 `mode: 'manual'`（官方介面按 JOIN 的預設值）
- **切換模式** = 對已 JOIN 的對話**再打一次同一支端點**，換不同的 mode
- 兩者不是兩個動作，是同一個動作的不同參數

實作見 `server/services/imbrace.ts` 的 `joinConversation()` / `setConversationMode()` /
`leaveConversation()`。

> ### ⚠️ 兩個不照著寫就會失敗的地方
>
> **① 識別碼必須是 `tcu_` 開頭的 team_conversation id，不是對話 id。**
> 兩者都是 UUID 形狀，傳錯不會有型別錯誤，而平台對錯誤的 id 可能只是靜默不作用 ——
> 症狀是「按了 JOIN 但沒反應」。ACL 的 `assertTeamConversationId()` 會當場擋下。
>
> **② `tcu_` id 只有 `conversations.get()` 會回傳，清單 payload 沒有。**
> 因此「從對話列表按 JOIN」必須先取一次詳情才拿得到識別碼。
> 這是 M1 實作對話列表時要預先安排的一次額外請求。
>
> **③ SDK 型別把 `conversation_id` 宣告成必填，但實際 API 只要
> `{ team_conversation_id, mode }`。** 此不一致已由 ACL 的 `joinBody()` 單點吸收。

> ⚠️ **切換 mode 會影響該對話的所有人**，包含正在官方介面工作的同事。
> 這不是本地偏好設定，UI 上必須讓客服意識到這一點 ——
> 尤其切到 `automation` 會讓所有人的 Composer 都變成唯讀。

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

**候選路徑（🔴 待 iMBrace 回覆 `IMBRACE_QUESTIONS.md` §0-3 後定案）**：

| 路徑 | 可行性 | 說明 |
|---|---|---|
| **掛 Knowledge Hub 給 AI Agent 再問它** | 🔴 **目前最可能** | 平台已有 311 個 RAG 檔案、20 個 Knowledge Hub，且組織內已有掛載知識庫的 agent（如 `TBC_T2_RAG問答_Agent`）。**關鍵未知**：agent 回應能否附帶引用來源與分數（§0-3a/c） |
| `boards.search(boardId, {q, filter, limit})` | 🟡 備案 | Meilisearch 相容關鍵字檢索，**有條目 ID**，足以滿足憲法第 5 條的白名單後驗。屬關鍵字非語意，同義詞會漏；分數待確認 |
| `StaticSopProvider` | ✅ 開發期 | 讀 `config/sop.yaml`，離線 fallback |
| ~~自建向量檢索~~ | ❌ 已排除 | 依賴的 `ai.embed()` 回 404 |

> **若最終無法取得分數**，介面上的「信心度 92%」可以拿掉 —— 這是可接受的降級，
> 但**引用來源（SOP 編號）不可省**，否則憲法第 5 條（`sopId` 白名單後驗）失去依據，
> 模型將可能杜撰不存在的 SOP。此為產品品質的底線。

無論最終選哪一條，替換 provider 即可，上層不動 —— 這正是抽象層的價值。

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
> JOIN 之後 AI 仍持續運作（見 §10.5），該時點之後依然是混合狀態。真正的分界是 `mode` 切換為 `manual`（即 `control.aiReplies` 轉為 `false`）的時刻。
>
> **正確做法**：以每則訊息各自的 `sender.type` 標示，時間分段僅作為輔助視覺提示（可在 `mode` 切換處加一條分隔線）。

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
| SSE 斷線 | 指數退避重連（1s → 30s）；重連後以本地 `lastMessageId` 打 `GET /api/messages?since=` **對帳補齊**（不靠 `Last-Event-ID`，理由見 §9.5）；斷線期間切 HTTP 輪詢 fallback | ❌ 否 |
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

**驗收** ✅ **2026-08-25 全數通過**

- [x] 能以 OTP 登入並選擇組織（**選擇畫面一律出現**，即使只有一個組織）
- [x] 重新整理 `organization.vue` 不會被踢回輸 email 的步驟
- [x] session 中確實存有 `refresh_token`（見 §5.1 ③）
- [x] 能列出對話清單
- [x] access token 不出現在任何前端資源或網路回應中

**驗收方式**（皆為自動化，可重跑）：

| 項目 | 由誰驗 |
|---|---|
| 前四項 + 憑證不外洩 | `npm run build && npm run smoke` —— 對建置後的 Nitro 伺服器跑完整登入流程，並掃描每個回應的 body 與 Set-Cookie |
| `refresh_token` 確實留存 | `npm test`（`test/auth-flow.test.ts`）—— 從 HTTP 外部看不到 session 內容，那正是這個設計的重點 |
| §5.1 的三個登入坑 | 同上，以真實 SDK 打假 gateway，驗的是「SDK 實際送出什麼」 |

> **超出原驗收清單、但一併完成的項目**：
> `StateStore` / `EventBus` 介面與記憶體實作（含 TTL、poll lock、去重語意的測試）、
> 對話識別碼正規化（§9.3）、JOIN / LEAVE / mode 切換的防腐層（§10.6）。
> 後兩者原屬 M1，因 M1 前置驗證過程中確認了平台行為而順勢完成。

**外部依賴**：無

---

### M1 — 對話主線

**內容**
- 對話列表、訊息流（虛擬滾動）、Composer、join / leave
- **Presence 四來源合併**（自家 SSE + `u_` 前綴反推 + 對話 `mode`；webhook 留待 M4）—— 見 §10.2
- SSE 管線 + 自動重連
- `MessageSource` 抽象 + `PollingMessageSource` + 共享訂閱 + 自適應頻率（§9.2 修訂表）
- **只取最新 N 則 + 本地 `lastMessageId` 比對**（無增量拉取的緩解，§9.3）
- **送出前樂觀併發檢查**
- JOIN 雙路徑去重

**驗收** ✅ **2026-08-26 全數通過**（8/8，皆為可重跑的自動化驗證）

- [x] 兩個瀏覽器開同一對話：A 送出後 B 在 **4 秒內**看到（前景輪詢 3s + 傳輸餘裕）
- [x] B 帶入草稿準備送出時，若 A 已回覆，**必須被攔截並提示**
- [x] 三個瀏覽器檢視同一對話時，該對話**只被輪詢一次**
- [x] 分頁切至背景後，輪詢頻率確實下降至 30s 以上
- [x] SSE 斷線後能自動重連並補齊斷線期間的訊息
- [x] 單次輪詢**不會**每次都取回整串對話（以 398 則的對話驗證）
- [x] PresenceBar 在**無人**時顯示正常空狀態，不是壞掉的樣子
- [x] `u_` 反推的同事標示為「N 分鐘前回覆過」，**不可**標示成「正在檢視」

**驗收方式**

| 項目 | 由誰驗 |
|---|---|
| 4 秒內看到 | `npm run smoke`（`realtime-http.ts`）—— 兩條真實 SSE 連線，量從 A 按下送出到 B 的連線收到 `messages.appended` 的**實際毫秒數**。⚠️ 兩條路徑分開量：送出 API 直接 `poke()` 的捷徑（≈40ms）與**客戶回覆**（不經我方 API，只能靠第一層清單輪詢發現，≈1s）—— 後者才是 4 秒預算的來源 |
| 斷線重連補齊 | 拆兩半驗：**伺服器端**由 `npm run smoke`（`realtime-http.ts`）—— 真的關掉 socket，斷線期間插入客戶與同事各一則，重連後以 `since=` 對帳，驗「漏掉的全補回、看過的不重送、錨點失效時回整批」；**前端**由 `npm test`（`stream-store.test.ts`）—— 對真正的 `app/stores/stream.ts` 驗退避間隔、首次連線不對帳／重連才對帳、401 與斷網分開處理 |
| 撞單攔截 | `npm run smoke` —— 同事插話後送出回 409，且**平台端收到 0 次送出請求**；帶 `force` 才放行 |
| 共享訂閱只輪詢一次 | `npm test`（`message-source.test.ts`）—— 三個訂閱者、`fetchLatest` 呼叫數為 1 |
| 背景降頻至 30s | `npm test`（`poll-interval.test.ts` / `list-poller.test.ts`）—— §9.2 的表逐格釘死 |
| 不取回整串對話 | `limit` 預設 50（`DEFAULT_MESSAGE_LIMIT`）；`npm run spike:write` 已對真實對話確認 `limit=N` 即最新 N 則 |
| PresenceBar 空狀態 | `npm test`（`presence.test.ts`）+ `npm run smoke` —— 回空陣列而非 null |
| `u_` 反推不得標成「正在檢視」 | `npm test`（`presence.test.ts`）—— 斷言 `source==='message'` 且 `state!=='viewing'` |

> ### ⚠️ 最後兩項是怎麼從「只有真實瀏覽器驗得到」變成自動化的（2026-08-26）
>
> 原本的判斷是「需要兩個真實瀏覽器 + 真實平台」。**那個判斷有一半是錯的** ——
> 真正需要瀏覽器的只有 `EventSource` 本身，而那是瀏覽器的實作，不是我方的程式碼。
> 拆開之後，我方負責的部分全都驗得到：
>
> | 這一段 | 誰驗 | 怎麼驗 |
> |---|---|---|
> | 兩位客服、兩條連線、跨 session 的送出與接收 | `realtime-http.ts` | 兩個獨立 cookie jar 打**建置後的 Nitro**，SSE 以 `fetch` 手動解析。時間量的是事件抵達的實際時刻 |
> | 斷線 | `realtime-http.ts` | `AbortController` 真的關掉 socket，伺服器端的 `onClosed` 清理也會跑到 |
> | 補齊 | `realtime-http.ts` | 斷線期間插入兩則（客戶 + 同事），重連後以 `since=` 對帳 |
> | 何時重連、退避多久、重連後要不要對帳 | `stream-store.test.ts` | 對**真正的** `app/stores/stream.ts` 跑，以假 `EventSource` 注入斷線 |
>
> **仍然驗不到的一小塊**：瀏覽器 `EventSource` 在真實網路抖動下的行為，
> 以及真實平台的延遲。前者不是我方程式碼；後者的預算來源是 §9.3.1 的實測
> （`last_message_at` ≤2 秒更新），已由 spike 記錄，不需要重跑一次瀏覽器。
>
> ⚠️ **測試自己也要能被信任**：`realtime-http.ts` 第一項檢查就是
> 「兩位客服是不同的 operator」。兩條 session 若共用同一個 operatorId，
> presence 的自我排除與撞單的 `sameOperator` 過濾都會被測成「正確」而其實分不出人
> —— 這正是 `mock-gateway.ts` 改成依 email 給不同 `user_id` 的理由。

> ⚠️ **另有一項尚未驗證的寫入行為**：`sendTextMessage()` 送出成功後回傳物件的
> `id` 欄位形狀（我方用它推進版本錨點）。欄位名 `conversation_id` 已由
> `npm run spike:write` 的零投遞探測確認，但**成功路徑只在假 gateway 上跑過** ——
> 對真實客戶送測試訊息不可接受。已列為 `IMBRACE_QUESTIONS.md` H-6a。
>
> ⚠️ 這一項**不列入上面的 8 項驗收**，因為它不是「我方有沒有做對」，
> 而是「平台回什麼」—— 沒有可安全寫入的測試對話之前，任何做法都只是換個地方假設。
>
> **但它目前的實際影響是零，不是「可能靜默出錯」**（2026-08-26 追查後更正）：
>
> | 用到送出回應 `id` 的地方 | 誰讀它 | 結論 |
> |---|---|---|
> | `advanceAnchor()` 寫入 `CopilotSession.lastMessageId` | `copilotSessionOf()` —— **匯出後從未被呼叫** | 寫了沒人讀 |
> | 撞單檢查的版本錨點 | 前端的 `baseMessageId`，來自 `GET /api/messages` 的**真實訊息 id** | 與送出回應無關 |
> | 避免自己送的訊息被重複 fan-out | `PollingMessageSource` 自己的 `lastMessageId`（每輪 `sliceNew` 推進） | 與送出回應無關；`seed()` 同樣**從未被呼叫** |
>
> 也就是說 `sentId` 為 `null` 時，今天不會有任何行為改變。
> 真正該記住的是反面：**`copilotSessionOf()` 與 `seed()` 是兩個沒有讀者的機制**，
> M2 若有人開始依賴 `CopilotSession.lastMessageId`，才會第一次真的需要 H-6a。
> 屆時要嘛先驗 H-6a，要嘛把錨點改成從 `GET /api/messages` 取 —— 別默默接上去。

**外部依賴**：無

> **取數方式已於 2026-08-25 定案**（原列為「可能阻塞 M1」的 #19 已解除，見 §19.1 #22）：
> `GET /v1/conversation_messages?conversation_id=<裸 UUID>`，precision 100%，
> 訊息由新到舊排序故 `limit=N` 即為最新 N 則。
> ⚠️ 實作前務必先讀 §9.3 的「對話有三種識別碼」—— 那是本專案目前最容易靜默出錯的地方。

> **本階段刻意接受的暫行方案**（皆不阻塞，待 iMBrace 回覆後再定案）：
> presence 有盲區（同事在官方介面 JOIN 但未發言時看不到，由 §10.4 兜底）、
> 輪詢頻率取保守值、附件僅顯示檔名無法預覽。
>
> ⚠️ 其中「presence 盲區」與「輪詢頻率」兩項**可能在開工前就改善** ——
> 取決於 `12-presence-watch.ts` 的結果（§10.2 的第四個來源、§9.3 的清單輪詢線索）。
> 建議 M1 開工前先跑完，否則會照著保守假設寫出之後要重做的東西。

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
| 1 | **無獨立的知識檢索 API** | 🔵 **已確認（部分緩解）** | 檢索只能透過 agent 間接觸發 | 無 query／retrieve 端點。~~改採自建向量檢索~~ **`ai.embed()` 亦 404，自建路線不成立**。**改為：agent 的 SSE `tool-output-available` 事件解析 `RAGknowledge` 輸出**，可取得檔名與 chunk 原文（見 PLATFORM_CAPABILITY §3③） |
| 2 | **Webhook payload 規格未定** | 🔵 **已確認為 M1 的硬限制** | 輪詢路徑**答不出「是誰」JOIN 了**（`users[]` 為團隊名冊，§10.2） | M1 只做「我方本地快路徑」＋ `mode` 的匿名訊號；具名的 operator 清單必須等 webhook（`IMBRACE_QUESTIONS` A-1 已重升為 P0）。`WebhookEventSource` 骨架先備 |
| 3 | **Presence 無可靠來源** | 🟢 **大幅緩解（2026-08-25 實測）** | 同事在官方介面 JOIN 但未發言時完全看不到 | ⚠️ 先前「`users[]` 12/12 全為空」**量錯位置**（量在 `search()` 的輕量 payload，該處 `users` 為 `null`）；`get()` 實際回 14 人，但兩個不同對話回同一批人且含 `Bot` 與 `observer` → 是**團隊名冊**，仍不可用。✅ **真正的解是 `mode` 欄位**：JOIN 時 `null→manual`、LEAVE 時 `manual→automation`，**雙向正確且在清單 payload 中**，一次清單輪詢即可得知所有對話有沒有真人在處理。原本最痛的盲區已補上。⚠️ 但它只能回答「有沒有人」不能回答「是誰」，且 `mode` 本質是 AI 處理模式（§10.6 視為正交維度），仍不可取代 §10.4 送出前檢查。詳見 §10.2 |
| 4 | **Webhook 簽章機制未知** | ⚪ | 無法驗簽 = 任何人可偽造 JOIN 事件 | 上線前必須取得規格，否則 endpoint 不得對外開放 |
| 5 | **SDK 無訊息層級推播** | 🔵 已確認 | 依賴輪詢，有延遲與 API 壓力 | 自適應頻率 + 共享訂閱；持續向 iMBrace 爭取 WS |
| 6 | **無相關度分數可用** | 🔵 **已確認** | **demo 的「信心度 92%」做不到** | ~~自建 embedding 檢索分數~~ **`ai.embed()` 404，此路不通**；agent 的 RAG 工具回傳純文字亦無 score。**決策：介面拿掉信心度數字，只保留 SOP 來源**（見 MEETING_2026-08-25 §4-1） |
| 7 | 多副本狀態共享 | ⚪ | 上 K8s 後 SSE 推播直接失效 | 介面 day-1 async；M4 換 Redis |
| 8 | Nuxt UI Pro 授權 | ⚪ | 商用可能需付費 | 開發前確認授權狀況，必要時以 Tailwind 自建替代元件 |
| 9 | 對話內容送外部 LLM | 🟡 範圍可能擴大 | 資安／合規 | 若 #17 確認無 structured output、或無 vision 模型，則需外送外部服務，**出境範圍從文字擴大到語音與影像**。`05-ai-structured.ts` 會一併檢查 `is_vision_available` |
| 10 | Data Board 欄位型別限制 | ⚪ | schema 可能需調整 | M3 前先實測，setup script 可重跑 |
| 11 | **附件內容完全取不到** | 🔴 **已確認（風險升級）** | 不只是「平台沒幫我們 OCR」，是**連原始檔案都拿不到**，自建 STT／vision 也無米可炊 | 實測 `file` 訊息的 `content` 是 `{name, media_id}`，**沒有 url**；SDK 全域搜尋 `media` 無任何端點，試打 4 條猜測路徑全 404。**已列為對 iMBrace 的 P0 追問**。M1 暫行方案：僅顯示檔名，標示「無法預覽」。398 則實測訊息中 `file` 僅 4 則、`image`／`audio` 各 0 則 → 建議**多模態移出 MVP** |
| 12 | **JOIN 後 AI 是否仍自動回覆** | 🟢 **已釐清（2026-08-25）** | 撞單是預設情況還是選用情況 —— 決定 §10.5 的適用範圍 | **兩個舊結論都只對一半。** 平台有三種模式（§10.6）：JOIN 時**預設 Manual（AI 關閉）**，故撞單**不是預設情況**；但客服可切到 **Hybrid（AI 開 + 客服可送）**，此時撞單真實存在。因此 §10.5「AI 是第四個競爭者」**不刪除，改為只在 Hybrid 模式下適用**，UI 需依 mode 決定是否顯示 AI 撞單警示。~~衍生新風險：SDK 無設定 mode 的端點，我方可能只能讀不能寫~~ **已解除，見 #23** |
| 13 | ~~訊息發送者身分無法區分~~ | ✅ **已解除** | ~~撞單防護產生大量誤判~~ | **實測 `from` 帶型別前綴**：`con_` 客戶／`u_` 真人客服／`pub_` AI，398 則覆蓋率 100%。已改用前綴判別（`mappers.senderTypeOf`），不再依賴 `users[]` 反推 —— 後者在 `users[]` 為空時會把同事全數誤判為 AI。**僅剩 `pub_` 語意待 iMBrace 確認（H-3b）**，未知前綴一律歸 `unknown`，不預設為 `ai` |
| 14 | 知識庫條目時效性 | ⚪ | 客服可能依據已失效的 SOP 回覆客戶 | `KnowledgeHit.updatedAt` 顯示於介面，過舊者標示提醒 |
| 15 | **主管強制介入擋不住官方介面** | ⚪ | 主管可能誤以為已完全接管 | 介面誠實標示邊界；`removeTeamMember()` API 確實存在，但實際效力待確認（H-4） |
| 16 | ~~角色權限來源未定~~ | ✅ **多半已解除** | ~~自建權限系統的離職同步缺口~~ | **`OrganizationMembership` 帶 `role?: string` 與 `is_admin?: boolean`**，`auth.authenticate()` 即回傳。實際有值則直接沿用平台角色，不必自建。`00-auth.ts` 確認填充率 |
| 17 | **無平台層的 structured output 保證** | 🟡 **已緩解** | 違反憲法第 4 條與 §11.7「絕不解析自由文字」 | ~~`ai.complete()` 無 `response_format`~~ 該端點根本 404。改走 agent 路徑後：27 個 agent 的 `response_format` 欄位**皆為 null**（值域待確認），但**純靠 prompt 實測 4/4 次可直接 `JSON.parse`**。**仍須自建 Zod 驗證 + 重試 + 降級**，不可假設模型永遠聽話 |
| 18 | **`messageSuggestion` 端點不存在** | 🔵 **已確認** | 建議卡完全自建 | 不只是「無信心度與引用」——**端點回 404**（兩種憑證皆然），連 fallback 都當不成。建議卡改由 agent 路徑產生，引用來源從 `RAGknowledge` 工具輸出解析 |
| 19 | 🆕 **RAG 檢索品質不可調校** | 🔴 **已確認（新增，最高優先）** | **客服可能照著錯誤的 SOP 回覆客戶 —— 比沒有建議更糟** | 實測向掛了 9 份 SOP 的 agent 問「電梯困人」，**未命中同名的 `金融大樓電梯困人SOP.pdf`**，反而回傳「管理辦法」的火災逃生段落。chunk 大小、top-k、中文斷詞、同義詞**全部不在我方手上**。已列為對 iMBrace 的 P0 追問；若調不動，則觸發方案 B（改接 viki） |
| 20 | 🆕 **AI 回應延遲 5～12 秒** | 🔵 **已確認（新增）** | 右欄若等全部算完才渲染，客服會以為當掉 | 實測中位數 **5.0s**、最慢 **12.2s**、首字 **2.2s**。**M2 必須做漸進顯示**：骨架先出，摘要／情緒／建議卡各自獨立載入，建議卡串流逐字顯示，並提供「重新產生」入口（因 #19 品質不穩） |
| 21 | 🆕 **客戶資料幾乎是空的** | 🟡 **已確認（新增）** | demo 右欄的「客戶資訊卡」無內容可顯示 | 實測 19 筆 Contact：`display_name` 100% 但值是 `TWN#UK2594` 這類代號；`email`／`phone_number`／`company_name`／`birthday`／`location` **填充率皆為 0%**；`avatar_url` 僅 21%。**待決策**：改從 CRM board 關聯取得（`contact` 帶 `board_id`／`board_item_id`），或此區塊 MVP 先拿掉 |
| 22 | ~~**`messages.list()` 無 `conversation_id` 也無 `since`**~~ | ✅ **已解除（不再阻塞 M1）** | ~~§9 整套輪詢策略的地基~~ | 原判「三種策略皆不可行」是**量測錯誤**：`precisionOf()` 以字串相等比對，而對話清單給裸 UUID、訊息帶 `conv_` 前綴，於是「取回 70 則全部正確的訊息」被算成 precision 0%。修正後 `raw-conversation-id` **precision 100%**，且不帶 `conversation_id` 會 400（代表過濾強制且真實）。`since` 類參數確實不支援（八種全被忽略），但訊息**由新到舊排序**，`limit=N` 直接就是最新 N 則 → §9.3 的緩解措施成本遠低於原本設想的最壞情況。詳見 §9.3 的識別碼說明 |
| 23 | ~~**無法由 API 設定對話 mode**~~ | ✅ **已解除（同日內翻案）** | ~~「切換為全真人模式」與主管接管可能做不出來~~ | 原判「SDK 無 mode 寫入端點」**是錯的**。由官方介面網路請求實測：`POST /v1/team_conversations/_join` body `{team_conversation_id, mode}` —— **切換模式與 JOIN 是同一支端點**，而 SDK `conversations.join()` 打的正是它，只是型別未宣告 `mode`。⚠️ 但識別碼必須用 `tcu_` 開頭的 team_conversation id，且該 id **只有 `get()` 會回傳、清單 payload 沒有** → 從列表 JOIN 前需先取詳情。實作見 §10.6 |

### 19.2 目前最需要收斂的三件事

| 優先 | 事項 | 為何是它 |
|---|---|---|
| 🔴 1 | **#11 語音／圖片文字化** | 唯一還能讓總工時再增 5–10 人日的變數。**必須用含語音與圖片的對話跑 `02-multimodal.ts`** |
| 🟡 2 | **從列表 JOIN 需要多一次請求** | ~~#19 取數~~、~~#3 Presence~~、~~#12 AI 停不停~~、~~#23 mode 寫入~~ 皆已解除。剩下的是實作層取捨：`tcu_` id 不在清單 payload 中，「從對話列表直接按 JOIN」必須先 `get()` 一次。要在列表載入時預取（N 次請求）還是按下 JOIN 當下才取（多一次來回延遲）—— M1 開工時決定即可，不阻塞 |
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

### ⚠️ 推翻既有結論時的必要步驟（2026-08-25 訂立）

上面第一條「同步更新 §2 與對應章節」太抽象，實際執行時會漏。
2026-08-25 一天之內就發生四次：`mode` 被確立為 presence 來源後，
§10.2 的總表、§2 決策摘要、§18 M1 內容、`IMBRACE_QUESTIONS.md` 的 H-1
全都還停在舊版本 —— **其中 H-1 是要直接轉貼給 iMBrace 的文件**，
差點把一個我們自己已經解決的問題送出去問對方。

> 本節的摘要版已寫進專案根目錄的 `CLAUDE.md`，那份會自動載入每個 session 的 context。
> **這條規則之所以被違反過，正是因為它原本只寫在這裡** —— 近 2000 行文件的最後一頁，
> 沒有人（或 agent）會在編輯 §10 時讀到 §附錄。修改本節時請一併確認 `CLAUDE.md` 是否需要同步。

**因此，改動任何實測結論後，必須 grep 舊說法：**

```bash
# 1. 舊結論的關鍵措辭（例：從三來源改成四來源）
grep -rn "三來源\|三個來源" docs/

# 2. 舊證據的數字（例：users[] 的填充率）
grep -rn "12/12" docs/

# 3. 對外文件是否還在問已解決的問題
grep -rn "<該題編號>" docs/IMBRACE_QUESTIONS.md
```

**為何是 grep 而不是「記得去改」**：本文件近 2000 行，同一個結論散落在
決策摘要、詳細章節、里程碑驗收、風險表、對外問題清單五個地方，
而它們的措辭各不相同。人（或 agent）在改完詳細章節後，
主觀上會覺得「已經改完了」—— 這正是最危險的時刻。

**特別注意 `IMBRACE_QUESTIONS.md`。** 它是唯一會離開這個 repo 的文件。
內容過期的代價不只是不準確，而是浪費對方時間、並稀釋其他真正待答問題的份量。
自行解決的問題應**明確撤回並附上解法**，而不是默默刪掉 —— 對方可能已經在查了。

**同類風險也存在於 `docs/DESIGN_TOKENS.md`，但形態不同。** 上面四處是「同一結論散落
在本文件內部，改了一處沒改其他處」；`DESIGN_TOKENS.md` 是「衍生文件與外部活動來源
（Claude Design 畫布）脫鉤」—— 畫布可能已被編輯，但文字規格還停在擷取當下的快照。
具體的過期判斷時機見該文件附錄「何時該懷疑本文件已過期」，不重複列在此處。
