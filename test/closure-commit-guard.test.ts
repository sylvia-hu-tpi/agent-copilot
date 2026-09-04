/**
 * SC-001／契約 R3.1：**寫入 CRM 只能由客服明確按下時觸發。**
 *
 * ⚠️ 這條是憲法第五條的落點，也是整個 006 存在的理由 ——
 *    「按下結案就寫」「摘要產生完成就寫」「閒置逾時就寫」「離開時順手寫」
 *    四種自動路徑都違反 FR-011，而**四種都不會報錯**：畫面照常、
 *    紀錄照樣進 CRM，只是沒有人看過它。
 *
 * ⚠️ **server 端無法保證這件事**（它分不出這個請求是誰按的），
 *    因此唯一的防線是靜態掃描：全 repo 只有一處呼叫 `/closure/commit`，
 *    而那一處在 store 的 `commit()` action 裡。
 *
 * ⚠️ 第二條驗的是 research #16：`closeConversation()` **不再呼叫 LEAVE**。
 *    LEAVE 移到寫入成功之後（FR-033）—— 舊版是「先 leave → 停止分析 → 隱藏面板」，
 *    留著的話客服一按結案就離開了，而結案面板要用到的分析狀態同時被停掉。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

function filesUnder(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full, exts)
    return exts.some(e => entry.name.endsWith(e)) ? [full] : []
  })
}

const toRel = (full: string): string =>
  full.replace(ROOT, '').split('\\').join('/').replace(/^\//, '')

/** ⚠️ 只剝註解、保留字串 —— 端點路徑本身就是字串，連字串一起剝會讓守衛恆真 */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const ENDPOINT = '/closure/commit'
const EXPECTED_CALLER = 'app/stores/closure.ts'

describe('SC-001：全 repo 只有一處呼叫 /closure/commit', () => {
  const appFiles = filesUnder(resolve(ROOT, 'app'), ['.ts', '.vue'])

  it('掃描本身是有效的 —— app/ 底下確實掃得到檔案', () => {
    // 掃描邏輯壞掉（例如 filesUnder 回空陣列）時，下面那項會永遠通過而毫無價值
    expect(appFiles.length).toBeGreaterThan(10)
  })

  it('`/closure/commit` 在 app/ 底下只出現一次，且在 store 裡', () => {
    const occurrences: Array<{ rel: string, count: number }> = []
    for (const f of appFiles) {
      const code = stripComments(readFileSync(f, 'utf8'))
      const count = code.split(ENDPOINT).length - 1
      if (count > 0) occurrences.push({ rel: toRel(f), count })
    }

    expect(occurrences).toEqual([{ rel: EXPECTED_CALLER, count: 1 }])
  })

  it('research #16：closeConversation() 不再呼叫 /leave', () => {
    const rel = 'app/composables/useConversationView.ts'
    const source = readFileSync(resolve(ROOT, rel), 'utf8')
    expect(source, `${rel} 不存在或被改名 —— 守衛會恆真`).toContain('closeConversation')

    // 取 `closeConversation` 這個函式的函式體（到下一個同縮排層級的宣告為止）
    const body = functionBodyOf(source, 'closeConversation')
    expect(body, 'closeConversation() 的函式體抓不到 —— 守衛會恆真').not.toBe('')
    expect(stripComments(body)).not.toContain('/leave')
  })
})

/**
 * 粗略地取出某個函式的函式體 —— 從名稱出現處起算大括號配對。
 *
 * ⚠️ 這是近似的（不處理字串裡的大括號），對本檔足夠：
 *    誤判方向是「多抓一點」而不是「抓不到」，而多抓只會讓守衛更嚴格。
 *    抓不到時上面那條 `not.toBe('')` 會紅，不會靜默通過。
 */
function functionBodyOf(source: string, name: string): string {
  const at = source.indexOf(name)
  if (at < 0) return ''
  const open = source.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return ''
}
