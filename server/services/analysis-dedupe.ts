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
/** 同鍵。標記「這次跑完後還要再跑一次」——旗標而非佇列 */
const analysisRerunPending = new Set<string>()

/**
 * 同一個 (對話, 區塊) 同時只跑一份分析；進行中又被觸發時**合併**成「跑完後再跑一次」
 * （FR-009），MUST NOT 直接丟棄。
 *
 * **為何是旗標而非佇列**：合併語意是「至少再跑一次最新的」。累積 N 次觸發就跑 N 次
 * 沒有意義 —— 分析的輸入是當下的狀態，不是被合併掉的那些事件。
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
    analysisRerunPending.add(key)
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
  await task

  if (analysisRerunPending.delete(key)) await runBlockDeduped(conversationId, block, fn)
}
