/**
 * @analysis-pipeline （管線成員標記，MUST NOT 刪 —— 理由見 `copilot-analysis.ts` 檔頭）
 *
 * 建議卡 —— specs/002-suggestion-knowledge-search、specs/004-progressive-citations。
 *
 * 三個區塊裡唯一有自己執行期控制流的一個：兩段式（先給可用的卡，再給有依據的卡）
 * 需要世代計數、兩個方向相反的 AbortController，以及一條刻意跑在鎖外的「尾巴」。
 * 這些狀態與摘要／情緒完全無關，因此整段獨立成檔。
 *
 * ⚠️ **`suggestionTails`／`suggestionTailDone` 是本檔獨有的狀態，MUST NOT 被任何其他
 *    檔案碰到。** 外部要作廢一條尾巴（LEAVE）走 `cancelSuggestionTail()`，
 *    要問「現在有沒有尾巴」走 `hasSuggestionTail()` —— 兩支都在本檔。
 *    直接摸那兩個 Map 會繞過世代計數，而症狀是舊尾巴的結果覆蓋新結果，不報錯。
 *
 * ⚠️ 這一整段是 server-only 的**控制流**狀態，MUST NOT 進 `CopilotAnalysisState`
 *    或 `shared/` —— 進了就會隨 `publishBlock()` 送出的整個 block 流到瀏覽器
 *    （`test/contract-guards.test.ts` 有守衛擋 `shared/` 出現這些名字）。
 *
 * ⚠️ 兩個 Map 皆為 **process-local**：程序重啟後尾巴全部消失，而
 *    `CopilotAnalysisState` 有 2 小時 sliding TTL 會活下來 ——
 *    落差由 `settleOrphanedPendingCitation()` 收拾（見該函式）。
 */

import { isWorkflowInternalMessage } from '../../../shared/types/conversation.js'
import type { Message } from '../../../shared/types/conversation.js'
import type { SuggestionCard } from '../../../shared/types/copilot.js'
import type { KnowledgeHit } from '../../../shared/types/knowledge.js'
import { useStateStore } from '../../state/index.js'
import type { CopilotAnalysisState } from '../../state/types.js'
import { useAIProvider } from '../ai/index.js'
import type { WithRetryOptions } from '../ai/retry-policy.js'
import { RetryAbortedError, RetryExhaustedError, withRetry } from '../ai/retry-policy.js'
import { parseSuggestionCards } from '../ai/schemas.js'
import { KNOWLEDGE_SEARCH_TIMEOUT_MS } from '../knowledge/agent-knowledge-provider.js'
import { useKnowledgeProvider } from '../knowledge/index.js'
// ⚠️ 稽核事件刻意住在管線**外**（`server/utils/`）：管線內部檔 import 管線外的工具是允許的方向，
//    反過來放進管線，FR-017 的量測腳本就 import 不到它（specs/005 research.md #15）
import { emitCitationAudit } from '../../utils/citation-audit.js'
import { runBlockDeduped } from '../analysis-dedupe.js'
import {
  batchAnchor,
  beginAnalyzing,
  clearFailedBatch,
  finishBlockError,
  isBatchAlreadyFailed,
  isTextCustomerMessage,
  logFailure,
  nowIso,
  publishBlock,
  publishRetrying,
  updateAnalysisState,
} from '../analysis-state.js'

// ── 建議卡（specs/002-suggestion-knowledge-search）──────────────────────

/**
 * FR-003、憲法 4.3：`sopId` 非 null 時必須存在於呼叫當下 `knowledgeHits` 的 `id` 集合，
 * 否則**整卡捨棄**（不只清空 `sopId`）——那是模型杜撰引用，不是格式問題（research.md #6）。
 *
 * ⚠️ specs/005-m2-residual-defects FR-014：本函式**一行不改**。005 只改「送進去的東西」
 *    （`buildSuggestionPrompt()` 的封閉清單）與「留下什麼證據」（`emitCitationAudit()`），
 *    不改「擋下來的規則」。被捨棄的 `sopId` 字串另由稽核事件記錄，這裡仍只負責過濾。
 */
export function whitelistFilter(cards: SuggestionCard[], hits: KnowledgeHit[]): SuggestionCard[] {
  const validIds = new Set(hits.map(h => h.id))
  return cards.filter(c => c.sopId === null || validIds.has(c.sopId))
}

/**
 * 憲法 4.4、FR-002：`knowledgeHits` 全數 `score === null` 時（iMBrace 路徑恆如此），
 * `confidence` MUST 被覆寫為 `null`——Zod 的 `.nullable()` 擋不住模型自評的數字，
 * 只靠 prompt 交代等同沒有規則，因此抽成純函式在寫入前強制執行。
 */
export function forceNullConfidence(cards: SuggestionCard[], hits: KnowledgeHit[]): SuggestionCard[] {
  if (!hits.every(h => h.score === null)) return cards
  return cards.map(c => (c.confidence === null ? c : { ...c, confidence: null }))
}

// ── 建議卡搶答判定（FR-015、US4 AC#2）───────────────────────────────────

/** 字元二連 gram 集合——中文多半無空白可斷詞，退而求其次用字元層級比對 */
function charBigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2))
  return grams
}

/**
 * 兩段文字的重疊比例（交集大小 / 較短一方的 gram 數）——刻意不用 Jaccard（交集/聯集），
 * 那會讓「同事的回覆比建議卡長很多但完整包含其內容」被稀釋成低相似度，
 * 而那正是最常見的搶答情境（同事的回覆通常比建議卡措辭更完整）。
 */
function overlapRatio(a: string, b: string): number {
  const A = charBigrams(a)
  const B = charBigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let intersection = 0
  for (const g of A) if (B.has(g)) intersection++
  return intersection / Math.min(A.size, B.size)
}

