/**
 * 第一層輪詢：整份對話清單 —— docs/ARCHITECTURE.md §9.3.1。
 *
 * ── 為何是清單而不是逐對話 ───────────────────────────────────────
 * 2026-08-25 實測確認 `conversations.search()` 的清單 payload 帶
 * `last_message_at` 與 `updated_at`，兩者都**即時更新**（≤2 秒）。
 * 因此一個請求就能同時回答三個原本各自為政的問題：
 *
 *   last_message_at 變了 → 該對話有新訊息
 *   updated_at 變了      → 該對話狀態變了（JOIN / LEAVE / 切換 mode）
 *   mode 是什麼          → 有沒有「我以外的人」能送出訊息（§10.2 來源 ③）
 *
 * 成本從逐對話輪詢的 ≈9.4 req/s 降到 ≈0.33 req/s，且**不隨對話數增加**。
 *
 * ── 兩個必須記住的邊界 ───────────────────────────────────────────
 * ⚠️ ① `last_message_at` 實測填充率僅 83%。為空的對話偵測不到新訊息，
 *      必須由第二層（PollingMessageSource）以完整 §9.2 頻率兜底 ——
 *      本檔的 `isListCovered()` 就是那個判斷。
 * ⚠️ ② 清單答不出「是誰」。`users[]` 是團隊名冊（§10.2），
 *      所以這裡**只發出 ConversationChange，不發 JoinEvent** ——
 *      發 JoinEvent 就得捏造一個 operator，那是 §10.2 明文禁止的。
 */

import type { Conversation } from '../../shared/types/conversation.js'
import type { ConversationChange, Unsubscribe } from './types.js'

/** 有人前景在線時的間隔（§9.2 前景聚焦 3s） */
export const LIST_INTERVAL_FOREGROUND_MS = 3_000
/** 全部客服的分頁都在背景（§9.2「瀏覽器分頁 hidden 全部降至 30s 以上」） */
export const LIST_INTERVAL_BACKGROUND_MS = 30_000

interface Snapshot {
  lastMessageAt?: string
  updatedAt: string
  mode: Conversation['mode']
}

export interface ListPollerDeps {
  /** 取回目前整份清單。生產環境是 `conversations.search()`，測試直接給假資料 */
  fetchAll: () => Promise<Conversation[]>
  /** 是否有人前景在線 —— 決定間隔 */
  hasForeground: () => boolean
  /** 輪詢失敗時回報（不中斷迴圈，見憲法第三條「靜默降級」） */
  onError?: (err: unknown) => void
}

type ChangeHandler = (change: ConversationChange) => void

export class ConversationListPoller {
  private snapshots = new Map<string, Snapshot>()
  /** 最新的完整快照 —— 路由可直接讀 mode，不必為此多打一次詳情 API */
  private cache = new Map<string, Conversation>()
  private handlers = new Set<ChangeHandler>()
  private timer: NodeJS.Timeout | undefined
  private running = false
  /** 監控用（§17）：跑了幾次、失敗幾次 */
  private stats = { polls: 0, failures: 0, changes: 0 }

  constructor(private readonly deps: ListPollerDeps) {}

  onChange(handler: ChangeHandler): Unsubscribe {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** 目前已知的對話快照 —— 供路由避免為了讀 mode 而多打一次 API */
  latest(conversationId: string): Conversation | undefined {
    return this.cache.get(conversationId)
  }

  /** 整份清單的最新快照（側欄用） */
  all(): Conversation[] {
    return [...this.cache.values()]
  }

  /**
   * 這個對話能否靠清單輪詢偵測到新訊息。
   *
   * ⚠️ 回 false 時第二層**不能**降頻，否則那 17% 的對話會變成「訊息要 30 秒才出現」。
   */
  isListCovered(conversationId: string): boolean {
    return this.snapshots.get(conversationId)?.lastMessageAt !== undefined
  }

  metrics(): Readonly<{ polls: number, failures: number, changes: number, tracked: number }> {
    return { ...this.stats, tracked: this.snapshots.size }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** 目前的輪詢間隔（測試與監控用） */
  intervalMs(): number {
    return this.deps.hasForeground()
      ? LIST_INTERVAL_FOREGROUND_MS
      : LIST_INTERVAL_BACKGROUND_MS
  }

  private async loop(): Promise<void> {
    if (!this.running) return
    await this.tick()
    if (!this.running) return
    this.timer = setTimeout(() => void this.loop(), this.intervalMs())
    // 這個計時器不該讓 Node 程序無法退出
    this.timer.unref?.()
  }

  /**
   * 跑一次比對。測試直接呼叫這支，不必動計時器。
   *
   * ⚠️ 失敗時只記錄不拋出：輪詢是背景迴圈，一次網路抖動不該讓整個迴圈死掉，
   *    也不該讓客服看到錯誤畫面（憲法 3.2 靜默降級）。
   */
  async tick(): Promise<ConversationChange[]> {
    this.stats.polls++
    let list: Conversation[]
    try {
      list = await this.deps.fetchAll()
    }
    catch (err) {
      this.stats.failures++
      this.deps.onError?.(err)
      return []
    }

    const changes: ConversationChange[] = []

    for (const conv of list) {
      this.cache.set(conv.id, conv)
      const prev = this.snapshots.get(conv.id)
      const next: Snapshot = {
        lastMessageAt: conv.lastMessageAt,
        updatedAt: conv.updatedAt,
        mode: conv.mode ?? null,
      }
      this.snapshots.set(conv.id, next)

      if (!prev) {
        // 首輪：全部都是「新的」，但那不是變動。不發事件，只建立基準。
        continue
      }

      const hasNewMessages
        = next.lastMessageAt !== undefined && next.lastMessageAt !== prev.lastMessageAt
      const modeChanged = (next.mode ?? null) !== (prev.mode ?? null)
      const touched = next.updatedAt !== prev.updatedAt

      if (!hasNewMessages && !modeChanged && !touched) continue

      changes.push({
        conversationId: conv.id,
        conversation: conv,
        hasNewMessages,
        modeChanged,
        previousMode: prev.mode ?? null,
        isFirstSight: false,
      })
    }

    this.stats.changes += changes.length
    for (const change of changes) this.emit(change)
    return changes
  }

  private emit(change: ConversationChange): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(change)
      }
      catch (err) {
        // 單一訂閱者爆掉不得影響其他訂閱者與輪詢迴圈本身
        this.deps.onError?.(err)
      }
    }
  }
}
