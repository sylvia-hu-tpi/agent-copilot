<script setup lang="ts">
/**
 * Copilot 面板的標題列 —— specs/003-analysis-trigger-policy FR-017、FR-018、FR-019。
 *
 * 兩個動作：收合／展開（純視覺，FR-017b）與「全部重試」（對每個 error 區塊各發一次
 * 既有的單區塊重試端點，契約 1.2 —— **MUST NOT** 新增 retry-all 端點）。
 *
 * ⚠️ 憲法 8.1：不可按狀態 MUST 同時以 `disabled`／`aria-disabled` 表達，
 *    MUST NOT 只靠降低對比度 —— 顏色不是給每個人都讀得到的資訊。
 * ⚠️ 憲法 8.2：兩個按鈕都是原生 `<button>`，因此天生可 Tab 聚焦、可 Enter／Space 觸發。
 */

const props = defineProps<{
  collapsed: boolean
  /** 三個區塊之中有沒有處於 error 的 —— 「全部重試」的可按條件（FR-019） */
  hasError: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'retry-all'): void
}>()

const { t } = useI18n()

const toggleLabel = computed(() => (props.collapsed ? t('copilot.expand') : t('copilot.collapse')))

/**
 * ⚠️ **刻意不做樂觀 disable**（research.md 決策 7）：往返期間按鈕仍可按是**預期行為**，
 *    面板狀態一律由伺服器推播驅動。重複按下由 FR-009 的同區塊併發去重吸收，
 *    不會跑出兩份分析。
 */
const retryAllTitle = computed(() => (props.hasError ? t('copilot.retryAll') : t('copilot.retryAllNone')))
</script>

<template>
  <header class="flex items-center justify-between gap-2">
    <h2 class="ac-status-label">{{ t('copilot.panelTitle') }}</h2>

    <div class="flex items-center gap-1">
      <button
        type="button"
        class="rounded-md px-2 py-1 text-[0.8125rem] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
        :style="{ color: 'var(--text-3)' }"
        :disabled="!hasError"
        :aria-disabled="!hasError"
        :title="retryAllTitle"
        @click="emit('retry-all')"
      >
        {{ t('copilot.retryAll') }}
      </button>

      <button
        type="button"
        class="rounded-md p-1 transition-opacity hover:opacity-70"
        :style="{ color: 'var(--text-3)' }"
        :aria-label="toggleLabel"
        :aria-expanded="!collapsed"
        :title="toggleLabel"
        @click="emit('toggle')"
      >
        <UIcon :name="collapsed ? 'i-lucide-panel-right-open' : 'i-lucide-panel-right-close'" class="size-4" />
      </button>
    </div>
  </header>
</template>
