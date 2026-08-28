/**
 * SSE 連線的控制通道。
 *
 * ── 為何需要它 ───────────────────────────────────────────────────
 * SSE 連線建立時，client 還不知道客服接下來會看哪個對話。
 * 而 EventBus 的 topic 慣例是 `conversation:{id}`（§8.3），
 * 所以連線必須**在執行期動態增減訂閱**。
 *
 * 三個被否決的替代方案，以及否決的理由：
 *
 *  1. 「切換對話時重連 SSE」—— 每次切換都會重播 session.opened、
 *     重跑一次 presence 廣播，且切得快時會留下一堆半關閉的連線。
 *  2. 「連線時用 query string 帶對話清單」—— 等同方案 1，清單一變就要重連。
 *  3. 「一律訂閱整個組織的事件，前端自己過濾」—— 訊息全文會送給不該收的人，
 *     且「訂閱數歸零即停止輪詢」（憲法 6.1）會失去依據。
 *
 * 因此走控制通道：`POST /api/presence` 順手發一則控制訊息給自己的連線。
 * 客服開啟對話時本來就要送 presence 心跳，不必多一支 API。
 *
 * ⚠️ topic 帶 `clientId` 而不只是 operatorId：同一位客服可能開兩個分頁看不同對話。
 */

import type { CopilotEvent } from '../../shared/types/events.js'

export interface StreamControl {
  kind: 'watch' | 'unwatch'
  conversationId: string
  priority: 'foreground' | 'background'
  joined: boolean
}

export const streamControlTopic = (operatorId: string, clientId: string): string =>
  `stream:${operatorId}:${clientId}`

/** 執行期型別守衛 —— EventBus 的 payload 是 unknown，不可直接 cast */
export function isStreamControl(payload: unknown): payload is StreamControl {
  const p = payload as StreamControl | null
  return !!p
    && (p.kind === 'watch' || p.kind === 'unwatch')
    && typeof p.conversationId === 'string'
}

/**
 * `POST /api/presence` 的 `state`／`joined` 應轉譯成哪一種控制通道訊息——
 * specs/002-suggestion-knowledge-search／contracts/presence-watch-control.md。
 *
 * ⚠️ `state === 'away'` **不再**無條件等於 unwatch（憲法 v3.0.0 修訂動機的程式碼根因）：
 *    客服切走但仍 JOIN 著的對話，Copilot 管線 MUST 繼續以 background 優先度運作——
 *    只有真的沒 JOIN（或已 LEAVE）才該 unwatch。抽成純函式，不依賴 H3Event，
 *    供 test/presence-away-joined.test.ts 直接單元測試（presence.post.ts 本身用了
 *    Nitro auto-import，無法被 vitest／tsx 直接 import）。
 */
export function resolvePresenceControl(
  state: 'viewing' | 'composing' | 'joined' | 'away',
  joined: boolean,
  visible: boolean,
): { kind: 'watch' | 'unwatch', priority: 'foreground' | 'background' } {
  const kind = state === 'away' && !joined ? 'unwatch' : 'watch'
  const priority = state === 'away' ? 'background' : (visible ? 'foreground' : 'background')
  return { kind, priority }
}

/**
 * 三個分析事件 —— specs/003-analysis-trigger-policy 契約不變式 C 的過濾範圍，
 * **恰為這三個**（`AnalysisBlock` 的三個區塊各一）。
 */
const ANALYSIS_EVENT_TYPES = new Set<CopilotEvent['type']>([
  'summary.updated',
  'sentiment.updated',
  'suggestion.updated',
])

/**
 * 這則事件該不該送給「對該對話 `joined` 為此值」的連線 ——
 * specs/003-analysis-trigger-policy FR-016a、契約不變式 C。
 *
 * > 客服未 JOIN 某對話時：右側面板 MUST 不存在，且伺服器 MUST NOT 把該對話的三個分析事件
 * > 送給這條連線。**中欄所需的其餘事件 MUST 不受影響。**
 *
 * ⚠️ `messages.appended`／`presence.updated`／`control.updated`／`conversation.updated`／
 *    `session.*`／`stream.heartbeat` 一律照送：它們服務的是中欄與連線本身，與 JOIN 無關
 *    （US2 AC#3 明文要求中欄一切照常）。尤其 **`stream.heartbeat` 過濾掉會直接讓連線
 *    被中間 proxy 切斷** —— 症狀是「放著不動一分鐘後就再也收不到訊息」。
 *
 * ⚠️ 抽成純函式的理由同 `resolvePresenceControl()`：`stream.get.ts` 用了 Nitro auto-import，
 *    vitest 無法直接 import 它，這條「靜默失效」的規則否則沒有單元測試守得住。
 *
 * ⚠️ 這只涵蓋**即時推播**（`forward()`）。連線建立時的分析快照走 `send()`、不經 `forward()`，
 *    在 `attach()` 裡另外擋 —— 只擋一條等於沒擋。
 */
