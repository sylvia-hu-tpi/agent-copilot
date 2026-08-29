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

/**
 * 區塊 tag（畫布 2a：「近 5 輪」）。
 * ⚠️ 數字是**實際的評分點數**，不是寫死的 5 —— 冷啟動或剛開始的對話會少於 5 點，
 *    顯示「近 5 輪」而實際只有 2 點就是在謊報樣本量。沒有資料時不顯示 tag。
 */
const roundsTag = computed(() => (
  props.block.timeline.length ? t('copilot.sentiment.rounds', { n: props.block.timeline.length }) : null
))

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

/**
 * 「有資料，但畫不出折線」—— 恰好一個評分點時的狀態（2026-08-28 真實環境發現）。
 *
 * ⚠️ `hasContent`（`timeline.length > 0`）決定要不要渲染內容區，折線卻要
 *    `pointsOnly.length > 1`。兩者不一致時會走進繪圖分支卻畫不出任何東西，
 *    呈現一個 64px 高、沒有數字也沒有文字的空白框——三個文字分支
 *    （`empty`／`analyzing`／`error`）都已經被 `hasContent` 跳過了。
 *    自動恢復後特別容易發生：`runIncremental()` 只補新訊息的點，先前失敗那批不補算。
 */
const singlePoint = computed(() => (pointsOnly.value.length === 1 ? pointsOnly.value[0]! : null))

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
  <CopilotBlockShell :title="t('copilot.sentiment.title')" :tag="roundsTag">
    <template #actions>
      <span v-if="statusText" class="shrink-0 text-[0.8125rem]" :style="{ color: statusColor }">
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

        <!-- 恰好一個評分點：畫不出折線，但那個分數本身仍是資訊，以圓點呈現而非留白 -->
        <span
          v-if="singlePoint"
          class="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          :style="{
            left: `${singlePoint.xPct}%`,
            top: `${100 - singlePoint.entry.score}%`,
            background: strokeColor,
          }"
          :title="t(`copilot.sentiment.label.${singlePoint.entry.label}`)"
        />

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

      <!-- ⚠️ 沒有這一行，恰好一個評分點時整個區塊就只是一個沒有任何說明的空白框 -->
      <p v-if="singlePoint" class="mt-2 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ t('copilot.sentiment.singlePoint') }}
      </p>

      <p v-if="block.status === 'error'" class="ac-alert-warn mt-2 flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ t('copilot.sentiment.error') }}</span>
      </p>
    </div>
  </CopilotBlockShell>
</template>
