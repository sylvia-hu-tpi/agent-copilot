# 設計規格：色票／字級／元件結構／文案

> ### 三層來源，優先序不可顛倒
>
> | 層 | 檔案 | 地位 |
> |---|---|---|
> | ① 唯一真實來源 | `docs/wireframe/AgentCopilot 客服介面設計.html` | Claude Design 畫布原始檔。**設計有變動時由畫布擁有者直接更新這個檔案。** |
> | ② 可查詢的衍生物 | **本文件** | ①的逐字擷取結果（擷取步驟見文末附錄）。實作時看這份 |
> | ③ 備存留查 | `docs/wireframe/*.png` | **只是截圖，不是規格。** 可能落後於①，**不必、也不用跟著更新** |
>
> ⚠️ **①不進版控**（`.gitignore` 已排除：單檔 6MB+、每次調整都整份重新匯出，diff 沒有意義）。
> 因此**換一台機器 clone 這個 repo 就只有②和③** —— 要重新擷取時得先向畫布擁有者取得①。
>
> ⚠️ **③只作視覺參考，任何數值都不要從截圖還原** —— 色票 hex、px、逐字文案一律以本文件為準。
> 若②與③看起來不一致，**以②為準**（③較可能是舊的）；若②與①不一致，**以①為準並就地訂正②**。
>
> **凍結時間點：2026-08-31 版畫布**。五個 artboard（1a／1b／1c／1d／2a）全部是逐字擷取的規格。
>
> ⚠️ **本文件不留變更沿革。** 畫布改版後就地訂正即可 —— ①本身就是真相來源，
> 已比對完、已修完的議題沒有保留價值。**只有這四類該留下**：現存畫布與實作的落差、未解決的議題、
> 待釐清的議題、已權衡過且會影響未來開發方向的決策。
>
> **對應頁面**：`app/pages/login.vue`（1a）、`app/pages/organization.vue`（1b）、
> `app/pages/c/[conversationId].vue`（1c／2a）。見 `ARCHITECTURE.md` §5.1。

## ⚠️ 重新核對時的三條紀律

1. **只做「這一版 vs 上一版」的 diff 不夠。** 版間 diff 只抓得到「這次改了什麼」；
   **兩版之間沒變、因而從沒被任何一次 diff 碰到的段落，才是本文件最容易長霉的地方**。
   已經發生過一次：§8.4 的 Composer 一般態從 08-29 起一直寫著「常用回覆／字數 N 字」，
   而畫布至少在 08-31 的前兩版就已改成上下兩列＋夾帶檔案按鈕，連續三輪 diff 都沒發現，
   最後是使用者直接看畫面問出來的。→ **每次更新後另挑幾段「沒被 diff 碰到」的規格回畫布抽驗。**
2. **什麼時候該重新擷取**：① 開始實作任一 artboard 前；② 畫布擁有者提到「我調整了…」時
   （視同已過期，不要等對方說「規格要更新了」—— 對方不一定知道有這份衍生文件）。
   ⚠️ 更新的對象**只有本文件**：`docs/wireframe/*.png` 是備存留查，落後了也沒關係，
   不要為了「保持一致」去重匯一批截圖。
3. **下一節「刻意偏離畫布之處」列的項目不是落差，不要「訂正」回畫布。**

## ⛔ 刻意偏離畫布之處 —— 不要改回去

> 這些是**已裁示的決定**，不是尚未同步的落差。核對時逐項確認它們**仍然**偏離，
> 而不是把它們改回畫布的樣子。給 Design 的說明見 `docs/DESIGN_FEEDBACK.md`。

| # | 項目 | 畫布 | 實作 | 為什麼 |
|---|---|---|---|---|
| 1 | **字級** | 見 §2 表列數字 | 全面加大約 **2.5px**，且改用 `rem` | 分兩輪、使用者確認過的刻意調整。核對字級時**只比對相對關係與 weight／letter-spacing**，絕對數值不比 |
| 2 | **情緒走勢圖寬度** | 128×34 靠右 | **整欄寬** | 要放最多 50 個評分點 ＋ 附件標記，128px 下每點只剩 2.5px |
| 3 | **頭像下拉裡的 email** | `text-overflow:ellipsis` 截斷 | **等寬字並允許換行，不截斷** | 那是要逐字核對「是不是我的帳號」的東西，而截斷正好蓋掉最能區分帳號的網域部分 |
| 4 | **服務模式說明** | 只描述模式本身 | 多一句「，包含在 iMBrace 官方介面工作的同事」 | 我們的鎖只在 AgentCopilot 內有效，這個邊界必須講清楚 |
| 5 | **拖曳把手的鍵盤操作** | 只畫滑鼠拖曳 | `role="separator"` ＋ 方向鍵／Home／End | 5px 的線對只用鍵盤的人等於不存在（憲法 8.2） |

> ✅ **先前的多數偏離已於 2026-08-31 消失** —— 畫布都改成與實作一致了，**不要再當成落差**：
> AI 泡泡的 `opacity`、語氣標籤、捲軸 8px、頂列只有頭像、兩條拖曳把手的 hover 色、
> 連線狀態文案、OTP 有效期與字元集、情緒量表的中文標籤與「生氣」獨立色、
> **情緒分數改 0–100**、**「推薦理由：」**、**「AI 即時回覆建議」／「知識庫快查」**、
> **presence 空狀態「沒有偵測到其他人」**、**快查每筆的兩行摘錄**。
>
> ⚠️ **`--danger` 系反過來要以畫布為準**：畫布新增了這三個 token，實作先前自訂的值已改為對齊（見 §1）。

> ⚠️ 另有兩處**畫布畫得到、但平台資料拿不到**因而實作缺席或改寫的（左欄最後一則訊息摘要、
> 各種「N 則」數字、客戶正在輸入…）。那些不是取捨而是沒有資料，清單見 `DESIGN_FEEDBACK.md` B 段。

