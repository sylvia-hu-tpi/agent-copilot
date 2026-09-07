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
 * ⚠️ **則數有三種狀態，`messageCount` 一個欄位表達不完**，判斷一律看 `truncated`：
 *    ① `truncated: true`（`messageCount: null`）＝「超過 500 則」—— **可選**，
 *       而且通常正是長期客戶要的那一個。把它當 0 會讓那些對話完全結不了案。
 *    ② `messageCount: null` ＋ `truncated: false` ＝「**尚未算出**」——
 *       自訂起算不在候選清單裡，則數只有 `draft.period` 算得出來。
 *    ③ `messageCount: 0` ＝ 真的 0 則，不可選。
 *    ⚠️ 曾經 ① 與 ② 都只看 `messageCount === null`，於是自訂起算後畫面謊報
 *       「超過 500 則」—— 起點明明更晚、則數只可能更少（2026-09-04 修）。
 */

import type { ClosurePeriod, ClosurePeriodOrigin } from '#shared/types/copilot'
import type { ClosureScopeCandidate, ClosureScopes } from '~/stores/closure'

const props = withDefaults(defineProps<{
  scopes: ClosureScopes
  selected: { periodStart: string, periodOrigin: ClosurePeriodOrigin } | null
  /** 畫布的三種呈現風格；預設 `row`（可點開的摘要列） */
  state?: 'quiet' | 'row' | 'list'
  /** `regen`：改了選擇、正在重新產生 */
  regenerating?: boolean
  /**
   * 草稿實際採用的區間 —— **自訂起算的則數唯一來源**。
   * 候選清單只含「上次結案」與安全網，自訂起點不在裡面，則數是 server 端
   * 產生草稿時才算的（`draft.period.messageCount`）。
   * ⚠️ 它可能是**上一個**區間的（regen 在途），因此 `current` 會比對
   *    `start`／`origin` 是否相符才採用。
   */
  period?: ClosurePeriod | null
}>(), { state: 'row', regenerating: false, period: null })

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
  // ⚠️ 選完就收合（§7.5「收合行為」）—— 畫布 B4 呈現的收合態是「選了」造成的，
  //    不是 `regen` 造成的。選項已經選定，清單再佔著半個面板只是擋住下面的摘要。
  open.value = false
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

/**
 * 起點片語。⚠️ 安全網逐字是「**第一則對話起**」而不是時間戳
 * （`DESIGN_TOKENS.md` §7.5 候選清單表格的 `t` 欄）—— 客服要的是
 * 「這是完整對話」這個語意，不是那一則訊息剛好幾點幾分。
 */
function startPhrase(c: ClosureScopeCandidate): string {
  return c.origin === 'first'
    ? t('closure.scope.startFirst')
    : t('closure.scope.startAt', { t: fmtTime(c.start) })
}

/** 則數片語 —— 三種狀態見檔頭。⚠️ 尚未算出時 MUST NOT 顯示成 0 則（憲法 4.5：不猜） */
function countPhrase(c: ClosureScopeCandidate): string {
  if (c.truncated) return t('closure.scope.countTruncated')
  if (c.messageCount === null) return t('closure.scope.countPending')
  return t('closure.scope.countN', { n: c.messageCount })
}

/**
 * 則數 > 150 的份量警示。⚠️ `truncated`（超過 500）當然算重；
 * 「尚未算出」**不算** —— 不知道就不上色（憲法 4.5：不猜）。
 * ⚠️ 原本寫成 `(messageCount ?? Infinity) > HEAVY`，把「尚未算出」也染成 warn。
 */
function isHeavy(c: ClosureScopeCandidate): boolean {
  return c.truncated || (c.messageCount ?? 0) > HEAVY
}

/** 收合態摘要列的「{起點} · {則數}」（畫布 `scopeSummaryLabel`）。⚠️ 候選列**不**用它，見下 */
function countText(c: ClosureScopeCandidate): string {
  return t('closure.scope.row', { start: startPhrase(c), count: countPhrase(c) })
}

/*
  ⚠️ **候選列的起點與則數是分開的兩段，不可併成一句話**（§7.5 逐字，附理由）：
     則數靠右對齊，客服要比較份量時才不必逐列去找數字落在哪個水平位置。
     併成 `{t} 起 · {n} 則` 會讓數字隨起點字數在每列漂移 —— 收合態的摘要列
     （只有一列、沒有東西可比）才是併起來的那個。
*/
/** 候選列的起點色：0 則轉灰，其餘 `--text` */
function startColor(c: ClosureScopeCandidate): string {
  return selectable(c) ? 'var(--text)' : 'var(--text-3)'
}

