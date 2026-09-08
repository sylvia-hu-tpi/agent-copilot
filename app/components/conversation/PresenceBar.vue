<script setup lang="ts">
/**
 * 誰在這個對話裡 —— docs/ARCHITECTURE.md §10.2。
 *
 * ── 這個元件的正確性標準是「誠實」，不是「好看」──────────────────
 * 三種來源的可信度完全不同，**必須分開呈現**：
 *
 *   王大明 正在輸入…      ← ① 自家 SSE：即時、確定在線、具名
 *   李小華 3 分鐘前回覆過  ← ② 訊息反推：推測、可能已離開、具名
 *   有同事正在處理         ← ③ mode：只知道有人，無法指名，沒有頭像可放
 *
 * ⚠️ **② 絕不可顯示成「正在檢視」。**「曾經發言」不等於「現在還在」——
 *    誤導客服以為有人守著而實際沒人，比不顯示更糟。
 *
 * ⚠️ **空狀態不可寫成「目前沒有其他人在看」。** `mode` 的 `automation` 值對
 *    「真的沒人」與「有人但選了 Automation Only（唯讀）」無法區分，
 *    那個宣稱超出資料能支持的範圍。文案只能停在「沒有偵測到其他人」。
 *
 * ⚠️ **空狀態是常態，不是例外。** 單人使用時①為空、無人發言時②為空 ——
 *    這一列大多數時候是空的，設計上要讓它看起來正常而不是壞掉。
 */

import type { PresenceEntry } from '#shared/types/conversation'
import type { PresenceSnapshot } from '#shared/types/events'

const props = defineProps<{ presence: PresenceSnapshot }>()

const { t } = useI18n()

const live = computed(() => props.presence.operators.filter(o => o.source !== 'message'))
const inferred = computed(() => props.presence.operators.filter(o => o.source === 'message'))

/**
 * specs/006 FR-045：正在結案的同事。
 * ⚠️ 只看來源 ①（自家 SSE）—— 來源 ② 是「曾經發言」的反推，它不知道對方有沒有在結案。
 * ⚠️ 快照已由 server 排除自己（`snapshotOf` 的 `excludeOperatorId`），
 *    因此這裡不會出現「你正在結案」。
 */
const closingOperators = computed(() =>
  props.presence.operators.filter(o => o.source !== 'message' && o.closing))

const isEmpty = computed(() =>
  props.presence.operators.length === 0 && !props.presence.unidentifiedActor,
)

function liveLabel(entry: PresenceEntry): string {
  return entry.state === 'composing' ? t('presence.composing') : t('presence.viewing')
}

/** ② 的相對時間 —— 必須看得出「多久以前」，那正是它與 ① 的差別所在 */
function ago(at: string): string {
  const diffMs = Date.now() - new Date(at).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (!Number.isFinite(mins) || mins < 1) return t('common.justNow')
  if (mins < 60) return t('common.minutesAgo', { n: mins })
  return t('common.hoursAgo', { n: Math.floor(mins / 60) })
}

/** ⚠️ 查不到名字時用通稱，**不可編一個名字**（見 server/services/directory.ts） */
function displayName(entry: PresenceEntry): string {
  return entry.operatorName || t('presence.unknownName')
}

/**
 * 「最後更新 HH:MM:SS」（畫布 §8.3）。
 *
 * ⚠️ `PresenceSnapshot` 本身**沒有時間戳**，所以這裡記的是「我方最後一次收到
 *    presence 更新的時刻」，不是伺服器產生快照的時刻。兩者在正常情況下差幾十毫秒，
 *    但斷線重連時會差很多——這正是這一行存在的意義：它讓「這份資料有多新」看得見。
 *    ⚠️ MUST NOT 改成 `new Date()` 即時渲染，那樣它永遠顯示現在時間、等於沒有資訊。
 */
const lastUpdatedAt = ref<Date | null>(null)
watch(() => props.presence, () => { lastUpdatedAt.value = new Date() }, { immediate: true, deep: true })

const lastUpdatedText = computed(() => (
  lastUpdatedAt.value
    ? t('presence.lastUpdated', {
        time: lastUpdatedAt.value.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      })
    : ''
))
</script>