下表的 artboard 編號是**畫布內的 section id**，`docs/wireframe/` 的檔名依它命名。
⚠️ 截圖欄只是備存留查的對照，規格看本文件對應章節。

| Artboard | 說明 | 規格 | 備存截圖 |
|---|---|---|---|
| 1a | 登入頁 | §4、§6 | `01-login_lightTheme.png` / `_darkTheme.png` |
| 1b | 選擇組織 | §5、§6 | `02-organization_lightTheme.png` / `_darkTheme.png` |
| 1c | 主工作區 | §8 | `03-workspace_lightTheme.png` / `_darkTheme.png`，**另有 10 個狀態變體，見下表** |
| 1d | 載入中／空狀態 | §9 | `04-workspace-empty_lightTheme.png` / `_darkTheme.png` |
| 3a | **語氣標籤色票**（`3a-light`／`3a-dark`） | §10 | 無截圖 |
| 2a | Copilot 面板（取代 1c／1d 右欄佔位） | §7 | `05-copilot-panel_4status_01.png`（四狀態總覽）、`05-copilot-panel_2status_02.png`（補齊第一張被裁掉的下半部） |

### 1c 的 10 個狀態變體

> 這些是**同一個 artboard 的不同狀態**，不是新的 artboard —— 在畫布原始碼裡是同一個
> `<section id="1c">` 用 8 個切換鈕參數化出來的。全部為淺色主題（深色僅 `_darkTheme` 一張）。
>
> ⚠️ **逐字文案與尺寸看 §8，不要從截圖判讀。** 下表記的是「哪張截圖對應哪個狀態、
> 實作時該注意什麼」—— 那是導覽資訊，是 §8 的逐字規格答不出來的部分。
>
> ⚠️ **這批截圖早於 2026-08-31 的數輪改版**，畫面上仍有「林佩君」等已被移除的元素
> （見檔頭第三層的說明：截圖是備存留查，不必跟著更新）。下表照截圖的實際內容描述，
> **不代表現行規格** —— 文案一律以 §8 為準。
>
> 規格出處：接手／離開／結案三個出口與 Copilot 面板可見性的行為定義在
> `specs/003-analysis-trigger-policy/spec.md`（FR-016～FR-023 與「Session 2026-08-28」兩節）；
> **結案流程本身屬 M3**，003 只交付出口的存在與文案。

| 截圖 | 狀態 | 實作時要看的重點 |
|---|---|---|
| `03-workspace_lightTheme.png` | 已接手（基準態） | 標題列「離開對話」（次要）＋「結案」（primary）＋輔助說明；服務模式分段控制項可切換；Copilot 面板展開 |
| `03-workspace_darkTheme.png` | 已接手 × 深色 | ⚠️ 與 lightTheme 的唯一差異：presence 列顯示「林佩君 ⟨正在結案⟩ 你仍可回覆或自行結案」（lightTheme 是「無人／未知」）。取深色色票時這是唯一要留意的多出來的元件 |
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
| `--bg`／`--surface*`／`--border*`／`--text*` | 無對應，需自訂 | 結構性色階，非語意色。直接以 CSS 變數進 `assets/css/main.css` 的 `:root`／`.dark`，元件內用 `var(--surface)`，不必勉強套 Nuxt UI 的中性階 |

字體：
- 內文：`'Noto Sans TC','Helvetica Neue',Helvetica,sans-serif`
- 代號／ID／驗證碼／倒數計時：`'IBM Plex Mono',monospace`

> ✅ 以上建議已採用，色票落於 `app/assets/css/main.css`。
>
> ⚠️ **深色模式的選擇器是 `.dark`，不是 `[data-theme="dark"]`。**
> `@nuxtjs/color-mode`（`@nuxt/ui` v4 內建）切換的是 `.dark` class，Nuxt UI 元件本身也依賴它；
> 兩套選擇器並存會讓自訂區塊與 Nuxt UI 元件在切換主題時**不同步**。下方 §1 已用 `.dark`。

---

## 1. 色票

```css
:root {
  --bg:#f3f4f6; --surface:#ffffff; --surface-2:#f8f9fb; --surface-3:#eef0f4;
  --border:#e2e5ea; --border-strong:#cfd4dc; --border-dash:#c7ccd6;
  --text:#1b2230; --text-2:#596274; --text-3:#8b93a3;
  --navy:#1b3a6b; --navy-2:#274d88; --navy-fg:#ffffff; --navy-soft:#eaeff7; --navy-soft-bd:#cbd8ea;
  --active:#17845c; --active-bg:#e7f5ef;
  --open:#8a5d05; --open-bg:#fbf2df; --open-bd:#e0c58c;
  --info:#20406f;
  --ai:#5348a8; --ai-bg:#f2f1fb; --ai-bd:#d9d6f0;
  --agent-bg:#e9eff8; --agent-bd:#c9d7ea;
  --warn:#a24a06; --warn-bg:#fdf1e3; --warn-bd:#eec69b;
  --danger:#a3202a; --danger-bg:#fbeaec; --danger-bd:#eebfc4;
  --skel:#e7e9ee; --skel-hi:#f2f3f7;
  --shadow:0 1px 2px rgba(16,24,40,.05);
}
.dark {
  --bg:#101319; --surface:#181c23; --surface-2:#1e232c; --surface-3:#252b35;
  --border:#2a303a; --border-strong:#3a4250; --border-dash:#414a58;
  --text:#e5e8ee; --text-2:#9fa8b8; --text-3:#6f7889;
  --navy:#2e5896; --navy-2:#3a6cb4; --navy-fg:#eef4fc; --navy-soft:#1c2635; --navy-soft-bd:#2c3d57;
  --active:#3cbb8c; --active-bg:#14251f;
  --open:#d8a340; --open-bg:#271f12; --open-bd:#4d3d1c;
  --info:#9dc0f2;
  --ai:#a79cf2; --ai-bg:#1d1e2e; --ai-bd:#343559;
  --agent-bg:#1b2433; --agent-bd:#2b384c;
  --warn:#e2a469; --warn-bg:#2a2015; --warn-bd:#553f22;
  --danger:#f0868f; --danger-bg:#2c1719; --danger-bd:#5c2b31;
  --skel:#232833; --skel-hi:#2c323d;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}
```

