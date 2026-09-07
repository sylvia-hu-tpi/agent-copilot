/**
 * 結案面板「畫面說的事實」守衛 —— 2026-09-04 手動驗收（T053 走查）抓到的三個缺陷。
 *
 * 三個都**不會報錯、不會有型別錯誤**，只會安靜地在畫面上說錯話：
 *
 * ① 自訂起算之後涵蓋範圍顯示「超過 500 則」，而起點明明更晚、則數只可能更少。
 *    根因：`messageCount: null` 在 `ClosureScopePicker` 裡被賦予**兩種**意思 ——
 *    「超過 500 則」（`truncated: true`）與「尚未算出」（自訂起點不在候選清單裡，
 *    則數要等 `draft.period` 回來）。三處呈現都只看 `=== null`，於是後者被印成前者。
 *
 * ② 同一個根因的第二個症狀：`regen` 提示印成「（超過 500 則 **則**）」——
 *    已含「則」的字串被塞進「（{n} 則）」的模板。
 *
 * ③ 「處理結果」「情緒結果」下拉選單顯示 `unresolved`／`still_negative`。
 *    根因：`RESOLUTIONS`／`SENTIMENT_OUTCOMES` 以 `string[]` 直接餵給 `USelect`，
 *    display 就等於 value。而那些 value **不能翻譯** —— 它們是寫進 Board
 *    `SingleSelection` 的受控詞彙（`config/categories.ts` 註明 MUST 逐字相同）。
 *
 * ④（2026-09-07 T054 走查補上）情緒分析仍在進行時，唯讀區沒有換一句話說明，
 *    「還在算」與「客戶沒發言／評分未涵蓋起點」被混成同一種留白（D-7）。
 *    ⚠️ 這一條**手動走查驗不到**：那句話所在的唯讀區掛在 `draft.readonly` 底下，
 *       要等結案摘要（數秒的 AI 呼叫）回來才渲染，而情緒分析是 JOIN 當下就開跑的 ——
 *       等 draft 回來時情緒幾乎必然已 `ready`。競速條件搶不到，只能在這裡守。
 *
 * ⚠️ 為什麼是掃描式而不是掛載元件：這個 repo 的 `test/nuxt/` 不掛載元件
 *    （見 `suggestion-citation-cue.test.ts`），而 ③ 真正該守的其實不是「畫面長怎樣」，
 *    是「**值域與中文對照有沒有對齊**」—— 那是資料，掃描比渲染更直接。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESOLUTIONS, SENTIMENT_OUTCOMES } from '../config/categories'

const ROOT = resolve(import.meta.dirname, '..')

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

const locale = JSON.parse(read('i18n/locales/zh-TW.json')) as {
  closure: {
    vocab: Record<string, Record<string, string>>
    scope: Record<string, string>
    fields: Record<string, string>
  }
}

describe('③ 受控詞彙：value 進 Board、中文只給客服看，兩者 MUST 雙向對齊', () => {
  const cases: Array<[string, readonly string[]]> = [
    ['resolution', RESOLUTIONS],
    ['sentimentOutcome', SENTIMENT_OUTCOMES],
  ]

  it.each(cases)('%s 的每個值都有中文對照', (group, values) => {
    const table = locale.closure.vocab[group]
    expect(table).toBeDefined()
    for (const v of values) {
      expect(table![v], `受控詞彙 ${group}.${v} 沒有中文對照，客服會看到英文原值`).toBeTruthy()
      // ⚠️ 中文對照 MUST NOT 等於 value 本身 —— 那等於沒翻，而且不會被上一條抓到
      expect(table![v]).not.toBe(v)
    }
  })

  it.each(cases)('%s 的中文對照沒有多餘鍵（值域縮減後的殘留）', (group, values) => {
    const table = locale.closure.vocab[group]!
    expect(Object.keys(table).sort()).toEqual([...values].sort())
  })

  /**
   * ⚠️ 這一條是本檔最重要的：`escalated` **同時存在於兩張表，語意相反**。
   *    `resolution.escalated` ＝ 案子往上轉（好事，處理中）；
   *    `sentimentOutcome.escalated` ＝ 客戶情緒惡化（壞事）。
   *    共用一份對照就會把其中一邊翻錯，而報表看不出來 —— 它只會看到中文。
   */
  it('同時存在於兩張表的值，中文 MUST 不同（escalated 的好壞方向相反）', () => {
    const both = RESOLUTIONS.filter(v => (SENTIMENT_OUTCOMES as readonly string[]).includes(v))
    expect(both, '前提變了：兩張表不再有共用值，這條守衛要重新評估').toContain('escalated')
    for (const v of both) {
      expect(
        locale.closure.vocab.resolution![v],
        `${v} 在兩張表的中文相同 —— 其中一邊必然是錯的`,
      ).not.toBe(locale.closure.vocab.sentimentOutcome![v])
    }
  })

  it('元件不再把受控詞彙以 string[] 直接餵給 USelect', () => {
    const src = read('app/components/copilot/ClosureBlock.vue')
    expect(src).not.toMatch(/const resolutionItems: string\[\]/)
    expect(src).not.toMatch(/const sentimentOutcomeItems: string\[\]/)
    // 兩者都必須經過 label／value 對照
    expect(src).toMatch(/closure\.vocab\.resolution\./)
    expect(src).toMatch(/closure\.vocab\.sentimentOutcome\./)
  })
})

