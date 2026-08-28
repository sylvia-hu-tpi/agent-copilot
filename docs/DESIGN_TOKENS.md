# 設計規格：色票／字級／元件結構／文案

> 來源：Claude Design 畫布（`AgentCopilot.dc.html`），2026-08-25 由 artifact 內容逐字擷取。
>
> ⚠️ **本文件的文字規格與 `docs/wireframe/` 的截圖，現在不是同一個時間點的快照**：
> 文字規格仍是 2026-08-25 擷取的，截圖已於 **2026-08-28** 大幅更新（1c 擴充為 12 張狀態變體、
> 2a 三張重新匯出、面板寬度統一為 420px）。兩者衝突時**以截圖為新**，但截圖的可信度較低
> （見下方各節的可信度標註）—— 正確做法是依文末附錄流程重新擷取一次，而不是二選一。
> 畫布連結：https://claude.ai/code/artifact/f4090229-a1b1-40ee-a6e6-c32a25e7e5bf
> （會隨畫布後續編輯而變動內容 —— 本文件與 `docs/wireframe/` 截圖是當時內容的凍結快照，實作請以此為準；
> 若畫布已更新且需要重新擷取最新內容，見文末附錄）
>
> 視覺參考見 `docs/wireframe/`（每個畫面各有淺色／深色截圖）；本文件是可查詢、可 diff 的精確規格 ——
> 色票 hex 值、px、逐字文案不建議從截圖肉眼還原，以本文件為準。
> 目前涵蓋 **1a（登入）／1b（選擇組織）**。1c／1d（主工作區）截圖已備妥，文字規格待後續擴充。
> ⚠️ **2026-08-28：1c 的截圖已擴充為 12 張**（基準態淺／深色 ＋ 10 個狀態變體：未接手、兩欄收合、
> 撞單攔截、結案五態…），索引與各自的判讀重點見下方「1c 的狀態變體」。文字規格仍待擴充，
> 因此這 12 張的可信度規則不變 —— **視覺參考可以，逐字文案與色值不建議肉眼還原**。
> **2a（Copilot 面板）截圖已備妥，但文字內容多數只能以截圖肉眼判讀 —— 與本文件一貫的「不建議肉眼還原」
> 原則相反，是不得已的例外，原因與範圍見 §7.0。**
>
> 對應頁面：`app/pages/login.vue`（1a）、`app/pages/organization.vue`（1b）。見 `ARCHITECTURE.md` §5.1。
>
> ⚠️ **2026-08-26**：`app/layouts/console.vue`（工作區頂欄）的 LOGO 已改用 `.ac-eyebrow`
> （見下方修正後的規格，與 1a/1b 共用同一顆元件，非猜測值），但同一個頂欄裡的「｜」分隔線、
> 組織名稱可點擊切換＋chevron，以及 `app/components/conversation/Sidebar.vue`（對話列表的頭像／
> 頻道 icon）**沒有**對應的 1c 逐字規格（見上一段「文字規格待後續擴充」），是依現有 token 與既有
> 頁面風格做的**臨場判斷**。若之後正式產出 1c 的 Copilot 面板設計，建議一併把這幾處定案，而不是只補右欄。

| Artboard | 說明 | 截圖 |
|---|---|---|
| 1a | 登入頁 | `docs/wireframe/01-login_lightTheme.png` / `_darkTheme.png` |
| 1b | 選擇組織 | `docs/wireframe/02-organization_lightTheme.png` / `_darkTheme.png` |
| 1c | 主工作區 | `docs/wireframe/03-workspace_lightTheme.png` / `_darkTheme.png`，**另有 10 個狀態變體，見下表** |
| 1d | 主工作區 — 載入中／空狀態 | `docs/wireframe/04-workspace-empty_lightTheme.png` / `_darkTheme.png` |
| 2a | Copilot 面板（取代 1c 右欄佔位） | `docs/wireframe/05-copilot-panel_4status_01.png`（四狀態總覽：展開×淺色／展開×深色／載入中／準備結案收合）、`docs/wireframe/05-copilot-panel_2status_02.png`（展開×淺色／深色，補齊第一張截圖被裁掉的下半部） |

### 1c 的狀態變體（2026-08-28 新增）

> 這些是**同一個 artboard 的不同狀態**，不是新的 artboard。全部為淺色主題（深色僅 `_darkTheme`
> 一張）。⚠️ 與上表同樣的可信度規則：**截圖只供視覺參考，逐字文案與色值不建議肉眼還原**。
>
> 規格出處：接手／離開／結案三個出口與 Copilot 面板可見性的行為定義在
> `specs/003-analysis-trigger-policy/spec.md`（FR-016～FR-023 與「Session 2026-08-28」兩節）；
> **結案流程本身屬 M3**，003 只交付出口的存在與文案。

