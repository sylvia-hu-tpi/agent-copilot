/**
 * 建立／驗證結案摘要的 Data Board（`specs/006-closure-handoff-summary` FR-050～FR-052、
 * 契約 `closure-board-schema.md` §3／§4）。
 *
 *     npm run board:setup     # Board 不存在 → 建立；已存在 → 只補「缺少」的欄位
 *     npm run board:verify    # 只比對、不寫入；齊全離開碼 0，有落差非 0
 *
 * ⚠️⚠️ **`ARCHITECTURE.md` §13.3 逐字寫著這句話，這支腳本整份都是它的展開：**
 *      > **少建一欄不會報錯，只會讓該維度在報表裡永遠是空的。**
 *
 * ⚠️ **執行期 MUST NOT 用名稱查找 board**（契約 §1）。名稱不是唯一鍵，同名 board
 *    會讓寫入靜默落到錯的地方，而 Board 是正式 CRM —— 寫錯的紀錄不會有任何錯誤訊息。
 *    因此：有 `IMBRACE_CLOSURE_BOARD_ID` 就用它；沒有且不是 verify 模式才建立新的，
 *    **不從既有 board 裡「找找看有沒有同名的」**。
 *
 * ⚠️ 以 `clientForApiKey()` 執行 —— `server/services/imbrace.ts` 該函式的註解逐字寫著
 *    「僅用於不需歸屬到特定客服的背景作業，例如 Data Board schema setup script」，
 *    這是它唯一的正當用途（憲法 1.3）。結案**寫入**一律走客服自己的 session token。
 *
 * ⚠️ **型別不符與選項不符只報不改**：改型別可能毀掉既有資料，改選項則牽涉到
 *    「舊紀錄裡存的是舊字串」這個資料遷移問題（見 `config/categories.ts` 檔頭）。
 *    兩者都要人來判斷。
 *
 * ⚠️ **MUST NOT 印出 API key 或任何 token**（B6、憲法 1.5）。
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Environment } from '@imbrace/sdk'
import {
  clientForApiKey,
  createBoard,
  createBoardField,
  getBoard,
  type BoardFieldInfo,
} from '../server/services/imbrace.js'
import {
  CLOSURE_BOARD_DESCRIPTION,
  CLOSURE_BOARD_FIELDS,
  CLOSURE_BOARD_NAME,
  type ClosureFieldSpec,
} from '../server/services/closure/board-schema.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 差集（純函式，供 `test/closure-board-verify.test.ts` 驗）─────────────

export interface BoardDiff {
  /** Board 上沒有這一欄 —— setup 模式會補建它 */
  missing: ClosureFieldSpec[]
  /** 欄位在但型別不對。⚠️ 只報不改：改型別可能毀掉既有資料 */
  typeMismatch: Array<{ name: string, actual: string, expected: string }>
  /** 受控詞彙的選項與 `config/categories.ts` 不一致。⚠️ 只報不改 */
  optionMismatch: Array<{ name: string, missing: string[], extra: string[] }>
  /**
   * **讀不到選項**，因此無法比對 —— 與「選項不符」是兩件事。
   *
   * ⚠️ 2026-09-04 實測（`scripts/spike/out/29-board-detail.json`）：以 `options`
   *    建立的 `SingleSelection` 欄位，`boards.get()` 回讀時**沒有任何選項欄位**。
   *    把這種情況報成「全部選項都缺」的話，`--verify` 會每一次都非零離開，
   *    而 B2 的離開碼從此失去意義 —— 那比不檢查更糟。
   *    因此獨立成一格：報出來讓人知道「這一項我方驗不了」，但不計入不通過。
   */
  optionsUnreadable: string[]
}

/**
 * ⚠️ **同時比對名稱、型別與選項**（B3、B4）。只比名稱的話，
 *    `sentiment_trough` 被建成 `ShortText` 一樣不會報錯，只會讓報表無法對它
 *    做數值統計 —— 與少建一欄的後果同級。
 */
