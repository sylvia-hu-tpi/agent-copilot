<script setup lang="ts">
/**
 * 建議回覆卡（單張）—— specs/002-suggestion-knowledge-search FR-001～FR-004、FR-018、FR-022。
 *
 * ⚠️ **FR-026**：卡片內容不得逐字串流——與憲法 4.3「顯示前驗證、驗不過整張捨棄」不相容，
 *    串流會讓客服看著讀到一半的卡整張消失。因此本元件永遠接收「已完成驗證」的完整卡片，
 *    不做任何逐字元／逐句的漸進顯示效果。
 * ⚠️ **FR-002／憲法 4.4**：`confidence` 為 `null` 時 MUST 留空不顯示，不得以任何估算或
 *    替代數字頂替——信心度一旦失準，客服很快就會學會忽略它，整個功能即告廢棄。
 * ⚠️ **FR-015、US4 AC#2**：`card.supersededBy` 非 null 代表已被同事或 AI 的後續回覆搶答，
 *    MUST 顯示搶答標示並降級呈現（此處採淡化，不自列表移除——客服仍可能想看內容判斷是否
 *    仍值得參考）。
 */

import type { SuggestionBlock, SuggestionCard } from '#shared/types/copilot'

/**
 * ⚠️ **FR-002（004）**：`sopTitle` 為 null 有兩種語意，MUST 分辨得出來 ——
 *    `citation === 'pending'` 是「尚未引用知識庫」（檢索還沒回來，之後可能會有），
 *    其餘是「未引用知識庫」（已經確定沒有）。少了這個區分，客服會以為第一段的卡
 *    就是最終結論而據此回覆。
 */
const props = defineProps<{ card: SuggestionCard, citation: SuggestionBlock['citation'] }>()
const emit = defineEmits<{ insert: [text: string] }>()

const { t } = useI18n()

const TONE_CLASS: Record<SuggestionCard['tone'], { background: string, color: string }> = {
  apologetic: { background: 'var(--warn-bg)', color: 'var(--warn)' },
  informative: { background: 'var(--surface-3)', color: 'var(--text-2)' },
  retention: { background: 'var(--warn-bg)', color: 'var(--warn)' },
  closing: { background: 'var(--surface-3)', color: 'var(--text-2)' },
  escalating: { background: 'var(--danger-bg, var(--warn-bg))', color: 'var(--danger, var(--warn))' },
}

const toneStyle = computed(() => TONE_CLASS[props.card.tone])
</script>

<template>
  <!--
    畫布 2a 的建議卡是 `--ai` 系的淡紫卡（`--ai-bg` 底、`--ai-bd` 框），不是白底的 `.ac-card` ——
    它與周圍的區塊外殼刻意不同色，因為「這是 AI 生成、需要你判斷」是這張卡最重要的屬性。
  -->
  <article
    class="space-y-[7px] rounded-[10px] border p-2.5 transition-opacity"
    :style="{
      background: 'var(--ai-bg)',
      borderColor: 'var(--ai-bd)',
      ...(card.supersededBy ? { opacity: 0.55 } : {}),
    }"
  >
    <!-- 搶答標示（FR-015、US4 AC#2）：同事或 AI 已搶先回覆類似內容 -->
    <p v-if="card.supersededBy" class="flex items-center gap-1.5 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
      <UIcon name="i-lucide-clock-alert" class="size-3.5 shrink-0" />
      {{ t(`copilot.suggestion.supersededBy.${card.supersededBy.kind}`) }}
    </p>

    <!-- 卡片標頭（畫布 2a）：知識庫來源在左、信心 pill 靠右 -->
    <div class="flex items-start gap-2">
      <!--
        ⚠️ 語氣標籤是**刻意保留的擴充**（D-17）：畫布 2026-08-31 版已把它拿掉，
           但「這句話是致歉還是升級」是客服掃一眼就要判斷的事，且中文比 `apologetic`
           好讀。依語氣上色同樣是刻意擴充。日後核對時不要當成落差「訂正」掉。
      -->
      <span class="shrink-0 rounded-full px-2 py-px text-[0.78125rem]" :style="toneStyle">
        {{ t(`copilot.suggestion.tone.${card.tone}`) }}
      </span>
      <span class="flex min-w-0 items-center gap-1.5">
        <UIcon name="i-lucide-book-open" class="size-3 shrink-0" :style="{ color: 'var(--ai)' }" />
        <span class="truncate text-[0.875rem] font-medium" :style="{ color: 'var(--text)' }">
          {{ card.sopTitle ?? t(citation === 'pending' ? 'copilot.suggestion.noKnowledgeRefPending' : 'copilot.suggestion.noKnowledgeRef') }}
        </span>
      </span>
      <span class="flex-1" />
      <!-- confidence 為 null 時留空不顯示（FR-002、憲法 4.4）——不得改用估算或替代數字 -->
      <span
        v-if="card.confidence !== null"
        class="ac-mono shrink-0 rounded-full border px-2 py-px text-[0.78125rem] font-bold"
        :style="{ color: 'var(--ai)', background: 'var(--surface)', borderColor: 'var(--ai-bd)' }"
      >
        {{ t('copilot.suggestion.confidence', { value: card.confidence }) }}
      </span>
    </div>

    <!-- 建議全文：畫布把它放在白底框裡，與卡片底色分開 —— 這一段是「可以直接送出的字」 -->
    <p
      class="rounded-lg border px-2.5 py-2 text-[0.90625rem] leading-relaxed"
      :style="{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }"
    >{{ card.text }}</p>

    <!--
      推薦理由 —— 畫布逐字是「rationale：」，**刻意改用中文**（D-20，2026-08-31 使用者裁示）。
      與 D-4（區塊標題）、D-17（語氣標籤）同一個方向：面板是給客服看的即時輔助，
      不是給工程師看的欄位名。日後核對時不要當成落差「訂正」回英文。

      ⚠️ 這一行先前完全沒有實作 —— 但它正是客服判斷「這張卡能不能直接送」的依據，
         少了它，信心度就變成唯一線索，而信心度說不出「為什麼」。
    -->
    <p v-if="card.rationale" class="text-[0.84375rem] leading-relaxed" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.suggestion.rationale', { text: card.rationale }) }}
    </p>

    <!--
      需補資料（憲法 4.5：缺的資料 MUST NOT 推測填入）。
      畫布是一條 `--open` 系的提醒列並明說「帶入前請先填寫」，不是一串沒有指示的項目符號 ——
      客服要知道的是「現在還不能直接送」，而不只是「有這幾個欄位」。
    -->
    <div
      v-if="card.requiresData.length > 0"
      class="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[0.84375rem] leading-relaxed"
      :style="{ background: 'var(--open-bg)', color: 'var(--open)' }"
    >
      <UIcon name="i-lucide-clipboard-list" class="mt-0.5 size-3 shrink-0" />
      <span>{{ t('copilot.suggestion.requiresData', { fields: card.requiresData.join('、') }) }}</span>
    </div>

    <div class="flex justify-end">
      <button
        type="button"
        class="ac-btn-primary flex h-7 items-center gap-1.5 px-3 text-[0.875rem]"
        :aria-label="t('copilot.suggestion.insert')"
        @click="emit('insert', card.text)"
      >
        <UIcon name="i-lucide-corner-down-left" class="size-3" />
        {{ t('copilot.suggestion.insert') }}
      </button>
    </div>
  </article>
</template>