/** 候選列的則數色：0 則 `--text-3`、份量重 `--warn`、其餘 `--text-2` */
function countColor(c: ClosureScopeCandidate): string {
  if (!selectable(c)) return 'var(--text-3)'
  return isHeavy(c) ? 'var(--warn)' : 'var(--text-2)'
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
  return t('closure.scope.coverage', { start: startPhrase(cur), count: countPhrase(cur) })
})

/**
 * `regen` 的提示（畫布 B4）。
 *
 * ⚠️ 安全網版與時間戳版是**兩個完整字串**，不是同一個模板換參數 ——
 *    畫布逐字的「已改為第一則對話起」**沒有空格**，而「已改為 9/2 14:30 起」有。
 *    用同一個 `{start}` 模板會在安全網版多出一個空格。
 * ⚠️ 則數尚未算出時走 `regenPending`（自訂起算必然有時間戳，不會是安全網）——
 *    把「則數計算中…」塞進「（{count}）」的括號裡讀起來像在報錯。
 */
const regenText = computed(() => {
  const cur = current.value
  if (!cur) return ''
  if (!cur.truncated && cur.messageCount === null) {
    return t('closure.scope.regenPending', { t: fmtTime(cur.start) })
  }
  const count = countPhrase(cur)
  return cur.origin === 'first'
    ? t('closure.scope.regenFirst', { count })
    : t('closure.scope.regen', { t: fmtTime(cur.start), count })
})

/** 目前選中的那一列（可能是 fallback，也可能是自訂 —— 自訂不在清單裡） */
const current = computed<ClosureScopeCandidate | null>(() => {
  if (!props.selected) return null
  const all = [...props.scopes.candidates, props.scopes.fallback]
  const hit = all.find(c => c.start === props.selected!.periodStart
    && c.origin === props.selected!.periodOrigin)
  if (hit) return hit
  // 自訂起算不在候選清單裡 —— 則數只有草稿算得出來（`draft.period`）。
  // ⚠️ 草稿可能還沒回來，或回來的是**上一個**區間的；那種情況 MUST 留
  //    `null` ＋ `truncated: false`（＝「尚未算出」），MUST NOT 沿用舊則數。
  const p = props.period
  const fresh = p !== null && p !== undefined
    && p.start === props.selected.periodStart
    && p.origin === props.selected.periodOrigin
  return {
    start: props.selected.periodStart,
    origin: props.selected.periodOrigin,
    messageCount: fresh ? p.messageCount : null,
    truncated: fresh ? p.truncated : false,
  }
})

const isCustomApplied = computed(() => props.selected?.periodOrigin === 'custom')

const customLabel = computed(() =>
  props.selected?.periodOrigin === 'custom'
    ? t('closure.custom.applied', { t: fmtTime(props.selected.periodStart) })
    : t('closure.custom.unused'))

function applyCustom(isoStart: string): void {
  showCustom.value = false
  // ⚠️ 與 `pick()` 同一個理由：套用自訂時間之後清單自動收合（§7.5）
  open.value = false
  emit('pick', isoStart, 'custom')
}
</script>

