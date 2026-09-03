<script setup lang="ts">
/**
 * 左欄收合態的窄直條 —— 畫布 §8.1（48px，2026-08-31 版；先前記錄的 30px 是 08-28 版的值）。
 *
 * 結構逐字：展開鈕（30×30、`panel-left-open`）／24×1px 分隔線／
 * 收件匣圖示（30×30、`navy-soft` 底）＋右上角的數量徽記。
 *
 * ⚠️ **這一條存在的理由不是「畫布有畫」，是收合後會少掉的那個訊號。**
 *    先前實作是整欄消失、展開鈕移到中欄標題列 —— 中欄確實更寬，但
 *    「還有幾個對話、有沒有新訊息」在收合期間完全沒有出口，客服得先展開才知道要不要展開。
 *
 * ⚠️ 徽記的數字是**對話數**（畫布的 `24` 對應展開態的「全部 24」），不是未讀則數。
 *    未讀維持既有的圓點語意（2026-08-29 裁定）—— 我方唯一的新訊息訊號 `last_message_at`
 *    在一次輪詢間隔內來幾則都只跳一次，數出來是「批次數」不是「則數」。
 */

const props = defineProps<{
  /** 平台回報的總數；`null` ＝ 拿不到，此時退回已載入的筆數 */
  total: number | null
  loaded: number
  /** 有沒有任何對話帶著未讀 —— 收合後唯一會消失的訊號，用圓點補回來 */
  hasUnread: boolean
}>()

const emit = defineEmits<{ expand: [] }>()

const count = computed(() => props.total ?? props.loaded)
</script>

<template>
  <aside
    class="flex h-full w-12 shrink-0 flex-col items-center gap-2.5 border-r py-2.5"
    :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
  >
    <button
      type="button"
      class="flex size-[30px] items-center justify-center rounded-lg border transition-opacity hover:opacity-70"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
      :aria-label="$t('sidebar.expand')"
      :aria-expanded="false"
      :title="$t('sidebar.expand')"
      @click="emit('expand')"
    >
      <UIcon name="i-lucide-panel-left-open" class="size-3.5" />
    </button>

    <span class="h-px w-6" :style="{ background: 'var(--border)' }" aria-hidden="true" />

    <span
      class="relative flex size-[30px] items-center justify-center rounded-lg border"
      :style="{ background: 'var(--navy-soft)', borderColor: 'var(--navy-soft-bd)', color: 'var(--navy-2)' }"
      :title="$t('sidebar.shownOnly', { n: count })"
    >
      <UIcon name="i-lucide-inbox" class="size-3.5" />
      <span
        class="absolute -right-1.5 -top-1 rounded-full px-1 text-[0.6875rem] leading-[1.4]"
        :style="{ background: 'var(--navy)', color: 'var(--navy-fg)' }"
      >{{ count }}</span>

      <!--
        ⚠️ 未讀用**圓點**而不是數字，理由同側欄列項（見檔頭）。
           位置刻意與數量徽記錯開，避免兩個徽記疊在一起讀不出來。
      -->
      <span
        v-if="hasUnread"
        class="absolute -bottom-0.5 -right-1 size-2 rounded-full border"
        :style="{ background: 'var(--navy-2)', borderColor: 'var(--surface)' }"
        :aria-label="$t('sidebar.unread')"
        :title="$t('sidebar.unread')"
      />
    </span>
  </aside>
</template>
