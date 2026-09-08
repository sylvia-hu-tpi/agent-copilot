# 設計規格：色票／字級／元件結構／文案

> ### 兩層來源，優先序不可顛倒
>
> | 層 | 檔案 | 地位 |
> |---|---|---|
> | ① 唯一真實來源 | `docs/wireframe/AgentCopilot 客服介面設計.html` | Claude Design 畫布原始檔。**設計有變動時由畫布擁有者直接更新這個檔案。** |
> | ② 可查詢的衍生物 | **本文件** | ①的逐字擷取結果（擷取步驟見文末附錄）。實作時看這份 |
>
> ⚠️ **①不進版控**（`.gitignore` 已排除：單檔 6MB+、每次調整都整份重新匯出，diff 沒有意義）。
> 因此**換一台機器 clone 這個 repo 就只有②** —— 要重新擷取時得先向畫布擁有者取得①。
> 若②與①不一致，**以①為準並就地訂正②**。
>
> ⚠️ **2026-09-03：`docs/wireframe/*.png` 的備存截圖已全數刪除。**
> 它們曾是第三層「備存留查」，但每次畫布改版都會落後，而落後的截圖被當成規格引用過不只一次
> —— 刪掉比維護它們便宜。**任何「視覺見某張圖」的引用一律改為指向 artboard 編號與狀態名稱**，
> 需要看畫面時開①。
>
> **凍結時間點：2026-09-08 17:03 版畫布**。七個 artboard（1a／1b／1c／1d／2a／**2b**／3a）全部是逐字擷取的規格。
> ⚠️ 但**不是每一節都在同一天重擷** —— 下面幾段記的就是「哪一節擷取到哪一版」，
> 那才是判斷某段敘述可不可信的依據。
>
> ⚠️ **2026-09-04 這次只重新擷取了兩處**：§7.5（涵蓋範圍選擇器，整節重寫）與
> §8 的 1c「結案中」狀態變體。觸發點是 `specs/006` 的手動驗收發現實作與畫布不一致，
> 因此比對集中在結案路徑。
>
> ⚠️ **2026-09-07 補了一輪「沒被 diff 碰到」的抽驗**（正是上一段說的長霉處），
> 對象是 `DESIGN_FEEDBACK.md` 的每一條回饋 ＋ 其對應章節：⛔ 表全項、§1 的 token 值、
> §7.2 區塊①②⑥、§7.5、以及 2b 的決策卡。結果：**⛔ 表有五條早就被畫布採納**
> （見表下說明）、§7.2 ⑥ 的置頂列與過期提示位置**兩處敘述是錯的**（已就地訂正），
> 另發現畫布的第 6 區塊**缺人審欄位的規格**（舊 `DESIGN_FEEDBACK.md` A-2，已於當天結清）。
>
> ⚠️ **2026-09-08 重新擷取了第 6 區塊（§7.2 ⑥），當天兩輪**：
> 上午 Design 補上整組人審欄位、`zeroTop` 的提示、情緒分析中的提示（新增 2b 的 C3 畫板），
> 並把 B4 的 `sumOpacity` 移除；下午再補「相關的知識庫來源」chip 列、四欄的空值態、
> 「採取的行動」改為多選 listbox、「後續待辦」的已填列，另新增 **D1／D2／E1／E2** 四張畫板。
> §7.2 ⑥ 的欄位表、樣式值與 §7.5 已依最新版就地訂正。
> ⚠️ **第 6 區塊自此以畫布為準，`DESIGN_FEEDBACK.md` 已無該區塊的待辦。**
>
> ⚠️ **2026-09-08 17:03 版：畫布在 1c 頂列新增了「淺／深色主題切換鈕」**（`toggleTheme`）。
> 這是**第一顆讓使用者自己換主題的入口** —— 在此之前深色只是畫布上並排的另一種塗色，
> 產品裡沒有任何地方切得過去。規格見 §8.1「頂列」。
> ✅ **實作已於同日補上**（`app/layouts/console.vue` ＋ `nuxt.config.ts` 的 `colorMode`）。
> 畫布沒回答的兩題由使用者裁示：**記住上次的選擇**、**首次進入固定 light**（不跟隨系統）。
> ⚠️ **同日 17:03 版另改了一行**：頂列分隔線兩側的間距定為各 10px，
> 做法是頭像那一組加 `margin-left:-2px`（見 §8.1「頂列」）—— 這是 Design 收到
> 我方「實作 10／10、畫布 12／6」的回報後，把畫布改成與實作一致。
> `template.html` 與 16:08 版只差那一行，`CopilotPanel.dc.html` 逐位元組相同。
>
> 同一輪另核對了 §1 的 35 個 token（**兩個主題逐值相符**）、⛔ 表十二條（**全部仍是偏離**）、
> 以及 §8.2／§8.4／§9 的抽驗，順手訂正了兩處已過期的敘述（分組標題字級、「· 即時同步」）。
> **其餘章節（§2～§7、§10）仍是先前的擷取結果**，動工前照第二條紀律重新核對。
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
   ⚠️ 更新的對象**只有本文件** ——
   不要為了「保持一致」去重匯一批截圖。
3. **下一節「刻意偏離畫布之處」列的項目不是落差，不要「訂正」回畫布。**
4. ⚠️ **不要用明文 `grep` 判斷畫布有沒有某段文字 —— 0 命中不等於不存在。**
   畫布被 `<dc-import>` 匯入的元件是 **gzip + base64 壓在 manifest 裡**（見文末附錄），
   2a／2b 的內容幾乎全在那裡面。直接 grep 原始檔會對 `freshIdle`、`一鍵寫入 CRM`、
   `AI 分析中` 這類字串全部回 0，而那會導出「這份文件是編的」這種完全相反的結論。
   **要查證先照附錄解壓，再對解出來的全文搜尋。**
   ⚠️ 同理，**本文件的轉述不等於畫布逐字**：2026-09-03 一輪核對中，
   「取消結案的位置」「Composer 不鎖」「約 5 秒完成的適用範圍」「重新產生（鎖住）」
   四處都與畫布有出入。要送 Design 或寫進規格的敘述，一律回①查。

## ⛔ 刻意偏離畫布之處 —— 不要改回去

> 這些是**已裁示的決定**，不是尚未同步的落差。核對時逐項確認它們**仍然**偏離，
> 而不是把它們改回畫布的樣子。給 Design 的說明見 `docs/DESIGN_FEEDBACK.md`。
>
> ⚠️ **編號就是 `DESIGN_FEEDBACK.md` 的 C 編號**（2026-09-07 統一）——
> 在那之前兩份文件各編各的，27 之後整組錯開一位（本檔的 28 是那邊的 C-27），
> 而兩邊的表格長得幾乎一樣，對照時不會有任何東西提醒你看的是不同的條目。
> **新增偏離時先去 `DESIGN_FEEDBACK.md` 取號**，那份會被轉出去，號碼一旦寄出就不能動。

| C 編號 | 項目 | 畫布 | 實作 | 為什麼 |
|---|---|---|---|---|
| C-19 | **情緒示警 pill 的文案**（§7.2 區塊①） | 逐字「焦慮偏高」 | 「客戶情緒：挫折」／「客戶情緒：生氣」 | 我方是**五級分類**，畫布只示範其中一種情況的措辭。001 FR-003 要求「挫折」與「生氣」在文字上就能互相區分 |
| C-22 | **走勢摘要的強調**（§7.2 區塊①） | 整段同色、無強調 | 後半的「建議…」加粗 | 客服要用的是那一句；走勢那半在折線圖上已經看得到 |
| C-25 | **走勢圖的筆畫縮放**（§7.2 區塊①） | `stroke-width:2`（畫板固定 420px） | 加 `vector-effect="non-scaling-stroke"` | 畫布畫板寬度固定，我方面板**可拖曳 320–720px**；等比 viewBox 之下筆畫會跟著放大，720px 時那條 2 的線會變約 4px |
| C-35 | **摘要「詳細內容」四段的內文**（§7.2 區塊②） | 整段文字 | **項目符號 `<ul>`** | `keyFacts`／`attempted`／`openIssues` 是**字串陣列**，攤平成一段會失去「這是幾件獨立的事」 |
| C-27 | **左欄列項的頭像配色**（§8.2） | 一律 `--surface-3` 單一灰 | **六色輪替**（依代號雜湊） | 讓客服在長清單裡用顏色快速定位同一個對話。⚠️ **但訊息泡泡裡的客戶頭像維持單一灰**：色盤有一組是 `--ai-bg`／`--ai`，而訊息流裡 `--ai` 是語意色（「這則是 AI 發的」）。畫布自己的示範代號 `TWN#GW4772` 雜湊後正好落在那一組 |
| C-28 | **左欄「載入更多對話」**（§8.2） | spinner 自動載入列 | **可按的按鈕** | 自動載入會在往下捲時持續打 API 且無法中止 |
| C-29 | **左欄搜尋列**（§8.2） | 只有搜尋框 ＋ 收合鈕 | 多一顆重新整理鈕 | 輪詢有間隔，客服偶爾需要立刻確認清單是最新的 |
| C-30 | **未接手時的輸入區**（§8.4） | 虛線提示框取代整個輸入區 | **只有「尚未接手」照畫布** | 另兩種不能送出的情況（Automation Only 唯讀、同事鎖）維持「說明框 ＋ 停用的輸入框」：那兩者是**暫時**狀態，客服可能想先打草稿，而畫布沒有涵蓋它們 |
| C-31 | **連續訊息的分組條件**（§8.3） | （只示範連續兩則 AI） | 只看**發送者**，不看時間間隔 | 平台訊息時間戳在同一批可能相同或極接近，加上「N 分鐘內」會產生不穩定的分組。⚠️ 真人客服另比 `sender.id` —— 只看 `type` 會把兩位同事的連續發言併成一組，第二位的 email 就此消失 |
| C-32 | **輸入框高度的下限**（§8.4） | 兩行 `72px`（「兩行 72px – 320px」） | 一行 **`46px`**（預設仍 `72`） | 小螢幕筆電上 72px 的下限會把訊息流壓到看不到幾則。「再低會讓 Shift+Enter 換行看起來像壞掉」改由 `rows="1"` 承擔。⚠️ 只動下限、不動預設 |

> ✅ **舊編號 1–18（統一前的本檔編號）已全部消失，不要再當成落差** —— 2026-09-01 的三輪改版裡畫布逐一採納了：
> 字級全面改 `rem` 並加大約 2.5px（**因此絕對數值現在要逐項比對，見 §2**）、情緒走勢圖整欄寬、
> 摘要的可展開「詳細內容」與「產生於 …」、「重新產生」只在失敗時可按、header 不顯示寬度數字、
> 建議卡捲動高度 480px、服務模式說明多一句、拖曳把手的鍵盤操作、頭像下拉的 email 換行不截斷、
> 中欄標題列的「已載入 N 則」、左欄 presence 兩態、未讀圓點＋「未讀」、篩選 chip 的計數。
> ⚠️ 編號留缺不遞補，以免與已轉出給 Design 的版本對不上。

> ✅ **C-20／C-21／C-23／C-24 與舊 33（漸層寫法）於 2026-09-07 的重核中一併消失** —— 2026-09-04 版畫布已逐項採納：
> 五段量表的「生氣」改用 `--danger` 系、標籤改中文、`score` 改 0–100 刻度、
> 輪數把 tag／軸標籤／實際點數三者對齊成同一個數字（示範值 25），
> 漸層的 `stop-color` 改寫在 `style` 裡。**這些現在是畫布規格，不再是我方偏離。**

> ⚠️ **`--danger` 系反過來要以畫布為準**：畫布定義了這三個 token，實作先前自訂的值已改為對齊（見 §1）。

> ⚠️ 另有數處**畫布畫得到、但平台資料拿不到**因而實作缺席或改寫的
> （客服姓名、未讀則數、對話清單列的「最後一則訊息」、客戶輸入狀態）。
> 那些不是取捨而是沒有資料，清單見 `DESIGN_FEEDBACK.md` B 段。
> ⚠️ 原本列在這裡的「只看未回覆」與 OTP「還可嘗試 N 次」，
> **畫布已於 2026-09-08 13:18 版改掉**，兩者不再是落差。

## 🚧 畫布已有、實作尚未跟上

> ⚠️ **這一節與上面的 ⛔ 表意義相反**：⛔ 是「已裁示、不要改回去」，這裡是「該做而還沒做」。
> 兩者混在一起看會把待辦當成決定，所以分開列。**做完就從本節刪掉**，不留沿革。

**目前是空的。** 2026-09-08 17:03 版畫布新增的主題切換鈕、以及同輪核出的三處落差
（頭像 26→28px、左欄分組標題 13→12.5px、`.dark` 沒有切換入口）**當天全部補上**，
規格見 §8.1「頂列」，守衛見 `test/theme-toggle.test.ts`。

下表的 artboard 編號是**畫布內的 section id**（`<section id="…">`）。
⚠️ 引用畫面時一律用「artboard 編號 ＋ 狀態名稱」，不要用檔名 —— 備存截圖已於 2026-09-03 刪除。
⚠️ 截圖欄只是備存留查的對照，規格看本文件對應章節。

