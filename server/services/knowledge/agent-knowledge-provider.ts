/**
 * 真的呼叫 iMBrace 知識庫 AI Agent 的 KnowledgeProvider 實作 ——
 * specs/002-suggestion-knowledge-search/research.md #1、#2、#3。
 *
 * ⚠️ `RAGknowledge` 工具輸出是**單一字串**（`result`），多筆命中以重複出現的
 *    `[Source: <檔名>]` 標記串接，不是結構化陣列。`folder_info` 是整個知識庫的資料夾
 *    快照（不是本次命中範圍），只用來把還原後的檔名比對回檔案 id。
 *
 * ⚠️ 檔名是**雙重 URL-encode**，需 `decodeURIComponent()` 兩次才能還原成可讀中文。
 *
 * ⚠️ 不重試：檢索失敗時 FR-004 允許呼叫端以空集合續行，重試只是再等一次。
 *    逾時／呼叫失敗一律直接拋錯，交由呼叫端（copilot-analysis.ts）捕捉降級。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import type { KnowledgeHit, KnowledgeProvider } from '../../../shared/types/knowledge.js'
import { AIProviderHttpError } from '../ai/retry-policy.js'

/** plan.md Constraints：短於 SC-002 的 10 秒門檻，留 2 秒給 BFF 往返與前端渲染 */
export const KNOWLEDGE_SEARCH_TIMEOUT_MS = 8_000

interface RagKnowledgeOutput {
  status: string
  /** 單一字串，多筆命中以重複出現的 `[Source: <檔名>]` 標記串接 */
  result: string
  /** 整個知識庫的資料夾快照（JSON 字串），非本次命中範圍 */
  folder_info: string
  metadata?: { result_count?: number, timestamp?: string }
}

/** 每個 chunk 出現即為一筆命中，同一檔名重複出現也各自成一筆（research.md #1 決策 2） */
const SOURCE_CHUNK_RE = /\[Source: ([^\]]+)\]\n([\s\S]*?)(?=\n\[Source: |$)/g

/** 檔名裡的版本／日期片段，例：`…SOP_V1_20250925_部門可見.pdf` */
const VERSION_DATE_RE = /_V\d+_(\d{4})(\d{2})(\d{2})_/

function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(decodeURIComponent(raw))
  }
  catch {
    try {
      return decodeURIComponent(raw)
    }
    catch {
      return raw
    }
  }
}

/** `folder_info` 比對不到時的容錯：以檔名雜湊出一個穩定 id，避免整筆結果被丟棄（research.md #1） */
function hashFilename(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0
  return `knowledge-fallback-${(h >>> 0).toString(16)}`
}

function parseFolderFiles(raw: string): Array<{ id: string, name: string }> {
  try {
    const parsed = JSON.parse(raw) as { folders?: Array<{ files?: Array<{ id: string, name: string }> }> }
    const files: Array<{ id: string, name: string }> = []
    for (const folder of parsed.folders ?? []) {
      for (const f of folder.files ?? []) files.push({ id: f.id, name: f.name })
    }
    return files
  }
  catch {
    return []
  }
}