`--ai`／`--agent-bg`／`--agent-bd`／`--open`／`--open-bg` 是 1c（主工作區）用的發送者／對話狀態標籤色，1a/1b 不會用到。

⚠️ **`--info` 專供 `--navy-soft` 底上的文字**（建議卡的「說明」語氣標籤）。
**不要改用 `--navy-2`** —— 它同時是按鈕的 hover 底色，為了這裡調亮會讓按鈕上的白字失去對比。

⚠️ **`--open` 2026-09-01 由 `#a3700a` 調深為 `#8a5d05`**：舊值疊在 `--open-bg` 上只有 **3.87:1**，
過不了 WCAG AA 內文的 4.5:1（新值 5.17:1）。這一改同時修好所有拿 `--open` 當文字的地方 ——
摘要過期提示、知識庫過期註記、`open` 狀態標籤、建議卡的「挽留」語氣標籤。

⚠️ **`--danger` 系是情緒量表「生氣」與建議卡「升級」語氣專用**，2026-08-31 由畫布新增 —— 在那之前實作曾自訂過一組
（`#c0311d`／`#fbeae7`／`#f0bcb3`），現已對齊畫布，**不要改回自訂值**。它與 `--warn`（「挫折」）
必須看得出差別：需求明訂這兩級要可互相區分，同色只靠反白在小尺寸與深色主題下辨識度不足。

---

## 2. 字級

| 用途 | size | weight | 備註 |
|---|---|---|---|
| 標題（登入／輸入驗證碼） | 19px | 700 | |
| Eyebrow 徽章（AGENTCOPILOT／選擇組織／artboard 編號） | 11px | 700 | letter-spacing .06em；**實心藍底白字**（`background:var(--navy)`／`color:var(--navy-fg)`），⚠️ 不是純文字 |
| 說明文字（subtitle） | 12.5px | 400 | line-height 1.6 |
| 欄位 label | 12px | 500 | |
| 輸入框文字 | 13.5px | 400 | OTP 格另計，見下 |
| OTP 數字格 | 22px | 400 | `IBM Plex Mono` |
| 輔助／meta 文字 | 11–11.5px | 400 | 常搭 `IBM Plex Mono`（org id、版本號、時間） |
| 主按鈕文字 | 13.5px | 500 | |
| 組織名稱 | 14px | 500 | |
| 組織 meta（org_id · role） | 11.5px | 400 | `IBM Plex Mono` |
| 狀態標籤（1b 的載入中／無組織） | 10.5px | 700 | letter-spacing .08em，color `var(--text-3)`。⚠️ 見下方關於 1a 那三個標籤的警告 |
| 錯誤內文 | 12px | 400 | color `var(--warn)` |

> ⛔ **1a 的「送出中」「錯誤」「驗證碼錯誤」不是 UI 文案，不要實作。**
> 它們在畫布上位於卡片**外面**、一條 `border-top:1px dashed` 之下，是畫布作者用來標示
> 「以下是這個狀態的示範」的**註解**。照抄會讓登入頁憑空多出三個標籤。
> （1b 的「載入中」「無組織」不同：它們在卡片**內**，是真的 UI 文案，實作照做。）
>
> ⛔ **本表是畫布的凍結數字，不是實作值**（見檔頭「刻意偏離畫布之處」第 1 項）：實作刻意加大約 **2.5px** 並改用 `rem`
> （如 `12.5px` → `text-[0.90625rem]` ≈ 14.5px），`rem` 也讓瀏覽器／OS 的字級偏好能生效。
> 實作值見 `app/assets/css/main.css`（`.ac-title`／`.ac-eyebrow`／`.ac-subtitle`）與各元件的
> `text-[…rem]`。**核對時只比對相對關係與 weight／letter-spacing，不要照畫布數字改回去。**

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
   > 連同 §6 的 OTP 有效期，這是本文件**兩處**「畫布錯、實作對」的落差之一——
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
- 「你隸屬於 {{n}} 個組織。選擇要進入的組織，之後可從**左**上角切換。」
  > ⚠️ 方位是「**左**上角」—— 組織名在 1c 頂列的 `AGENTCOPILOT` 徽章之後（§8.3）。
  > 這句話承諾的「可以切換」已實作：`POST /api/auth/reselect-organization` 把 active session
  > 退回 `pending_org` 後導向既有的選組織頁。⚠️ 代價是 `loginToken` 與 `organizations`
  > 要留在 `ActiveSession` 裡整個 8 小時 session。
- 組織列範例資料（**示意假資料，非文案** —— 實際要接真實組織清單）：
  台灣客服中心／org_twn_cs·客服專員／14 個進行中；
  英國客服中心／org_uk_cs·客服專員／無進行中；
  品質稽核組／org_qa·唯讀稽核／唯讀
- footer「組織清單由後台權限決定，無法自行加入。」／按鈕「登出」
- 載入中標籤「載入中」
- 無組織標籤「無組織」／標題「此帳號尚未加入任何組織」／
  說明「請聯絡系統管理員將你加入客服組織後，再重新登入。」／按鈕「重新整理」

> ⚠️ 「接下來的加入對話與回覆都會以此身分留下紀錄。」**不是設計稿原文**，是討論過程中自行補充的
> 說法。要不要用由開發端決定，但不要當成畫布規格。

---

## 7. 2a — Copilot 面板（取代 1c／1d 的右欄佔位）