| 截圖 | 狀態 | 實作時要看的重點 |
|---|---|---|
| `03-workspace_lightTheme.png` | 已接手（基準態） | 標題列「離開對話」（次要）＋「結案」（primary）＋輔助說明；服務模式分段控制項可切換；Copilot 面板展開 |
| `03-workspace_darkTheme.png` | 已接手 × 深色 | ⚠️ 與 lightTheme 的唯一差異：presence 列顯示「林佩君 ⟨正在結案⟩ 你仍可回覆或自行結案」（lightTheme 是「無人／未知」）。取深色色票時這是唯一要留意的多出來的元件——2026-08-28 已移除先前一併疊上的「撞單攔截」狀態 |
| `03-workspace_assignment01.png` | **未接手** | Copilot 面板**整欄不存在**（非變灰／非骨架），中欄延伸至右緣；標題列只有「接手對話」＋下拉；Composer 唯讀提示。003 FR-016 的視覺依據 |
| `03-workspace_assignment02.png` | 未接手 × 下拉展開 | 兩個選項寫出**後果**而非模式名稱：「接手並停用 AI 自動回覆」／「接手但保留 AI 自動回覆」 |
| `03-workspace_toggleLeft.png` | 左側對話清單收合 | 收合為窄直條，保留展開鈕與未讀數徽章 |
| `03-workspace_toggleCopilot.png` | Copilot 面板收合 | 收合為窄直條，保留 COPILOT 直排標籤與展開鈕。⚠️ 收合鈕**只在已接手時存在**（003 FR-017） |
| `03-workspace_orderConflict.png` | 撞單攔截 | 憲法 3.3① 的封閉集合之一。Composer 轉為「已攔截」，三個處置選項＋「草稿已保留」 |
| `03-workspace_close.png` | **結案中**（M3） | Composer **不鎖**＋上方常駐橫幅說明快照規則；標題列「取消結案」＋「結案中…」；服務模式轉唯讀；左側清單顯示「結案未完成」；面板轉「準備結案」態、其餘區塊收合 |
| `03-workspace_close_abstractExpired.png` | 結案中 — 摘要過期（M3） | 摘要區塊出現「對話有新內容，建議重新產生」；**按鈕主從對調** —— 「重新產生」轉強調樣式，「一鍵寫入 CRM」降為次要並改文案為「仍要寫入 CRM」 |
| `03-workspace_close_writing.png` | 結案中 — 寫入中（M3） | 「寫入中…」spinner；「重新產生」與**「取消結案」同時 disabled**（請求已送出，此時不可回頭） |
| `03-workspace_close_colleaguePerspective.png` | 同事視角 — 有人正在結案（M3） | presence 列顯示「林佩君 ⟨正在結案⟩ 你仍可回覆或自行結案」。⚠️ **不阻擋**同事回覆或自行結案，純提示。⚠️ 此圖右上角的登入者仍是「林佩君」，與 presence 的人同名 —— 是 mock 的瑕疵（presence 會排除自己），判讀時請當作兩個不同的人 |
| `03-workspace_close_logoutFailed.png` | 摘要已寫入但 LEAVE 失敗（M3） | 頂端橫幅「結案摘要已寫入，但離開對話失敗」＋「重試離開」；面板恢復為「即時輔助」正常態；左側「結案未完成」標記已消失（結案本身已完成） |

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

> ✅ **2026-08-25 M0 實作結果**：以上建議已採用（色票落於 `app/assets/css/main.css`）。
> **深色模式選擇器改用 `.dark`，不是本文件原寫的 `[data-theme="dark"]`。**
> 原因：`@nuxtjs/color-mode`（`@nuxt/ui` v4 內建）切換的是 `.dark` class，Nuxt UI 元件本身也依賴這個
> class；兩套選擇器並存會讓自訂區塊與 Nuxt UI 元件在切換主題時不同步。變數名與色值不變，
> 下方 §1 的程式碼區塊示意時請自行替換選擇器（`[data-theme="dark"]` → `.dark`）。

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
| Eyebrow 徽章（AGENTCOPILOT／選擇組織／artboard 編號） | 11px | 700 | letter-spacing .06em；**實心藍底白字**（`background:var(--navy)`／`color:var(--navy-fg)`），非純文字，2026-08-26 校正——先前這裡漏記背景色 |
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