/** spec.md Assumptions 允許簡單的關鍵詞重疊／相似度比對——判定方式留待實作決定 */
const SUPERSEDE_OVERLAP_THRESHOLD = 0.6

/**
 * 標記與 `reply` 內容明顯重複的既有卡片（FR-015）。已標記過的卡片不重複覆蓋
 * （保留最先搶答者的紀錄）。內容不重疊時回傳原陣列（同一參照），供呼叫端判斷是否需要發布。
 */
export function markSupersededCards(
  cards: SuggestionCard[],
  reply: { kind: 'agent' | 'ai', messageId: string, text: string },
): SuggestionCard[] {
  let changed = false
  const next = cards.map((c) => {
    if (c.supersededBy) return c
    if (overlapRatio(c.text, reply.text) < SUPERSEDE_OVERLAP_THRESHOLD) return c
    changed = true
    return { ...c, supersededBy: { kind: reply.kind, messageId: reply.messageId } }
  })
  return changed ? next : cards
}

/**
 * 同事回覆或（Hybrid 模式下）AI 自動回覆抵達時，檢查既有建議卡是否已被搶答（US4 AC#2）。
 * ⚠️ AI workflow 的內部訊息（`isWorkflowInternalMessage()`）不算「已回覆」，
 *    比照撞單檢查的排除原則（憲法 6.5）——客戶根本收不到那則訊息。
 */
export async function checkSuggestionsSuperseded(conversationId: string, messages: Message[]): Promise<void> {
  const replies = messages.filter(m =>
    (m.sender.type === 'agent' || m.sender.type === 'ai')
    && !(m.sender.type === 'ai' && isWorkflowInternalMessage(m)),
  )
  if (replies.length === 0) return

  /**
   * FR-015：這一刻手上正拿著回覆全文，而且 `sender.type` 篩選與 workflow-internal 排除
   * （憲法 6.5）都已經做完 —— 把它留存到尾巴上，第二段整批換卡前重放。
   *
   * ⚠️ 位置 MUST 在上面兩道過濾**之後**：這正是選在這裡留存的理由，MUST NOT 在第二段
   *    那邊複製一份過濾邏輯。
   * ⚠️ 即使本次沒有任何卡被標記（下面 `cards === …` 提早 return）也 MUST 已經 push 完 ——
   *    第二段換上的是**不同文字**的新卡，這次沒標到不代表對新卡也標不到。
   * ⚠️ 這是 FR-015 的**唯一**資料來源。刪掉它不會有型別錯誤，症狀只有「同事已回過的
   *    建議以未標記的新卡復活」，而 `status` 仍是 `ready`。
   *    MUST NOT 改由 `analyzeSuggestionsOnce()` 手上的 `input.history` 推導 —— 那份資料
   *    在前景增量路徑上是已篩成 `customer` 的新訊息、在冷啟動路徑上只到 JOIN 當下，
   *    兩者都篩不出任何同事回覆，照它「重跑」會什麼都不標、不報錯。
   */
  const tail = suggestionTails.get(conversationId)
  if (tail) {
    for (const reply of replies) {
      tail.repliesDuringTail.push({
        kind: reply.sender.type as 'agent' | 'ai',
        messageId: reply.id,
        text: reply.text,
      })
    }
  }

  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state || state.suggestionBlock.cards.length === 0) return

  let cards = state.suggestionBlock.cards
  for (const reply of replies) {
    cards = markSupersededCards(cards, { kind: reply.sender.type as 'agent' | 'ai', messageId: reply.id, text: reply.text })
  }
  if (cards === state.suggestionBlock.cards) return

  const next = await updateAnalysisState(conversationId, s => ({
    ...s,
    suggestionBlock: { ...s.suggestionBlock, cards, updatedAt: nowIso() },
  }))
  await publishBlock(conversationId, 'suggestions', next)
}

// ── 兩段式的執行期控制流（specs/004-progressive-citations data-model.md §4）──────
//
// ⚠️ 這一整段是 server-only 的**控制流**狀態，MUST NOT 進 `CopilotAnalysisState` ——
//    進了 state 就會隨 `publishBlock()` 送出的整個 block 流到瀏覽器
//    （`test/contract-guards.test.ts` 有守衛擋 `shared/` 出現這些名字）。

/**
 * 第二段（帶知識庫命中重新生成）的單次呼叫逾時。
 *
 * ✅ **2026-08-29 裁決為 20 秒**（004 research.md #5）。第二段一律 `maxRetries: 0`，
 * **不進重試迴圈**，因此改這個數字不牽動 001 FR-014 的 15s／1s→4s／40s 三數綁定，
 * 兩者沒有耦合 —— MUST NOT 因為「統一」而把這裡改成 15 秒。
 *
 * 為什麼不是 15 秒：建議卡生成實測最慢 13.0 秒，15 秒只剩 13% 餘裕；平台漂移 36% 就會逾時，
 * 而第二段逾時是**靜默**落成 `citation: 'none'`（依 FR-003 不轉 error、不顯示重試中），
 * 客服只會看到「未引用知識庫」而沒有任何異常跡象 —— 直接侵蝕 SC-002 的「≥ 90% 取得引用」。
 */
const SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 20_000