| Artboard | 說明 | 規格 | 備存截圖 |
|---|---|---|---|
| 1a | 登入頁 | §4、§6 | 淺／深色 |
| 1b | 選擇組織 | §5、§6 | 淺／深色 |
| 1c | 主工作區 | §8 | 淺／深色，**另有多個狀態變體，見下表** |
| 1d | 載入中／空狀態 | §9 | 淺／深色 |
| 3a | **語氣標籤色票**（`3a-light`／`3a-dark`） | §10 | 無截圖 |
| 2a | Copilot 面板（取代 1c／1d 右欄佔位） | §7 | 展開態（淺／深）、載入中、結案流程中、以及三個摘要卡狀態 |
| **2b** | **結案摘要區塊 · 狀態矩陣** | **§7.5** | 2026-09-03 新增。只畫第 6 區塊，把涵蓋範圍選擇器與摘要卡的各種狀態並排。⚠️ 1c／2a 只保留**一個**結案基準態，其餘結案相關狀態全部收在這裡 |

### 1c 的狀態變體

> 這些是**同一個 artboard 的不同狀態**，不是新的 artboard —— 在畫布原始碼裡是同一個
> `<section id="1c">` 用切換鈕與畫面內的按鈕參數化出來的。
>
> ⚠️ **逐字文案與尺寸看 §8，不要從畫面判讀。** 下表記的是「有哪些狀態、怎麼觸發、
> 實作時該注意什麼」—— 那是導覽資訊，是 §8 的逐字規格答不出來的部分。
>
> ⚠️ **2026-09-03 起本表以「狀態名稱」為鍵，不再對應截圖檔名**（備存截圖已刪除）。
> 「觸發」欄記的是畫布原始碼裡的 handler 名稱，開①時照那個名字找得到對應的切換鈕。
>
> 規格出處：接手／離開／結案三個出口與 Copilot 面板可見性的行為定義在
> `specs/003-analysis-trigger-policy/spec.md`（FR-016～FR-023 與「Session 2026-08-28」兩節）；
> **結案流程本身屬 M3**，行為定義在 `specs/006-closure-handoff-summary`。

| 狀態 | 觸發 | 實作時要看的重點 |
|---|---|---|
| 已接手（基準態） | 預設 | 標題列「離開對話」（次要）＋「結案」（primary）＋輔助說明逐字「離開＝僅退出不寫入 · 結案＝產生摘要供確認後寫入」；服務模式分段控制項可切換；Copilot 面板展開 |
| 已接手 × 深色 | `theme` | 深色只提供基準態 |
| **未接手** | `toggleClaimed` | Copilot 面板**整欄不存在**（非變灰／非骨架），中欄延伸至右緣；標題列只有「接手對話」＋下拉；Composer 唯讀提示逐字「尚未接手此對話，無法輸入回覆。請先點右上角「接手對話」。」。003 FR-016 的視覺依據 |
| 未接手 × 下拉展開 | 同上，點開下拉 | 兩個選項寫出**後果**而非模式名稱：「接手並停用 AI 自動回覆」／「接手但保留 AI 自動回覆」 |
| 左側對話清單收合 | `toggleLeft` | 收合為窄直條，保留展開鈕與未讀數徽章 |
| Copilot 面板收合 | `toggleRightCollapsed` | 收合為窄直條，保留 COPILOT 直排標籤與展開鈕。⚠️ 收合鈕**只在已接手時存在**（003 FR-017） |
| 撞單攔截 | `toggleIntercept` | 憲法 3.3① 的封閉集合之一。Composer 轉為「已攔截」，三個處置選項＋「草稿已保留 · 送出鍵已鎖定」 |
| **結案中**（唯一的結案基準態） | 畫面上按「結案」（`startClosing`），`cancelClosing` 復原 | **① Composer 維持可輸入**（畫布未對結案狀態做任何停用，唯一的 `disabled` 綁在撞單攔截上）＋上方常駐橫幅，逐字：「**結案中** —— 摘要內容為按下結案當下的對話快照，不含此後的新訊息。送出新訊息後，可按「重新產生」把它納入摘要。」（✅ 2026-09-04 版畫布已改掉舊尾句「要送出訊息請先取消結案。」—— 它與同狀態下可用的 composer 矛盾，Design 已採納）。**② 標題列換成兩顆按鈕**，⚠️ **「離開對話」在此狀態不顯示**（`closing` 分支只有這兩顆）：`取消結案`（height 29px、padding 0 10px、`1px solid --border-strong`、透明底、radius 7px、0.9063rem `--text-2`、`undo-2` 13px、hover `--surface-2`、`title="回到已接手狀態，不寫入任何紀錄"`）＋ `結案中…`（**disabled 的 `--navy` 實心鍵**：height 29px、padding 0 12px、無框、radius 7px、`--navy-fg` 字／0.9063rem／500、`cursor:default`、`opacity:.85`，內含 `animation:spin 1s linear infinite` 的 `loader-2` 13px）＋ 其下輔助說明「取消結案＝回到已接手狀態，不會留下任何紀錄」（0.7813rem `--text-3`）。`writing` 時「取消結案」轉 disabled（`1px solid --border` ＋ `--surface-3` 底 ＋ `--text-3` 字 ＋ `cursor:not-allowed` ＋ `opacity:.6`，icon 仍是 `undo-2`）＋ `title="寫入請求已送出，此時無法取消"`，輔助說明同時換成 `lock` icon 11px ＋「寫入請求已送出，此時無法取消」。**③ 對話資訊列（收合態）另有一顆狀態 pill**：`--navy-soft` 底 ＋ `1px solid --navy-soft-bd` ＋ **radius 20px** ＋ padding 2px 9px ＋ 0.8438rem `--navy-2`，內含旋轉 `loader-2` **11px** ＋「結案中…」（未結案時同位置是 `--navy` 實心的「結案」鍵，height 27px）—— ⚠️ 與 ② 的標題列按鈕是**兩個不同位置**，不要只做一個。⚠️ **這條警告本身就漏接過一次**：實作到 2026-09-08 手動驗收前只做了 ②，收合態在結案中仍顯示「結案」鍵，客服會以為沒按到而再按一次（那是一次無效操作，不會報錯、不留痕跡）。已補上，並由 `test/closure-ui-honesty.test.ts` ⑪ 守住。**④** 服務模式轉唯讀並提示「結案中無法切換服務模式，請先取消結案」；左側清單該列顯示「結案未完成」；右欄 `panelVariant` 轉 `closing`（第 6 區塊置頂、其餘五塊收合）。⚠️ **摘要過期與寫入中兩個子狀態已移到 2b**，1c 不再各開一個變體 |
| 同事視角 — 有人正在結案 | `toggleColleague` | presence 列顯示「〈某人〉正在結案／你仍可回覆或自行結案」。⚠️ **不阻擋**同事回覆或自行結案，純提示 |
| 摘要已寫入但離開失敗 | `toggleLeaveFailed` | 頂端橫幅「結案摘要已寫入，但離開對話失敗」＋「重試離開」；⚠️ 該 handler 會設 `closing:false`，因此**右欄回到 `expanded`、第 6 區塊已消失** —— 結案本身已完成（`specs/006` FR-047b）。左側「結案未完成」標記也已消失 |
| 訊息載入完成 | `toggleMsgs` | 「載入較早的訊息」按鈕與「已載入 N 則」的兩態 |

---

## 0. Token 對應策略

這是自訂的 navy 品牌色階，**不是** Nuxt UI 預設的中性灰階（`bg-default`/`text-muted` 那組）。
建議走 `app.config.ts` 自訂主題，而非硬套 Nuxt UI 語意 token：

| 設計 token | Nuxt UI 對應 | 備註 |
|---|---|---|
| `--navy` | `primary` | 品牌主色 |
| `--warn` | `error` | 錯誤／警示 |
| `--active` | `success` | 連線 pill、`active` 狀態圓點、情緒量表的「平靜」段、服務模式的「全自動」 |
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
>
> ⚠️ **2026-09-08 起這條不再只是「翻譯選擇器」的細節** —— 畫布新增了真的會被按的
> 主題切換鈕（§8.1）。在那之前沒有任何東西會切換主題，兩套選擇器的差異看不出後果；
> 現在那顆鈕切錯目標（改 `data-theme` 而不是 `.dark`）**自訂區塊會變色、Nuxt UI 元件不會**，
> 得到一個半深半淺的畫面，而且不會有任何錯誤訊息。

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

⚠️ **2026-09-01 起畫布已全面改用 `rem`，且採納了實作的尺度（較舊版加大約 2.5px）。**
因此**絕對數值現在要逐項比對** —— 先前那條「只比相對關係、不比絕對值」的紀律**已作廢**。

畫布用的階梯（四位小數是畫布的寫法，實作用等值的精確分數，例如 `0.8438rem` ≡ `0.84375rem`）：

| rem | px | 典型用途 |
|---|---|---|
| `0.7188` | 11.5 | 訊息泡泡裡的頭像縮寫 |
| `0.75` | 12 | 右欄收合態的「已收合」直排字 |
| `0.7813` | 12.5 | 走勢圖軸標籤、發送者角色、語氣標籤以外的最小輔助字 |
| `0.8125` | 13 | 狀態標籤（700／`.08em`）、面板 `COPILOT` 徽章、meta 與時間戳（多搭 mono） |
| `0.8438` | 13.5 | Eyebrow 徽章（700／`.06em`）、區塊徽章、篩選 chip、量表分段 |
| `0.875` | 14 | 知識庫摘錄、需補資料、error 說明 |
| `0.9063` | 14.5 | 建議卡標題、摘要「詳細內容」內文、走勢摘要、錯誤內文 |
| `0.9375` | 15 | 說明文字（`line-height:1.6`）、摘要正文（`1.75`）、知識庫結果標題、組織名稱 |
| `0.9688` | 15.5 | 情緒示警 pill、訊息泡泡正文、送出鍵 |
| `1` | 16 | 輸入框文字（含 Composer 的 `textarea`）、主按鈕 |
| `1.0313` | 16.5 | 1b 組織清單的組織名 |
| `1.0938` | 17.5 | artboard 標題（畫布自己的說明文字，非 UI） |
| `1.3438` | 21.5 | 頁面標題（登入／輸入驗證碼） |
| `1.5313` | 24.5 | OTP 數字格（mono） |

實作值集中在 `app/assets/css/main.css`（`.ac-title`／`.ac-eyebrow`／`.ac-subtitle`／`.ac-label`／
`.ac-status-label`／`.ac-detail-*`）與各元件的 `text-[…rem]`。

> ⛔ **1a 的「送出中」「錯誤」「驗證碼錯誤」不是 UI 文案，不要實作。**
> 它們在畫布上位於卡片**外面**、一條 `border-top:1px dashed` 之下，是畫布作者用來標示
> 「以下是這個狀態的示範」的**註解**。照抄會讓登入頁憑空多出三個標籤。
> （1b 的「載入中」「無組織」不同：它們在卡片**內**，是真的 UI 文案，實作照做。）

⚠️ **Eyebrow 徽章的縱向 padding 依所在畫板而異，不是同一個值**：
1a／1b 是 `4px 8px`、面板 header 是 `3px 8px`、區塊徽章是 `3px 9px`。
共用的 `.ac-eyebrow` 取面板那組，另外兩處在使用端覆寫。

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
2. 標題「輸入驗證碼」+「已寄送至 {{maskedEmail}}，15 分鐘內有效。」
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
  - 中：組織名稱（`1.0313rem`／`500`）+「org_id · 角色」（`0.875rem` mono／`--text-2`）
  - 右：`chevron-right`。⚠️ **沒有狀態 pill** —— 角色寫在第二行的 `org_id · 角色`（mono，如 `org_qa · 唯讀稽核`）
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
- 「輸入驗證碼」／「已寄送至 {{maskedEmail}}，15 分鐘內有效。」
  > 這是本文件**兩處**「畫布錯、實作對」的落差之一，另一處是 §4.2 的 OTP 字元集。
- 按鈕「驗證並登入」
- 「沒收到？」＋「{{mm:ss}} 後可重新寄送」／按鈕「重新寄送」
- 錯誤「驗證碼不正確，請確認後再試一次。」
  > ⚠️ 畫布 2026-09-08 13:18 版之前逐字寫著「還可嘗試 {{n}} 次」，**已依我方回饋改掉**：
  > 驗證 API 的回應沒有剩餘次數欄位，那個數字只能用猜的。不要把它加回來。

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
- **常駐五個區塊，皆可獨立折疊**（情緒／對話摘要／建議／知識庫快查／AI 階段紀錄）。
  ⚠️ 第 6 區塊「結案摘要自動填入」**不常駐** —— 只在結案流程中出現，且**置頂**。見 §7.2 ⑥ 與 §7.5
- 支援淺色／深色主題
- 支援「載入骨架」與「結案流程中」兩種特殊狀態

### 7.2 區塊

一般狀態由上到下是**五個**常駐區塊（①～⑤）；第 6 區塊只在結案流程中出現並**置頂**，
此時其餘五塊全部收合成單行。

