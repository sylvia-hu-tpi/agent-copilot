/**
 * KnowledgeProvider 的 mock 實作 —— 比照 server/services/ai/mock-ai-provider.ts 的故障開關模式。
 *
 * 回傳固定樣本資料，讓建議卡／知識庫快查的狀態機正確性完全獨立於真實 AI 呼叫驗證。
 */

import type { KnowledgeHit, KnowledgeProvider } from '../../../shared/types/knowledge.js'

export interface MockKnowledgeProviderOptions {
  /** 每次呼叫前的延遲（ms）—— 測試用，模擬檢索呼叫的執行時間 */
  searchDelayMs?: number
  /** 每次呼叫時執行；回傳 Error 即拋出該錯誤，回傳 null 表示這次不失敗 */
  searchFailure?: () => Error | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const SAMPLE_HITS: KnowledgeHit[] = [
  {
    id: 'mock-knowledge-file-1',
    title: '金融大樓電梯困人SOP',
    snippet: '電梯困人時請立即通知大樓管理中心，並保持冷靜引導受困人員，管理中心將於 5 分鐘內派員處理。',
    score: null,
    updatedAt: '2025-09-25T00:00:00.000Z',
    sourceRef: { type: 'knowledge', ref: 'mock-knowledge-file-1' },
  },
  {
    id: 'mock-knowledge-file-2',
    title: '金融大樓管理辦法',
    snippet: '承租區域之機電維修服務，如需任何維修或緊急協助，請聯繫客服專線並提供租戶名稱與狀況說明。',
    score: null,
    updatedAt: null,
    sourceRef: { type: 'knowledge', ref: 'mock-knowledge-file-2' },
  },
]

export class MockKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly opts: MockKnowledgeProviderOptions = {}) {}

  async search(
    query: string,
    opts?: { topK?: number, fileId?: string, timeoutMs?: number },
  ): Promise<KnowledgeHit[]> {
    if (this.opts.searchDelayMs) await sleep(this.opts.searchDelayMs)

    const failure = this.opts.searchFailure?.()
    if (failure) throw failure

    if (!query.trim()) return []

    const hits = opts?.fileId ? SAMPLE_HITS.filter(h => h.sourceRef.ref === opts.fileId) : SAMPLE_HITS
    return hits.slice(0, opts?.topK ?? hits.length)
  }
}
