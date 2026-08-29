# 設計規格：色票／字級／元件結構／文案

> 來源：Claude Design 畫布，**2026-08-29 由 2026-08-28 版 artifact 全面逐字擷取**。
> 本機副本：`docs/wireframe/AgentCopilot 客服介面設計.html`（擷取步驟見文末附錄）。
>
> ✅ **五個 artboard（1a／1b／1c／1d／2a）現在全部是逐字規格**，不再有任何「肉眼讀圖」的段落。
> 這解除了先前「1c 只有截圖、2a 只能判讀截圖」兩個長期限制。
>
> **2026-08-29 重新比對的結果**：
> - **1a／1b 完全沒變** —— 色票 30 個 token（淺／深各一組）、字級、卡片幾何（440px／560px／
>   `28px 28px 24px`／radius 12px）、逐字文案，全部與 2026-08-25 版一致。08-28 的改版沒有動到它們。
> - **1c／1d 首次取得逐字規格**，見 §8／§9。10 個狀態變體全部參數化在同一個 1c section 裡。
> - **2a 由肉眼讀圖升級為逐字**，訂正清單見 §7.5（其中「附件有第三型」與「徽章 10.5px」
>   兩項照舊版寫會做錯）。
>
> 畫布連結：https://claude.ai/code/artifact/f4090229-a1b1-40ee-a6e6-c32a25e7e5bf
> （會隨畫布後續編輯而變動 —— 本文件與 `docs/wireframe/` 截圖是凍結快照，實作以此為準；
> 畫布更新後的重新擷取流程見文末附錄）
>
> 視覺參考見 `docs/wireframe/`（每個畫面各有淺色／深色截圖）；本文件是可查詢、可 diff 的精確規格 ——
> 色票 hex 值、px、逐字文案**一律以本文件為準，不要從截圖肉眼還原**。
>
> 對應頁面：`app/pages/login.vue`（1a）、`app/pages/organization.vue`（1b）、
> `app/pages/c/[conversationId].vue`（1c／2a）。見 `ARCHITECTURE.md` §5.1。
>
> ⚠️ **2026-08-26 記下的三處「臨場判斷」現在可以定案了**：`app/layouts/console.vue` 的「｜」分隔線、
> 組織名稱可點擊切換＋chevron、`app/components/conversation/Sidebar.vue` 的頭像／頻道 icon ——
> 當時沒有 1c 逐字規格才憑既有 token 判斷，現在 §8 有了，動到這些元件時請一併核對。

| Artboard | 說明 | 截圖 |
|---|---|---|
| 1a | 登入頁 | `docs/wireframe/01-login_lightTheme.png` / `_darkTheme.png` |
| 1b | 選擇組織 | `docs/wireframe/02-organization_lightTheme.png` / `_darkTheme.png` |
| 1c | 主工作區 | `docs/wireframe/03-workspace_lightTheme.png` / `_darkTheme.png`，**另有 10 個狀態變體，見下表** |
| 1d | 主工作區 — 載入中／空狀態 | `docs/wireframe/04-workspace-empty_lightTheme.png` / `_darkTheme.png` |
| 2a | Copilot 面板（取代 1c 右欄佔位） | `docs/wireframe/05-copilot-panel_4status_01.png`（四狀態總覽：展開×淺色／展開×深色／載入中／準備結案收合）、`docs/wireframe/05-copilot-panel_2status_02.png`（展開×淺色／深色，補齊第一張截圖被裁掉的下半部） |

### 1c 的狀態變體（2026-08-28 新增）