1. **客戶情緒提示**（tag「近 N 輪」，mono；畫布示範值為「近 25 輪」，折線正好 25 點、軸標籤右端也是 25。⚠️ N MUST 與軸標籤右端同一個數字 —— 兩者都是「這張圖實際畫了幾輪」）—— 由上到下四段：
   - **警示列**：情緒 pill（`0.9688rem`／`500`／`--warn` 字／`--warn-bg` 底／`--warn-bd` 框／
     `radius:20px`／`padding:5px 12px`／`gap:5px`／`alert-triangle` 14px）＋ 彈性空白 ＋
     `score 72 ↑`（`0.8438rem`／mono／`--text-3`，**0–100 刻度**；畫布示範值 `score 35 ↓`）
   - **走勢圖**（⚠️ **2026-09-01 全面改版，舊的 128×34 sparkline 規格已作廢**）：
     整段包在 `border:1px solid var(--border)`／`radius:8px`／`--surface-2` 底／
     `padding:8px 9px 6px`／`gap:5px` 的框內。
     - `<svg viewBox="0 0 320 52">`＋`width:100%; height:auto`（**等比**），繪圖區 x ∈ [6, 314]、y ∈ [6, 42]
     - 基準線：`y=42`、`x` 由 6 到 314、`stroke-width:1`／`--border-strong`
     - 折線：`stroke-width:2`／`linecap:round`／`linejoin:round`／`fill:none`，最多 50 點。
       ⚠️ **依分數帶上色**（2026-09-01）：`<linearGradient gradientUnits="userSpaceOnUse">`
       由 `y=6`（score 100）到 `y=42`（score 0），五級各兩個同 `offset` 的硬停點
       （`0/0.2` `--active`、`0.2/0.4` `--info`、`0.4/0.6` `--open`、`0.6/0.8` `--warn`、
       `0.8/1.0` `--danger`），色票與下方量表 bar 同一組。
       ⚠️ 示警**不**染折線（先前會整條轉 `--warn`／`--danger`，已退場）。
       ⚠️ **`stop-color` MUST 寫在 `style` 裡**（畫布 2026-09-04 版已是這個寫法）——
       presentation attribute 不做 `var()` 代換，寫成 `stop-color="var(--active)"`
       在瀏覽器裡是無效值，會**靜默退回黑色**：不報錯，只是整條折線變黑
     - 端點：`<circle r="2.8">`，同折線色（`fill="url(#…)"`，由 y 座標自動取到該點的分帶色）
     - 附件標記：`x` 位置的**虛線**（`y` 6→42、`--border-strong`、`stroke-dasharray="2 3"`）
       ＋ 基準線下方的實心小三角（`path d="M<x> 44.5 l3 4.5 h-6 z"`／`--text-3`）
     - 圖下方一列（`0.7813rem`／`--text-3`）：`第 1 輪`（mono）→ 彈性 → `▲附件`（7×7 三角）→ 彈性 → `第 N 輪`（mono）
   - **走勢文字摘要**（`0.9063rem`／`--text-2`／`line-height:1.7`）
     ✅ 包在 `sc-if trendNote` 裡 —— 畫布明訂它**可能不存在**，此時整段不顯示。
     我方的 `SentimentNarrative { trend, advice }` 在產生失敗或評分點少於 2 個時為 `null`，正是這個狀態。
   - **情緒量表圖例**：五段等寬（`0.8438rem`），逐字為中文：「平靜」→`--active`／
     **「普通」→`--info` 字＋`--navy-soft` 底**（⚠️ 2026-09-01 由 `--text-2`＋無底色改來：
     無底色那格與走勢圖框同色、在 bar 上像破了個洞，且無彩度的灰夾在四個有彩度的顏色中間
     會被讀成「停用」。⚠️ 不要改用 `--navy-2`，深色主題對 `--surface-2` 只有 3.02:1，
     當文字達不到 AA）／
     「擔憂」→`--open`／「挫折」→`--warn`／**「生氣」→`--danger` 系**；
     目前所在區間 `font-weight:700` ＋ `box-shadow:inset 0 -3px 0 <該段色>`；
     ⚠️ 「生氣」段的左分隔線用 `--danger-bd`（其餘四段 `--border`），且字重固定 500。

   ⚠️ **標題列右側只有 tag，沒有重試按鈕** —— 三個分析區塊皆同，重試入口只在該區塊 error 時出現。

2. **對話摘要**（tag「AI 產生 · 接手前必讀」）—— `order:2`，位置在情緒與建議之間。⚠️ 它是畫布 2026-08-31 才新增的區塊，與「第 6 區塊（結案摘要）」是**兩件不同的事**，不要混淆。
   - **ready**：一段摘要正文（`0.9375rem`／`line-height:1.75`／`--text`）＋ 分類 pill 列
     （`radius:20px`／`padding:3px 9px`／`0.8438rem`；一般類別用 `--navy-2` 字＋`--navy-soft` 底＋`--navy-soft-bd` 框＋`tag` icon，
     風險類別如「重複進線」改用 `--open` 字＋`--open-bg` 底＋`repeat` icon）
     ＋ **「詳細內容」區**（`border-top:1px solid var(--border)`／`padding-top:8px`）：
     標題列左為 chevron ＋「詳細內容」（`0.9063rem`／`500`／`--text-2`）、右為「**四段 · 掃完摘要後查**」
     （`0.8125rem`／`--text-3`）；展開後四段（已知事實／已嘗試處理／尚未解決／建議行動），
     段標 `0.8125rem`／`700`／`letter-spacing:.05em`／`--text-3`，內文 `0.9063rem`／`line-height:1.7`／`--text`
     ＋ **底列**（`0.8125rem`／`--text-3`）：左「產生於 <mono>HH:MM:SS</mono>」、右「**同一則訊息不會有不同結果，僅產生失敗時可重試**」
     ⚠️ **ready 態沒有按鈕** —— 重試入口只在 error 告示框裡。
     ⛔ pill 文字實作改用 `--info` 而非 `--navy-2`（B-2：後者同時是按鈕 hover 底色，調亮會破壞按鈕上的白字）。
   - **無正文（`noBody`）**：正文位置改為虛線提示框（`--surface-2` 底／`1px dashed var(--border-dash)`／
     `radius:8px`／`padding:8px 10px`／`file-question` 13px ＋「**本次未產生摘要正文，已改為預設展開詳細內容。**」）

   > **資料來源**：正文與主題標籤對應 `ConversationSummary` 的 `narrative`／`topics`
   > （2026-09-01 新增），風險 pill 對應既有的 `riskFlags`（五個列舉值）。
   > ⚠️ `narrative`／`topics` 由 iMBrace 後台的 `AgentCopilot_摘要_agent` 產生，
   > **那份 system prompt 不在這個 repo 裡** —— 因此兩者在 schema 一律是選填，
   > 且驗不過的值轉 `undefined` 而不拋錯（見 `server/services/ai/schemas.ts` 的說明）。
   > 缺值時 UI 退回以 `intent` 當正文。
   - **loading**：**三條** 10px skeleton（首條帶 `shimmer` 動畫，寬度 100%／94%／62%）＋ 兩顆 20px 高、82px／70px 寬的 pill skeleton
   - **error**：`--warn-bg` 底／`--warn-bd` 框／`radius:9px` 的告示框，內含 `alert-triangle`
     （`padding:9px 11px`／icon 15px）＋ 標題「**摘要產生失敗**」（`0.9063rem`／`500`）
     ＋ 說明「**其餘區塊不受影響，可直接閱讀完整對話紀錄。**」（`0.875rem`）
     ＋「**重試**」按鈕（`27px` 高／`padding:0 10px`／`radius:7px`／`0.875rem`）

3. **AI 即時回覆建議**（tag：ready 時「**本次回傳 3 則**」；⛔ 載入中的「產生中 2 / 3」**實作不做** —— 004 的兩段式生成沒有「已完成 x 張」這種狀態，照抄會顯示一個永遠對不上流程的進度）—— 一張或多張建議卡（`--ai-bg` 底／`--ai-bd` 框／`radius:10px`／`padding:10px 11px`／`gap:7px`），每張由上到下：
   - 標題列：`book-open` icon（`--ai`）＋ 知識庫來源標題（`12px`／`--text`／`500`）
     ＋ **語氣標籤** ＋ 彈性空白 ＋ **信心度 pill**
   - **語氣標籤**（`0.8125rem`／`500`／`radius:4px`／`padding:1px 6px`，各帶一個 icon）：
     「致歉」`heart-handshake`／`--warn` 系、「說明」`info`／**`--info`**＋`--navy-soft`（畫布本身已改用 `--info`）、
     「挽留」`hand-heart`／`--open` 系
   - **信心度 pill**：`0.8125rem`／`700`／`radius:20px`／`padding:2px 8px`／mono／`--surface` 底＋`--ai-bd` 框＋`--ai` 字，逐字「信心度 92%」。**不是每張卡都有**（截圖裡第二張沒有），與憲法 4.4「`confidence` 沒有真實依據時 MUST 為 `null`、UI 依 `null` 決定顯示或留空」一致
   - 建議回覆全文（`0.9375rem`／`line-height:1.75`，放在 `--surface` 底＋`--border` 框＋`radius:8px` 的框內）
   - 「**推薦理由：**…」（`0.8438rem`／`line-height:1.6`／`--text-3`）
   - 「需補：… — 帶入前請先填寫」（僅缺資料時，`--open` 系）
   - 底列靠右「↵ 一鍵帶入」（`28px` 高／`--navy` 底／`--navy-fg` 字／`radius:7px`／`corner-down-left` icon）
   - 卡片區可捲動（`max-height:480px`，卡片間距 `9px`）

4. **知識庫快查** —— 搜尋輸入框（`height:34px`、`--surface-2` 底、`--border-strong` 框、內含放大鏡 icon；placeholder 逐字為「**用一句話問，例：發票補寄要多久**」）＋ 結果清單，每筆由上到下：
   - 標題（`0.9375rem`／`500`／單行 `ellipsis`）＋ 靠右的更新年月（`2026/05`，mono `0.8125rem`）
   - **摘錄**（`0.875rem`／`--text-2`／`line-height:1.65`），**兩行截斷**
     （`display:-webkit-box`／`-webkit-line-clamp:2`／`-webkit-box-orient:vertical`／`overflow:hidden`）
   - **靠左**的「插入為回覆」（`25px` 高、`--border-strong` 框、`--surface-2` 底）／
     「展開全文」（無框＋`chevron-down`）兩顆按鈕

   過期文件多一條**獨立警示列**：`--open` 字／`--open-bg` 底／`radius:6px`／`padding:4px 8px`／
   `gap:6px`／`clock-alert` 12px ＋ 逐字「**已超過 12 個月未更新，引用前請確認**」。
   ⚠️ 色系是 `--open` 不是 `--warn` —— 這不是錯誤，是「引用前請確認」的提醒。
   ⚠️ **每一筆結果都有 `border-top`，包含第一筆**（上方緊接搜尋框，那條線分開的是「輸入」與「結果」）。
   ⚠️ **沒有 SOP 編號**，只有標題＋更新年月。

5. **AI 階段完整對話紀錄**（tag「AI 階段」）—— 逐則對話紀錄（客戶／AI／客服三種發送者），附件有**三種**型別，各自的說明文字逐字為：「PDF · 檔名僅供辨識，無法預覽」／「圖片 · 可預覽縮圖」／「舊型附件 · 僅有檔名，無法預覽」；區塊內可捲動，底部一行逐字為「**顯示 AI 階段訊息，可捲動**」（⚠️ 2026-09-01 畫布已拿掉「7 / 18 則」——
   我方本來就給不出則數，現在兩邊一致）

