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
