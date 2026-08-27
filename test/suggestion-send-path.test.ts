/**
 * 建議卡「一鍵帶入」與知識庫快查「插入為回覆」不得繞過既有撞單檢查 —— SC-004、FR-006、憲法 7.2／3.3①。
 *
 * 兩條路徑（`SuggestionCard.vue` 的 `insert` 事件、`KnowledgeSearch.vue` 的「插入為回覆」）
 * 共用同一個 `useOverwriteConfirm()` 實例，最終都只是把文字寫進同一個 `draft.text` ref——
 * 與客服手動打字寫入的是同一個欄位、同一個 API。下游的 `view.send(text, force)` 只接受
 * 一個純字串參數，看不出這段文字是怎麼進來的，因此不存在「suggestion 來源」可以另闢蹊徑
 * 略過 `baseMessageId` 版本錨點或撞單檢查的空間。
 *
 */

import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useOverwriteConfirm } from '../app/composables/useOverwriteConfirm.js'

describe('一鍵帶入／插入為回覆與手動輸入寫入同一個草稿欄位（SC-004）', () => {
  it('草稿為空白時，insert 直接寫入 draft.text——與手動輸入 `draft.text.value = 文字` 完全相同', () => {
    const draftText = ref('')
    const onApply = vi.fn((text: string) => { draftText.value = text })
    const overwrite = useOverwriteConfirm(draftText, onApply)

    // 模擬 SuggestionCard.vue 的 @insert="overwriteConfirm.request($event)"
    overwrite.request('建議卡回覆全文')

    expect(draftText.value).toBe('建議卡回覆全文')
    expect(overwrite.pending.value).toBeNull()
    // 手動輸入會做的事，一模一樣：直接寫入同一個 ref，沒有任何額外欄位或旗標
    draftText.value = '客服手動輸入的內容'
    expect(draftText.value).toBe('客服手動輸入的內容')
  })

  it('草稿非空白時，insert 與插入為回覆皆須先確認才寫入，不繞過（FR-018）', () => {
    const draftText = ref('客服正在打的字')
    const onApply = vi.fn((text: string) => { draftText.value = text })
    const overwrite = useOverwriteConfirm(draftText, onApply)

    // 模擬 KnowledgeSearch.vue 的「插入為回覆」（hit.snippet，US2）
    overwrite.request('知識庫命中的片段原文')
    expect(draftText.value).toBe('客服正在打的字') // 尚未套用，等待確認
    expect(overwrite.pending.value).toBe('知識庫命中的片段原文')

    overwrite.confirm()
    expect(draftText.value).toBe('知識庫命中的片段原文')
    expect(overwrite.pending.value).toBeNull()
  })

  it('取消覆蓋時草稿維持原內容不變，insert 的文字不會偷偷生效', () => {
    const draftText = ref('原本的草稿')
    const overwrite = useOverwriteConfirm(draftText, (text) => { draftText.value = text })

    overwrite.request('建議卡文字')
    overwrite.cancel()

    expect(draftText.value).toBe('原本的草稿')
    expect(overwrite.pending.value).toBeNull()
  })

  it('onApply 只接受純字串——介面上不存在可攜帶「來源」或「略過檢查」旗標的參數', () => {
    const draftText = ref('')
    const onApply = vi.fn((text: string) => { draftText.value = text })
    const overwrite = useOverwriteConfirm(draftText, onApply)

    overwrite.request('任意文字')

    expect(onApply).toHaveBeenCalledWith('任意文字')
    expect(onApply.mock.calls[0]).toHaveLength(1) // 唯一參數就是文字本身
  })
})