6. **結案摘要自動填入**（tag「AI 草稿 · 可修改」，⚠️ 分隔是 U+00B7 不是「・」）
   —— ⚠️ **整塊包在 `sc-if closing` 裡：未進入結案流程時不存在**（非收合、非骨架），
   進入時**置頂**（在畫布原始碼中物理位置就在①之前）。上方另有一列「已進入結案流程」。

   ⚠️ **2026-09-07 訂正：那一列在元件裡是畫出來的**，先前寫成「沒有被畫出來、版面由實作自訂」
   是錯的（成因是只讀了 2b 的決策卡敘述，沒有回元件原始檔查）。逐字規格為：
   **卡片之外**的獨立一列（`order:0`，第 6 區塊是 `order:1`）、`--navy-soft` 底 ＋
   `1px solid --navy-soft-bd` ＋ radius 8px ＋ padding 7px 10px ＋ `gap:7px`，
   內含 `flag` 13px `--navy-2` ＋ 文字 0.875rem `--text-2`，其中「結案流程」四字以
   `--text`／500 強調。2b 的「決策 · 置頂時的提示」卡片補的是**為什麼只說這一句**：
   「收合與還原是可預期的模式切換，不需要在每次結案時解釋一遍。」

   展開後的容器是 `padding:0 12px 12px` ＋ `flex-direction:column` ＋ **`gap:10px`**。
   內容由上到下：（過期提示）＋ **涵蓋範圍選擇器（§7.5）** ＋ **人審欄位組（見下表）**
   ＋ 時間戳逐字「**草稿產生於 HH:MM:SS**」（`0.8125rem` `--text-3`，時間用 IBM Plex Mono）
   ＋ 兩個按鈕
   ＋ 一行提醒文字：「「一鍵寫入 CRM」是本面板唯一會寫入資料庫的動作，寫入後不可自動回復。」

   **人審欄位組**（⚠️ 2026-09-08 版畫布才補上，先前只有三顆唯讀 pill；
   欄位清單與受控詞彙的選項逐字等同我方 `config/categories.ts`，順序也相同）：

   | 順序 | 欄位 | 控制項與樣式 |
   |---|---|---|
   | 1 | 摘要正文 | `textarea`：`min-height:104px`、`resize:vertical`、`1px solid --border-strong`、radius **9px**、`--surface-2` 底、`padding:9px 11px`、`0.9375rem`／`line-height:1.7`／`--text` |
   | 2 | 意圖 | `input`：`height:34px`、同上框線／底色／radius、`padding:0 11px`、`0.9063rem` |
   | 3 | 分類 · 處理結果 · 情緒結果 | 一列三欄 `grid-template-columns:repeat(3,minmax(0,1fr))` ＋ `gap:8px`；每個是 `select`：`height:34px`、`appearance:none`、同上框線／底色／radius、`padding:0 28px 0 11px`、`0.9063rem`；右側絕對定位 `chevron-down` 14px `--text-3`（`right:9px`、`pointer-events:none`） |
   | 4 | 採取的行動（**多選**） | 觸發鈕：`height:34px`、同上框線／底色／radius、`padding:0 9px 0 11px`；label `0.9063rem`，多值以「、」串接並 `text-overflow:ellipsis`；右側 `chevron-down` 14px `--text-3`。展開的面板 `position:absolute; top:38px; z-index:25`：`--surface` 底 ＋ `1px solid --border-strong` ＋ radius 10px ＋ `box-shadow:0 10px 28px rgba(16,24,40,.18)`；頂部搜尋框 `height:34px`、無框只有 `border-bottom:1px solid --border`、placeholder 逐字「搜尋行動…」；選項列 `padding:8px 11px`、hover `--surface-3`、右側勾號 14px `--navy-2`（`stroke-width:2.5`，未選以 `opacity` 隱藏）；清單 `max-height:198px` ＋ `overflow-y:auto`；無結果逐字「沒有符合的行動」（`0.875rem` `--text-3`、`padding:9px 11px`）。無障礙：觸發鈕 `aria-haspopup="listbox"` ＋ `aria-expanded`，面板 `role="listbox"` ＋ `aria-multiselectable`，選項 `role="option"` ＋ `aria-selected` |
   | 5 | 相關的知識庫來源 | chip 列（`flex-wrap` ＋ `gap:6px`）。每顆：`height:26px`、`padding:0 6px 0 9px`、`1px solid --navy-soft-bd`、radius **7px**、`--navy-soft` 底；文字 `0.8438rem` `--navy-2` **IBM Plex Mono** ＋ `ellipsis`；`×` 鈕 18×18、radius 5px、透明底、`--navy-2`、hover `--navy-soft-bd`、`aria-label="移除這筆知識庫來源"`。⚠️ **只能移除、沒有新增** —— 內容由系統檢索填入。⚠️ **刪光之後欄位不消失**，改顯示逐字「已全部移除，寫入時不帶知識庫來源」（`0.8438rem` `--text-3`） |
   | 6 | 後續待辦 | **每列兩行**（⚠️ 不是三欄並排 —— 420px 下每欄只剩約 120px）。外層 `flex-col gap:3px` ＋ `padding-bottom:2px`；內層 `flex-col gap:6px`。第一行：「待辦事項」input **整列寬**、`height:34px`、radius 9px、`--surface-2` 底，框線**依內容變色**（有字 `--border-strong`／空 **`--danger`**）。第二行 `flex gap:6px`：「負責人（選填）」與「時間（選填）」各 `flex:1 1 0`（同樣式），列尾移除鈕 30×30、透明底、radius 7px、`--text-3`、`aria-label="移除這一列待辦"`。該列未填時，其下一行 `0.8125rem` `--danger` 逐字「有待辦事項還沒填內容，請補上或移除該列後再寫入」。所有列之後才是虛線新增鈕：`height:28px`、`padding:0 10px 0 6px`、`1px dashed --border-strong`、radius 7px、透明底、`0.875rem` `--text-2`、內含 `plus` 13px；hover 轉 `--surface-2` 底 ＋ `--text` 字。⚠️ **待辦事項空白時「一鍵寫入 CRM」鎖住**（2b 的 **D1** 畫板），補上內容或移除該列即解鎖 |
   | 7 | 唯讀區 | `--surface-2` 底 ＋ `1px solid --border` ＋ radius **9px** ＋ `padding:9px 11px` ＋ `gap:5px`；首行逐字「由系統計算，不可修改」（`0.8125rem` `--text-3`）；其下每列左為標籤、右為值（右對齊、`0.8125rem` `--text-2`、IBM Plex Mono、`overflow-wrap:anywhere`）：參與的客服／接手時間／區間起點情緒／區間終點情緒／區間最低情緒。⚠️ **這一區的值有兩套：畫面看到的與寫進 Board 的刻意不同**（見下方兩條註）|

   ⚠️ **唯讀區的時間一律轉成本地時區 ＋ 時區標記**（`2026/09/08 10:13 [GMT+8]`），
   涵蓋「接手時間」與情緒留空說明（`sentimentNote`）句子裡的時間戳；原始值留在 `title`。
   ✅ **畫布已於 2026-09-08 14:12 版改採同一格式**（`sysHandover` 與 `sysSentiment` 逐字元相同），
   因此這**不再**是實作偏離；此前畫布寫的是原始 UTC ISO `2026-09-08T02:13:19.700Z`。
   當初改的理由留在這裡防回退：客服在 UTC+8 讀 `02:13` 對不上自己十點多接手的記憶，
   而這一區的用途正是事後核對。
   ⚠️ **時區標記不可省** —— 沒有它，畫面的 10:13 與 Board 的 02:13Z 看起來會像兩筆不同的紀錄。
   ⚠️ **只換顯示。** 寫進 Data Board 的 `joined_at`／`period_sentiment_note` 與後端日誌
   都仍是原始 UTC ISO —— 存進去的字串一旦帶了產生它的那台瀏覽器的時區，
   之後就再也無法確定它是哪個時刻。兩者由 `commit.post.ts` 以 server 端
   `computeReadonlyFields()` 重算、忽略 body（契約 R3.7），前端格式化結構上碰不到它們。
   ⚠️ 情緒說明是**就地換掉句子裡的時間戳**，不重組句子 —— 那四句是 server 在
   `sentiment-range.ts` 組好的，要重組就得拆成 i18n key ＋ 參數並改動契約與 Board schema。
   其中「區間起點無法解析（…）」那一句裡的字串本來就不是合法時間，**維持原樣**。
   共用實作在 `app/utils/absolute-time.ts`，守衛見 `test/closure-ui-honesty.test.ts` ⑦。

   ⚠️ **「參與的客服」顯示的是名字，不是 id**（2026-09-08）。經 `server/services/directory.ts`
   查到的顯示名（平台沒有人名，名冊 `display_name` 實測 12/12 全是 email，因此實際上是 email），
   多人以「、」串接，原始 id 留在 `title`。
   ✅ **畫布已於 2026-09-08 14:31 版改採同樣的呈現**（`sysAgents` 逐字
   `agent.lin@company.com、agent.chen@company.com`，連分隔符都相同），因此這**不再**是實作偏離；
   此前畫布寫的是原始 `u_df56079c-7df4-41c6-9ce0-5f57f29df534`。
   當初改的理由留在這裡防回退：這一區要回答的是「誰服務過這位客戶」，
   而 `u_` 開頭那串字對客服不對應任何他認得的東西。
   ⚠️⚠️ **登入者自己的名字來自 session（`session.operatorName`），不是名冊。**
   名冊只裝 `conversations.get()` 的 `users[]`（團隊名冊），**登入者自己不保證在裡面**，
   而且沒有任何路徑會把自己寫進去（JOIN 走 presence 的 `reportViewing({ id, name })`，
   不是 `rememberOperators()`）。2026-09-08 手動驗收時整欄都顯示原始 `u_` id，就是這個原因 ——
   它走的是「查不到就誠實顯示 id」那條**合法**路徑，因此不報錯、也沒有紅燈。
   ⚠️ **查不到名字的那一個回傳原本的 id**，MUST NOT 留空、MUST NOT 編一個名字 ——
   「知道有這個人但不知道他叫什麼」與「沒有這個人」在畫面上必須不同（§10.2）。
   ⚠️ **同事（`watchers`）只查團隊名冊，名冊沒收錄的就顯示 id** ——
   這是 2026-09-08 的裁示，**不是待辦**。曾評估過的替代來源是 presence 條目
   （`reportViewing()` 存過 `operatorName`），代價是 `computeReadonlyFields()`
   要多收一個 store 參數並改成 async，決定不換。
   ⚠️ **寫進 Board 的 `operators` 仍是 id。** id 穩定，email 會隨帳號改名變動，
   改完之後舊紀錄就指不回任何人；這也與 `reviewed_by` 存 id 的既有做法一致。
   契約上因此是兩個欄位：`operators`（id、進 Board）與 `operatorLabels`（顯示名、只給畫面），
   由同一個 `map` 產生所以必然對位。守衛見 `test/closure-operator-labels.test.ts`。

   **欄位標籤一律 `0.8438rem` `--text-2`**（不加粗），標籤與控制項之間 `gap:4px`
   （後續待辦與唯讀區是 `5px`）。✅ 實作已於 2026-09-08 照改（原為 `0.8125rem` `--text-3` ＋ 500）。

   **實作對齊狀態（2026-09-08 收尾）**：手刻的部分已逐字照畫布 ——
   欄位標籤、知識庫 chip（含「已全部移除」的空態）、共用提示句（含 `info` icon）、
   後續待辦的兩行式與**就地**的錯誤說明、按鈕列的六種組合。
   `UInput`／`USelect` 已於本日改成原生 `<input>`／`<select>` ＋ `ac-field`
   （`height:34px`／radius 9px／`--surface-2` 底／`1px solid --border-strong`），
   後續待辦的兩顆 `UButton` 也改成原生 `<button>` ＋ 畫布的 token
   （新增鈕 `1px dashed --border-strong`／`height:28px`；移除鈕 30×30／radius 7px）。

   ⚠️ **仍是 `USelectMenu` 的只剩「採取的行動」一顆**，那是**刻意保留**的：
   畫布對它要的 `aria-haspopup="listbox"` ＋ `aria-multiselectable` ＋ `role="option"`
   ＋ 鍵盤與焦點管理，正是手刻最容易做壞、而且**壞掉不會報錯**的一段。
   觸發鈕與面板外框以 `:ui` 對到畫布的 token。
   ⚠️⚠️ **它內建的文案走 `@nuxt/ui` 自己的 locale，不是我方的 i18n 檔。**
   本專案沒有設定 `UApp` 的 `locale`，因此搜尋框與空結果會落回**英文**
   （`Search…`／`No matching data`）—— 在一個全中文的內部工具裡漏出兩句英文，
   而且 grep `i18n/locales/zh-TW.json` 永遠找不到它（那兩句根本不在我方的語系檔裡）。
   已於 2026-09-08 以 `:search-input` 與 `#empty` 覆寫成畫布的
   「搜尋行動…」／「沒有符合的行動」。**日後再引入任何 Nuxt UI 的複合元件時，
   先確認它有沒有自己的內建字串。**
   ⚠️ 畫布另外要 `aria-label="搜尋行動"`，**目前沒有給**：`searchInput` 的型別是
   `InputProps`，而它以 `@vue-ignore` 把 `InputHTMLAttributes` 從 props 型別裡拿掉，
   傳 `aria-label` 會是型別錯誤（執行期其實會落到 `<input>` 上）。
   那個 aria-label 的字與 placeholder 完全相同，因此沒有為它加一個
   「型別說不行、實際可以」的 cast。
   ⚠️ 面板內部尚未逐字對的還有：`box-shadow:0 10px 28px rgba(16,24,40,.18)`、
   選項列 `padding:8px 11px` ＋ hover `--surface-3`、勾號 14px `--navy-2`
   （`stroke-width:2.5`）、清單 `max-height:198px`。

   唯讀區裡三個情緒數值留空時的兩種替代呈現：

   - 留空且**不是**在分析中 → 一行 `sentimentNote`：`0.8125rem` `--text-3`／`line-height:1.6`。
     ⚠️ **句子裡的時間戳在畫面上換成本地時區的易讀版本**（原始整句留在 `title`），
     理由與下方「接手時間」同一條
   - 留空且情緒為 `analyzing`／`retrying` → 旋轉的 `loader-2` 13px `--open`
     ＋ 文字 `0.8125rem` `--open`／`line-height:1.65`，逐字
     「情緒分析仍在進行，此刻寫入的紀錄情緒欄位會留空。等它完成後按「重新產生」即可補上。」
     （對應 2b 的 **C3** 畫板。⚠️ 寫入本身**不封鎖** —— 情緒欄位留空是合法紀錄）

   #### 四個受控詞彙欄位的空值態（2b 的 **E1**／**E2** 畫板）

   模型挑不到白名單值時該欄位就是**空的**（`ai/schemas.ts` 會把白名單外的值換成空，
   FR-020a），而空值**是合法的寫入值**（`commit.post.ts` 的 `enumOrEmpty` 允許空字串）——
   不會被擋、不會報錯。因此這一態必須靠文案講清楚，不能只靠視覺。

   - **三個單選**：首項是 `<option value="">請選擇</option>`；
     文字色依有無值切換 —— 有值 `--text`、**留空 `--text-2`**（淡一階，但仍過 AA）。
   - **採取的行動**：未選時觸發鈕的 label 逐字「請選擇」，色同樣是 `--text-2`。
   - **共用提示句**：四欄**任一個**留空就顯示，**只出現一次**，位置在四個欄位之後 ——
     `info` icon 12px（`margin-top:3px`）＋ 文字 `0.8125rem` `--open`／`line-height:1.6`／`gap:5px`，
     逐字「AI 沒有從清單中選到合適的值，請自行選擇」。
   - ⚠️ **寫入按鈕維持可用**（E2 逐字：「客服有權留空結案」）——
     MUST NOT 因為欄位留空而封鎖寫入。這與 C3（情緒分析未完成）是同一條原則。
   - ⚠️ **`actionsTaken` 為空陣列也算留空**：`filter` 濾掉白名單外的值之後，
     「模型挑不到」與「真的沒採取行動」在資料上不可區分，而漏提醒的代價是
     一筆行動欄空白的紀錄直接進正式報表。
     觸發條件因此是 `!分類 || !處理結果 || !情緒結果 || 採取的行動為空`。

   **按鈕的六種組合**（畫布的 `freshIdle`／`staleIdle`／`scopeRegen`／`writing`／
   `writeFail="failed"`／`writeFail="unverified"`）：

   | 狀態 | 左鈕 | 右鈕 |
   |---|---|---|
   | `freshIdle` 一般 | 重新產生 | **一鍵寫入 CRM**（主要） |
   | `staleIdle` 摘要過期 | **重新產生**（升為主要） | 仍要寫入 CRM（降為次要） |
   | `scopeRegen` 改了涵蓋範圍 | — | 重新產生中，請稍候 |
   | `writing` 寫入中 | **文字不變**「重新產生」，轉 `disabled` ＋ `--surface-3` 底 ＋ `opacity:.6` | 文字轉為「**寫入中…**」＋ 旋轉 `loader-2`，`disabled` ＋ `--navy` 底 ＋ `opacity:.85` |
   | **B7** `failed` 寫入失敗 | 「重新產生」**降為次要** | **紅色**主鈕「重試寫入 CRM」＋ `rotate-cw`；另有次要文字鈕列「複製摘要文字」·「回報 IT」 |
   | **B8** `unverified` 回報成功但查不到 | 同上 | **紅色**主鈕「已確認沒有，重試寫入」＋ `shield-check`；**無次鈕** |

   ⚠️ 摘要過期時，**選擇器上方**多一列「對話有新內容，建議重新產生」（2026-09-07 訂正：先前寫成「下方」）—— 它講的是這份草稿整體過期了，不是涵蓋範圍選錯了，擺在選擇器下方會讀成在解釋剛剛那個選擇。
   ⚠️ 「重新產生」在 B7／B8 降為次要是**刻意的**，畫布寫明理由：**此刻重產只會蓋掉待寫入的內容**。
   ⚠️ 次鈕只有 B7 有（`hasFailSecond: wf === "failed"`）—— B8 的出路是人工查驗後重試，不是回報。

