# AgentCopilot

iMBrace 客服平台的協作副駕。Nuxt 4（`ssr: false` + 完整 Nitro BFF）。

> **本檔只放「必須在 context 裡才有用」的東西。**
> 架構、實測結論、程式碼約束都有各自的正典檔案（見下方文件地圖），
> 此處**只指路、不重述** —— 多一個地方描述同一件事，就多一個會過期的地方。

## 文件地圖

| 檔案 | 是什麼的正典 |
|---|---|
| `docs/ARCHITECTURE.md` | 架構決策與**所有平台實測結論**。1600+ 行，用章節號索引 |
| `docs/CONSTITUTION.md` | 程式碼約束（九條憲法）＋命名慣例＋修憲流程。寫 code 前必讀。條號是穩定介面，程式碼註解直接引用 |
| `docs/IMBRACE_QUESTIONS.md` | 待向 iMBrace 確認的清單。⚠️ **唯一會離開這個 repo 的文件** |
| `docs/PLATFORM_CAPABILITY.md`、`docs/SDK_FINDINGS.md` | 平台能力與 SDK 的實測記錄 |
| `docs/DESIGN_TOKENS.md` | 設計規格。⚠️ 衍生自 Claude Design 畫布，可能與畫布脫鉤 |
| `scripts/spike/out/` | 實測原始產出。**結論有疑慮時以此為準，不以文件敘述為準** |

⚠️ **`docs/meeting-draft/` 底下的檔案（如會議草稿）一律不得被正典文件引用（檔名連結、`見 XXX.md`）。**
那個資料夾在 `.gitignore` 裡，只存在於本機，是開會前釐清思緒用的草稿，隨時會被推翻、變動。
正典文件若要引用其中的結論，**必須把結論本身寫進正典文件**（用自己的措辭重述），而不是連過去。
否則換一台機器、換一個協作者 clone 這個 repo 時，正典文件裡的連結會全部指向不存在的檔案——
這個問題已經在三份正典文件裡發生過一次，2026-08-26 才清乾淨。

## 溝通語言

- 與使用者的**對話輸出一律用繁體中文**：回報成果、說明、詢問問題、摘要都用繁體中文。
- 技術識別項照原文，不翻譯：程式碼、指令、檔名/路徑（`server/api/**`、`shared/types/copilot.ts`）、
  型別與欄位名（`mode`、`status`、`conversationId`、`teamConversationId`）、
  受控字彙值（`manual`／`hybrid`／`automation`、`analyzing`／`retrying`／`ready`／`error`）、
  Conventional Commits 前綴（`feat`、`fix`、`chore`、`docs`）、
  API／憑證名稱（`IMBRACE_API_KEY`、`accessToken`、`SESSION_SECRET`）、
  既有英文術語（JOIN、LEAVE、webhook、SSE、sparkline、debounce、provider、refcount）。
- 規格文件（`spec.md`、`plan.md`、`tasks.md` 等 Spec Kit 產出）與 UI 文案（i18n）本身也以繁體中文撰寫，
  技術名詞比照上一點保留原文。

## ⚠️ 正典文件修改後，必須 grep 舊說法（不限於實測結論）

**這是本專案最常犯、代價最高的錯誤，且已經犯過不只一次。**

同一個結論或決策會散落在決策摘要、詳細章節、里程碑驗收、風險表、對外問題清單、**甚至另一份正典文件**
（例如 `docs/CONSTITUTION.md` 的憲法條文、`docs/SDK_FINDINGS.md` 的型別層分析）**多個地方**，
措辭各不相同。改完「主要」那份文件後，主觀上會覺得「已經改完了」—— 那正是最危險的時刻。

不只實測結論會這樣過期，**任何正典決策的變更都一樣**——UI 欄位要不要 nullable、
provider 走哪個方案、milestone 範圍調整……只要曾經在某處寫死過舊結論，就有機會被漏掉。
（2026-08-26 的實例：把 `confidence` 改成 nullable 時，事後才發現 `CONSTITUTION.md` 4.4 條、
`SDK_FINDINGS.md` 的候選路徑表、`ARCHITECTURE.md` M3 里程碑都還在引用已撤銷的舊方案。）

```bash
grep -rn "<舊結論的關鍵措辭>" docs/    # 例：改成四來源後，grep「三來源」
grep -rn "<舊證據的數字>" docs/         # 例：grep「12/12」
grep -rn "<題號>" docs/IMBRACE_QUESTIONS.md   # 對外文件是否還在問已解決的問題
grep -rln "<被撤銷方案的名稱/端點>" docs/   # 例：撤銷 ai.embed() 路線後，grep 是否還有文件推薦它
```

完整說明見 `docs/ARCHITECTURE.md` 附錄「推翻既有結論時的必要步驟」。

> **`IMBRACE_QUESTIONS.md` 要特別小心** —— 它會被直接轉貼給 iMBrace。
> 內容過期不只是不準確，而是浪費對方時間並稀釋其他真正待答問題。
> 自行解決的問題要**明確撤回並附上解法**，不是默默刪掉（對方可能已經在查了）。

## ⚠️ 三個會「靜默失效」的地雷

以下都**不會報錯、不會有型別錯誤**，只會安靜地做錯事。動到相關區域前務必先讀章節。