export function diffBoardFields(
  actual: readonly BoardFieldInfo[],
  expected: readonly ClosureFieldSpec[] = CLOSURE_BOARD_FIELDS,
): BoardDiff {
  const byName = new Map(actual.map(f => [f.name, f]))
  const diff: BoardDiff = {
    missing: [], typeMismatch: [], optionMismatch: [], optionsUnreadable: [],
  }

  for (const spec of expected) {
    const found = byName.get(spec.name)
    if (!found) { diff.missing.push(spec); continue }
    if (found.type !== spec.type) {
      diff.typeMismatch.push({ name: spec.name, actual: found.type, expected: spec.type })
      // 型別都不對了，選項比對沒有意義 —— 先把型別修好
      continue
    }
    if (!spec.options) continue
    if (!found.options) { diff.optionsUnreadable.push(spec.name); continue }

    const have = new Set(found.options)
    const want = new Set(spec.options)
    const missing = spec.options.filter(o => !have.has(o))
    // ⚠️ `extra` 只報不移除：Board 上多出來的選項可能是營運手動加的，
    //    而刪掉它會讓已經用了那個值的歷史紀錄在篩選器裡消失
    const extra = found.options.filter(o => !want.has(o))
    if (missing.length > 0 || extra.length > 0) {
      diff.optionMismatch.push({ name: spec.name, missing, extra })
    }
  }
  return diff
}

/** 有落差就非零離開（B2）。⚠️ `optionsUnreadable` **不**計入 —— 那是我方驗不了，不是不通過 */
export function isDiffClean(diff: BoardDiff): boolean {
  return diff.missing.length === 0
    && diff.typeMismatch.length === 0
    && diff.optionMismatch.length === 0
}

// ── 輸出（逐字比照契約 §4）──────────────────────────────────────────────

function report(boardName: string, boardId: string, total: number, diff: BoardDiff): void {
  console.log(`\nBoard: ${boardName} (${boardId})\n`)

  const ok = total - diff.missing.length
  if (isDiffClean(diff)) {
    console.log(`✅ ${total} 個欄位齊全`)
  }
  else {
    console.log(`✅ ${ok} 個欄位存在`)
  }

  if (diff.missing.length > 0) {
    console.log(`❌ 缺少 ${diff.missing.length} 個欄位：`)
    // ⚠️ B2：**逐欄列出名稱**。只印「不通過」不夠 ——
    //    缺哪一欄決定了報表哪一個維度是空的
    for (const f of diff.missing) console.log(`   - ${f.name.padEnd(22)} (${f.type})`)
  }
  if (diff.typeMismatch.length > 0) {
    console.log(`⚠️ 型別不符 ${diff.typeMismatch.length} 個：`)
    for (const m of diff.typeMismatch) {
      console.log(`   - ${m.name.padEnd(22)} 實際 ${m.actual}，應為 ${m.expected}`)
    }
  }
  if (diff.optionMismatch.length > 0) {
    console.log(`⚠️ 選項不符 ${diff.optionMismatch.length} 個：`)
    for (const m of diff.optionMismatch) {
      if (m.missing.length > 0) {
        console.log(`   - ${m.name.padEnd(22)} 設定檔有「${m.missing.join('、')}」，Board 沒有`)
      }
      if (m.extra.length > 0) {
        console.log(`   - ${m.name.padEnd(22)} Board 多出「${m.extra.join('、')}」（只報不移除）`)
      }
    }
  }
  if (diff.optionsUnreadable.length > 0) {
    console.log(`ℹ️ 讀不到選項、無法比對 ${diff.optionsUnreadable.length} 個：${diff.optionsUnreadable.join('、')}`)
    console.log('   （實測 boards.get() 目前不回選項清單，見 scripts/spike/out/29-board-detail.json；')
    console.log('    這一項不計入不通過 —— 否則 --verify 會每次都失敗而失去意義）')
  }

  const problems = diff.missing.length + diff.typeMismatch.length + diff.optionMismatch.length
  console.log(
    isDiffClean(diff)
      ? '\n結果：通過'
      : `\n結果：不通過（缺 ${diff.missing.length}、型別不符 ${diff.typeMismatch.length}、`
        + `選項不符 ${diff.optionMismatch.length}，共 ${problems} 項）`,
  )
}

