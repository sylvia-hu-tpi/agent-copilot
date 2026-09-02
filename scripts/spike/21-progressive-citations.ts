/**
 * 21 — 冷啟動三區塊的端到端量測（004 T032：SC-001／SC-002 的驗收證據）
 *
 * 量什麼：對真實對話跑**生產路徑**的冷啟動分析，記錄
 *   - 第一段落地（`citation: 'pending'`）的毫秒數 → 004 SC-001（p90 ≤ 20 秒）
 *   - 第二段落定（`'cited'`／`'none'`）的毫秒數 → 契約 §2 的 50 秒上限
 *   - 多段對話中最終取得 `'cited'` 的比例 → 004 SC-002（知識庫有內容時 ≥ 90%）
 *   - **摘要區塊與情緒區塊各自 `ready` 的毫秒數 → 001 SC-005（p90 ≤ 10 秒）**
 *
 * ⚠️ **摘要／情緒那兩筆是 2026-09-01 才補上的，補的是 M2 驗收清單裡唯一沒有實測的一項。**
 *    先前只量得到單一 agent 的延遲（`spike:agent-latency`），而 SC-005 的判準是
 *    「**區塊**的實質內容何時呈現」——摘要是 1 次呼叫，情緒卻是每
 *    `SENTIMENT_CHUNK_SIZE`（6）則客戶發言切一批各自呼叫，兩者的關係不是
 *    「乘上一個常數」，長對話的情緒區塊會遠慢於單次呼叫的延遲。
 *    用單一 agent 的數字去推 SC-005 會系統性低估，那正是這一項一直沒被驗掉的原因。
 *
 * ⚠️ **2026-09-01 起情緒批次改為有上限的並行**（`SENTIMENT_CONCURRENCY`）。
 *    因此本腳本同時記錄**每一次呼叫的延遲與成敗**（`sentimentCalls`）與**峰值並發**：
 *    並行會壓低區塊總時間，但可能因平台側排隊而抬高單次延遲，一旦單次破 FR-014 的
 *    15 秒就觸發重試。**只看總時間會看到「變快了」而完全看不到失敗率上升**，
 *    兩者必須一起看 —— 這正是這次改動唯一需要把關的風險。
 *
 * ⚠️ 情緒的 `ready` 取的是**分數落地那一刻**，不含之後才補的 `narrative`
 *    （§8.2b「分數先發、敘述後補」）—— 判準要的是折線何時看得到，散文是附加物。
 *
 * ⚠️ **走生產路徑的 `runColdStart()`，不自行組裝兩段流程**（比照 18／20 號的同一個理由）：
 *    世代、尾巴、白名單、`confidence` 歸零、FR-005 的檢索備忘都與正式路徑同一份程式碼，
 *    自行重組只會量到另一件事。連帶代價是每段對話也會跑摘要與情緒（各自的 AI 呼叫）——
 *    那正是真實 JOIN 的成本，刻意不省。
 *
 * ⚠️ **輸出不含任何訊息或卡片文字**（憲法 1.5）：只有毫秒數、命中數、卡片張數與狀態。
 *
 * ── 三種模式 ────────────────────────────────────────────────────
 *
 *   npm run spike:progressive -- --inspect "標題A" "標題B"
 *       **完全唯讀、不呼叫任何 AI**。把標題解析成對話 id，印出現況（status／mode／訊息數）
 *       與「`--join` 會做什麼」。動任何寫入之前**先跑這個**。
 *
 *   npm run spike:progressive -- "標題A" "標題B"
 *       唯讀量測：只 GET 對話與訊息，在本機記憶體跑分析。**不 JOIN、不寫入正式環境。**
 *       起點是「分析啟動」而非「客服按下 JOIN」，兩者差一次讀訊息的往返（另記 `fetchMs`）。
 *
 *   npm run spike:progressive -- --join "標題A" "標題B"
 *       ⚠️ **會對正式環境寫入**：走 T032 要求的真 JOIN 流程 —— 真的 JOIN、量測它觸發的
 *       冷啟動、再 LEAVE。起點就是 JOIN 送出的那一刻，與 SC-001 的定義完全對齊。
 *
 *   npm run spike:progressive -- --repeat 5 "標題A" "標題B"
 *       唯讀模式下把每段對話重跑 N 輪，總樣本數 ＝ 對話數 × N。
 *       ⚠️ **p90 判準下 n 太小會給出方向隨機的結論**（§8.2b：同一支 probe 在 n=3 時
 *          先後給過方向相反的兩個答案，n=5 才穩定）。SC-005 與 SC-001 都是 p90，
 *          **MUST 湊到 n≥15 再下結論**，而可用的對話往往不到 15 段，這個旗標就是補位用的。
 *       ⚠️ 第 2 輪起改用「同一段歷史、另一個狀態鍵」重跑，等同一次全新的冷啟動：
 *          沿用同一個鍵會讓 FR-005 的檢索備忘生效而**跳過檢索**（那是刻意的正確行為），
 *          第二段時序就不再是冷啟動的時序了。`--join` 不支援本旗標（會重複寫入正式環境）。
 *
 * ⚠️⚠️ **`--join` 的不可逆副作用，動手前必須知道**（§10.2）：
 *    `mode` 是**對話層級的共用狀態**，不是本地偏好。JOIN 會 `null → manual`，
 *    LEAVE 會 `manual → automation` —— 也就是說**跑完之後對話停在 `automation`，
 *    不保證回到原本的值**。原本是 `null` 的對話會就此變成「AI 可自動回覆」。
 *    因此本腳本：
 *      ① `mode ∈ {manual, hybrid}` 的對話**一律拒絕**——那代表有人正在處理它（§10.2 ③），
 *         JOIN 進去等於介入同事的現場；
 *      ② 每一段都印出 JOIN 前後的 `mode`，讓變動有紀錄可查；
 *      ③ 無論成功失敗都在 `finally` 裡 LEAVE。
 *
 * 目標對話可以給**標題**（會用 `conversations.search()` 解析，需唯一命中）或直接給 id；
 * 都不給時退回 `.env.local` 的 `SPIKE_CONVERSATION_IDS`（逗號分隔）／`SPIKE_CONVERSATION_ID`。
 */

import type { ImbraceClient, Conversation as SdkConversation } from '@imbrace/sdk'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { businessUnitId, env, isMain, loadEnv, makeClient, OUT_DIR, ROOT, SkipProbe } from './lib/harness.js'
import { setAIProvider, useAIProvider } from '../../server/services/ai/index.js'
import { setKnowledgeProvider, useKnowledgeProvider } from '../../server/services/knowledge/index.js'
import { whitelistFilter } from '../../server/services/copilot-analysis.js'
import type { AIProvider, SuggestionCard } from '../../shared/types/copilot.js'
import type { KnowledgeHit, KnowledgeProvider } from '../../shared/types/knowledge.js'
import { normalizeConversationId, toConversation, unwrapPaged } from '../../server/sources/mappers.js'
import { fetchLatest } from '../../server/sources/message-fetch.js'
import { getConversationDetail, joinConversation, leaveConversation } from '../../server/services/imbrace.js'
import { awaitSuggestionTail, isTextCustomerMessage, runColdStart, SENTIMENT_CHUNK_SIZE } from '../../server/services/copilot-analysis.js'
import { CALL_TIMEOUT_MS as AI_CALL_TIMEOUT_MS } from '../../server/services/ai/retry-policy.js'
import { useEventBus, useStateStore } from '../../server/state/index.js'
import { conversationTopic } from '../../server/state/types.js'
import { controlFromMode } from '../../shared/types/conversation.js'
import type { ConversationMode } from '../../shared/types/conversation.js'
import type { CopilotEvent } from '../../shared/types/events.js'