/**
 * 第一段（不帶命中、先出無引用版本）的單次呼叫逾時。
 *
 * ✅ **2026-09-02 新增，比照第二段的先例改用獨立常數**——同樣**不動** 001 FR-014 的
 * 共用 15 秒，因此摘要／情緒的失敗偵測完全不受影響。
 *
 * 為什麼需要它：沿用共用的 15 秒時，**002 SC-001 的 20 秒門檻在重試路徑上數學上不可能滿足**
 * ——第一次呼叫撞 15 秒逾時後，15 ＋ 1（退避）＋ 下一次呼叫（實測中位 9.7 秒）必然破 20 秒。
 * 也就是門檻寫 20 秒、實際判準卻是 15 秒。2026-09-01 三輪端到端實測：**14/14 個破 20 秒的
 * 樣本，事件序列裡都有 `retrying`，0 例外；沒重試的樣本最慢只有 14.5 秒。**
 *
 * 為什麼是 20 秒：**這個數字直接取自判準本身（SC-001 的 20 秒），不是從量測湊出來的。**
 * 語意是「超過預算才完成的呼叫，即使等到了也已經未達，繼續等沒有收益」。
 * 2026-09-02 原始單次量測（`spike:agent-latency -- suggestion 20`，不經 withRetry）
 * 佐證這個選擇：中位 9.7 秒、**最慢 18.4 秒、20/20 全部落在 20 秒內**，
 * 但其中 2 次超過 15 秒 —— 那 2 次在舊設定下會被砍掉重來、變成約 26 秒而未達。
 *
 * ⚠️ 與 `SUGGESTION_STAGE2_CALL_TIMEOUT_MS` **數值相同純屬巧合，MUST NOT 合併成一個常數**：
 *    第二段的 20 秒來自「實測最慢 13.0 秒 ＋ 平台漂移餘裕」，第一段的 20 秒來自「SC-001 的預算」。
 *    合併會讓其中一個決策的理由在下次調整時靜默消失。
 *
 * ⚠️ 代價（**刻意接受**）：第一段連續失敗到底的偵測時間由最壞約 50 秒變約 65 秒
 *    （20＋1＋20＋4＋20）。期間客服看到的是「重試中」而非空白，故不是靜默劣化。
 *    FR-014 的 40 秒退避預算**不需要跟著改** —— 該預算自第一次失敗起算，
 *    第二次失敗時 elapsed 約 21 秒 < 40 秒，整條重試鏈仍走得完，沒有被截斷。
 *
 * ⚠️ **這個槓桿只在平台的正常時段有效。** 降級時段（2026-09-01 曾量到摘要單次中位 52 秒）
 *    原始呼叫本身就遠超 20 秒，放寬逾時救不回來 —— 那不是我方的參數問題（§8.2b）。
 */
const SUGGESTION_STAGE1_CALL_TIMEOUT_MS = 20_000

/** 第一段的落定結果 —— 尾巴在落定 `citation` 之前 MUST 先等它（FR-003a ①） */
type Stage1Result =
  | { kind: 'landed' } // 已發布 ready/pending（cards 可能為空）
  | { kind: 'failed' } // 已 finishBlockError()，區塊為 error
  | { kind: 'aborted' } // 被 stage1Abort 取消，區塊仍停在 analyzing／retrying

interface SuggestionTail {
  /** 每次 `analyzeSuggestionsOnce()` 啟動 +1；過期判定的**唯一**依據 */
  generation: number
  /**
   * ⚠️ **兩個 controller MUST NOT 合併成一個**（data-model.md §4）。觸發者與標的相反：
   *   - `stage1Abort`：由**第二段自己**在成功路徑上（檢索有命中時）觸發，標的是第一段
   *     尚未送出的重試（FR-006a）
   *   - `tailAbort`：由**外部**（新世代、本檔的 `cancelSuggestionTail()` ＝ LEAVE）觸發，
   *     標的是尚未送出的第二段呼叫
   * 共用一個的後果是：第二段一開始就把它 abort 掉，之後 LEAVE 再 abort 完全是 no-op ——
   * 第二段的 AI 呼叫照送、錢照付、結果無人看，而且**不會有任何錯誤**。
   */
  stage1Abort: AbortController
  tailAbort: AbortController
  /** 第二段已寫入；同世代後到的第一段結果 MUST NOT 覆蓋它（FR-006a） */
  citedLanded: boolean
  /**
   * 第一段到目前為止自動重試了幾次。第二段落地時沿用它填 `provenance`，讓
   * 「這批訊息總共呼叫幾次」＝ 1 + n + 1 可以從單一 block 讀出（SC-005）。
   * ⚠️ 由第一段的 `onRetry` 逐次更新，**不是**等第一段成功才知道 —— 第二段可能先落地
   *    （FR-006a），那時第一段還在重試迴圈裡。
   */
  stage1RetryAttempt: number
  stage1Settled: Promise<Stage1Result>
  /** 由第一段的三條出口之一呼叫。**三條都要**，漏一條尾巴會永遠掛在 await 上而不報錯 */
  settleStage1: (result: Stage1Result) => void
  /** 尾巴結束（成功、放棄、丟棄皆算）；`awaitSuggestionTail()` 供測試等待 */
  done: Promise<void>
  finishTail: () => void
  /** research.md #3 的檢索備忘 —— FR-005「命中已在手」用 */
  lastRetrieval?: { anchor: string | null, hits: KnowledgeHit[], at: string }
  /**
   * FR-015：第二段等待期間抵達的同事／AI 回覆，由 `checkSuggestionsSuperseded()` 在
   * **訊息抵達當下**追加（它那一刻手上正拿著回覆全文，且已做完 workflow-internal 過濾）。
   * 第二段整批換卡前重放，否則同事已回過的建議會以未標記的新卡復活（憲法 7.2）。
   * ⚠️ MUST NOT 改由分析函式手上的 `input.history` 推導 —— 那份資料裡沒有同事回覆（§8）。
   */
  repliesDuringTail: { kind: 'agent' | 'ai', messageId: string, text: string }[]
}

const suggestionTails = new Map<string, SuggestionTail>()

