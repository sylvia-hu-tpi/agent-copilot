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
  <article
    class="ac-card space-y-2 p-3 transition-opacity"
    :style="card.supersededBy ? { opacity: 0.55 } : undefined"
  >
    <!-- 搶答標示（FR-015、US4 AC#2）：同事或 AI 已搶先回覆類似內容 -->
    <p v-if="card.supersededBy" class="flex items-center gap-1.5 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
      <UIcon name="i-lucide-clock-alert" class="size-3.5 shrink-0" />
      {{ t(`copilot.suggestion.supersededBy.${card.supersededBy.kind}`) }}
    </p>

    <div class="flex flex-wrap items-center gap-1.5">
      <span
        class="rounded-full px-2 py-0.5 text-[0.8125rem]"
        :style="toneStyle"
      >
        {{ t(`copilot.suggestion.tone.${card.tone}`) }}
      </span>
      <!-- confidence 為 null 時留空不顯示（FR-002、憲法 4.4）——不得改用估算或替代數字 -->
      <span v-if="card.confidence !== null" class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ t('copilot.suggestion.confidence', { value: card.confidence }) }}
      </span>
    </div>

    <p class="text-[0.9375rem]" :style="{ color: 'var(--text-1)' }">{{ card.text }}</p>

    <p class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
      {{ card.sopTitle ?? t(citation === 'pending' ? 'copilot.suggestion.noKnowledgeRefPending' : 'copilot.suggestion.noKnowledgeRef') }}
    </p>

    <ul v-if="card.requiresData.length > 0" class="list-disc space-y-0.5 pl-4 text-[0.8125rem]" :style="{ color: 'var(--text-2)' }">
      <li v-for="(item, i) in card.requiresData" :key="i">{{ item }}</li>
    </ul>

    <div class="flex justify-end">
      <button
        type="button"
        class="ac-btn-primary h-8 px-3 text-[0.875rem]"
        :aria-label="t('copilot.suggestion.insert')"
        @click="emit('insert', card.text)"
      >
        {{ t('copilot.suggestion.insert') }}
      </button>
    </div>
  </article>
</template>