<template>
  <!--
    ⚠️ **外層沒有自己的邊框與底色**（§7.5 逐字：「選擇器的外層是 `flex-col gap:7px`，
       沒有邊框或底色 —— 有框的是 `row` 的那顆按鈕」）。
       2026-09-07 核對前這裡是一張 `--surface-2` 的卡片，於是第 6 區塊裡出現
       「卡中卡」：選擇器看起來與下面的草稿是兩個平行的東西，而它其實是草稿的前提。
  -->
  <div class="flex flex-col gap-[7px]">
    <!--
      收合態摘要列（畫布 `scopeStyle:"row"`）：**有框有底的按鈕**。
      憲法 8.2 逐字規格：`role="button"` ＋ `tabIndex` ＋ `aria-expanded`。
    -->
    <div
      role="button"
      :tabindex="0"
      :aria-expanded="open"
      class="flex w-full items-center gap-[7px] rounded-lg px-[9px] py-[7px] text-left outline-offset-[-2px] focus-visible:bg-[var(--surface-3)]"
      :style="{ border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
    >
      <UIcon name="i-lucide-calendar-clock" class="size-3.5 shrink-0" :style="{ color: 'var(--text-3)' }" />
      <span class="shrink-0 text-[0.8438rem]" :style="{ color: 'var(--text-3)' }">
        {{ $t('closure.scope.label') }}
      </span>
      <span class="ac-mono min-w-0 flex-1 truncate text-[0.9063rem]">
        {{ current ? countText(current) : '—' }}
      </span>
      <UIcon
        :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        class="size-3.5 shrink-0"
        :style="{ color: 'var(--text-3)' }"
      />
    </div>

    <template v-if="open">
      <div v-if="state === 'list'" class="flex items-center gap-[7px]">
        <UIcon name="i-lucide-calendar-clock" class="size-3.5 shrink-0" :style="{ color: 'var(--text-3)' }" />
        <span class="text-[0.9063rem] font-medium">{{ $t('closure.scope.title') }}</span>
        <span class="flex-1" />
        <span class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
          {{ $t('closure.scope.subtitle') }}
        </span>
      </div>

      <div
        role="radiogroup"
        :aria-label="$t('closure.scope.title')"
        class="flex flex-col gap-[5px]"
      >
        <!--
          `never`（從未結案過）：**有框的告知卡**（§7.5 逐字）——
          它要說的是「預設值是怎麼來的」，比另外兩句重，因此畫布只有這一句給了框。
        -->
        <p
          v-if="autoState === 'never'"
          class="flex items-start gap-[7px] rounded-[7px] border px-[9px] py-[7px] text-[0.875rem] leading-relaxed"
          :style="{
            background: 'var(--navy-soft)',
            borderColor: 'var(--navy-soft-bd)',
            color: 'var(--text-2)',
          }"
        >
          <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" :style="{ color: 'var(--navy-2)' }" />
          {{ $t('closure.scope.never') }}
        </p>

        <!--
          `zeroTop`：⚠️ **這一句是我方追加的**（`DESIGN_FEEDBACK.md` D-6）——
          畫布認為灰掉的那一列自己就是說明，但那一列只說「這個起點沒有新訊息」，
          沒說「所以系統幫你改選了下一個」。選擇結果被系統動過而客服不知道，
          正是憲法 8.1 要避免的情形。
          ⚠️ 樣式刻意跟著 `overflow` 那種**無框的旁注**，不是 `never` 的告知卡 ——
             它補充的是清單裡看得到的事實，不是預設值的來源。
        -->
        <p
          v-if="autoState === 'zeroTop'"
          class="flex items-start gap-[7px] px-0.5 pt-0.5 text-[0.8438rem] leading-relaxed"
          :style="{ color: 'var(--text-3)' }"
        >
          <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
          {{ $t('closure.scope.zeroTop') }}
        </p>

        <!--
          候選：時間降冪（由 server 排好，這裡不再排一次）。
          ⚠️ **每一列是兩行**：第一行是起點與右對齊的則數，第二行才是 label。
        -->
        <button
          v-for="c in scopes.candidates"
          :key="`${c.origin}:${c.start}`"
          type="button"
          role="radio"
          :aria-checked="isSelected(c)"
          class="flex w-full items-start gap-2 rounded-lg border px-[9px] py-[7px] text-left outline-offset-[-2px]"
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
            class="mt-0.5 size-3.5 shrink-0"
            :style="{ color: isSelected(c) ? 'var(--navy-2)' : 'var(--text-3)' }"
          />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex items-baseline gap-2">
              <span
                class="ac-mono min-w-0 truncate text-[0.9063rem] font-medium"
                :style="{ color: startColor(c) }"
              >{{ startPhrase(c) }}</span>
              <span class="flex-1" />
              <span
                class="ac-mono shrink-0 text-[0.8438rem]"
                :style="{ color: countColor(c) }"
              >{{ countPhrase(c) }}</span>
            </span>
            <span class="text-[0.8438rem] leading-[1.55]" :style="{ color: 'var(--text-3)' }">
              {{ labelText(c) }}
            </span>
          </span>
        </button>

        <!-- ⚠️ 安全網永遠墊底、永遠存在；未選中時虛線框（畫布逐字） -->
        <button
          type="button"
          role="radio"
          :aria-checked="isSelected(scopes.fallback)"
          class="flex w-full items-start gap-2 rounded-lg px-[9px] py-[7px] text-left outline-offset-[-2px]"
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
            class="mt-0.5 size-3.5 shrink-0"
            :style="{ color: isSelected(scopes.fallback) ? 'var(--navy-2)' : 'var(--text-3)' }"
          />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex items-baseline gap-2">
              <span
                class="ac-mono min-w-0 truncate text-[0.9063rem] font-medium"
                :style="{ color: startColor(scopes.fallback) }"
              >{{ startPhrase(scopes.fallback) }}</span>
              <span class="flex-1" />
              <span
                class="ac-mono shrink-0 text-[0.8438rem]"
                :style="{ color: countColor(scopes.fallback) }"
              >{{ countPhrase(scopes.fallback) }}</span>
            </span>
            <span class="text-[0.8438rem] leading-[1.55]" :style="{ color: 'var(--text-3)' }">
              {{ labelText(scopes.fallback) }}
            </span>
          </span>
        </button>

        <!--
          `overflow`：**無底色無框的旁注**（§7.5 逐字），位置在清單**下方** ——
          它講的是「清單到此為止」，放在清單之前會變成在講一件還沒發生的事。
        -->
        <p
          v-if="autoState === 'overflow'"
          class="flex items-start gap-[7px] px-0.5 pt-0.5 text-[0.8438rem] leading-relaxed"
          :style="{ color: 'var(--text-3)' }"
        >
          <UIcon name="i-lucide-ellipsis" class="mt-0.5 size-3.5 shrink-0" />
          {{ $t('closure.scope.overflow', { n: scopes.overflowCount }) }}
        </p>

        <!--
          ⚠️ 自訂起算時間的入口在**任何狀態**都可用（FR-021e-1）。
          ⚠️ 它與候選列是同一個視覺家族（§7.5 逐字：「框線在已套用時由虛線轉
             `--navy` 實線」）—— 做成 ghost 按鈕會讓客服讀不出「這也是一個
             可選的起算點」，而它正是候選清單湊不出來的那些區間的唯一出路。
        -->
        <div class="relative pt-0.5">
          <button
            type="button"
            class="flex h-7 w-full items-center gap-[7px] rounded-[7px] px-[9px] text-left"
            :aria-expanded="showCustom"
            aria-haspopup="dialog"
            :style="{
              border: isCustomApplied
                ? '1px solid var(--navy)'
                : '1px dashed var(--border-dash)',
              background: isCustomApplied ? 'var(--navy-soft)' : 'var(--surface-2)',
            }"
            @click="showCustom = !showCustom"
          >
            <UIcon
              name="i-lucide-calendar-plus"
              class="size-3.5 shrink-0"
              :style="{ color: 'var(--text-3)' }"
            />
            <span class="min-w-0 flex-1 truncate text-[0.8438rem]" :style="{ color: 'var(--text-3)' }">
              {{ $t('closure.custom.entry') }}
            </span>
            <span
              class="ac-mono shrink-0 text-[0.8438rem]"
              :style="{ color: isCustomApplied ? 'var(--navy-2)' : 'var(--text-3)' }"
            >{{ customLabel }}</span>
          </button>

          <CopilotClosureCustomStart
            v-if="showCustom"
            class="mt-2"
            :min="scopes.firstMessageAt"
            :max="new Date().toISOString()"
            @apply="applyCustom"
            @close="showCustom = false"
          />
        </div>
      </div>
    </template>

    <!--
      ⚠️ 唯讀涵蓋說明：**不可省**（FR-021f），且不隨展開／收合消失。
      ⚠️ 它的位置是**清單下方**（§7.5 逐字）而不是標題列下方 —— 擺在標題列下方時，
         展開態會與標題列連續出現兩行幾乎相同的句子，讀起來像重複；擺在清單之後，
         它讀起來是「以上選擇的結論」。收合態則自然緊接標題列，那正是畫布的樣子。
    -->
    <p class="flex items-center gap-1.5 text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
      <UIcon name="i-lucide-check" class="size-3 shrink-0" :style="{ color: 'var(--text-3)' }" />
      {{ coverage }}
    </p>

    <!--
      ⚠️ `regen` 提示**不能只在展開時出現**（畫布 B4 就是收合態）——
         改了範圍正在重算是「畫面上這份摘要即將被換掉」的唯一告知，
         客服把清單收起來之後就看不到，等於沒告知。
      ⚠️ 畫布把它畫在選擇器容器**之外**、摘要 textarea 之前。外層拿掉框與底色之後，
         擺在容器最後一項與擺在容器之後在畫面上是同一件事（只差 7px／10px 的間距），
         而留在這裡才拿得到 `current` —— 移出去就得把整段則數推導複製一份。
    -->
    <p
      v-if="regenerating && current"
      class="flex items-start gap-1.5 rounded-[7px] border px-[9px] py-[7px] text-[0.875rem] leading-relaxed"
      :style="{
        background: 'var(--navy-soft)',
        borderColor: 'var(--navy-soft-bd)',
        color: 'var(--text-2)',
      }"
    >
      <UIcon
        name="i-lucide-loader-2"
        class="mt-0.5 size-3 shrink-0 animate-spin"
        :style="{ color: 'var(--navy-2)' }"
      />
      {{ regenText }}
    </p>
  </div>
</template>
