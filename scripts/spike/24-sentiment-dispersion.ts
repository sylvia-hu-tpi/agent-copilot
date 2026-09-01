/**
 * 24 — 情緒 agent 的刻度穩定度、批次邊界斷層、走勢摘要的 prompt 衝突。
 *
 * 動機（2026-09-01 使用者回報「走勢圖的分數與顏色變化滿大」）：當時
 * `AgentCopilot_情緒評分_agent` 的 system prompt 要求「判斷依據只能是該則發言本身」，
 * 逐則孤立判斷把「好，那我再等等」判成 85／calm，在折線上造成一個假的樂觀尖峰。
 * prompt 補上「看同批上下文」＋絕對分數帶＋兩條界線 tie-breaker 之後問題解決
 * （見 ARCHITECTURE §8.2b）。本 probe 自此的用途是**迴歸檢查**：後台 prompt 不在
 * 版本控管內，改壞了沒有任何 commit 看得出來，只有重跑這支才會發現。
 *
 * 四個量測：
 *   A 刻度離散度 —— 同一批訊息連跑 N 次，看同一則的分數擺動幅度與 label 是否翻面。
 *     折線圖看的是相鄰兩點的差，刻度不穩會被原樣放大成鋸齒。
 *   D score／label 一致性 —— 圖上高度只看 score、顏色只看 label，而 prompt 沒把兩者綁住。
 *   B 批次邊界 —— 正式路徑每 6 則切一批獨立呼叫（SENTIMENT_CHUNK_SIZE），
 *     批與批之間不共享上下文。同一則訊息「單獨成批」與「整批一起送」的分數差
 *     就是折線在第 6→7 點可能出現的假跳動。⚠️ 這是**迴歸檢查**：
 *     後台 prompt 若哪天失去絕對分數帶，這個數字會先變大。
 *   C 走勢摘要 —— narrateSentiment() 與 analyzeSentiment() 共用同一個 agent
 *     （ARCHITECTURE §8.2b），但 system prompt 寫死「只能輸出一個 JSON 陣列」，
 *     而走勢摘要要的是 {trend, advice} 物件。量它實際回什麼形狀。
 *
 * ⚠️ 唯讀：只呼叫 AI Agent，不碰任何真實對話資料。訊息樣本是合成的。
 *
 * ⚠️ 不在 `run-all.ts` 裡（比照 15 號之後的所有 probe）：它會打 12 次 AI agent、約 3 分鐘，
 *    而 `npm run spike` 的定位是快速全掃。要跑就單獨跑。
 *
 * 跑法：
 *   npm run spike:sentiment-dispersion
 */

import { runProbe, isMain, env, requireEnv, SkipProbe, type Finding } from './lib/harness.js'
import { clientForApiKey } from '../../server/services/imbrace.js'
import { ImbraceAgentProvider } from '../../server/services/ai/imbrace-agent-provider.js'
import { parseSentimentNarrative, parseSentimentPoints } from '../../server/services/ai/schemas.js'
import type { Message } from '../../shared/types/conversation.js'
import type { SentimentPoint } from '../../shared/types/copilot.js'

/** 合成樣本：先升溫、被安撫、再度失望的六輪 —— 刻意包含中性與界線模糊的兩則 */
const SAMPLE: Message[] = [
  '網路又斷了，這個月第三次',
  '燈號都是綠的，我照你們說的重開機了',
  '所以到底什麼時候會好？我在家工作耶',
  '好，那我再等等',
  '已經兩天了，完全沒有人跟我聯絡',
  '我要申訴，順便問一下解約要怎麼辦',
].map((text, i) => ({
  id: `m${i + 1}`,
  conversationId: 'synthetic',
  at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  sender: { type: 'customer' as const },
  text,
}))

const RUNS = 3

/**
 * B 段跑幾次。
 *
 * ⚠️ **刻意大於 `RUNS`。** B 段比的是兩個平均值的差，而那個差（個位數分）與 agent
 *    自身的擺動同一量級 —— n=3 時它進不了雜訊之上。2026-09-01 已經因為樣本太小
 *    先後得到兩個方向相反的結論各一次，加大樣本比再猜一次便宜。
 */
const B_RUNS = 5

/** 提案的分數帶（尚未定案）—— 用來量「score 與 label 目前有多不一致」 */
const BANDS: Record<SentimentPoint['label'], [number, number]> = {
  angry: [0, 19],
  frustrated: [20, 39],
  concerned: [40, 59],
  neutral: [60, 79],
  calm: [80, 100],
}

function inBand(p: Pick<SentimentPoint, 'score' | 'label'>): boolean {
  const [lo, hi] = BANDS[p.label]
  return p.score >= lo && p.score <= hi
}

