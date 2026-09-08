/**
 * 「有沒有新訊息」的判定 —— 結案過期標記（FR-044）的唯一依據。
 *
 * ⚠️ 這支測試存在的理由：**「訊息有沒有重複」很好驗，「有沒有新內容」不會。**
 *    2026-09-07 使用者回報「按下結案後，沒有新訊息卻仍出現『對話有新內容，
 *    建議重新產生』，而且抓不到規律」。根因是 `messages.appended` 被當成
 *    「有新訊息」的同義詞 —— 但它的契約明文允許整批重送：
 *
 *      `PollingMessageSource.sliceNew()`：`lastMessageId === null`（pipeline 首次拉取）
 *      或錨點在視窗內找不到時，一律回傳整批（寧可重送也不可漏送，§9.4）。
 *      `session-manager.ts` 的 fan-out 註明「MUST NOT 一起濾」。
 *
 *    而 pipeline 每次因 `{priority, joined}` 改變被拆掉重建，錨點就歸零：
 *    分頁切到背景再切回、切到別的對話再切回、SSE 斷線重連 —— 三者都會觸發。
 *    盯著畫面不動時心跳參數不變、`createWatchRegistry().watch()` 提前 return，
 *    於是「有時會、有時不會」。
 *
 *    typecheck、既有單元測試、smoke 全都是綠的，因為它們只驗到「訊息沒有重複」。
 *
 * ⚠️ **過期標記說錯話的代價是不對稱的**：誤報只是煩人，漏報會讓客服把一份
 *    遺漏了訊息的摘要寫進 CRM。因此 `added` 的語意 MUST 是「id 層級的新增」，
 *    寧可在同 id 內容更新時不算新增，也不可把已知訊息算成新的。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mergeMessages } from '../app/utils/message-merge.js'
import type { Message } from '../shared/types/conversation.js'

function msg(id: string, at: string, text = id): Message {
  return {
    id,
    conversationId: 'conv-1',
    sender: { type: 'customer', id: 'con_1', name: '客戶' },
    text,
    at,
  }
}

const M1 = msg('m1', '2026-09-07T10:00:00.000Z')
const M2 = msg('m2', '2026-09-07T10:01:00.000Z')
const M3 = msg('m3', '2026-09-07T10:02:00.000Z')

describe('整批重送（pipeline 重建後錨點歸零）', () => {
  it('把已知的整批再送一次，added MUST 為 0 —— 這正是誤報過期標記的來源', () => {
    const first = mergeMessages([], [M1, M2, M3])
    expect(first.added).toBe(3)

    const resend = mergeMessages(first.messages, [M1, M2, M3])
    expect(resend.added).toBe(0)
    expect(resend.messages).toHaveLength(3)
  })

  it('重送整批 ＋ 夾帶一則真的新訊息時，added MUST 只算那一則', () => {
    const before = mergeMessages([], [M1, M2]).messages
    const after = mergeMessages(before, [M1, M2, M3])
    expect(after.added).toBe(1)
    expect(after.messages).toHaveLength(3)
  })

  it('同一則訊息在同一批裡出現兩次，MUST 只算一則', () => {
    expect(mergeMessages([], [M1, M1]).added).toBe(1)
  })

  it('既有 id 被同 id 的新版本覆蓋 MUST NOT 算新增 —— 那是同一則訊息，不是新內容', () => {
    const before = mergeMessages([], [M1, M2]).messages
    const after = mergeMessages(before, [msg('m2', M2.at, '（已編輯）')])
    expect(after.added).toBe(0)
    expect(after.messages.find(m => m.id === 'm2')?.text).toBe('（已編輯）')
  })

  it('空的一批 MUST 為 0，且 MUST NOT 動到既有列表的參照（避免無謂的重繪）', () => {
    const before = mergeMessages([], [M1, M2]).messages
    const after = mergeMessages(before, [])
    expect(after.added).toBe(0)
    expect(after.messages).toBe(before)
  })
})

describe('排序', () => {
  it('平台回傳順序不保證 —— 合併後 MUST 依時間排序（中欄是時間軸）', () => {
    const { messages, added } = mergeMessages([], [M3, M1, M2])
    expect(added).toBe(3)
    expect(messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

/**
 * 上面驗的是「`added` 算得對不對」，這裡驗的是「**有沒有真的拿它當條件**」。
 *
 * ⚠️ 掃描而非掛載元件的理由同 `test/closure-ui-honesty.test.ts`：
 *    `useConversationView` 掛著 `onMounted`／`onBeforeUnmount`／`watch`，
 *    vitest 無法在沒有元件實例的情況下跑它。而這一行一旦被改回無條件呼叫，
 *    `added` 再正確也擋不住誤報 —— 不報錯、沒有型別錯誤，只是提示又開始亂跳。
 */
describe('接線', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../app/composables/useConversationView.ts', import.meta.url)),
    'utf8',
  )

  it('markStale() MUST 以「真的有新訊息」為條件', () => {
    expect(source).toMatch(/added\s*>\s*0\s*&&[^\n]*markStale/)
  })

  it('MUST NOT 存在無條件呼叫 markStale() 的路徑', () => {
    const calls = source.match(/^.*closure\.markStale\(.*$/gm) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('added > 0')
  })
})
