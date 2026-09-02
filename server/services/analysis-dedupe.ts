/**
 * @analysis-pipeline （管線成員標記，MUST NOT 刪 —— 理由見 `copilot-analysis.ts` 檔頭）
 *
 * 同區塊併發去重 —— 「同一個 (對話, 區塊) 同時只跑一份分析」。
 *
 * 這是**排程**，不是狀態：它回答的是「這次要不要跑」，完全不知道跑的是什麼。
 * 因此與 `analysis-state.ts`（狀態怎麼寫）刻意分開兩個檔案，各自擁有自己的 Map。
 *
 * ⚠️ 這裡的兩個 Map 是 **process-local**，M4 多副本時去重完全失效
 *    —— 同一個對話會在兩個副本上各跑一次分析，而不會有任何錯誤
 *    （docs/ARCHITECTURE.md §8.3）。
 */

import type { AnalysisBlock } from './analysis-state.js'

/** 鍵：`${conversationId}:${block}` */
const analysisInFlight = new Map<string, Promise<void>>()
/** 同鍵。「這次跑完後還要再跑一次」—— 存的是**最新那次觸發的 fn**，一格而非佇列 */
const analysisRerunPending = new Map<string, () => Promise<void>>()

/**
 * 同一個 (對話, 區塊) 同時只跑一份分析；進行中又被觸發時**合併**成「跑完後再跑一次」
 * （FR-009），MUST NOT 直接丟棄。
 *
 * **為何是一格而非佇列**：合併語意是「至少再跑一次最新的」。累積 N 次觸發就跑 N 次
 * 沒有意義 —— 分析的輸入是當下的狀態，不是被合併掉的那些事件。
 *
 * ⚠️ **rerun 執行的是「最新那次觸發」的 `fn`，不是第一次的**（2026-09-02，specs/005 T026b）。
 *    原實作只存一個布林旗標、rerun 時重跑**第一次**的閉包：第一批還在飛時客戶又說了第二批，
 *    第二批的 `fn` 被丟掉、第一批被原封再送一次 —— 同一則發言進 AI 兩次，而第二批**從此消失**
 *    在情緒時間軸上（不報錯、不影響型別；spec 005 Edge Case「補算與新發言同時發生」）。
 *    註解寫的一直是「再跑一次最新的」，實作只是沒有照做。
 *    ⚠️ 三次以上併發時中間那些觸發的 `fn` 仍然會被最新的覆蓋 —— 那是合併語意的本意
 *    （debounce 已先把 1 秒內的爆量聚成一批，這裡只處理「AI 呼叫比 debounce 長」的重疊）。
 *
 * ⚠️ rerun 的那一次 **MUST 重新過一次失敗批次記憶檢查**（`fn` 自己會查，見各分析入口）。
 *    否則「失敗 → 期間又被觸發 → rerun 無視記憶再跑一次」會在錯誤狀態上多出一輪呼叫，
 *    把 SC-001 的「不超過 1 輪」打破。
 */
export async function runBlockDeduped(
  conversationId: string,
  block: AnalysisBlock,
  fn: () => Promise<void>,
): Promise<void> {
  const key = `${conversationId}:${block}`

  const inFlight = analysisInFlight.get(key)
  if (inFlight) {
    analysisRerunPending.set(key, fn)
    return
  }

  const task = (async () => {
    try {
      await fn()
    }
    finally {
      analysisInFlight.delete(key)
    }
  })()
  analysisInFlight.set(key, task)

  // ⚠️ 進行中的那次即使拋出，等待中的 rerun 也 MUST 被消化掉：留在 Map 裡的閉包會在幾分鐘後
  //    下一次成功的觸發之後被「補跑」，那時它手上的訊息早已過期。各分析入口自己會 catch AI 失敗，
  //    這裡防的是它們之外的意外（例如狀態層拋錯）。
  try {
    await task
  }
  finally {
    const rerun = analysisRerunPending.get(key)
    if (rerun) {
      analysisRerunPending.delete(key)
      await runBlockDeduped(conversationId, block, rerun)
    }
  }
}
