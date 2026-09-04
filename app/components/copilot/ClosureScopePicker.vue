<script setup lang="ts">
/**
 * 涵蓋範圍選擇器（畫布 2b、`docs/DESIGN_TOKENS.md` §7.5、FR-021 系列）。
 *
 * **它在回答什麼**：同一個聊天室長期存在、可能被結案多次，系統無法判斷
 * 「本次結案從哪算起」，因此由客服選。這個選擇決定 AI 讀哪些訊息。
 *
 * ⚠️ **選錯區間不會有任何錯誤提示** —— 摘要看起來一樣完整，只是涵蓋了錯的那一段。
 *    「本次摘要涵蓋 {t} 起 · {n} 則」那一行因此**不可省**（FR-021f）：
 *    它是事後唯一的憑據。
 *
 * ⚠️ **0 則的候選不可選，而且不只靠顏色表達**（憲法 8.1）：
 *    `--surface-3` 底 ＋ `circle-slash-2` icon ＋ `cursor:not-allowed` ＋ `tabIndex:-1`
 *    ＋ handler 內另有一道 `if (n === 0) return`。
 *    ⚠️ 不可選 ≠ 不顯示 —— 客服要看得到「上次結到這裡」。
 *
 * ⚠️ **`messageCount === null` 是「超過 500 則」，不是 0 則**，因此**可選**，
 *    而且通常正是長期客戶要的那一個。把 null 當 0 會讓那些對話完全結不了案，
 *    畫面上只會顯示一個灰掉的選項。
 */

import type { ClosurePeriodOrigin } from '#shared/types/copilot'
import type { ClosureScopeCandidate, ClosureScopes } from '~/stores/closure'

const props = withDefaults(defineProps<{
  scopes: ClosureScopes
  selected: { periodStart: string, periodOrigin: ClosurePeriodOrigin } | null
  /** 畫布的三種呈現風格；預設 `row`（可點開的摘要列） */
  state?: 'quiet' | 'row' | 'list'
  /** `regen`：改了選擇、正在重新產生 */
  regenerating?: boolean
}>(), { state: 'row', regenerating: false })

const emit = defineEmits<{ pick: [start: string, origin: ClosurePeriodOrigin] }>()

const { t, locale } = useI18n()

/** 則數 > 150 轉 `--warn` 色 —— 讓客服在選之前就看得出份量 */
const HEAVY = 150

/**
 * 三種需要**自動展開**的狀態（畫布 `autoOpen`）——
 * 它們的共同點是「有一件事客服不看見就會選錯」，因此不能藏在收合列裡。
 */
const autoState = computed<'never' | 'overflow' | 'zeroTop' | null>(() => {
  const s = props.scopes
  if (s.candidates.length === 0) return 'never'
  if (s.overflowCount > 0) return 'overflow'
  if (s.candidates[0]?.messageCount === 0) return 'zeroTop'
  return null
})

const open = ref(props.state === 'list' || autoState.value !== null)
const showCustom = ref(false)

const selectable = (c: ClosureScopeCandidate): boolean => c.messageCount !== 0

function pick(c: ClosureScopeCandidate): void {
  // ⚠️ 第二道防線：`disabled` 之外 handler 內也擋（畫布逐字的 `if (n === 0) return`）
  if (!selectable(c)) return
  emit('pick', c.start, c.origin)
}

function isSelected(c: ClosureScopeCandidate): boolean {
  return props.selected?.periodStart === c.start && props.selected?.periodOrigin === c.origin
}

const fmtTime = (iso: string): string =>
  new Intl.DateTimeFormat(locale.value, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))

const fmtDate = (iso: string): string =>
  new Intl.DateTimeFormat(locale.value, {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))

/** 一列的「{t} 起 · {n} 則」；數不完時逐字為「超過 500 則」 */
function countText(c: ClosureScopeCandidate): string {
  if (c.messageCount === null) return t('closure.scope.rowTruncated')
  return t('closure.scope.row', { t: fmtTime(c.start), n: c.messageCount })
}

