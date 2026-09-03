/**
 * `:style` 裡的**簡寫屬性**不可綁成 `undefined` —— 這是「完全靜默」的一類錯誤。
 *
 * ── 為什麼需要一支專門的測試 ─────────────────────────────────────
 * 2026-08-31，`MessageBubble.vue` 的客戶訊息泡泡在畫面上長出一條**深色左框線**，
 * 而設計稿沒有。typecheck 綠、build 綠、360 支測試全綠 —— 是使用者截圖比對才發現的。
 *
 * 成因是這一行：
 *
 *     borderLeft: senderType === 'ai' ? '3px solid var(--ai)' : undefined,
 *
 * 直覺上「undefined ＝ 不設定」，但 Vue 的 `patchStyle` 會**逐一走過物件的每個 key**，
 * 值是 `undefined` 時執行 `el.style.borderLeft = ''`。依 CSSOM，把**簡寫屬性**
 * 設成空字串等同 `removeProperty('border-left')`，而它會連帶移除三個長寫：
 * `border-left-width`／`border-left-style`／`border-left-color`。
 *
 * 同一個物件的上一行才剛寫入 `borderColor: 'var(--border)'`（展開成四個
 * `border-*-color` 長寫），於是 `border-left-color` 被一併清掉，顏色掉回層疊。
 * Tailwind 的 `border` utility **只給 width 與 style、沒有給 color**，
 * 所以左邊框取初始值 `currentColor` —— 也就是同一個物件裡的 `color: tone.fg`。
 * 客戶泡泡的 `--text` 是近黑色，結果就是三邊淺灰、左邊一條深色線。
 *
 * ⚠️ **這個坑與「值是什麼」無關，只與「key 出現了沒」有關。**
 *    正確寫法是條件**展開**，讓 key 在不需要時根本不存在：
 *
 *        ...(cond ? { borderLeft: '3px solid var(--ai)' } : {}),
 *
 * ⚠️ 只擋**簡寫**屬性。長寫（`borderLeftColor`…）設成 `''` 只影響它自己，是安全的；
 *    非 style 的 attribute（`:title`／`:aria-current`）綁 `undefined` 是**正確**用法
 *    （Vue 會移除該屬性），因此本測試刻意只掃 `:style` 區塊。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * CSS 簡寫屬性（camelCase，對應 `CSSStyleDeclaration` 的介面名）。
 * ⚠️ 判準是「這個屬性會展開成多個長寫」，不是「常不常用」——
 *    只有簡寫在被設成 `''` 時會波及其他長寫。
 */
const SHORTHANDS = [
  'background', 'border', 'borderBlock', 'borderBottom', 'borderColor', 'borderImage',
  'borderInline', 'borderLeft', 'borderRadius', 'borderRight', 'borderStyle', 'borderTop',
  'borderWidth', 'columns', 'flex', 'flexFlow', 'font', 'gap', 'grid', 'gridArea',
  'gridColumn', 'gridRow', 'gridTemplate', 'inset', 'listStyle', 'margin', 'mask',
  'offset', 'outline', 'overflow', 'padding', 'placeItems', 'placeContent', 'placeSelf',
  'textDecoration', 'transition',
]

function vueFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(full)
    return entry.isFile() && entry.name.endsWith('.vue') ? [full] : []
  })
}

/** 去掉註解 —— 註解裡本來就會把「MUST NOT 這樣寫」的反例寫出來 */
function codeOnly(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 抓出所有 `:style="…"` / `v-bind:style="…"` 的內容。
 * 屬性值裡可能含單引號與樣板字串，但不會含未跳脫的雙引號，
 * 因此以雙引號界定就夠 —— 專案內的 style 綁定全部是雙引號寫法。
 */
function styleBindings(code: string): string[] {
  return [...code.matchAll(/(?::|v-bind:)style="([^"]*)"/g)].map(m => m[1]!)
}

const OFFENDER = new RegExp(
  String.raw`\b(${SHORTHANDS.join('|')})\s*:\s*[^,}]*?\bundefined\b`,
)

describe(':style 的簡寫屬性不可綁 undefined', () => {
  const files = [...vueFiles(resolve(ROOT, 'app'))]

  it('掃得到 .vue 檔（避免路徑寫錯時這支測試靜默通過）', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files.map(f => [f.slice(ROOT.length + 1).replace(/\\/g, '/'), f] as const))(
    '%s',
    (_label, file) => {
      const offenders = styleBindings(codeOnly(readFileSync(file, 'utf8')))
        .flatMap(binding => binding.split('\n'))
        .map(line => line.trim())
        .filter(line => OFFENDER.test(line))

      expect(offenders, [
        '簡寫屬性綁 undefined 會讓 Vue 執行 `style.<簡寫> = \'\'`，',
        '等同 removeProperty()，會連帶清掉同一個物件稍早寫入的長寫。',
        '改用條件展開：...(cond ? { key: value } : {})',
      ].join('\n')).toEqual([])
    },
  )
})