#### 兩種寫入失敗態（B7／B8，2026-09-04 新增）

⚠️ **這兩態是我方提報缺口後 Design 補的**，原本四種組合都預設寫入不會失敗。
拆成兩態的判準是「**客服接下來該做什麼**」不同，不是錯誤碼不同。

**共用版面**：錯誤區塊插在**按鈕列上方、摘要正文下方** —— **摘要不清空**。
容器 `--danger-bg` 底／`1px solid var(--danger-bd)` 框／**`border-left:3px solid var(--danger)`**／
`radius:8px`／`padding:9px 11px`／`gap:7px`。內含由上到下三段：

- 標題列：`{{ failIcon }}` 14px（`--danger`）＋ 標題（`0.9063rem`／`600`／`--danger`）
  ＋ 內文（`0.875rem`／`--text-2`／`line-height:1.65`）
- meta 列（`padding-left:21px`）：`clock` 11px ＋ `{{ failMeta }}`（`0.8125rem`／mono／`--text-3`）
- 備援列（`padding-left:21px`）：`corner-down-right` 11px ＋ `{{ failFallback }}`（`0.8125rem`／`--text-3`）

| | **B7** `failed` | **B8** `unverified` |
|---|---|---|
| `failIcon` | `x-circle` | `shield-alert` |
| `failTitle` | 寫入 CRM 失敗 | 寫入結果無法確認 |
| `failBody` | CRM 未收到這筆結案紀錄，摘要仍在此處、未遺失。可直接重試；連續失敗請改用下方備援管道，不要離開此對話。 | 平台回報寫入成功，但在 CRM 查不到這筆結案紀錄。請勿當成已完成——先到 CRM 確認，若確實沒有再重試一次。 |
| `failMeta` | `14:36:02 寫入失敗 · CRM 連線逾時（req 8f2c-41）` | `14:36:02 已送出 · 回報成功 · 查驗未找到（req 8f2c-41）` |
| `failFallback` | 備援：複製摘要並貼到 CRM 手動建檔，或回報 IT。 | 查驗方式：CRM 客戶頁 › 服務紀錄，比對「9/4 14:36 發票補寄」是否存在。 |
| `failBtn` | 重試寫入 CRM | 已確認沒有，重試寫入 |
| `failBtnIcon` | `rotate-cw` | `shield-check` |
| 次要文字鈕列（`hasFailSecond`／`failSecond`） | **「複製摘要文字」· 「回報 IT」** 兩顆（`0.8438rem`／`--navy-2`／底線，位於按鈕列之下） | （無） |

⚠️ **兩顆的內容相反，MUST NOT 互相取代**（2026-09-08 補上「複製摘要文字」，此前只有「回報 IT」）：
`回報 IT` 複製的是 `failMeta` ＋ `draftId` ＋ `conversationId`，**刻意不含草稿內文**
（憲法 1.5 —— IT 拿 `reqId` 就能串起三步寫入，不需要看到客戶對話）；
`複製摘要文字` 複製的**正是**草稿內文，那是 `failFallback` 逐字要客服做的事
（「複製摘要並貼到 CRM 手動建檔」），目的地是他自己的剪貼簿，不外流。
⚠️ 這一列**只有 B7 有**：B8 的出路是「先到 CRM 查驗、確認沒有再重試」，
多給兩個出口只會讓人繞過那個查驗。守衛見 `test/closure-ui-honesty.test.ts` ⑧。

⚠️ **`failMeta` 裡的 `req 8f2c-41` 是我方要提供的請求識別碼**（`specs/006` FR-035a）——
它是三步寫入（搜尋 → 建立／更新 → 回查）在日誌裡的串接鍵，客服看不懂也不需要懂，
但那是事後唯一能判斷「平台沒建」還是「我方回查用錯 id」的線索。

⚠️ **B8 的內文原本尾句為「重試可能產生重複紀錄，確認後再按。」，已於 2026-09-04 移除** ——
實測（`spike:board-write` 006-E10，n=3）建立後 47～55ms 即可被 `q` 搜尋到、`getItem` 3/3 立即可取，
因此重試會命中既有紀錄走 `updateItem`，**不會產生第二筆**。
⚠️ 量測條件是小型 board、低負載，資料量放大後未再驗證。

⚠️ 畫布曾有次鈕「標記為已手動建檔」，**已於 2026-09-04 移除**：它代表「客服自己在 CRM 建好了」，
而我方要不要為此在 Board 留一筆牽涉第二條寫入路徑與重複紀錄，超出 `specs/006` 範圍。
移除後畫布與實作一致，不留「文案先於行為」。

> ⚠️ 第 6 區塊的「一鍵寫入 CRM 不可回復」提醒，語氣上與 `ARCHITECTURE.md`／`CONSTITUTION.md` 裡對「寫入類操作需明確、不可靜默」的既有原則一致，**這點在 2a 是設計稿本身就強調的，不是本文件外推**。

### 7.3 面板 Header

`height:42px`／`--surface` 底／`border-bottom:1px solid var(--border)`／`padding:0 13px`／`gap:9px`。
由左到右：

- `COPILOT` 徽章：`background:var(--navy)`／`color:var(--navy-fg)`／`0.8125rem`／`font-weight:700`／`letter-spacing:.06em`／`padding:3px 8px`／`border-radius:5px`。
  ⚠️ 比 1a／1b 的 eyebrow 小半階（`0.8438rem`），是畫布本身的差異，不是抄錯。
- 副標 `headNote`（`0.8438rem`／`--text-2`）三態，逐字：載入中「**分析中**」／準備結案「**準備結案**」／其餘「**即時輔助**」
- 彈性空白
- **「全部重試」按鈕**（僅 `anyError` 時出現）：`24px` 高／`--warn-bd` 框／`--warn-bg` 底／`--warn` 字／`radius:6px`／`padding:0 9px`／`refresh-cw` icon 11px／`title="重新產生所有失敗的區塊"`
- 收合鈕：`26×26`／`--border` 框／`--surface-2` 底／`radius:6px`／`panel-right-close` icon

⚠️ **header 是 `flex:none` 的固定列，不屬於捲動區** —— 內容區才是 `flex:1; overflow-y:auto`。
「全部重試」正是某個區塊失敗時才出現的東西，讓 header 跟著捲走等於在客服最需要它的時候把它藏起來。

### 7.4 三種特殊狀態

- **載入中（漸進顯示）**：header 副標「分析中」；最上方一條狀態列（`--surface-2` 底／`--border` 框／`radius:8px`／`padding:7px 10px`）內含旋轉的 `loader-2` ＋ 逐字「**AI 分析中 · 約 5 秒完成（最長 12 秒），區塊會逐一出現**」；各區塊依 ①已完成／②進行中／③④⑤尚未開始 三種樣態呈現 —— 已完成的標題列右側出現完成勾選 icon，進行中與尚未開始的以 skeleton（`--skel`／`--skel-hi` 的 `shimmer` 漸層）呈現。
- **結案流程中**：第 6 區塊**置頂**展開可編輯，其餘五塊全部收合成單行（標題 ＋ tag ＋ 展開箭頭）；置頂列只說「已進入結案流程」。
  ⚠️ **不在此處解釋「為什麼其他區塊收合了」** —— 收合與還原是可預期的模式切換，不需要每次結案都說明一次（畫布 2b 的裁示）。
- **展開態（一般狀態）**：**五個**區塊，皆可各自獨立展開／收合。**沒有結案摘要區塊。**
- **五塊的來回**（畫布行為，⛔ **我方不實作** —— `DESIGN_FEEDBACK.md` C-37）：
  按下結案時保存五塊的展開組合與捲動位置（畫布原始碼的 `this.saved = { open, scroll }`）；
  **取消結案與寫入成功都原樣還原**，並隱藏第 6 區塊。結案面板本身一律從頂端開始捲（`scrollTop = 0`）。
  ⚠️ **我方的第 6 區塊以 `v-if` 切換版面，其餘四塊在進入結案時會被卸載重掛** ——
  內部狀態不是「被覆蓋」而是「不存在了」，因此還原不了。要做得先把各塊的展開狀態
  提到頁面層集中管理。
  ⚠️ 2026-09-08 前 `useCopilotPanel()` 裡有一套看起來在做這件事的機制
  （`PanelSavedLayout`／`saved`／`scrollTop`／`rememberOpenState()`），
  但**沒有任何呼叫端**，`saved.open` 恆為 `{}`、`scroll` 恆為 0 ——
  一份從未生效過的契約，已整段移除。要補做時 MUST 連同呼叫端一起加。

> ⚠️ **折疊的無障礙屬性是逐字規格**：標題列是 `role="button"` ＋ `tabIndex` ＋ `aria-expanded`
> ＋ `outline-offset:-2px` ＋ `style-focus="background:var(--surface-2)"`，不是純 `<div>` 加 onClick。

---

### 7.5 涵蓋範圍選擇器（2b）

> 只存在於結案流程中。行為規格見 `specs/006-closure-handoff-summary` FR-021 系列；
> 本節是①的逐字擷取（元件 `CopilotPanel.dc.html`，`scopeStyle`／`scopeState` 兩個 prop）。

**它在回答什麼**：同一個聊天室長期存在、可能被結案多次，系統無法判斷「本次結案從哪算起」，
因此由客服選。此選擇決定 AI 讀哪些訊息，**改動即重新產生摘要**。預設已選「最近一次結案且
則數 > 0」，多數情況可直接略過。

#### 第 6 區塊的容器

> ⚠️ **文案、內容順序與按鈕六種組合見 §7.2 ⑥ —— 此處只補它沒寫的視覺尺寸。**
> 兩處都寫一遍就會有兩處要維護，而過期的那一處看起來和正確的一樣可信。

| 部位 | 規格 |
|---|---|
| 區塊 | `order:1`（置頂）、`--surface` 底、`1px solid --border`、radius 12px、`--shadow`、`overflow:hidden` |
| 標題列 | `role="button"` ＋ `aria-expanded`、padding 11px 12px、focus 時 `--surface-2`。**⚠️ 本區塊自己也可收合**，chevron 在**最左邊**（14px `--text-3`） |
| 標題徽章 | `--navy` 底 ＋ `--navy-fg` 字、0.8438rem／**700**、padding 3px 9px、radius 5px |
| 右側註記 | 0.8125rem `--text-3`，與徽章之間由 `flex:1` 撐開 |
| 內容區 | padding 0 12px 12px、`flex-col gap:10px` |
| 過期提示 | `--open-bg` 底 ＋ `1px solid --open-bg`（⚠️ 框線與底色同色）、radius 7px、padding 7px 9px、`clock-alert` 13px `--open`、文字 0.875rem `--open` |
| 草稿時間戳 | 「草稿產生於 」為一般字體，**其後的 `HH:MM:SS` 是 mono** —— 只有時間換字體 |

#### 三種呈現風格（`scopeStyle`）

> ⛔ **我方只出貨 `row`**（`DESIGN_FEEDBACK.md` C-38）。另外兩種在本期沒有畫面用得到。
> ⚠️ 2026-09-08 前元件上有一個接受三個值的 prop，但唯一的呼叫端從來沒傳過它 ——
> 傳 `quiet` 的人會拿到 `row` 的樣子且不報錯。該 prop 已移除；
> 要補另外兩種時 MUST 連同呼叫端一起加回來。