// ── 主流程 ─────────────────────────────────────────────────────────────

function loadEnv(): void {
  for (const f of ['.env.local', '.env']) {
    const p = resolve(ROOT, f)
    if (existsSync(p)) { process.loadEnvFile(p); break }
  }
}

function requireEnv(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) {
    // ⚠️ 只說「缺哪一個」，MUST NOT 印出任何已設定的值（B6）
    throw new Error(`缺少環境變數 ${key} —— 請填進 .env.local`)
  }
  return v
}

async function main(): Promise<number> {
  loadEnv()
  const verify = process.argv.includes('--verify')

  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: (process.env.IMBRACE_ENV?.trim() || 'stable') as Environment,
    baseUrl: process.env.IMBRACE_BASE_URL?.trim() || undefined,
  })

  // ── ① 取得 board ─────────────────────────────────────────
  let boardId = process.env.IMBRACE_CLOSURE_BOARD_ID?.trim() ?? ''
  if (!boardId) {
    if (verify) {
      console.error('❌ IMBRACE_CLOSURE_BOARD_ID 未設定，無法驗證。請先跑 `npm run board:setup`。')
      return 1
    }
    console.log(`\n📋 IMBRACE_CLOSURE_BOARD_ID 未設定，建立新的 Board「${CLOSURE_BOARD_NAME}」…`)
    boardId = await createBoard(client, CLOSURE_BOARD_NAME, CLOSURE_BOARD_DESCRIPTION)
  }

  // ── ② 讀現有欄位（⚠️ 不吃快取 —— 驗證的整個意義就是不信任任何副本）──
  let board = await getBoard(client, boardId)
  if (!board) {
    console.error(`❌ 找不到 Board ${boardId} —— 請確認 IMBRACE_CLOSURE_BOARD_ID 是否正確。`)
    return 1
  }

  // ── ③ 算差集 ─────────────────────────────────────────────
  let diff = diffBoardFields(board.fields)

  // ── ④ setup 模式只補 `missing`（B1：先讀再算差集，MUST NOT 無條件建立）──
  if (!verify && diff.missing.length > 0) {
    console.log(`\n🔧 補建 ${diff.missing.length} 個缺少的欄位…`)
    for (const spec of diff.missing) {
      await createBoardField(client, boardId, spec)
      console.log(`   + ${spec.name} (${spec.type})`)
    }
    /*
      ⚠️ **欄位 id 事後以 `getBoard()` 反查，MUST NOT 取 `createBoardField()` 的回傳值**
         —— SDK 對 `createField()` 的註解寫著它「直接回傳 field」，**那句是錯的**，
         它回的是整個 board。防腐層因此刻意不回傳 id（見 `imbrace.ts`），
         這裡重讀一次是唯一正確的做法。
    */
    board = await getBoard(client, boardId)
    diff = board ? diffBoardFields(board.fields) : diff
  }

  report(board?.name || CLOSURE_BOARD_NAME, boardId, CLOSURE_BOARD_FIELDS.length, diff)

  // ── ⑤ 印出 id 供貼進 .env.local（B5）────────────────────────
  console.log(`\nIMBRACE_CLOSURE_BOARD_ID=${boardId}\n`)

  // ── ⑥ 離開碼：齊全 0、有落差非 0（B2）──────────────────────
  return isDiffClean(diff) ? 0 : 1
}

// ⚠️ 只在直接執行時跑 —— `test/closure-board-verify.test.ts` 會 import
//    `diffBoardFields()`，那時不該連上任何平台
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('setup-closure-board.ts')) {
  main()
    .then(code => process.exit(code))
    .catch((err) => {
      // ⚠️ 只印訊息，不印 stack、不印請求內容 —— 憑證可能在裡面
      console.error(`\n💥 ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
