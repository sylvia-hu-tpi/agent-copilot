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
import { formatAbsolute, humanizeTimestamps } from '../app/utils/absolute-time.js'

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


describe('⑤ 知識庫來源 chip 顯示的 MUST 是檔名，MUST NOT 是檔案 id', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')

  /*
    ⚠️ 這一條守的是 002 research #2「二次訂正」既有的結論，不是新規則：
       知識庫沒有正式的 SOP 編號制度，把檔案 id（或短版本）當顯示編號是杜撰一個
       對不到任何外部制度的字串。`shared/types/knowledge.ts` 的 `KnowledgeHit.id`
       逐字寫著「MUST NOT 顯示於 UI」，而結案面板從落地起就一直在渲染它 ——
       同一份文件的容錯 id 長成 `knowledge-fallback-1a2b3c`，客服無從判斷該不該刪。
    ⚠️ 走查看得到卻沒被抓到：正式環境的來源清單在 2026-09-08 之前恆為空（契約 R2.7
       的舊做法），這一區塊根本不會出現。**「畫面上沒看到」不等於「沒有問題」。**
  */
  const chip = block.slice(
    block.indexOf('v-for="sop in draft.citedSops"'),
    block.indexOf('closure.fields.sopRemove'),
  )

  it('chip 列存在，且逐一走訪的是 citedSops 而不是一串 id', () => {
    expect(chip.length).toBeGreaterThan(0)
    expect(block).toMatch(/v-for="sop in draft\.citedSops"/)
  })

  /*
    ⚠️ **客服把來源全部刪光時，這一欄 MUST 仍然在**（2026-09-08 照畫布改；
       先前是 `v-if="draft.citedSops.length"` 把整塊藏起來）。
       整欄消失有兩個問題：客服會以為自己弄壞了什麼；而且「這次寫入不帶來源」
       這件事失去了畫面上的落點 —— 那正是他刪完之後要確認的事。
    ⚠️ 這一條擋的是「把空清單當成沒有這個欄位」，不是樣式。
  */
  it('來源被刪光時欄位不消失，改顯示「已全部移除」而不是整塊隱藏', () => {
    expect(block).not.toMatch(/v-if="draft\.citedSops\.length"/)
    expect(block).toMatch(/v-if="!draft\.citedSops\.length"/)
    expect(block).toContain('closure.fields.sopsAllRemoved')
  })

  it('chip 的內容是 title', () => {
    expect(chip).toMatch(/\{\{\s*sop\.title\s*\}\}/)
  })

  it('chip 的內容 MUST NOT 是 id', () => {
    // ⚠️ `:key="sop.id"` 是對的（title 可能重名），要擋的是把 id 插進顯示位置
    expect(chip).not.toMatch(/\{\{\s*sop\.id\s*\}\}/)
    expect(chip).not.toMatch(/\{\{\s*id\s*\}\}/)
  })
})


describe('⑥ 後續待辦：未填的那一列 MUST 自己說出來，不能只鎖住寫入鍵', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')

  /*
    ⚠️ 空白的「待辦事項」會讓 commit 端點的 zod 擋下整次寫入（`action: z.string().min(1)`），
       而前端把 400 歸成「寫入失敗」—— 顯示的是 B7 的「CRM 未收到⋯可直接重試」，
       重試送的又是同一份 body，於是永遠失敗，畫面上沒有任何地方指得出是哪一列造成的。
    ⚠️ 因此「鎖住寫入鍵」只是**其中一半**：另一半是那一列自己要標紅並就地說明。
       說明放在整組之後（2026-09-08 之前的做法）時，客服仍得一列一列自己找。
    ⚠️ 這一條掃原始碼而不是渲染結果 —— 要擋的是「把說明搬回組層級」這個退步，
       而那不會有型別錯誤，畫面上也只是少一句話。
  */
  const rowStart = block.indexOf('v-for="(f, i) in draft.followUps"')
  const row = block.slice(rowStart, block.indexOf('closure.fields.followUpAdd'))

  it('每一列都在 v-for 內部渲染自己的錯誤說明', () => {
    expect(rowStart).toBeGreaterThan(-1)
    expect(row).toMatch(/v-if="invalidFollowUpRows\.has\(i\)"/)
    expect(row).toContain('closure.fields.followUpActionRequired')
  })

  /*
    ⚠️ 這一條守的是**行為**，不是某個元件的 API：2026-09-08 把 `UInput` 換成原生
       `<input>`（照畫布 §7.2 ⑥），錯誤色從 `color="error"` 變成框線轉 `--danger`。
       因此這裡斷言的是「那一格自己看得出來是錯的」＋「輔助技術也知道」，
       而不是任何一個特定寫法。
  */
  it('該列的輸入框本身也標成錯誤色，不是只有下方一句話', () => {
    expect(row).toMatch(/invalidFollowUpRows\.has\(i\).*--danger/)
    expect(row).toMatch(/:aria-invalid="invalidFollowUpRows\.has\(i\)"/)
  })

  it('寫入鍵仍 MUST 鎖住 —— 就地標示是補充，不是取代', () => {
    expect(block).toMatch(/:disabled="status === 'writing' \|\| hasInvalidFollowUps"/)
  })
})

