# AgentCopilot 文件索引

iMBrace 平台 Conversations 模組的即時客服輔助擴充。

---

## 文件

| 文件 | 用途 | 讀者 |
|---|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | **主開發指引**。完整架構、技術選型、資料流、目錄結構、AI 契約、階段切分與驗收標準，含所有平台實測結論 | 所有開發者，開工前必讀 |
| [docs/CONSTITUTION.md](./docs/CONSTITUTION.md) | **不可違反的架構約束**（九條憲法）。寫 code 前必讀，也是 Spec Kit 憲法的來源 | 所有開發者與 AI agent |
| [docs/IMBRACE_QUESTIONS.md](./docs/IMBRACE_QUESTIONS.md) | 待向 iMBrace 團隊確認的規格清單，可直接轉貼。⚠️ 唯一會離開這個 repo 的文件 | 對接窗口 |
| [docs/PLATFORM_CAPABILITY.md](./docs/PLATFORM_CAPABILITY.md) | 平台能力實測記錄 | 開發者 |
| [docs/SDK_FINDINGS.md](./docs/SDK_FINDINGS.md) | SDK 實測記錄（型別與實際 API 的落差） | 開發者 |
| [docs/DESIGN_TOKENS.md](./docs/DESIGN_TOKENS.md) | 設計規格。⚠️ 衍生自 Claude Design 畫布，可能與畫布脫鉤 | 開發者 |

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

### 三十秒理解這個專案

> 客服在 iMBrace 按下 JOIN 接手對話的那一刻，必須在數秒內讀完數十輪對話、判斷情緒、找出 SOP、組織回覆。
>
> **AgentCopilot 消除這段空窗。**

技術上是一個 **Nuxt 4 SPA（`ssr: false`）+ Nitro BFF**：前端只跟自家 BFF 溝通，BFF 持有 iMBrace 憑證、執行 AI 分析、以 SSE 推播結果。

所有尚未確定的外部依賴（webhook 規格、Knowledge API）都藏在 provider 介面之後，**因此 M0–M3 不被任何外部進度阻塞**。

### 開發階段

| 階段 | 內容 | 外部依賴 |
|---|---|---|
| M0 | 地基：Nuxt + Nitro + OTP 登入 + BFF session | 無 |
| M1 | 對話主線：訊息流、presence、SSE、輪詢、撞單防護 | 無 |
| M2 | Copilot 核心：摘要、情緒、建議卡、一鍵帶入 | 無 |
| M3 | 知識庫與結案摘要 | Data Board schema |
| M4 | 生產化：Redis、webhook、對帳、K8s | webhook 規格 |

詳見 [docs/ARCHITECTURE.md §18](./docs/ARCHITECTURE.md#18-開發階段切分與驗收)。