1. **對話有三種識別碼**，形狀都是 UUID，傳錯只會靜默不作用或比對永遠不相等。
   已經造成過兩次實際損害（一次誤判整個里程碑被阻塞）。→ **§9.3**
2. **`mode` 欄位的 `automation` 值有歧義**，且它回答的不是「有沒有人在」。
   判定條件寫錯會讓同事從 presence 中消失。→ **§10.2、§10.6**
3. **SDK 的型別與實際 API 不一致**（欄位名不同、必填標錯、參數未宣告）。
   照型別寫會 400 或 401，而錯誤訊息無法反推原因。
   所有繞道一律關在 `server/services/imbrace.ts` 的防腐層，**不得散落到 route**。

判斷「文件說的」與「平台實際行為」哪個對時：**跑 spike 實測，不要推理**。
`scripts/spike/` 下有現成的探測腳本，`npm run spike:*`。

## 驗證指令

```bash
npm run typecheck    # nuxt typecheck + scripts/test 的 tsc
npm test             # vitest（單元 + 對假 gateway 的整合測試）
npm run build        # 會先跑 typecheck 才建置
npm run smoke        # ⚠️ 需先 build。兩支合計約 30 秒（下面兩支的總和）
npm run smoke:flow      # 單一 session 走完登入→對話→送出，並掃描憑證是否外洩
npm run smoke:realtime  # 兩位客服、兩條 SSE：M1 的「4 秒內看到」與「斷線補齊」
```

提交前至少跑 `npm run typecheck && npm test`。
動到 `server/api/**`、`server/utils/session*`、`server/sources/**` 時**一併跑 `smoke`** ——
它涵蓋 vitest 測不到的 HTTP route 與 cookie 往返，並掃描每個回應確認憑證不外洩。

⚠️ `smoke:realtime` 會量**實際延遲**並斷言 ≤ 4 秒（§18 M1）。
機器負載很重時它可能是唯一會浮動的檢查 —— 但失敗是真的訊號，
不要因為「偶爾紅」就放寬門檻，那個數字是驗收標準本身。

## 協作注意

- **可能有另一個 Claude session 正在編輯同一份文件** —— 不限於 `docs/DESIGN_TOKENS.md`，
  `docs/ARCHITECTURE.md` 同樣會被跨 session 修正（例如發現文件內部不同步、
  或畫布內容有更新時）。`git add -A` 前先 `git status` 看一眼，
  避免把對方進行中的修改掃進自己的 commit。
- commit 訊息用 Conventional Commits，內文說明**為什麼**，不只是改了什麼 ——
  這個專案的多數 commit 是在記錄「某個假設被實測推翻」，那個推翻的理由才是價值所在。
- 跑 `/speckit-implement` 或 `/speckit-analyze` 時，**邊實作邊逐一勾選 `tasks.md` 或 checklist 中的完成項目**
  （例如完成 T010 就打勾 `[x]`），每個 Phase 結束時用 `/commit-split` 分類並建立 commit。
- 里程碑完成打 tag（`m0-done`、`m1-done`）。**tag 一旦建立就不移動。**

  ⚠️ **「tag 落後 HEAD」不是需要修正的錯誤，那是它的正常狀態，也正是它的用途** ——
  它標記的是「當時通過驗收」這個歷史事實，本來就會隨後續 commit 越落越後。
  若因為落後就往前挪，tag 會永遠跟著 HEAD 跑，等於什麼都沒標記到。
  （已發生過一次：`m1-ready` 建立後隔一個 commit 就被以「落後 HEAD」為由移動。
  該次結果無害，但理由不成立，記錄於此以免再犯。）

  真的押在錯的狀態上時（例如押在驗收尚未通過的 commit），
  **刪掉重押並在 annotation 說明**，不要靜默移動。

  ⚠️ **機制陷阱**：`git tag -f -a <name>` 不指定 commit-ish 時會**靜默重新指向 HEAD**。
  因此「只想改 annotation 文字」的操作會連帶移動位置，而且不會有任何提示。
  要保位置改文字，必須明確帶上原本的 commit：

  ```bash
  git tag -f -a m1-ready <原本的 commit hash> -m "..."   # ✅ 位置不變
  git tag -f -a m1-ready -m "..."                        # ❌ 靜默跳到 HEAD
  ```

  這個陷阱已經觸發過一次 —— 在一段正文寫著「位置維持不動」的 annotation 裡，
  改寫該段文字的動作本身把 tag 又往前移了一個 commit。

## 環境

- Node ≥ 24。`.env.local` 一份供 spike 腳本與 Nuxt 共用，
  `nuxt.config.ts` 會把 `IMBRACE_*` 橋接成 Nuxt 的 `NUXT_*` 慣例。
- ⚠️ 專案路徑含空白（`03 FE products`），這會讓部分工具的路徑處理出錯。
  `typescript.typeCheck` 因此關閉，改由 build script 串接（理由寫在 `nuxt.config.ts`）。
- ⚠️ `IMBRACE_ENV=stable` 是**正式環境**，操作的是真實客戶資料。
  寫入類的實測（JOIN、送訊息、切換 mode）前先確認對象對話，並讓使用者知情。