/**
 * 尾巴的結束 Promise，**與登記本身分開存放**：`cancelSuggestionTail()`（LEAVE）會把登記
 * 整筆刪掉，但那一刻尾巴本身可能還在 `await retrieval`。測試要能等到它真的收工，
 * 才問得出「第二段有沒有被送出」。尾巴自己在 finally 移除，因此只會留下進行中的那些。
 */
const suggestionTailDone = new Map<string, Promise<void>>()

/**
 * 開一個新世代：舊尾巴的第二段就此作廢（abort 尚未送出的呼叫），並換上全新的兩個 controller。
 *
 * ⚠️ 過期判定一律比對 `generation`，**MUST NOT 用 `basedOnMessageId`**（research.md #2）：
 *    手動重試會用同一個錨點再跑一次，錨點比對會放行舊尾巴覆蓋新結果，而且不會報錯。
 */
function nextSuggestionGeneration(conversationId: string): SuggestionTail {
  const prev = suggestionTails.get(conversationId)
  prev?.tailAbort.abort()

  let settleStage1: (result: Stage1Result) => void
  const stage1Settled = new Promise<Stage1Result>((resolve) => {
    settleStage1 = resolve
  })
  let finishTail: () => void
  const done = new Promise<void>((resolve) => {
    finishTail = resolve
  })

  const tail: SuggestionTail = {
    generation: (prev?.generation ?? 0) + 1,
    stage1Abort: new AbortController(),
    tailAbort: new AbortController(),
    citedLanded: false,
    stage1RetryAttempt: 0,
    stage1Settled,
    settleStage1: settleStage1!,
    done,
    finishTail: finishTail!,
    // 檢索備忘刻意**沿用**上一筆：FR-005 的「命中已在手」判斷靠它，
    // 而手動重試正是新世代——這裡清掉會讓那條路徑永遠走不到。
    lastRetrieval: prev?.lastRetrieval,
    repliesDuringTail: [],
  }
  suggestionTails.set(conversationId, tail)
  suggestionTailDone.set(conversationId, done)
  return tail
}

/** 這個對話現在有沒有尾巴在跑 —— 重連快照用來分辨「pending 還有人接手」與「程序重啟後的孤兒」 */
export function hasSuggestionTail(conversationId: string): boolean {
  return suggestionTails.has(conversationId)
}

/**
 * 把一個沒有尾巴接手的 `citation: 'pending'` 落定為 `'none'`（契約 §4）。
 *
 * ⚠️ 這是**程序重啟後唯一**會讓「尚未引用知識庫・檢索中」永久卡住的路徑：尾巴是執行期
 *    狀態，重啟即消失，而 `CopilotAnalysisState` 有 2 小時 sliding TTL 會活下來。
 *    呼叫端（`sendAnalysisSnapshotAndResume()`）MUST 先確認 `!hasSuggestionTail()`。
 *    卡片不動 —— 它們是第一段的真實產出，只是永遠不會有第二段了。
 */
export async function settleOrphanedPendingCitation(conversationId: string): Promise<CopilotAnalysisState> {
  return updateAnalysisState(conversationId, state => ({
    ...state,
    suggestionBlock: { ...state.suggestionBlock, citation: 'none' as const, updatedAt: nowIso() },
  }))
}

/**
 * ⚠️ **僅供測試**：等待這個對話最後一次尾巴收工。正式路徑上沒有人需要等第二段 ——
 * 它就是為了「不讓任何人等」才被放到鎖外的。
 */
export function awaitSuggestionTail(conversationId: string): Promise<void> {
  return suggestionTailDone.get(conversationId) ?? Promise.resolve()
}

/**
 * 作廢這個對話進行中的尾巴（LEAVE，由 `copilot-analysis.ts` 的 `cancelPendingAnalysis()` 呼叫）。
 *
 * ⚠️ 呼叫順序有規範，見呼叫端 —— 這支 MUST 在該函式的早退之前被呼叫到。
 *
 * ① abort：沒有人 JOIN 的對話不該再花第二段的錢（003 FR-013 的延伸）。
 * ② delete：`lastRetrieval` 備忘的唯一用途是手動重試（FR-005），而 LEAVE 之後
 *    沒有人能按重試，備忘從那一刻起就沒有意義。不刪的話這個 Map 會隨程序生命週期
 *    逐對話累積，每筆還帶著知識庫全文片段 —— 對照 `CopilotAnalysisState` 有 2 小時
 *    sliding TTL，它會是唯一沒有任何回收機制的狀態。
 */
export function cancelSuggestionTail(conversationId: string): void {
  const tail = suggestionTails.get(conversationId)
  if (!tail) return
  tail.tailAbort.abort()
  suggestionTails.delete(conversationId)
}

/** 這個世代還是不是最新的？不是就整個丟棄，一個字都不要寫回 state */
function isCurrentGeneration(conversationId: string, tail: SuggestionTail): boolean {
  return suggestionTails.get(conversationId)?.generation === tail.generation
}

// ── 建議卡的共用工具（004 T010）────────────────────────────────────────

/**
 * 一次「生成 → 驗證 → 白名單 → confidence 歸零」。兩段共用，順序與 002 相同（憲法 4.2～4.4）。
 *
 * ⚠️ **白名單集合是本次呼叫傳入的 `hits`**（data-model.md §7）：第一段是空集合（因此任何
 *    `sopId !== null` 的卡都會被整卡捨棄，那是既有行為），第二段是**第二段呼叫當下**的命中。
 *    第二段若沿用第一段的空集合，所有帶 `sopId` 的卡會被整卡捨棄、畫面永遠看不到引用，
 *    而 `status` 仍是 `ready` —— 不報錯。
 */