> 對應畫布 artboard「2a」。**取代 1c 與 1d 的右欄佔位區塊** —— §8／§9 的 1c／1d 規格**不含右欄**，右欄一律以本節為準（1d 那句「面板內容於下一階段設計。」是舊佔位文字，不要照抄）。

### 7.1 版面／寬度

- **展開寬度 420px**，可拖曳 **320–720px** —— 四種 variant（展開／載入中／準備結案／收合）共用，
  **結案態沒有獨立寬度**。
  ⚠️ **上限 720 遠大於預設 420，是刻意的**：面板在某些情境下會成為客服主要在看的畫面
  （逐條讀建議卡、展開知識庫全文），不是永遠的輔助欄。拉到 720 時中欄會被壓縮 ——
  中欄是 `min-width:0` 可壓縮，這是畫布允許的取捨，不是要擋掉的邊界。
- ⚠️ **收合態不另立寬度 token**：收合時整欄改渲染窄直條，寬度由元件自己決定，
  `copilotWidth` 只在展開態生效 —— 多一個 token 就多一個要跟畫布同步的數字。
- **六個區塊皆可獨立折疊**（第六塊「對話摘要」由畫布於 2026-08-31 新增）
- 支援淺色／深色主題
- 支援「載入骨架」與「準備結案收合」兩種特殊狀態

### 7.2 六個可折疊區塊

由上到下（`order` 決定，結案階段會把 ⑤ 提前）：

1. **客戶情緒提示**（tag「近 5 輪」）—— 情緒警示 pill（逐字「焦慮偏高」＋`alert-triangle`，`--warn` 字／`--warn-bg` 底／`--warn-bd` 框／`radius:20px`／`padding:5px 12px`）＋ 折線走勢圖（128×34，主線 `stroke-width:2.25` ＋ 0.3 透明度的疊影線 ＋ 端點 `r:2.6` 圓點）＋ 右下角 `score 72 ↑`（`IBM Plex Mono` 10px，**0–100 刻度**）＋ 走勢文字摘要 ＋ 情緒量表圖例（五段等寬，逐字為中文：「平靜」→`--active`／「普通」→`--text-2`／「擔憂」→`--open`／「挫折」→`--warn`／**「生氣」→`--danger` 系**；目前所在區間 `font-weight:700` ＋ `box-shadow:inset 0 -3px 0 <該段色>`）
   ✅ **走勢文字摘要包在 `sc-if trendNote` 裡** —— 畫布明訂它**可能不存在**，此時整段不顯示。
   我方的 `SentimentNarrative { trend, advice }` 在產生失敗或評分點少於 2 個時為 `null`，正是這個狀態。

2. **對話摘要**（tag「AI 產生 · 接手前必讀」）—— **第六個區塊，`order:2`，位置在情緒與建議之間。**
   - **ready**：一段摘要正文（`12.5px`／`line-height:1.75`／`--text`）＋ 分類 pill 列
     （`radius:20px`／`padding:3px 9px`／`11px`；一般類別用 `--navy-2` 字＋`--navy-soft` 底＋`--navy-soft-bd` 框＋`tag` icon，
     風險類別如「重複進線」改用 `--open` 字＋`--open-bg` 底＋`repeat` icon）
     ＋ 底列 `generated HH:MM:SS`（mono／`--text-3`）＋ 右側「重新產生」（`refresh-cw`，`26px` 高、`--border-strong` 框）
   - **loading**：四條 skeleton（首條帶 `shimmer` 動畫，寬度 100%／94%／62%）＋ 兩顆 `radius:20px` 的 pill skeleton
   - **error**：`--warn-bg` 底／`--warn-bd` 框／`radius:9px` 的告示框，內含 `alert-triangle`
     ＋ 標題「**摘要產生失敗**」＋ 說明「**其餘區塊不受影響，可直接閱讀完整對話紀錄。**」＋「重試」按鈕

3. **AI 即時回覆建議**（tag：ready 時「**本次回傳 3 則**」、載入中「**產生中 2 / 3**」）—— 一張或多張建議卡（`--ai-bg` 底／`--ai-bd` 框／`radius:10px`／`padding:10px 11px`／`gap:7px`），每張由上到下：
   - 標題列：`book-open` icon（`--ai`）＋ 知識庫來源標題（`12px`／`--text`／`500`）
     ＋ **語氣標籤** ＋ 彈性空白 ＋ **信心度 pill**
   - **語氣標籤**（`10.5px`／`500`／`radius:4px`／`padding:1px 6px`，各帶一個 icon）：
     「致歉」`heart-handshake`／`--warn` 系、「說明」`info`／`--navy-2`＋`--navy-soft`、
     「挽留」`hand-heart`／`--open` 系
   - **信心度 pill**：`10.5px`／`700`／`radius:20px`／`padding:2px 8px`／mono／`--surface` 底＋`--ai-bd` 框＋`--ai` 字，逐字「信心度 92%」。**不是每張卡都有**（截圖裡第二張沒有），與憲法 4.4「`confidence` 沒有真實依據時 MUST 為 `null`、UI 依 `null` 決定顯示或留空」一致
   - 建議回覆全文（`12.5px`／`line-height:1.75`，放在 `--surface` 底＋`--border` 框＋`radius:8px` 的框內）
   - 「**推薦理由：**…」（`11px`／`--text-3`）
   - 「需補：… — 帶入前請先填寫」（僅缺資料時，`--open` 系）
   - 底列靠右「↵ 一鍵帶入」（`28px` 高／`--navy` 底／`--navy-fg` 字／`radius:7px`／`corner-down-left` icon）
   - 卡片區可捲動（`max-height:392px`）

