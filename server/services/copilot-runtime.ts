/**
 * 每個組織一份的輪詢執行環境 —— 把 §9.3.1 的兩層輪詢接起來。
 *
 * ```
 * 第一層（永遠在跑）：conversations.search()      ← 1 個請求，涵蓋全部對話
 *          │
 *          ├─ last_message_at 變了 → messageSource.poke()  → 第二層立刻拉該對話
 *          ├─ mode 變了           → control.updated / presence.updated
 *          └─ 任何變動            → conversation.updated（側欄徽記）
 * ```
 *
 * ⚠️ 實例掛在 globalThis 而非模組變數：dev 模式下 Nitro HMR 會重新載入模組，
 *    模組層級的單例會被重建，輪詢迴圈與 refcount 全部歸零而舊的計時器還在跑。
 *
 * ⚠️ 第一層只在「該組織有人連線」時才跑。沒人連線時 `borrowCredential()` 回 null，
 *    `fetchAll` 直接回空陣列 —— 迴圈空轉的成本遠低於「忘記重新啟動」的風險。
 */

import type { Conversation as SdkConversation } from '@imbrace/sdk'
import { controlFromMode } from '../../shared/types/conversation.js'
import type { CopilotEvent } from '../../shared/types/events.js'
import { ConversationListPoller } from '../sources/conversation-list-poller.js'
import { fetchLatest } from '../sources/message-fetch.js'
import { toConversation, unwrapPaged } from '../sources/mappers.js'
import { PollingMessageSource } from '../sources/polling-message-source.js'
import { imbraceClientForPolling } from '../utils/imbrace-client.js'
import { useEventBus, useStateStore } from '../state/index.js'
import { conversationTopic, organizationTopic } from '../state/types.js'
import { resolveBusinessUnitId } from './business-unit.js'
import { setJoinedResolver } from './copilot-analysis.js'
import {
  borrowCredential,
  hasForegroundOperator,
} from './credentials.js'
import { snapshotOf } from './presence.js'

/** 第一層一次取回的對話數上限。超過此數的組織需分頁 —— 見下方 TODO */
const LIST_PAGE_SIZE = 100

export interface CopilotRuntime {
  orgId: string
  listPoller: ConversationListPoller
  messageSource: PollingMessageSource
  /** 停掉所有計時器（程序關閉、測試收尾） */
  dispose: () => Promise<void>
}

const KEY = Symbol.for('agent-copilot.copilot-runtime')
type Global = typeof globalThis & { [KEY]?: Map<string, CopilotRuntime> }

function runtimes(): Map<string, CopilotRuntime> {
  const g = globalThis as Global
  if (!g[KEY]) g[KEY] = new Map()
  return g[KEY]
}

export function useCopilotRuntime(orgId: string): CopilotRuntime {
  const existing = runtimes().get(orgId)
  if (existing) return existing

  const runtime = createRuntime(orgId)
  runtimes().set(orgId, runtime)
  runtime.listPoller.start()
  return runtime
}

/**
 * 該對話目前是否仍有任何人 JOIN（我方系統內）—— specs/003-analysis-trigger-policy 決策 3。
 *
 * ⚠️ 不需要 `orgId`：一個對話只屬於一個組織，其餘組織的 `messageSource` 對它沒有 entry
 *    而回傳 `false`，因此「任一組織說 true 即為 true」與「先找出正確的組織再問」等價，
 *    但不必把 orgId 一路穿過 `copilot-analysis.ts` 的每一個入口。
 */
export function isConversationJoined(conversationId: string): boolean {
  for (const runtime of runtimes().values()) {
    if (runtime.messageSource.isJoined(conversationId)) return true
  }
  return false
}

/**
 * ⚠️ **裝配點，MUST NOT 刪除。** `copilot-analysis.ts` 需要上面那個判斷來守住 FR-012 的
 *    JOIN 界線，但它**不能**反向 import 本檔：本檔經 `server/utils/imbrace-client.ts`
 *    用到 Nitro auto-import 的 `useRuntimeConfig()`，一旦被 `test/` 間接拉進型別圖，
 *    `tsconfig.scripts.json` 會整份紅（該檔開頭已把這個陷阱寫成警告）。
 *    因此相依方向反過來，由這裡在載入時注入。
 *
 *    這一行被刪掉時解析器會退回「一律視為已 JOIN」，症狀是 LEAVE 之後分析照跑、
 *    面板事件照送 —— **不報錯、不會有型別錯誤**。`test/contract-guards.test.ts`
 *    因此直接掃描本檔是否仍有這行呼叫。
 */
setJoinedResolver(isConversationJoined)

