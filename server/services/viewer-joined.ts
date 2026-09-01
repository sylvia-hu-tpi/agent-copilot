/**
 * 左欄列項的「**你**在此對話中」判定 —— docs/ARCHITECTURE.md §10.2.1、畫布 §8.2。
 *
 * ── 為什麼需要這一層 ────────────────────────────────────────────────
 *
 * 平台的 `is_joined`（「我」有沒有 JOIN）**只有單筆 `conversations.get()` 才有**：
 * 實測對話清單 16 筆之中 0 筆帶這個欄位（`scripts/spike/out/23-list-join-fields.json`），
 * 也沒有「只列出我 JOIN 的」端點（D-23f：SDK 註解寫著 view 有 all／joined／yours，
 * 實測 `getViewsCount()` 回的是 status 分組、`list({type})` 三種全回 0 筆）。
 *
 * 所以要在清單上標出「你在此對話中」，只能自己補查詳情。而**前景清單輪詢是 3 秒一次**
 * （`LIST_INTERVAL_FOREGROUND_MS`），對每一列各補一次是不可行的。這個檔案的存在
 * 就是為了讓那個補查**不隨對話總量成長**。
 *
 * ── 成本模型 ──────────────────────────────────────────────────────
 *
 * ⚠️ **候選集合必須是「現在有人在」（`mode ∈ {manual, hybrid}`），
 *    不可以是「曾經有人 JOIN 過」（`is_agent_joined`）。**
 *    後者實測是**單向黏著、永不回復**的（D-23d：LEAVE 之後仍是 `true`），
 *    因此它只會單調成長 —— 上線幾個月後幾乎每一則都會是 `true`，
 *    等於退化成「查每一列」。而「現在有人在」的量測的是**團隊規模 × 每人並行數**，
 *    與一天進來幾則對話無關：一天 500 則、10 位客服每人同時開 3 則 → 候選仍是 30。
 *
 * 加上快取之後：
 *   - **穩定狀態 0 次額外呼叫** —— 3 秒的輪詢命中快取，不觸發任何解析
 *   - 只有「某則對話**剛剛**變成有人在」才查一次，那是人接手對話的頻率
 *   - 冷啟動（伺服器重啟／剛登入）一次性解析候選，再由 `RESOLVE_LIMIT` 削平突刺
 *
 * ⚠️ **刻意不設 TTL。** TTL 是唯一會讓成本隨候選集合線性成長的東西
 *   （2026-09-01 使用者以「上線後一天可能上百則」為由裁定砍掉）。
 *   代價是下面「已知盲區」的第一項。
 *
 * ── 已知盲區（都不會答錯，只會暫時少標）──────────────────────────
 *
 * ① **同事已經在裡面（`mode` 已是 `manual`）時，你從 iMBrace 官方介面 JOIN**：
 *    `mode` 不變動 → 沒有失效訊號 → 該則暫時標成「有客服在此」而非「你在此對話中」。
 *    你在 AgentCopilot 裡點開它就會修正（詳情路由會回填，見 `[id].get.ts`）。
 * ② **你以 Automation Only（唯讀）從官方介面加入**：`mode` 是 `automation`，
 *    不在候選集合裡。那個狀態下你本來就送不出訊息（§10.6），標記價值低。
 *
 * 兩者都是「該標而沒標」，**不會**標錯人 —— 這個方向是刻意選的：
 * 把同事的對話標成「你在此對話中」會讓客服以為自己已經接手而不去接，那才是真的損害。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import type { Conversation } from '../../shared/types/conversation.js'
import { someoneElseCanSend } from '../../shared/types/conversation.js'
import type { StateStore } from '../state/types.js'
import { getConversationDetail } from './imbrace.js'

/**
 * 單輪最多向平台解析幾則。
 *
 * ⚠️ 這是**突刺上限**，不是正確性上限：排不進來的這一輪維持 `undefined`
 *    （＝「還不知道」，見 `Conversation.viewerJoined` 的說明），下一輪再解析。
 *    前景輪詢 3 秒一次，所以 30 則候選最多兩輪、約 6 秒就會全部標好。
 */
export const VIEWER_JOINED_RESOLVE_LIMIT = 10