async function generateSuggestionCards(
  input: { history: Message[], aiReplies: boolean },
  hits: KnowledgeHit[],
  opts: {
    maxRetries?: number
    callTimeoutMs?: number
    onRetry?: WithRetryOptions['onRetry']
    signal?: AbortSignal
  },
): Promise<GeneratedCards> {
  const outcome = await withRetry(
    async () => parseSuggestionCards(await useAIProvider().suggest({
      history: input.history,
      knowledgeHits: hits,
      // ⚠️ 兩段都要帶（002 FR-016）。第二段漏帶會讓 Hybrid 模式下的補位提示在第二段消失。
      aiReplies: input.aiReplies,
    })),
    {
      maxRetries: opts.maxRetries,
      callTimeoutMs: opts.callTimeoutMs,
      onRetry: opts.onRetry,
      signal: opts.signal,
    },
  )

  // 005 FR-015：被白名單擋下的識別碼字串本身是稽核證據（也是 FR-017 歸因的原料），在這裡順手收下；
  // 白名單本身一行不改（FR-014），這一行只是「看」，不是「擋」
  const validIds = new Set(hits.map(h => h.id))
  const invalidSopIds = outcome.value
    .map(c => c.sopId)
    .filter((v): v is string => v !== null && !validIds.has(v))

  const whitelisted = whitelistFilter(outcome.value, hits)
  return {
    cards: forceNullConfidence(whitelisted, hits),
    retryAttempt: outcome.retryAttempt,
    audit: { cardsReturned: outcome.value.length, invalidSopIds },
  }
}

interface GeneratedCards {
  cards: SuggestionCard[]
  retryAttempt: number
  /** 給 `suggestion.citation.audited` 用的兩個數字（specs/005 contracts/citation-audit-event.md §1） */
  audit: { cardsReturned: number, invalidSopIds: string[] }
}

/**
 * 引用結果**落定**時發稽核事件（specs/005-m2-residual-defects FR-015、SC-005）。
 *
 * ⚠️ 三條落定路徑都要（前景兩段式的第二段、背景單段、命中已在手的單段），**含失敗**：
 *    第二段呼叫失敗、模型回 0 張、整批未過 Zod 都經 `settleNone()` 落成 `'none'`，那也是落定 ——
 *    漏掉任一條，該路徑的個案永遠查不到成因，SC-005 對它不成立。
 * ⚠️ 只記數字與識別碼，不記訊息全文與知識庫標題（憲法 1.5；事件型別上把那些欄位標成 never）。
 */
function auditSettlement(
  conversationId: string,
  anchor: string | null,
  stage: 1 | 2,
  hitCount: number,
  generated: GeneratedCards | null,
): void {
  emitCitationAudit({
    conversationId,
    anchor,
    stage,
    hitCount,
    cardsReturned: generated?.audit.cardsReturned ?? 0,
    cardsKept: generated?.cards.length ?? 0,
    citedKept: generated?.cards.filter(c => c.sopId !== null).length ?? 0,
    invalidSopIds: generated?.audit.invalidSopIds ?? [],
    failed: generated === null,
  })
}

/** 落地一批卡並推播。`clearFailedBatch()` 一併做掉——這批有結果了，失敗記憶沒有存在意義 */
async function publishSuggestionReady(
  conversationId: string,
  args: {
    cards: SuggestionCard[]
    knowledgeSearch: { ran: boolean, hitCount: number }
    citation: 'pending' | 'cited' | 'none'
    basedOnMessageId: string | null
    provenance: { stage: 1 | 2, stage1RetryAttempt: number }
  },
): Promise<void> {
  const next = await updateAnalysisState(conversationId, state => ({
    ...clearFailedBatch(state, 'suggestions'),
    suggestionBlock: {
      status: 'ready' as const,
      cards: args.cards,
      knowledgeSearch: args.knowledgeSearch,
      citation: args.citation,
      basedOnMessageId: args.basedOnMessageId,
      provenance: args.provenance,
      retryAttempt: undefined,
      firstFailureAt: undefined,
      updatedAt: nowIso(),
    },
  }))
  await publishBlock(conversationId, 'suggestions', next)
}

export async function analyzeSuggestions(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  strategy: SuggestionStrategy,
): Promise<void> {
  await runBlockDeduped(conversationId, 'suggestions', () => analyzeSuggestionsOnce(conversationId, input, strategy))
}

/**
 * 建議卡的兩種執行策略（004 FR-001／FR-013）。
 *
 * ⚠️ 參數名 MUST 是 `strategy`，**不是 `mode`**：`mode` 在本專案是對話服務模式的受控字彙
 *    （`manual`／`hybrid`／`automation`，CLAUDE.md 列為靜默失效地雷之一），而同一支函式的
 *    輸入正帶著由它推導出的 `aiReplies`。同一段程式碼裡兩個 `mode` 指不同東西是找麻煩。
 *
 *   - `'progressive'`：前景兩段式——第一段不帶知識庫先落地（`pending`），檢索有命中時
 *     第二段整批換上（`cited`）
 *   - `'single'`：等檢索完成再一次生成（背景對話 FR-013、命中已在手 FR-005）
 *
 * ⚠️ **背景對話用 `'single'` 是刻意的不一致，MUST NOT「修」回兩段式**（FR-013）：
 *    背景沒有人在等（002 SC-007 以「切回時已更新」為驗收），第一段的產出沒有人會看到，
 *    而背景並行上限 10 個對話正是兩段式在背景省下的那筆呼叫。沒有這段說明，
 *    日後會有人把它當成漏改的 bug 順手改掉。
 */
type SuggestionStrategy = 'progressive' | 'single'

