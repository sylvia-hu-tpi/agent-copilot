# 設計規格：色票／字級／元件結構／文案

> 來源：Claude Design 畫布（`AgentCopilot.dc.html`），2026-08-25 由 artifact 內容逐字擷取。
> 畫布連結：https://claude.ai/code/artifact/f4090229-a1b1-40ee-a6e6-c32a25e7e5bf
> （會隨畫布後續編輯而變動內容 —— 本文件與 `docs/wireframe/` 截圖是當時內容的凍結快照，實作請以此為準；
> 若畫布已更新且需要重新擷取最新內容，見文末附錄）
>
> 視覺參考見 `docs/wireframe/`（每個畫面各有淺色／深色截圖）；本文件是可查詢、可 diff 的精確規格 ——
> 色票 hex 值、px、逐字文案不建議從截圖肉眼還原，以本文件為準。
> 目前涵蓋 **1a（登入）／1b（選擇組織）**。1c／1d（主工作區）截圖已備妥，文字規格待後續擴充。
>
> 對應頁面：`app/pages/login.vue`（1a）、`app/pages/organization.vue`（1b）。見 `ARCHITECTURE.md` §5.1。

| Artboard | 說明 | 截圖 |
|---|---|---|
| 1a | 登入頁 | `docs/wireframe/01-login_lightTheme.png` / `_darkTheme.png` |
| 1b | 選擇組織 | `docs/wireframe/02-organization_lightTheme.png` / `_darkTheme.png` |
| 1c | 主工作區 | `docs/wireframe/03-workspace_lightTheme.png` / `_darkTheme.png` |
| 1d | 主工作區 — 載入中／空狀態 | `docs/wireframe/04-workspace-empty_lightTheme.png` / `_darkTheme.png` |

---

## 0. Token 對應策略

這是自訂的 navy 品牌色階，**不是** Nuxt UI 預設的中性灰階（`bg-default`/`text-muted` 那組）。
建議走 `app.config.ts` 自訂主題，而非硬套 Nuxt UI 語意 token：

| 設計 token | Nuxt UI 對應 | 備註 |
|---|---|---|
| `--navy` | `primary` | 品牌主色 |
| `--warn` | `error` | 錯誤／警示 |
| `--active` | `success` | 1b 的「N 個進行中」pill |
| `--open` | `warning` | 1c 才用到（對話狀態） |
| `--ai` / `--agent-bg` | 無對應，需自訂 | 1c 才用到（發送者標籤色） |
| `--bg`／`--surface*`／`--border*`／`--text*` | 無對應，需自訂 | 結構性色階，非語意色，建議直接以 CSS 變數形式進 `assets/css/main.css` 的 `:root`／`[data-theme]`，元件內用 `var(--surface)` 等，不必勉強套 Nuxt UI 的中性階 |

字體：
- 內文：`'Noto Sans TC','Helvetica Neue',Helvetica,sans-serif`
- 代號／ID／驗證碼／倒數計時：`'IBM Plex Mono',monospace`

---

## 1. 色票

```css
:root, [data-theme="light"] {
  --bg:#f3f4f6; --surface:#ffffff; --surface-2:#f8f9fb; --surface-3:#eef0f4;
  --border:#e2e5ea; --border-strong:#cfd4dc; --border-dash:#c7ccd6;
  --text:#1b2230; --text-2:#596274; --text-3:#8b93a3;
  --navy:#1b3a6b; --navy-2:#274d88; --navy-fg:#ffffff; --navy-soft:#eaeff7; --navy-soft-bd:#cbd8ea;
  --active:#17845c; --active-bg:#e7f5ef; --open:#a3700a; --open-bg:#fbf2df;
  --ai:#5348a8; --ai-bg:#f2f1fb; --ai-bd:#d9d6f0;
  --agent-bg:#e9eff8; --agent-bd:#c9d7ea;
  --warn:#a24a06; --warn-bg:#fdf1e3; --warn-bd:#eec69b;
  --skel:#e7e9ee; --skel-hi:#f2f3f7;
  --shadow:0 1px 2px rgba(16,24,40,.05);
}
[data-theme="dark"] {
  --bg:#101319; --surface:#181c23; --surface-2:#1e232c; --surface-3:#252b35;
  --border:#2a303a; --border-strong:#3a4250; --border-dash:#414a58;
  --text:#e5e8ee; --text-2:#9fa8b8; --text-3:#6f7889;
  --navy:#2e5896; --navy-2:#3a6cb4; --navy-fg:#eef4fc; --navy-soft:#1c2635; --navy-soft-bd:#2c3d57;
  --active:#3cbb8c; --active-bg:#14251f; --open:#d8a340; --open-bg:#271f12;
  --ai:#a79cf2; --ai-bg:#1d1e2e; --ai-bd:#343559;
  --agent-bg:#1b2433; --agent-bd:#2b384c;
  --warn:#e2a469; --warn-bg:#2a2015; --warn-bd:#553f22;
  --skel:#232833; --skel-hi:#2c323d;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}
```