/** 004 SC-001：第一批卡 90% 在 20 秒內（002 SC-001 的建議卡門檻，2026-08-29 由 10 秒修訂） */
const SC001_BUDGET_MS = 20_000
/** 契約 §2 的第二段上限：30 秒檢索 ＋ 20 秒生成 */
const STAGE2_BUDGET_MS = 50_000
/** 004 SC-002：知識庫有內容時 ≥ 90% 最終取得引用 */
const SC002_CITED_RATIO = 0.9
/**
 * 001 SC-005 的**摘要**門檻：10 秒（`docs/ARCHITECTURE.md` §18 M2 驗收第 3 項）。
 *
 * ⚠️ **MUST NOT 因為量出來過不了就把這個數字改掉。** 放寬一律要先經過裁決並寫回 §18 M2；
 *    工具擅自放寬等於把判準改成「一定會通過」。
 */
const SC005_SUMMARY_BUDGET_MS = 10_000

/**
 * 001 SC-005 的**情緒**門檻：15 秒（§18 M2 驗收第 2 項）。
 *
 * ⚠️ **兩個區塊的門檻不同，先前本腳本兩者共用 10 秒是錯的**（2026-09-02 修正）：
 *    情緒已於 2026-09-01 經裁決由 10 秒改為 15 秒 —— 而且是**連程式一起改**
 *    （`SENTIMENT_CONCURRENCY = 3`），不是單純放寬。腳本沒跟上，於是 2026-09-02 的量測
 *    把情緒判成 ❌ 未達，判的卻是一個已經被取代的門檻。
 *
 * ⚠️ 15 秒**不是對所有長度成立**：§18 M2 已載明 50 則客戶發言（9 批＝3 波）約 20 秒會破。
 *    判讀本列時 MUST 一併看 `sentimentChunks`。
 */
const SC005_SENTIMENT_BUDGET_MS = 15_000

/** JOIN 的模式：與官方介面、與我方 `join.post.ts` 的預設一致（§10.5） */
const JOIN_MODE = 'manual' as const

interface Target {
  /** 使用者給的原始字串（標題或 id），用於報告 */
  input: string
  conversationId: string
  title: string
  status?: string
  mode: ConversationMode | null
  teamConversationId?: string
}

interface Sample {
  conversationId: string
  title: string
  /** 第幾輪（`--repeat`）。1 代表單輪，與舊有的量測結果同義 */
  round: number
  /** 'join' = 真的 JOIN 過；'readonly' = 只讀不寫 */
  method: 'join' | 'readonly'
  modeBefore: ConversationMode | null
  modeAfter?: ConversationMode | null
  /** 讀取訊息的往返時間。唯讀模式下 SC-001 若要從 JOIN 起算，把它加上去 */
  fetchMs: number
  messageCount: number
  customerMessageCount: number
  /**
   * **客服看到第一批可用建議卡**的毫秒數 → 002 SC-001 的判準本身。
   *
   * ⚠️ **這才是 SC-001，`pendingMs` 不是。** 兩者在多數樣本上相等，因此很容易誤用；
   *    但有一整類樣本兩者不等，而那類樣本恰好全部是慢的：
   *    檢索先回且有命中時，FR-006a 會 `stage1Abort.abort()` 掉第一段**尚未送出**的重試，
   *    第一段從此不再發布 —— `pendingMs` 永遠是 null，客服實際看到的第一批卡是第二段
   *    在 27～35 秒給的那批。用 `pendingMs` 統計等於把這些樣本整筆丟掉，
   *    量出來的 SC-001 會**系統性偏樂觀**（2026-09-01 的三輪：報表 83%／86%／71%，
   *    實際 67%／40%／33%）。
   */
  firstCardsMs: number | null
  /** 第一段落地（`citation: 'pending'`）距起點的毫秒數；沒有 pending 時為 null。⚠️ 診斷用，判 SC-001 請用 `firstCardsMs` */
  pendingMs: number | null
  /** 第二段落定（cited／none）的毫秒數 */
  settledMs: number | null
  /** 摘要區塊 `ready` 的毫秒數 → 001 SC-005。轉 error 時為 null */
  summaryReadyMs: number | null
  /**
   * 情緒區塊 `ready` 的毫秒數 → 001 SC-005。
   * ⚠️ 是**分數落地**那一刻，不含之後才補的 `narrative`（§8.2b）
   */
  sentimentReadyMs: number | null
  /** 情緒實際切了幾批（`SENTIMENT_CHUNK_SIZE`）—— 判讀 sentimentReadyMs 時的關鍵分母 */
  sentimentChunks: number | null
  /** 情緒的每一次呼叫（含重試的每次嘗試）—— 並行化的風險就藏在這裡，見 instrumentProviders */
  sentimentCalls?: Array<{ elapsedMs: number, ok: boolean, errorName?: string }>
  /** 同時在飛的情緒呼叫數峰值。依序版本恆為 1；並行版本應等於 min(批次數, 並行上限) */
  sentimentPeakInFlight?: number
  finalCitation: 'pending' | 'cited' | 'none' | null
  finalStatus: string | null
  hitCount: number | null
  cardCount: number | null
  provenance: { stage: 1 | 2, stage1RetryAttempt: number } | null
  /** `status/citation` 的完整序列 —— 契約 §2 的那張表就是照這個形狀寫的 */
  sequence: string[]
  /** 檢索耗時與命中數（每輪一次） */
  retrievals?: Array<{ elapsedMs: number, hitCount: number }>
  /** 第二段的原始輸出診斷 —— 「命中卻沒引用」的成因就靠它判讀（見 Stage2Trace） */
  stage2?: Stage2Trace[]
  error?: string
}

/**
 * 第二段到底發生了什麼 —— **T032 判讀 SC-002 未達的關鍵**。
 *
 * 「命中 > 0 卻落成 `none`」有三個成因，處置完全不同，而它們在事件序列上長得一模一樣：
 *   - `timeout`／`failed`  → 第二段沒回來或報錯 → 依 T032 回頭重議 `SUGGESTION_STAGE2_CALL_TIMEOUT_MS`（T011）
 *   - `whitelisted-out`    → 第二段回來了，但卡片的 `sopId` 全不在本次命中集合＝**模型杜撰引用**
 *                            → 是 prompt／agent 的問題，**與逾時無關，改常數沒有用**
 *   - `empty-output`       → 模型回了 0 張卡
 * 少了這一層，只能靠「日誌有沒有印錯誤」反推，那是猜測不是證據。
 */
