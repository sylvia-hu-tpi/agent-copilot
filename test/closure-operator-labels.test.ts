/**
 * 唯讀區「參與的客服」：**Board 存 id，畫面顯示名字**（2026-09-08）。
 *
 * 修這件事之前，唯讀區印的是 `u_df56079c-7df4-41c6-9ce0-5f57f29df534` ——
 * 那串字對客服不對應任何他認得的東西，而這一欄的用途正是讓人事後看得出
 * 「誰服務過這位客戶」。
 *
 * ⚠️ **兩個欄位、兩種用途，MUST NOT 合併成一個：**
 *    - `operators`（id）→ 寫進 Board。id 穩定；email 會隨帳號改名變動，
 *      改完之後舊紀錄就指不回任何人。
 *    - `operatorLabels`（顯示名）→ 只給畫面。平台沒有人名，名冊的
 *      `display_name` 實測 12/12 全是 email，因此這裡實際上會是 email。
 *
 * ⚠️ 這與 `reviewed_by` 的既有做法一致：Board 存 id，
 *    `commit.post.ts` 只在**顯示** `newClosuresSincePanelOpen` 時才查名字。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { CopilotSession } from '../server/state/types.js'
import { computeReadonlyFields } from '../server/services/closure/readonly-fields.js'
import { rememberOperators, resetDirectory } from '../server/services/directory.js'

const ORG = 'org_1'
const PERIOD_START = '2026-09-03T10:00:00.000Z'

afterEach(() => resetDirectory())

/** `ReadonlyFieldsInput.ctx` 結構上就只有這兩個欄位（見該處註解） */
const ctx = { channel: 'line', contactId: 'con_1' }

function sessionWith(watcherIds: string[]): CopilotSession {
  return {
    conversationId: 'c1',
    watchers: watcherIds.map(id => ({ operatorId: id })),
    lastMessageId: null,
    createdAt: Date.parse(PERIOD_START),
    updatedAt: Date.parse(PERIOD_START),
  } as unknown as CopilotSession
}

function compute(
  watcherIds: string[],
  { operatorId = 'u_me', operatorLabel }: { operatorId?: string, operatorLabel?: string } = {},
) {
  return computeReadonlyFields({
    ctx,
    analysis: null,
    session: sessionWith(watcherIds),
    periodStart: PERIOD_START,
    firstCustomerAt: null,
    operatorId,
    operatorLabel,
    orgId: ORG,
    confidence: null,
  })
}

describe('operators 是 id、operatorLabels 是顯示名', () => {
  it('查得到名字時，labels 給名字而 operators 仍是 id', () => {
    rememberOperators(ORG, [
      { id: 'u_me', name: 'agent.lin@company.com' },
      { id: 'u_other', name: 'agent.chen@company.com' },
    ])

    const r = compute(['u_other'])

    expect(r.operators).toEqual(['u_me', 'u_other'])
    expect(r.operatorLabels).toEqual(['agent.lin@company.com', 'agent.chen@company.com'])
  })

  /*
    ⚠️ 名冊是 30 分鐘 TTL 的快取，查不到是常態而非例外。
       此時回**原本的 id**：留空會讓「有這個人但查不到名字」看起來像「沒有這個人」，
       而編一個名字會讓客服認錯同事 —— 那正是這個專案最不能出錯的地方（§10.2）。
  */
  it('查不到名字的那一個回傳原本的 id，不留空也不編名字', () => {
    rememberOperators(ORG, [{ id: 'u_me', name: 'agent.lin@company.com' }])

    const r = compute(['u_ghost'])

    expect(r.operators).toEqual(['u_me', 'u_ghost'])
    expect(r.operatorLabels).toEqual(['agent.lin@company.com', 'u_ghost'])
  })

  /*
    ⚠️ 這一條守的是**對位**：兩個陣列由同一個 `map` 產生，因此必然等長。
       分兩處各算一次的話，只要其中一邊多濾掉一個人，
       畫面上第二位同事的名字就會掛到第三位頭上 —— 而那不會報錯。
  */
  it('兩個陣列必然等長且同序，MUST NOT 出現錯位', () => {
    rememberOperators(ORG, [{ id: 'u_b', name: 'b@company.com' }])

    const r = compute(['u_a', 'u_b', 'u_c'])

    expect(r.operatorLabels).toHaveLength(r.operators.length)
    for (const [i, id] of r.operators.entries()) {
      const label = r.operatorLabels[i]!
      expect(label === id || label.includes('@')).toBe(true)
    }
  })

  it('別的組織查不到同一批人 —— 名冊是 org 層級的', () => {
    rememberOperators('org_other', [{ id: 'u_me', name: 'agent.lin@company.com' }])

    expect(compute([]).operatorLabels).toEqual(['u_me'])
  })
})

/*
  ⚠️⚠️ 2026-09-08 手動驗收抓到的缺陷：「參與的客服」對**每一個人**都顯示原始 `u_` id。

  根因不是 fallback 寫錯 —— fallback 是對的。是**登入者自己從來不在名冊裡**：
  `server/services/directory.ts` 只裝 `conversations.get()` 的 `users[]`（團隊名冊），
  而沒有任何路徑會把「現在登入的這個人」寫進去
  （JOIN 走的是 presence 的 `reportViewing({ id, name })`，不是 `rememberOperators()`）。
  單人測試時 `operators` 只有自己一個，於是整欄都是 id。

  ⚠️ 這種缺陷不會報錯也不會有紅燈 —— 它走的正是「查不到就誠實顯示 id」那條合法路徑。
*/
describe('登入者自己的名字來自 session，不是名冊', () => {
  it('名冊完全空的時候，自己仍然顯示 email（這正是驗收當下的情境）', () => {
    const r = compute([], { operatorLabel: 'agent.lin@company.com' })

    expect(r.operators).toEqual(['u_me'])
    expect(r.operatorLabels).toEqual(['agent.lin@company.com'])
  })

  it('session 有名字時優先於名冊 —— 名冊即使有也不會蓋掉', () => {
    rememberOperators(ORG, [{ id: 'u_me', name: 'stale@company.com' }])

    expect(compute([], { operatorLabel: 'agent.lin@company.com' }).operatorLabels)
      .toEqual(['agent.lin@company.com'])
  })

  /*
    ⚠️ `session.operatorName` 在型別上是 optional。沒有值時 MUST 退回名冊 → id，
       MUST NOT 因此渲染出 `undefined` 或空字串。
  */
  it('session 沒有名字時退回名冊，再退回 id', () => {
    expect(compute([], { operatorLabel: undefined }).operatorLabels).toEqual(['u_me'])

    rememberOperators(ORG, [{ id: 'u_me', name: 'roster@company.com' }])
    expect(compute([], { operatorLabel: undefined }).operatorLabels).toEqual(['roster@company.com'])
  })

  it('自己以外的人不受影響，仍走名冊', () => {
    rememberOperators(ORG, [{ id: 'u_other', name: 'agent.chen@company.com' }])

    expect(compute(['u_other'], { operatorLabel: 'agent.lin@company.com' }).operatorLabels)
      .toEqual(['agent.lin@company.com', 'agent.chen@company.com'])
  })
})
