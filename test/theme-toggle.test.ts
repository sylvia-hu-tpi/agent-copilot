/**
 * 主題切換鈕的守衛 —— 四種「不會報錯、只會安靜做錯事」的缺陷。
 *
 * 這顆鈕是畫布 2026-09-08 16:08 版新增的（`docs/DESIGN_TOKENS.md` §8.1），
 * 而它牽涉的每一個決定壞掉時都**不會有型別錯誤、不會有 runtime 錯誤**：
 *
 * ① **icon 方向反了**。畫布的規則是「icon 畫的是按下去會變成什麼」——
 *    淺色時顯示月亮。反過來寫，畫面完全正常，只是每個使用者都會按錯一次。
 * ② **切到 `colorMode.value` 而不是 `preference`**。兩者型別相同、都能寫入、
 *    當下畫面也都會變 —— 唯一的症狀是重新整理後主題自己跳回去，
 *    而那要等到下一次重整才看得到，手動走查很容易錯過。
 * ③ **`preference` 留在模組預設的 `'system'`**。使用者裁示「首次進入固定 light」，
 *    但預設是跟隨作業系統：在淺色系統的開發機上永遠測不出差別，
 *    到了深色系統的使用者那裡第一次打開就是深色。
 * ④ **選擇器對不上**。畫布用 `[data-theme="dark"]`、實作用 `.dark`（`main.css` §0 的理由）。
 *    切錯目標時自訂區塊會變色、Nuxt UI 元件不會，得到半深半淺的畫面。
 *
 * ⚠️ 為什麼是掃描式而不是掛載元件：這個 repo 的 `test/nuxt/` 不掛載元件
 *    （同 `closure-ui-honesty.test.ts` 的理由）。而這四條要守的其實都不是「畫面長怎樣」，
 *    是「**設定與畫布的對照有沒有對齊**」—— 那是文字，掃描比渲染更直接。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

const layout = read('app/layouts/console.vue')
const config = read('nuxt.config.ts')
const css = read('app/assets/css/main.css')

/** 畫布逐字給的兩條 path（`docs/DESIGN_TOKENS.md` §8.1）—— 不是 lucide 的 moon／sun */
const MOON = 'M20.5 14.8A8.5 8.5 0 1 1 9.2 3.5a6.8 6.8 0 0 0 11.3 11.3z'
const SUN = 'M12 3v1.5M12 19.5V21M4.2 4.2l1.1 1.1M18.7 18.7l1.1 1.1M3 12h1.5M19.5 12H21M4.2 19.8l1.1-1.1M18.7 5.3l1.1-1.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0'

describe('① icon 畫的是「按下去會變成什麼」，不是「現在是什麼」', () => {
  it('兩條 path 都逐字取自畫布，沒有被換成 lucide 的 moon／sun', () => {
    expect(layout, '月亮的 path 與畫布不符 —— 換成 lucide 會靜默偏離畫布').toContain(MOON)
    expect(layout, '太陽的 path 與畫布不符 —— 換成 lucide 會靜默偏離畫布').toContain(SUN)
  })

  it('月亮掛在 toDark（目前淺色）、太陽掛在 toLight（目前深色）', () => {
    // 兩者的鍵名就是「按下去會變成什麼」；掛反了畫面正常，只是人人按錯一次
    expect(layout).toMatch(new RegExp(`toDark:\\s*'${MOON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    expect(layout).toMatch(new RegExp(`toLight:\\s*'${SUN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  })

  it('isDark 時取 toLight（太陽），否則取 toDark（月亮）', () => {
    expect(
      layout,
      'themeIconPath 的三元運算子方向反了 —— 深色時應該顯示太陽（按了變淺色）',
    ).toContain('isDark.value ? THEME_ICON.toLight : THEME_ICON.toDark')
  })

  it('title／aria-label 與 icon 說同一件事（都是「會變成什麼」）', () => {
    expect(layout).toContain(`isDark ? 'theme.toLight' : 'theme.toDark'`)
  })
})

describe('② 切換寫的是 preference（會持久化），不是 value（只改當下畫面）', () => {
  it('toggleTheme 指派給 colorMode.preference', () => {
    expect(
      layout,
      '寫 colorMode.value 不會進 localStorage —— 症狀只有「重新整理後主題自己跳回去」',
    ).toMatch(/colorMode\.preference\s*=/)
  })

  it('沒有任何地方指派給 colorMode.value', () => {
    expect(layout).not.toMatch(/colorMode\.value\s*=[^=]/)
  })
})

describe('③ 首次進入固定 light（使用者裁示 2026-09-08），不是模組預設的 system', () => {
  it('nuxt.config.ts 明寫 colorMode.preference 為 light', () => {
    const block = config.match(/colorMode:\s*\{[\s\S]*?\}/)?.[0]
    expect(block, 'nuxt.config.ts 沒有 colorMode 設定 —— 會退回模組預設的 system').toBeTruthy()
    expect(block).toMatch(/preference:\s*'light'/)
    expect(block, "preference 若留成 'system'，深色系統的使用者第一次打開就是深色").not.toMatch(/preference:\s*'system'/)
  })
})

describe('④ 選擇器：實作用 .dark，畫布的 [data-theme] 只是畫布的寫法', () => {
  it('main.css 的深色 token 掛在 .dark 上', () => {
    expect(css).toMatch(/^\.dark\s*\{/m)
  })

  it('main.css 沒有改用 [data-theme]（兩套並存會讓 Nuxt UI 元件與自訂區塊不同步）', () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('[data-theme')
  })
})