/**
 * 幫清單項目補上 `viewerJoined`。**就地修改傳入的陣列並回傳同一個參考。**
 *
 * ⚠️ **這個函式不得拋錯。** 它是清單路由的加值步驟，不是必要步驟 ——
 *    平台補查失敗時整份清單仍必須回得去，只是少了「你在此對話中」的標記。
 *    讓它拋錯等於用一個裝飾性欄位把左欄整個打掉。
 */
export async function annotateViewerJoined(
  store: StateStore,
  client: ImbraceClient,
  operatorId: string,
  items: Conversation[],
): Promise<Conversation[]> {
  /*
    我方自己的 JOIN 記錄 —— 經 AgentCopilot JOIN 的一定在這裡，不必問平台。

    ⚠️ 這一份**優先於 `mode` 的推論**：若同事後來離開、平台把 `mode` 帶回 `automation`
       而我其實還在裡面，光看 `mode` 會漏標。我方自己的 JOIN／LEAVE 是明確操作，
       比從 `mode` 反推可靠。
    ⚠️ 但它**不能單獨使用**：這份記錄在記憶體裡，重啟／HMR 後歸零，
       也記不到在 iMBrace 官方介面按的 JOIN（同一個家族的不同步已經害過一次，
       見 `conversation-context.ts::isViewerJoined()`）。所以它是快路徑，不是真相。
  */
  const ownJoined = new Set(await store.listJoinedConversations(operatorId))

  const pending: Conversation[] = []

  for (const item of items) {
    const mode = item.mode ?? null

    if (ownJoined.has(item.id)) {
      item.viewerJoined = true
      continue
    }

    const cached = await store.getViewerJoined(operatorId, item.id)
    // ⚠️ 比對 mode：`mode` 一變就代表有人 JOIN 或 LEAVE，舊答案不再可信
    if (cached && cached.mode === mode) {
      item.viewerJoined = cached.joined
      continue
    }

    /*
      不在候選集合裡 —— 沒有人能送出訊息，因此不可能是「我在裡面且能回覆」。
      ⚠️ 這一筆也要寫進快取（帶著當下的 mode），否則同事的對話每輪都會重新走一次
         下面的解析流程。快取的 key 含 mode，所以 mode 一變它自然就過期了。
    */
    if (!someoneElseCanSend(mode)) {
      item.viewerJoined = false
      await store.setViewerJoined(operatorId, item.id, { joined: false, mode })
      continue
    }

    pending.push(item)
  }

  await resolveFromPlatform(store, client, operatorId, pending)
  return items
}

/**
 * 對候選逐則查詳情取 `is_joined`。
 *
 * ⚠️ 用 `allSettled` 而非 `all`：一則查不到不該讓其他幾則的答案一起丟掉。
 *    失敗的那則維持 `undefined` 並**不寫入快取** —— 寫進去會把一次網路失誤
 *    變成一個要等 `mode` 變動才會消失的錯誤答案。
 */
async function resolveFromPlatform(
  store: StateStore,
  client: ImbraceClient,
  operatorId: string,
  candidates: Conversation[],
): Promise<void> {
  const batch = candidates.slice(0, VIEWER_JOINED_RESOLVE_LIMIT)
  if (batch.length === 0) return

  await Promise.allSettled(batch.map(async (item) => {
    /*
      ⚠️ 這裡刻意直接用 `getConversationDetail()` 而不是 `loadConversationContext()`：
         後者會順手把 operators 寫進團隊名冊快取（`rememberOperators`），
         而我們只是要一個布林值 —— 為了一個旗標去更新別的共享狀態是不必要的耦合。
    */
    const raw = await getConversationDetail(client, item.id)
    if (!raw) return

    const joined = (raw as Record<string, unknown>).is_joined === true
    // ⚠️ 記錄「解析當下」的 mode，取自詳情而非清單 —— 兩者若不同步，詳情較新
    const mode = typeof (raw as Record<string, unknown>).mode === 'string'
      ? (raw as Record<string, unknown>).mode as string
      : null

    item.viewerJoined = joined
    await store.setViewerJoined(operatorId, item.id, { joined, mode })
  }))
}