interface Stage2Trace {
  /** 第二段呼叫送出時距起點的毫秒數 */
  startedAtMs: number
  elapsedMs: number
  /** 傳入第二段的命中數 */
  hitCount: number
  /** 模型回傳的原始卡數（Zod 之後、白名單之前） */
  rawCardCount?: number
  /** 通過白名單的卡數 */
  keptCardCount?: number
  /** 模型宣稱引用的 sopId 是否都在命中集合裡；false 即為杜撰 */
  sopIdsAllValid?: boolean
  /**
   * 杜撰的 `sopId` 長什麼形狀 —— 決定「調 prompt 能不能修」的關鍵，**只記形狀不記值**：
   *   - `used-title`      → 填了命中結果的**標題**而不是 id（模型看得到資料，只是選錯欄位
   *                         → 調 prompt 有機會修）
   *   - `truncated-id`    → 是某個命中 id 的前綴／子字串（複製時被截斷 → 同上）
   *   - `unknown-id-like` → 形狀像 id 但完全不在命中集合裡（純粹編造 → 調 prompt 未必有用）
   *   - `other`           → 其餘
   */
  invalidSopIdShapes?: string[]
  outcome: 'ok' | 'whitelisted-out' | 'empty-output' | 'failed'
  errorName?: string
  errorMessage?: string
}

/**
 * 把真實 provider 包一層，**只觀察不改行為**：記錄檢索耗時與第二段的原始輸出。
 * 判別兩段的方式與 `test/copilot-analysis.test.ts` 相同——第一段的 `knowledgeHits` 恆為空集合。
 */