> ⚠️ **刻意背離本表數字，已分兩輪調整**：2026-08-26 第一輪全面加大約 1.5px 並從固定 px
> 改為 `rem`；同日第二輪再加大約 1px。兩輪疊加後，本表原始數字與實際顯示大小相差約 2.5px
> （如 `12.5px` 原表值 → 實作 `text-[0.90625rem]` ≈ 14.5px）。改用 `rem` 也讓瀏覽器/OS 的
> 字級偏好設定能生效。實作值見 `app/assets/css/main.css`（`.ac-title`／`.ac-eyebrow`／
> `.ac-subtitle` 等）與各元件的 `text-[…rem]` class，不等於本表所列的原始凍結數字。
> **日後若依附錄流程重新核對畫布，字級這一項不要照畫布數字改回去**——這是使用者確認過、
> 分兩次做的刻意調整，不是尚未同步的落差。

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

## 7. 2a — Copilot 面板（取代 1c 右欄佔位）

> 對應畫布 artboard「2a」，2026-08-26 產出。**取代 1c（主工作區）右欄目前的佔位區塊** —— 1c 本身逐字規格仍待後續擴充（見文件開頭表格），但右欄的內容規格由本節取代，1c 章節之後補齊時不需要再處理右欄。

### 7.0 擷取方式與可信度說明（⚠️ 請先讀這段再用下面的規格）

2a 這個 artboard 在畫布原始碼裡**不是直接寫死的 HTML**，而是用 `<dc-import name="CopilotPanel" variant="…">` 四次匯入同一個元件、各給不同 `variant`（`expanded`／`loading`／`closing`）與 `data-theme`（`light`／`dark`）組合出四種畫面。附錄描述的「解開 `__bundler/template` 拿到逐字 HTML」的擷取法，**對 2a 這種 `dc-import` 元件無效**——`CopilotPanel` 元件本身的內容是在畫布的編譯後 JS bundle 裡於執行期渲染出來的，不在 template 的 HTML 字串中，擷取只能拿到四個空的 `<dc-import>` 標籤，看不到面板內部長什麼樣。這是這次擷取才發現的限制，記在這裡供下次省一次踩坑。

**可信度分兩層，不要混用：**

- **§7.1（版面／寬度）—— 逐字擷取，可信**：這段資訊來自 2a 外層 wrapper 的直接 HTML（不經過 `dc-import`），擷取方式與 1a/1b 相同，數字可信。
- **§7.2 之後（區塊內容／文案／顏色細節）—— 肉眼讀圖，僅供參考**：`dc-import` 擷取不到，只能對照 `docs/wireframe/05-copilot-panel_*.png` 用肉眼判讀後轉寫。文字有可能有辨識錯誤（截圖字級小，尤其附件檔名等次要文字），顏色僅能對照已知色票（§1）猜配對，不保證每個 pill/badge 用的 CSS 變數精確無誤。**動工前務必用「直接看畫布本人操作 `CopilotPanel` 元件原始檔」的方式再核一次**（例如請畫布擁有者提供 `CopilotPanel.dc.html`（或其元件原始檔）本身，而不是這個組合了四個 import 的 2a 頁面）——這是本文件目前唯一一段逐字文案「不是」以逐字擷取為準的地方，開發前不比對就直接照抄有較高風險。

### 7.1 版面／寬度（逐字擷取，可信）

- **四種 variant（展開／載入中／準備結案／收合）的示範容器寬度一律 420px**，可拖曳調整範圍 **320–520px**