| 值 | 樣子 |
|---|---|
| `quiet` | 一行：`calendar-clock` 13px ＋ 涵蓋說明（0.875rem `--text-2`）＋ 底線連結「變更範圍」（`--navy-2`） |
| `row`（預設） | 一顆**有框有底的按鈕**：`1px solid --border-strong` ＋ `--surface-2` 底 ＋ radius 8px ＋ padding 7px 9px ＋ hover `--surface-3`；內容為 `calendar-clock` 14px `--text-3` ＋「涵蓋範圍」0.8438rem `--text-3` ＋ `{起點} · {N} 則`（0.9063rem `--text` mono、過長 ellipsis）＋ chevron 14px |
| `list` | 清單常開，標題「本次結案涵蓋範圍」（0.9063rem／500）＋ 右側副標「決定 AI 讀哪些訊息」（0.8125rem `--text-3`） |

⚠️ 選擇器的外層是 `flex-col gap:7px`，**沒有**自己的邊框或底色 —— 有框的是 `row` 的那顆按鈕。

#### 候選清單（`role="radiogroup"`，`aria-label="本次結案涵蓋範圍"`）

畫布的示範值：

| `t`（起點） | `label` | `n` |
|---|---|---|
| `9/2 14:30` | 上次結案 · 分類：發票補寄（agent.lin@company.com） | 25 |
| `9/1 09:12` | 上次結案 · 分類：帳單金額疑義（agent.chen@company.com） | 112 |
| `8/14 11:05` | 上次結案 · 分類：會員資料變更（agent.lin@company.com） | 203 |
| `第一則對話` | 自 2026/03/06 首次進線起算 · 完整對話 | 398 |

⚠️ **安全網那一列的起點逐字是「第一則對話」，不是時間戳** —— 客服要的是「這是完整對話」
這個語意，不是那一則訊息剛好幾點幾分。時間降冪，安全網（`fallback:true`）**永遠墊底**。

**每一列是兩行**（`role="radio"` ＋ `aria-checked` ＋ `tabIndex`）：

```
外層  flex align-items:flex-start gap:8px  padding:7px 9px  radius:8px
      border:1px {bdStyle} {bd}   background:{bg}
  ├ icon 14×14  margin-top:2px  color:{iconColor}
  └ flex:1 flex-col gap:2px
      ├ 第一行  flex align-items:baseline gap:8px
      │    {t}      0.9063rem / 500 / mono / {tColor}
      │    (flex:1 撐開)
      │    {n} 則   0.8438rem / mono / {nColor} / flex:none   ← 右對齊
      └ 第二行  {label}  0.8438rem  --text-3  line-height:1.55
```

⚠️ **則數靠右、與起點分行**。把 `{t} 起 · {n} 則` 併成一段文字會讓則數散在每列不同的
水平位置，客服要比較份量時得逐列找數字。

| 狀態 | 框線 | 底色 | icon | icon 色 | 起點色 | 則數色 |
|---|---|---|---|---|---|---|
| 選中 | `--navy` solid | `--navy-soft` | `circle-dot` | `--navy-2` | `--text` | 見下 |
| 未選（一般） | `--border` solid | `--surface` | `circle` | `--text-3` | `--text` | 見下 |
| 未選（安全網） | `--border-dash` **dashed** | `--surface` | `circle` | `--text-3` | `--text` | 見下 |
| 0 則（不可選） | `--border` solid | `--surface-3` | `circle-slash-2` | `--text-3` | `--text-3` | `--text-3` |

則數色：0 則 `--text-3`；**> 150 為 `--warn`**（讓客服在選之前就看得出份量）；其餘 `--text-2`。

- **預設選中「最上面則數 > 0」的那一列**（`list.findIndex(x => x.n > 0)`），全為 0 則落到安全網。
- **0 則不可選**：`cursor:not-allowed` ＋ `tabIndex:-1`（鍵盤跳過），`pickScope()` 內另有一道 `if (n === 0) return`。
- 鍵盤：Enter／Space／Spacebar 皆觸發（`e.preventDefault()`）。

#### 唯讀涵蓋說明（不可省）

`check` icon 12×12 `--text-3` ＋ 文字 0.8438rem `--text-2`（`quiet` 風格為 0.875rem）。逐字：

- 一般：「**本次摘要涵蓋 {t} 起 · {n} 則**」
- 安全網：「**本次摘要涵蓋 第一則對話起 · {n} 則**」

⚠️ **它的位置是選擇器容器內的最後一項** —— 清單展開時它在**候選清單下方**，不是標題列下方。
⚠️ 選錯區間**不會有任何錯誤提示**，這一行是事後唯一的憑據。

#### 四種選擇器狀態（`scopeState`）

`never`／`overflow`／`zeroTop` 三者會**自動展開清單**（`autoOpen`），確保客服看見那件事。

| 值 | 行為與逐字 |
|---|---|
| `never` 從未結案過 | 無候選，只有安全網。提示為**有框的告知卡**：`--navy-soft` 底 ＋ `1px solid --navy-soft-bd` ＋ radius 7px ＋ padding 7px 9px ＋ `info` 13px `--navy-2`；文字 0.875rem `--text-2`，逐字「這則對話從未被結案，預設**從第一則起算**。若只想涵蓋某段時間，可自訂起算時間。」（「從第一則起算」以 `--text`／500 強調） |
| `overflow` 候選超過 5 個 | 只列最近 5 次。提示**無底色無框**（padding 2px 2px 0）、`ellipsis` 13px `--text-3`；文字 0.8438rem `--text-3`，逐字「另有 3 個更早的結案起點未列出（僅顯示最近 5 次）。需要更早的區間請用**自訂起算時間**。」（後四字以 `--navy-2` 強調） |
| `zeroTop` 最上候選 0 則 | 示範 label 逐字：「林佩君已於 11:20 結案 · 此後尚無新訊息」，`n:0`。該列不可選，預設自動落到下一個。⚠️ **2026-09-08 版起有一句提示**（先前沒有）：與 `overflow` 同一種**無框旁注**（`info` 13px `--text-3` ＋ padding 0 2px 2px），文字 0.8438rem **`--text-2`**，逐字「最近一次結案之後尚無新訊息，已自動改選下一個起點。」⚠️ 我方實作目前整行都用 `--text-3`，**待照畫布改為 `--text-2`**（尚未改） |
| `regen` 改了選擇 | 見下 |

#### `regen`（改了選擇、正在重新產生）

三件事同時發生：

1. **提示卡**：位置在**選擇器容器之外**、摘要 textarea 之前。`--navy-soft` 底 ＋
   `1px solid --navy-soft-bd` ＋ radius 7px ＋ padding 7px 9px；旋轉的 `loader-2`
   13px `--navy-2`（`animation:spin 1s linear infinite`）＋ 文字 0.875rem `--text-2`。逐字兩種：
   - 安全網：「涵蓋範圍已改為**第一則對話起**（398 則），正在重新產生摘要…」
   - 一般：「涵蓋範圍已改為 {t} 起（{n} 則），正在重新產生摘要…」

   ⚠️ **兩者的空格不同**：安全網版「已改為」後**不空格**（「已改為第一則對話起」），
   一般版空格（「已改為 9/2 14:30 起」）。
2. **整組人審欄位不存在** —— ⚠️ 2026-09-08 版起 `sumBody = !firstGen && !regen`，
   重算期間摘要正文與所有欄位都不渲染。畫布的說明卡逐字加註「舊內容不留半透明殘影，
   避免被誤讀成還可編輯」。
   ⚠️ **舊版畫布是「摘要 textarea `opacity:0.45`、其餘欄位不變」** —— 該做法與我方契約
   R2.2（發請求前先清空草稿）不能同時成立，且淡出範圍比實際被替換的範圍小，
   已由 Design 於 2026-09-08 移除。看到任何文件仍在講「淡出」的，都是過期敘述。
3. **按鈕列收成單一忙碌鍵**：一顆 `flex:1` 的 disabled 灰鍵 —— `1px solid --border` ＋
   `--surface-3` 底 ＋ `--text-3` 字 ＋ radius 7px ＋ height 30px ＋ `cursor:not-allowed`，
   內容為旋轉 `loader-2` 13px ＋「重新產生中，請稍候」。⚠️ **不是** primary 色。

#### 自訂起算時間

**不限於 `never` 狀態，任何時候都可用。** 是一顆與候選列同一視覺家族的整列按鈕
（`aria-expanded` ＋ `aria-haspopup="dialog"`）：

| 部位 | 規格 |
|---|---|
| 尺寸 | height 28px、padding 0 9px、radius 7px、hover `--surface-3` |
| 框線 | 已套用 `1px solid --navy`／未用 `1px dashed --border-dash` |
| 底色 | 已套用 `--navy-soft`／未用 `--surface-2` |
| 內容 | `calendar-plus` 13px `--text-3` ＋「自訂起算時間」0.8438rem `--text-3` ＋ 右對齊的 `customLabel` 0.8438rem mono |
| `customLabel` | 未用「未使用」（`--text-3`）／已用「{t} · 已套用」（`--navy-2`） |

展開為 `role="dialog"` ＋ `aria-label="自訂起算時間"` 的彈窗（Esc 關閉，`stopPropagation`）：
月曆（上／下月，超出範圍 `opacity:0.4` ＋ `cursor:not-allowed`；選中日 `--navy` 框 ＋
`--navy-soft` 底 ＋ `--navy-2` 字 ＋ 700）＋ 時／分輸入
＋ 一行「可選範圍：`2026/03/06`（首次進線）至今」＋「取消」／「以此起算並重新產生」
（後者 `flex:1`、height 28px、`--navy` 底、hover `--navy-2`）。

⚠️ **2026-09-08 版起彈窗裡沒有「約 N 則」預估**（舊版的 `customEst` 已移除）——
實際則數由套用後的涵蓋說明呈現。✅ 2b「B1 從未結案過」的說明卡也已同步刪掉該描述（舊 `DESIGN_FEEDBACK.md` D-4，已結清）。

⚠️ 自訂起點的 `label` 逐字為「**自訂起算時間（非結案起點）**」—— 誠實標示它不對應任何真實的結案事件。

#### 收合行為（容易漏掉）

- **選了任一候選、或套用自訂時間之後，清單自動收合**（`scopeOpen:false` ＋ `scopeShut:true`）。
  畫布 B4 呈現的就是這個收合態 —— 它不是 `regen` 造成的，是「選了」造成的。
- `scopeShut` 一旦為真，`autoOpen` 不再把清單拉開 —— 客服自己收起來的東西不該又彈開。

---

## 8. 1c — 主工作區

> 10 個狀態變體**全部參數化在同一個 1c section 裡**，不是各自獨立的 artboard——
> 畫布上有 8 個切換鈕：「切換左欄收合」「切換撞單警示」「切換接手狀態」「切換面板收合」
> 「B1 摘要過期」「B2 同事視角」「B3 寫入中」「C1 離開失敗」。

### 8.1 版面

| 區域 | 尺寸 |
|---|---|
| Artboard 全寬 | 1440px |
| **頂列（全寬）** | **`height:48px`／`flex:none`／`--surface` 底／`border-bottom:1px solid --border`／`padding:0 14px`／`gap:12px`**（見下方「頂列」） |
| 左欄（對話清單）展開 | **預設 280px，可拖曳 220–400px** |
| 左欄收合 | **48px** 窄直條 |
| 右欄（Copilot 面板）展開 | **預設 420px，可拖曳 320–720px**（與 §7.1 同一個值） |
| 右欄收合 | **44px** 窄直條 |
| 中欄 | 剩餘空間（`min-width:0`，可壓縮） |

> ⚠️ **兩欄的拖曳範圍在畫布的 script 裡是逐字寫死的**，不是示意：
> `startDragLeft` → `Math.min(400, Math.max(220, …))`、`startDrag` → `Math.min(720, Math.max(320, …))`。
>
> ⚠️ 收合寬度左 **48px**／右 **44px** 不對稱，是因為左欄要放按鈕＋徽記、右欄要放直排 `COPILOT` 標籤。

**頂列**（`1c-workspace` 的第一個子元素，由左至右）：

| 位置 | 內容（逐字） |
|---|---|
| 左 | eyebrow 徽章「AGENTCOPILOT」：`--navy` 底／`--navy-fg` 字／`0.8125rem`／`700`／`letter-spacing:.07em`／`padding:4px 8px`／`radius:5px` |
| 左 · 接續 | 組織名 `building-2` 13px ＋「台灣客服中心」＋ `chevron-down` 13px（`--text-3`），`0.9063rem`／`--text-2`，整組前面一條 `border-left:1px solid var(--border)` ＋ `padding-left:12px` |
| — | `flex:1` 彈性空白 |
| 右 | 連線 pill「**已連線**」：`--active` 6px 圓點 ＋ `--surface-2` 底 ＋ `1px solid var(--border)` ＋ `padding:4px 9px` ＋ `radius:20px` ＋ `0.875rem`／`--text-2` |
| 右 | **主題切換鈕**（⚠️ 2026-09-08 17:03 版新增，規格見下） |
| 右 | 帳號頭像 `28×28` 圓鈕，整組帶 **`margin-left:-2px`** ＋ `border-left:1px solid var(--border)` ＋ `padding-left:10px`（下拉見 §8.2） |

⚠️ **那個 `margin-left:-2px` 不是微調，是分隔線兩側各 10px 的做法**（2026-09-08 17:03 版定案）：
頂列的 `gap` 是 12px，負 margin 把分隔線左側從 12 拉回 10，`padding-left` 給右側 10。
**不要改成把整排的 `gap` 調成 10px** —— 看起來一樣，但那會把「連線 pill ↔ 主題鈕」
也一起縮掉 2px，而那一段畫布仍是 12px。