`--ai`／`--agent-bg`／`--agent-bd`／`--open`／`--open-bg` 是 1c（主工作區）用的發送者／對話狀態標籤色，1a/1b 不會用到，先列在這裡備查。

---

## 2. 字級

| 用途 | size | weight | 備註 |
|---|---|---|---|
| 標題（登入／輸入驗證碼） | 19px | 700 | |
| Eyebrow 徽章（AGENTCOPILOT／選擇組織／artboard 編號） | 11px | 700 | letter-spacing .06em |
| 說明文字（subtitle） | 12.5px | 400 | line-height 1.6 |
| 欄位 label | 12px | 500 | |
| 輸入框文字 | 13.5px | 400 | OTP 格另計，見下 |
| OTP 數字格 | 22px | 400 | `IBM Plex Mono` |
| 輔助／meta 文字 | 11–11.5px | 400 | 常搭 `IBM Plex Mono`（org id、版本號、時間） |
| 主按鈕文字 | 13.5px | 500 | |
| 組織名稱 | 14px | 500 | |
| 組織 meta（org_id · role） | 11.5px | 400 | `IBM Plex Mono` |
| 狀態標籤（載入中／無組織／送出中／錯誤／驗證碼錯誤） | 10.5px | 700 | letter-spacing .08em，color `var(--text-3)` |
| 錯誤內文 | 12px | 400 | color `var(--warn)` |

---

## 3. 卡片容器

```
background: var(--surface)
border: 1px solid var(--border)
border-radius: 12px
box-shadow: var(--shadow)
```

| Artboard | 寬度 | padding |
|---|---|---|
| 1a-email | 440px | `28px 28px 24px` |
| 1a-otp | 440px | `28px` |
| 1b-list | 560px | header `20px 22px 16px`、清單 `10px`、footer `12px 22px` |
| 1b-loading / 1b-empty | 400px | `18px` |

頁面層級（設計稿沒有明確畫出整頁 chrome，此段為建議、非逐字擷取）：整頁 background 用 `var(--bg)`，卡片在 viewport 置中。

---

## 4. 1a — 登入頁

### 4.1 Email 步驟（`data-screen-label="1a-email"`）

由上到下：

1. Header row：`AGENTCOPILOT` 徽章 + `v1.0 · internal`（mono，`var(--text-3)`）
2. 標題「登入」+ 說明文字
3. Email 欄位：label →輸入框（mail icon 15px + input，`height:40px` `border-radius:8px` bg `var(--surface-2)`）→ 輔助文字（info icon 12px）
4. 主按鈕「傳送驗證碼」+ arrow-right icon，`height:40px` bg `var(--navy)`，hover `var(--navy-2)`
5. 狀態變體（虛線分隔，`border-top:1px dashed var(--border)`）：
   - 送出中：disabled 按鈕 + `loader-2` icon（spin 動畫）+「正在寄送驗證碼…」
   - 錯誤：`alert-circle` icon + 錯誤訊息（`var(--warn-bg)` 底 + `var(--warn-bd)` 邊）

### 4.2 OTP 步驟（`data-screen-label="1a-otp"`）

1. Header row：**純圖示返回按鈕**（`arrow-left`，26×26）+「步驟 2 / 2」
   ⚠️ **沒有「改用其他 email」文字連結** —— 只有圖示按鈕，不要多做一個文字連結元件
2. 標題「輸入驗證碼」+「已寄送至 {{maskedEmail}}，10 分鐘內有效。」
3. **驗證碼是 6 格分離輸入，不是單一輸入框**（確定答案）：6 個獨立 `<input>`，各 `56×56px`，`text-align:center`，`font-size:22px`，`font-family:'IBM Plex Mono'`，`maxlength=1`，`inputmode="numeric"`，`border-radius:9px`；focus 時 `border-color:var(--navy-2)` + bg 轉 `var(--surface)`
4. 主按鈕「驗證並登入」，樣式同上
5. 重新寄送列：左「沒收到？ {{mm:ss}} 後可重新寄送」（倒數格式 `mm:ss`），右「重新寄送」按鈕在倒數中為 disabled（`refresh-cw` icon）
6. 錯誤狀態（虛線分隔示範）：已輸入格顯示錯誤色（`var(--warn)` 文字／`var(--warn-bg)` 底／`var(--warn-bd)` 邊）+ 錯誤訊息（`alert-circle` icon 15px）

---

## 5. 1b — 選擇組織

### 5.1 組織清單卡（`data-screen-label="1b-list"`）