> 這些是**同一個 artboard 的不同狀態**，不是新的 artboard——它們在畫布原始碼裡是同一個
> `<section id="1c">` 用 8 個切換鈕參數化出來的。全部為淺色主題（深色僅 `_darkTheme` 一張）。
>
> ✅ **2026-08-29 起，逐字文案與尺寸請看 §8，不要從截圖判讀。** 下表保留是因為它記的是
> 「每一張截圖對應哪個狀態、實作時該注意什麼」——那是 §8 的逐字規格答不出來的導覽資訊。
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
2. 標題「輸入驗證碼」+「已寄送至 {{maskedEmail}}，10 分鐘內有效。」（⚠️ **10 分鐘是畫布寫錯的，實際 15 分鐘**，見 §6 的註記）
3. **驗證碼是 6 格分離輸入，不是單一輸入框**（確定答案）：6 個獨立 `<input>`，各 `56×56px`，`text-align:center`，`font-size:22px`，`font-family:'IBM Plex Mono'`，`maxlength=1`，`border-radius:9px`；focus 時 `border-color:var(--navy-2)` + bg 轉 `var(--surface)`
   > ⚠️ **畫布的 `inputmode="numeric"` 與只收數字的 `replace(/[^0-9]/g,'')` 都是錯的，不要照抄。**
   > 平台的 OTP 是**數字 ＋ 大寫英文**（2026-08-29 由使用者確認）。`app/pages/login.vue` 目前的
   > `inputmode="text"` ＋ `[^0-9A-Z]` ＋ `autocapitalize="characters"` 才是對的。
   > 連同 §6 的 OTP 有效期，這是本文件**第二處**「畫布錯、實作對」的落差——
   > 1a 的互動細節在畫布上是示意，不是規格，核對時要留意。
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
  > ⚠️ **這裡的「10 分鐘」是畫布寫錯的，不要照抄，也不要在下次核對時把實作「訂正」回去。**
  > 平台 OTP 的實際有效期是 **15 分鐘**，明載於使用者收到的 OTP 信件（2026-08-29 由使用者確認）。
  > `app/pages/login.vue` 目前寫的 15 分鐘是對的。
  > 這是本文件**兩處**「畫布錯、實作對」的落差之一，另一處是 §4.2 的 OTP 字元集。
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

> 對應畫布 artboard「2a」。**取代 1c 與 1d 的右欄佔位區塊** —— §8／§9 的 1c／1d 規格**不含右欄**，右欄一律以本節為準（1d 那句「面板內容於下一階段設計。」是舊佔位文字，不要照抄）。

### 7.0 擷取方式與可信度說明

> ✅ **2026-08-29 全面改寫：本節先前所有「肉眼讀圖、僅供參考」的但書都已失效。**
> `CopilotPanel` 元件的原始檔**確實在畫布 artifact 裡**，只是不在 `__bundler/template`，
> 而是 **gzip + base64 內嵌在 `__bundler/manifest`**，靠 `__bundler/ext_resources` 的 uuid 對照
> （解法見附錄）。解出來是 43 KB 的完整元件原始檔，逐字文案與 CSS 全在裡面。
>
> ⚠️ 先前寫在這裡的「`dc-import` 此路不通，唯一可靠的方法是跟畫布擁有者要原始檔」**是錯的**，
> 而且造成實際損害：後續交接一度誤以為 repo 裡有一份 `CopilotPanel.dc.html`，實際從來沒有。
> 那個檔案不需要單獨索取——artifact 自己就帶著它。

以下 §7.1～§7.4 已依元件原始檔逐字核對（2026-08-29）。與 2026-08-26 肉眼讀圖版的差異列在 §7.5。

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

### 7.2 五個可折疊區塊（逐字核對，2026-08-29）

由上到下：

1. **客戶情緒提示**（tag「近 5 輪」）—— 情緒警示 pill（如「⚠ 焦慮偏高」，橘色，疑似沿用 `--warn`/`--warn-bg` 色票）＋ 折線走勢圖（score，如「0.72 ↑」）＋ 一段文字摘要（近幾輪情緒變化與建議）＋ 情緒量表圖例（`calm`／`neutral`／`concerned`／`frustrated`／`angry`，目前所在區間會被強調顯示）
2. **AI 語意即時建議**（tag「N 則建議」，載入中顯示「產生中 x/y」）—— 一張或多張建議卡：標題 ＋ 語氣標籤（如 `apologetic`／`informative`）＋ 建議回覆全文 ＋「rationale：」推薦理由 ＋「複製」／「↵ 一鍵帶入」兩個按鈕；卡片間可捲動（「可捲動查看其餘建議」）。**「信心 NN」分數不是每張卡都有**——截圖裡第一張卡（安撫開場與時效承諾）畫了「信心 92」，緊接著的第二張卡（補寄工單建立流程）沒有信心分數，設計稿本身就是條件式呈現，見下方說明。（2026-08-27 訂正：卡片標題前原本畫有 `SOP #編號` 徽章，經核對真實知識庫資料後確認 iMBrace 沒有這套編號制度，畫布擁有者已同步移除該徽章並更新截圖與 artifact，見 `specs/002-suggestion-knowledge-search/research.md` #2）
3. **知識庫自然語言快查** —— 搜尋輸入框（placeholder 為示範查詢句，如「發票補寄要多久」）＋ 結果清單，每筆：標題 ＋「插入為回覆」／「展開全文」按鈕；過期文件會多一條警示列（如「⏱ 已超過 12 個月未更新，引用前請確認」，疑似沿用 `--warn` 系色票）。（2026-08-27 訂正：本區塊原本仍畫有「SOP #12 · 2026/05」一類的編號＋日期格式，與第 2 區塊已移除編號的決定不一致；畫布擁有者已同步移除該編號並更新截圖與 artifact，見 `specs/002-suggestion-knowledge-search/research.md` #2）
4. **AI 階段完整對話紀錄**（tag「共 N 則訊息」，示範值「共 18 則訊息」）—— 逐則對話紀錄（客戶／AI／客服三種發送者），附件有**三種**型別，各自的說明文字逐字為：「PDF · 檔名僅供辨識，無法預覽」／「圖片 · 可預覽縮圖」／「舊型附件 · 僅有檔名，無法預覽」；區塊內可捲動，底部一行逐字為「**顯示 AI 階段 7 / 18 則，可捲動**」（2026-08-29 確認動詞是「顯示」，且分隔為全形逗號）
5. **結案摘要自動填入**（tag「AI 草稿・可修改」）—— 可編輯文字區塊（AI 生成的結案摘要草稿）＋ 三個分類 pill（「意圖：…」／「處理結果：…」／「情緒結果：…」）＋「draft {{時間}}」時間戳 ＋「↻ 重新產生」／「▤ 一鍵寫入 CRM」兩個按鈕 ＋ 一行提醒文字：「「一鍵寫入 CRM」是本面板唯一會寫入資料庫的動作，寫入後不可自動回復。」

