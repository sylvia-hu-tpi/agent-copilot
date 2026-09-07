/**
 * `fetchPeriodMessages()` 的截斷判定 —— 2026-09-04 手動驗收時發現的缺陷。
 *
 * **原本的寫法**：`draft.post.ts` 硬寫 `truncated: false`，`messageCount: history.length`。
 * 於是超過 500 則的區間會回報「500 則、未截斷」—— 而 Board 的 `period_message_count`
 * 逐字定義是「留空 ＝ 超過 500 則的掃描上限，數不完（**不是 0**）」，寫進去的 500 是個謊。
 *
 * ⚠️ 它不會報錯：畫面顯示「500 則」、紀錄也寫得下去，只是那個數字不是事實。
 *    UI 那側也靠 `truncated` 才分得出「超過 500 則」與「則數尚未算出」。
 *
 * ⚠️ **判準與 `countByCandidate()` 是同一組**（收滿上限、且不是因為走過區間起點
 *    或資料掃完）—— 兩邊用不同判準的話，候選清單說「25 則」而草稿說「數不完」，
 *    客服無從判斷該信哪個。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../shared/types/conversation'

const fetchLatest = vi.hoisted(() => vi.fn())

vi.mock('../server/sources/message-fetch.js', () => ({ fetchLatest }))

const { fetchPeriodMessages } = await import('../server/services/closure/period.js')

const PERIOD_START = '2026-09-01T00:00:00.000Z'

/** 由舊到新的一頁（`fetchLatest()` 已反轉過，見 period.ts 的註解） */
function page(n: number, opts: { older?: boolean } = {}): Message[] {
  const base = opts.older
    ? Date.parse('2026-08-01T00:00:00.000Z')
    : Date.parse('2026-09-02T00:00:00.000Z')
  return Array.from({ length: n }, (_, i) => ({
    id: `m_${base}_${i}`,
    at: new Date(base + i * 1000).toISOString(),
    from: 'customer:c1',
    senderType: 'customer',
    text: 'x',
  } as unknown as Message))
}

/** 依序回傳指定的幾頁；用盡之後回空頁 */
function pages(...seq: Message[][]): void {
  let i = 0
  fetchLatest.mockImplementation(async () => seq[i++] ?? [])
}

beforeEach(() => {
  fetchLatest.mockReset()
})

describe('收滿掃描上限、且還有更早的沒讀到 → truncated', () => {
  it('每頁都滿、訊息都在區間內 → truncated 為 true，則數交給呼叫端轉成 null', async () => {
    pages(page(2), page(2), page(2))
    const res = await fetchPeriodMessages({} as never, 'c1', PERIOD_START, {
      scanLimit: 4,
      pageSize: 2,
    })
    expect(res.truncated).toBe(true)
    expect(res.messages).toHaveLength(4)
  })
})

describe('不是被上限中止的兩種情形 → 則數是精確的', () => {
  /**
   * ⚠️ **這一條是本檔唯一能抓到「`!exhausted` 被拿掉」的案例。**
   *    其餘案例的 `collected` 都沒收滿上限，於是退化成
   *    `collected.length >= scanLimit` 之後照樣全過 —— 驗證過，會漏。
   *    這裡刻意讓「收滿上限」與「資料掃完」**同時成立**：
   *    一頁只回 2 則（< pageSize 3，因此是最後一頁），而上限也是 2。
   */
  it('收滿上限但資料也掃完了 → truncated 為 false', async () => {
    pages(page(2))
    const res = await fetchPeriodMessages({} as never, 'c1', PERIOD_START, {
      scanLimit: 2,
      pageSize: 3,
    })
    expect(res.truncated).toBe(false)
    expect(res.messages).toHaveLength(2)
  })

  it('資料掃完（最後一頁不滿）→ truncated 為 false', async () => {
    pages(page(2), page(1))
    const res = await fetchPeriodMessages({} as never, 'c1', PERIOD_START, {
      scanLimit: 4,
      pageSize: 2,
    })
    expect(res.truncated).toBe(false)
    expect(res.messages).toHaveLength(3)
  })

  /**
   * ⚠️ `!hitOlder` 在目前的迴圈結構下**是冗餘的**，這條測不到它 ——
   *    內層是「先判 `at < startMs` 才 push，push 完才判收滿」，因此撞到更舊的訊息時
   *    `collected` 必然還沒滿，`collected.length >= scanLimit` 已經隱含了 `!hitOlder`。
   *    判定式仍寫出它，是為了與 `countByCandidate()` 的判準逐字對齊；
   *    迴圈順序一改它就會真的生效。這條案例守的是「走過起點時不算截斷」這個行為本身。
   */
  it('走過區間起點（撞到更舊的訊息）→ truncated 為 false', async () => {
    // 第二頁混入比 periodStart 更舊的 → hitOlder，代表這個區間已經完整讀到
    pages(page(2), [...page(1, { older: true }), ...page(1)])
    const res = await fetchPeriodMessages({} as never, 'c1', PERIOD_START, {
      scanLimit: 10,
      pageSize: 2,
    })
    expect(res.truncated).toBe(false)
  })

  it('完全沒有訊息 → truncated 為 false（不是「數不完」）', async () => {
    pages()
    const res = await fetchPeriodMessages({} as never, 'c1', PERIOD_START, {
      scanLimit: 4,
      pageSize: 2,
    })
    expect(res.truncated).toBe(false)
    expect(res.messages).toHaveLength(0)
  })
})

/**
 * ⚠️ **已知的殘留邊界，刻意保留**：總則數**剛好等於**掃描上限、而且最後一頁剛好滿時，
 *    分不出「剛好掃完」與「還有更多」—— 因為兩者在這一刻的觀測完全相同
 *    （要分辨就得多抓一頁，而那讓每次結案都多一次往返）。
 *
 *    判定因此**保守地回 `true`**（說「數不完」而其實剛好數完）。方向是刻意的：
 *    「說數不完、其實剛好數完」只是少給一個數字；反過來「謊報一個精確的 500」
 *    會讓 Board 上留下一筆看起來可信而其實錯的紀錄。
 *
 *    `countByCandidate()` 有同樣的邊界（它多一道「起點 vs 實際掃到的最舊一則」的比較，
 *    但在這個邊界上同樣會落到保守側）。⚠️ 兩邊 MUST 保持同一個方向。
 */
describe('已知邊界：剛好等於上限且分頁對齊', () => {
  it('保守地回 true —— 寧可少給一個數字，不要謊報一個精確值', async () => {
    pages(page(2), page(2))
    const res = await fetchPeriodMessages({} as never, 'c1', PERIOD_START, {
      scanLimit: 4,
      pageSize: 2,
    })
    expect(res.truncated).toBe(true)
    expect(res.messages).toHaveLength(4)
  })
})