describe('①② 則數的三種狀態：超過上限／尚未算出／確切數字', () => {
  const picker = read('app/components/copilot/ClosureScopePicker.vue')

  it('「超過 500 則」的判斷經由 truncated，而不是 messageCount === null', () => {
    const kind = picker.match(/function countPhrase[\s\S]*?\n}/)?.[0]
    expect(kind, 'countPhrase 不見了 —— 三態判斷被搬走或改名，這條守衛要跟著改').toBeTruthy()
    // truncated 必須先判，否則「尚未算出」會落進「超過 500 則」
    expect(kind!.indexOf('truncated')).toBeGreaterThan(-1)
    expect(kind!.indexOf('truncated')).toBeLessThan(kind!.indexOf('=== null'))
  })

  it('已無「則數不明就當 0 則」的路徑（憲法 4.5：不猜）', () => {
    expect(picker).toMatch(/countPending/)
    // ⚠️ 舊寫法 `(messageCount ?? Number.POSITIVE_INFINITY) > HEAVY` 把「尚未算出」染成 warn 色
    expect(picker).not.toMatch(/messageCount \?\? Number\.POSITIVE_INFINITY/)
  })

  it('則數片語與起點片語分開，模板不會疊出「超過 500 則 則」', () => {
    // 組合式模板：{count} 已含單位，因此模板本身 MUST NOT 再寫「則」
    expect(locale.closure.scope.row).toBe('{start} · {count}')
    expect(locale.closure.scope.regen).not.toMatch(/\{count\}\s*則/)
    expect(locale.closure.scope.countN).toBe('{n} 則')
    // 舊的合成鍵已移除，避免有人再把含單位的字串塞進帶單位的模板
    expect(locale.closure.scope.rowTruncated).toBeUndefined()
    expect(locale.closure.scope.coverageTruncated).toBeUndefined()
  })

  /**
   * ⚠️ 畫布的 regen 提示是**兩個完整字串**，不是一個模板換參數：
   *    安全網版「已改為第一則對話起」**沒有空格**，時間戳版「已改為 9/2 14:30 起」有。
   *    把兩者統一成 `{start}` 一個模板（看起來更 DRY）會在安全網版多出一個空格。
   */
  it('regen 的兩個模板逐字保留（含「已改為」後的空格差異）', () => {
    expect(locale.closure.scope.regenFirst)
      .toBe('涵蓋範圍已改為第一則對話起（{count}），正在重新產生摘要…')
    expect(locale.closure.scope.regen)
      .toBe('涵蓋範圍已改為 {t} 起（{count}），正在重新產生摘要…')
  })

  it('自訂起算的則數來自 draft.period，且只在區間相符時採用', () => {
    expect(picker).toMatch(/period\?: ClosurePeriod \| null/)
    // ⚠️ 不比對 start／origin 就採用的話，regen 在途時會顯示上一個區間的則數
    const current = picker.match(/const current = computed[\s\S]*?\n}\)/)?.[0]
    expect(current).toBeTruthy()
    expect(current!).toMatch(/p\.start === props\.selected\.periodStart/)
    expect(current!).toMatch(/p\.origin === props\.selected\.periodOrigin/)
  })
})