> ### ✅ 2026-08-28：「結案態是否有獨立寬度」的未定案問題已關閉
>
> **原問題**：2026-08-25 擷取時，展開態／載入中標示 380px 而準備結案標示 420px，
> 無法判斷這是「結案狀態有獨立固定寬度」還是「畫布作者示範時隨手選的展示寬度」。
>
> **結論：沒有獨立寬度，420px 是所有狀態共用的展開寬度。** 2026-08-28 重新匯出的
> `05-copilot-panel_4status_01.png` 四態全部標示 420px，`05-copilot-panel_2status_02.png`
> 與 1c 的 12 張截圖亦然。先前的 380/420 差異來自畫布當時尚未統一，不是設計區分。
>
> ⚠️ **本行的證據等級低於本節其餘內容**：420 這個數字是從截圖上畫布自己標注的欄寬文字讀來的
> （字夠大、可信），**不是**像原本的 380 那樣經 `dc-import` 逐字擷取。若日後要據此做精確版面計算，
> 建議依文末附錄流程重新擷取一次 2a 的 wrapper HTML 確認。
>
> ✅ **實作端已對齊**：`app/pages/c/[conversationId].vue` 的 `copilotWidth` 預設值已於 2026-08-28
> 由 `ref(380)` 改為 `ref(420)`（`specs/003-analysis-trigger-policy` T031）。拖曳範圍 320–520 不變。
>
> ⚠️ **收合態沒有獨立的欄寬 token**：收合時整欄改渲染窄直條（見 `03-workspace_toggleCopilot.png`），
> 寬度由元件自己決定，`copilotWidth` 只在展開態生效 —— 不要為收合態另立一個寬度 token，
> 那會變成第二個需要跟畫布同步的數字。
- **五個區塊皆可獨立折疊**（wrapper 原文：「五區塊皆可折疊」）
- 支援淺色／深色主題
- 支援「載入骨架」與「準備結案收合」兩種特殊狀態

### 7.2 五個可折疊區塊（肉眼讀圖，見 §7.0 可信度說明）

由上到下：

1. **客戶情緒提示**（tag「近 5 輪」）—— 情緒警示 pill（如「⚠ 焦慮偏高」，橘色，疑似沿用 `--warn`/`--warn-bg` 色票）＋ 折線走勢圖（score，如「0.72 ↑」）＋ 一段文字摘要（近幾輪情緒變化與建議）＋ 情緒量表圖例（`calm`／`neutral`／`concerned`／`frustrated`／`angry`，目前所在區間會被強調顯示）
2. **AI 語意即時建議**（tag「N 則建議」，載入中顯示「產生中 x/y」）—— 一張或多張建議卡：標題 ＋ 語氣標籤（如 `apologetic`／`informative`）＋ 建議回覆全文 ＋「rationale：」推薦理由 ＋「複製」／「↵ 一鍵帶入」兩個按鈕；卡片間可捲動（「可捲動查看其餘建議」）。**「信心 NN」分數不是每張卡都有**——截圖裡第一張卡（安撫開場與時效承諾）畫了「信心 92」，緊接著的第二張卡（補寄工單建立流程）沒有信心分數，設計稿本身就是條件式呈現，見下方說明。（2026-08-27 訂正：卡片標題前原本畫有 `SOP #編號` 徽章，經核對真實知識庫資料後確認 iMBrace 沒有這套編號制度，畫布擁有者已同步移除該徽章並更新截圖與 artifact，見 `specs/002-suggestion-knowledge-search/research.md` #2）
3. **知識庫自然語言快查** —— 搜尋輸入框（placeholder 為示範查詢句，如「發票補寄要多久」）＋ 結果清單，每筆：標題 ＋「插入為回覆」／「展開全文」按鈕；過期文件會多一條警示列（如「⏱ 已超過 12 個月未更新，引用前請確認」，疑似沿用 `--warn` 系色票）。（2026-08-27 訂正：本區塊原本仍畫有「SOP #12 · 2026/05」一類的編號＋日期格式，與第 2 區塊已移除編號的決定不一致；畫布擁有者已同步移除該編號並更新截圖與 artifact，見 `specs/002-suggestion-knowledge-search/research.md` #2）
4. **AI 階段完整對話紀錄**（tag「共 N 則訊息」）—— 逐則對話紀錄（客／AI／客服三種發送者），支援附件顯示（PDF：檔名 ＋「PDF・檔名僅供辨識，無法預覽」；圖片：檔名 ＋「可預覽縮圖」）；區塊內可捲動，底部有一行「{{顯示｜隱藏}} AI 階段 x/y 則・可捲動」——**這行的動詞是「顯示」還是「隱藏」，兩張截圖肉眼判讀不一致，尚未確認，開工前務必核對原始檔**
5. **結案摘要自動填入**（tag「AI 草稿・可修改」）—— 可編輯文字區塊（AI 生成的結案摘要草稿）＋ 三個分類 pill（「意圖：…」／「處理結果：…」／「情緒結果：…」）＋「draft {{時間}}」時間戳 ＋「↻ 重新產生」／「▤ 一鍵寫入 CRM」兩個按鈕 ＋ 一行提醒文字：「「一鍵寫入 CRM」是本面板唯一會寫入資料庫的動作，寫入後不可自動回復。」