function labelText(c: ClosureScopeCandidate): string {
  if (c.origin === 'first') return t('closure.scope.fallbackLabel', { date: fmtDate(c.start) })
  if (c.origin === 'custom') return t('closure.scope.customLabel')
  return t('closure.scope.closureLabel', {
    category: c.label?.category ?? '',
    name: c.label?.reviewedByName ?? '',
  })
}

/** ⚠️ 這一行不可省（FR-021f） */
const coverage = computed(() => {
  const cur = current.value
  if (!cur) return ''
  return cur.messageCount === null
    ? t('closure.scope.coverageTruncated', { t: fmtTime(cur.start) })
    : t('closure.scope.coverage', { t: fmtTime(cur.start), n: cur.messageCount })
})

/** 目前選中的那一列（可能是 fallback，也可能是自訂 —— 自訂不在清單裡） */
const current = computed<ClosureScopeCandidate | null>(() => {
  if (!props.selected) return null
  const all = [...props.scopes.candidates, props.scopes.fallback]
  const hit = all.find(c => c.start === props.selected!.periodStart
    && c.origin === props.selected!.periodOrigin)
  if (hit) return hit
  // 自訂起算 —— 則數要等草稿回來才知道，這裡先以 null 表示「尚未確定」
  return {
    start: props.selected.periodStart,
    origin: props.selected.periodOrigin,
    messageCount: null,
    truncated: false,
  }
})

const customLabel = computed(() =>
  props.selected?.periodOrigin === 'custom'
    ? t('closure.custom.applied', { t: fmtTime(props.selected.periodStart) })
    : t('closure.custom.unused'))

function applyCustom(isoStart: string): void {
  showCustom.value = false
  emit('pick', isoStart, 'custom')
}
</script>