⚠️ **「已連線」後面已經沒有「· 即時同步」了** —— 畫布全檔僅存兩處「已連線」（1c 與 1d），
兩處都是短的那個。舊敘述「1d 比 1c 少了『· 即時同步』」已作廢，不要再拿它當實作依據。

**主題切換鈕**（⚠️ 2026-09-08 17:03 版新增，`toggleTheme`）：

| 面向 | 逐字規格 |
|---|---|
| 尺寸／樣式 | `width:28px; height:28px; flex:none`／`1px solid var(--border)`／`background:var(--surface-2)`／**`border-radius:7px`**／`color:var(--text-2)`／`padding:0`／`cursor:pointer`；hover 轉 `background:var(--surface-3); color:var(--text)` |
| icon | inline `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`，單一 `<path>` |
| 淺色時的 `d`（月亮） | `M20.5 14.8A8.5 8.5 0 1 1 9.2 3.5a6.8 6.8 0 0 0 11.3 11.3z` |
| 深色時的 `d`（太陽） | `M12 3v1.5M12 19.5V21M4.2 4.2l1.1 1.1M18.7 18.7l1.1 1.1M3 12h1.5M19.5 12H21M4.2 19.8l1.1-1.1M18.7 5.3l1.1-1.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0` |
| `title`／`aria-label` | 同一句：淺色時「切換為**深**色主題」、深色時「切換為**淺**色主題」 |
| `aria-pressed` | 目前是否為深色 |

> ⚠️ **icon 畫的是「按下去會變成什麼」，不是「現在是什麼」** —— 淺色時顯示月亮。
> 反過來做不會有任何錯誤訊息，只會讓每個使用者按錯一次。
>
> ⚠️ **`radius:7px` 的方角圓，不是頭像那種正圓** —— 它旁邊 6px 就是 `radius:50%` 的頭像，
> 兩顆都做成正圓會讓頂列右上角看起來是兩個帳號。
>
> ⚠️ **位置在連線 pill 之後、頭像那條 `border-left` 之前** ——
> 它不在頭像那一組裡。主題是畫面偏好，不是身分，那條分隔線兩邊是兩件事。
>
> ⚠️ **只有 1c 有這顆鈕**：1d 的骨架頂列沒有（載入中還沒有東西可切），1a／1b 也沒有。
>
> ⚠️ **畫布只有 light／dark 兩態，`toggleTheme` 就是二擇一互換** ——
> 沒有文字標籤、沒有下拉、**沒有「跟隨系統」第三態**。
>
> ⚠️ **畫布沒有回答兩件事，兩者都是實作決策**：① 重新整理後記不記得上次的選擇；
> ② 首次進入時預設哪一個（畫布的 `theme` 預設 `light`，但那是畫板的預設塗色，
> 不等於產品要無視作業系統偏好）。**2026-09-08 使用者裁示：① 記得、② 固定 `light`。**
> 兩者都落在 `nuxt.config.ts` 的 `colorMode`，持久化由 `@nuxtjs/color-mode` 的
> `localStorage['nuxt-color-mode']` 承擔，我方不另外存。
>
> ⚠️ **`preference: 'light'` 是刻意覆寫，不是抄預設值** —— 模組預設是 `'system'`，
> 留著會讓裁示②在深色系統上靜默失效（淺色系統的開發機永遠測不出差別）。
>
> ⚠️ 切換時 MUST 寫 `colorMode.preference`，**不是 `colorMode.value`** ——
> 後者只改當下畫面、不進 localStorage，症狀只有「重新整理後主題自己跳回去」。
> 兩者型別相同、都不會報錯。守衛見 `test/theme-toggle.test.ts`。
>
> ⚠️ 畫布用 `[data-theme="dark"]`，實作用 `.dark`（理由見 §0）——
> 這顆鈕切的是 class，不是 attribute。

**拖曳把手**（逐字）—— 共三條，欄間兩條與**輸入框上方一條**：

| 位置 | 尺寸 | cursor | `aria-orientation` | 鍵盤 |
|---|---|---|---|---|
| 左／中欄之間、中／右欄之間 | `width:5px`，握把短線 `1×26px` | `col-resize` | `vertical` | ←／→ 每次 16px、Shift 64px |
| **輸入框上方**（⚠️ 2026-09-01 新增） | `height:6px`，握把短線 `26×1px` | `row-resize` | `horizontal` | ↑／↓ 每次 12px、Shift 48px |

共通：`background:var(--border)`、握把短線 `--border-strong`、`role="separator"` ＋ `tabIndex` ＋
`aria-valuenow/min/max`、hover 與 focus 轉 `--navy-2`（focus 另加 `box-shadow:0 0 0 2px var(--navy-soft)`）。

- 欄寬 `title="拖曳，或聚焦後用 ←／→、Home／End 調整寬度"`
- 輸入框高度 `title="拖曳，或聚焦後用 ↑／↓、Home／End 調整輸入框高度"`，畫布範圍 **72–320px（預設 72）**；
  ⚠️ 我方下限改為 **46px（一行）**，預設仍 72 —— 小螢幕筆電上兩行的下限會把訊息流壓得看不到幾則（見 `DESIGN_FEEDBACK.md`）。
  未接手時退回一條 1px 的 `--border` 線（沒有輸入框可調，留一個調不動的把手只會讓人以為壞了）

⚠️ 三條共用同一個 `ConversationResizeHandle` 元件與 `usePaneSize()`。
**不要因為軸向不同而另寫一份 markup** —— 底色寫在 inline `:style` 上，
而 inline style 的優先權高於任何 class，另寫一份時 `hover:` utility 會被靜默蓋掉（已發生過一次）。

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

> ⚠️ **頂列不屬於左欄，規格已移到 §8.1「頂列」**（徽章／組織名／連線 pill／主題切換鈕／頭像）。
> 這裡只留頭像下拉的內容 —— 它是左欄寬度以外的東西，但與頂列同一顆按鈕。

- 頂列右上角的頭像：**28px 圓形**（`--navy-soft` 底／`--navy-soft-bd` 框／`--navy-2` 字／
  mono 縮寫如「AG」／`aria-haspopup="menu"`），**沒有姓名文字、沒有 chevron**。
  ⚠️ 它**不再是右上角唯一的東西** —— 左邊那條分隔線（兩側各 10px）外還有一顆主題切換鈕（§8.1）。
  下拉（`236px` 寬／`radius:9px`／`box-shadow:0 8px 24px rgba(16,24,40,.14)`／`top:34px`）由上到下：
  eyebrow「**已登入身分**」＋ email（mono）→ 分隔線 → 「登出」（`role="menuitem"`）。
  email 為 mono、`0.875rem`／`--text`／`white-space:normal; word-break:break-all; line-height:1.55`（不截斷）
- 篩選 chip（五顆，`0.8438rem`／`line-height:1.35`／`padding:4px 9px`／`radius:20px`／`gap:5px`）：
  「全部 19」／「● active 15」／「● open 4」／「[icon] web 15」／「[icon] line 4」。
  ⚠️ **數字是 mono**，未選中時比標籤深一階（標籤 `--text-2`、數字 `--text`）；選中的那顆整顆 `--navy` 底白字。
- 分組標題：「今天」／「昨天」（更早的用 `MM/DD`）。
  `position:sticky; top:0`／`--surface-2` 底／`border-bottom:1px solid var(--border)`
  （「昨天」以下每一組還多一條 `border-top`）／`padding:3px 6px 3px 12px`／
  `display:flex; align-items:center; gap:8px`／`z-index:1`
  - 標題文字：`0.7813rem`（12.5px）／`font-weight:700`／`letter-spacing:.08em`／`--text-3`
    （⚠️ 舊值 `10px` 是 2026-09-01 全面改 `rem` 之前的數字，已作廢。⚠️ **不要沿用
    `.ac-status-label` 的 `0.8125rem`** —— 實作曾因為本文件記著 `10px` 而長成 13px，
    2026-09-08 已對齊為 `0.78125rem`）
  - **右端收合鈕**（⚠️ **2026-08-31 新增**）：`20×20`／**無邊框**／**透明底**／`border-radius:5px`／
    `--text-3`，**hover 才浮出** `--surface-3` 底 ＋ `--text-2` 字；
    icon `chevron-up`（展開中，按了收合）／`chevron-down`（已收合，按了展開），13px。
    `title` 逐字「收合此日期區間」／「展開此日期區間」，
    `aria-label`「收合{日期}的對話」／「展開{日期}的對話」，並帶 `aria-expanded`。
    收合時**該組所有列項整批不顯示**。

  > ⚠️ 收合狀態的識別 MUST 用**日期本身**，不可用顯示文字 —— 「今天」那一組明天就叫「昨天」，
  > 用文字當 key 的話收合狀態會留在「今天」這個位置上，而不是跟著那批對話走。
  >
  > ⚠️ 實作**多顯示一個該組的對話數**（收合時才出現，舊 `DESIGN_FEEDBACK.md` C-8，已結清）——
  > 收起來之後那批對話從畫面上消失，只剩一個箭頭的話這一列等於在說「這裡什麼都沒有」。
- 列項：**兩行**（⚠️ **2026-09-01 畫布改版，整個第二行都換掉了**）

  | 行 | 內容（由左至右） |
  |---|---|
  | 第一行 | `30px` 圓形頭像縮寫（mono `0.7813rem`／`700`）＋ 代號（`TWN#GW4772`，mono `0.9375rem`）＋ **status 圓點**（`6px`，`--active`／`--open`，帶 `title`）＋ 彈性空白 ＋ 時間（mono `0.8125rem`／`--text-3`／絕對時間 `14:32`） |
  | 第二行 | 頻道 icon（`13px`）＋ **presence 標記**（icon `12px` ＋ 文字 `0.8125rem`，`line-height:1`）＋ 彈性空白 ＋ **未讀**（`7px` `--navy` 圓點 ＋ 逐字「未讀」，`--navy-2`） |
  ⚠️ 所有 icon 都帶 `display:block; align-self:center` —— 少了它會被基線對齊頂高半個字。

  - **presence 標記兩態**，逐字（⚠️ 畫布 2026-09-01 已由三態改為兩態，與實作一致）：
    「你在此對話中」（`user-check`／`--navy-2`）／
    「有客服在此」（`eye`／`--text-2`）；兩者皆不成立時**留白**
  - **「結案未完成」**（`clipboard-check` ＋ 虛線 `--navy-soft-bd` 框的 pill）出現在**第二行右端**，
    標記結案中途離開的對話
  - ⚠️ **未讀在第二行右端，不在第一行** —— 第一行是這則對話的身分（代號 · status · 時間），
    第二行是它此刻的狀態。舊版畫布把未讀畫成第一行的數字徽記，已撤銷。
  - ⛔ **舊版畫布的「最後一則訊息摘要」（前綴「AI：」「客戶：」「我：」）已從畫布移除**，
    第二行改為頻道 ＋ presence。實作本來就做不到那個摘要（清單 payload 沒有訊息文字或發送者，
    要顯示就得對每一列各打一次訊息 API，見 `DESIGN_FEEDBACK.md` B-1），現在畫布與實作一致。

  > **為什麼只有兩態**（畫布已採納，此處保留證據供日後重新核對時不必重跑）。
  > 實測：`npm run spike:join-visibility`（16 筆，`scripts/spike/out/23-*.json`）——
  >
  > - ✅ **「你在此對話中」做得到，但不是免費的**：清單 payload **完全沒有 `is_joined`**
  >   （實測 0/16），也沒有「只列出我 JOIN 的」端點（D-23f）。實作改為在 BFF 端對
  >   **候選集合**（`mode ∈ {manual, hybrid}`）補查詳情並快取，穩定狀態 0 次額外呼叫 ——
  >   完整的成本模型與兩個已知盲區見 §10.2.1a 與 `server/services/viewer-joined.ts`。
  > - ❌ **「無客服在此」證明不了**：`mode` 為 `automation`／`null` 時「沒人」與
  >   「有人但選了 Automation Only（唯讀觀察）」是同一個值（§10.2）。
  >   也不能改用 `is_agent_joined` 補 —— 實測 LEAVE 後它仍是 `true`（16 筆裡**沒有任何一筆是 `false`**），
  >   它代表「曾經有人 JOIN 過」而非「現在有人」。
  > - ❌ **「`{email}` 在此」拿不到**：清單 payload 沒有參與者身分（`users[]` 是團隊名冊）。
  >   因此第二態的措辭是「有**客服**」而不是「有**同事**」—— 它同時涵蓋
  >   「`viewerJoined` 這一輪還沒解析出來」的情況，那時裡面的人也可能是你自己。
  >
  > **「結案未完成」屬 M3**，結案流程存在之後才有東西可標。
- **底部統計列**：`flex:none` 的固定 footer，**在捲動區之外**
  （`border-top:1px solid var(--border)`／`padding:7px 12px`／`justify-content:space-between`）——
  左「顯示 7 / 24」（mono）、右「依最新訊息排序」。
  ⚠️ 放進捲動區會讓它跟著清單捲走，而客服要確認「我看到的是不是全部」的時機，
  通常正是已經捲到一半的時候。
  ⛔ 「載入更多對話…」畫布是 spinner 自動載入列，**實作維持可按的按鈕**（偏離 C-28），
  且它留在捲動區內（它是清單的延續）。

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

**標題列** meta 列：`conv_8f21c0 · 建立於 08/25 13:58 · 已載入 120 則`