async function analyzeSuggestionsOnce(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  strategy: SuggestionStrategy,
): Promise<void> {
  const anchor = batchAnchor(input.history)
  if (await isBatchAlreadyFailed(conversationId, 'suggestions', anchor)) return

  await beginAnalyzing(conversationId, 'suggestions')

  const query = input.history
    .filter(isTextCustomerMessage)
    .map(m => m.text)
    .join('\n')

  // 上一個世代留下的檢索備忘（FR-005）。MUST 在開新世代**之前**讀 —— 開新世代雖然會
  // 沿用它，但先讀語意清楚：判斷依據是「上一輪對這一批做過的檢索」。
  const memo = suggestionTails.get(conversationId)?.lastRetrieval

  // ⚠️ 每一條路徑都開新世代（含單段）：舊尾巴的第二段就此作廢。尾巴在鎖外跑，
  //    新一輪分析啟動時它可能還在飛，不作廢就會拿舊結果覆蓋新結果。
  const tail = nextSuggestionGeneration(conversationId)

  /**
   * FR-005「命中已在手」：這一批的檢索上一輪已經完成過，改走單段並直接沿用備忘。
   *
   * ⚠️ **判準是「備忘存在且錨點相同」，不是「`hits.length > 0`」**（2026-08-29 裁決）：
   *    `hits` 為空陣列同樣成立 —— 此時單段照樣重新生成一批卡並把標示落定為 `'none'`，
   *    但 MUST NOT 再發一次檢索。同一批訊息、同一個 query，知識庫在數十秒內不會改變，
   *    重查幾乎必然仍是 0 筆，卻要多花 9.4～20.1 秒把重試整輪拖慢。
   *
   * ⚠️ 這**不是**憲法 6.2 禁止的「略過檢索」。v3.0.2 的量詞是「每一批訊息至少一次檢索，
   *    且該批的重新生成 MUST 建立在那次檢索的真實結果上」——錨點相同保證是同一批，
   *    備忘就是那次檢索的結果。（條文原本寫「每一次生成」，兩段式與本路徑都會違反其
   *    字面，已於 2026-08-29 因本規格澄清為 v3.0.2，見憲法附錄 C。）
   */
  const hitsInHand = strategy === 'progressive' && memo && memo.anchor === anchor ? memo.hits : undefined

  if (strategy === 'single' || hitsInHand !== undefined) {
    try {
      await runSingleStage(conversationId, input, { anchor, query, presetHits: hitsInHand })
    }
    finally {
      // 單段沒有尾巴要跑，但登記本身要留著（備忘給手動重試用）——只結束它的等待。
      concludeTail(conversationId, tail)
    }
    return
  }

  await runProgressive(conversationId, input, tail, { anchor, query })
}

/**
 * 前景兩段式（FR-001、FR-003、FR-006a）。
 *
 * 檢索與第一段**同時**啟動：第一段不帶知識庫，落地即顯示（`citation: 'pending'`）；
 * 檢索交給鎖外的尾巴（T014），有命中時以命中結果重新生成整批並換上（`'cited'`）。
 *
 * ⚠️ **鎖內只等第一段**（`runBlockDeduped()` 的鎖，research.md #2）。把尾巴留在鎖內不會
 *    報錯，但新一批客戶發言的分析會被舊尾巴拖慢最多 50 秒 —— 正是 FR-006 要避免的方向。
 */
async function runProgressive(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  tail: SuggestionTail,
  ctx: { anchor: string | null, query: string },
): Promise<void> {
  const retrieval = useKnowledgeProvider()
    .search(ctx.query, { topK: 5, timeoutMs: KNOWLEDGE_SEARCH_TIMEOUT_MS })
    .catch((err): KnowledgeHit[] => {
      // FR-004：檢索失敗以空集合續行（誠實降級，非整塊轉 error）
      console.error(`[copilot-analysis] ${conversationId} 知識庫檢索失敗，改以無引用續行:`, err instanceof Error ? err.message : String(err))
      return []
    })

  // ⚠️ MUST NOT `await` —— 尾巴刻意留在鎖外（見本函式的說明）
  void runSuggestionTail(conversationId, input, tail, ctx, retrieval)

  try {
    const { cards, retryAttempt } = await generateSuggestionCards(input, [], {
      // ⚠️ 獨立常數，不是 FR-014 的共用 15 秒（理由見該常數的說明）
      callTimeoutMs: SUGGESTION_STAGE1_CALL_TIMEOUT_MS,
      onRetry: (info) => {
        tail.stage1RetryAttempt = info.attempt
        return publishRetrying(conversationId, 'suggestions', info)
      },
      signal: tail.stage1Abort.signal,
    })
    tail.stage1RetryAttempt = retryAttempt

    // ⚠️ 第二段可能已經先落地（FR-006a）：那批卡有 SOP 依據，MUST NOT 被第一段的無引用版本蓋回去
    if (!tail.citedLanded && isCurrentGeneration(conversationId, tail)) {
      await publishSuggestionReady(conversationId, {
        cards,
        // 檢索已送出＝已跑；命中數這一刻還不知道（data-model.md §3）
        knowledgeSearch: { ran: true, hitCount: 0 },
        citation: 'pending',
        basedOnMessageId: ctx.anchor,
        provenance: { stage: 1, stage1RetryAttempt: retryAttempt },
      })
    }
    // 沒發布時同樣算 'landed'：這兩種情形（第二段先落地、世代已過期）下，
    // 區塊都不是被第一段留在 analyzing／retrying 的，FR-003a ② 那條規則不適用。
    tail.settleStage1({ kind: 'landed' })
  }
  catch (err) {
    // 被第二段 abort（FR-006a）：**靜默返回**，不轉 error —— 第二段接手了這一輪。
    // 若第二段之後也失敗，由 `settleNone()` 依 FR-003a ② 收斂為 error。
    if (err instanceof RetryAbortedError) {
      tail.settleStage1({ kind: 'aborted' })
      return
    }
    await finishBlockError(conversationId, 'suggestions', err, ctx.anchor)
    tail.settleStage1({ kind: 'failed' })
  }
}