> ⚠️ 第 5 區塊的「一鍵寫入 CRM 不可回復」提醒，語氣上與 `ARCHITECTURE.md`／`CONSTITUTION.md` 裡對「寫入類操作需明確、不可靜默」的既有原則一致，**這點在 2a 是設計稿本身就強調的，不是本文件外推**。

> ✅ **與 `CONSTITUTION.md` §4.4 一致，非衝突**：該條規定 `confidence` 沒有真實依據時 MUST 為 `null`、
> UI 依 `null` 與否決定顯示或留空。第 2 區塊的示範卡片剛好就是這樣畫的——第一張卡（安撫開場與時效
> 承諾）有信心分數，緊接著的第二張卡（補寄工單建立流程）沒有，兩張卡在同一張截圖裡並列。**設計稿
> 沒有超前於技術限制，是本文件先前的判讀錯誤，2026-08-26 由使用者指出後更正**：實作時信心分數本來
> 就該依 `confidence` 是否為 `null` 決定顯示或留空，不需要另外隱藏或改動設計稿的呈現方式。

### 7.3 面板 Header（逐字核對，2026-08-29）

`COPILOT` 徽章 ＋ 依狀態變化的副標文字 ＋ 面板寬度數字 ＋ 右側圖示按鈕。

徽章樣式逐字：`background:var(--navy)`／`color:var(--navy-fg)`／`font-size:10.5px`／`font-weight:700`／`letter-spacing:.06em`／`padding:3px 8px`／`border-radius:5px`。
⚠️ **10.5px，不是 §2 表列 eyebrow 的 11px** —— 面板徽章比登入頁的小 0.5px，是設計稿本身的差異。

副標（原始檔 `headNote` 三元式，逐字）：展開態「即時輔助」／載入中「分析中」／準備結案「準備結案」。

### 7.4 三種特殊狀態

- **載入中（漸進顯示）**：header 副標「分析中」，下方有一行狀態列（如「AI 分析中・約 5 秒完成（最長 12 秒）・區塊會依序出現」）；各區塊尚未產出的內容以骨架屏（shimmer 灰色色塊）呈現，已完成的區塊（如第 1 區塊「客戶情緒提示」）標題列右側會出現完成勾選 icon；第 2 區塊在部分完成時 tag 顯示「產生中 x/y」而非最終的「N 則建議」。
- **準備結案（其餘區塊收合）**：header 副標「準備結案」，下方有一行提示列（如「⚑ 偵測到準備結案階段・已收合其餘區塊」）；除「結案摘要自動填入」外，其餘四個區塊全部收合成單行（標題 ＋ tag ＋ 展開箭頭），只有結案摘要維持展開可編輯。
- **展開態（一般狀態）**：五個區塊皆可各自獨立展開／收合，非上述兩種特殊狀態時的預設互動樣式。

---


### 7.5 2026-08-29 逐字核對後的訂正

