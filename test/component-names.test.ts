/**
 * 模板裡用到的元件必須真的存在 —— 這是「完全靜默」的一類錯誤。
 *
 * ── 為什麼需要一支專門的測試 ─────────────────────────────────────
 * **Vue 對未知元件不報錯、不警告，就是不渲染。**
 * typecheck 綠、build 綠、單元測試綠、smoke 綠 —— 畫面上就是少了一整塊。
 *
 * M1 已經被這個坑咬過一次：`components/conversation/Sidebar.vue`
 * 的自動匯入名稱是 **`ConversationSidebar`**，而當時寫成
 * `ConversationConversationSidebar`（誤以為要自己加目錄前綴，
 * 但 Nuxt 會**去掉重複的前綴**）。結果整個對話側欄消失，
 * 所有自動化檢查都是綠的，是使用者打開畫面才發現的。
 *
 * ⚠️ 依賴 `.nuxt/components.d.ts`，該檔由 `nuxt prepare`（postinstall）產生。
 *    找不到時**跳過而不是失敗** —— 乾淨 checkout 上還沒 prepare 過是正常的，
 *    讓 CI 因此紅掉只會教大家忽略這支測試。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const COMPONENTS_DTS = resolve(ROOT, '.nuxt/components.d.ts')

/**
 * Vue／Nuxt 的內建元件 —— 不會出現在 components.d.ts，但模板裡合法。
 * ⚠️ 只放**確定是框架內建**的，不可拿來塞自己寫錯的名字。
 */
const BUILTINS = new Set([
  'Transition', 'TransitionGroup', 'Teleport', 'KeepAlive', 'Suspense', 'Component',
  'NuxtPage', 'NuxtLayout', 'NuxtLink', 'NuxtLoadingIndicator', 'NuxtErrorBoundary',
  'ClientOnly', 'DevOnly', 'NuxtClientFallback', 'NuxtIsland', 'NuxtRouteAnnouncer',
  'NuxtWelcome', 'ServerPlaceholder', 'NuxtImg', 'NuxtPicture',
])

function vueFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(full)
    return entry.name.endsWith('.vue') ? [full] : []
  })
}

/** components.d.ts 的**全部**具名匯出（含 Nuxt UI 的 U*、Nuxt 內建與我方元件） */
function declaredComponents(): Set<string> {
  const dts = readFileSync(COMPONENTS_DTS, 'utf8')
  const names = new Set<string>()
  for (const m of dts.matchAll(/export const (\w+):/g)) {
    if (m[1]) names.add(m[1])
  }
  return names
}

/** 我方元件（指向 app/components/ 的那些）—— 用來確認測試真的看得到東西 */
function ownComponents(): Set<string> {
  const dts = readFileSync(COMPONENTS_DTS, 'utf8')
  const names = new Set<string>()
  for (const m of dts.matchAll(/export const (\w+): typeof import\("([^"]+)"\)/g)) {
    const [, name, path] = m
    if (name && path?.includes('app/components/') && !name.startsWith('Lazy')) names.add(name)
  }
  return names
}

/** 模板裡出現的 PascalCase 標籤 */
function usedComponents(source: string): Set<string> {
  const used = new Set<string>()
  // 只掃 <template> 區塊，避免 script 裡的型別註記被誤判成標籤
  const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
  for (const m of template.matchAll(/<([A-Z]\w+)[\s/>]/g)) {
    if (m[1]) used.add(m[1])
  }
  return used
}

function scanAll(): string[] {
  const declared = declaredComponents()
  const missing: string[] = []

  for (const file of [
    ...vueFiles(resolve(ROOT, 'app/pages')),
    ...vueFiles(resolve(ROOT, 'app/layouts')),
    ...vueFiles(resolve(ROOT, 'app/components')),
  ]) {
    for (const name of usedComponents(readFileSync(file, 'utf8'))) {
      if (!declared.has(name) && !BUILTINS.has(name)) {
        missing.push(`${file.replace(ROOT, '.').replace(/\\/g, '/')} → <${name}>`)
      }
    }
  }
  return missing
}

const hasDts = existsSync(COMPONENTS_DTS)

describe.skipIf(!hasDts)('模板中的元件名稱', () => {
  it('components.d.ts 確實列出我方元件（否則本測試等於沒在驗）', () => {
    expect(ownComponents().size).toBeGreaterThan(0)
  })

  it('Nuxt 會去掉重複的目錄前綴 —— conversation/Sidebar.vue → ConversationSidebar', () => {
    const own = ownComponents()
    expect(own.has('ConversationSidebar')).toBe(true)
    // 這正是當初寫錯的名字。它不存在，而 Vue 對此完全不吭聲。
    expect(own.has('ConversationConversationSidebar')).toBe(false)
  })

  it('每一個用到的元件都必須真的存在', () => {
    expect(scanAll()).toEqual([])
  })

  it('⚠️ 這支守衛本身是有效的 —— 對著錯誤名稱必須抓得出來', () => {
    // 若掃描邏輯壞掉（例如正則沒對到），上面那項會永遠通過而毫無價值。
    // 這裡直接餵一個假模板驗證偵測邏輯本身。
    const declared = declaredComponents()
    const fake = '<template><ConversationConversationSidebar /></template>'
    const used = [...usedComponents(fake)]

    expect(used).toEqual(['ConversationConversationSidebar'])
    expect(used.every(n => declared.has(n) || BUILTINS.has(n))).toBe(false)
  })
})