/*
  ⑦（2026-09-08）唯讀區把 server 給的 UTC ISO 原樣印出來
     （接手時間 `2026-09-08T02:13:19.700Z`、情緒留空說明裡的兩個時間戳），
     而客服在 UTC+8 讀它 —— 螢幕上是 02:13、他記得自己十點多才接手，
     於是這個「由系統計算、不可修改」的區塊變成沒有人會去看的字。

  ⚠️ 這一組守的是**兩邊各自該長什麼樣**，不是「有沒有做格式化」：
     畫面要本地時間**且帶時區**（不帶的話 10:13 與 Board 的 02:13Z 看起來像兩筆紀錄），
     Data Board 與後端日誌要原始 UTC ISO（存進去的字串一旦帶了某台瀏覽器的時區，
     之後就再也無法確定它是哪個時刻）。兩者是相反的要求，很容易在
     「順手讓它到處都好讀」的一次修改裡被弄成同一種。
*/
describe('⑦ 唯讀區的時間：畫面轉本地時區、Board 與日誌維持原始 UTC', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')

  describe('顯示端：formatAbsolute／humanizeTimestamps 的實際行為', () => {
    /*
      ⚠️ 一律指定 `Asia/Taipei`、locale 固定 `zh-TW`：輸出取決於執行環境，
         照系統時區斷言只會得到一個換台機器就紅的測試。
    */
    const fmt = (iso: string): string => formatAbsolute(iso, 'zh-TW', 'Asia/Taipei')

    it('UTC 的 02:13 在台北顯示成當天 10:13，而不是 02:13', () => {
      const out = fmt('2026-09-08T02:13:19.700Z')
      expect(out).toContain('10:13')
      expect(out).not.toContain('02:13')
    })

    it('MUST 帶時區標記 —— 否則與 Board 的 UTC 對不起來', () => {
      expect(fmt('2026-09-08T02:13:19.700Z')).toMatch(/GMT\+8/)
    })

    it('formatAbsolute：解析失敗回傳原字串，不會是 Invalid Date', () => {
      expect(formatAbsolute('不是時間', 'zh-TW')).toBe('不是時間')
      expect(formatAbsolute('不是時間', 'zh-TW')).not.toContain('Invalid')
    })

    it('humanizeTimestamps：只換句子裡的時間戳，其餘一個字都不動', () => {
      const note = '情緒評分僅涵蓋 2026-08-24T08:57:01.614Z 起，未涵蓋區間內第一則客戶發言 2026-08-19T08:23:17.395Z'
      const out = humanizeTimestamps(note, 'zh-TW', 'Asia/Taipei')
      expect(out).toContain('情緒評分僅涵蓋')
      expect(out).toContain('未涵蓋區間內第一則客戶發言')
      expect(out).not.toContain('2026-08-24T08:57:01.614Z')
      expect(out).not.toContain('2026-08-19T08:23:17.395Z')
      expect(out).not.toMatch(/Invalid/)
    })

    /*
      ⚠️ 這一條是整組裡最容易被「順手擴大 regex」弄壞的：
         `sentimentNote` 的其中一句正是「區間起點無法解析（…）」，
         那句裡的字串本來就不是合法時間，換掉它會讓那句話自相矛盾。
    */
    it('humanizeTimestamps：「無法解析」那一句裡的壞字串 MUST 原樣留著', () => {
      const note = '區間起點無法解析（not-a-timestamp），情緒數值留空'
      expect(humanizeTimestamps(note, 'zh-TW', 'Asia/Taipei')).toBe(note)
    })

    /*
      ⚠️ 不帶時區的字串會被 `new Date()` 當**本地時間**解析，換算結果是錯的
         而且看不出來 —— 這種字串寧可原樣顯示。
    */
    it('humanizeTimestamps：不帶時區的 ISO 不換 —— 換了會得到一個看不出錯的錯時間', () => {
      const note = '區間起點 2026-09-07T08:45:26 之後沒有任何情緒評分點'
      expect(humanizeTimestamps(note, 'zh-TW', 'Asia/Taipei')).toBe(note)
    })
  })

  describe('元件：兩個欄位都經過轉換，原始值留在 title 供事後核對', () => {
    it('接手時間 MUST NOT 直接把 ISO 當內文印出來', () => {
      expect(block).not.toMatch(/<dd[^>]*>\{\{ readonlyFields\.joinedAt \}\}<\/dd>/)
      expect(block).toMatch(/:title="readonlyFields\.joinedAt"[^>]*>\{\{ joinedAtLabel \}\}/)
    })

    it('情緒留空說明 MUST NOT 直接把整句原文印出來', () => {
      expect(block).not.toMatch(/>\{\{ readonlyFields\.sentimentNote \}\}</)
      expect(block).toContain(':title="readonlyFields.sentimentNote ?? undefined">{{ sentimentNoteLabel }}')
    })

    it('兩者共用同一支格式化 —— 兩處各寫一份遲早會分岔', () => {
      expect(block).toMatch(/formatAbsolute\(iso, locale\.value\)/)
      expect(block).toMatch(/humanizeTimestamps\(note, locale\.value\)/)
      expect(block).not.toMatch(/timeZoneName/)
    })
  })

  describe('寫入端：Board 與後端日誌不受畫面格式影響', () => {
    it('Board 的 joined_at 直接取 summary.joinedAt，中間不做任何格式化', () => {
      expect(read('server/services/closure/board-repository.ts')).toMatch(/joined_at: summary\.joinedAt,/)
    })

    it('Board 的 period_sentiment_note 直接取 summary.sentimentNote', () => {
      expect(read('server/services/closure/board-repository.ts'))
        .toMatch(/period_sentiment_note: summary\.sentimentNote,/)
    })

    /*
      ⚠️ 這條是上面兩條的真正靠山：即使有人把格式化搬到前端的送出路徑上，
         這些欄位也不會被污染 —— server 在 commit 時重算，body 帶來的一律忽略（R3.7）。
    */
    it('commit 時 joinedAt 與 sentimentNote 都來自 server 重算，不採用 request body', () => {
      const commit = read('server/api/conversations/[id]/closure/commit.post.ts')
      expect(commit).toMatch(/joinedAt: readonly\.joinedAt,/)
      expect(commit).toMatch(/sentimentNote: readonly\.sentimentNote,/)
      expect(commit).not.toMatch(/joinedAt: body\./)
      expect(commit).not.toMatch(/sentimentNote: body\./)
    })

    it('server 組的說明文字仍用原始 ISO —— 後端日誌與 Board 的比對基準只能有一個', () => {
      const range = read('server/services/closure/sentiment-range.ts')
      expect(range).toMatch(/\$\{earliest\.at\}/)
      expect(range).not.toMatch(/Intl\.DateTimeFormat/)
    })
  })
})

