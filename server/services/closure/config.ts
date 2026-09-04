/**
 * 結案流程的執行期設定 —— 三支端點共用的同一次讀取與同一段錯誤訊息。
 *
 * ⚠️ **`IMBRACE_CLOSURE_BOARD_ID` 缺席時 MUST 當場 500，MUST NOT 有任何預設值。**
 *    給預設值（例如「找一個叫 AgentCopilot_ClosureSummary 的 board」）的話，
 *    寫入會靜默落到錯的 board —— 名稱不是唯一鍵，而 Board 是正式 CRM，
 *    寫錯的紀錄不會有任何錯誤訊息（契約 closure-board-schema.md §1）。
 *
 * ⚠️ 本檔用 Nitro 的 `useRuntimeConfig()`／`createError()`，因此**不可被
 *    `scripts/`（tsx）import**（見 `tsconfig.scripts.json` 檔頭）。
 *    setup script 需要的欄位表在 `board-schema.ts`，那才是純模組。
 */

export function requireClosureBoardId(): string {
  // ⚠️ 憲法 1.1：這個鍵在 `runtimeConfig` 而非 `runtimeConfig.public`
  const boardId = useRuntimeConfig().imbraceClosureBoardId
  if (!boardId) {
    throw createError({
      statusCode: 500,
      message:
        'IMBRACE_CLOSURE_BOARD_ID 未設定 —— 結案紀錄的 Data Board 是以 id 指定的。'
        + '請先跑 `npm run board:setup`，把它印出的 id 填進 .env.local'
        + '（或部署環境的 NUXT_IMBRACE_CLOSURE_BOARD_ID）。',
    })
  }
  return boardId
}
