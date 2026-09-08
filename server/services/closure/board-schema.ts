/**
 * Data Board `AgentCopilot_ClosureSummary` 的名稱與欄位表 ——
 * `specs/006-closure-handoff-summary/contracts/closure-board-schema.md` §2 的程式碼副本。
 *
 * ⚠️ **這份陣列是 `board-repository.ts`（寫入）與 `setup-closure-board.ts`（建立／驗證）
 *    的共同來源。** FR-052 的「schema 與程式碼保持同步」靠單一來源成立，不靠人記得 ——
 *    各抄一份的話，setup 建了 26 欄而 repository 只寫 25 欄，兩邊都不會報錯，
 *    只會讓該維度在報表裡永遠是空的（§13.3 逐字寫著這句話）。
 *
 * ⚠️ 本表、`shared/types/copilot.ts` 的 `ClosureSummary`、`docs/ARCHITECTURE.md` §13.3、
 *    與上述契約是**同一份事實的四個副本**。改任一處 MUST 四處同步。驗法：
 *
 *    grep -n "period_origin\|period_sentiment_note" docs/ARCHITECTURE.md \
 *      shared/types/copilot.ts server/services/closure/board-schema.ts \
 *      specs/006-closure-handoff-summary/contracts/closure-board-schema.md
 *
 * ⚠️ **本檔是純模組，MUST NOT 使用任何 Nitro auto-import**（`useRuntimeConfig`、
 *    `createError`…）。理由見 `tsconfig.scripts.json` 檔頭：`scripts/setup-closure-board.ts`
 *    以 tsx 直接 import 它，那條路徑沒有 Nitro 的 auto-import。
 *
 * ⚠️ **本目錄（`server/services/closure/`）刻意不是分析管線的成員**：
 *    不受 `@analysis-pipeline` 標記管轄、不進 `test/contract-guards.test.ts` 的狀態擁有權表、
 *    不參與背景節流。結案摘要只在客服明確按下時產生一次，把它掛進管線會讓它跟著背景重算跑
 *    （§14.1.1 拒絕讓第 6 區塊常駐的同一個理由）。
 */

import {
  ACTIONS_TAKEN,
  CATEGORIES,
  RESOLUTIONS,
  SENTIMENT_OUTCOMES,
} from '../../../config/categories.js'

/**
 * ⚠️ 執行期 **MUST NOT 用這個名稱查找 board**（契約 §1）。名稱不是唯一鍵，
 *    同名 board 會讓寫入靜默落到錯的地方，而 Board 是正式 CRM —— 寫錯的紀錄
 *    不會有任何錯誤訊息。執行期一律用 `IMBRACE_CLOSURE_BOARD_ID`。
 *    這個常數只有兩個用途：setup script 建立時的名稱，與 `--verify` 輸出的標題。
 */
export const CLOSURE_BOARD_NAME = 'AgentCopilot_ClosureSummary'

export const CLOSURE_BOARD_DESCRIPTION
  = 'AgentCopilot 結案摘要（specs/006-closure-handoff-summary）。每一列是一段服務的結案紀錄；'
    + '同一通對話可有多筆（多次服務、多位客服各自結案）。'

/** 平台認得的欄位型別 —— 六種全數實測可建立（spike 29 的 006-E2） */
export type ClosureFieldType
  = | 'ShortText'
    | 'LongText'
    | 'Number'
    | 'Date'
    | 'SingleSelection'
    | 'MultipleSelection'

export interface ClosureFieldSpec {
  name: string
  type: ClosureFieldType
  /** 受控詞彙欄位的選項；⚠️ 直接取自 `config/categories.ts`，MUST NOT 另抄一份 */
  options?: readonly string[]
  /** 給人看的說明，寫進 Board 的欄位描述 */
  description?: string
}

/**
 * 26 個欄位，逐欄對照契約 §2 的表。
 *
 * ⚠️ **順序有意義**：setup script 依序建立，Board UI 的欄位排列會照這個順序。
 *    識別欄在前、區間、通道、內容、情緒數值、稽核欄在後 —— 讓人在 Board 上一眼讀得懂。
 * ⚠️ `period_origin` 與 `period_sentiment_note` 是本規格對 §11.5／§13.3 的新增
 *    （research #21、FR-022b），四份副本都要有。
 */