| 項目 | 肉眼讀圖版（2026-08-26） | 逐字原始檔 |
|---|---|---|
| 第 4 區塊底部那行的動詞 | 「{{顯示｜隱藏}} AI 階段 x/y 則」**未確認** | **「顯示 AI 階段 7 / 18 則，可捲動」** —— 動詞是「顯示」，且分隔是全形逗號不是「・」 |
| 附件型別 | 只列 PDF、圖片兩種 | **三種**：「PDF · 檔名僅供辨識，無法預覽」／「圖片 · 可預覽縮圖」／**「舊型附件 · 僅有檔名，無法預覽」** |
| 分隔符號 | 記為「・」（片假名中點 U+30FB） | 實際是 **「 · 」（U+00B7，前後各一空格）** |
| `COPILOT` 徽章 | 「疑似沿用 `.ac-eyebrow`，未確認」 | 確認：`background:var(--navy)`／`color:var(--navy-fg)`／**`font-size:10.5px`**／`font-weight:700`／`letter-spacing:.06em`／`padding:3px 8px`／`border-radius:5px`。⚠️ **10.5px，不是 §2 表列的 11px** |
| 情緒量表圖例 | 「目前所在區間會被強調顯示」（推測） | 確認：`calm` 用 `--active`／`--active-bg`；所在區間（`frustrated`）用 `--warn-bg` ＋ **`box-shadow:inset 0 -3px 0 var(--warn)`** 的底線強調 |
| 「信心 NN」 pill | 疑似 | 確認：`border-radius:20px`／`padding:2px 8px`／`IBM Plex Mono` |
| 語氣標籤（`apologetic`） | 疑似 | 確認：`border-radius:4px`／`padding:1px 6px`／`IBM Plex Mono` |
| 快查 placeholder | 猜「發票補寄要多久」 | ✅ 正確，原始檔 `kbQuery: "發票補寄要多久"` |
| header 副標 | 展開「即時輔助」／載入「分析中」／結案「準備結案」 | ✅ 全部正確（原始檔 `headNote` 三元式） |
| 過期文件警示 | 猜「⏱ 已超過 12 個月未更新，引用前請確認」 | ✅ 文字正確（icon 另計） |
| 知識庫結果三筆標題 | 未記錄 | 「電子發票補寄作業與時效」／「收件資料變更申請流程」／「紙本發票換開規則（舊版）」 |
| 第 4 區塊 tag | 「共 N 則訊息」 | ✅ 正確，示範值「共 18 則訊息」 |

> ⚠️ **§7.2 的區塊順序、五個區塊的名稱、SOP 編號已移除這三件事，逐字核對後全部確認正確**——
> 先前的肉眼判讀準確度比預期高，但上表那幾項（尤其附件第三型與徽章字級）照舊版寫會做錯。
---

## 8. 1c — 主工作區（逐字擷取，2026-08-28 畫布）

> ⚠️ 本節與 §9 是 **2026-08-29 首次逐字擷取**的結果，取代先前「只有截圖、須肉眼判讀」的狀態。
> 擷取法見附錄（`__bundler/template` → `<section id="1c">`）。
> 10 個狀態變體**全部參數化在同一個 1c section 裡**，不是各自獨立的 artboard——
> 畫布上有 8 個切換鈕：「切換左欄收合」「切換撞單警示」「切換接手狀態」「切換面板收合」
> 「B1 摘要過期」「B2 同事視角」「B3 寫入中」「C1 離開失敗」。

### 8.1 版面

| 區域 | 尺寸 |
|---|---|
| Artboard 全寬 | 1440px |
| 左欄（對話清單）展開 | **280px** |
| 左欄收合 | **30px** 窄直條 |
| 右欄（Copilot 面板）展開 | **420px**，可拖曳 320–520px（與 §7.1 同一個值） |
| 右欄收合 | 30px 窄直條 |
| 中欄 | 剩餘空間（`min-width:0`，可壓縮） |

wrapper 副標（逐字）：「左欄可收合 · 中／右欄之間可拖曳 · 訊息可分辨 客戶／AI／真人客服 · Composer 撞單攔截」

### 8.2 左欄 — 對話清單

