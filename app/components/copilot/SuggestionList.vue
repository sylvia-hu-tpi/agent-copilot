<script setup lang="ts">
/**
 * 建議卡清單（區塊層級狀態機）—— specs/002-suggestion-knowledge-search FR-014、FR-015、FR-024。
 *
 * 四種可互相區分的狀態：
 *   - `empty`                        → 「尚無資料」（FR-014）
 *   - `analyzing`／`retrying`        → 「產生中」／「重試中 (n/2)」
 *   - `ready` 且 `cards.length === 0` → 「本次未產生建議」（中性，非錯誤）
 *   - `error`                        → 「暫時無法產生建議」＋重試按鈕
 *
 * `ready && cards.length === 0` 底下有兩種語意（`knowledgeSearch.hitCount === 0` = 知識庫
 * 沒這題／`> 0` = 有命中但引用全遭白名單捨棄）：對客服的呈現一致（都是中性空狀態），
 * 但後者是模型杜撰引用的訊號，MUST 分別記錄供事後稽核（data-model.md §7）。
 *
 * ⚠️ **FR-024**：`ready` 狀態下 MUST NOT 出現任何一般性的「重新產生」按鈕；重試按鈕只在
 *    `error` 狀態可用。快取鍵（§11.3）是 `{conversationId}:{lastMessageId}`，同一狀態不會
 *    產生不同結果——任何「重新產生」都只是給出系統做不到的承諾。
 */

import type { SuggestionBlock } from '#shared/types/copilot'

const props = defineProps<{ block: SuggestionBlock }>()
const emit = defineEmits<{ retry: [], insert: [text: string] }>()

const { t } = useI18n()

const statusText = computed(() => {
  switch (props.block.status) {
    case 'analyzing':
      return t('copilot.suggestion.analyzing')
    case 'retrying':
      return t('copilot.suggestion.retrying', { attempt: props.block.retryAttempt ?? 1 })
    case 'error':
      return t('copilot.suggestion.error')
    default:
      return null
  }
})

const readyEmpty = computed(() => props.block.status === 'ready' && props.block.cards.length === 0)
</script>

<template>
  <section class="ac-card p-4">
    <div class="flex items-center justify-between gap-2">
      <h2 class="ac-status-label">{{ t('copilot.suggestion.title') }}</h2>
      <div class="flex items-center gap-2">
        <span v-if="statusText" class="text-[0.8125rem]" :style="{ color: block.status === 'error' ? 'var(--warn)' : 'var(--text-3)' }">
          {{ statusText }}
        </span>
        <!-- FR-024：重試按鈕只在 error 狀態可用，非一般性的「重新產生」 -->
        <button
          type="button"
          class="rounded-md p-1 transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          :style="{ color: 'var(--text-3)' }"
          :disabled="block.status !== 'error'"
          :aria-label="t('copilot.retry')"
          :title="t('copilot.retry')"
          @click="emit('retry')"
        >
          <UIcon name="i-lucide-rotate-cw" class="size-4" />
        </button>
      </div>
    </div>

    <!-- empty：尚無資料（FR-014） -->
    <p v-if="block.status === 'empty'" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.suggestion.empty') }}
    </p>

    <!-- 首次 analyzing／retrying，尚無任何卡片可疊加 -->
    <div v-else-if="block.cards.length === 0 && (block.status === 'analyzing' || block.status === 'retrying')" class="mt-3 space-y-2">
      <div class="ac-skel ac-skel-shimmer h-16 w-full" />
    </div>

    <!-- 從未成功過的 error：無卡片可顯示 -->
    <p v-else-if="block.cards.length === 0 && block.status === 'error'" class="ac-alert-warn mt-3 flex items-start gap-2 px-3 py-2">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.suggestion.error') }}</span>
    </p>

    <!-- ready 且 cards.length === 0：本次未產生建議（中性，非錯誤） -->
    <p v-else-if="readyEmpty" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.suggestion.readyEmpty') }}
    </p>

    <!-- 有卡片：ready／retrying(保留舊卡)／error(曾成功過，仍顯示上次卡片) -->
    <div v-else class="mt-3 max-h-120 space-y-2 overflow-y-auto">
      <CopilotSuggestionCard
        v-for="card in block.cards"
        :key="card.id"
        :card="card"
        @insert="emit('insert', $event)"
      />
    </div>
  </section>
</template>
