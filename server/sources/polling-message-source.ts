/**
 * 第二層輪詢：單一對話的訊息 —— docs/ARCHITECTURE.md §9.1 / §9.2 / §9.3。
 *
 * 三個硬性要求，缺一不可：
 *
 *  ① **共享訂閱**（憲法 6.1）：以 conversationId 為鍵 refcount，
 *     三位客服檢視同一對話只輪詢一次，結果 fan-out。訂閱數歸零即停止。
 *  ② **只取最新 N 則**（§9.3）：實測單一對話最多 398 則，全量取回是真正的成本所在。
 *  ③ **本地 lastMessageId 比對**：平台不支援增量拉取（八種寫法全被忽略），
 *     所以「只推新增的部分給前端」這件事只能在我方做。
 *
 * ── 與第一層的分工 ───────────────────────────────────────────────
 * §9.3.1 的清單輪詢已經能在 ≤3 秒內知道「哪個對話有新訊息」，
 * 所以本層在**被清單涵蓋**的對話上不需要用 §9.2 的頻率空轉 ——
 * 改由 `poke()` 驅動，自身計時器降為 30 秒的對帳輪詢（與 §9.4 同一個原則：
 * 推播會漏，真相一律回源頭對帳）。
 *
 * ⚠️ 但清單的 `last_message_at` 填充率只有 83%。**沒被涵蓋的對話必須跑滿 §9.2 頻率**，
 *    否則那 17% 會變成「訊息要 30 秒才出現」—— 而且完全不會報錯。
 */

import type { Message } from '../../shared/types/conversation.js'
import type { StateStore } from '../state/types.js'
import type {
  MessageSource,
  SubscribeOptions,
  Unsubscribe,
  WatchPriority,
} from './types.js'

// ── §9.2 自適應頻率表 ───────────────────────────────────────────────────
//
// ⚠️ 這組數字是 2026-08-25 依實測**放寬**後的值，不是原始設計值。
//    原表建立在「支援 since 增量拉取」的假設上，而實測 since/after/since_id
//    等八種寫法全部被忽略，每次輪詢都是全量取回 —— 不能沿用原頻率。
//
// ⚠️ 前景已 JOIN 從 1.5s 放寬到 3s 是**刻意**的：撞單防護的有效性不靠輪詢頻率，
//    真正有效的是 §10.4 送出前的樂觀併發檢查，那一層在按下送出的當下才比對版本。
//    輪詢頻率只影響「畫面上多久看到同事的訊息」。

export const POLL_FOREGROUND_JOINED_MS = 3_000
export const POLL_FOREGROUND_WATCHING_MS = 5_000
export const POLL_BACKGROUND_JOINED_MS = 15_000
export const POLL_BACKGROUND_WATCHING_MS = 30_000
/** 連續無新訊息時的退避上限 */
export const POLL_BACKOFF_MAX_MS = 60_000
/** 連續幾次無新訊息後開始退避 */
export const POLL_BACKOFF_AFTER = 5
/** 被第一層清單輪詢涵蓋時，自身只做低頻對帳（§9.4 同一原則） */
export const POLL_RECONCILE_MS = 30_000

export interface PollState {
  priority: WatchPriority
  joined: boolean
  /** 連續幾次拉回來沒有新訊息 */
  emptyStreak: number
}

/**
 * §9.2 修訂表的純函式版本 —— 可直接對著文件逐行核對，也可直接測。
 *
 * ⚠️ 不含「被清單涵蓋時降為對帳頻率」的最佳化，那一層在 `effectiveIntervalMs()`。
 *    兩者分開是刻意的：這支必須永遠等於文件上的表，
 *    否則日後有人改了最佳化，會連帶把文件的驗收基準一起改掉而沒人發現。
 */
export function pollIntervalMs(state: PollState): number {
  const base = state.priority === 'foreground'
    ? (state.joined ? POLL_FOREGROUND_JOINED_MS : POLL_FOREGROUND_WATCHING_MS)
    : (state.joined ? POLL_BACKGROUND_JOINED_MS : POLL_BACKGROUND_WATCHING_MS)

  if (state.emptyStreak < POLL_BACKOFF_AFTER) return base

  // 第 5 次起指數退避：base×2、×4、×8…，上限 60s
  const factor = 2 ** (state.emptyStreak - POLL_BACKOFF_AFTER + 1)
  return Math.min(base * factor, POLL_BACKOFF_MAX_MS)
}

interface Entry {
  conversationId: string
  /** operatorId → 該訂閱者的優先度。⚠️ 用 Map 而非計數器 —— 見 subscribe() */
  subscribers: Map<symbol, { onNew: (m: Message[]) => void, opts: Required<SubscribeOptions> }>
  lastMessageId: string | null
  emptyStreak: number
  timer: NodeJS.Timeout | undefined
  inFlight: boolean
  /** poll lock 的持有狀態（M4 多副本用；M1 單副本時永遠是我方持有） */
  lockOwned: boolean
  lockUntil: number
  pollCount: number
}