- 品牌區：徽章「AGENTCOPILOT」／「台灣客服中心」／「已連線 · 即時同步」／頭像「林」＋「林佩君」
- 篩選 chip：「全部 24」／「active 14」／「open 10」
- 分組標題：「今天」／「昨天」
- 列項：頭像縮寫（GW／UK／QT／HN／ZK／MD）＋ 代號（`TWN#GW4772`）＋ 時間 ＋ 最後一則摘要
  - 摘要前綴逐字為「AI：」「客戶：」「我：」三種
  - 無訊息時為「（此對話尚無訊息）」
  - 未讀以數字徽記表示（例：`3`）
  - **「結案未完成」**標記出現在結案中途離開的對話上
- 底部：「載入更多對話…」／「顯示 7 / 24」／「依最新訊息排序」

### 8.3 中欄 — 標題列與訊息流

**標題列**：`conv_8f21c0 · 建立於 08/25 13:58 · 訊息 312 則`

| 狀態 | 標題列內容 |
|---|---|
| 未接手 | 「接手對話」＋下拉，兩個選項寫**後果**不寫模式名：「接手並停用 AI 自動回覆／之後由我回覆，AI 不再自動發話」「接手但保留 AI 自動回覆／AI 繼續自動回覆，我可隨時插話」 |
| 已接手 | 「離開對話」（次要）＋「結案」（primary）＋輔助說明「離開＝僅退出不寫入 · 結案＝產生摘要供確認後寫入」 |
| 結案中 | 「取消結案」＋「結案中…」＋輔助說明「取消結案＝回到已接手狀態，不會留下任何紀錄」 |

**服務模式**分段控制項：「全真人」／「協作」／「全自動（唯讀）」
＋ 說明「模式是這個對話的共用設定，切換會影響所有人。」
結案中轉唯讀，提示「結案中無法切換服務模式，請先取消結案」

**Presence 列**「在此對話中」：
- 無人：「無人／未知」＋「presence 資料未提供」
- 同事正在結案：頭像「林」＋「林佩君」＋標籤「正在結案」＋「你仍可回覆或自行結案」
- 自己：「你正在檢視」
- 右側：「最後更新 14:32:11」

**訊息流**：頂端「載入較早的 305 則訊息」／日期分隔「08/25（今天）」
發送者三種：「客戶」／「AI 自動回覆」／「林佩君 · 真人客服 · 你」
- AI 訊息附 meta：`14:28:07 · 意圖 invoice_status · 信心 0.82`
- 附件：檔名 ＋「僅有檔名 · 無縮圖，無法預覽」＋「下載」
- 「客戶正在輸入…」
- 自己剛送出的訊息標「14 秒前送出」

### 8.4 Composer 與撞單攔截

- 一般態：「常用回覆」／字數「{{ draftLen }} 字」／「送出」
- 未接手：「尚未接手此對話，無法輸入回覆。請先點右上角『接手對話』。」（唯讀）
- 結案中：橫幅「結案中 —— 摘要內容為按下結案當下的對話快照，不含此後的新訊息。要送出訊息請先取消結案。」
  ⚠️ **Composer 不鎖**，只是提示
- 撞單攔截（憲法 3.3① 封閉集合之一）：
  - 標題「撞單攔截：客戶已在你打字期間收到回覆」
  - 內文「AI 自動回覆 已於 14:32:07（14 秒前）送出「收件地址…」。你的草稿尚未送出，直接送出可能造成重複或矛盾訊息。」
  - 三個處置：「先看最新訊息」／「我已確認，仍要送出」／「捨棄草稿」
  - 狀態列「草稿已保留 · 送出鍵已鎖定」，送出鍵轉為「已攔截」

### 8.5 摘要已寫入但 LEAVE 失敗（C1）

頂端橫幅：「結案摘要已寫入，但離開對話失敗」
＋「摘要已存入 CRM（…），但系統未能將你自對話中移除，因此畫面仍停留在已接手狀態。」
＋按鈕「重試離開」

### 8.6 右欄收合態

收合為 30px 窄直條，保留直排標籤與展開鈕，狀態文字「已收合」。
⚠️ 收合鈕**只在已接手時存在**（003 FR-017）。

---

## 9. 1d — 主工作區的載入中／空狀態（逐字擷取）

wrapper 副標：「初次載入骨架 · 未選擇對話 · 對話清單為空 · 訊息流為空」

