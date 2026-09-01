/**
 * StateStore 的記憶體實作 —— docs/ARCHITECTURE.md §8.3。
 *
 * ⚠️ 僅適用單副本。一旦上 K8s 多副本，presence 會各副本一份、poll lock 形同虛設、
 *    去重失效（§16.1）。M4 換 redis-store.ts —— 因為介面全 async，換掉不動呼叫端。
 *
 * 過期處理採「讀取時惰性淘汰 + 定期掃除」雙軌：
 * 惰性淘汰保證正確性，定期掃除保證沒人讀的 key 不會無限累積記憶體。
 */

import type {
  CopilotAnalysisState,
  CopilotSession,
  Session,
  StateStore,
  ViewerJoinedEntry,
} from './types.js'
import type { PresenceEntry } from '../../shared/types/conversation.js'

interface Expiring<T> {
  value: T
  expiresAt: number
}

const SWEEP_INTERVAL_MS = 60_000

/**
 * 「我有沒有 JOIN」快取的**每位客服**上限（ARCHITECTURE §10.2.1）。
 *
 * ⚠️ 這個快取沒有 TTL —— 它的失效訊號是 `mode` 變動，不是時間（見 `ViewerJoinedEntry`）。
 *    沒有 TTL 就沒有東西會自然淘汰它，因此必須自己設上限：上線後一天可能有數百則對話，
 *    每一則被列出來都會留下一筆，不設限就是一條慢速的記憶體洩漏。
 *
 * ⚠️ 取 500 是「側欄載入上限 100（`BACKGROUND_COVERAGE`）」的五倍 ——
 *    要能同時裝下客服來回捲動、切換篩選所觸及的範圍，又不至於無限成長。
 *    淘汰採插入順序（Map 的天然順序）：最舊的先走，被淘汰的下次會重新解析一次，
 *    只是多一次 API 呼叫，不會答錯。
 */
const VIEWER_JOINED_CACHE_MAX = 500

function alive<T>(e: Expiring<T> | undefined, now: number): e is Expiring<T> {
  return e !== undefined && e.expiresAt > now
}

export class MemoryStateStore implements StateStore {
  private sessions = new Map<string, Session>()
  private copilots = new Map<string, CopilotSession>()
  private analysisStates = new Map<string, Expiring<CopilotAnalysisState>>()
  /** convId → (operatorId → entry) */
  private presence = new Map<string, Map<string, Expiring<PresenceEntry>>>()
  private pollLocks = new Map<string, number>()
  private seenKeys = new Map<string, number>()
  /** operatorId → 已 JOIN 的 conversationId 集合（specs/002-suggestion-knowledge-search，不設 TTL） */
  private joinedConversations = new Map<string, Set<string>>()
  /** operatorId → (conversationId → 判定)。⚠️ 記得住 false，這是它與上面那個的關鍵差別 */
  private viewerJoined = new Map<string, Map<string, ViewerJoinedEntry>>()

  private sweeper: NodeJS.Timeout | undefined

  constructor(opts: { autoSweep?: boolean } = {}) {
    if (opts.autoSweep !== false) {
      // unref：這個計時器不該讓 Node 程序無法退出
      this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
      this.sweeper.unref()
    }
  }