/*
  ⑧（2026-09-08）B7「寫入 CRM 失敗」的錯誤區塊逐字要客服
     「複製摘要並貼到 CRM 手動建檔」，畫面上卻沒有那顆鈕 ——
     次要鈕列只有「回報 IT」，而且做成按鈕列裡的 outline 按鈕。

  ⚠️ 兩顆的**內容相反**，這是本組真正要守的事：
     - 「複製摘要文字」複製的是**草稿內文**，目的地是客服自己的剪貼簿。
     - 「回報 IT」複製的是 `failMeta` ＋ 兩個 id，**刻意不含草稿內文**
       —— 草稿內文是客戶對話個資（憲法 1.5），IT 不需要也不該看到。
     把後者寫成「順便把摘要一起貼給 IT」不會報錯，只會安靜地外洩個資。
*/
describe('⑧ B7 的次要文字鈕列：兩顆內容相反，且只有 B7 有', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')
  const row = block.slice(block.indexOf('⑧-b'), block.indexOf('closure.writeWarning'))

  it('兩顆都在，且同一列', () => {
    expect(row).toContain('closure.buttons.copySummary')
    expect(row).toContain('closure.buttons.reportIt')
  })

  /*
    ⚠️ B8（`unverified`）MUST NOT 有這一列：它的出路是「先到 CRM 查驗，
       確認沒有再重試」，多給兩個出口只會讓人繞過那個查驗 —— 而畫布的
       `hasFailSecond` 也正是只在 `failed` 為真。
  */
  it('只在 failed 出現，unverified 沒有這一列', () => {
    expect(row).toContain(`showFailure && failKind === 'failed'`)
  })

  it('「回報 IT」MUST NOT 複製草稿內文（憲法 1.5）', () => {
    const fn = block.slice(block.indexOf('async function reportToIt'), block.indexOf('async function onCommit'))
    expect(fn).toContain('draftId')
    expect(fn).toContain('conversationId')
    expect(fn).not.toMatch(/d\.summary|draft\.value\?\.summary|\.intent/)
  })

  it('「複製摘要文字」MUST 複製草稿內文 —— 否則那句備援說明是空頭支票', () => {
    const fn = block.slice(block.indexOf('async function copySummaryText'), block.indexOf('/**\n * 「回報 IT」'))
    expect(fn).toContain('d.summary')
    expect(fn).toContain('d.intent')
    expect(fn).toContain('navigator.clipboard.writeText')
  })

  /*
    ⚠️ 這份文字的唯一讀者是人（客服要照著填進 CRM），因此時間也 MUST 用易讀版本；
       用原始 ISO 的話，他得自己在腦中換算時區才知道那是什麼時候。
  */
  it('複製出來的文字裡，時間用易讀版本而不是原始 ISO', () => {
    const fn = block.slice(block.indexOf('async function copySummaryText'), block.indexOf('/**\n * 「回報 IT」'))
    expect(fn).toContain('formatAbsolute(ro.joinedAt')
    expect(fn).toContain('humanizeTimestamps(ro.sentimentNote')
  })
})