<template>
  <section
    class="rounded-lg border"
    :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)' }"
  >
    <!-- 標題／摘要列：憲法 8.2 逐字規格 —— role="button" ＋ tabIndex ＋ aria-expanded -->
    <div
      role="button"
      :tabindex="0"
      :aria-expanded="open"
      class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-offset-[-2px] focus-visible:bg-[var(--surface-3)]"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
    >
      <UIcon name="i-lucide-calendar-clock" class="size-3.5 shrink-0" :style="{ color: 'var(--text-3)' }" />
      <span class="shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ $t('closure.scope.label') }}
      </span>
      <span class="ac-mono min-w-0 flex-1 truncate text-[0.8438rem]">
        {{ current ? countText(current) : '—' }}
      </span>
      <UIcon
        :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        class="size-3.5 shrink-0"
        :style="{ color: 'var(--text-3)' }"
      />
    </div>

    <!-- ⚠️ 唯讀涵蓋說明：不可省（FR-021f），且不隨展開／收合消失 -->
    <p class="px-3 pb-2 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
      {{ coverage }}
    </p>

    <div v-if="open" class="border-t px-3 py-2" :style="{ borderColor: 'var(--border)' }">
      <p v-if="state === 'list'" class="mb-1 text-[0.9063rem] font-medium">
        {{ $t('closure.scope.title') }}
      </p>
      <p v-if="state === 'list'" class="mb-2 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ $t('closure.scope.subtitle') }}
      </p>

      <!-- 三種需要客服看見的狀態 —— 自動展開並直說 -->
      <p
        v-if="autoState"
        class="mb-2 rounded px-2 py-1.5 text-[0.8125rem] leading-relaxed"
        :style="{ background: 'var(--surface-3)', color: 'var(--text-2)' }"
      >
        <template v-if="autoState === 'never'">{{ $t('closure.scope.never') }}</template>
        <template v-else-if="autoState === 'overflow'">
          {{ $t('closure.scope.overflow', { n: scopes.overflowCount }) }}
        </template>
        <template v-else>{{ $t('closure.scope.zeroTop') }}</template>
      </p>

      <p
        v-if="regenerating && current"
        class="mb-2 text-[0.8125rem]"
        :style="{ color: 'var(--text-3)' }"
      >
        {{ $t('closure.scope.regen', {
          t: fmtTime(current.start),
          n: current.messageCount === null ? $t('closure.scope.rowTruncated') : current.messageCount,
        }) }}
      </p>

      <ul class="flex flex-col gap-1">
        <!-- 候選：時間降冪（由 server 排好，這裡不再排一次） -->
        <li v-for="c in scopes.candidates" :key="`${c.origin}:${c.start}`">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left"
            :class="selectable(c) ? '' : 'cursor-not-allowed'"
            :disabled="!selectable(c)"
            :tabindex="selectable(c) ? 0 : -1"
            :title="selectable(c) ? undefined : $t('closure.scope.unselectable')"
            :style="{
              borderColor: isSelected(c) ? 'var(--navy)' : 'var(--border)',
              background: !selectable(c)
                ? 'var(--surface-3)'
                : isSelected(c) ? 'var(--navy-soft)' : 'var(--surface)',
            }"
            @click="pick(c)"
          >
            <UIcon
              :name="!selectable(c)
                ? 'i-lucide-circle-slash-2'
                : isSelected(c) ? 'i-lucide-circle-dot' : 'i-lucide-circle'"
              class="size-3.5 shrink-0"
              :style="{ color: selectable(c) ? 'var(--text-3)' : 'var(--text-3)' }"
            />
            <span
              class="ac-mono shrink-0 text-[0.8438rem]"
              :style="{
                color: (c.messageCount ?? Number.POSITIVE_INFINITY) > HEAVY
                  ? 'var(--warn)'
                  : 'var(--text)',
              }"
            >{{ countText(c) }}</span>
            <span class="min-w-0 flex-1 truncate text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
              {{ labelText(c) }}
            </span>
          </button>
        </li>

        <!-- ⚠️ 安全網永遠墊底、永遠存在；未選中時虛線框（畫布逐字） -->
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
            :style="{
              border: isSelected(scopes.fallback)
                ? '1px solid var(--navy)'
                : '1px dashed var(--border-dash)',
              background: isSelected(scopes.fallback) ? 'var(--navy-soft)' : 'var(--surface)',
            }"
            @click="pick(scopes.fallback)"
          >
            <UIcon
              :name="isSelected(scopes.fallback) ? 'i-lucide-circle-dot' : 'i-lucide-circle'"
              class="size-3.5 shrink-0"
              :style="{ color: 'var(--text-3)' }"
            />
            <span
              class="ac-mono shrink-0 text-[0.8438rem]"
              :style="{
                color: (scopes.fallback.messageCount ?? Number.POSITIVE_INFINITY) > HEAVY
                  ? 'var(--warn)'
                  : 'var(--text)',
              }"
            >{{ countText(scopes.fallback) }}</span>
            <span class="min-w-0 flex-1 truncate text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
              {{ labelText(scopes.fallback) }}
            </span>
          </button>
        </li>
      </ul>

      <!-- ⚠️ 自訂起算時間的入口在**任何狀態**都可用（FR-021e-1） -->
      <div class="mt-2 flex items-center gap-2">
        <UButton size="xs" color="neutral" variant="ghost" @click="showCustom = !showCustom">
          {{ $t('closure.custom.entry') }}
        </UButton>
        <span
          class="text-[0.8125rem]"
          :style="{ color: selected?.periodOrigin === 'custom' ? 'var(--navy-2)' : 'var(--text-3)' }"
        >{{ customLabel }}</span>
      </div>

      <CopilotClosureCustomStart
        v-if="showCustom"
        class="mt-2"
        :min="scopes.firstMessageAt"
        :max="new Date().toISOString()"
        @apply="applyCustom"
        @close="showCustom = false"
      />
    </div>
  </section>
</template>