4. **知識庫快查** —— 搜尋輸入框（`height:34px`、`--surface-2` 底、`--border-strong` 框、內含放大鏡 icon；placeholder 逐字為「**用一句話問，例：發票補寄要多久**」）＋ 結果清單，每筆由上到下：
   - 標題（`12.5px`／`500`／單行 `ellipsis`）＋ 靠右的更新年月（`2026/05`，mono `10.5px`）
   - **摘錄**（`11.5px`／`--text-2`／`line-height:1.65`），**兩行截斷**
     （`display:-webkit-box`／`-webkit-line-clamp:2`／`-webkit-box-orient:vertical`／`overflow:hidden`）
   - **靠左**的「插入為回覆」（`25px` 高、`--border-strong` 框、`--surface-2` 底）／
     「展開全文」（無框＋`chevron-down`）兩顆按鈕

   過期文件多一條警示列（「⏱ 已超過 12 個月未更新，引用前請確認」，`--warn` 系）。
   ⚠️ **沒有 SOP 編號**，只有標題＋更新年月。

5. **AI 階段完整對話紀錄**（tag「AI 階段」）—— 逐則對話紀錄（客戶／AI／客服三種發送者），附件有**三種**型別，各自的說明文字逐字為：「PDF · 檔名僅供辨識，無法預覽」／「圖片 · 可預覽縮圖」／「舊型附件 · 僅有檔名，無法預覽」；區塊內可捲動，底部一行逐字為「**顯示 AI 階段 7 / 18 則，可捲動**」（動詞是「顯示」，分隔為全形逗號）

6. **結案摘要自動填入**（tag「AI 草稿 · 可修改」，⚠️ 分隔是 U+00B7 不是「・」）—— 可編輯文字區塊（AI 生成的結案摘要草稿）＋ 三個分類 pill（「意圖：…」／「處理結果：…」／「情緒結果：…」）＋「draft {{時間}}」時間戳 ＋「↻ 重新產生」／「▤ 一鍵寫入 CRM」兩個按鈕 ＋ 一行提醒文字：「「一鍵寫入 CRM」是本面板唯一會寫入資料庫的動作，寫入後不可自動回復。」
   ⚠️ `order` 由階段決定（結案階段會被提前），其餘五塊固定。⚠️ 摘要過期時多一列「對話有新內容，建議重新產生」。

> ⚠️ 第 6 區塊的「一鍵寫入 CRM 不可回復」提醒，語氣上與 `ARCHITECTURE.md`／`CONSTITUTION.md` 裡對「寫入類操作需明確、不可靜默」的既有原則一致，**這點在 2a 是設計稿本身就強調的，不是本文件外推**。

### 7.3 面板 Header

`height:42px`／`--surface` 底／`border-bottom:1px solid var(--border)`／`padding:0 13px`／`gap:9px`。
由左到右：

- `COPILOT` 徽章：`background:var(--navy)`／`color:var(--navy-fg)`／`font-size:10.5px`／`font-weight:700`／`letter-spacing:.06em`／`padding:3px 8px`／`border-radius:5px`。
  ⚠️ **10.5px，不是 §2 表列 eyebrow 的 11px** —— 面板徽章比登入頁的小 0.5px，是設計稿本身的差異。
- 副標 `headNote`（`11px`／`--text-2`）三態，逐字：載入中「**分析中**」／準備結案「**準備結案**」／其餘「**即時輔助**」
- 彈性空白
- **「全部重試」按鈕**（僅 `anyError` 時出現）：`24px` 高／`--warn-bd` 框／`--warn-bg` 底／`--warn` 字／`radius:6px`／`refresh-cw` icon／`title="重新產生所有失敗的區塊"`
- 面板目前寬度數字 `{{ width }}px`（`10.5px`／mono／`--text-3`）
- 收合鈕：`26×26`／`--border` 框／`--surface-2` 底／`radius:6px`／`panel-right-close` icon

### 7.4 三種特殊狀態

- **載入中（漸進顯示）**：header 副標「分析中」；最上方一條狀態列（`--surface-2` 底／`--border` 框／`radius:8px`／`padding:7px 10px`）內含旋轉的 `loader-2` ＋ 逐字「**AI 分析中 · 約 5 秒完成（最長 12 秒），區塊會逐一出現**」；各區塊依 ①已完成／②進行中／③④⑤尚未開始 三種樣態呈現 —— 已完成的標題列右側出現完成勾選 icon，進行中與尚未開始的以 skeleton（`--skel`／`--skel-hi` 的 `shimmer` 漸層）呈現。
- **準備結案（其餘區塊收合）**：header 副標「準備結案」，下方一行提示列（「⚑ 偵測到準備結案階段・已收合其餘區塊」）；除「結案摘要自動填入」外其餘區塊全部收合成單行（標題 ＋ tag ＋ 展開箭頭）。
- **展開態（一般狀態）**：六個區塊皆可各自獨立展開／收合。

> ⚠️ **折疊的無障礙屬性是逐字規格**：標題列是 `role="button"` ＋ `tabIndex` ＋ `aria-expanded`
> ＋ `outline-offset:-2px` ＋ `style-focus="background:var(--surface-2)"`，不是純 `<div>` 加 onClick。

---

## 8. 1c — 主工作區

> 10 個狀態變體**全部參數化在同一個 1c section 裡**，不是各自獨立的 artboard——
> 畫布上有 8 個切換鈕：「切換左欄收合」「切換撞單警示」「切換接手狀態」「切換面板收合」
> 「B1 摘要過期」「B2 同事視角」「B3 寫入中」「C1 離開失敗」。

### 8.1 版面

| 區域 | 尺寸 |
|---|---|
| Artboard 全寬 | 1440px |
| 左欄（對話清單）展開 | **預設 280px，可拖曳 220–400px** |
| 左欄收合 | **48px** 窄直條 |
| 右欄（Copilot 面板）展開 | **預設 420px，可拖曳 320–720px**（與 §7.1 同一個值） |
| 右欄收合 | **44px** 窄直條 |
| 中欄 | 剩餘空間（`min-width:0`，可壓縮） |

