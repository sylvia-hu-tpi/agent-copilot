/**
 * AgentKnowledgeProvider —— specs/002-suggestion-knowledge-search/research.md #1、#2、#3。
 *
 * 驗證 `RAGknowledge` 工具輸出（單一字串，`[Source: <雙重 URL-encode 檔名>]` 標記串接）
 * 的解析：chunk 切分、雙重 decodeURIComponent()、folder_info id 比對（含比對不到的容錯）、
 * updatedAt 正則擷取（含大小寫版本號、擷取不到回傳 null）、title 清理後綴。
 *
 * ⚠️ **樣本刻意內嵌在本檔，不讀 `scripts/spike/out/`。**
 *    這支測試原本讀 `scripts/spike/out/11-宏宏企業-knowledge-raw.json`，但整個 `out/`
 *    在 `.gitignore` 裡 —— 換一台機器 clone、或本機清掉 out/，這支測試就必紅
 *    （2026-08-27 實際發生）。測試不得依賴不在版控裡的檔案。
 *
 * ⚠️ **下方 SAMPLE_* 常數的「形狀」逐欄取自 2026-08-27 重跑 `npm run spike:contract`
 *    的真實產出**（事件序列、雙重 URL-encode、`📁 Sources:` 前綴、folder_info 結構、
 *    同一檔案重複命中、大小寫混用的 `_V1_`／`_v1_` 版本片段皆為實測所見），
 *    但**文件正文與檔名已改寫為虛構內容** —— 那是客戶的知識庫文件，不進本 repo
 *    （`research.md` #1 引用該樣本時同樣以 `<urlencode 檔名>` 遮蔽）。
 *    格式若有疑慮，以 `npm run spike:contract` 的實測產出為準（CLAUDE.md），不以本檔為準。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import { describe, expect, it } from 'vitest'
import { AgentKnowledgeProvider } from '../server/services/knowledge/agent-knowledge-provider.js'

/** 雙重 URL-encode —— 實測所見的檔名編碼方式（research.md #1） */
const enc = (name: string): string => encodeURIComponent(encodeURIComponent(name))

/** folder_info 是**整個資料夾**的快照，不是本次命中範圍（含未命中的檔案） */
const SAMPLE_FILES = [
  { id: 'acae61e2-ed66-4e02-a502-8a78fe66ae56', name: '示範事業部大樓-部門辦法-大樓管理辦法_V1_20200703_部門可見.pdf', remarks: null },
  { id: '3d1c0f77-9a41-4a2e-8f0d-2b5c7e9a1d34', name: '示範事業部大樓-部門辦法-大樓管理辦法(商店版)_V1_20200703_部門可見.pdf', remarks: null },
  // ⚠️ 實測所見：同一個資料夾裡有檔案用小寫 `_v1_`（9 個檔案有 2 個），且分隔符改用底線
  { id: '5f8b2a10-6c33-4d95-b7e1-0a4d8c62f9b7', name: '示範事業部大樓_部門作業_工作職掌分配表_v1_20200926_部門可見.pdf', remarks: null },
  { id: '1fa9bd7c-0a69-4ef7-be47-71d236caa35c', name: '示範事業部大樓-部門作業-電梯困人SOP_V1_20250925_部門可見.pdf', remarks: null },
]

const FILE_MANAGEMENT = SAMPLE_FILES[0]!
const FILE_SHOP_EDITION = SAMPLE_FILES[1]!
const FILE_LOWERCASE_VERSION = SAMPLE_FILES[2]!

/**
 * `result` 的真實形狀：`📁 Sources:` 清單 + `📄 Context:` 後接多個 `[Source: ]` 段落。
 * ⚠️ 同一個檔案命中兩次 —— 實測如此，且兩段各自成一筆命中（research.md #1 決策 2）。
 */
