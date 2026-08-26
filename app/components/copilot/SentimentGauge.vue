<script setup lang="ts">
/**
 * 情緒 sparkline —— specs/001-sentiment-panel FR-002、FR-003、FR-009、FR-012、FR-014、FR-015。
 * 手刻 SVG polyline，不引圖表庫（docs/ARCHITECTURE.md §14.5）。
 *
 * ⚠️ 示警（FR-003、憲法 8.1）：MUST 以顏色＋圖示＋文字三者並呈，「挫折」與「生氣」
 *    MUST 可互相區分（不同色票＋不同圖示＋本就不同的標籤文字）。示警判定用
 *    `isSentimentAlerting()`（遲滯規則，見 shared/types/copilot.ts）而非單點判斷，
 *    避免批次中一則語氣稍緩的訊息誤導清除示警。文字標籤加 `aria-live="polite"`。
 *
 * ⚠️ 具體圖示樣式／文案措辭本規格刻意不預先鎖定（spec.md FR-003 2026-08-26 修訂）——
 *    Claude Design 畫布上 `CopilotPanel` 元件（`dc-import` 動態渲染）在本次實作時
 *    無法透過 Artifact 擷取到內部逐字內容（僅能拿到組合頁面的 loader script，
 *    見 docs/DESIGN_TOKENS.md §7.0 已記錄的擷取限制）。這裡的圖示／文案是依規格
 *    的硬性下限（兩級可區分、三者並呈、WCAG AA）做的合理預設，尚未對照畫布原始檔核實。
 */

import type { SentimentBlock, SentimentPoint, SentimentTimelineEntry } from '#shared/types/copilot'
import { isSentimentAlerting } from '#shared/types/copilot'

const props = defineProps<{ block: SentimentBlock }>()
const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()

const MAX_POINTS = 50

/** 從尾端往前取，直到湊滿 MAX_POINTS 個 point，沿途遇到的 marker 一併保留（FR-012、FR-015） */
function recentWindow(timeline: SentimentTimelineEntry[]): SentimentTimelineEntry[] {
  let pointCount = 0
  let startIdx = timeline.length
  for (let i = timeline.length - 1; i >= 0; i--) {
    startIdx = i
    if (timeline[i]!.kind === 'point') pointCount++
    if (pointCount >= MAX_POINTS) break
  }
  return timeline.slice(startIdx)
}

interface Positioned { entry: SentimentTimelineEntry, xPct: number }

const windowEntries = computed(() => recentWindow(props.block.timeline))

const positioned = computed<Positioned[]>(() => {
  const entries = windowEntries.value
  if (entries.length === 0) return []
  return entries.map((entry, i) => ({
    entry,
    xPct: entries.length === 1 ? 50 : (i / (entries.length - 1)) * 100,
  }))
})

const pointsOnly = computed(() =>
  positioned.value.filter((p): p is Positioned & { entry: SentimentPoint } => p.entry.kind === 'point'))

const markersOnly = computed(() => positioned.value.filter(p => p.entry.kind === 'attachment_only'))

/** viewBox 0 0 100 100：score 越高（越正面）在圖上越高，故 y = 100 - score */
const polylinePoints = computed(() =>
  pointsOnly.value.map(p => `${p.xPct},${100 - p.entry.score}`).join(' '))

/** 目前應顯示的示警等級 —— isSentimentAlerting() 的遲滯規則，但需要知道「哪一級」供文字/圖示區分 */
const alertLabel = computed<'frustrated' | 'angry' | null>(() => {
  if (!isSentimentAlerting(props.block.timeline)) return null
  for (let i = props.block.timeline.length - 1; i >= 0; i--) {
    const e = props.block.timeline[i]!
    if (e.kind !== 'point') continue
    if (e.label === 'frustrated' || e.label === 'angry') return e.label
    if (e.label === 'calm' || e.label === 'neutral') return null
  }
  return null
})

const alertColor = computed(() => (alertLabel.value === 'angry' ? 'var(--danger)' : 'var(--warn)'))
const strokeColor = computed(() => (alertLabel.value ? alertColor.value : 'var(--navy-2)'))

const hasContent = computed(() => props.block.timeline.length > 0)

const statusText = computed(() => {
  switch (props.block.status) {
    case 'analyzing':
      return hasContent.value ? t('copilot.sentiment.updating') : t('copilot.sentiment.analyzing')
    case 'retrying':
      return t('copilot.sentiment.retrying', { attempt: props.block.retryAttempt ?? 1 })
    case 'error':
      return t('copilot.sentiment.error')
    default:
      return null
  }
})

const statusColor = computed(() => (props.block.status === 'error' || props.block.status === 'retrying' ? 'var(--warn)' : 'var(--text-3)'))
</script>

<template>
  <section class="ac-card p-4">
    <div class="flex items-center justify-between gap-2">
      <h2 class="ac-status-label">{{ t('copilot.sentiment.title') }}</h2>
      <div class="flex items-center gap-2">
        <span v-if="statusText" class="text-[0.8125rem]" :style="{ color: statusColor }">
          {{ statusText }}
        </span>
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

    <!-- 示警：顏色＋圖示＋文字三者並呈（FR-003、憲法 8.1），frustrated／angry 可互相區分 -->
    <p
      v-if="alertLabel"
      class="mt-2 flex items-center gap-1.5 text-[0.90625rem] font-medium"
      :style="{ color: alertColor }"
      aria-live="polite"
    >
      <UIcon :name="alertLabel === 'angry' ? 'i-lucide-flame' : 'i-lucide-alert-triangle'" class="size-4 shrink-0" />
      <span>{{ t(`copilot.sentiment.alert.${alertLabel}`) }}</span>
    </p>

    <!-- empty：尚無可分析內容（FR-009） -->
    <p v-if="block.status === 'empty'" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.sentiment.empty') }}
    </p>

    <!-- 首次 analyzing，尚無任何舊內容可疊加 -->
    <div v-else-if="!hasContent && block.status === 'analyzing'" class="mt-3">
      <div class="ac-skel ac-skel-shimmer h-16 w-full" />
    </div>

    <!-- 從未成功過的 error：無內容可顯示 -->
    <p
      v-else-if="!hasContent && block.status === 'error'"
      class="ac-alert-warn mt-3 flex items-start gap-2 px-3 py-2"
    >
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.sentiment.error') }}</span>
    </p>

    <!-- ready／retrying／analyzing(保留舊內容)／error(曾成功過，仍顯示上次內容) -->
    <div v-else-if="hasContent" class="mt-3">
      <div class="relative h-16 w-full">
        <svg
          class="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polyline
            v-if="pointsOnly.length > 1"
            :points="polylinePoints"
            fill="none"
            :stroke="strokeColor"
            stroke-width="2"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
            class="transition-all duration-300"
          />
        </svg>

        <!-- 純附件輪：不參與折線，僅在時間軸上以中性圖示標記（FR-012） -->
        <span
          v-for="(m, i) in markersOnly"
          :key="i"
          class="absolute bottom-0 flex size-4 -translate-x-1/2 items-center justify-center rounded-full"
          :style="{ left: `${m.xPct}%`, background: 'var(--surface-3)', color: 'var(--text-3)' }"
          :title="t('copilot.sentiment.attachmentMarker')"
        >
          <UIcon name="i-lucide-paperclip" class="size-2.5" />
        </span>
      </div>

      <p v-if="block.status === 'error'" class="ac-alert-warn mt-2 flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ t('copilot.sentiment.error') }}</span>
      </p>
    </div>
  </section>
</template>
