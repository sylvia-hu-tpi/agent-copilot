<script setup lang="ts">
/**
 * 摘要卡 —— specs/001-sentiment-panel FR-001、FR-006、FR-009、FR-011、FR-014。
 *
 * 五態呈現（`AnalysisBlockStatus`，憲法 8.1 擴大適用至所有狀態資訊）：
 * empty／analyzing／retrying／ready／error，彼此視覺上可區分。
 *
 * ⚠️ `ready → analyzing`（增量重新分析）期間 MUST 保留舊內容疊加「更新中」提示，
 *    不得清空重回骨架屏（data-model.md「呈現規則」）。
 * ⚠️ 重試按鈕（憲法 8.2 可鍵盤操作）MUST 維持可見但停用，非 error 狀態時 disabled
 *    （2026-08-26 定案 CHK033），不額外加冷卻節流（既有 409 已足夠防重疊，CHK032）。
 */

import type { SummaryBlock } from '#shared/types/copilot'

const props = defineProps<{ block: SummaryBlock }>()
const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()

const RISK_FLAG_TONE = { background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)', color: 'var(--warn)' }

const hasContent = computed(() => props.block.summary !== null)

const statusText = computed(() => {
  switch (props.block.status) {
    case 'analyzing':
      return hasContent.value ? t('copilot.summary.updating') : t('copilot.summary.analyzing')
    case 'retrying':
      return t('copilot.summary.retrying', { attempt: props.block.retryAttempt ?? 1 })
    case 'error':
      return t('copilot.summary.error')
    default:
      return null
  }
})

const statusColor = computed(() => {
  if (props.block.status === 'error') return 'var(--warn)'
  if (props.block.status === 'retrying') return 'var(--warn)'
  return 'var(--text-3)'
})
</script>

<template>
  <CopilotBlockShell :title="t('copilot.summary.title')">
    <template #actions>
      <span
        v-if="statusText"
        class="shrink-0 text-[0.8125rem]"
        :style="{ color: statusColor }"
        :aria-live="block.status === 'error' ? 'polite' : undefined"
      >
        {{ statusText }}
      </span>
      <button
        type="button"
        class="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
        :style="{ color: 'var(--text-3)' }"
        :disabled="block.status !== 'error'"
        :aria-label="t('copilot.retry')"
        :title="t('copilot.retry')"
        @click="emit('retry')"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" />
      </button>
    </template>

    <!-- empty：尚無可分析內容（FR-009），與 error／loading 視覺上可區分 -->
    <p v-if="block.status === 'empty'" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.summary.empty') }}
    </p>

    <!-- 首次 analyzing，尚無任何舊內容可疊加 -->
    <div v-else-if="!hasContent && block.status === 'analyzing'" class="mt-3 space-y-2">
      <div class="ac-skel ac-skel-shimmer h-3 w-3/4" />
      <div class="ac-skel ac-skel-shimmer h-3 w-1/2" />
      <div class="ac-skel ac-skel-shimmer h-3 w-5/6" />
    </div>

    <!-- 從未成功過的 error：無內容可顯示 -->
    <p
      v-else-if="!hasContent && block.status === 'error'"
      class="ac-alert-warn mt-3 flex items-start gap-2 px-3 py-2"
    >
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.summary.error') }}</span>
    </p>

    <!-- ready／retrying／analyzing(保留舊內容)／error(曾成功過，仍顯示上次內容) -->
    <div v-else-if="block.summary" class="mt-3 space-y-3 text-[0.9375rem]">
      <div>
        <h3 class="ac-label">{{ t('copilot.summary.intent') }}</h3>
        <p>{{ block.summary.intent }}</p>
      </div>

      <div v-if="block.summary.riskFlags.length > 0" class="flex flex-wrap gap-1.5">
        <span
          v-for="flag in block.summary.riskFlags"
          :key="flag"
          class="rounded-full border px-2 py-0.5 text-[0.8125rem]"
          :style="RISK_FLAG_TONE"
        >
          {{ t(`copilot.summary.riskFlags.${flag}`) }}
        </span>
      </div>

      <div v-if="block.summary.keyFacts.length > 0">
        <h3 class="ac-label">{{ t('copilot.summary.keyFacts') }}</h3>
        <ul class="list-disc space-y-0.5 pl-4">
          <li v-for="(fact, i) in block.summary.keyFacts" :key="i">{{ fact }}</li>
        </ul>
      </div>

      <div v-if="block.summary.attempted.length > 0">
        <h3 class="ac-label">{{ t('copilot.summary.attempted') }}</h3>
        <ul class="list-disc space-y-0.5 pl-4">
          <li v-for="(item, i) in block.summary.attempted" :key="i">{{ item }}</li>
        </ul>
      </div>

      <div v-if="block.summary.openIssues.length > 0">
        <h3 class="ac-label">{{ t('copilot.summary.openIssues') }}</h3>
        <ul class="list-disc space-y-0.5 pl-4">
          <li v-for="(issue, i) in block.summary.openIssues" :key="i">{{ issue }}</li>
        </ul>
      </div>

      <div>
        <h3 class="ac-label">{{ t('copilot.summary.advice') }}</h3>
        <p>{{ block.summary.advice }}</p>
      </div>

      <p v-if="block.status === 'error'" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ t('copilot.summary.error') }}</span>
      </p>
    </div>
  </CopilotBlockShell>
</template>
