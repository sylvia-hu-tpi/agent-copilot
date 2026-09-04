/**
 * SC-004／FR-046a／FR-040a：**摘要產生期間 100% 誠實。**
 *
 * 2026-09-03 裁示把 SC-004 從「N 秒內完成」改寫成這一條 —— 耗時由涵蓋區間長度
 * 決定，訂任何秒數都是錯的口徑。因此改驗三個 0：
 *   ① 完成前 `status` **從未**等於 `'ready'`（不在完成前顯示完成訊號）
 *   ② `closure.*` 文案中**不含**「秒」「約」＋數字的時間承諾（不給會過期的承諾）
 *   ③ `generating` 期間 `canCancel === true`，且 `cancel()` 會真的 abort 在途請求
 *
 * ⚠️ **本檔必須放在 `test/nuxt/`**：它 import `app/stores/closure.ts`，
 *    而只有這個目錄由 `nuxt typecheck` 以真正的 auto-import 型別檢查
 *    （`ref`／`$fetch`）。放 `test/` 會落到 `tsconfig.scripts.json`（Node 環境、
 *    沒有 auto-import 宣告）而必紅 —— 見 `test/nuxt/stream-store.test.ts` 檔頭
 *    與 `tsconfig.scripts.json` L33–39。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 三種涵蓋區間長度 × 幾次 —— SC-004 逐字要求共 20 次 */
const CASES = [
  { label: '短區間', delayMs: 5, runs: 7 },
  { label: '中區間', delayMs: 25, runs: 7 },
  { label: '長區間', delayMs: 60, runs: 6 },
]

const CONV = 'conv-wait-honesty'

const fetchMock = vi.fn<(path: string, opts?: Record<string, unknown>) => Promise<unknown>>()

let useClosureStore: typeof import('../../app/stores/closure.js')['useClosureStore']

const SCOPES = {
  candidates: [],
  fallback: { start: '2026-09-01T00:00:00.000Z', origin: 'first', messageCount: 9, truncated: false },
  overflowCount: 0,
  defaultIndex: -1,
  firstMessageAt: '2026-09-01T00:00:00.000Z',
  baselineAt: '2026-09-03T10:15:00.000Z',
  closureBaseline: [],
}

function draftFor(delayMs: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise({
      draftId: 'draft_1',
      conversationId: CONV,
      period: { start: SCOPES.fallback.start, origin: 'first', messageCount: 9, truncated: false },
      summary: '摘要', intent: '意圖', category: '', resolution: '',
      actionsTaken: [], sentimentOutcome: '', citedSopIds: [], followUps: [],
      readonly: {
        operators: ['u_1'], joinedAt: SCOPES.fallback.start, closedAt: null,
        sentimentStart: null, sentimentEnd: null, sentimentTrough: null,
        sentimentNote: '評分點不齊', channel: 'line', contactId: 'con_1', confidence: null,
      },
    }), delayMs)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }, { once: true })
  })
}