/**
 * 尾巴（第二段）—— 鎖外執行，用世代計數擋過期結果。
 *
 * ⚠️ 這裡的每一個 `return` 都是「靜默丟棄」：世代已過期、或 LEAVE／新世代 abort 了尾巴。
 *    這些情形下 MUST NOT 寫回任何狀態 —— 那個 state 已經屬於別人了。
 */
async function runSuggestionTail(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  tail: SuggestionTail,
  ctx: { anchor: string | null, query: string },
  retrieval: Promise<KnowledgeHit[]>,
): Promise<void> {
  try {
    const hits = await retrieval
    if (!isCurrentGeneration(conversationId, tail)) return

    // FR-005 的備忘 —— 手動重試時據此走單段，不再發第二次檢索
    tail.lastRetrieval = { anchor: ctx.anchor, hits, at: nowIso() }

    if (hits.length === 0) {
      // 落定 ①：知識庫本次未命中 —— 沒有第二段可跑，模型回卡數記 0
      auditSettlement(conversationId, ctx.anchor, 2, 0, { cards: [], retryAttempt: 0, audit: { cardsReturned: 0, invalidSopIds: [] } })
      await settleNone(conversationId, tail, { anchor: ctx.anchor, hitCount: 0 })
      return
    }

    // FR-006a：檢索有命中，第一段的產出已經注定要被換掉 —— 擋下它**尚未送出**的重試。
    // ⚠️ 用 `stage1Abort`，不是 `tailAbort`（兩者的標的相反，見 SuggestionTail 的註解）。
    tail.stage1Abort.abort()

    // ⚠️ 送出前檢查：LEAVE（`cancelSuggestionTail()`）或新世代已經作廢這條尾巴時，
    //    第二段一個字都不該送出去 —— 沒有人 JOIN 的對話不該再花這筆錢。
    if (tail.tailAbort.signal.aborted) return

    let generated: GeneratedCards
    try {
      // ⚠️ `maxRetries: 0`（FR-014：每批最壞 4 次呼叫）、**MUST NOT 傳 `onRetry`**——
      //    第二段失敗依 FR-003 是靜默的，閃出「重試中」等於對客服說謊。
      generated = await generateSuggestionCards(input, hits, {
        maxRetries: 0,
        callTimeoutMs: SUGGESTION_STAGE2_CALL_TIMEOUT_MS,
        signal: tail.tailAbort.signal,
      })
    }
    catch (err) {
      if (err instanceof RetryAbortedError) return // LEAVE／新世代：靜默丟棄，不是落定
      logFailure(conversationId, 'suggestions', err instanceof RetryExhaustedError ? err.kind : 'permanent', err)
      // 落定 ⑤：第二段失敗（FR-016 的靜默 none）—— 畫面上與「未命中」一模一樣，只有事件分得出來
      if (isCurrentGeneration(conversationId, tail)) auditSettlement(conversationId, ctx.anchor, 2, hits.length, null)
      await settleNone(conversationId, tail, { anchor: ctx.anchor, hitCount: hits.length, cause: err })
      return
    }
    const cards = generated.cards

    // 落定 ②③④：命中了但未引用／被白名單捨棄／模型未回卡 —— 由數字推導 outcome
    if (isCurrentGeneration(conversationId, tail)) auditSettlement(conversationId, ctx.anchor, 2, hits.length, generated)

    // 全數遭白名單捨棄（模型杜撰引用）——第一段的卡維持不動，標示落定為「未引用」。
    // `hitCount` 記真實命中數，讓「有命中卻沒引用」在事後稽核時分辨得出來（data-model.md §3）。
    if (cards.length === 0) {
      await settleNone(conversationId, tail, { anchor: ctx.anchor, hitCount: hits.length })
      return
    }
    if (!isCurrentGeneration(conversationId, tail)) return

    tail.citedLanded = true

    /**
     * FR-015：整批換卡前重放尾巴等待期間抵達的搶答標記。
     *
     * ⚠️ 順序 MUST 在白名單與 `confidence` 歸零**之後**（`generateSuggestionCards()` 內已做完）——
     *    搶答標記是對「最終要顯示的卡」下的判斷，對已被捨棄的卡標記沒有意義。
     * ⚠️ 漏了這一步，同事已經回過的建議會以未標記的新卡復活，客服可能重複回覆客戶
     *    （憲法 7.2），而 `status` 仍是 `ready` —— 不報錯。
     */
    let finalCards = cards
    for (const reply of tail.repliesDuringTail) finalCards = markSupersededCards(finalCards, reply)

    await publishSuggestionReady(conversationId, {
      cards: finalCards,
      knowledgeSearch: { ran: true, hitCount: hits.length },
      citation: 'cited',
      basedOnMessageId: ctx.anchor,
      // 沿用第一段的重試次數，讓「這批訊息總共呼叫幾次」＝ 1 + n + 1 可從單一 block 讀出
      provenance: { stage: 2, stage1RetryAttempt: tail.stage1RetryAttempt },
    })
  }
  catch (err) {
    // 尾巴自己爆掉 MUST NOT 影響任何其他路徑（憲法 3.2）——第一段的卡仍在畫面上。
    console.error(`[copilot-analysis] ${conversationId} 建議卡第二段異常:`, err instanceof Error ? err.message : String(err))
  }
  finally {
    concludeTail(conversationId, tail)
  }
}

/**
 * 把 `citation` 落定為 `'none'`（FR-003a）。三條落定路徑共用：
 * 檢索 0 筆／檢索失敗或逾時／第二段失敗、逾時或全數遭白名單捨棄。
 *
 * ⚠️ **兩條收斂規則都不會報錯，漏掉只會安靜地做錯事。**
 */
