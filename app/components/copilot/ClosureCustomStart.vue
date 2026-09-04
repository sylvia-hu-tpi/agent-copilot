<script setup lang="ts">
/**
 * 自訂起算時間的彈窗（`docs/DESIGN_TOKENS.md` §7.5「自訂起算時間」、FR-021e-1）。
 *
 * ⚠️ **不限於「從未結案」狀態，任何時候都可用。** 客服可能只想涵蓋某一段，
 *    而那一段的起點不一定對應任何一次結案。
 *
 * ⚠️ 產出的區間 `origin` 是 `'custom'`，label 逐字為「自訂起算時間（非結案起點）」——
 *    誠實標示它不對應任何真實的結案事件。光靠 `start` 這個時間戳事後分不出來，
 *    而「客服選了某次結案」與「客服自己打了一個時間」是完全不同的兩件事。
 *
 * ⛔ **畫布的「約 N 則」預估在本規格不實作**（`docs/DESIGN_FEEDBACK.md` D-4）：
 *    它需要額外一次訊息掃描，而套用之後真正的則數會由 `draft.period.messageCount`
 *    呈現。與其顯示一個可能與最終結果不同的估算，不如不顯示。
 *
 * ⚠️ 憲法 8.2：`role="dialog"` ＋ `aria-label` ＋ Esc 關閉 ＋ 超出範圍的日期
 *    `cursor:not-allowed` 且鍵盤跳過（不只是變淡）。
 */

const props = defineProps<{
  /** 可選下界 —— 這個對話第一則訊息的時間（ISO8601） */
  min: string
  /** 可選上界 —— 現在（ISO8601） */
  max: string
}>()

const emit = defineEmits<{ apply: [isoStart: string], close: [] }>()

const { t, locale } = useI18n()

const minDate = computed(() => new Date(props.min))
const maxDate = computed(() => new Date(props.max))

/** 月曆游標 —— 只用到年與月 */
const cursor = ref(new Date(maxDate.value.getFullYear(), maxDate.value.getMonth(), 1))
const selected = ref<Date | null>(null)
const hour = ref(0)
const minute = ref(0)

const monthLabel = computed(() =>
  new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(cursor.value))

const rangeLabel = computed(() =>
  t('closure.custom.range', { from: fmtDate(minDate.value) }))

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** 該月的日格（含前置空白，週一起始） */
const cells = computed(() => {
  const y = cursor.value.getFullYear()
  const m = cursor.value.getMonth()
  const first = new Date(y, m, 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(y, m + 1, 0).getDate()
  return [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => new Date(y, m, i + 1)),
  ]
})

/**
 * ⚠️ 比較用「當天 23:59:59 是否早於下界」「當天 00:00 是否晚於上界」——
 *    直接比 `Date` 會把「下界當天」整天判成不可選，而那一天正是首次進線那天。
 */
function inRange(d: Date): boolean {
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return endOfDay >= minDate.value && startOfDay <= maxDate.value
}

function isSelected(d: Date): boolean {
  const s = selected.value
  return !!s && s.getFullYear() === d.getFullYear()
    && s.getMonth() === d.getMonth() && s.getDate() === d.getDate()
}

function choose(d: Date): void {
  // ⚠️ 不只靠 `disabled` 屬性 —— handler 內也要擋（憲法 8.1 的同一個精神：
  //    一道防線壞掉時，另一道還在）
  if (!inRange(d)) return
  selected.value = d
}

const canApply = computed(() => !!selected.value && inRange(composed()))

function composed(): Date {
  const d = selected.value ?? minDate.value
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour.value, minute.value)
}

function apply(): void {
  if (!canApply.value) return
  emit('apply', composed().toISOString())
}

const shiftMonth = (delta: number): void => {
  cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + delta, 1)
}

const canPrev = computed(() => cursor.value > new Date(minDate.value.getFullYear(), minDate.value.getMonth(), 1))
const canNext = computed(() => cursor.value < new Date(maxDate.value.getFullYear(), maxDate.value.getMonth(), 1))
</script>

<template>
  <div
    role="dialog"
    :aria-label="$t('closure.custom.dialogLabel')"
    class="ac-card p-3"
    tabindex="-1"
    @keydown.esc.stop.prevent="$emit('close')"
  >
    <div class="flex items-center gap-2">
      <UButton
        size="xs" color="neutral" variant="ghost" icon="i-lucide-chevron-left"
        :disabled="!canPrev" :aria-label="$t('closure.custom.prevMonth')"
        @click="shiftMonth(-1)"
      />
      <span class="flex-1 text-center text-[0.9063rem] font-medium">{{ monthLabel }}</span>
      <UButton
        size="xs" color="neutral" variant="ghost" icon="i-lucide-chevron-right"
        :disabled="!canNext" :aria-label="$t('closure.custom.nextMonth')"
        @click="shiftMonth(1)"
      />
    </div>

    <div class="mt-2 grid grid-cols-7 gap-0.5">
      <button
        v-for="(cell, i) in cells"
        :key="i"
        type="button"
        class="h-7 rounded text-[0.8125rem]"
        :class="cell && !inRange(cell) ? 'cursor-not-allowed' : ''"
        :style="cell
          ? {
            opacity: inRange(cell) ? 1 : 0.4,
            background: isSelected(cell) ? 'var(--navy-soft)' : 'transparent',
            border: isSelected(cell) ? '1px solid var(--navy)' : '1px solid transparent',
          }
          : { visibility: 'hidden' }"
        :disabled="!cell || !inRange(cell)"
        :tabindex="cell && inRange(cell) ? 0 : -1"
        @click="cell && choose(cell)"
      >
        {{ cell ? cell.getDate() : '' }}
      </button>
    </div>

    <div class="mt-2 flex items-center gap-2">
      <label class="flex items-center gap-1 text-[0.8125rem]" :style="{ color: 'var(--text-2)' }">
        <input
          v-model.number="hour" type="number" min="0" max="23"
          class="ac-mono w-14 rounded border px-1 py-0.5 text-right"
          :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)' }"
        >
        {{ $t('closure.custom.hour') }}
      </label>
      <label class="flex items-center gap-1 text-[0.8125rem]" :style="{ color: 'var(--text-2)' }">
        <input
          v-model.number="minute" type="number" min="0" max="59"
          class="ac-mono w-14 rounded border px-1 py-0.5 text-right"
          :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)' }"
        >
        {{ $t('closure.custom.minute') }}
      </label>
    </div>

    <p class="mt-2 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">{{ rangeLabel }}</p>

    <div class="mt-3 flex justify-end gap-2">
      <UButton size="xs" color="neutral" variant="ghost" @click="$emit('close')">
        {{ $t('closure.custom.cancel') }}
      </UButton>
      <UButton size="xs" color="primary" :disabled="!canApply" @click="apply">
        {{ $t('closure.custom.apply') }}
      </UButton>
    </div>
  </div>
</template>