> ⚠️ **兩欄的拖曳範圍在畫布的 script 裡是逐字寫死的**，不是示意：
> `startDragLeft` → `Math.min(400, Math.max(220, …))`、`startDrag` → `Math.min(720, Math.max(320, …))`。
>
> ⚠️ 收合寬度左 **48px**／右 **44px** 不對稱，是因為左欄要放按鈕＋徽記、右欄要放直排 `COPILOT` 標籤。

**拖曳分隔線**（逐字，左右兩條共用）：
`width:5px` · `cursor:col-resize` · `background:var(--border)` ·
內含 `width:1px` / `height:26px` / `background:var(--border-strong)` 的握把短線 ·
`title="拖曳調整寬度"`。
⚠️ hover 色畫布自己不一致（左 `--border-strong`／右 `--navy-2`），實作統一取 `--navy-2`。

**捲軸**（逐字，全域一組，套用在所有捲動容器上）：

```css
*::-webkit-scrollbar        { width:8px; height:8px; }
*::-webkit-scrollbar-thumb  { background:var(--border-strong); border-radius:4px; }
*::-webkit-scrollbar-track  { background:transparent; }
```

> ⚠️ **不要再加 `scrollbar-width`／`scrollbar-color`。** Chromium 只要看到某個元素的
> `scrollbar-width` 是非初始值，就會**整組忽略該元素的 `::-webkit-scrollbar`** ——
> 兩套並存會讓那些元素退回瀏覽器預設寬度（約 11px），同一頁出現兩種捲軸。
> 畫布曾經兩套並存，2026-08-31 已移除標準屬性那組。
>
> ⚠️ 但 `::-webkit-scrollbar` 在 **Firefox 無效**。實作若要兩個瀏覽器都精確，
> 必須把標準屬性關進 `@supports not selector(::-webkit-scrollbar)` 讓兩組**互斥**，
> 而不是並列 —— 見 `app/assets/css/main.css`。
>
> ⚠️ 顏色 MUST 走 `var(--border-strong)`：深色主題是 `#3a4250`，寫死淺色值會在深色主題留一條淺灰捲軸。

wrapper 副標（逐字）：
「左欄可收合、可拖曳調寬 · **中欄資訊列可收合** · 中／右欄之間可拖曳**（320–720px）** · 訊息可分辨 客戶／AI／真人客服 · Composer 撞單攔截」

### 8.2 左欄 — 對話清單

- 品牌區：徽章「AGENTCOPILOT」／組織名／連線 pill「**已連線**」（`--active` 小圓點 ＋ `radius:20px`）
- 頂列右上角：**只有 28px 圓形頭像**（`--navy-soft` 底／`--navy-soft-bd` 框／`--navy-2` 字／
  mono 縮寫如「AG」／`aria-haspopup="menu"`），**沒有姓名文字、沒有 chevron**。
  下拉（`236px` 寬／`radius:9px`／`box-shadow:0 8px 24px rgba(16,24,40,.14)`）由上到下：
  eyebrow「**已登入身分**」＋ email（mono）→ 分隔線 → 「登出」（`role="menuitem"`）。
  ⛔ 畫布的 email 用 `text-overflow:ellipsis` 截斷，**實作刻意允許換行不截斷**（偏離第 3 項）
- 篩選 chip：「全部 24」／「active 14」／「open 10」
- 分組標題：「今天」／「昨天」（更早的用 `MM/DD`）。
  `position:sticky; top:0`／`--surface-2` 底／`border-bottom:1px solid var(--border)`
  （「昨天」以下每一組還多一條 `border-top`）／`padding:3px 6px 3px 12px`／
  `display:flex; align-items:center; gap:8px`／`z-index:1`
  - 標題文字：`10px`／`font-weight:700`／`letter-spacing:.08em`／`--text-3`
  - **右端收合鈕**（⚠️ **2026-08-31 新增**）：`20×20`／**無邊框**／**透明底**／`border-radius:5px`／
    `--text-3`，**hover 才浮出** `--surface-3` 底 ＋ `--text-2` 字；
    icon `chevron-up`（展開中，按了收合）／`chevron-down`（已收合，按了展開），13px。
    `title` 逐字「收合此日期區間」／「展開此日期區間」，
    `aria-label`「收合{日期}的對話」／「展開{日期}的對話」，並帶 `aria-expanded`。
    收合時**該組所有列項整批不顯示**。

  > ⚠️ 收合狀態的識別 MUST 用**日期本身**，不可用顯示文字 —— 「今天」那一組明天就叫「昨天」，
  > 用文字當 key 的話收合狀態會留在「今天」這個位置上，而不是跟著那批對話走。
  >
  > ⚠️ 實作**多顯示一個該組的對話數**（收合時才出現，見 `DESIGN_FEEDBACK.md` C-8）——
  > 收起來之後那批對話從畫面上消失，只剩一個箭頭的話這一列等於在說「這裡什麼都沒有」。
- 列項：頭像縮寫（GW／UK／QT／HN／ZK／MD）＋ 代號（`TWN#GW4772`）＋ 時間 ＋ 最後一則摘要
  - 摘要前綴逐字為「AI：」「客戶：」「我：」三種
  - 無訊息時為「（此對話尚無訊息）」
  - 未讀以數字徽記表示（例：`3`）
  - **「結案未完成」**標記出現在結案中途離開的對話上
- 底部：「載入更多對話…」／「顯示 7 / 24」／「依最新訊息排序」

### 8.3 中欄 — 標題列與訊息流

**對話資訊列可收合**（畫布的 `headerCollapsed` / `headerExpanded`）——
收合的是**標題列 ＋ 服務模式 ＋ Presence 三段整組**，不是只收其中一段：