export function shouldForwardToConnection(type: CopilotEvent['type'], joined: boolean): boolean {
  return joined || !ANALYSIS_EVENT_TYPES.has(type)
}

/** `attach()` 的形狀 —— 回傳「解除這次監看」的清理函式（訂閱 topic ＋ watcher） */
export type AttachConversation = (
  conversationId: string,
  priority: 'foreground' | 'background',
  joined: boolean,
) => Promise<() => void>

/**
 * 一次監看的登記內容 —— specs/003-analysis-trigger-policy data-model.md §2。
 *
 * 原本只存 `off`（`Map<string, () => void>`）。新增的兩個欄位同時餵兩個需求，
 * **MUST NOT** 另立第二份記錄：
 *   ① 心跳去重（不變式 A）：`{priority, joined}` 與上次完全相同 = 週期心跳 = no-op。
 *   ② 分析事件的推播過濾（不變式 C）：`joined` 是「這條連線對這個對話有沒有 JOIN」的
 *      **唯一真相來源**。兩份必然不同步，而症狀是「面板明明不在，前端 store 卻在背景
 *      被更新」——極難重現、極難追查。
 */
interface WatchRegistration {
  /** 解除這次監看（退訂 topic + 解除 watcher） */
  off: () => void
  /** ⚠️ 上一次 attach() 用的參數。判斷「這次是真變化還是週期心跳」的唯一依據 */
  priority: 'foreground' | 'background'
  joined: boolean
}

/**
 * 一條 SSE 連線的「目前正在監看哪些對話」註冊表 ——
 * specs/002-suggestion-knowledge-search research.md #8 決策 3／4。
 *
 * ⚠️ 抽出來的理由與 `resolvePresenceControl()` 相同：`stream.get.ts` 用了 Nitro
 *    auto-import（`defineEventHandler`／`createEventStream`），vitest／tsx 無法直接
 *    import 它，於是這兩條「靜默失效」的規則過去沒有單元測試能守：
 *
 *    ① **重連復原**：連線建立時把此客服所有已 JOIN 的對話一律以 `background` 掛回去。
 *       漏掉的話，背景對話會在斷線的當下悄悄停止分析——不報錯、畫面也不會有異狀，
 *       只有「切回去才發現什麼都沒算」。
 *    ② **優先度升級**：已在監看中的對話再次收到 `watch` 時 **MUST NOT** 因為
 *       「已經在 watched 裡」就直接略過。客服切回背景對話時送的正是這種第二次 watch；
 *       略過的話優先度永遠停在 background，摘要永遠不會補跑。
 *
 *    ①②，也正是 T059 要驗的東西。
 *
 * ⚠️ **2026-08-28 修訂（specs/003-analysis-trigger-policy）**：②「不可略過」的正確範圍是
 *    **`{priority, joined}` 有改變時**，不是「每一次 watch」。原實作一律先解舊訂閱再重新
 *    `attach()`，而每 20 秒一次的 presence 心跳送的正是**參數完全相同**的 watch ——
 *    於是一個放著不動的對話每 20 秒重跑一輪完整分析。② 的立論（切回前景要能升級）不受影響：
 *    那一種第二次 watch 的 `priority` 是變的。判定表見
 *    specs/003-analysis-trigger-policy/contracts/analysis-trigger-contract.md 不變式 A。
 */