export const probe24 = () => runProbe('24', '情緒 agent 刻度穩定度與 prompt 衝突', async (p) => {
  const sentimentAgentId = env('IMBRACE_SENTIMENT_AGENT_ID')
  if (!sentimentAgentId) throw new SkipProbe('缺少 IMBRACE_SENTIMENT_AGENT_ID（見 .env.local）')

  const client = clientForApiKey(requireEnv('IMBRACE_API_KEY'), {
    organizationId: requireEnv('IMBRACE_ORGANIZATION_ID'),
    env: 'stable',
  })
  // 只用得到情緒 agent，摘要／建議的 id 傳空字串（本 probe 不呼叫那兩支）
  const provider = new ImbraceAgentProvider(client, '', sentimentAgentId, '')

  async function score(messages: Message[]): Promise<SentimentPoint[]> {
    return parseSentimentPoints(await provider.analyzeSentiment({ messages }))
  }

  // ── A 刻度離散度 ────────────────────────────────────────────
  console.log(`\n  A 刻度離散度：同一批 ${SAMPLE.length} 則連跑 ${RUNS} 次`)
  const runsA: SentimentPoint[][] = []
  for (let r = 1; r <= RUNS; r++) {
    try {
      const pts = await score(SAMPLE)
      runsA.push(pts)
      console.log(`    第 ${r} 次：${pts.map(x => `${x.score}/${x.label}`).join('  ')}`)
    }
    catch (e) {
      console.log(`    第 ${r} 次 ❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  let maxSpread = 0
  let labelFlips = 0
  const perMessage: Array<Record<string, unknown>> = []
  if (runsA.length >= 2) {
    for (let i = 0; i < SAMPLE.length; i++) {
      const scores = runsA.map(r => r[i]!.score)
      const labels = runsA.map(r => r[i]!.label)
      const spread = Math.max(...scores) - Math.min(...scores)
      const flipped = new Set(labels).size > 1
      if (spread > maxSpread) maxSpread = spread
      if (flipped) labelFlips++
      perMessage.push({ index: i + 1, scores, labels, spread, labelFlipped: flipped })
      console.log(`    第 ${i + 1} 則：分數 ${scores.join('／')} → 擺動 ${spread} 分${flipped ? `　⚠️ label 翻面（${[...new Set(labels)].join('→')}）` : ''}`)
    }
    p.record({
      question: '24-A',
      claim: '同一則發言在不同次呼叫得到的分數是否穩定',
      verdict: maxSpread <= 10 && labelFlips === 0 ? 'yes' : maxSpread <= 20 ? 'partial' : 'no',
      evidence: `${RUNS} 次呼叫，同一則的最大分數擺動 ${maxSpread} 分；${labelFlips}/${SAMPLE.length} 則的 label 在不同次之間翻面`,
      impact: maxSpread > 10
        ? `折線圖看的是相鄰兩點的差，${maxSpread} 分的重測擺動會被原樣畫成鋸齒；label 翻面則會讓整條折線換色（SentimentGauge 的 strokeColor 吃 label）`
        : '刻度穩定，走勢圖的抖動來源不在重測離散度',
    })
  }

  // ── D score 與 label 的一致性（在 A 的樣本上一併算）──────────
  const allPoints = runsA.flat()
  const offBand = allPoints.filter(x => !inBand(x))
  if (allPoints.length > 0) {
    console.log(`\n  D score／label 一致性（依提案分帶）：${allPoints.length - offBand.length}/${allPoints.length} 落在對應區間`)
    for (const x of offBand) console.log(`    ⚠️ score ${x.score} 卻標成 ${x.label}（該級提案區間 ${BANDS[x.label].join('–')}）`)
    p.record({
      question: '24-D',
      claim: 'score 與 label 是否互相一致（agent 目前未被要求兩者對齊）',
      verdict: offBand.length === 0 ? 'yes' : offBand.length < allPoints.length / 3 ? 'partial' : 'no',
      evidence: `${allPoints.length} 個評分點中 ${offBand.length} 個的 score 落在其 label 的提案區間之外`,
      impact: '圖上的高度只看 score、顏色只看 label。兩者不一致時會出現「線在高處卻整條變橘」這種矛盾畫面',
    })
  }

  // ── B 批次邊界斷層 ──────────────────────────────────────────
  /*
    模擬正式路徑的第二批：第 4–6 則自成一批（每 6 則切一次，第 7 則起就是這個處境 ——
    看不到前面發生過什麼）。基準真相取「整批 6 則一起送」時第 4–6 則的分數，
    那是模型看得到完整上下文時的判斷；兩者的差就是折線在批次邊界的假斷層。

    ⚠️ **兩邊都取平均，而且 n 要夠。** 2026-09-01 這一段先用單次、再用 n=3，
       先後得到兩個方向相反的結論，兩次都是雜訊 —— 要偵測的差與 agent 自身的擺動
       同一個量級。n=5 才穩定下來。

    ⚠️ 這裡曾經還比過「把前一批尾端的評分帶進 prompt」（`AIProvider` 的 `priorPoints`）。
       補上分數帶與界線 tie-breaker 之後接縫本身就縮到 3.6 分，前情再也量不到效益
       （n=5：3.6 對 3.9），該參數已移除，這段比較隨之拿掉。詳見 ARCHITECTURE §8.2b。
  */
  console.log(`
  B 批次邊界：第 4–6 則自成一批 vs 整批 6 則（各 ${B_RUNS} 次取平均）`)
  const tail = SAMPLE.slice(3)

  function meanScoreAt(runs: SentimentPoint[][], offset: number, i: number): number {
    const xs = runs.map(r => r[offset + i]!.score)
    return xs.reduce((a, b) => a + b, 0) / xs.length
  }

  if (runsA.length >= 2) {
    const truth = tail.map((_, i) => meanScoreAt(runsA, 3, i))
    const aloneRuns: SentimentPoint[][] = []
    try {
      for (let r = 0; r < B_RUNS; r++) aloneRuns.push(await score(tail))

      const dev = tail.map((_, i) => Math.abs(meanScoreAt(aloneRuns, 0, i) - truth[i]!))
      const avgDev = dev.reduce((a, b) => a + b, 0) / dev.length

      tail.forEach((m, i) => {
        console.log(`    「${m.text}」　基準（整批）${truth[i]!.toFixed(1)}`
          + `　自成一批 ${meanScoreAt(aloneRuns, 0, i).toFixed(1)}　偏離 ${dev[i]!.toFixed(1)}`)
      })
      console.log(`    平均偏離：${avgDev.toFixed(1)} 分`)

      p.record({
        question: '24-B',
        claim: '同一則訊息的分數是否受「跟哪些訊息同一批」影響',
        verdict: avgDev <= 5 ? 'yes' : avgDev <= 12 ? 'partial' : 'no',
        evidence: `第 4–6 則自成一批 vs 併入整批 6 則（各 ${B_RUNS} 次取平均），平均偏離 ${avgDev.toFixed(1)} 分`,
        impact: avgDev <= 5
          ? 'prompt 的絕對分數帶讓模型不再拿同批其他訊息當相對基準，批次組成對分數的影響已可忽略'
          : `批次組成仍在影響分數 ${avgDev.toFixed(1)} 分。正式路徑每 6 則切一批，`
            + '折線會在第 6→7、12→13 點出現不是真實情緒變化的斷層',
      })
    }
    catch (e) {
      console.log(`    ❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── C 走勢摘要的 prompt 衝突 ────────────────────────────────
  console.log(`\n  C 走勢摘要：narrateSentiment() 連跑 ${RUNS} 次（與評分共用同一個 agent）`)
  let narrativeOk = 0
  const shapes: string[] = []
  const points = (runsA[0] ?? []).map(x => ({ score: x.score, label: x.label, drivers: x.drivers }))
  if (points.length >= 2) {
    for (let r = 1; r <= RUNS; r++) {
      let shape = '無法解析'
      try {
        const raw = await provider.narrateSentiment({ points })
        shape = Array.isArray(raw)
          ? `陣列（${raw.length} 個元素）`
          : `物件（鍵：${Object.keys(raw as object).join('、')}）`
        shapes.push(shape)
        const n = parseSentimentNarrative(raw)
        narrativeOk++
        console.log(`    第 ${r} 次 ✅ ${shape}`)
        console.log(`           trend：${n.trend}`)
        console.log(`           advice：${n.advice}`)
      }
      catch (e) {
        if (shape === '無法解析') shapes.push(shape)
        console.log(`    第 ${r} 次 ❌ ${shape} — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    p.record({
      question: '24-C',
      claim: 'system prompt 的「只能輸出 JSON 陣列」是否讓走勢摘要（要物件）產不出來',
      verdict: narrativeOk === RUNS ? 'no' : narrativeOk === 0 ? 'yes' : 'partial',
      evidence: `${narrativeOk}/${RUNS} 次通過 parseSentimentNarrative()；實際回傳形狀：${shapes.join('、') || '（皆無法解析）'}`,
      impact: narrativeOk < RUNS
        ? '失敗時 narrateSentimentTrend() 會吞掉錯誤、narrative 留 null，UI 那一整段走勢文字安靜消失，畫面上沒有任何提示'
        : 'system prompt 的陣列規則未實際影響走勢摘要',
    })
  }

  // 樣本是合成的，不含 PII，raw=true 保留原樣以便比對改 prompt 前後
  p.fixture('sentiment-dispersion', { runs: runsA, perMessage, narrativeShapes: shapes }, true)
})

if (isMain(import.meta.url)) {
  probe24().then((f: Finding[]) => process.exit(f.some(x => x.verdict === 'unknown') ? 1 : 0))
}