| 狀態 | 內容 |
|---|---|
| 展開 | 標題列 ＋ 服務模式 ＋ Presence 列（如下各段）。收合鈕在**服務模式那一列的最右端** |
| 收合 | 單列 `height:38px`／`--surface` 底／`padding:0 10px 0 14px`／`gap:9px`：<br>代號 ＋ status pill ＋ 頻道 pill ＋ **模式 pill**（`sliders-horizontal` icon）＋ **presence 一句話**（`eye` icon）＋ 右側**當下唯一的主要動作**（未接手＝「接手對話」／已接手＝「結案」／結案中＝「結案中…」）＋ 展開鈕 |

收合／展開鈕（兩態共用同一組樣式）：`24×24` · `border:1px solid var(--border-strong)` ·
`background:var(--surface)` · `border-radius:6px` · `color:var(--text-2)` ·
icon `chevrons-up`（收合）／`chevrons-down`（展開）13px ·
`title`／`aria-label` 逐字為「收合對話資訊列」／「展開對話資訊列」。

⚠️ **收合鈕的位置在 2026-08-31 第三版改過**：由「服務模式按鈕那一列的最右端」
（flex 的最後一個項目）改為 **`position:absolute; right:14px; bottom:8px`** ——
即整個服務模式區塊 padding box 的**右下角**，與最後一行警語齊底，而不是與模式按鈕齊高。
展開態的收合鈕在此；收合態的展開鈕仍在那條 38px 單列的最右端。

> ⚠️ **收合態的模式 pill 不可省。** `mode` 決定 Composer 能不能送出、AI 會不會自己回話，
> 而且是對話層級的共用狀態（§10.6）—— 收起來會讓客服在不知道自己處於「全自動（唯讀）」
> 的情況下打完一整段才發現送不出去。
>
> ⚠️ **收合態只放主要動作。** 「離開對話」與接手的兩種模式選項留在展開態 ——
> 那些是有後果、要連同輔助說明一起讀的動作，不該塞進一條 38px 的窄列。

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
- 無人：「**沒有偵測到其他人**」
- 同事正在結案：頭像 ＋ email ＋ 標籤「正在結案」（`--navy-2` 字／`--navy-soft` 底／
  `--navy-soft-bd` 框／`radius:20px`／`clipboard-check` icon）＋「你仍可回覆或自行結案」
- 自己：「你正在檢視」
- 右側：「最後更新 14:32:11」

**訊息流**：頂端「載入較早的 305 則訊息」／日期分隔「08/25（今天）」
發送者三種：「客戶」／「AI 自動回覆」／「`agent.lin@company.com` · 真人客服 · 你」（自己的訊息才有「· 你」）

每一列是 `display:flex` 橫列（`gap:8px`／`padding:5px 16px`），內容欄 `max-width:62%`：
- **只有客戶那一側有頭像** —— `26×26` 圓、`--surface-3` 底 ＋ `--border` 框 ＋ `--text-2` 字、
  9px/700 等寬、`margin-top:14px`（對齊泡泡第一行）。同一位客戶的**續列**（純附件、輸入中）
  改放 `width:26px` 的空白佔位，讓泡泡的左緣對齊。
  AI／真人客服那一側整列 `justify-content:flex-end`，**沒有頭像**。
- 泡泡外框：客戶與真人客服都是**均勻的 1px 外框**；
  ⚠️ **`border-left:3px solid var(--ai)` 是 AI 專屬的標記**，客戶泡泡沒有這條色條。
- 泡泡圓角：**四角一律 `9px`**（三種發送者與 1d 骨架泡泡皆同，沒有尖角）。
  AI 泡泡另有 `opacity:.82`。
  ⚠️ **實作刻意不用 `opacity`，改用逐項混色。**
  `opacity` 會連文字一起壓，而畫布的文字色 `--text-2` 疊在 `--ai-bg` 上起點只有 5.48:1，
  `.82` 之後淺色掉到 **3.74:1**、連 `.90` 都只有 4.41，過不了 WCAG AA（內文需 ≥ 4.5）。
  逐項混色讓每一項各自設定：
  **底色／邊框／左側色條與畫布完全同色**（`.82` 的等效混色），
  **文字**因為畫布那個亮度本身就是破線的原因而無法同色，改以 `--text` 為基底混到 **65%**
  ——淺色 4.76:1，是**規則允許下最接近畫布的值**（63% 就掉到 4.49 破線）。
  最終只有**文字**與畫布不同：rgb(103,108,117) vs 畫布的 rgb(117,124,139)。
  ⚠️ 另一個不用 `opacity` 的理由：它會把泡泡**裡面**的附件卡與「下載」連結一起壓低對比。
  詳見 `DESIGN_FEEDBACK.md` F-1 與 `MessageBubble.vue` 的註解。

> ⚠️ **泡泡幾何不再區分發送者**（畫布曾以三個不同位置的直角區分，已全部撤銷為均勻 `9px`）。
> 這移掉了一個區分維度，剩下的必須夠用：客戶靠**左右對齊 ＋ 只有客戶側有頭像**；
> AI 與真人客服都靠右、只差底色，靠 AI 的 **3px `--ai` 左側色條**與泡泡上方的
> **文字徽章**（「AI 自動回覆」vs 姓名＋「真人客服 · 你」）分辨。
> 憲法 8.1「資訊不可只靠顏色」因此仍成立，但現在是**文字**在扛，幾何已經不幫忙了。
- AI 訊息附 meta：`14:28:07 · 意圖 invoice_status · 信心 0.82`
- 附件：檔名 ＋ 說明 ＋「下載」。
  ⚠️ **畫布自己不一致**：1c 那則 PDF 的說明是「僅有檔名 · 無縮圖，無法預覽」，
  但 2a 區塊④ 的同一件事分成三種型別各有措辭（§7.2）。實作採**三型別版**——
  它才分得出「PDF 有 url 可下載」與「舊型 file 連 url 都沒有」，1c 那句把兩者說成同一件事。