function instrumentProviders(startedAt: () => number) {
  const retrievals: Array<{ elapsedMs: number, hitCount: number }> = []
  const stage2: Stage2Trace[] = []
  /**
   * 情緒的**每一次呼叫**（含 `withRetry()` 的每一次嘗試）。
   *
   * ⚠️ 2026-09-01 新增，為的是把關「批次由依序改為並行」那次改動的**風險面**：
   *    並發可能讓平台側排隊而抬高單次延遲，一旦單次破 FR-014 的 15 秒就觸發重試。
   *    只看區塊的總時間會看到「變快了」而完全看不到這件事 ——
   *    **總時間與單次延遲必須一起量，否則量到的是一半的事實。**
   */
  const sentimentCalls: Array<{ elapsedMs: number, ok: boolean, errorName?: string }> = []
  let sentimentInFlight = 0
  let sentimentPeakInFlight = 0

  const realAI = useAIProvider()
  const realKnowledge = useKnowledgeProvider()

  const knowledge: KnowledgeProvider = {
    async search(query, opts) {
      const t0 = Date.now()
      try {
        const hits = await realKnowledge.search(query, opts)
        retrievals.push({ elapsedMs: Date.now() - t0, hitCount: hits.length })
        return hits
      }
      catch (err) {
        retrievals.push({ elapsedMs: Date.now() - t0, hitCount: -1 })
        throw err
      }
    },
  }

  const ai: AIProvider = {
    summarize: input => realAI.summarize(input),
    async analyzeSentiment(input) {
      sentimentInFlight++
      sentimentPeakInFlight = Math.max(sentimentPeakInFlight, sentimentInFlight)
      const t0 = Date.now()
      try {
        const points = await realAI.analyzeSentiment(input)
        sentimentCalls.push({ elapsedMs: Date.now() - t0, ok: true })
        return points
      }
      catch (err) {
        sentimentCalls.push({
          elapsedMs: Date.now() - t0,
          ok: false,
          errorName: err instanceof Error ? err.constructor.name : typeof err,
        })
        throw err
      }
      finally {
        sentimentInFlight--
      }
    },
    // ⚠️ 走勢敘述與評分共用同一個 agent，但它是另一個方法、也不在 SC-005 的判準內，
    //    刻意不計入 `sentimentCalls` —— 混進去會讓「每批延遲」多出一筆性質不同的樣本
    narrateSentiment: input => realAI.narrateSentiment(input),
    async suggest(input) {
      const hits: KnowledgeHit[] = input.knowledgeHits
      if (hits.length === 0) return realAI.suggest(input) // 第一段，不記錄

      const t0 = Date.now()
      const trace: Stage2Trace = {
        startedAtMs: t0 - startedAt(),
        elapsedMs: 0,
        hitCount: hits.length,
        outcome: 'ok',
      }
      stage2.push(trace)
      try {
        const cards: SuggestionCard[] = await realAI.suggest(input)
        trace.elapsedMs = Date.now() - t0
        trace.rawCardCount = cards.length
        // ⚠️ 用生產的 `whitelistFilter()`，不自己重寫一份判斷（重寫就量到另一件事）
        const kept = whitelistFilter(cards, hits)
        trace.keptCardCount = kept.length
        const validIds = new Set(hits.map(h => h.id))
        trace.sopIdsAllValid = cards.every(c => c.sopId === null || validIds.has(c.sopId))
        const invalid = cards.map(c => c.sopId).filter((v): v is string => typeof v === 'string' && !validIds.has(v))
        trace.invalidSopIdShapes = invalid.map((bad) => {
          if (hits.some(h => h.title === bad)) return 'used-title'
          if (hits.some(h => h.id.includes(bad) || bad.includes(h.id))) return 'truncated-id'
          if (hits.some(h => h.title.includes(bad) || bad.includes(h.title))) return 'used-title'
          return /^[\w-]{8,}$/.test(bad) ? 'unknown-id-like' : 'other'
        })
        trace.outcome = cards.length === 0 ? 'empty-output' : kept.length === 0 ? 'whitelisted-out' : 'ok'
        return cards
      }
      catch (err) {
        trace.elapsedMs = Date.now() - t0
        trace.outcome = 'failed'
        trace.errorName = err instanceof Error ? err.constructor.name : typeof err
        trace.errorMessage = err instanceof Error ? err.message : String(err)
        throw err
      }
    },
  }

  setKnowledgeProvider(knowledge)
  setAIProvider(ai)

  return {
    read: () => ({
      retrievals: [...retrievals],
      stage2: [...stage2],
      sentimentCalls: [...sentimentCalls],
      sentimentPeakInFlight,
    }),
    restore: () => { setAIProvider(realAI); setKnowledgeProvider(realKnowledge) },
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

/** `p90Ms` 為 null＝第 90 百分位的樣本根本沒落地（見 budgetStats），比任何門檻都糟 */
function fmtP90(ms: number | null): string {
  return ms === null ? '未落地（比門檻更糟）' : `${ms}ms`
}

/** 通過率的百分比文字 —— 判準是比率，先前的報表只印 p90，看不出分母被抽掉 */
function pctText(st: { withinBudget: number, total: number }): string {
  return st.total > 0 ? `${(st.withinBudget / st.total * 100).toFixed(0)}%` : '—'
}

/**
 * 逐筆列印時直接標出有沒有超過**該區塊**的 SC-005 門檻 —— 只看彙總的 p90 會漏掉「哪一段慢」。
 * ⚠️ `budgetMs` MUST 由呼叫端傳入：摘要 10 秒、情緒 15 秒，兩者不同。
 */
function fmtBudget(ms: number | null, budgetMs: number): string {
  if (ms === null) return '—（未落地）'
  return `${ms}ms${ms > budgetMs ? ' ⚠️超' : ''}`
}

/**
 * 一組延遲樣本對某個 p90 門檻的判定 —— SC-001／SC-005 三列共用同一份算法。
 *
 * ⚠️ **未落地的樣本（轉 error、被 abort、從未出現）算「未達」，MUST NOT 排除。**
 *    2026-09-02 修正：舊版的 `pass` 只對已落地的值取 p90，等於把「客服根本沒看到內容」
 *    這個**最壞**的結果從分母裡拿掉——失敗率越高，分數反而越好看。
 *    2026-09-01 三輪的 SC-001 因此被報成 83%／86%／71%，實際是 67%／40%／33%。
 *
 *    正確定義：門檻是「≥ 90% 的樣本在預算內」。已落地的值由小到大排，未落地的一律排在
 *    最後面（視為 +∞），第 90 百分位落在未落地那一段時 `p90Ms` 為 `null`。
 *
 * @param n 分母＝**可用樣本總數**，不是 `values.length`
 */
function budgetStats(values: number[], budgetMs: number, n: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const withinBudget = sorted.filter(v => v <= budgetMs).length
  // 第 90 百分位在「已落地值 ++ 未落地(+∞)」這個長度 n 的序列上的索引
  const p90Index = Math.ceil(0.9 * n) - 1
  return {
    n: sorted.length,
    /** 沒落地的樣本數：轉 error 或未完成。⚠️ 它們算未達，並且**進**分母 */
    missing: n - sorted.length,
    medianMs: percentile(sorted, 0.5),
    /** `null` = 第 90 百分位的那個樣本根本沒落地（比任何門檻都糟） */
    p90Ms: p90Index < sorted.length ? sorted[p90Index]! : null,
    maxMs: sorted[sorted.length - 1] ?? 0,
    withinBudget,
    /** 分母是可用樣本總數 —— 這一欄就是 `missing` 為什麼不能被排除的地方 */
    total: n,
    budgetMs,
    pass: n > 0 && withinBudget / n >= 0.9,
  }
}

function looksLikeConversationId(s: string): boolean {
  return /^conv_/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// ── 目標解析（標題 → id）────────────────────────────────────────

/**
 * 用標題找對話。⚠️ 必須**唯一命中**才接受 —— 標題重複時猜錯的代價是對錯誤的對話 JOIN，
 * 那是對真實客戶對話的寫入，不可以靠運氣。
 */
async function resolveByTitle(client: ImbraceClient, buId: string, title: string): Promise<Target> {
  const res = await client.conversations.search({ businessUnitId: buId, q: title, limit: 50, skip: 0 })
  const items = unwrapPaged<SdkConversation>(res).map(toConversation)
  const exact = items.filter(c => c.name === title)
  const partial = items.filter(c => (c.name ?? '').includes(title))
  const hits = exact.length > 0 ? exact : partial

  if (hits.length === 0) throw new SkipProbe(`找不到標題含「${title}」的對話`)
  if (hits.length > 1) {
    const list = hits.slice(0, 5).map(c => `「${c.name}」(${c.id})`).join('、')
    throw new SkipProbe(`標題「${title}」命中 ${hits.length} 段，無法判斷是哪一段：${list}`)
  }

  const c = hits[0]!
  return { input: title, conversationId: c.id, title: c.name ?? '(無標題)', status: c.status, mode: c.mode ?? null }
}

/** 補上詳情才有的欄位（`tcu_` id 與最新的 mode）—— JOIN／LEAVE 一定要 `tcu_` id（§10.6 ①） */
async function enrich(client: ImbraceClient, target: Target): Promise<Target> {
  const raw = await getConversationDetail(client, target.conversationId)
  if (!raw) return target
  const conv = toConversation(raw as unknown as Parameters<typeof toConversation>[0])
  // ⚠️ 與 `loadConversationContext()` 同一段推導：詳情的 id 是 tcu_，而 mapper 只在
  //    `raw.id` 以 tcu_ 開頭時才填 —— 這裡不另立第二套推導邏輯。
  let tcu = conv.teamConversationId
  if (!tcu) {
    const fallback = (raw as { _id?: unknown, id?: unknown })._id ?? (raw as { id?: unknown }).id
    if (typeof fallback === 'string' && fallback.startsWith('tcu_')) tcu = fallback
  }
  return {
    ...target,
    title: conv.name ?? target.title,
    status: conv.status ?? target.status,
    mode: conv.mode ?? target.mode,
    teamConversationId: tcu,
  }
}

async function resolveTargets(client: ImbraceClient, inputs: string[]): Promise<Target[]> {
  const buId = await businessUnitId(client)
  const out: Target[] = []
  for (const input of inputs) {
    const base = looksLikeConversationId(input)
      ? { input, conversationId: normalizeConversationId(input), title: '(待查)', mode: null as ConversationMode | null }
      : await resolveByTitle(client, buId, input)
    out.push(await enrich(client, base))
  }
  return out
}

// ── 量測 ────────────────────────────────────────────────────────

/**
 * 訂閱事件匯流排，把三個區塊的時序記下來。
 *
 * ⚠️ **時點一律取自事件，MUST NOT 在 `runColdStart()` 回來之後才讀狀態算。**
 *    `runColdStart()` 是 `Promise.all` 三個區塊，它 resolve 的時間是**最慢那一個**——
 *    用它當摘要或情緒的完成時間，會把建議卡第二段的等待算到它們頭上，
 *    量出來的 SC-005 會系統性高估且完全看不出來（三個區塊本來就是各自先行顯示的，
 *    FR-011）。事件是使用者實際看到內容的那一刻，也是判準說的那一刻。
 */
function watchAnalysis(conversationId: string, startedAt: () => number) {
  const sequence: string[] = []
  let firstCardsMs: number | null = null
  let pendingMs: number | null = null
  let settledMs: number | null = null
  let summaryReadyMs: number | null = null
  let sentimentReadyMs: number | null = null

  const off = useEventBus().subscribe(conversationTopic(conversationId), (payload) => {
    const evt = payload as CopilotEvent

    if (evt.type === 'summary.updated') {
      if (evt.summary.status === 'ready' && summaryReadyMs === null) summaryReadyMs = Date.now() - startedAt()
      return
    }

    if (evt.type === 'sentiment.updated') {
      // ⚠️ `narrative` 補上時會再發一次 `ready`，因此只認**第一次**——判準要的是折線
      //    何時看得到（§8.2b「分數先發、敘述後補」）。`=== null` 這個守衛就是那條規則。
      if (evt.sentiment.status === 'ready' && sentimentReadyMs === null) sentimentReadyMs = Date.now() - startedAt()
      return
    }

    if (evt.type !== 'suggestion.updated') return
    const block = evt.suggestion
    sequence.push(`${block.status}/${block.citation}`)
    if (block.status !== 'ready') return
    // ⚠️ 判準問的是「第一批**可用的卡**何時出現」，不問它由哪一段產生（見 Sample.firstCardsMs）
    if (firstCardsMs === null) firstCardsMs = Date.now() - startedAt()
    if (block.citation === 'pending' && pendingMs === null) pendingMs = Date.now() - startedAt()
    if (block.citation !== 'pending' && settledMs === null) settledMs = Date.now() - startedAt()
  })

  return { off, sequence, read: () => ({ firstCardsMs, pendingMs, settledMs, summaryReadyMs, sentimentReadyMs }) }
}

type SampleBase = Omit<
  Sample,
  'firstCardsMs' | 'pendingMs' | 'settledMs' | 'summaryReadyMs' | 'sentimentReadyMs' | 'sentimentChunks'
  | 'finalCitation' | 'finalStatus' | 'hitCount' | 'cardCount' | 'provenance' | 'sequence'
>

/** 三個時序欄位都取不到時的填充值 —— 早退路徑共用，避免每加一個欄位就要改好幾處 */
const EMPTY_TIMINGS = {
  firstCardsMs: null,
  pendingMs: null,
  settledMs: null,
  summaryReadyMs: null,
  sentimentReadyMs: null,
  sentimentChunks: null,
  finalCitation: null,
  finalStatus: null,
  hitCount: null,
  cardCount: null,
  provenance: null,
  sequence: [] as string[],
} satisfies Omit<Sample, keyof SampleBase | 'retrievals' | 'stage2' | 'error' | 'modeAfter'>

async function finishSample(
  stateKey: string,
  base: SampleBase,
  watcher: ReturnType<typeof watchAnalysis>,
  sentimentChunks: number | null,
  probes?: ReturnType<typeof instrumentProviders>,
): Promise<Sample> {
  const { firstCardsMs, pendingMs, settledMs, summaryReadyMs, sentimentReadyMs } = watcher.read()
  const block = (await useStateStore().getAnalysisState(stateKey))?.suggestionBlock ?? null
  const traces = probes?.read()
  return {
    ...base,
    retrievals: traces?.retrievals,
    stage2: traces?.stage2,
    sentimentCalls: traces?.sentimentCalls,
    sentimentPeakInFlight: traces?.sentimentPeakInFlight,
    firstCardsMs,
    pendingMs,
    settledMs,
    summaryReadyMs,
    sentimentReadyMs,
    sentimentChunks,
    finalCitation: block?.citation ?? null,
    finalStatus: block?.status ?? null,
    hitCount: block?.knowledgeSearch.hitCount ?? null,
    cardCount: block?.cards.length ?? null,
    provenance: block?.provenance ?? null,
    sequence: watcher.sequence,
  }
}

/**
 * 唯讀：只 GET，不 JOIN。起點是「分析啟動」。
 *
 * ⚠️ `round > 1` 時**改用另一個狀態鍵**（`<id>#r<n>`）跑同一段歷史。理由見檔頭的
 *    `--repeat` 說明：沿用同一個鍵會讓 FR-005 的檢索備忘生效而跳過檢索，
 *    量到的就不再是冷啟動。狀態鍵在分析管線裡只當 `StateStore` 的鍵與 EventBus 的 topic
 *    （檢索送的是訊息文字、不是 id），因此換一個鍵不會讓量測失真。
 */
async function measureReadOnly(client: ImbraceClient, target: Target, round = 1): Promise<Sample> {
  const stateKey = round === 1 ? target.conversationId : `${target.conversationId}#r${round}`
  const fetchStart = Date.now()
  const history = await fetchLatest(client, target.conversationId)
  const fetchMs = Date.now() - fetchStart

  const customerCount = history.filter(m => m.sender.type === 'customer').length
  const base = {
    conversationId: target.conversationId,
    title: target.title,
    round,
    method: 'readonly' as const,
    modeBefore: target.mode,
    fetchMs,
    messageCount: history.length,
    customerMessageCount: customerCount,
  }
  if (customerCount === 0) {
    return { ...base, ...EMPTY_TIMINGS, error: '沒有任何客戶發言，分析會維持 empty（FR-009）' }
  }

  // 情緒實際會切幾批 —— 用正式路徑的判別式與常數算，不自己抄一份（見兩者的 export 註解）
  const chunks = Math.ceil(history.filter(isTextCustomerMessage).length / SENTIMENT_CHUNK_SIZE)

  let startedAt = Date.now()
  const watcher = watchAnalysis(stateKey, () => startedAt)
  const probes = instrumentProviders(() => startedAt)
  try {
    startedAt = Date.now()
    await runColdStart(stateKey, history, false)
    await awaitSuggestionTail(stateKey)
  }
  finally {
    watcher.off()
    probes.restore()
  }
  return finishSample(stateKey, base, watcher, chunks, probes)
}

/**
 * T032 的嚴格路徑：**真的 JOIN**，量它觸發的冷啟動，再 LEAVE。
 *
 * ⚠️ 這裡刻意重現 `server/api/conversations/[id]/join.post.ts` 的 `triggerColdStartIfNeeded()`
 *    ——`fetchLatest()` → `runColdStart()`，`aiReplies` 一律由 `controlFromMode()` 推導
 *    （002 FR-016 的地雷，兩段都要帶）。差別只在少了 HTTP 與 presence 那幾層，
 *    它們不參與本腳本要量的兩段時序。
 */
async function measureWithJoin(client: ImbraceClient, target: Target): Promise<Sample> {
  const base = {
    conversationId: target.conversationId,
    title: target.title,
    round: 1,
    method: 'join' as const,
    modeBefore: target.mode,
    fetchMs: 0,
    messageCount: 0,
    customerMessageCount: 0,
  }
  const empty = EMPTY_TIMINGS

  if (!target.teamConversationId) {
    return { ...base, ...empty, error: '詳情裡沒有 tcu_ id，JOIN／LEAVE 都做不了（§10.6 ①）' }
  }
  // ⚠️ 護欄①：mode 為 manual／hybrid 代表「有人能送出訊息」＝有人正在處理（§10.2 ③）。
  //    JOIN 進去是介入同事的現場，一律拒絕。
  if (target.mode === 'manual' || target.mode === 'hybrid') {
    return { ...base, ...empty, error: `mode 為 ${target.mode} —— 代表有人正在處理這段對話，拒絕 JOIN（§10.2）` }
  }

  let startedAt = Date.now()
  const watcher = watchAnalysis(target.conversationId, () => startedAt)
  const probes = instrumentProviders(() => startedAt)
  let joined = false
  let chunks: number | null = null

  try {
    // ⚠️ 起點就是 JOIN 送出的那一刻 —— SC-001 的「JOIN 後 20 秒」就是從這裡算起
    startedAt = Date.now()
    await joinConversation(client, target.teamConversationId, JOIN_MODE)
    joined = true

    const fetchStart = Date.now()
    const history = await fetchLatest(client, target.conversationId)
    base.fetchMs = Date.now() - fetchStart
    base.messageCount = history.length
    base.customerMessageCount = history.filter(m => m.sender.type === 'customer').length

    if (base.customerMessageCount === 0) {
      return { ...base, ...empty, error: '沒有任何客戶發言，分析會維持 empty（FR-009）' }
    }
    chunks = Math.ceil(history.filter(isTextCustomerMessage).length / SENTIMENT_CHUNK_SIZE)

    await runColdStart(target.conversationId, history, controlFromMode(JOIN_MODE).aiReplies)
    await awaitSuggestionTail(target.conversationId)
  }
  finally {
    watcher.off()
    probes.restore()
    if (joined) {
      // ⚠️ 無論成功失敗都要離開。LEAVE 會把 mode 帶到 `automation`，**不保證回到原值**
      try {
        await leaveConversation(client, target.teamConversationId)
      }
      catch (err) {
        console.log(`     ⚠️ LEAVE 失敗，這段對話可能仍停在 ${JOIN_MODE}，請手動確認：`
          + (err instanceof Error ? err.message : String(err)))
      }
    }
  }

  const sample = await finishSample(target.conversationId, base, watcher, chunks, probes)
  const after = await enrich(client, target).catch(() => target)
  return { ...sample, modeAfter: after.mode }
}

// ── 主流程 ──────────────────────────────────────────────────────

function parseArgs(argv: string[]): { mode: 'inspect' | 'readonly' | 'join', inputs: string[], repeat: number } {
  const flags = argv.filter(a => a.startsWith('--'))
  const mode = flags.includes('--join') ? 'join' : flags.includes('--inspect') ? 'inspect' : 'readonly'

  // `--repeat N` 的 N 是下一個位置參數，要從 inputs 裡拿掉，否則會被當成對話標題去查
  const repeatAt = argv.indexOf('--repeat')
  const repeat = repeatAt >= 0 ? Math.max(1, Number(argv[repeatAt + 1] ?? 1) || 1) : 1
  const consumed = repeatAt >= 0 ? new Set([repeatAt + 1]) : new Set<number>()
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i))

  return { mode, inputs, repeat }
}

function fallbackInputs(): string[] {
  const raw = env('SPIKE_CONVERSATION_IDS') || env('SPIKE_CONVERSATION_ID')
  if (!raw) {
    throw new SkipProbe(
      '請以參數給對話標題或 id（例：npm run spike:progressive -- --inspect "標題A" "標題B"），'
      + '或在 .env.local 設定 SPIKE_CONVERSATION_IDS（逗號分隔，SC-002 的比例建議 10 段）',
    )
  }
  return [...new Set(raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean))]
}

