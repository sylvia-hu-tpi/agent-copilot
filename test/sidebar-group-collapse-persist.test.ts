/**
 * 左欄日期區間的收合狀態必須**撐過切換對話**。
 *
 * ── 症狀與真因 ───────────────────────────────────────────────
 * 2026-09-01 實機驗收發現：收起某一天的區間後，點另一則對話，收起來的區間全部彈開。
 *
 * 真因不在 `Sidebar.vue` 的收合邏輯，而在路由：`<NuxtPage>` 預設的 key 是**把路由參數
 * 代入後的路徑**（Nuxt 的 `generateRouteKey` → `interpolatePath`），`/c/A` 換到 `/c/B`
 * 就是換了一個 key，整個 page 元件連同左欄一起 unmount／remount —— 元件內的 `ref`
 * 回到初始值。畫面上像是「收合被重設」，實際上是整個左欄重建了。
 *
 * 修法是把狀態宣告在**模組層**的 `<script>` 區塊（跨 remount 存活、重新整理後歸零）。
 *
 * ⚠️ **為什麼需要一支測試守它**：把兩個 `<script>` 區塊合併回一個、或「順手」把宣告
 *    搬進 `<script setup>`，是完全合理的整理動作 —— typecheck 綠、所有測試綠、
 *    畫面上也一切正常，只有「切換對話後收合彈開」這一個要手動操作兩步才看得到的行為壞掉。
 *    這正是上次它溜過驗收的方式。
 *
 * ⚠️ 這裡刻意**不**要求存進 `localStorage`：key 是日期，存下去會在瀏覽器裡累積一份
 *    永遠不會被清掉的舊日期清單。重新整理後回到全展開是對的。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = readFileSync(resolve(ROOT, 'app/components/conversation/Sidebar.vue'), 'utf8')

/** 取出兩種 `<script>` 區塊的內容 —— 差別只在有沒有 `setup` */
function scriptBlock(kind: 'module' | 'setup'): string {
  const re = kind === 'setup'
    ? /<script setup lang="ts">([\s\S]*?)<\/script>/
    : /<script lang="ts">([\s\S]*?)<\/script>/
  const m = SOURCE.match(re)
  expect(m, `找不到 ${kind} 的 <script> 區塊`).toBeTruthy()
  return m![1]!
}

describe('左欄日期區間的收合狀態', () => {
  it('宣告在模組層的 <script>，不在 <script setup> 裡', () => {
    expect(scriptBlock('module')).toMatch(/const collapsedGroups = ref\(/)
    // ⚠️ 搬進 setup 就等於「每換一個對話重置一次」——那正是原本的 bug
    expect(scriptBlock('setup')).not.toMatch(/const collapsedGroups\s*=/)
  })

  it('不寫進 localStorage —— key 是日期，存下去會無限累積', () => {
    expect(SOURCE).not.toMatch(/localStorage[\s\S]{0,80}collapsedGroups/)
    expect(SOURCE).not.toMatch(/collapsedGroups[\s\S]{0,80}localStorage/)
  })

  it('toggleGroup 換一個新的 Set，不原地 mutate', () => {
    // 直接 mutate 的話 `has()` 的依賴追蹤不會觸發重繪 —— 按了沒反應
    const body = scriptBlock('setup').match(/function toggleGroup[\s\S]*?\n}/)?.[0] ?? ''
    expect(body).toMatch(/new Set\(collapsedGroups\.value\)/)
    expect(body).toMatch(/collapsedGroups\.value = /)
  })

  it('page 不得用 definePageMeta({ key }) 阻止 remount 來繞過這件事', () => {
    // 那會讓草稿、面板、SSE 訂閱等其他 page 層狀態跨對話殘留，代價遠大於這個問題
    const page = readFileSync(resolve(ROOT, 'app/pages/c/[conversationId].vue'), 'utf8')
    expect(page).not.toMatch(/definePageMeta\(\{[^}]*\bkey\b/)
  })
})