| 狀態 | 逐字文案 |
|---|---|
| 訊息流載入中 | 「正在載入 312 則訊息…」／Composer「連線建立後才可輸入」 |
| 左欄品牌區 | 「台灣客服中心」／「已連線」（⚠️ 比 1c 少了「· 即時同步」） |
| 對話清單為空 | 「找不到符合的對話」／「客戶僅有代號，請輸入完整代號片段（例：GW4772）或清除篩選。」／按鈕「清除搜尋與篩選」 |
| 未選擇對話 | 「尚未選擇對話」／「從左側列表選擇一個對話開始處理。標記 ●&nbsp;active 的對話代表客戶正在等待回覆，建議優先處理。」／按鈕「處理最舊的 active 對話」「只看未回覆」 |
| 右欄佔位 | 「選擇對話後提供輔助內容」／「面板內容於下一階段設計。」 |

⚠️ 最後一列是 **1d 自己的右欄佔位文字**，已由 §7 的 2a 取代——實作不應照抄這兩句。
骨架列數 `skelRows: [1,2,3,4,5,6]`（6 列）。

---

## 附錄：如何重新擷取（設計稿更新後）

Claude Design 畫布以 bundler 包裝，`Artifact action:"read"` 拿到的是 loader script，不是可直接解析的 HTML。實際內容分成**兩個**區塊，兩個都要解：

```js
const raw = fs.readFileSync('docs/wireframe/AgentCopilot 客服介面設計.html', 'utf8')

// ── ① 頁面本身：<script type="__bundler/template"> 是一個 JSON 字串 ──
const html = JSON.parse(raw.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/)[1])
// html 裡找 <section id="1a"|"1b"|"1c"|"1d"|"2a"> 或 data-screen-label 即可定位

// ── ② 被 <dc-import> 匯入的元件：gzip + base64 壓在 manifest 裡 ──
//    ext_resources 給 id → uuid 的對照，manifest 以 uuid 為鍵存實際內容
const pick = (type) => {
  const s = raw.indexOf(`<script type="__bundler/${type}">`)
  const b = raw.indexOf('>', s) + 1
  return raw.slice(b, raw.indexOf('</script>', b))
}
const manifest = JSON.parse(pick('manifest'))
const ext = JSON.parse(pick('ext_resources'))
for (const r of ext.filter(r => r.id.endsWith('.dc.html'))) {
  const e = manifest[r.uuid]                      // { mime, compressed, data }
  const buf = Buffer.from(e.data, 'base64')
  const src = e.compressed ? zlib.gunzipSync(buf) : buf   // ← 元件的逐字原始檔
}
```

> ⚠️ **`match()` 對 manifest 不可靠**：它是 6 MB 的單行 JSON，用非貪婪正則會慢到像當掉
> （2026-08-29 踩過，直接回 `null`）。用上面的 `indexOf` 切片。
>
> ✅ **2026-08-29 更正一條錯誤結論**：先前這裡寫著「`dc-import` 的元件內容在執行期才渲染、
> 不在 artifact 裡，唯一可靠的方法是跟畫布擁有者要原始檔」——**那是錯的**，內容一直都在
> manifest 裡（`CopilotPanel.dc.html` 是 9 KB base64／解開 43 KB）。這條錯誤結論的代價是：
> 2a 的規格白白以肉眼讀圖的形式停留了三天，而且後續交接誤以為 repo 裡有一份不存在的
> `CopilotPanel.dc.html`。**不需要向任何人索取檔案。**

### 何時該懷疑本文件已過期

上面是「怎麼擷取」，但沒寫「什麼時候該重新擷取」——這正是 `ARCHITECTURE.md`
附錄記錄的那類問題的同一種病灶：有步驟、但沒有觸發時機，容易變成「應該沒事吧」的僥倖心理。

**具體觸發點：**

1. **開始實作任一 artboard 前**，先重新跑一次上面的擷取，用 `<section id="…">` 的內容跟本文件比對
   —— 不比對就開工，等於相信一份可能已經過期的規格。五個 artboard 現在都是逐字的，
   所以差異一定看得出來，沒有「可能只是我判讀錯」這個藉口了。
2. **畫布擁有者提到「我調整了…」或「我又補了…」時**，視同已過期，不要等對方明確講
   「規格文件要更新了」才動作 —— 對方不一定知道有這份衍生文件存在。
3. **任何一次擷取比對出差異時**，本文件與 `docs/wireframe/` 截圖要一起更新，
   不能只改其中一個 —— 兩者都是同一個時間點的凍結快照，各自更新會製造新的不一致。

本文件目前的凍結時間點：**五個 artboard 一律為 2026-08-29 擷取的 2026-08-28 版畫布**
（先前 1a/1b/1c/1d 為 08-25、2a 為 08-26 的分歧已消除）。
距離這個日期越久，在動工前重新核對一次的必要性越高。