async function main(): Promise<void> {
  loadEnv()
  const { mode, inputs, repeat } = parseArgs(process.argv.slice(2))
  const targetInputs = inputs.length > 0 ? inputs : fallbackInputs()
  const client = makeClient()

  if (repeat > 1 && mode === 'join') {
    // ⚠️ 每一輪都會 JOIN／LEAVE 一次真實對話並改動 mode，重複做是在正式環境上反覆寫入
    console.error('  ⛔ --repeat 不支援 --join：每一輪都會對正式環境 JOIN／LEAVE 並改動 mode。請改用唯讀模式。')
    process.exit(1)
  }

  console.log(`\n── 21 冷啟動三區塊端到端量測（004 T032 ＋ 001 SC-005）${'─'.repeat(10)}`)
  console.log(`   環境 ${env('IMBRACE_ENV', 'stable')}｜目標 ${targetInputs.length} 段`
    + `${repeat > 1 ? ` × ${repeat} 輪＝${targetInputs.length * repeat} 個樣本` : ''}｜模式 ${mode}`)
  console.log(mode === 'join'
    ? '   ⚠️ **會對正式環境寫入**：真的 JOIN → 量測 → LEAVE。LEAVE 後 mode 會停在 automation，不保證回到原值。'
    : '   唯讀：只 GET，不 JOIN、不送訊息、不切換 mode。')
  console.log('')

  const targets = await resolveTargets(client, targetInputs)

  // ── --inspect：完全唯讀，一次 AI 都不呼叫 ────────────────────
  if (mode === 'inspect') {
    console.log('  現況（尚未做任何事）：\n')
    for (const t of targets) {
      const blocked = t.mode === 'manual' || t.mode === 'hybrid'
      const noTcu = !t.teamConversationId
      console.log(`  ${blocked || noTcu ? '⛔' : '✅'} 「${t.title}」`)
      console.log(`     id=${t.conversationId}`)
      console.log(`     status=${t.status ?? '?'}｜mode=${t.mode ?? 'null'}｜tcu=${t.teamConversationId ? '有' : '**無**'}`)
      if (blocked) console.log('     ⛔ mode 顯示有人正在處理這段對話，--join 會拒絕它（§10.2）')
      if (noTcu) console.log('     ⛔ 沒有 tcu_ id，JOIN／LEAVE 做不了（§10.6 ①）')
      if (!blocked && !noTcu) console.log(`     --join 會做：JOIN(mode=${JOIN_MODE}) → 冷啟動分析 → LEAVE（結束後 mode 會是 automation）`)
      console.log('')
    }
    console.log('  下一步：確認無誤後加上 --join 實際執行，或不加旗標跑唯讀量測。\n')
    return
  }

  const samples: Sample[] = []
  const plan = Array.from({ length: repeat }, (_, r) => targets.map(t => ({ target: t, round: r + 1 }))).flat()
  for (const [i, { target, round }] of plan.entries()) {
    process.stdout.write(`  [${i + 1}/${plan.length}]${repeat > 1 ? ` 第 ${round} 輪` : ''} 「${target.title}」 … `)
    try {
      const sample = mode === 'join'
        ? await measureWithJoin(client, target)
        : await measureReadOnly(client, target, round)
      samples.push(sample)
      if (sample.error) {
        console.log(`⏭  ${sample.error}`)
      }
      else {
        console.log(
          `${sample.finalCitation === 'cited' ? '✅ cited' : `🟡 ${sample.finalCitation}`}`
          + `｜首批卡 ${sample.firstCardsMs ?? '—（從未出現）'}ms`
          + `｜第一段 ${sample.pendingMs ?? '—'}ms｜落定 ${sample.settledMs ?? '—'}ms`
          + `｜命中 ${sample.hitCount}｜卡 ${sample.cardCount} 張`
          + (sample.modeAfter !== undefined ? `｜mode ${sample.modeBefore ?? 'null'} → ${sample.modeAfter ?? 'null'}` : '')
          + `\n        摘要 ${fmtBudget(sample.summaryReadyMs, SC005_SUMMARY_BUDGET_MS)}｜情緒 ${fmtBudget(sample.sentimentReadyMs, SC005_SENTIMENT_BUDGET_MS)}`
          + `（${sample.sentimentChunks ?? '—'} 批 / ${sample.customerMessageCount} 則客戶發言）  ← 001 SC-005`
          + (sample.sentimentCalls?.length
            ? `\n        情緒單次：${sample.sentimentCalls.map(c =>
              `${c.elapsedMs}ms${c.ok ? '' : `/${c.errorName}`}${c.elapsedMs > AI_CALL_TIMEOUT_MS ? ' ⚠️破15秒' : ''}`).join('、')}`
              + `（峰值並發 ${sample.sentimentPeakInFlight ?? '—'}）`
            : '')
          + `\n        序列：${sample.sequence.join(' → ')}`
          + (sample.retrievals?.length
            ? `\n        檢索：${sample.retrievals.map(r => `${r.elapsedMs}ms/${r.hitCount === -1 ? '失敗' : `${r.hitCount} 筆`}`).join('、')}`
            : '')
          + (sample.stage2?.length
            ? `\n        第二段：${sample.stage2.map(t =>
              `${t.outcome}（送出 +${t.startedAtMs}ms、耗時 ${t.elapsedMs}ms、模型回 ${t.rawCardCount ?? '—'} 張、`
              + `過白名單 ${t.keptCardCount ?? '—'} 張、sopId 全有效=${t.sopIdsAllValid ?? '—'}`
              + `${t.invalidSopIdShapes?.length ? `、無效的形狀=[${t.invalidSopIdShapes.join(',')}]` : ''}`
              + `${t.errorName ? `、${t.errorName}: ${t.errorMessage}` : ''}）`).join('；')}`
            : ''),
        )
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`💥 ${msg}`)
      samples.push({
        conversationId: target.conversationId,
        title: target.title,
        round,
        method: mode === 'join' ? 'join' : 'readonly',
        modeBefore: target.mode,
        fetchMs: 0,
        messageCount: 0,
        customerMessageCount: 0,
        firstCardsMs: null,
        pendingMs: null,
        settledMs: null,
        summaryReadyMs: null,
        sentimentReadyMs: null,
        sentimentChunks: null,
        finalCitation: null,
        finalStatus: null,
        hitCount: null,
        cardCount: null,
        provenance: null,
        sequence: [],
        error: msg,
      })
    }
  }

  // ── 彙總 ────────────────────────────────────────────────────
  const usable = samples.filter(s => !s.error)
  // 002 SC-001 的判準：第一批**可用的卡**何時出現，不問由哪一段產生（見 Sample.firstCardsMs）
  const firstCards = usable.map(s => s.firstCardsMs).filter((v): v is number => v !== null)
  const pendings = usable.map(s => s.pendingMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const settles = usable.map(s => s.settledMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  // ⚠️ SC-002 的分母只算「知識庫真的有命中」的那些：0 命中時落成 'none' 是正確行為，
  //    把它算進分母等於在量知識庫的涵蓋率，不是在量本規格。
  const withHits = usable.filter(s => (s.hitCount ?? 0) > 0)
  const cited = withHits.filter(s => s.finalCitation === 'cited')
  const summaryReady = usable.map(s => s.summaryReadyMs).filter((v): v is number => v !== null)
  const sentimentReady = usable.map(s => s.sentimentReadyMs).filter((v): v is number => v !== null)
  // 情緒的每一次呼叫（跨全部樣本攤平）—— 並行化風險的判讀依據，見 instrumentProviders
  const allCalls = usable.flatMap(s => s.sentimentCalls ?? [])
  const callMs = allCalls.map(c => c.elapsedMs).sort((a, b) => a - b)
  const sentimentCallStats = {
    n: allCalls.length,
    medianMs: percentile(callMs, 0.5),
    p90Ms: percentile(callMs, 0.9),
    maxMs: callMs[callMs.length - 1] ?? 0,
    /** 破 FR-014 的 15 秒 → 這一次呼叫會被判逾時並觸發重試 */
    overCallTimeout: allCalls.filter(c => c.elapsedMs > AI_CALL_TIMEOUT_MS).length,
    failed: allCalls.filter(c => !c.ok).length,
    peakInFlight: Math.max(0, ...usable.map(s => s.sentimentPeakInFlight ?? 0)),
  }

  const summary = {
    at: new Date().toISOString(),
    env: env('IMBRACE_ENV', 'stable'),
    method: mode,
    repeat,
    /**
     * ⚠️ 舊檔（2026-08-29 之前）只有一個 `conversations` 欄位，值是**樣本數**。
     *    `--repeat` 之後兩者不再相等，因此**改名而不是沿用**——同一個鍵在新舊檔裡
     *    代表不同的東西，是最難察覺的一種資料錯誤。
     */
    targets: targets.length,
    sampleCount: samples.length,
    usable: usable.length,
    /**
     * 002 SC-001（＝`ARCHITECTURE.md` §18 M2 驗收第 4 項）：首批建議卡 p90 ≤ 20 秒。
     * **這一欄才是驗收判準**，`stage1` 只是診斷（2026-09-02 起，理由見 Sample.firstCardsMs）。
     */
    sc001: budgetStats(firstCards, SC001_BUDGET_MS, usable.length),
    /**
     * 第一段**自己**發布的時點 —— 診斷用，**MUST NOT 拿來判 SC-001**。
     *
     * ⚠️ 2026-09-02 起**刻意不再有 `pass` 欄位**：它先前存在，而且判的是別的東西
     *    （分母只含「第一段真的發布過」的樣本）。同一個鍵在新舊檔裡代表不同的意思，
     *    是最難察覺的一種資料錯誤——所以拿掉，讓舊讀法直接壞掉而不是靜默給出樂觀值。
     */
    stage1: {
      n: pendings.length,
      /** 第一段沒發布的樣本數：被 FR-006a abort、或整塊轉 error */
      notPublished: usable.length - pendings.length,
      medianMs: percentile(pendings, 0.5),
      p90Ms: percentile(pendings, 0.9),
      maxMs: pendings[pendings.length - 1] ?? 0,
      withinBudget: pendings.filter(v => v <= SC001_BUDGET_MS).length,
      budgetMs: SC001_BUDGET_MS,
    },
    stage2: {
      n: settles.length,
      /** ⚠️ 未落定的樣本算未達（同 budgetStats 的理由），因此進 `pass` */
      missing: usable.length - settles.length,
      medianMs: percentile(settles, 0.5),
      p90Ms: percentile(settles, 0.9),
      maxMs: settles[settles.length - 1] ?? 0,
      budgetMs: STAGE2_BUDGET_MS,
      pass: settles.length === usable.length && usable.length > 0
        && (settles[settles.length - 1] ?? 0) <= STAGE2_BUDGET_MS,
    },
    /**
     * 001 SC-005（＝`ARCHITECTURE.md` §18 M2 驗收第 2 項）：摘要與情緒各自的實質內容 p90 ≤ 10 秒。
     *
     * ⚠️ **兩列分開判，MUST NOT 合成一個數字。** 摘要是單次呼叫、情緒是 N 批依序呼叫，
     *    合起來平均會讓長對話的情緒被短對話的摘要稀釋，而驗收要的是「客服看到的那兩塊」
     *    各自何時出現。判準對兩者都成立才算通過。
     */
    /**
     * 情緒**單次呼叫**的分佈 —— 與 `sc005.sentiment`（區塊總時間）是兩件事，**兩者都要看**。
     * 並行化若成功，總時間會下降而這裡應該持平；若這裡跟著上升，就是平台側在排隊，
     * 代價會以「偶發重試甚至整批 error」的形式出現，而不是在總時間上看得到。
     */
    sentimentCalls: sentimentCallStats,
    sc005: {
      summary: budgetStats(summaryReady, SC005_SUMMARY_BUDGET_MS, usable.length),
      sentiment: budgetStats(sentimentReady, SC005_SENTIMENT_BUDGET_MS, usable.length),
      pass: budgetStats(summaryReady, SC005_SUMMARY_BUDGET_MS, usable.length).pass
        && budgetStats(sentimentReady, SC005_SENTIMENT_BUDGET_MS, usable.length).pass,
    },
    sc002: {
      withHits: withHits.length,
      cited: cited.length,
      ratio: withHits.length > 0 ? cited.length / withHits.length : null,
      threshold: SC002_CITED_RATIO,
      pass: withHits.length > 0 && cited.length / withHits.length >= SC002_CITED_RATIO,
    },
    samples,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const payload = JSON.stringify(summary, null, 2)
  const jsonFile = resolve(OUT_DIR, '21-progressive-citations.json')
  writeFileSync(jsonFile, payload, 'utf8')
  // ⚠️ 同時留一份帶時間戳的：本規格的量測**每次結果都不同**（檢索與模型輸出都非決定性，
  //    2026-08-29 連跑兩次即得到不同的 citation 結論），只留最新一份等於把前一次的證據蓋掉。
  const stampFile = resolve(OUT_DIR, `21-progressive-citations-${summary.at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(stampFile, payload, 'utf8')

  console.log(`\n── 彙總 ${'─'.repeat(45)}`)
  console.log(`  首批建議卡（002 SC-001，≥90% 在 ${SC001_BUDGET_MS / 1000} 秒內）：`
    + `${summary.sc001.withinBudget}/${summary.sc001.total} = ${pctText(summary.sc001)}`
    + `${summary.sc001.missing > 0 ? `（其中 ${summary.sc001.missing} 個從未出現任何卡）` : ''} `
    + `中位 ${summary.sc001.medianMs}ms p90 ${fmtP90(summary.sc001.p90Ms)} 最慢 ${summary.sc001.maxMs}ms`
    + ` → ${summary.sc001.pass ? '✅ 通過' : '❌ 未達'}`)
  console.log(`    └ 第一段自身（診斷，非判準）：n=${summary.stage1.n}`
    + `（另有 ${summary.stage1.notPublished} 個樣本第一段未發布：被 FR-006a abort 或整塊轉 error）`
    + ` 中位 ${summary.stage1.medianMs}ms p90 ${summary.stage1.p90Ms}ms`)
  console.log(`  第二段落定（契約 §2，≤ ${STAGE2_BUDGET_MS / 1000} 秒且無未落定）：`
    + `n=${summary.stage2.n}${summary.stage2.missing > 0 ? `（另有 ${summary.stage2.missing} 個未落定）` : ''} `
    + `中位 ${summary.stage2.medianMs}ms p90 ${summary.stage2.p90Ms}ms 最慢 ${summary.stage2.maxMs}ms`
    + ` → ${summary.stage2.pass ? '✅ 通過' : '❌ 未達'}`)
  for (const [label, st] of [['摘要', summary.sc005.summary], ['情緒', summary.sc005.sentiment]] as const) {
    console.log(`  ${label}區塊（001 SC-005，≥90% 在 ${st.budgetMs / 1000} 秒內）：`
      + `${st.withinBudget}/${st.total} = ${pctText(st)}`
      + `${st.missing > 0 ? `（其中 ${st.missing} 個未落地，計為未達）` : ''} `
      + `中位 ${st.medianMs}ms p90 ${fmtP90(st.p90Ms)} 最慢 ${st.maxMs}ms`
      + ` → ${st.pass ? '✅ 通過' : '❌ 未達'}`)
  }
  console.log(`  情緒單次呼叫（含重試的每次嘗試，峰值並發 ${summary.sentimentCalls.peakInFlight}）：`
    + `n=${summary.sentimentCalls.n} 中位 ${summary.sentimentCalls.medianMs}ms `
    + `p90 ${summary.sentimentCalls.p90Ms}ms 最慢 ${summary.sentimentCalls.maxMs}ms｜`
    + `破 ${AI_CALL_TIMEOUT_MS / 1000} 秒 ${summary.sentimentCalls.overCallTimeout} 次、`
    + `失敗 ${summary.sentimentCalls.failed} 次`)
  console.log(`     ↑ 並行化只有在「總時間下降、這一列持平」時才算成功；這一列跟著上升＝平台在排隊`)
  console.log(`  引用比例（SC-002，≥ ${SC002_CITED_RATIO * 100}%）：`
    + `${summary.sc002.cited}/${summary.sc002.withHits} 段有命中的對話取得 cited`
    + ` → ${summary.sc002.pass ? '✅ 通過' : summary.sc002.withHits === 0 ? '❓ 無有效樣本（沒有任何一段命中知識庫）' : '❌ 未達'}`)
  console.log(`\n  📁 ${jsonFile.replace(ROOT, '.')}（同時留存 ${stampFile.replace(ROOT, '.')}）`)

  if (mode === 'join') {
    const changed = samples.filter(s => s.modeAfter !== undefined && s.modeAfter !== s.modeBefore)
    if (changed.length > 0) {
      console.log(`\n  ⚠️ 下列對話的 mode 已改變（JOIN → LEAVE 的必然結果，見檔頭警告）：`)
      for (const s of changed) console.log(`     「${s.title}」 ${s.modeBefore ?? 'null'} → ${s.modeAfter ?? 'null'}`)
    }
  }

  if (!summary.sc002.pass && summary.sc002.withHits > 0) {
    // ⚠️ T032 只在「失敗原因是第二段 20 秒逾時」時才要求回頭重議 T011。
    //    其餘成因（模型杜撰引用而被整卡捨棄）改常數一點用都沒有 —— 這裡直接分類，不留給人猜。
    const missed = usable.filter(s => (s.hitCount ?? 0) > 0 && s.finalCitation !== 'cited')
    const byOutcome = new Map<string, number>()
    for (const s of missed) {
      for (const t of s.stage2 ?? []) byOutcome.set(t.outcome, (byOutcome.get(t.outcome) ?? 0) + 1)
      if ((s.stage2?.length ?? 0) === 0) byOutcome.set('第二段從未送出', (byOutcome.get('第二段從未送出') ?? 0) + 1)
    }
    console.log(`\n  ⚠️ SC-002 未達（${missed.length} 段有命中卻沒拿到引用）。成因分類：`)
    for (const [outcome, n] of byOutcome) console.log(`     ${outcome}：${n} 次`)
    const failed = missed.some(s => s.stage2?.some(t => t.outcome === 'failed'))
    console.log(failed
      ? '     → 含第二段失敗／逾時：依 tasks.md T032 回到 T011 重議 SUGGESTION_STAGE2_CALL_TIMEOUT_MS'
        + '（先確認 errorName 是不是 AICallTimeoutError —— 其他錯誤改常數也沒用）'
      : '     → **不是逾時、也不是失敗**：改 SUGGESTION_STAGE2_CALL_TIMEOUT_MS 無效。'
        + '問題在建議卡 agent 的輸出，憲法 4.3 的白名單正在擋它杜撰引用。')
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof SkipProbe) {
      console.log(`\n⏭  略過：${err.message}\n`)
      process.exit(0)
    }
    console.error('\n💥', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
