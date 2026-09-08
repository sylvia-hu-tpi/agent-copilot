/**
 * 結案草稿的「相關的知識庫來源」清單 —— `toCitedSops()`（契約 R2.7）。
 *
 * ⚠️ **這一組守的是一個不會報錯的形狀。** 原本的寫法是
 *    `citedSopIds: knowledgeHits.map(h => h.id)`：型別對、測試綠、畫面渲染得出來，
 *    只是同一份文件命中兩段時，清單裡就有兩顆一模一樣的 chip、`v-for` 的 `:key` 重複、
 *    按一次 `×` 兩顆一起消失、Board 的 `cited_sops` 寫進重複 id。
 *    Vue 對重複 key 只在 console 警告，四個症狀沒有一個會讓測試變紅。
 */

import { describe, expect, it } from 'vitest'
import type { KnowledgeHit } from '../shared/types/knowledge'
import { toCitedSops } from '../server/services/closure/cited-sops'

function hit(id: string, title: string, snippet = '片段'): KnowledgeHit {
  return { id, title, snippet, score: null, updatedAt: null, sourceRef: { type: 'knowledge', ref: id } }
}

describe('命中 → 來源清單', () => {
  it('帶出 title —— 畫面要顯示的是檔名，不是檔案 id', () => {
    expect(toCitedSops([hit('f_1', '金融大樓電梯困人SOP')]))
      .toEqual([{ id: 'f_1', title: '金融大樓電梯困人SOP' }])
  })

  it('同一份文件命中多段 → 只留一筆', () => {
    const out = toCitedSops([
      hit('f_1', '金融大樓電梯困人SOP', '第一段'),
      hit('f_1', '金融大樓電梯困人SOP', '第二段'),
      hit('f_2', '金融大樓管理辦法'),
    ])
    expect(out).toEqual([
      { id: 'f_1', title: '金融大樓電梯困人SOP' },
      { id: 'f_2', title: '金融大樓管理辦法' },
    ])
  })

  /**
   * ⚠️ 順序是檢索的相關性順序 —— 去重 MUST 保留**第一次出現**的位置。
   *    用 `Map` 反覆覆寫再取值也去得掉重複，但會把重複那筆推到後面出現的位置上。
   */
  it('去重保留第一次出現的順序', () => {
    const out = toCitedSops([hit('f_1', 'A'), hit('f_2', 'B'), hit('f_1', 'A')])
    expect(out.map(s => s.id)).toEqual(['f_1', 'f_2'])
  })

  /**
   * `folder_info` 比對不到檔名時，`AgentKnowledgeProvider` 以檔名雜湊出
   * `knowledge-fallback-*` 的容錯 id。那筆命中是真的、title 也可讀，
   * MUST NOT 因為 id 不漂亮就丟掉 —— 丟掉等於不告訴客服有這份文件。
   */
  it('容錯 id 的命中照樣保留', () => {
    expect(toCitedSops([hit('knowledge-fallback-1a2b3c', '客訴處理原則')]))
      .toEqual([{ id: 'knowledge-fallback-1a2b3c', title: '客訴處理原則' }])
  })

  it('沒有命中 → 空陣列（面板整塊不顯示）', () => {
    expect(toCitedSops([])).toEqual([])
  })
})