⚠️ 尾端的則數在 2026-09-01 當日先被畫布拿掉、又加了回來，**現行版本是有的**，
且採用我方的措辭（`msgCountLabel`：未載完顯示「已載入 N 則」、載完才說「訊息 N 則」）——
平台的訊息 API 只回一頁 ＋ `hasMore`，給不出總數。
⚠️ **收合態那一列也有同一欄**（mono／`--text-3`），兩處共用同一個計算來源。

| 狀態 | 標題列內容 |
|---|---|
| 未接手 | 「接手對話」＋下拉，兩個選項寫**後果**不寫模式名：「接手並停用 AI 自動回覆／之後由我回覆，AI 不再自動發話」「接手但保留 AI 自動回覆／AI 繼續自動回覆，我可隨時插話」 |
| 已接手 | 「離開對話」（次要）＋「結案」（primary）＋輔助說明「離開＝僅退出不寫入 · 結案＝產生摘要供確認後寫入」 |
| 結案中 | 「取消結案」＋「結案中…」＋輔助說明「取消結案＝回到已接手狀態，不會留下任何紀錄」 |

> ⚠️ **中欄被擠窄時的行為畫布不涵蓋，由實作自訂 —— 這不是落差，不要「訂正」回畫布。**
> 畫布是固定寬度的畫板；我方的中欄是 `flex-1`，左欄可拉到 400px、右欄可拉到 720px，
> 兩邊拉滿時只剩幾百 px，而「取消結案 ＋ 結案中…」正是這一列最寬的一組按鈕。
> 規則兩層：**展開態**擠不下時整組按鈕 `flex-wrap` 換到第二行（仍靠右，與輔助說明對齊）
> ＋ 資訊區 `min-w-0 flex-auto overflow-hidden` 兜底；
> **收合態**是 38px 固定單列、沒有垂直空間，因此改為依優先序讓資訊消失
> （container query：則數 → presence → 頻道 → status，模式與主要動作永不消失）。
> ⚠️ 兩態都**不可讓按鈕被裁或溢出** —— 溢出到右欄不是 z-index 問題，是繪製順序，
> 調 z-index 不會修好（理由寫在 `HeaderCollapsed.vue` 檔頭）。
> ⚠️ 這個 bug 展開態與收合態各發生過一次（2026-09-01、2026-09-07），
> 守衛在 `test/header-overflow-guard.test.ts`。

**服務模式**是**獨立的第二層資訊列**，不是標題列的一部分：
畫布把它畫成自己的區塊（`--surface` 底／`padding:8px 14px`／
**自己的 `border-bottom:1px solid var(--border)`**），
對話標頭（`padding:9px 14px`）另有一條 —— 展開態因此共有**三條**橫線
（標頭下、服務模式下、Presence 列下）。

> ⚠️ **標頭與服務模式之間那條線不可省。** 兩段包在同一個容器裡只留最外面一條時，
> 「接手／離開／結案」與「切換服務模式」看起來會像同一組控制項 —— 而它們的後果差很遠：
> 前者只影響我，後者是整個對話的共用設定（§10.6）。2026-09-01 由使用者在畫面上發現。

分段控制項：「全真人」／「協作」／「全自動（唯讀）」
＋ 說明「模式是這個對話的共用設定，切換會影響所有人。」
結案中轉唯讀，提示「結案中無法切換服務模式，請先取消結案」

**Presence 列**「在此對話中」：
- 無人：「**沒有偵測到其他人**」
- 同事正在結案：頭像 ＋ email ＋ 標籤「正在結案」（`--navy-2` 字／`--navy-soft` 底／
  `--navy-soft-bd` 框／`radius:20px`／`clipboard-check` icon）＋「你仍可回覆或自行結案」
- 自己：「你正在檢視」
- 右側：「最後更新 14:32:11」

**訊息流**：頂端「載入較早的訊息」（⚠️ 2026-09-01 畫布已拿掉「305 則」）／日期分隔「08/25（今天）」
發送者三種：「客戶」／「AI 自動回覆」／「`agent.lin@company.com` · 真人客服 · 你」（自己的訊息才有「· 你」）

每一列是 `display:flex` 橫列（`gap:8px`／`padding:5px 16px`），內容欄 `max-width:62%`：
- **只有客戶那一側有頭像** —— `26×26` 圓、`--surface-3` 底 ＋ `--border` 框 ＋ `--text-2` 字、
  9px/700 等寬、`margin-top:14px`（對齊泡泡第一行）。同一位客戶的**續列**（純附件、輸入中）
  改放 `width:26px` 的空白佔位，讓泡泡的左緣對齊。
  AI／真人客服那一側整列 `justify-content:flex-end`，**沒有頭像**。
- 泡泡外框：客戶與真人客服都是**均勻的 1px 外框**；
  ⚠️ **`border-left:3px solid var(--ai)` 是 AI 專屬的標記**，客戶泡泡沒有這條色條。
- 泡泡圓角：**四角一律 `9px`**（三種發送者與 1d 骨架泡泡皆同，沒有尖角）。
  ✅ **AI 泡泡不再淡化** —— 畫布 2026-08-31 起已移除整顆的 `opacity:.82`，文字色也由
  `--text-2` 改為 `--text`。實作四項全部用原色 token（`--ai-bg`／`--ai-bd`／`--ai`／`--text`），
  與畫布一致，這裡**不再有偏離**。
  ⚠️ **不要把淡化加回來。** 先前實作用的「逐項混色」是為了在畫布仍套 `opacity` 時還能過
  WCAG AA 的補償措施（`--text-2` 疊在 `--ai-bg` 上經 `.82` 之後淺色只剩 3.74:1，內文需 ≥ 4.5），
  畫布拿掉 `opacity` 之後那層補償就沒有存在理由了。若日後想表達「AI 的份量較輕」，
  用色條或徽章，不要用 `opacity` —— 它會連泡泡裡的附件卡與「下載」連結一起壓低對比。
  理由詳見 `MessageBubble.vue` 的註解。

> ⚠️ **泡泡幾何不再區分發送者**（畫布曾以三個不同位置的直角區分，已全部撤銷為均勻 `9px`）。
> 這移掉了一個區分維度，剩下的必須夠用：客戶靠**左右對齊 ＋ 只有客戶側有頭像**；
> AI 與真人客服都靠右、只差底色，靠 AI 的 **3px `--ai` 左側色條**與泡泡上方的
> **文字徽章**（「AI 自動回覆」vs 姓名＋「真人客服 · 你」）分辨。
> 憲法 8.1「資訊不可只靠顏色」因此仍成立，但現在是**文字**在扛，幾何已經不幫忙了。
- AI 訊息附 meta：`14:28:07 · 意圖 invoice_status · 信心 0.82`
- 附件：檔名 ＋ 說明 ＋「下載」。
  ✅ 1c 與 2a 區塊④的措辭已於 2026-09-01 統一為「PDF · 檔名僅供辨識，無法預覽」，
  先前「畫布自己不一致」的問題消失。實作採 §7.2 的**三型別版**（PDF／圖片／舊型附件）——
  它才分得出「PDF 有 url 可下載」與「舊型 file 連 url 都沒有」。
  ✅ **「客戶正在輸入…」已從畫布移除**（平台不提供客戶端輸入狀態，實作本來就沒做）。
- **撞單來源**的那一則訊息（畫布上是 AI 的訊息）標橘色的「14 秒前送出」，
  泡泡外加 `box-shadow:0 0 0 3px var(--warn-bg)`。
  ⚠️ **這個標籤掛在「害你被攔下的那一則」上，不是客服自己送的訊息**
  （畫布原始碼的 `<!-- ai after agent — 撞單來源 -->`）。兩者意思完全相反，容易判讀顛倒。

### 8.4 Composer 與撞單攔截

- **上方一條 6px 的高度把手**（⚠️ 2026-09-01 新增，取代原本 Composer 區塊的 `border-top`）——
  規格見 §8.1 的拖曳把手表
- 一般態：**上下兩列**的輸入區
  （`border:1px solid var(--border-strong)`／`--surface-2` 底／`radius:9px`／`overflow:hidden`）
  - 上：`textarea`，`height` 由把手決定（72–320px）、`resize:none`、無框、`padding:10px 12px`、
    `font-size:1rem`／`line-height:1.6`，placeholder 逐字「輸入回覆內容…（Enter 送出，Shift+Enter 換行）」
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
> ✅ 版面本身已於 2026-09-01 改為上下兩列，補按鈕時不必再重排。
- **未接手**：整個輸入區換成虛線提示框（`1px dashed var(--border-dash)`／`--surface-2` 底／
  `radius:9px`／`padding:14px`／`lock` 15px ＋「尚未接手此對話，無法輸入回覆。請先點右上角『接手對話』。」）。
  ⚠️ **不再另外渲染一個 disabled 的 textarea**（偏離 C-30：另兩種不能送出的情況仍保留輸入框）
- **送出鍵**：`30px` 高／`padding:0 14px`／`radius:7px`／`0.9688rem`／`500`。
  撞單時轉為 `--warn` 三色的「已攔截」（`lock` icon），**不是把主按鈕變灰**
- 結案中：橫幅「結案中 —— 摘要內容為按下結案當下的對話快照，不含此後的新訊息。送出新訊息後，可按「重新產生」把它納入摘要。」
  ⚠️ **Composer 維持可輸入** —— 畫布未對結案狀態做任何停用（唯一的 `disabled` 綁在撞單攔截）。
  ⚠️ 尾句於 2026-09-04 由「要送出訊息請先取消結案。」改來：原文與可用的 composer 矛盾，已請 Design 修正
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
| 訊息流載入中 | 「正在載入訊息…」（⚠️ 畫布已拿掉則數）／Composer「連線建立後才可輸入」 |
| 頂列 | 「台灣客服中心」／「已連線」（⚠️ 與 1c 逐字相同；畫布已無「· 即時同步」）。⚠️ **1d 的頂列右側既沒有主題切換鈕也沒有頭像**：`1d-loading` 只有一條 `--skel` 佔位條，`1d-empty` 只有裸的圓點＋文字（**連 pill 的底色與框都沒有**，與 1c 不同）。這是 1d 的簡化，不是漏畫 |
| 對話清單為空 | 「找不到符合的對話」／「客戶僅有代號，請輸入完整代號片段（例：GW4772）或清除篩選。」／按鈕「清除搜尋與篩選」 |
| 未選擇對話 | 「尚未選擇對話」／「從左側列表選擇一個對話開始處理。標記 ●&nbsp;active 的對話代表客戶正在等待回覆，建議優先處理。」／按鈕「處理最舊的 active 對話」（⚠️ 只有這一顆） |
| 右欄佔位 | 「選擇對話後提供輔助內容」／「面板內容於下一階段設計。」 |

⚠️ 最後一列是 **1d 自己的右欄佔位文字**，已由 §7 的 2a 取代——實作不應照抄這兩句。
骨架列數 `skelRows: [1,2,3,4,5,6]`（6 列）。

---

## 10. 3a — 語氣標籤色票

> 畫布 artboard `3a-light`／`3a-dark`（畫布最下方），**只有色票、沒有版面** ——
> 它存在的目的就是把建議卡的五種語氣一次定義清楚。

共用形狀：`font-size:0.8125rem`／`font-weight:500`／`border-radius:4px`／`padding:1px 6px`，
各帶一個 **10px** 的 lucide icon。

| 語氣 | fg | bg | bd | icon | 淺色對比 | 深色對比 |
|---|---|---|---|---|---|---|
| 致歉 | `--warn` | `--warn-bg` | `--warn-bd` | `heart-handshake` | 5.36:1 | 7.41:1 |
| 說明 | `--info` | `--navy-soft` | `--navy-soft-bd` | `info` | 8.98:1 | 8.17:1 |
| 挽留 | `--open` | `--open-bg` | `--open-bd` | `hand-heart` | 5.17:1 | 7.15:1 |
| 結案 | `--text-2` | `--surface-3` | `--border-strong` | `circle-check` | 5.38:1 | 5.94:1 |
| 升級 | `--danger` | `--danger-bg` | `--danger-bd` | `circle-arrow-up` | 6.46:1 | 6.84:1 |

> 對比欄是我方實算的（sRGB 相對亮度，文字 vs 該標籤自己的底色）。
> 標籤文字 `0.8125rem`（13px）屬**內文**，門檻是 AA 的 4.5:1 —— 十組全部通過。

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
// html 裡找 <section id="1a"|"1b"|"1c"|"1d"|"2a"|"2b"|"3a"> 或 data-screen-label 即可定位

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
> ⚠️ **`dc-import` 的元件內容就在 artifact 裡**（`CopilotPanel.dc.html`：2026-09-08 17:03 版解開後 **104 KB**，第 6 區塊與涵蓋範圍選擇器都在裡面，不在 `page.html`；`__bundler/template` 本身解開後約 **473 KB**，其中絕大部分是內嵌的 `@font-face`，先把 `@font-face { … }` 整批濾掉再讀，剩下約 143 KB 才是版面），
> **不需要向畫布擁有者索取任何檔案** —— repo 裡也不存在這個檔案，不要去找。

> ⚠️ **「怎麼擷取」有了，但真正會出事的是「什麼時候該重新擷取」** —— 有步驟卻沒有觸發時機，
> 就會退化成「應該沒事吧」的僥倖。觸發點見檔頭「重新核對時的三條紀律」第 2 條。

凍結時間點見檔頭。**距離該日期越久，動工前重新核對一次的必要性越高。**
