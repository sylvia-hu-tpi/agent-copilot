/**
 * AgentKnowledgeProvider —— specs/002-suggestion-knowledge-search/research.md #1、#2。
 *
 * 使用真實實測樣本 `scripts/spike/out/11-宏宏企業-knowledge-raw.json` 作為 fixture，
 * 驗證 `RAGknowledge` 工具輸出（單一字串，`[Source: <雙重 URL-encode 檔名>]` 標記串接）
 * 的解析：chunk 切分、雙重 decodeURIComponent()、folder_info id 比對（含比對不到的容錯）、
 * updatedAt 正則擷取（含擷取不到回傳 null 的情境）、title 清理後綴。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ImbraceClient } from '@imbrace/sdk'
import { describe, expect, it } from 'vitest'
import { AgentKnowledgeProvider } from '../server/services/knowledge/agent-knowledge-provider.js'

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'scripts/spike/out/11-宏宏企業-knowledge-raw.json'), 'utf-8'),
) as { citation: { eventLevel: unknown[] } }

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

const outputEvent = fixture.citation.eventLevel.find(
  (e): e is { type: string, output: { result: string, folder_info: string } } =>
    (e as { type?: string }).type === 'tool-output-available',
)!
const folderInfo = JSON.parse(outputEvent.output.folder_info) as {
  folders: Array<{ files: Array<{ id: string, name: string }> }>
}
const files = folderInfo.folders[0]!.files

describe('AgentKnowledgeProvider.search()（fixture：11-宏宏企業-knowledge-raw.json）', () => {
  it('每個 [Source: ] chunk 各自成一筆命中（同一檔名重複出現也各自成一筆）', async () => {
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom(fixture.citation.eventLevel)), 'agent-1')
    const hits = await provider.search('service process')
    expect(hits).toHaveLength(3)
    for (const hit of hits) {
      expect(hit.snippet.length).toBeGreaterThan(0)
      expect(hit.score).toBeNull()
      expect(hit.sourceRef).toEqual({ type: 'knowledge', ref: hit.id })
    }
  })

  it('檔名經兩次 decodeURIComponent() 還原，並比對 folder_info 取得真實檔案 id', async () => {
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom(fixture.citation.eventLevel)), 'agent-1')
    const hits = await provider.search('service process')

    for (const hit of hits) {
      const matched = files.find(f => f.id === hit.id)
      expect(matched, `hit.id=${hit.id} 應比對到 folder_info 裡的真實檔案`).toBeDefined()
    }
  })

  it('title 清理副檔名與版本／日期／可見範圍後綴', async () => {
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom(fixture.citation.eventLevel)), 'agent-1')
    const hits = await provider.search('service process')

    for (const hit of hits) {
      const matched = files.find(f => f.id === hit.id)!
      expect(matched.name.startsWith(hit.title)).toBe(true)
      expect(hit.title).not.toMatch(/\.pdf$/i)
      expect(hit.title).not.toMatch(/_V\d+_\d{8}_/)
    }
  })

  it('updatedAt 依檔名版本日期片段轉為 ISO8601（已知樣本：_V1_20200703_）', async () => {
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom(fixture.citation.eventLevel)), 'agent-1')
    const hits = await provider.search('service process')

    const knownFile = files.find(f => f.name.includes('_V1_20200703_'))!
    const hit = hits.find(h => h.id === knownFile.id)!
    expect(hit.updatedAt).toBe('2020-07-03T00:00:00.000Z')
  })

  it('folder_info 比對不到時退回檔名雜湊，不丟棄整筆結果', async () => {
    const encoded = encodeURIComponent(encodeURIComponent('測試檔案.pdf'))
    const events = [
      { type: 'tool-input-available', toolCallId: 't1', toolName: 'RAGknowledge', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 't1',
        output: {
          status: 'success',
          result: `[Source: ${encoded}]\n測試內容`,
          folder_info: JSON.stringify({ folders: [{ files: [] }] }),
        },
      },
    ]
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom(events)), 'agent-1')
    const hits = await provider.search('q')

    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toMatch(/^knowledge-fallback-/)
    expect(hits[0]!.title).toBe('測試檔案')
  })

  it('檔名無法擷取到版本日期片段時，updatedAt 為 null（不謊報，研究 #2）', async () => {
    const encoded = encodeURIComponent(encodeURIComponent('沒有日期的檔案.pdf'))
    const events = [
      { type: 'tool-input-available', toolCallId: 't2', toolName: 'RAGknowledge', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 't2',
        output: {
          status: 'success',
          result: `[Source: ${encoded}]\n內容`,
          folder_info: JSON.stringify({ folders: [] }),
        },
      },
    ]
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom(events)), 'agent-1')
    const hits = await provider.search('q')

    expect(hits[0]!.updatedAt).toBeNull()
  })

  it('找不到任何 RAGknowledge 的 tool-output-available 事件時回傳空陣列', async () => {
    const provider = new AgentKnowledgeProvider(makeClient(sseTextFrom([{ type: 'text-delta', id: '0', delta: 'hi' }])), 'agent-1')
    const hits = await provider.search('q')
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