/**
 * ⚠️ 這一組守的是 2026-09-04 我方自己引入的三段**死程式碼**（改完當天就發現）：
 *    `regenerating` 曾寫成 `status === 'generating' && draft !== null`，
 *    而契約 R2.2 要求發請求前先清空 `draft` —— 於是它恆為 `false`，
 *    regen 的提示卡、淡出與忙碌鍵三段畫面全部永不觸發。
 *    **測試沒抓到**，因為當時的守衛只掃「程式碼長怎樣」，不驗「條件會不會成立」。
 */
describe('regen 的判斷來源：store 旗標，不是 draft 是否存在', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')
  const store = read('app/stores/closure.ts')

  it('元件讀 store 的 regenerating，而不是自己用 draft 推導', () => {
    expect(block).toMatch(/session\.value\?\.regenerating/)
    expect(block, "draft 在 generating 期間恆為 null（R2.2），用它推導會讓整段畫面永不出現")
      .not.toMatch(/generating'\s*&&\s*draft\.value\s*!==\s*null/)
  })

  it('store 在清空 draft 之前記錄「這次是重新產生」', () => {
    expect(store).toMatch(/regenerating: boolean/)
    const pick = store.slice(store.indexOf('async function pick('))
      .slice(0, 2000)
    expect(pick).toBeTruthy()
    const hadDraftAt = pick!.indexOf('hadDraft')
    const clearedAt = pick!.indexOf('draft: null')
    expect(hadDraftAt).toBeGreaterThan(-1)
    expect(hadDraftAt, 'hadDraft 取在 draft 被清掉之後 —— 那永遠會是 false')
      .toBeLessThan(clearedAt)
  })

  it('regen 的忙碌鍵不在 v-if="draft" 區塊內（否則整列不會渲染）', () => {
    const line = block.split(String.fromCharCode(10))
      .find(l => l.includes('v-if="regenerating"') && l.includes('<div'))
    expect(line, 'regen 忙碌鍵的容器不見了').toBeTruthy()
    expect(line!.match(/^\s*/)![0].length, '縮排超過 6 格 —— 它被塞進 v-if="draft" 裡了')
      .toBeLessThanOrEqual(6)
  })
})

