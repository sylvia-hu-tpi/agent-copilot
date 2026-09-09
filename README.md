# AgentCopilot 文件索引

iMBrace 平台 Conversations 模組的即時客服輔助擴充。

---

## 文件

| 文件 | 用途 | 讀者 |
|---|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | **主開發指引**。完整架構、技術選型、資料流、目錄結構、AI 契約、階段切分與驗收標準，含所有平台實測結論 | 所有開發者，開工前必讀 |
| [docs/CONSTITUTION.md](./docs/CONSTITUTION.md) | **不可違反的架構約束**（九條憲法）。寫 code 前必讀，也是 Spec Kit 憲法的來源 | 所有開發者與 AI agent |
| [docs/IMBRACE_QUESTIONS.md](./docs/IMBRACE_QUESTIONS.md) | 待向 iMBrace 團隊確認的規格清單，可直接轉貼。⚠️ **會離開這個 repo**，過期內容等於浪費對方時間 | 對接窗口 |
| [docs/DESIGN_FEEDBACK.md](./docs/DESIGN_FEEDBACK.md) | 給 Design 的畫布回饋（尚未解決的落差＋刻意偏離的理由）。⚠️ **會離開這個 repo** | Design 窗口 |
| [docs/PLATFORM_CAPABILITY.md](./docs/PLATFORM_CAPABILITY.md) | 平台能力實測記錄 | 開發者 |
| [docs/SDK_FINDINGS.md](./docs/SDK_FINDINGS.md) | SDK 實測記錄（型別與實際 API 的落差） | 開發者 |
| [docs/AGENT_PROMPTS.md](./docs/AGENT_PROMPTS.md) | 五個 iMBrace agent 的 system prompt 與模型**快照**。⚠️ 生成物，改它不會改變 agent 行為；動 AI 路徑前先跑 `npm run spike:agent-prompts` 比對漂移 | 開發者 |
| [docs/DESIGN_TOKENS.md](./docs/DESIGN_TOKENS.md) | 設計規格。⚠️ 衍生自 Claude Design 畫布，可能與畫布脫鉤 | 開發者 |
| [deploy/README.md](./deploy/README.md) | SIT 單機 compose 的**現場操作**：前置、首次部署、換版、除錯症狀表。形態與前提的正典在 ARCHITECTURE §16.1 | 部署者、SI |

## 參考素材

| 檔案 | 說明 |
|---|---|
| `docs/demo_agentCopilot01.png` | 目標介面設計稿 —— 上半部（情緒提示、AI 語意即時建議） |
| `docs/demo_agentCopilot02.png` | 目標介面設計稿 —— 下半部（知識庫快查、AI 階段對話紀錄、**結案摘要自動填入**） |
| `docs/iMBrace_conversations01.png` | iMBrace 平台現有的 Conversations 介面 |

---

## 快速上手

### 開工前必做

1. 閱讀 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §2 核心決策摘要與 §8 抽象層
2. 閱讀 [docs/CONSTITUTION.md](./docs/CONSTITUTION.md) 全文（不長，但每一條都會影響實作）
3. 若 [docs/IMBRACE_QUESTIONS.md](./docs/IMBRACE_QUESTIONS.md) 仍有未確認項目，送交 iMBrace 團隊（P0 項目會影響 M3／M4）

### 換一台機器繼續開發

`git clone` 之後有**兩樣東西 git 補不回來**，都在 `.gitignore` 裡，要從舊機器手動搬：

1. `.env.local` —— iMBrace 憑證、五個 agent 的 `assistant_id`、Board id、`SESSION_SECRET`。用加密管道搬，不走 Slack／Email 明文。
2. `scripts/spike/out/` —— 所有實測結論的**原始證據**（CLAUDE.md：結論有疑慮時以此為準）。多數 spike 對接正式資料、部分含個資，**不能隨手重跑**；整個資料夾打包搬。

其餘都可重產，不用搬：`node_modules/`、`.nuxt/`、`.output/`、docker image、`deploy/certs/`、`deploy/agent-copilot.env`（由 `.env.local` 抄成 `NUXT_*`）。

新機器的順序：裝 Node **24.20.0**（與 `Dockerfile` 對齊）、Docker Desktop、Git ＋ SSH key → `git clone` → 放回 `.env.local` → `npm install` → `npm run typecheck && npm test` 綠燈即可開工；要起 compose 照 [deploy/README.md](./deploy/README.md) 本機那節。

### 三十秒理解這個專案

> 客服在 iMBrace 按下 JOIN 接手對話的那一刻，必須在數秒內讀完數十輪對話、判斷情緒、找出 SOP、組織回覆。
>
> **AgentCopilot 消除這段空窗。**

技術上是一個 **Nuxt 4 SPA（`ssr: false`）+ Nitro BFF**：前端只跟自家 BFF 溝通，BFF 持有 iMBrace 憑證、執行 AI 分析、以 SSE 推播結果。

所有尚未確定的外部依賴（webhook 規格、Knowledge API）都藏在 provider 介面之後，**因此規格未定不會阻塞開發**。

⚠️ 但 provider 抽象擋不掉**能力面**的缺口：M3 剩餘三條（附件 vision／文件分析、429 全域退避佇列）卡在
「平台沒有內建 OCR」與「沒有書面 rate limit 規格」，2026-09-08 已標為「卡外部回覆·已安置」
（[§18 M3](./docs/ARCHITECTURE.md#18-開發階段切分與驗收)）。M3.5 則是刻意設計成一題都不用等。

### 開發階段

| 階段 | 內容 | 外部依賴 | 現況（2026-09-08） |
|---|---|---|---|
| M0 | 地基：Nuxt + Nitro + OTP 登入 + BFF session | 無 | ✅ `m0-done` |
| M1 | 對話主線：訊息流、presence、SSE、輪詢、撞單防護 | 無 | ✅ `m1-done` |
| M2 | Copilot 核心：摘要、情緒、建議卡、一鍵帶入 | 無 | ✅ `m2-done`（三項時效未達標·已安置） |
| M3 | 知識庫與結案摘要 | Data Board schema（✅ 已建立） | 結案摘要與人審面板已合回 `main`（`m3-006-done`）；剩餘三條卡 iMBrace 回覆·已安置，M3 **保持開放**（無 `m3-done`），待回覆後回頭完成 |
| M3.5 | SIT 展示就緒：image、`deploy/` 單機 compose、SIT 走查 | 公司 SI 的 VM 與對外連線（**不等 iMBrace 回覆，也不等 M3 收尾**） | 🚧 進行中 |
| M4 | 生產化：Redis、webhook、對帳、K8s 多副本 | webhook 規格 | 未開始 |

詳見 [docs/ARCHITECTURE.md §18](./docs/ARCHITECTURE.md#18-開發階段切分與驗收)。