const SAMPLE_RESULT = [
  '📁 Sources:',
  `- ${enc(FILE_MANAGEMENT.name)}`,
  `- ${enc(FILE_SHOP_EDITION.name)}`,
  '',
  '📄 Context:',
  `[Source: ${enc(FILE_MANAGEMENT.name)}]`,
  '（示範內容）第一段：門禁與訪客登記的作業範圍說明。',
  '',
  `[Source: ${enc(FILE_MANAGEMENT.name)}]`,
  '（示範內容）第二段：公共區域清潔與設備巡檢的頻率規定。',
  '',
  `[Source: ${enc(FILE_SHOP_EDITION.name)}]`,
  '（示範內容）商店版：營業時間與貨物進出動線的補充條款。',
].join('\n')

/**
 * ⚠️ 實測所見：agent 可能**先呼叫 `folderContentsTool`**（列出資料夾內容）再呼叫
 * `RAGknowledge`，於是同一條 SSE 裡會有**兩個 `tool-output-available`**，
 * 而且第一個完全沒有 `result`／`folder_info` 欄位。天真地取「第一個
 * tool-output-available」會拿到資料夾清單、解析出空結果 —— 必須靠
 * `toolCallId → toolName` 對照表反查（`tool-output-available` 事件本身不帶 `toolName`）。
 */
const SAMPLE_EVENTS: unknown[] = [
  { type: 'tool-input-start', toolCallId: 'call_folder', toolName: 'folderContentsTool' },
  { type: 'tool-input-available', toolCallId: 'call_folder', toolName: 'folderContentsTool', input: {} },
  {
    type: 'tool-output-available',
    toolCallId: 'call_folder',
    output: { status: 'success', total_files: SAMPLE_FILES.length, document_file_ids: SAMPLE_FILES.map(f => f.id) },
  },
  { type: 'tool-input-start', toolCallId: 'call_rag', toolName: 'RAGknowledge' },
  { type: 'tool-input-available', toolCallId: 'call_rag', toolName: 'RAGknowledge', input: { query: '服務流程' } },
  {
    type: 'tool-output-available',
    toolCallId: 'call_rag',
    output: {
      status: 'success',
      result: SAMPLE_RESULT,
      folder_info: JSON.stringify({ folders: [{ files: SAMPLE_FILES }] }),
      metadata: { result_count: 1, timestamp: '2026-08-27T13:32:12.543Z' },
    },
  },
  { type: 'text-delta', id: '0', delta: '以下是知識庫中的服務流程說明……' },
]

function sseTextFrom(events: unknown[]): string {
  return events.map(e => `data: ${JSON.stringify(e)}`).join('\n')
}

function makeClient(sseText: string, delayMs = 0): ImbraceClient {
  return {
    aiAgent: {
      streamChat: async () => {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
        return { text: async () => sseText }
      },
    },
  } as unknown as ImbraceClient
}

function providerOf(events: unknown[]): AgentKnowledgeProvider {
  return new AgentKnowledgeProvider(makeClient(sseTextFrom(events)), 'agent-1')
}