async function settleNone(
  conversationId: string,
  tail: SuggestionTail,
  args: { anchor: string | null, hitCount: number, cause?: unknown },
): Promise<void> {
  /**
   * ① MUST 先等第一段落定。
   *
   * 不等的話，第一段隨後落地會把標示寫回 `'pending'`，而該輪檢索已經結束、
   * 沒有任何路徑再落定它 —— 客服永遠看到「檢索中」，而 `status` 是 `ready`、卡片可用，
   * **沒有任何錯誤跡象**。這個交錯實測不罕見（檢索最快 9.4 秒 vs 第一段中位 9.2 秒），
   * 不是理論邊界。`'none' → 'pending'` 不是合法序列（data-model.md §2 不變量 1）。
   */
  const stage1 = await tail.stage1Settled
  if (!isCurrentGeneration(conversationId, tail)) return

  /**
   * ② 第一段被取消（從未發布）而第二段又失敗時 MUST 轉 error。
   *
   * 此時 `cards` 是空的、`status` 停在 `'analyzing'`／`'retrying'`，畫面永遠是「重試中 (n/2)」。
   * FR-003「第二段失敗 MUST NOT 轉 error」的前提是「客服已有第一批卡」，這條路徑下前提不成立；
   * 錯誤狀態＋重試按鈕才誠實，而且該次重試會走 FR-005 的單段（快）。
   */
  if (stage1.kind === 'aborted') {
    await finishBlockError(conversationId, 'suggestions', args.cause, args.anchor)
    return
  }
  // 第一段已經 finishBlockError()：區塊是 error，MUST NOT 把它改回 ready（contracts §2）
  if (stage1.kind === 'failed') return

  // 'landed'：只改標示與命中數，**cards 一張都不動**（FR-003）
  const next = await updateAnalysisState(conversationId, state => ({
    ...state,
    suggestionBlock: {
      ...state.suggestionBlock,
      citation: 'none' as const,
      knowledgeSearch: { ran: true, hitCount: args.hitCount },
      updatedAt: nowIso(),
    },
  }))
  await publishBlock(conversationId, 'suggestions', next)
}

/**
 * 結束尾巴的等待。**登記本身刻意保留**——`lastRetrieval` 要留給手動重試（FR-005）；
 * 它的回收點在本檔的 `cancelSuggestionTail()`（由 `copilot-analysis.ts::cancelPendingAnalysis()` 於 LEAVE 時呼叫）。
 */
function concludeTail(conversationId: string, tail: SuggestionTail): void {
  tail.finishTail()
  if (suggestionTailDone.get(conversationId) === tail.done) suggestionTailDone.delete(conversationId)
}

/**
 * 單段：等檢索完成，再以命中結果一次生成（背景對話 FR-013、命中已在手 FR-005）。
 *
 * @param presetHits 已完成的檢索結果（FR-005 的備忘）。有值時 MUST NOT 再發一次檢索——
 *   同一批訊息、同一個 query，知識庫在數十秒內不會改變。
 */
async function runSingleStage(
  conversationId: string,
  input: { history: Message[], aiReplies: boolean },
  ctx: { anchor: string | null, query: string, presetHits?: KnowledgeHit[] },
): Promise<void> {
  let knowledgeHits: KnowledgeHit[] = ctx.presetHits ?? []
  if (!ctx.presetHits) {
    try {
      // ⚠️ **2026-08-29（004 FR-003）**：與快查共用 `KNOWLEDGE_SEARCH_TIMEOUT_MS`。
      //    原本這裡帶的是建議卡專用的 8 秒短逾時常數（已刪除），理由是保護
      //    「先檢索再生成」這條**串行**路徑的門檻；而實測檢索最快 9.4 秒，
      //    那個上限等於建議卡永遠拿不到引用。MUST NOT 為建議卡另立第二個逾時值。
      knowledgeHits = await useKnowledgeProvider().search(ctx.query, {
        topK: 5,
        timeoutMs: KNOWLEDGE_SEARCH_TIMEOUT_MS,
      })
    }
    catch (err) {
      // FR-004：檢索失敗時以空集合續行（誠實降級，非整塊轉 error）——
      // 憲法 6.2 禁止的是「略過檢索」，不是「結果是空的」
      console.error(`[copilot-analysis] ${conversationId} 知識庫檢索失敗，改以無引用續行:`, err instanceof Error ? err.message : String(err))
    }
  }
  // 檢索呼叫**送出後**即視為已跑過，無論結果多寡或是否拋錯 —— 憲法 6.2 要求的可稽核證據
  const knowledgeSearch = { ran: true, hitCount: knowledgeHits.length }

  try {
    const generated = await generateSuggestionCards(input, knowledgeHits, {
      onRetry: info => publishRetrying(conversationId, 'suggestions', info),
    })
    // 落定（單段：背景、命中已在手）—— 契約把單段記為 stage 1
    auditSettlement(conversationId, ctx.anchor, 1, knowledgeHits.length, generated)

    await publishSuggestionReady(conversationId, {
      cards: generated.cards,
      knowledgeSearch,
      citation: knowledgeHits.length > 0 ? 'cited' : 'none',
      basedOnMessageId: ctx.anchor,
      // 單段沒有第一段，`stage1RetryAttempt` 恆為 0（data-model.md §1）
      provenance: { stage: 2, stage1RetryAttempt: 0 },
    })
  }
  catch (err) {
    // 單段失敗會轉 error（有重試按鈕），但它同樣是一次落定 —— 個案排查要查得到
    auditSettlement(conversationId, ctx.anchor, 1, knowledgeHits.length, null)
    await finishBlockError(conversationId, 'suggestions', err, ctx.anchor)
  }
}