/*
  ⑨（2026-09-08）唯讀區的「參與的客服」印的是 `u_df56079c-7df4-…`。
     那串字對客服不對應任何他認得的東西，而這一欄要回答的是「誰服務過這位客戶」。
     行為面的守衛在 `test/closure-operator-labels.test.ts`，這裡只守畫面用對了欄位。
*/
describe('⑨ 參與的客服：畫面顯示名字、id 留在 title', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')

  it('內文用 operatorLabels，MUST NOT 直接印 operators', () => {
    expect(block).not.toMatch(/<dd[^>]*>\{\{ readonlyFields\.operators\.join/)
    expect(block).toContain('{{ readonlyFields.operatorLabels.join(\'、\') }}')
  })

  it('原始 id 留在 title —— 事後要對 Board 的那一欄時只有它對得起來', () => {
    expect(block).toContain(':title="readonlyFields.operators.join(\'、\')"')
  })

  it('寫進 Board 的仍是 id，MUST NOT 換成顯示名', () => {
    const commit = read('server/api/conversations/[id]/closure/commit.post.ts')
    expect(commit).toMatch(/operators: readonly\.operators,/)
    expect(commit).not.toMatch(/operators: readonly\.operatorLabels/)
  })
})

/*
  ⑩（2026-09-08）三處「畫布訂了、實作走 Nuxt UI 預設」的落差。

  ⚠️⚠️ 第一項是**真的缺陷而不只是外觀**：`USelectMenu` 內建的搜尋框與空結果文案
       走 `@nuxt/ui` 自己的 locale，而本專案沒有設定 `UApp` 的 `locale` ——
       於是它落回英文（`Search…`／`No matching data`），在一個全中文的內部工具裡
       漏出兩句英文。**這不會報錯，而且 grep 自己的 `i18n/locales/zh-TW.json`
       永遠找不到它** —— 那兩句字串根本不在我方的語系檔裡，這正是它活這麼久的原因。

  ⚠️ 另外兩項是後續待辦的兩顆鈕。虛線框不只是裝飾：它與上方那幾列實線框的輸入框
     放在一起，虛線是「這裡還沒有東西、按了才會長出來」的既有視覺語彙。
*/
describe('⑩ 畫布訂了尺寸與文案的地方，MUST NOT 落回 Nuxt UI 預設', () => {
  const block = read('app/components/copilot/ClosureBlock.vue')

  it('「採取的行動」的搜尋框帶我方文案，不吃 @nuxt/ui 的英文預設', () => {
    expect(block).toContain('closure.fields.actionSearch')
    expect(block).toMatch(/:search-input=/)
  })

  it('空結果用 #empty 覆寫 —— 預設是英文的 No matching data', () => {
    expect(block).toMatch(/<template #empty>/)
    expect(block).toContain('closure.fields.actionEmpty')
  })

  it('三句文案都在我方語系檔裡（否則就是又落回內建 locale 了）', () => {
    expect(locale.closure.fields.actionSearch).toBe('搜尋行動…')
    expect(locale.closure.fields.actionEmpty).toBe('沒有符合的行動')
  })

  it('「新增一項待辦」是虛線框鈕，不是 ghost 按鈕', () => {
    const btn = block.slice(block.indexOf('虛線框是這顆鈕的語意'), block.indexOf('⑥ 唯讀區'))
    expect(btn).toContain('border-dashed')
    expect(btn).toContain('border-[var(--border-strong)]')
    expect(btn).toContain('h-[28px]')
    expect(btn).toContain('closure.fields.followUpAdd')
  })

  it('「移除這一列待辦」是 30×30 / radius 7px 的無框鈕（畫布逐字）', () => {
    const btn = block.slice(block.indexOf('closure.fields.followUpRemove') - 700, block.indexOf('closure.fields.followUpRemove') + 200)
    expect(btn).toContain('size-[30px]')
    expect(btn).toContain('rounded-[7px]')
  })

  /*
    ⚠️ 這一條守的是「不要又寫回去」：`UButton` 的 ghost variant 看起來很接近，
       但它沒有框，而框正是這兩顆鈕與周圍輸入框產生關係的地方。
  */
  it('後續待辦那一段已無 UButton', () => {
    const section = block.slice(block.indexOf('closure.fields.followUpAction'), block.indexOf('⑥ 唯讀區'))
    expect(section).not.toContain('UButton')
  })
})

/*
  ⑪（2026-09-08 手動驗收回報）進入結案流程後把中欄資訊列**收起來**，
     收合列又出現一顆「結案」——而展開態明明是「取消結案 ＋ 結案中…」。

  ⚠️ 兩個畫面對同一個狀態說了相反的話，而客服會相信眼前那一個：
     他會以為剛才沒按到而再按一次。**再按一次不會報錯**（對已在結案中的對話
     那是一次無效操作），因此這個矛盾只停在畫面上，不會在任何地方留下痕跡 ——
     沒有例外、沒有日誌、沒有紅燈。

  ⚠️ 根因是收合列只有「未接手／已接手」兩種分支，缺了第三種。
     畫布 1c 的收合列**有**這第三種（`sc-if value="{{ closing }}"`），
     而且刻意畫成不能按的徽記而不是 disabled 按鈕。
*/
describe('⑪ 收合的對話資訊列 MUST 與展開態對同一個狀態說同一句話', () => {
  const collapsed = read('app/components/conversation/HeaderCollapsed.vue')
  const page = read('app/pages/c/[conversationId].vue')

  it('收合列知道「正在結案」這件事 —— 由頁面傳入，不自己推導', () => {
    expect(collapsed).toMatch(/closing: boolean/)
    expect(page).toContain(':closing="closing"')
  })

  it('結案中 MUST NOT 再出現「結案」鍵', () => {
    expect(collapsed).toMatch(/v-else-if="closing"/)
    const closeBtn = collapsed.slice(collapsed.indexOf('v-else-if="closing"'))
    expect(closeBtn.indexOf('conversation.close')).toBeGreaterThan(closeBtn.indexOf('closure.titlebar.closing'))
  })

  /*
    ⚠️ 這一條守的是「不要改成 disabled 按鈕就算了」：disabled 也擋得住點擊，
       但它仍然長得像「這裡本來可以按」。畫布要的是徽記 —— 從形狀上就說明它是狀態。
  */
  it('結案中是不能按的徽記，不是 button', () => {
    const i = collapsed.indexOf('v-else-if="closing"')
    const el = collapsed.slice(collapsed.lastIndexOf('<', i), i + 400)
    expect(el.startsWith('<span')).toBe(true)
    expect(el).toContain('closure.titlebar.closing')
    expect(el).toContain('animate-spin')
  })

  /*
    ⚠️ 收合列與展開態共用同一個 i18n 鍵 —— 兩處各寫一份文案的話，
       改了其中一處就會變成「同一個狀態、兩種說法」，而那正是本條要修的病。
  */
  it('兩處共用同一個 i18n 鍵', () => {
    expect(collapsed).toContain('closure.titlebar.closing')
    expect(page).toContain('closure.titlebar.closing')
  })
})