> ⚠️ 第 5 區塊的「一鍵寫入 CRM 不可回復」提醒，語氣上與 `ARCHITECTURE.md`／`CONSTITUTION.md` 裡對「寫入類操作需明確、不可靜默」的既有原則一致，**這點在 2a 是設計稿本身就強調的，不是本文件外推**。

> ✅ **與 `CONSTITUTION.md` §4.4 一致，非衝突**：該條規定 `confidence` 沒有真實依據時 MUST 為 `null`、
> UI 依 `null` 與否決定顯示或留空。第 2 區塊的示範卡片剛好就是這樣畫的——第一張卡（安撫開場與時效
> 承諾）有信心分數，緊接著的第二張卡（補寄工單建立流程）沒有，兩張卡在同一張截圖裡並列。**設計稿
> 沒有超前於技術限制，是本文件先前的判讀錯誤，2026-08-26 由使用者指出後更正**：實作時信心分數本來
> 就該依 `confidence` 是否為 `null` 決定顯示或留空，不需要另外隱藏或改動設計稿的呈現方式。

### 7.3 面板 Header（肉眼讀圖）

`COPILOT` 徽章（風格疑似沿用既有 `.ac-eyebrow`，未確認）＋ 依狀態變化的副標文字（展開態「即時輔助」／載入中「分析中」／準備結案「準備結案」）＋ 面板寬度數字 ＋ 右側一或兩個圖示按鈕（疑似摺疊／釘選面板，圖示語意未確認）。

### 7.4 三種特殊狀態

- **載入中（漸進顯示）**：header 副標「分析中」，下方有一行狀態列（如「AI 分析中・約 5 秒完成（最長 12 秒）・區塊會依序出現」）；各區塊尚未產出的內容以骨架屏（shimmer 灰色色塊）呈現，已完成的區塊（如第 1 區塊「客戶情緒提示」）標題列右側會出現完成勾選 icon；第 2 區塊在部分完成時 tag 顯示「產生中 x/y」而非最終的「N 則建議」。
- **準備結案（其餘區塊收合）**：header 副標「準備結案」，下方有一行提示列（如「⚑ 偵測到準備結案階段・已收合其餘區塊」）；除「結案摘要自動填入」外，其餘四個區塊全部收合成單行（標題 ＋ tag ＋ 展開箭頭），只有結案摘要維持展開可編輯。
- **展開態（一般狀態）**：五個區塊皆可各自獨立展開／收合，非上述兩種特殊狀態時的預設互動樣式。

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

> ⚠️ **這個擷取法對 `<dc-import>` 元件無效**（2026-08-26 擷取 2a／Copilot 面板時發現）。
> 若目標 artboard 是用 `<dc-import name="…" variant="…">` 匯入另一個元件組成的（2a 就是這樣，見 §7.0），
> 上面的擷取法只會拿到空的 `<dc-import>` 標籤本身，元件內部的 HTML/文案在畫布的編譯後 JS bundle
> 裡於執行期渲染，不在 `__bundler/template` 的字串裡，此路不通。遇到這種情況，唯一可靠的方法是
> 直接跟畫布擁有者要那個元件的原始檔（如 `CopilotPanel.dc.html`），而不是含 `dc-import` 的組合頁面。

### 何時該懷疑本文件已過期

上面是「怎麼擷取」，但沒寫「什麼時候該重新擷取」——這正是 `ARCHITECTURE.md`
附錄記錄的那類問題的同一種病灶：有步驟、但沒有觸發時機，容易變成「應該沒事吧」的僥倖心理。

**具體觸發點：**

1. **開始實作任一 artboard 前**（尤其 1c/1d，本文件目前只有文字規格到 1a/1b；2a 則只有肉眼讀圖的規格，
   可信度見 §7.0），先重新跑一次上面的擷取，用 `<section id="…">` 的內容跟本文件比對 —— 不比對就開工，
   等於相信一份可能已經過期（或本來就只是肉眼判讀）的規格。
2. **畫布擁有者提到「我調整了…」或「我又補了…」時**，視同已過期，不要等對方明確講
   「規格文件要更新了」才動作 —— 對方不一定知道有這份衍生文件存在。
3. **任何一次擷取比對出差異時**，本文件與 `docs/wireframe/` 截圖要一起更新，
   不能只改其中一個 —— 兩者都是同一個時間點的凍結快照，各自更新會製造新的不一致。

本文件目前的凍結時間點：1a/1b/1c/1d 為 **2026-08-25**；2a（Copilot 面板）為 **2026-08-26**（見檔首）。
距離這個日期越久，在動工前重新核對一次的必要性越高。
