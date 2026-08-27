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
} from './types.js'
import type { PresenceEntry } from '../../shared/types/conversation.js'

interface Expiring<T> {
  value: T
  expiresAt: number
}

const SWEEP_INTERVAL_MS = 60_000

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
