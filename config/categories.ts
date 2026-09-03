/**
 * 結案摘要的受控詞彙白名單 —— 憲法 4.6、`specs/006-closure-handoff-summary` FR-015。
 *
 * ⚠️ **這份清單有四個消費者，四邊都 import 本檔，MUST NOT 各抄一份：**
 *   ① AI prompt（`buildClosurePrompt()`，讓模型只能從中挑）
 *   ② server 端後驗（Zod enum，模型挑錯就丟棄該欄位）
 *   ③ 人審面板的選單選項
 *   ④ Board setup script 建立 `SingleSelection`／`MultipleSelection` 的選項
 *
 * 任何一邊分岔的後果都是**靜默的**：prompt 少一個值 → 模型永遠選不到它；
 * Board 少一個選項 → 該值寫得進去（實測平台會照收，見下方），但它不是 Board 上的正式選項，
 * 報表的篩選器裡看不到它。兩者都不報錯。
 *
 * ── 為什麼是 `.ts` 而不是憲法 4.6 括號裡寫的 `.yaml` ──────────────
 * 因為 `resolution` 與 `sentimentOutcome` 的值域**同時**存在於「設定檔」與
 * 「`ClosureSummary` 的字面聯集型別」（`ARCHITECTURE.md` §11.5）兩個地方，
 * 而兩處分岔是遲早的事。用 `.ts` 讓型別**由本檔推導**（見下方 `ClosureResolution`），
 * 分岔在編譯期就不可能發生 —— 這是 `.yaml` ＋ 執行期解析換不到的保證。
 * ✅ 憲法 4.6 與 `ARCHITECTURE.md` 的四處指標已於 2026-09-03 同步訂正為 `.ts`
 *    （憲法 v4.0.1，屬 B.2 的 PATCH 級指標訂正，規則本身不變）。
 *
 * ── 改動這份清單時：新增是安全的，改名與刪除不是 ──────────────
 *
 * **新增**一個值 → 改這裡就好，但**要記得重跑 `npm run board:setup`**。
 * 四個消費者裡有三個（prompt、後驗、面板選單）改完立即生效，
 * 只有 **Board 的選項清單**不會自動跟上 —— 它由 setup script 建立。
 * ⚠️ 漏跑的後果比預期輕但仍要修：實測平台**會照收**選項清單外的值
 * （`scripts/spike/29-board-write-path.ts` 的 006-E5），所以資料寫得進去、不會掉，
 * 但它不會成為 Board 上的正式選項，報表的篩選器裡看不到它。
 * `npm run board:verify` 會把這個落差指出來。
 *
 * ⚠️ **改名或刪除既有的值，MUST 當成資料遷移處理，不是改一行字。**
 * 已寫入的歷史紀錄裡存的是**舊字串**，改名不會回頭更新它們 ——
 * 結果是同一類議題在報表上裂成兩條，而且不會有任何錯誤訊息。
 * 真的要改時，順序是：① 先確認 Board 上該值的既有筆數；② 決定舊紀錄怎麼處理
 * （保留、或以 `updateItem` 批次改寫）；③ 才改這份檔案並重跑 setup。
 */

/**
 * 分類 —— 客戶這次進線屬於哪一類議題。
 *
 * ⚠️ **這份初始清單是開發起點，尚未與 iMBrace／營運確認**（`specs/006` Dependencies
 *    的「受控詞彙設定檔」）。前三項取自 Design 畫布 artboard 2b 的示範候選
 *    （發票補寄／帳單金額疑義／會員資料變更），其餘由既有 spike 的真實對話樣本歸納。
 *    正式上線前 MUST 與實際報表需求對過一輪 —— 分類定錯不會報錯，
 *    只會讓半年後的報表全部落在「其他」。
 */
export const CATEGORIES = [
  '發票補寄',
  '帳單金額疑義',
  '會員資料變更',
  '訂單查詢',
  '退款進度',
  '物流查詢',
  '商品瑕疵',
  '障礙排除',
  '合約與續約',
  '個資與隱私',
  '客訴與服務態度',
  '其他',
] as const

/**
 * 處理結果 —— 本次服務的**結果狀態**。
 *
 * ⚠️ 與 `ACTIONS_TAKEN`（做了什麼）刻意分開（`ARCHITECTURE.md` §13.3 逐字要求）。
 *    合併的話「已建立工單」與「已解決」會擠在同一欄，報表分不出
 *    「處理了但沒解決」與「解決了」—— 而那是客服品質最重要的一條分界。
 * ⚠️ 值域來自 `ARCHITECTURE.md` §11.5 的 `ClosureSummary.resolution`，MUST 逐字相同。
 */
export const RESOLUTIONS = [
  'resolved',
  'workaround',
  'escalated',
  'unresolved',
  'customer_abandoned',
] as const

/**
 * 實際採取的行動 —— 可多選。
 *
 * ⚠️ 與 `CATEGORIES` 同樣是待確認的初始清單。
 */
export const ACTIONS_TAKEN = [
  '已提供操作說明',
  '已建立工單',
  '已派工',
  '已更新客戶資料',
  '已補寄',
  '已退款',
  '已補償或折抵',
  '已預約回電',
  '已轉交上級',
  '已轉其他部門',
  '已提供替代方案',
] as const

/**
 * 情緒結果 —— 客戶情緒的收尾狀態。
 *
 * ⚠️ 這是**語意標籤**，與 `sentiment_start`／`end`／`trough` 三個數值是兩回事：
 *    數值由系統從情緒時間軸計算（唯讀、可能留空），本欄由模型判讀對話最後幾輪。
 *    兩者 MUST NOT 互相推導 —— 數值留空時（FR-022b）本欄仍應有值。
 * ⚠️ 值域來自 `ARCHITECTURE.md` §11.5 的 `ClosureSummary.sentimentOutcome`，MUST 逐字相同。
 */
export const SENTIMENT_OUTCOMES = [
  'appeased',
  'satisfied',
  'still_negative',
  'escalated',
] as const

// ── 型別由清單推導，不另外寫一份字面聯集 ──────────────────────────
//
// ⚠️ `shared/types/copilot.ts` 的 `ClosureSummary` MUST 使用下面這兩個型別，
//    MUST NOT 自己再寫一次 `'resolved' | 'workaround' | ...`。
//    自己寫一份的那一刻，這個檔案就從「唯一來源」退化成「其中一份副本」。

export type ClosureResolution = typeof RESOLUTIONS[number]
export type ClosureSentimentOutcome = typeof SENTIMENT_OUTCOMES[number]

/** `category` 刻意維持 `string` 而非推導聯集 —— 它是開放值域，營運會持續增修 */
export type ClosureCategory = string

/** 給 prompt 與 setup script 用的統一形狀 */
export const CLOSURE_VOCABULARY = {
  categories: CATEGORIES,
  resolutions: RESOLUTIONS,
  actionsTaken: ACTIONS_TAKEN,
  sentimentOutcomes: SENTIMENT_OUTCOMES,
} as const