export function createWatchRegistry(attach: AttachConversation) {
  /** conversationId → 該對話的登記（清理函式 ＋ 上次 attach 的參數） */
  const watched = new Map<string, WatchRegistration>()

  /**
   * ⚠️ **先登記、再執行 attach() 的副作用**（契約不變式 C 末段）。
   *
   * 既有實作是 `attach()` 完成後才 `watched.set()`。沿用該順序的話，attach 期間
   * （它會送快照、補跑分析、publish presence）註冊表尚無條目，`stream.get.ts` 的
   * 推播過濾會把那個窗口內的分析事件一律判成「未 JOIN」而丟棄 ——
   * 又是一個不報錯的漏事件。
   */
  async function register(
    conversationId: string,
    priority: 'foreground' | 'background',
    joined: boolean,
  ): Promise<void> {
    // 先放一個 no-op 佔位，讓 isJoined() 在 attach 期間就答得出正確答案
    watched.set(conversationId, { off: () => {}, priority, joined })
    const off = await attach(conversationId, priority, joined)
    const current = watched.get(conversationId)
    // attach 期間可能已被 unwatch()／closeAll() 掃掉 —— 此時不可把 off 塞回去，
    // 否則會留下一份沒人解得掉的孤兒訂閱。直接就地解除。
    if (!current) {
      off()
      return
    }
    current.off = off
  }

  return {
    /**
     * 第零步：連線建立（含重連、含重新整理後的全新連線）時復原背景 watch。
     * 已在監看中的對話跳過——此時客服自己的 presence 心跳可能已經先把它升級成前景了。
     *
     * ⚠️ 這裡 **MUST 一併寫入 `{priority, joined}`**（由 `register()` 負責）。
     *    漏掉的症狀：復原的對話會在 20 秒後的第一次心跳被誤判為「首次」而重跑一輪完整分析
     *    —— 缺陷只縮小而未消除，且只在「重連後恰好滿 20 秒」時出現（契約不變式 A）。
     */
    async restoreJoined(load: () => Promise<string[]>): Promise<void> {
      for (const conversationId of await load()) {
        if (watched.has(conversationId)) continue
        await register(conversationId, 'background', true)
      }
    },

    /**
     * 控制通道的 `watch`。
     *
     * ⚠️ **不是每次都重新 attach()**（specs/003-analysis-trigger-policy FR-001、FR-002）。
     *    presence 心跳每 20 秒送一次，而 `attach()` 帶有「送快照 ＋ 補跑分析」的副作用 ——
     *    每次都走的話，一個放著不動的對話會每 20 秒重跑一輪完整分析
     *    （2026-08-27 於真實環境實測換算約 3,780 次 AI 呼叫／小時／對話）。
     *
     *    因此 `{priority, joined}` 與上一次**完全相同**時直接 return：不解舊訂閱、
     *    不 attach、不送快照、不補跑。任一欄位改變（切前景／切背景／JOIN／LEAVE）
     *    或註冊表中沒有條目（首次、重連、`unwatch()` 之後）才走既有路徑。
     *    完整的判定表見 contracts/analysis-trigger-contract.md 不變式 A。
     */
    async watch(
      conversationId: string,
      priority: 'foreground' | 'background',
      joined: boolean,
    ): Promise<void> {
      const prev = watched.get(conversationId)
      if (prev && prev.priority === priority && prev.joined === joined) return

      prev?.off()
      await register(conversationId, priority, joined)
    },

    /** 控制通道的 `unwatch`。條目連同 `{priority, joined}` 一併刪除 —— 下次 `watch()` 因此被正確地視為「首次」 */
    unwatch(conversationId: string): void {
      watched.get(conversationId)?.off()
      watched.delete(conversationId)
    },

    /** 連線關閉時解除全部監看（憲法 6.1：訂閱數歸零即停止輪詢） */
    closeAll(): void {
      for (const reg of watched.values()) reg.off()
      watched.clear()
    },

    has: (conversationId: string): boolean => watched.has(conversationId),

    /**
     * 這條連線對該對話有沒有 JOIN —— 契約不變式 C 的**唯一**資料來源
     * （specs/003-analysis-trigger-policy FR-016a，`stream.get.ts` 的 `forward()` 與分析快照）。
     *
     * ⚠️ **MUST 是註冊表回傳物件上的方法**（比照 `has()`），
     *    **MUST NOT** 改寫成 `stream-control.ts` 的模組層 `export function`：
     *    `watched` 住在本工廠函式的 closure 裡、**每條 SSE 連線一份**，模組層函式讀不到它，
     *    只能改用模組全域 Map —— 那等於所有連線共用一份 JOIN 狀態，
     *    A 客服接手與否會決定 B 客服收不收得到分析事件，而且完全不會報錯。
     */
    isJoined: (conversationId: string): boolean => watched.get(conversationId)?.joined ?? false,

    get size(): number {
      return watched.size
    },
  }
}
