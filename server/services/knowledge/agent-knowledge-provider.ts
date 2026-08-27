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

/**
 * 知識庫快查（US2）的逾時上限 —— 客服**自己輸入查詢、盯著骨架等**的那條路徑。
 *
 * ⚠️ **這個數字是實測校準的，不是拍板的。** 原本是 8 秒（推導自 SC-002 的 10 秒門檻，
 * 留 2 秒給 BFF 往返與渲染），但 2026-08-27 對真實知識庫實測，三個會正確呼叫工具的模型
 * 共九次取樣，**最快 13.0 秒、最慢 24.9 秒，沒有任何一次低於 13 秒**：
 *
 *   us.amazon.nova-pro-v1:0   13.1／16.7／17.1／23.8 秒
 *   qwen.qwen3-32b-v1:0       20.5／13.0／18.6 秒
 *   qwen.qwen3-vl-235b-a22b   24.9 秒（之後連續呼叫全面逾時，已排除）
 *   （獨立對照：spike 11 的另一支 nova-pro agent 14.9 秒）
 *
 * 也就是說 8 秒在生產路徑上會 **100% 逾時**，快查恆顯示「知識庫服務暫時無法使用」。
 * 這不是選錯模型 —— iMBrace 的知識庫檢索延遲就是這個量級（已列入
 * `docs/IMBRACE_QUESTIONS.md` 詢問是否可調校）。SC-002 的門檻已同步改寫為實測值。
 */
export const KNOWLEDGE_SEARCH_TIMEOUT_MS = 30_000

/**
 * 建議卡生成前的知識庫檢索（US1）逾時上限 —— **刻意遠短於快查**。
 *
 * ⚠️ 兩者不能共用同一個數字，理由是它們受不同的門檻約束：
 *
 *   - 快查是客服主動發起的同步查詢，畫面上有骨架，等 20 秒是可接受的
 *   - 建議卡走的是「先檢索、再生成」的**串行**流程，而 SC-001 要求 10 秒內完整呈現。
 *     若這裡也用 30 秒，建議卡會變成 30 秒後才出現 —— 直接違反 SC-001
 *
 * 因此這條路徑維持短逾時、逾時即以空集合續行（FR-004：誠實標示「未引用知識庫」，
 * MUST NOT 因此把整個建議卡區塊轉為 error）。
 *
 * ⚠️ **已知後果**：既然實測檢索最快也要 13 秒，這個 8 秒上限等於**建議卡目前拿不到引用**。
 * 正解是把建議卡改成漸進式（先出無引用版本、檢索回來再更新為有引用版本），
 * 已另立 `specs/004-*` 承接。在那之前，這裡刻意保護 SC-001 而犧牲引用 ——
 * 這是**明知的取捨，不是疏漏**。
 */
export const SUGGESTION_RETRIEVAL_TIMEOUT_MS = 8_000

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

/**
 * 檔名裡的版本／日期片段，例：`…SOP_V1_20250925_部門可見.pdf`。
 *
 * ⚠️ **必須不分大小寫**（2026-08-27 重跑 `npm run spike:contract` 取樣時發現）：
 *    同一個知識庫資料夾裡 9 個檔案就有 2 個寫成小寫 `_v1_20200926_`。
 *    大小寫敏感的版本會讓這兩個檔案靜默拿到 `updatedAt: null`（前端顯示
 *    「更新日期未知」）、標題還留著 `_v1_20200926_部門可見` 後綴 ——
 *    不報錯、型別也對，只是安靜地說錯話。
 */
const VERSION_DATE_RE = /_V\d+_(\d{4})(\d{2})(\d{2})_/i

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
    // ⚠️ 與 VERSION_DATE_RE 同樣不分大小寫，理由見該常數的說明
    .replace(/_V\d+_\d{8}_[^_]*$/i, '')
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

/**
 * ⚠️ **這段措辭是實測校準過的，改動前務必重跑 `npm run spike:knowledge-prompt` 驗證。**
 *
 * 2026-08-27 於真實環境發現：原本寫成命令式的檢索指令
 * （「請在知識庫中搜尋與下列內容最相關的段落（最多 N 筆）：…」）時，
 * agent **會把工具呼叫當成文字敘述出來而不是真的呼叫** —— 回應裡看得到
 * 「我會使用 RAGknowledge 工具來執行這個搜尋」甚至整個 ```tool_code``` 區塊，
 * 但整條 SSE **沒有任何 `tool-input-available`／`tool-output-available` 事件**，
 * 於是 `findRagKnowledgeOutput()` 找不到輸出、快查恆為 0 命中。
 *
 * 不報錯、型別也對 —— 又一個靜默失效。同一個 agent、同一個模型，只把措辭換成
 * 「請查詢知識庫回答下列問題，並在回答最後列出參考了哪些文件」這種**自然提問**形狀，
 * 工具就真的被呼叫了（實測回傳 3 個 `[Source: ]` 段落）。
 *
 * 直覺的解釋是：命令式措辭在講「工具」這件事本身，模型於是去描述它；
 * 自然提問則是一個需要知識才答得出來的問題，模型只好去查。
 * ⚠️ 這是**經驗結論不是理論**，換模型後不保證仍成立 —— 所以才要求改動前重測。
 */
function buildKnowledgePrompt(query: string, opts?: { topK?: number, fileId?: string }): string {
  const topK = opts?.topK ?? 5
  let prompt = `請查詢知識庫回答下列問題，並在回答最後列出你參考了哪些文件或章節（最多 ${topK} 筆）：\n\n${query}`
  if (opts?.fileId) {
    // research.md #3：「展開全文」把 RAGknowledge 的 document_file_ids 輸入參數限定為該檔案 id
    prompt += `\n\n請只參考檔案 id 為 "${opts.fileId}" 的文件（document_file_ids: ["${opts.fileId}"]）。`
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