<template>
  <div
    class="flex min-h-[34px] flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-[0.875rem]"
    :style="{ color: 'var(--text-3)', background: 'var(--surface-2)', borderColor: 'var(--border)' }"
  >
    <span class="ac-status-label shrink-0">{{ t('presence.inThisConversation') }}</span>

    <!-- ① 自家 SSE：確定在線 -->
    <span
      v-for="op in live"
      :key="`live-${op.operatorId}`"
      class="flex items-center gap-1.5"
      :style="{ color: 'var(--text-2)' }"
    >
      <span
        class="size-1.5 shrink-0 rounded-full"
        :style="{ background: 'var(--active)' }"
        aria-hidden="true"
      />
      <span class="font-medium">{{ displayName(op) }}</span>
      <span>{{ liveLabel(op) }}</span>
    </span>

    <!--
      specs/006 FR-045（SHOULD）：有同事正在走結案流程。

      ⚠️ **純提示，不阻擋**（憲法 3.3、憲法 7.1）—— 看到的人仍可回覆、仍可自行結案。
         文案本身就把這件事說出來（「你仍可回覆或自行結案」），
         而不是只顯示「XXX 正在結案」讓人自己猜要不要停手。
      ⚠️ 與 ①「正在輸入／正在檢視」是**兩個正交的維度**，因此另起一列而不是
         替換 `liveLabel()` 的文字 —— 替換的話，對方一開始打字提示就消失了。
    -->
    <span
      v-for="op in closingOperators"
      :key="`closing-${op.operatorId}`"
      class="flex items-center gap-1.5 rounded-full px-2 py-0.5"
      :style="{ background: 'var(--open-bg)', color: 'var(--open)' }"
    >
      <UIcon name="i-lucide-flag" class="size-3 shrink-0" aria-hidden="true" />
      {{ t('closure.presenceClosing', { name: displayName(op) }) }}
    </span>

    <!-- ② 訊息反推：推測，措辭必須是過去式 -->
    <span
      v-for="op in inferred"
      :key="`msg-${op.operatorId}`"
      class="flex items-center gap-1.5"
      :title="t('presence.sourceHint')"
    >
      <UIcon name="i-lucide-history" class="size-3 shrink-0" aria-hidden="true" />
      <span>{{ displayName(op) }}</span>
      <span>{{ t('presence.repliedAgo', { time: ago(op.at) }) }}</span>
    </span>

    <!-- ③ mode：有人能送出訊息，但指不出是誰 —— 刻意沒有頭像也沒有名字 -->
    <span
      v-if="presence.unidentifiedActor"
      class="flex items-center gap-1.5 rounded-full border border-dashed px-2 py-0.5"
      :style="{ borderColor: 'var(--border-dash)', color: 'var(--text-2)' }"
    >
      <UIcon name="i-lucide-users" class="size-3 shrink-0" aria-hidden="true" />
      {{ t('presence.unidentified') }}
    </span>

    <!--
      空狀態：常態，不是錯誤。措辭刻意保守。
      ⚠️ **不採用畫布的「無人／未知」＋「presence 資料未提供」**（2026-08-29 使用者裁定保留實作）：
         畫布把「沒有人」與「偵測不到」並列，而 §10.2 明訂我方無法區分這兩者，
         寫成並列等於宣稱我們分得出來。實作只講偵測結果。
    -->
    <!--
      ⚠️ 畫布 1c 的空狀態是「20px 虛線圓框 ＋ `user` icon ＋ 一般字」，不是斜體淡字。
         斜體＋降透明度會讓它讀起來像「這裡壞了」，而空狀態是常態不是錯誤。
    -->
    <span v-if="isEmpty" class="flex items-center gap-1.5">
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed"
        :style="{ borderColor: 'var(--border-dash)' }"
        aria-hidden="true"
      >
        <UIcon name="i-lucide-user" class="size-2.5" :style="{ color: 'var(--text-3)' }" />
      </span>
      {{ t('presence.none') }}
    </span>

    <span class="ml-auto" />

    <!-- 自己 —— 畫布 §8.3 靠右恆常顯示。presence.operators 刻意排除自己，故這裡是靜態文字 -->
    <span class="flex shrink-0 items-center gap-1.5" :style="{ color: 'var(--text-2)' }">
      <UIcon name="i-lucide-eye" class="size-3 shrink-0" aria-hidden="true" />
      {{ t('presence.youViewing') }}
    </span>

    <time v-if="lastUpdatedText" class="ac-mono shrink-0 text-[0.8125rem]">{{ lastUpdatedText }}</time>
  </div>
</template>
