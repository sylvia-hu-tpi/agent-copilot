/**
 * `callAgent()` 帶上 `user_id` —— specs/005-m2-residual-defects FR-021（T044b）。
 *
 * ⚠️ 「MUST NOT 改變任何既有分析行為」要有自動化守衛：對假 client 斷言請求 payload **只多了 `user_id`**、
 *    其餘欄位與呼叫次數逐一不變。填錯（例如填成客服的 operatorId）不會報錯，
 *    只會讓 AI 服務端的用量統計掛到錯的人身上 —— 這裡順帶斷言 provider 根本拿不到客服身分。
 */

import type { ImbraceClient } from '@imbrace/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImbraceAgentProvider } from '../server/services/ai/imbrace-agent-provider.js'
import { resetAiClientUserIdCache, resolveAiClientUserId } from '../server/services/imbrace.js'
import type { Message } from '../shared/types/conversation.js'

const OPERATOR_ID = 'u_operator_alice'
const CLIENT_USER_ID = 'chat_client_user_9f3a'

function sse(delta: string): string {
  return `data: ${JSON.stringify({ type: 'text-delta', delta })}\n`
}

/** 只實作 provider 與防腐層真的碰到的表面：streamChat、http.getFetch、base */
type StreamChatBody = Record<string, unknown>

function fakeClient(opts: { authStatus?: number, authBody?: unknown } = {}) {
  const streamChat = vi.fn<(body: StreamChatBody) => Promise<{ text: () => Promise<string> }>>(async () => ({
    text: async () => sse('[{"score":70,"label":"neutral","drivers":[]}]'),
  }))
  const authFetch = vi.fn(async () => new Response(
    JSON.stringify(opts.authBody ?? { id: CLIENT_USER_ID }),
    { status: opts.authStatus ?? 200 },
  ))
  const client = {
    aiAgent: {
      streamChat,
      http: { getFetch: () => authFetch },
      base: 'https://fake-gateway.test/ai-agent',
    },
  } as unknown as ImbraceClient
  return { client, streamChat, authFetch }
}

const msg: Message = {
  id: 'm1', conversationId: 'c1', at: '2026-09-02T10:00:00.000Z',
  sender: { type: 'customer', id: 'con_1' }, text: '網路又斷了',
}

beforeEach(() => {
  resetAiClientUserIdCache()
})

afterEach(() => {
  resetAiClientUserIdCache()
  vi.restoreAllMocks()
})

describe('callAgent() 的 payload 只多了 user_id（FR-021）', () => {
  it('請求欄位恰為 assistant_id／messages／user_id，user_id 來自 chat-client/auth/user', async () => {
    const { client, streamChat, authFetch } = fakeClient()
    const provider = new ImbraceAgentProvider(client, 'a-summary', 'a-sentiment', 'a-suggest')

    const points = await provider.analyzeSentiment({ messages: [msg] })
    expect(points).toHaveLength(1)

    expect(streamChat).toHaveBeenCalledTimes(1)
    const body = streamChat.mock.calls[0]![0]
    expect(Object.keys(body).sort()).toEqual(['assistant_id', 'messages', 'user_id'])
    expect(body.assistant_id).toBe('a-sentiment')
    expect(body.messages).toEqual([{ role: 'user', parts: [{ type: 'text', text: expect.any(String) }] }])
    expect(body.user_id).toBe(CLIENT_USER_ID)
    expect(authFetch).toHaveBeenCalledWith('https://fake-gateway.test/ai-agent/chat-client/auth/user', { method: 'POST' })
  })

  it('user_id 不是客服的 operatorId —— provider 拿不到客服身分，這是刻意的', async () => {
    const { client, streamChat } = fakeClient()
    const provider = new ImbraceAgentProvider(client, 'a-summary', 'a-sentiment', 'a-suggest')
    await provider.analyzeSentiment({ messages: [msg] })
    const body = streamChat.mock.calls[0]![0]
    expect(body.user_id).not.toBe(OPERATOR_ID)
    expect(body.user_id).toBe(CLIENT_USER_ID)
  })

  it('id 只查一次就快取：連續三次呼叫，auth 往返恰好一趟（省下的正是那 54ms）', async () => {
    const { client, streamChat, authFetch } = fakeClient()
    const provider = new ImbraceAgentProvider(client, 'a-summary', 'a-sentiment', 'a-suggest')
    await provider.analyzeSentiment({ messages: [msg] })
    await provider.analyzeSentiment({ messages: [msg] })
    await provider.analyzeSentiment({ messages: [msg] })
    expect(streamChat).toHaveBeenCalledTimes(3)
    expect(authFetch).toHaveBeenCalledTimes(1)
    for (const call of streamChat.mock.calls) expect(call[0].user_id).toBe(CLIENT_USER_ID)
  })

  it('取不到 id 時退回舊路徑：payload 沒有 user_id、呼叫照常成功、只警告一行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, streamChat, authFetch } = fakeClient({ authStatus: 500 })
    const provider = new ImbraceAgentProvider(client, 'a-summary', 'a-sentiment', 'a-suggest')

    const points = await provider.analyzeSentiment({ messages: [msg] })
    expect(points).toHaveLength(1)
    const body = streamChat.mock.calls[0]![0]
    expect(Object.keys(body).sort()).toEqual(['assistant_id', 'messages'])
    expect(warn).toHaveBeenCalledTimes(1)

    // 失敗不快取：下一次會再試（這裡仍失敗，但 auth 確實又打了一次）
    await provider.analyzeSentiment({ messages: [msg] })
    expect(authFetch).toHaveBeenCalledTimes(2)
  })
})

describe('resolveAiClientUserId()（防腐層）', () => {
  it('回應缺 id 視為失敗，且不快取', async () => {
    const { client, authFetch } = fakeClient({ authBody: {} })
    await expect(resolveAiClientUserId(client)).rejects.toThrow(/缺少 id/)
    await expect(resolveAiClientUserId(client)).rejects.toThrow()
    expect(authFetch).toHaveBeenCalledTimes(2)
  })

  it('SDK 內部結構變動（沒有 aiAgent.http／base）時當場報錯，不靜默退回', async () => {
    const client = { aiAgent: {} } as unknown as ImbraceClient
    await expect(resolveAiClientUserId(client)).rejects.toThrow(/內部結構已變更/)
  })

  it('同時發起多次取得只打一趟（併發也共用同一個 pending）', async () => {
    const { client, authFetch } = fakeClient()
    const ids = await Promise.all([resolveAiClientUserId(client), resolveAiClientUserId(client), resolveAiClientUserId(client)])
    expect(ids).toEqual([CLIENT_USER_ID, CLIENT_USER_ID, CLIENT_USER_ID])
    expect(authFetch).toHaveBeenCalledTimes(1)
  })
})