describe('AgentKnowledgeProvider.search()（樣本形狀取自 npm run spike:contract 實測）', () => {
  it('每個 [Source: ] chunk 各自成一筆命中（同一檔名重複出現也各自成一筆）', async () => {
    const hits = await providerOf(SAMPLE_EVENTS).search('service process')

    expect(hits).toHaveLength(3)
    for (const hit of hits) {
      expect(hit.snippet.length).toBeGreaterThan(0)
      expect(hit.score).toBeNull()
      expect(hit.sourceRef).toEqual({ type: 'knowledge', ref: hit.id })
    }
    // 前兩筆同一個檔案、內容不同；第三筆是另一個檔案
    expect(hits[0]!.id).toBe(FILE_MANAGEMENT.id)
    expect(hits[1]!.id).toBe(FILE_MANAGEMENT.id)
    expect(hits[0]!.snippet).not.toBe(hits[1]!.snippet)
    expect(hits[2]!.id).toBe(FILE_SHOP_EDITION.id)
  })

  it('agent 先呼叫 folderContentsTool 時，仍取到 RAGknowledge 那一個 tool-output-available', async () => {
    // ⚠️ 這正是「取第一個 tool-output-available」會靜默解析出空結果的情境
    const hits = await providerOf(SAMPLE_EVENTS).search('service process')
    expect(hits).toHaveLength(3)
  })

  it('檔名經兩次 decodeURIComponent() 還原，並比對 folder_info 取得真實檔案 id', async () => {
    const hits = await providerOf(SAMPLE_EVENTS).search('service process')

    for (const hit of hits) {
      const matched = SAMPLE_FILES.find(f => f.id === hit.id)
      expect(matched, `hit.id=${hit.id} 應比對到 folder_info 裡的真實檔案`).toBeDefined()
    }
  })

  it('title 清理副檔名與版本／日期／可見範圍後綴', async () => {
    const hits = await providerOf(SAMPLE_EVENTS).search('service process')

    for (const hit of hits) {
      const matched = SAMPLE_FILES.find(f => f.id === hit.id)!
      expect(matched.name.startsWith(hit.title)).toBe(true)
      expect(hit.title).not.toMatch(/\.pdf$/i)
      expect(hit.title).not.toMatch(/_V\d+_\d{8}_/i)
    }
    expect(hits[0]!.title).toBe('示範事業部大樓-部門辦法-大樓管理辦法')
    expect(hits[2]!.title).toBe('示範事業部大樓-部門辦法-大樓管理辦法(商店版)')
  })

  it('updatedAt 依檔名版本日期片段轉為 ISO8601（已知樣本：_V1_20200703_）', async () => {
    const hits = await providerOf(SAMPLE_EVENTS).search('service process')

    for (const hit of hits) expect(hit.updatedAt).toBe('2020-07-03T00:00:00.000Z')
  })

  it('版本片段為小寫 `_v1_` 時同樣擷取得到日期與標題（2026-08-27 重新取樣發現：9 個檔案有 2 個是小寫）', async () => {
    const events = [
      { type: 'tool-input-available', toolCallId: 'c', toolName: 'RAGknowledge', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 'c',
        output: {
          status: 'success',
          result: `[Source: ${enc(FILE_LOWERCASE_VERSION.name)}]\n（示範內容）職掌分配說明。`,
          folder_info: JSON.stringify({ folders: [{ files: SAMPLE_FILES }] }),
        },
      },
    ]
    const hits = await providerOf(events).search('職掌')

    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe(FILE_LOWERCASE_VERSION.id)
    expect(hits[0]!.updatedAt).toBe('2020-09-26T00:00:00.000Z')
    expect(hits[0]!.title).toBe('示範事業部大樓_部門作業_工作職掌分配表')
  })

  it('folder_info 比對不到時退回檔名雜湊，不丟棄整筆結果', async () => {
    const events = [
      { type: 'tool-input-available', toolCallId: 't1', toolName: 'RAGknowledge', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 't1',
        output: {
          status: 'success',
          result: `[Source: ${enc('測試檔案.pdf')}]\n測試內容`,
          folder_info: JSON.stringify({ folders: [{ files: [] }] }),
        },
      },
    ]
    const hits = await providerOf(events).search('q')

    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toMatch(/^knowledge-fallback-/)
    expect(hits[0]!.title).toBe('測試檔案')
  })

  it('檔名無法擷取到版本日期片段時，updatedAt 為 null（不謊報，研究 #2）', async () => {
    const events = [
      { type: 'tool-input-available', toolCallId: 't2', toolName: 'RAGknowledge', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 't2',
        output: {
          status: 'success',
          result: `[Source: ${enc('沒有日期的檔案.pdf')}]\n內容`,
          folder_info: JSON.stringify({ folders: [] }),
        },
      },
    ]
    const hits = await providerOf(events).search('q')

    expect(hits[0]!.updatedAt).toBeNull()
  })

  it('找不到任何 RAGknowledge 的 tool-output-available 事件時回傳空陣列', async () => {
    const hits = await providerOf([{ type: 'text-delta', id: '0', delta: 'hi' }]).search('q')
    expect(hits).toEqual([])
  })

  it('search() 逾時即拋錯，不重試（FR-004 允許呼叫端以空集合續行，重試只是再等一次）', async () => {
    const client = {
      aiAgent: { streamChat: () => new Promise(() => {}) }, // 永不 resolve
    } as unknown as ImbraceClient
    const provider = new AgentKnowledgeProvider(client, 'agent-1')
    await expect(provider.search('q', { timeoutMs: 20 })).rejects.toThrow(/逾時/)
  })
})