  /** 測試與程序關閉時呼叫，停掉掃除計時器 */
  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
  }

  // ── Session ────────────────────────────────────────────────────────

  async getSession(id: string): Promise<Session | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(id)
      return null
    }
    return s
  }

  async setSession(id: string, s: Session): Promise<void> {
    this.sessions.set(id, s)
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id)
  }

  // ── CopilotSession ─────────────────────────────────────────────────

  async getCopilotSession(convId: string): Promise<CopilotSession | null> {
    return this.copilots.get(convId) ?? null
  }

  async setCopilotSession(s: CopilotSession): Promise<void> {
    this.copilots.set(s.conversationId, s)
  }

  async deleteCopilotSession(convId: string): Promise<void> {
    this.copilots.delete(convId)
  }

  // ── CopilotAnalysisState（specs/001-sentiment-panel，比照 presence 的雙軌淘汰）───

  async getAnalysisState(convId: string): Promise<CopilotAnalysisState | null> {
    const entry = this.analysisStates.get(convId)
    if (!alive(entry, Date.now())) {
      this.analysisStates.delete(convId)
      return null
    }
    return entry.value
  }

  async setAnalysisState(s: CopilotAnalysisState, ttlMs: number): Promise<void> {
    this.analysisStates.set(s.conversationId, { value: s, expiresAt: Date.now() + ttlMs })
  }

  // ── Presence ───────────────────────────────────────────────────────

  async addPresence(convId: string, op: PresenceEntry, ttlMs: number): Promise<void> {
    let byOperator = this.presence.get(convId)
    if (!byOperator) {
      byOperator = new Map()
      this.presence.set(convId, byOperator)
    }
    byOperator.set(op.operatorId, { value: op, expiresAt: Date.now() + ttlMs })
  }

  async removePresence(convId: string, operatorId: string): Promise<void> {
    const byOperator = this.presence.get(convId)
    if (!byOperator) return
    byOperator.delete(operatorId)
    if (byOperator.size === 0) this.presence.delete(convId)
  }

  async listPresence(convId: string): Promise<PresenceEntry[]> {
    const byOperator = this.presence.get(convId)
    if (!byOperator) return []
    const now = Date.now()
    const out: PresenceEntry[] = []
    for (const [operatorId, entry] of byOperator) {
      if (alive(entry, now)) out.push(entry.value)
      else byOperator.delete(operatorId)
    }
    if (byOperator.size === 0) this.presence.delete(convId)
    return out
  }

  // ── 多副本協調 ──────────────────────────────────────────────────────

  async acquirePollLock(convId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now()
    const heldUntil = this.pollLocks.get(convId)
    if (heldUntil !== undefined && heldUntil > now) return false
    this.pollLocks.set(convId, now + ttlMs)
    return true
  }

  async releasePollLock(convId: string): Promise<void> {
    this.pollLocks.delete(convId)
  }

  // ── 背景 JOIN 持久追蹤（不設 TTL，見 StateStore 介面註解）───────────────

  async addJoinedConversation(operatorId: string, conversationId: string): Promise<void> {
    let set = this.joinedConversations.get(operatorId)
    if (!set) {
      set = new Set()
      this.joinedConversations.set(operatorId, set)
    }
    set.add(conversationId)
  }

  async removeJoinedConversation(operatorId: string, conversationId: string): Promise<void> {
    const set = this.joinedConversations.get(operatorId)
    if (!set) return
    set.delete(conversationId)
    if (set.size === 0) this.joinedConversations.delete(operatorId)
  }

  async listJoinedConversations(operatorId: string): Promise<string[]> {
    return [...(this.joinedConversations.get(operatorId) ?? [])]
  }

  // ── 「你在此對話中」的判定快取（§10.2.1）────────────────────────────

  async getViewerJoined(
    operatorId: string,
    conversationId: string,
  ): Promise<ViewerJoinedEntry | undefined> {
    return this.viewerJoined.get(operatorId)?.get(conversationId)
  }

  async setViewerJoined(
    operatorId: string,
    conversationId: string,
    entry: ViewerJoinedEntry,
  ): Promise<void> {
    let byConv = this.viewerJoined.get(operatorId)
    if (!byConv) {
      byConv = new Map()
      this.viewerJoined.set(operatorId, byConv)
    }
    /*
      ⚠️ 先 delete 再 set —— Map 對「已存在的 key 重新賦值」**不會**更新插入順序，
         少了這一行，一直在被使用的熱門對話會停在原本的位置，
         淘汰時反而先被丟掉，而真正冷掉的那些卻留著。
    */
    byConv.delete(conversationId)
    byConv.set(conversationId, entry)

    while (byConv.size > VIEWER_JOINED_CACHE_MAX) {
      const oldest = byConv.keys().next()
      if (oldest.done) break
      byConv.delete(oldest.value)
    }
  }

  // ── 去重 ────────────────────────────────────────────────────────────

  /** ⚠️ true = 先前已見過（重複，應丟棄）；false = 首見（已記錄） */
  async seen(eventKey: string, ttlMs: number): Promise<boolean> {
    const now = Date.now()
    const until = this.seenKeys.get(eventKey)
    if (until !== undefined && until > now) return true
    this.seenKeys.set(eventKey, now + ttlMs)
    return false
  }

  // ── 掃除 ────────────────────────────────────────────────────────────

  sweep(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(id)
    }
    for (const [convId, entry] of this.analysisStates) {
      if (!alive(entry, now)) this.analysisStates.delete(convId)
    }
    for (const [convId, byOperator] of this.presence) {
      for (const [operatorId, entry] of byOperator) {
        if (!alive(entry, now)) byOperator.delete(operatorId)
      }
      if (byOperator.size === 0) this.presence.delete(convId)
    }
    for (const [convId, until] of this.pollLocks) {
      if (until <= now) this.pollLocks.delete(convId)
    }
    for (const [key, until] of this.seenKeys) {
      if (until <= now) this.seenKeys.delete(key)
    }
  }
}