describe('B1／B4：畫布逐字要求（DESIGN_TOKENS.md §7.5）', () => {
  const picker = read('app/components/copilot/ClosureScopePicker.vue')

  it('安全網的起點逐字是「第一則對話起」，不是時間戳', () => {
    expect(locale.closure.scope.startFirst).toBe('第一則對話起')
    expect(picker).toMatch(/origin === 'first'[\s\S]{0,80}startFirst/)
  })

  /**
   * ⚠️ 用**縮排**判斷而不是用出現順序：`coverage` 與 `regen` 都在清單之後
   *    （§7.5 的位置要求），因此「regenText 出現在 `v-if="open"` 之前」不再成立。
   *    真正要守的是「它不在展開條件內」—— `<section>` 直屬元素縮排 4 格，
   *    `v-if="open"` 區塊內的是 6 格以上。
   */
  it('regen 提示不在展開態之內 —— 收合時也 MUST 看得到（畫布 B4 就是收合態）', () => {
    const lines = picker.split(/\r?\n/)
    expect(lines.find(l => l.includes('{{ regenText }}')), 'regenText 不見了').toBeTruthy()
    const host = lines.find(l => /^\s*v-if="regenerating && current"/.test(l))
    expect(host, 'regen 提示的 v-if 不再是 `regenerating && current`').toBeTruthy()
    expect(host!.match(/^\s*/)![0].length, 'regen 提示縮排超過 6 格 —— 它被塞進 v-if="open" 裡了')
      .toBeLessThanOrEqual(6)
    expect(host!).not.toMatch(/open/)
  })

  it('coverage 在候選清單之後，且帶 check icon（§7.5）', () => {
    const template = picker.slice(picker.indexOf('<template>'))
    expect(template.indexOf('{{ coverage }}'))
      .toBeGreaterThan(template.indexOf('v-if="open"'))
    expect(template).toMatch(/i-lucide-check[\s\S]{0,200}\{\{ coverage \}\}/)
  })

  it('自訂起算時間是一整列且有框線（未套用虛線／已套用 --navy 實線）', () => {
    expect(picker).toMatch(/isCustomApplied/)
    expect(picker).toMatch(/1px dashed var\(--border-dash\)/)
    expect(picker).toMatch(/1px solid var\(--navy\)/)
  })
})

describe('④ D-7：留空的兩種原因 MUST NOT 被混成同一句話', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')
  const page = read('app/pages/c/[conversationId].vue')

  it('「還在算」與「本來就沒有」是兩句不同的文案', () => {
    const fields = locale.closure.fields
    expect(fields.sentimentPending).toBeTruthy()
    expect(fields.sentimentPending).not.toBe(fields.sentimentEmpty)
    // 客服的下一步在文案裡要說得出來，否則「等一下就有」和「等也沒有」仍然分不開
    expect(fields.sentimentPending).toMatch(/重新產生/)
  })

  it('pending 那句只出現在「三數值為 null」的分支裡，不是另開一塊', () => {
    // 有值的時候顯示三個數值，沒值的時候才輪到這兩句二選一
    const guard = block.indexOf('readonlyFields.sentimentStart !== null')
    const pending = block.indexOf("$t('closure.fields.sentimentPending')")
    expect(guard).toBeGreaterThan(-1)
    expect(pending).toBeGreaterThan(guard)
  })

  it('pending 與 sentimentNote 是 v-if／v-else 的互斥兩支（不會同時出現、也不會都不出現）', () => {
    expect(block).toMatch(
      /v-if="sentimentPending"[\s\S]{0,500}v-else[\s\S]{0,300}readonlyFields\.sentimentNote/,
    )
  })

  it('pending 帶轉圈 icon —— 它表達的是「還在跑」，不是一句靜態說明', () => {
    expect(block).toMatch(/v-if="sentimentPending"[\s\S]{0,400}animate-spin/)
  })

  it('sentimentPending 只由 analyzing／retrying 推導，error 與 ready 都不算「還在算」', () => {
    const start = page.indexOf('const sentimentPending = computed(')
    expect(start).toBeGreaterThan(-1)
    /*
      整段 computed ＝ 從宣告到「行尾是 `)`」的那一行為止。
      ⚠️ 不能取固定行數 —— 多加一個 `|| … === 'error'` 就會落在窗外，守衛等於沒守。
         （2026-09-07 實際踩到：取三行時退回舊寫法不會紅。）
    */
    const rest = page.slice(start).split(String.fromCharCode(10))
    const end = rest.findIndex(l => l.trimEnd().endsWith(')'))
    expect(end).toBeGreaterThan(-1)
    const expr = rest.slice(0, end + 1).join(' ')
    expect(expr).toMatch(/'analyzing'/)
    expect(expr).toMatch(/'retrying'/)
    // ⚠️ error 若算進來，客服會一直等一個永遠不會來的結果（該按的是重試）
    expect(expr).not.toMatch(/'error'/)
    expect(expr).not.toMatch(/'ready'/)
  })
})