- Header（`padding:20px 22px 16px`，底部 border）：「選擇組織」徽章 + 右側使用者 email（mono）；副標說明
- 每列組織（`padding:12px`，`border-radius:9px`）：
  - 左：38×38 圓角方塊，2 字母縮寫（如 TW/UK/QA）
  - 中：組織名稱（14px/500）+「org_id · 角色」（11.5px mono）
  - 右：狀態 pill —— 「N 個進行中」（`var(--active)`/`var(--active-bg)`）／「無進行中」（純文字 `var(--text-3)`）／「唯讀」（外框 pill）
  - 最右 `chevron-right` icon
  - **樣式狀態**：預設透明邊框；hover 時 bg 轉 `var(--surface-2)` + border 轉 `var(--border)`。設計稿把首列畫成「選中」樣式（`var(--navy-soft)` 底）純屬示範 —— 這是點擊即導航的清單，非持久選取的表單，實作成 `:hover` 即可，**不需要 selected 持久態**
  - **沒有 disabled 列樣式** —— 唯讀角色的組織一樣可點擊，只是角色是唯讀
- Footer（`padding:12px 22px`，頂部 border）：左說明文字，右「登出」按鈕（`log-out` icon，無框透明底）

> ⚠️ **已知缺口**：「N 個進行中」需要每個組織的進行中對話數。目前已知的 auth API
> （`loginWithOtp()` 回傳的 `organizations[]`，見 `ARCHITECTURE.md` §7.1）只帶 `role`/`is_admin`，
> **沒有對話數欄位**。這可能是設計稿超前於已確認的 API 能力 —— 需另外呼叫
> `conversations.getViewsCount()` 之類的 API 補這個數字，或此欄位先隱藏。未定案。

### 5.2 載入中（`data-screen-label="1b-loading"`，獨立卡片）

**骨架屏，不是 spinner**。兩列，每列：38×38 圓角骨架方塊（shimmer 動畫）+ 兩行文字骨架
（第一行 shimmer 動畫、第二行純色靜態，寬度約 52%/34% 與 40%/28%）。

### 5.3 無組織（`data-screen-label="1b-empty"`，獨立卡片）

虛線框（`border-dash`）內：`building-2` icon（22px）+ 標題（13.5px/500）+ 說明文字 +「重新整理」按鈕（outline 樣式）。

---

## 6. 文案（逐字，設計稿原文）

### 1a-email
- 徽章「AGENTCOPILOT」／meta「v1.0 · internal」
- 「登入」／「輸入公司 Email，我們會寄送 6 位數驗證碼。此工具僅供內部客服團隊使用。」
- label「公司 Email」／placeholder「you@company.com」／helper「僅接受已建檔的內部網域」
- 按鈕「傳送驗證碼」／loading「正在寄送驗證碼…」
- 錯誤「此 Email 不在內部名單中，請聯絡系統管理員開通。」

### 1a-otp
- 「步驟 2 / 2」
- 「輸入驗證碼」／「已寄送至 {{maskedEmail}}，10 分鐘內有效。」
- 按鈕「驗證並登入」
- 「沒收到？」＋「{{mm:ss}} 後可重新寄送」／按鈕「重新寄送」
- 錯誤「驗證碼不正確，還可嘗試 {{n}} 次。」

### 1b
- 徽章「選擇組織」
- 「你隸屬於 {{n}} 個組織。選擇要進入的組織，之後可從右上角切換。」
- 組織列範例資料（**示意假資料，非文案** —— 實際要接真實組織清單）：
  台灣客服中心／org_twn_cs·客服專員／14 個進行中；
  英國客服中心／org_uk_cs·客服專員／無進行中；
  品質稽核組／org_qa·唯讀稽核／唯讀
- footer「組織清單由後台權限決定，無法自行加入。」／按鈕「登出」
- 載入中標籤「載入中」
- 無組織標籤「無組織」／標題「此帳號尚未加入任何組織」／
  說明「請聯絡系統管理員將你加入客服組織後，再重新登入。」／按鈕「重新整理」

> ⚠️ 先前討論中提過的「接下來的加入對話與回覆都會以此身分留下紀錄。」**設計稿裡沒有這段文字**，
> 是對話過程中自行補充的說法，不是設計稿原文。是否採用由開發端決定，此處僅釐清來源。

---

## 附錄：如何重新擷取（1c/1d 或設計稿更新後）

Claude Design 畫布以 bundler 包裝，`Artifact action:"read"` 拿到的是 loader script，不是可直接解析的 HTML。實際內容需要多解一層：

```js
// 1. 讀 artifact，raw HTML 存成本機檔案（Artifact read 的回傳說明會給檔案路徑）
// 2. 從 <script type="__bundler/template"> 取出內容 —— 這是一個 JSON 字串，內容才是真正的頁面 HTML
const templateMatch = raw.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/)
const html = JSON.parse(templateMatch[1])   // 逐字的頁面 HTML，含 CSS 變數與所有文案
```

之後在 `html` 字串裡找 `<section id="1c">`／`<section id="1d">` 或對應的 `data-screen-label` 即可定位內容。