beforeEach(async () => {
  fetchMock.mockReset()
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('$fetch', fetchMock)
  setActivePinia(createPinia())
  // ⚠️ 動態載入：stubGlobal 必須在 module 求值前生效
  ;({ useClosureStore } = await import('../../app/stores/closure.js'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SC-004 ①：完成前 status 從未等於 ready（三種區間長度共 20 次）', () => {
  for (const c of CASES) {
    for (let run = 0; run < c.runs; run++) {
      it(`${c.label} 第 ${run + 1} 次`, async () => {
        const store = useClosureStore()
        let resolved = false

        fetchMock.mockImplementation(async (path, opts) => {
          if (path.endsWith('/closure/scopes')) return SCOPES
          if (path.endsWith('/closure/draft')) {
            const out = await draftFor(c.delayMs, opts?.signal as AbortSignal | undefined)
            resolved = true
            return out
          }
          throw new Error(`未預期的路徑 ${path}`)
        })

        // 產生期間每 1ms 檢查一次：只要草稿還沒回來，就 MUST NOT 是 ready
        const observed: string[] = []
        const poll = setInterval(() => {
          const s = store.get(CONV)
          if (!s) return
          observed.push(s.status)
          if (!resolved) {
            expect(s.status, '草稿尚未產生完成，status 不得是 ready').not.toBe('ready')
          }
        }, 1)

        await store.open(CONV)
        clearInterval(poll)

        expect(store.get(CONV)?.status).toBe('ready')
        expect(store.get(CONV)?.draft?.draftId).toBe('draft_1')
        // 觀察真的有跑到 —— 少了這條，上面的迴圈可能一次都沒執行而看起來是通過的
        expect(observed.length).toBeGreaterThan(0)
      })
    }
  }
})

describe('SC-004 ②：closure.* 文案不得含會過期的時間承諾（FR-046a）', () => {
  const locale = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../i18n/locales/zh-TW.json'), 'utf8'),
  ) as Record<string, unknown>

  /** 把 `closure` 底下所有字串攤平成 `[path, text]` */
  function flatten(node: unknown, path: string, out: Array<[string, string]>): void {
    if (typeof node === 'string') { out.push([path, node]); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) flatten(v, path ? `${path}.${k}` : k, out)
  }

  it('closure.* 存在且有內容（少了這條，下面那項會恆真）', () => {
    const texts: Array<[string, string]> = []
    flatten(locale.closure, 'closure', texts)
    expect(texts.length).toBeGreaterThan(10)
  })

  it('沒有任何一句給出「約 N 秒」這類承諾', () => {
    const texts: Array<[string, string]> = []
    flatten(locale.closure, 'closure', texts)

    /*
      ⚠️ 抓的是「數字 ＋ 秒／分鐘」與「約 ＋ 數字」兩種形狀。
         ⚠️ 刻意**排除** `{n}` 這種樣板佔位（例如「{n} 則」）—— 那是則數不是時間承諾。
         ⚠️ 也刻意排除「30 秒」以外的寫入逾時說明？**不排除** ——
            寫入路徑的文案不屬於 `closure.generating`，若真的寫在 closure.* 裡
            也應該讓這條紅一次，由人判斷要不要挪走。寧可誤報，不可漏報：
            這條守的是「等待期間的承諾」，而那正是最容易被順手加上去的東西。
    */
    const PROMISE = /(\d+\s*(秒|分鐘|分鍾))|(約\s*\d)/
    const offenders = texts.filter(([, text]) => PROMISE.test(text))
    expect(offenders).toEqual([])
  })
})

describe('SC-004 ③／FR-040a：產生期間可取消，且取消會真的中止在途請求', () => {
  it('generating 期間 canCancel 為 true；cancel() 會 abort 在途的 draft 請求', async () => {
    const store = useClosureStore()
    let draftSignal: AbortSignal | undefined

    fetchMock.mockImplementation(async (path, opts) => {
      if (path.endsWith('/closure/scopes')) return SCOPES
      if (path.endsWith('/closure/draft')) {
        draftSignal = opts?.signal as AbortSignal | undefined
        // 永不 resolve —— 只有 abort 才會結束（模擬長區間）
        return draftFor(60_000, draftSignal)
      }
      throw new Error(`未預期的路徑 ${path}`)
    })

    const pending = store.open(CONV)
    // 等 scopes 落地並進入 generating
    await vi.waitFor(() => expect(store.get(CONV)?.status).toBe('generating'))

    expect(store.canCancel(CONV)).toBe(true)
    expect(draftSignal).toBeDefined()
    expect(draftSignal!.aborted).toBe(false)

    store.cancel(CONV)

    // ⚠️ 這一行是整條規則的重點：取消 MUST 真的中止在途呼叫，
    //    MUST NOT 只是把畫面關掉（後者的呼叫照送、錢照付、結果無人看）
    expect(draftSignal!.aborted).toBe(true)
    // 取消 ＝ 面板消失、不留任何紀錄
    expect(store.get(CONV)).toBeUndefined()
    await pending
  })

  it('⚠️ writing 期間 canCancel 為 false —— 它是唯一不可取消的狀態', async () => {
    const store = useClosureStore()
    fetchMock.mockImplementation(async (path) => {
      if (path.endsWith('/closure/scopes')) return SCOPES
      if (path.endsWith('/closure/draft')) return draftFor(0)
      if (path.endsWith('/closure/commit')) return new Promise(() => {}) // 永不落定
      throw new Error(`未預期的路徑 ${path}`)
    })

    await store.open(CONV)
    expect(store.canCancel(CONV)).toBe(true)

    void store.commit(CONV)
    await vi.waitFor(() => expect(store.get(CONV)?.status).toBe('writing'))
    expect(store.canCancel(CONV)).toBe(false)
    // 不可取消的前提是有 30 秒硬上界（FR-032a）—— 那一半由 server 端的測試守
    store.cancel(CONV)
    expect(store.get(CONV)?.status).toBe('writing')
  })
})