- 「客戶正在輸入…」（⚠️ 平台不提供客戶端輸入狀態，實作未做，見 M2 核對記錄）
- **撞單來源**的那一則訊息（畫布上是 AI 的訊息）標橘色的「14 秒前送出」，
  泡泡外加 `box-shadow:0 0 0 3px var(--warn-bg)`。
  ⚠️ **這個標籤掛在「害你被攔下的那一則」上，不是客服自己送的訊息**
  （畫布原始碼的 `<!-- ai after agent — 撞單來源 -->`）。兩者意思完全相反，容易判讀顛倒。

### 8.4 Composer 與撞單攔截

- 一般態：**上下兩列**的輸入區
  （`border:1px solid var(--border-strong)`／`--surface-2` 底／`radius:9px`／`overflow:hidden`）
  - 上：`textarea`，`min-height:64px`、`resize:none`、無框，
    placeholder 逐字「輸入回覆內容…（Enter 送出，Shift+Enter 換行）」
  - 下：工具列（`border-top:1px solid var(--border)`／`padding:7px 10px`）——
    **左側「夾帶檔案」按鈕**（`28×28`／`border:1px solid var(--border)`／`--surface` 底／
    `radius:6px`／`--text-2`／`paperclip` icon 14px／**無文字標籤**）→ 彈性空白 →
    右側「送出」（`send` icon 在文字**之後**）或撞單時的「已攔截」

> ⚠️ **這一列沒有「常用回覆」也沒有字數「N 字」** —— 兩者實作早已裁定不做，畫布後來也移除了，
> **兩邊一致，不是落差**。
>
> ⚠️ **夾帶檔案按鈕實作未做**，且**不是單純沒排到** —— 附件的**送出流程本身是未解問題**
> （`IMBRACE_QUESTIONS.md` H-6c：先 `_fileupload` 取 url 再帶入，還是別的流程？），
> 對應里程碑為 M3。**刻意不放 disabled 佔位鈕**：在拿到答案前那顆按鈕按下去沒有任何可走的路，
> 而「按了不會有任何變化的按鈕比沒有按鈕更像壞掉」。
> ⚠️ 補這顆按鈕時**要一起改版面**：畫布是上下兩列，實作目前是 `textarea` 與送出鍵左右並排。
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

收合為 **44px** 窄直條（08-28 版是 30px），保留直排標籤與展開鈕，狀態文字「已收合」。
⚠️ 收合鈕**只在已接手時存在**（003 FR-017）。

---

## 9. 1d — 載入中／空狀態

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

## 10. 3a — 語氣標籤色票

> 畫布 artboard `3a-light`／`3a-dark`（畫布最下方），**只有色票、沒有版面** ——
> 它存在的目的就是把建議卡的五種語氣一次定義清楚。

共用形狀：`font-size:10.5px`／`font-weight:500`／`border-radius:4px`／`padding:1px 6px`，
各帶一個 **10px** 的 lucide icon。

| 語氣 | fg | bg | bd | icon | 淺色對比 | 深色對比 |
|---|---|---|---|---|---|---|
| 致歉 | `--warn` | `--warn-bg` | `--warn-bd` | `heart-handshake` | 5.36:1 | 7.41:1 |
| 說明 | `--info` | `--navy-soft` | `--navy-soft-bd` | `info` | 8.98:1 | 8.17:1 |
| 挽留 | `--open` | `--open-bg` | `--open-bd` | `hand-heart` | 5.17:1 | 7.15:1 |
| 結案 | `--text-2` | `--surface-3` | `--border-strong` | `circle-check` | 5.38:1 | 5.94:1 |
| 升級 | `--danger` | `--danger-bg` | `--danger-bd` | `circle-arrow-up` | 6.46:1 | 6.84:1 |

> 對比欄是我方實算的（sRGB 相對亮度，文字 vs 該標籤自己的底色）。
> 標籤文字 10.5px 屬**內文**，門檻是 AA 的 4.5:1 —— 十組全部通過。

⚠️ **這五種是封閉集合**，模型每次產生建議卡都會落在其中之一（`shared/types/copilot.ts`
的 `SuggestionCard.tone`）。少一種配色，那張卡在畫面上就是實作自己編的。

⚠️ **「升級」是整份設計裡唯一使用紅色系的標籤。** 這是刻意的 —— 它與「致歉」的琥珀 `--warn`
分屬兩個色相（紅 vs 橙），兩者的處置強度差最遠，色相分開後在小尺寸與深色主題下才分得出來。
**不要為了「整齊」把它併回 `--warn` 系。**

⚠️ **「結案」刻意用中性灰**，不佔用任何有情緒的色系 —— 收尾是「無事發生」的訊號。

⚠️ 形狀是 `radius:4px` 的**小方角標籤**，不是 pill；圓角 pill（`radius:20px`）在畫布上
是信心度那一顆，兩者不要混用。

實作對應：`app/components/copilot/SuggestionCard.vue` 的 `TONE`。

---

## 附錄：如何重新擷取（畫布更新後）

> ⚠️ **前置條件**：下面的程式碼讀的是檔頭那張表的①，而**①不進版控** ——
> 全新 clone 的 repo 裡沒有這個檔案。動手前先確認它存在，不在就向畫布擁有者要一份最新匯出。

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
> （直接回 `null`）。用上面的 `indexOf` 切片。
>
> ⚠️ **`dc-import` 的元件內容就在 artifact 裡**（`CopilotPanel.dc.html`：9 KB base64／解開 43 KB），
> **不需要向畫布擁有者索取任何檔案** —— repo 裡也不存在這個檔案，不要去找。

> ⚠️ **「怎麼擷取」有了，但真正會出事的是「什麼時候該重新擷取」** —— 有步驟卻沒有觸發時機，
> 就會退化成「應該沒事吧」的僥倖。觸發點見檔頭「重新核對時的三條紀律」第 2 條。

凍結時間點見檔頭。**距離該日期越久，動工前重新核對一次的必要性越高。**