/** 擷取不到日期片段時為 null（research.md #2：檔名日期只是啟發式，不謊報） */
function deriveUpdatedAt(filename: string): string | null {
  const m = VERSION_DATE_RE.exec(filename)
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(`${y}-${mo}-${d}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 清理副檔名與版本／日期／可見範圍後綴，只留客服看得懂的標題（research.md #2） */
function deriveTitle(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/_V\d+_\d{8}_[^_]*$/, '')
}

function parseRagOutput(output: RagKnowledgeOutput): KnowledgeHit[] {
  const files = parseFolderFiles(output.folder_info)
  const hits: KnowledgeHit[] = []

  for (const m of output.result.matchAll(SOURCE_CHUNK_RE)) {
    const rawFilename = m[1]
    if (!rawFilename) continue
    const snippet = m[2]?.trim() ?? ''
    const filename = decodeFilename(rawFilename)
    const id = files.find(f => f.name === filename)?.id ?? hashFilename(filename)

    hits.push({
      id,
      title: deriveTitle(filename),
      snippet,
      score: null,
      updatedAt: deriveUpdatedAt(filename),
      sourceRef: { type: 'knowledge', ref: id },
    })
  }
  return hits
}

function buildKnowledgePrompt(query: string, opts?: { topK?: number, fileId?: string }): string {
  const topK = opts?.topK ?? 5
  let prompt = `請在知識庫中搜尋與下列內容最相關的段落（最多 ${topK} 筆）：\n\n${query}`
  if (opts?.fileId) {
    // research.md #3：「展開全文」把 RAGknowledge 的 document_file_ids 輸入參數限定為該檔案 id
    prompt += `\n\n請將搜尋限定在檔案 id 為 "${opts.fileId}" 的文件內（document_file_ids: ["${opts.fileId}"]）。`
  }
  return prompt
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`知識庫檢索逾時（${timeoutMs}ms）`)), timeoutMs)
  })
  try {
    return await Promise.race([fn(), timeout])
  }
  finally {
    clearTimeout(timer!)
  }
}

export class AgentKnowledgeProvider implements KnowledgeProvider {
  constructor(
    private readonly client: ImbraceClient,
    private readonly knowledgeAgentId: string,
  ) {}

  async search(
    query: string,
    opts?: { topK?: number, fileId?: string, timeoutMs?: number },
  ): Promise<KnowledgeHit[]> {
    const timeoutMs = opts?.timeoutMs ?? KNOWLEDGE_SEARCH_TIMEOUT_MS
    return withTimeout(async () => {
      const output = await this.callForRagOutput(buildKnowledgePrompt(query, opts))
      return output ? parseRagOutput(output) : []
    }, timeoutMs)
  }

  private async callForRagOutput(prompt: string): Promise<RagKnowledgeOutput | null> {
    let res: { text: () => Promise<string> }
    try {
      res = await this.client.aiAgent.streamChat({
        assistant_id: this.knowledgeAgentId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      } as Parameters<typeof this.client.aiAgent.streamChat>[0])
    }
    catch (err) {
      const status = (err as { status?: number, statusCode?: number })?.status
        ?? (err as { status?: number, statusCode?: number })?.statusCode
      if (typeof status === 'number') {
        throw new AIProviderHttpError(err instanceof Error ? err.message : String(err), status)
      }
      throw err
    }

    const raw = await res.text()
    const events = raw.split('\n')
      .filter(l => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
      .filter(Boolean) as Array<Record<string, unknown>>

    return findRagKnowledgeOutput(events)
  }
}

/**
 * ⚠️ **實測發現**（scripts/spike/out/11-宏宏企業-knowledge-raw.json）：`tool-output-available`
 * 事件本身**不帶 `toolName`**——那個欄位只出現在同一次工具呼叫較早的
 * `tool-input-start`／`tool-input-available` 事件上（以 `toolCallId` 相關聯）。
 * 因此不能直接對 `tool-output-available` 事件比對 `toolName === 'RAGknowledge'`
 * （會恆為 `undefined`，靜默找不到任何輸出）——必須先建立 `toolCallId → toolName` 的對照表，
 * 再用它反查 `tool-output-available` 屬於哪個工具。
 */
function findRagKnowledgeOutput(events: Array<Record<string, unknown>>): RagKnowledgeOutput | null {
  const toolNameByCallId = new Map<string, string>()
  for (const e of events) {
    if (typeof e.toolCallId === 'string' && typeof e.toolName === 'string') {
      toolNameByCallId.set(e.toolCallId, e.toolName)
    }
  }

  const outputEvent = events.find((e) => {
    if (e.type !== 'tool-output-available') return false
    const toolName = typeof e.toolCallId === 'string' ? toolNameByCallId.get(e.toolCallId) : undefined
    return toolName === 'RAGknowledge'
  })
  return (outputEvent?.output as RagKnowledgeOutput | undefined) ?? null
}
