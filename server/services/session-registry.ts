/**
 * CopilotSession 的觀察者計數 ＋ 輪詢 pipeline 的 refcount —— `session-manager.ts` 的**純核心**
 * （specs/005-m2-residual-defects US1、contracts/connection-lifecycle.md §2／§3／§6）。
 *
 * ── 為何從 `session-manager.ts` 抽出來 ─────────────────────────────
 * `session-manager.ts` import `copilot-runtime.ts`（要拿 `messageSource`），後者經
 * `server/utils/imbrace-client.ts` 用到 Nitro auto-import 的 `useRuntimeConfig()`。
 * vitest 一 import `session-manager.ts`，`tsconfig.scripts.json` 就整份紅（該檔開頭寫了這個陷阱，
 * `test/contract-guards.test.ts` 對分析管線守的正是同一件事）。
 * 而 FR-004 的驗收核心是一條**可執行的等式**：
 *
 * > **I-4**：`session.watchers.length === pipeline.refs` 在每一次 attach／release 完成後都成立。
 *
 * 等式的兩邊都住在這裡，`test/connection-counting.test.ts` 才驗得到它。`session-manager.ts`
 * 只負責把 `messageSource` 的訂閱與 EventBus 的推播接上來。
 *
 * ── 同一件事只有一個真相（FR-004）─────────────────────────────────
 * ⚠️ 2026-09-02 之前，同一個函式裡 `pipeline.refs` **有** refcount（先 `refs--` 再判 0），
 *    `session.watchers` **沒有**（去重的 operatorId、無條件 filter 到空就刪 session）。
 *    同一位客服關掉一個分頁 → watchers 歸零 → `deleteCopilotSession()` → 錨點不再前推 →
 *    自己送出的訊息被當成新訊息再 fan-out 一次；而 refs 還是 1、輪詢照跑。
 *    兩個計數器對同一件事給出不同答案，那個不變式破裂本身就是 bug 的形狀。
 *    現在兩邊都以 `connectionId` 為單位，每條連線一筆。
 *
 * ⚠️ `pipelines` 是 **process-local**（掛在 globalThis 只是為了 dev HMR），`watchers` 進 `StateStore`
 *    （M4 換 Redis 後跨副本）。多副本下 I-4 只在**單一副本內**成立 —— 這是既有落差
 *    （docs/ARCHITECTURE.md §18 M2 已盤點的八份 process-local 狀態同一家族），本模組不擴大也不解決。
 */

import { useStateStore } from '../state/index.js'
import type { CopilotSession, SessionWatcher, Unsubscribe } from '../state/types.js'

interface Pipeline {
  refs: number
  unsubscribePublisher: Unsubscribe
}

const KEY = Symbol.for('agent-copilot.session-pipelines')
type Global = typeof globalThis & { [KEY]?: Map<string, Pipeline> }

function pipelines(): Map<string, Pipeline> {
  const g = globalThis as Global
  if (!g[KEY]) g[KEY] = new Map()
  return g[KEY]
}

/**
 * 一條連線開始檢視一個對話：把它記進 `session.watchers`（每條連線一筆，I-6：同一 `connectionId`
 * 對同一對話至多一筆）。
 *
 * @returns `isResume`＝「這個對話在我 attach 之前已經有人在看」。
 *   ⚠️ **這是 005 的行為變更**（data-model.md §2）：舊判準是去重後的 `watchers.length > 1`，
 *   同一位客服的第二個分頁會是 `false`；改成連線計數後它是 `true`。`session.opened` 的 `reason`
 *   目前沒有前端消費者（全 repo grep 只有型別定義與測試的事件清單），但回歸清單 MUST 點名它。
 */
export async function attachWatcher(
  conversationId: string,
  watcher: SessionWatcher,
): Promise<{ session: CopilotSession, isResume: boolean }> {
  const store = useStateStore()
  const now = Date.now()
  const existing = await store.getCopilotSession(conversationId)
  const isResume = (existing?.watchers.length ?? 0) > 0

  const session: CopilotSession = existing
    ? {
        ...existing,
        watchers: existing.watchers.some(w => w.connectionId === watcher.connectionId)
          ? existing.watchers
          : [...existing.watchers, watcher],
        updatedAt: now,
      }
    : {
        conversationId,
        watchers: [watcher],
        lastMessageId: null,
        createdAt: now,
        updatedAt: now,
      }

  await store.setCopilotSession(session)
  return { session, isResume }
}

/**
 * 該對話的 pipeline refcount +1；0→1 時才建立 publisher（每個對話恰好一份，見 `session-manager.ts` 檔頭）。
 * ⚠️ 每一次 `attachWatcher()` 都 MUST 配一次本呼叫，否則 I-4 破裂。
 */
export function acquirePipeline(conversationId: string, createPublisher: () => Unsubscribe): void {
  const existing = pipelines().get(conversationId)
  if (existing) {
    existing.refs++
    return
  }
  pipelines().set(conversationId, { refs: 1, unsubscribePublisher: createPublisher() })
}

/**
 * 一條連線停止檢視：只移除**這一筆**（以 `connectionId` 為準，FR-003）。
 * `watchers` 歸零才 `deleteCopilotSession()`（I-5）—— 同一位客服的其他分頁完全不受影響（I-8）。
 */
export async function detachWatcher(conversationId: string, connectionId: string): Promise<void> {
  const store = useStateStore()
  const session = await store.getCopilotSession(conversationId)
  if (!session) return

  const watchers = session.watchers.filter(w => w.connectionId !== connectionId)
  if (watchers.length === 0) await store.deleteCopilotSession(conversationId)
  else await store.setCopilotSession({ ...session, watchers, updatedAt: Date.now() })
}

/**
 * 該對話的 pipeline refcount −1；歸零時拆掉 publisher。
 * @returns `'closed'`＝這次歸零（呼叫端該 publish `session.closed`）；`'open'`＝還有人；`'missing'`＝本來就沒有
 */
export function releasePipelineRef(conversationId: string): 'closed' | 'open' | 'missing' {
  const pipeline = pipelines().get(conversationId)
  if (!pipeline) return 'missing'

  pipeline.refs--
  if (pipeline.refs > 0) return 'open'

  pipeline.unsubscribePublisher()
  pipelines().delete(conversationId)
  return 'closed'
}

/** I-4 的右邊：該對話目前的 refcount；沒有 pipeline 時為 `null` */
export function pipelineRefs(conversationId: string): number | null {
  return pipelines().get(conversationId)?.refs ?? null
}

/** 監控用（§17）與測試用 */
export function pipelineCount(): number {
  return pipelines().size
}

/** 測試用：拆掉所有 pipeline（會呼叫各自的 unsubscribe） */
export function resetSessionRegistry(): void {
  for (const pipeline of pipelines().values()) pipeline.unsubscribePublisher()
  pipelines().clear()
}
