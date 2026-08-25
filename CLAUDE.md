# AgentCopilot

iMBrace 客服平台的協作副駕。Nuxt 4（`ssr: false` + 完整 Nitro BFF）。

> **本檔只放「必須在 context 裡才有用」的東西。**
> 架構、實測結論、程式碼約束都有各自的正典檔案（見下方文件地圖），
> 此處**只指路、不重述** —— 多一個地方描述同一件事，就多一個會過期的地方。

## 文件地圖

| 檔案 | 是什麼的正典 |
|---|---|
| `docs/ARCHITECTURE.md` | 架構決策與**所有平台實測結論**。近 2000 行，用章節號索引 |
| `docs/CONSTITUTION.md` | 程式碼約束（八條憲法）。寫 code 前必讀 |
| `docs/IMBRACE_QUESTIONS.md` | 待向 iMBrace 確認的清單。⚠️ **唯一會離開這個 repo 的文件** |
| `docs/PLATFORM_CAPABILITY.md`、`docs/SDK_FINDINGS.md` | 平台能力與 SDK 的實測記錄 |
| `docs/DESIGN_TOKENS.md` | 設計規格。⚠️ 衍生自 Claude Design 畫布，可能與畫布脫鉤 |
| `scripts/spike/out/` | 實測原始產出。**結論有疑慮時以此為準，不以文件敘述為準** |

## ⚠️ 改動實測結論後，必須 grep 舊說法

**這是本專案最常犯、代價最高的錯誤，且已經犯過。**

同一個結論會散落在決策摘要、詳細章節、里程碑驗收、風險表、對外問題清單**五個地方**，
措辭各不相同。改完詳細章節後，主觀上會覺得「已經改完了」—— 那正是最危險的時刻。

```bash
grep -rn "<舊結論的關鍵措辭>" docs/    # 例：改成四來源後，grep「三來源」
grep -rn "<舊證據的數字>" docs/         # 例：grep「12/12」
grep -rn "<題號>" docs/IMBRACE_QUESTIONS.md   # 對外文件是否還在問已解決的問題
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
npm run smoke        # ⚠️ 需先 build。對建置後的 Nitro 跑完整登入流程並驗 M0 驗收
```

提交前至少跑 `npm run typecheck && npm test`。
動到 `server/api/**`、`server/utils/session*`、`server/sources/**` 時**一併跑 `smoke`** ——
它涵蓋 vitest 測不到的 HTTP route 與 cookie 往返，並掃描每個回應確認憑證不外洩。

## 協作注意

- **可能有另一個 Claude session 正在編輯同一份文件**（設計 session 負責
  `docs/DESIGN_TOKENS.md` 與畫布）。`git add -A` 前先 `git status` 看一眼，
  避免把對方進行中的修改掃進自己的 commit。
- commit 訊息用 Conventional Commits，內文說明**為什麼**，不只是改了什麼 ——
  這個專案的多數 commit 是在記錄「某個假設被實測推翻」，那個推翻的理由才是價值所在。
- 里程碑完成打 tag（`m0-done`）。**tag 不移動** —— 它標記的是「當時驗收通過」這個歷史事實。

## 環境

- Node ≥ 24。`.env.local` 一份供 spike 腳本與 Nuxt 共用，
  `nuxt.config.ts` 會把 `IMBRACE_*` 橋接成 Nuxt 的 `NUXT_*` 慣例。
- ⚠️ 專案路徑含空白（`03 FE products`），這會讓部分工具的路徑處理出錯。
  `typescript.typeCheck` 因此關閉，改由 build script 串接（理由寫在 `nuxt.config.ts`）。
- ⚠️ `IMBRACE_ENV=stable` 是**正式環境**，操作的是真實客戶資料。
  寫入類的實測（JOIN、送訊息、切換 mode）前先確認對象對話，並讓使用者知情。