/** 測試與程序關閉用 */
export async function disposeAllRuntimes(): Promise<void> {
  const all = [...runtimes().values()]
  runtimes().clear()
  await Promise.all(all.map(r => r.dispose()))
}

function createRuntime(orgId: string): CopilotRuntime {
  const bus = useEventBus()
  const store = useStateStore()

  const listPoller = new ConversationListPoller({
    fetchAll: () => fetchConversationList(orgId),
    hasForeground: () => hasForegroundOperator(orgId),
    onError: err => logPollFailure('list', orgId, err),
  })

  const messageSource = new PollingMessageSource({
    fetchLatest: convId => fetchMessagesFor(orgId, convId),
    store,
    isListCovered: convId => listPoller.isListCovered(convId),
    onError: (convId, err) => logPollFailure('messages', convId, err),
  })

  const offChange = listPoller.onChange((change) => {
    // ① 新訊息 → 叫第二層立刻拉（第二層才知道「新了哪幾則」）
    if (change.hasNewMessages) messageSource.poke(change.conversationId)

    // ② 側欄：任何變動都要讓清單重新排序與顯示徽記
    void publish(bus, organizationTopic(orgId), {
      type: 'conversation.updated',
      conversationId: change.conversationId,
      lastMessageAt: change.conversation.lastMessageAt,
    })

    // ③ mode 變了 → Composer 可用性與 presence ③ 都要跟著變
    //    ⚠️ 這是對話層級的共用狀態：同事切成 Automation Only 時，
    //       我方的 Composer 也會被停用。畫面必須說清楚原因（§10.6）。
    if (change.modeChanged) {
      void publish(bus, conversationTopic(change.conversationId), {
        type: 'control.updated',
        conversationId: change.conversationId,
        control: controlFromMode(change.conversation.mode),
      })
      void publishPresence(change.conversationId, change.conversation.mode ?? null)
    }
  })

  async function publishPresence(conversationId: string, mode: Parameters<typeof controlFromMode>[0]): Promise<void> {
    // ⚠️ 這裡不排除任何人也不帶 viewerJoined —— 廣播版本無法針對個別檢視者調整。
    //    每個 SSE 連線收到後會依自己的身分重算（見 server/api/stream.get.ts）。
    const presence = await snapshotOf(store, conversationId, { mode: mode ?? null })
    await publish(bus, conversationTopic(conversationId), {
      type: 'presence.updated',
      conversationId,
      presence,
    })
  }

  return {
    orgId,
    listPoller,
    messageSource,
    dispose: async () => {
      offChange()
      listPoller.stop()
      await messageSource.dispose()
    },
  }
}

async function publish(
  bus: ReturnType<typeof useEventBus>,
  topic: string,
  event: CopilotEvent,
): Promise<void> {
  await bus.publish(topic, event)
}

/**
 * 第一層取數。
 *
 * ⚠️ 用 `search()` 而非 `list()`：後者沒有 business unit scope 時**永遠回空陣列且不報錯**
 *    —— 「症狀看起來像沒資料、實際是查詢方式錯」的典型坑。
 *
 * TODO(M2)：對話數超過 LIST_PAGE_SIZE 的組織需要分頁。
 * 目前刻意不做 —— 沒有實際資料前不知道該用 skip 分頁還是改查 `_outstanding`，
 * 兩者的成本模型差很多。真的超過時第一層會安靜地漏掉尾端的對話，
 * 因此 `metrics().tracked` 貼到上限即為警訊（§17）。
 */
async function fetchConversationList(orgId: string) {
  const cred = borrowCredential(orgId)
  // 沒有人連線 → 不輪詢。輪詢是為了推給人看的，沒人看就不必打 API
  if (!cred) return []

  const client = imbraceClientForPolling(cred)
  const businessUnitId = await resolveBusinessUnitId(client, orgId)
  const res = await client.conversations.search({
    businessUnitId,
    q: '',
    limit: LIST_PAGE_SIZE,
  })
  return unwrapPaged<SdkConversation>(res).map(toConversation)
}

async function fetchMessagesFor(orgId: string, conversationId: string) {
  const cred = borrowCredential(orgId)
  if (!cred) return []
  return fetchLatest(imbraceClientForPolling(cred), conversationId)
}

/**
 * ⚠️ 憲法 1.5：日誌不得輸出訊息全文，也不得輸出 token。
 *    這裡只留「哪一層、哪個 id、什麼錯誤訊息」。
 */
function logPollFailure(layer: string, id: string, err: unknown): void {
  console.error(`[poll:${layer}] ${id}: ${err instanceof Error ? err.message : String(err)}`)
}