export const CLOSURE_BOARD_FIELDS: readonly ClosureFieldSpec[] = [
  { name: 'record_id', type: 'ShortText', description: '主鍵（平台 item id 的副本）' },
  {
    name: 'draft_id',
    type: 'ShortText',
    description: '冪等鍵：同一份草稿重試任意次都只會有這一筆（憲法 5.3）',
  },
  {
    name: 'conversation_id',
    type: 'ShortText',
    description: '⚠️ 可重複的索引，不是唯一鍵 —— 同一通對話有多筆結案紀錄是正常的',
  },
  { name: 'period_start', type: 'Date', description: '本次涵蓋區間的起點' },
  {
    name: 'period_message_count',
    type: 'Number',
    description: '區間內訊息則數；留空 ＝ 超過 500 則的掃描上限，數不完（不是 0）',
  },
  {
    name: 'period_origin',
    type: 'SingleSelection',
    options: ['closure', 'first', 'custom'],
    description: '區間起點怎麼來的：上一次結案／第一則對話／客服自訂（FR-021e-1）',
  },
  { name: 'channel', type: 'ShortText' },
  { name: 'contact_id', type: 'ShortText' },
  {
    name: 'operators',
    type: 'LongText',
    description: 'JSON 陣列。⚠️ 用 LongText 而非 MultipleSelection：後者會讓每個新客服 id '
      + '都被記進該欄位的選項清單，清單隨資料無限成長 —— 那是把 schema 當資料用',
  },
  { name: 'joined_at', type: 'Date' },
  { name: 'closed_at', type: 'Date', description: '⚠️ 候選清單依本欄**本地**降冪排序（平台的 sort 被靜默忽略）' },
  { name: 'summary', type: 'LongText' },
  { name: 'intent', type: 'ShortText' },
  {
    name: 'category',
    type: 'SingleSelection',
    options: CATEGORIES,
    description: '白名單外 → 留空並要求客服選擇（FR-015）',
  },
  { name: 'resolution', type: 'SingleSelection', options: RESOLUTIONS },
  { name: 'actions_taken', type: 'MultipleSelection', options: ACTIONS_TAKEN },
  { name: 'sentiment_outcome', type: 'SingleSelection', options: SENTIMENT_OUTCOMES },
  {
    name: 'sentiment_start',
    type: 'Number',
    description: '⚠️ 留空 ＝ 區間內評分點不齊（FR-022b），**不是 0 分**。'
      + '實測未設定的 Number 回讀為 null，與 0 明確可分（spike 29 的 006-E4）',
  },
  { name: 'sentiment_end', type: 'Number', description: '同 sentiment_start' },
  {
    name: 'sentiment_trough',
    type: 'Number',
    description: '⚠️ **區間內**的最低點，不是整條情緒時間軸的最低點（FR-022a）',
  },
  {
    name: 'period_sentiment_note',
    type: 'ShortText',
    description: '情緒留空的原因與實際涵蓋範圍。有值即代表上面三個是留空',
  },
  { name: 'cited_sops', type: 'LongText', description: 'JSON 陣列，理由同 operators' },
  { name: 'follow_ups', type: 'LongText', description: 'JSON 陣列 [{ action, owner?, dueHint? }]' },
  { name: 'confidence', type: 'Number', description: '0–100；留空 ＝ 無真實依據（憲法 4.4）' },
  {
    name: 'reviewed_by',
    type: 'ShortText',
    description: '⚠️ 留空 ＝ 未經人審（憲法 5.2）。本規格不交付任何自動寫入路徑，'
      + '因此本欄目前一律有值；保留可留空是為了日後若有自動路徑時能標示它',
  },
  { name: 'reviewed_at', type: 'Date' },
] as const

/** 供輸出與斷言用 —— 契約 §4 的「N 個欄位齊全」印的就是它 */
export const CLOSURE_BOARD_FIELD_COUNT = CLOSURE_BOARD_FIELDS.length

/** 欄位名 → 規格，供 diff 與 `toFieldsById()` 查表 */
export const CLOSURE_FIELD_BY_NAME: ReadonlyMap<string, ClosureFieldSpec>
  = new Map(CLOSURE_BOARD_FIELDS.map(f => [f.name, f]))