export interface MessageSourceDeps {
  /** 取某對話的最新 N 則（由舊到新）。生產環境是 `message-fetch.fetchLatest()` */
  fetchLatest: (conversationId: string) => Promise<Message[]>
  store: StateStore
  /** 該對話能否靠第一層清單輪詢偵測新訊息（§9.3.1，填充率 83%） */
  isListCovered: (conversationId: string) => boolean
  onError?: (conversationId: string, err: unknown) => void
}

export class PollingMessageSource implements MessageSource {
  private entries = new Map<string, Entry>()

  constructor(private readonly deps: MessageSourceDeps) {}

  /**
   * 共享訂閱（憲法 6.1）。
   *
   * ⚠️ 訂閱者以 `symbol` 為鍵而不是 operatorId：同一位客服可能同時開兩個分頁，
   *    用 operatorId 當鍵會讓第一個分頁關閉時把第二個也一起退訂 ——
   *    症狀是「開兩個分頁後，關掉其中一個，另一個就不再更新」。
   */
  subscribe(
    conversationId: string,
    onNew: (messages: Message[]) => void,
    opts: SubscribeOptions = {},
  ): Unsubscribe {
    const entry = this.entries.get(conversationId) ?? this.createEntry(conversationId)
    const token = Symbol('subscriber')

    entry.subscribers.set(token, {
      onNew,
      opts: { priority: opts.priority ?? 'foreground', joined: opts.joined ?? false },
    })

    // 第一位訂閱者：立刻拉一次，不要等一個輪詢週期
    if (entry.subscribers.size === 1) void this.pollNow(entry)
    else this.reschedule(entry)

    let done = false
    return () => {
      if (done) return
      done = true
      entry.subscribers.delete(token)
      if (entry.subscribers.size === 0) void this.teardown(entry)
      else this.reschedule(entry)
    }
  }

  async fetchSince(conversationId: string, sinceMessageId?: string | null): Promise<Message[]> {
    const all = await this.deps.fetchLatest(conversationId)
    if (!sinceMessageId) return all
    const idx = all.findIndex(m => m.id === sinceMessageId)
    return idx >= 0 ? all.slice(idx + 1) : all
  }

  /** 第一層說「這個對話有新東西」→ 立刻拉，並把退避歸零 */
  poke(conversationId: string): void {
    const entry = this.entries.get(conversationId)
    if (!entry) return
    entry.emptyStreak = 0
    void this.pollNow(entry)
  }

  /**
   * specs/002-suggestion-knowledge-search/research.md #9：背景並行節流的判斷依據，
   * 直接重用既有的「前景蓋過背景」聚合邏輯（aggregateState()），不另訂一套規則。
   * 目前無任何訂閱者時回傳 'background'（安全預設）。
   */
  getPriority(conversationId: string): WatchPriority {
    const entry = this.entries.get(conversationId)
    if (!entry) return 'background'
    return this.aggregateState(entry).priority
  }

  /**
   * 送出訊息後呼叫：把本地錨點推到最新，避免自己送的那則被當成「別人的新訊息」
   * 再 fan-out 一次。
   */
  seed(conversationId: string, lastMessageId: string | null): void {
    const entry = this.entries.get(conversationId)
    if (entry && lastMessageId) entry.lastMessageId = lastMessageId
  }

  /** 監控與驗收用：§18 M1「三個瀏覽器檢視同一對話時只被輪詢一次」靠這個驗 */
  metrics(conversationId: string): { subscribers: number, polls: number, intervalMs: number } | null {
    const entry = this.entries.get(conversationId)
    if (!entry) return null
    return {
      subscribers: entry.subscribers.size,
      polls: entry.pollCount,
      intervalMs: this.effectiveIntervalMs(entry),
    }
  }

  /** 目前正在輪詢的對話數（§17 監控指標） */
  activeCount(): number {
    return this.entries.size
  }

  /** 程序關閉／測試收尾：停掉所有計時器並釋放鎖 */
  async dispose(): Promise<void> {
    await Promise.all([...this.entries.values()].map(e => this.teardown(e)))
  }

  // ── 內部 ────────────────────────────────────────────────────────────

  private createEntry(conversationId: string): Entry {
    const entry: Entry = {
      conversationId,
      subscribers: new Map(),
      lastMessageId: null,
      emptyStreak: 0,
      timer: undefined,
      inFlight: false,
      lockOwned: false,
      lockUntil: 0,
      pollCount: 0,
    }
    this.entries.set(conversationId, entry)
    return entry
  }

