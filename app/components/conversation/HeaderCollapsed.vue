<script setup lang="ts">
/**
 * 中欄「對話資訊列」的收合態 —— 畫布 1c 逐字（38px 單列）。
 *
 * 展開態佔掉 標題列 ＋ 服務模式 ＋ Presence 三段，在 860px 高的畫面上約 130px；
 * 客服真正在讀的是訊息流，長對話往回翻時那三段一直佔著位置。
 * 收合態把「不看也不行」的四件事壓成一列：**代號／status／頻道／模式**，
 * 再加上 presence 一句話與**當下唯一的主要動作**。
 *
 * ⚠️ **收合後不得少掉任何「會影響下一步操作」的資訊。**
 *    模式（`mode`）尤其不能省 —— 它決定 Composer 能不能送出、AI 會不會自己回話，
 *    而且是**對話層級的共用狀態**（§10.6）。收起來會讓客服在不知道自己處於
 *    全自動（唯讀）的情況下打了一段字才發現送不出去。
 *
 * ⚠️ **收合態只放主要動作**（未接手＝「接手對話」／已接手＝「結案」），
 *    畫布如此。「離開對話」與接手的兩種模式選項留在展開態 ——
 *    那些是有後果、需要讀完輔助說明才按的動作，不該塞進一條 38px 的窄列。
 *
 * ⚠️ 接手在這裡固定是 `manual`（畫布的 `takeoverStop`＝「接手並停用 AI 自動回覆」）。
 *    要「接手但保留 AI 自動回覆」得展開 —— 因為那個選擇必須連同後果文案一起讀。
 */

import type { ConversationMode } from '#shared/types/conversation'

defineProps<{
  /** 客戶代號（`TWN#GW4772`） */
  title: string
  /** 對話 status；`STATUS_COLOR` 沒列到的值不畫圓點（見 conversation-display.ts） */
  status?: string | null
  channel?: string | null
  /** 服務模式；`null` ＝ 尚未取得，此時顯示「未知」而不是猜一個 */
  mode: ConversationMode | null
  /** presence 的一句話摘要，由頁面沿用 PresenceBar 的同一套保守措辭算出 */
  presenceShort: string
  /** 「已載入 N 則」／「訊息 N 則」；`null` ＝ 尚未載入任何訊息，此時整欄不顯示 */
  msgCountLabel?: string | null
  joined: boolean
  busy: boolean
}>()

const emit = defineEmits<{ expand: [], join: [], close: [] }>()

const { t } = useI18n()
</script>

<template>
  <div
    class="flex h-[38px] shrink-0 items-center gap-2.5 border-b py-0 pl-4 pr-2.5"
    :style="{ background: 'var(--surface)', borderColor: 'var(--border)' }"
  >
    <h1 class="ac-mono min-w-0 shrink truncate text-[0.9375rem] font-medium">{{ title }}</h1>

    <span
      v-if="status && STATUS_COLOR[status]"
      class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.8125rem]"
      :style="{ background: STATUS_COLOR[status]!.bg, color: STATUS_COLOR[status]!.fg }"
    >
      <span class="size-1 rounded-full" :style="{ background: STATUS_COLOR[status]!.fg }" aria-hidden="true" />
      {{ status }}
    </span>

    <span
      v-if="channel"
      class="flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.8125rem]"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
    >
      <img
        v-if="CHANNEL_ICON[channel]"
        :src="CHANNEL_ICON[channel]"
        :alt="channel"
        class="size-3 shrink-0 rounded-[3px] object-contain"
      >
      {{ channel }}
    </span>

    <!-- ⚠️ 模式在收合態是必要資訊，不是裝飾 —— 理由見檔頭 -->
    <span
      class="flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.8125rem]"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
      :title="mode ? t(`mode.${mode}Hint`) : undefined"
    >
      <UIcon name="i-lucide-sliders-horizontal" class="size-3 shrink-0" />
      {{ mode ? t(`mode.${mode}`) : t('mode.none') }}
    </span>

    <span
      class="flex shrink-0 items-center gap-1 text-[0.8125rem]"
      :style="{ color: 'var(--text-3)' }"
    >
      <UIcon name="i-lucide-eye" class="size-3 shrink-0" aria-hidden="true" />
      {{ presenceShort }}
    </span>

    <!--
      訊息則數（畫布 1c 收合列也有這一欄）。
      ⚠️ 措辭與展開態共用同一個 `msgCountLabel` —— 各算一份的話遲早會分岔成
         「已載入 N 則」與「訊息 N 則」不同步，而那就是在謊報總數。
    -->
    <span
      v-if="msgCountLabel"
      class="ac-mono shrink-0 text-[0.8125rem]"
      :style="{ color: 'var(--text-3)' }"
    >{{ msgCountLabel }}</span>

    <span class="ml-auto" />

    <button
      v-if="!joined"
      type="button"
      class="ac-btn-primary flex h-7 shrink-0 items-center gap-1.5 px-3 text-[0.875rem]"
      :disabled="busy"
      @click="emit('join')"
    >
      <UIcon
        :name="busy ? 'i-lucide-loader-circle' : 'i-lucide-user-check'"
        class="size-3.5 shrink-0"
        :class="{ 'animate-spin': busy }"
      />
      {{ busy ? t('conversation.joining') : t('conversation.join') }}
    </button>

    <button
      v-else
      type="button"
      class="ac-btn-primary flex h-7 shrink-0 items-center gap-1.5 px-3 text-[0.875rem]"
      :disabled="busy"
      @click="emit('close')"
    >
      <UIcon name="i-lucide-clipboard-check" class="size-3.5 shrink-0" />
      {{ busy ? t('conversation.closing') : t('conversation.close') }}
    </button>

    <button
      type="button"
      class="flex size-6 shrink-0 items-center justify-center rounded-md border transition-opacity hover:opacity-70"
      :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface)', color: 'var(--text-2)' }"
      :aria-label="t('conversation.expandHeader')"
      :aria-expanded="false"
      :title="t('conversation.expandHeader')"
      @click="emit('expand')"
    >
      <UIcon name="i-lucide-chevrons-down" class="size-3.5" />
    </button>
  </div>
</template>