  /**
   * 整個 entry 的輪詢頻率取**所有訂閱者中最急的那一個**。
   *
   * 理由：一位客服前景聚焦、另一位背景掛著，該對話對前者而言就是前景。
   * 取最慢的會讓前景那位看到延遲的畫面，而他根本不知道是別人的設定造成的。
   */
  private aggregateState(entry: Entry): PollState {
    let priority: WatchPriority = 'background'
    let joined = false
    for (const { opts } of entry.subscribers.values()) {
      if (opts.priority === 'foreground') priority = 'foreground'
      if (opts.joined) joined = true
    }
    return { priority, joined, emptyStreak: entry.emptyStreak }
  }

  private effectiveIntervalMs(entry: Entry): number {
    const base = pollIntervalMs(this.aggregateState(entry))
    // 被第一層涵蓋 → 自身只做低頻對帳，即時性由 poke() 提供
    return this.deps.isListCovered(entry.conversationId)
      ? Math.max(base, POLL_RECONCILE_MS)
      : base
  }

  private reschedule(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.subscribers.size === 0) return
    entry.timer = setTimeout(() => void this.pollNow(entry), this.effectiveIntervalMs(entry))
    entry.timer.unref?.()
  }

  /**
   * ⚠️ `inFlight` 不是最佳化，是正確性。
   * 沒有它時，一次慢請求（實測最慢可達數秒）會讓下一輪的計時器再送一個請求出去，
   * 累積成雪崩 —— 而 §9.3 的「並發控制」要求正是為了避免觸發未知的 rate limit。
   */
  private async pollNow(entry: Entry): Promise<void> {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined

    if (entry.inFlight || entry.subscribers.size === 0) return
    entry.inFlight = true

    try {
      if (!await this.holdLock(entry)) {
        // 另一個副本正在輪詢這個對話 —— 它會把結果 publish 到 EventBus，
        // 我方不必也不該重複打 API（§9.1 多副本協調）
        return
      }

      entry.pollCount++
      const messages = await this.deps.fetchLatest(entry.conversationId)
      const fresh = this.sliceNew(entry, messages)

      if (fresh.length === 0) {
        entry.emptyStreak++
        return
      }

      entry.emptyStreak = 0
      entry.lastMessageId = fresh[fresh.length - 1]?.id ?? entry.lastMessageId
      for (const { onNew } of [...entry.subscribers.values()]) {
        try {
          onNew(fresh)
        }
        catch (err) {
          // 單一訂閱者爆掉不得影響其他訂閱者（憲法 3.2）
          this.deps.onError?.(entry.conversationId, err)
        }
      }
    }
    catch (err) {
      entry.emptyStreak++
      this.deps.onError?.(entry.conversationId, err)
    }
    finally {
      entry.inFlight = false
      this.reschedule(entry)
    }
  }

  /**
   * 本地 lastMessageId 比對（§9.3 緩解措施 ②）。
   *
   * ⚠️ 首次拉取（`lastMessageId === null`）要把整批都當「新的」推給訂閱者 ——
   *    那是訊息流的初始內容。之後才是真正的增量。
   *
   * ⚠️ 錨點找不到時（斷線太久，已被 N 則的視窗擠出去）回傳整批。
   *    上層以 messageId 去重，寧可重送也不可漏送 —— 漏一則訊息是最難追查的 bug（§9.4）。
   */
  private sliceNew(entry: Entry, messages: Message[]): Message[] {
    if (messages.length === 0) return []
    if (entry.lastMessageId === null) return messages

    const idx = messages.findIndex(m => m.id === entry.lastMessageId)
    return idx >= 0 ? messages.slice(idx + 1) : messages
  }

  /**
   * 多副本協調（§9.1）。M1 單副本時永遠取得，這段是為 M4 準備的。
   *
   * ⚠️ 續租寫成「先 release 再 acquire」：`StateStore.acquirePollLock()` 的語意是
   *    「未過期就拒絕」，包含拒絕鎖的持有者自己。中間那一瞬間理論上可被別的副本插隊，
   *    但後果只是輪詢換人做，不影響正確性 —— 結果一律經 EventBus fan-out。
   */
  private async holdLock(entry: Entry): Promise<boolean> {
    const ttl = Math.max(this.effectiveIntervalMs(entry) * 3, 10_000)
    const now = Date.now()

    if (entry.lockOwned && now < entry.lockUntil - ttl / 2) return true

    if (entry.lockOwned) await this.deps.store.releasePollLock(entry.conversationId)

    entry.lockOwned = await this.deps.store.acquirePollLock(entry.conversationId, ttl)
    entry.lockUntil = now + ttl
    return entry.lockOwned
  }

  private async teardown(entry: Entry): Promise<void> {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    this.entries.delete(entry.conversationId)
    if (entry.lockOwned) {
      entry.lockOwned = false
      await this.deps.store.releasePollLock(entry.conversationId)
    }
  }
}
