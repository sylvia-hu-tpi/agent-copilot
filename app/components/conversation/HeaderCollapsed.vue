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
 *
 * ⚠️ **這一列必須能變窄，因為中欄的寬度不是它自己決定的。**（2026-09-01 實機驗收發現的 bug）
 *    中欄是 `flex-1`，左欄可拉到 400px、右欄可拉到 720px —— 兩邊都拉滿時中欄只剩幾百 px。
 *    先前這裡除了標題以外全是 `shrink-0`，寬度不夠時整列**溢出到右欄上面**：
 *    收合／展開鈕會被畫在 Copilot 面板的頂上。
 *    ⚠️ 那不是 z-index 設錯，是 CSS 的繪製順序（CSS 2.1 附錄 E）：面板的**背景**屬於
 *    「非定位區塊」那一輪，而溢出的按鈕是 **inline-level 內容**，在更後面一輪才畫，
 *    因此天生就蓋在後面兄弟的背景之上。加 `z-index` 不會修好它，**不要往那個方向調**。
 *
 *    修法是兩層，缺一不可：
 *    ① **依優先序讓資訊項消失**（container query，見檔尾 `<style>`）——
 *       訊息則數 → presence → 頻道 → status，由最軟的先讓位。
 *    ② **資訊區自己 `overflow-hidden`**，兩顆按鈕在資訊區外且 `shrink-0` ——
 *       這樣即使 ① 的門檻估錯，被裁掉的也只會是資訊，**永遠不會是按鈕**。
 *       ⚠️ MUST NOT 只在最外層加 `overflow-hidden`：裁切從右緣開始，
 *       第一個被裁掉的就是展開鈕，客服會再也展不開這一列。
 *
 * ⚠️ 依 §10.6 與檔頭第三條，**模式、主要動作、展開鈕在任何寬度下都不得消失**，
 *    因此它們不在 ① 的清單裡。
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
    class="ac-hdr-row flex h-[38px] shrink-0 items-center gap-2.5 border-b py-0 pl-4 pr-2.5"
    :style="{ background: 'var(--surface)', borderColor: 'var(--border)' }"
  >
    <!--
      資訊區 —— ⚠️ `min-w-0 flex-1 overflow-hidden` 三者缺一不可：
      `flex-1` 取代原本的 `ml-auto` 把按鈕推到右邊，`min-w-0` 讓它真的能縮
      （flex 子項的預設 `min-width:auto` 會讓它縮不下去），`overflow-hidden` 讓
      裁切發生在**這裡**而不是整列的右緣。理由見檔頭。
    -->
    <div class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
      <h1 class="ac-mono min-w-0 shrink truncate text-[0.9375rem] font-medium">{{ title }}</h1>

      <span
        v-if="status && STATUS_COLOR[status]"
        class="ac-hdr-status flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.8125rem]"
        :style="{ background: STATUS_COLOR[status]!.bg, color: STATUS_COLOR[status]!.fg }"
      >
        <span class="size-1 rounded-full" :style="{ background: STATUS_COLOR[status]!.fg }" aria-hidden="true" />
        {{ status }}
      </span>

      <span
        v-if="channel"
        class="ac-hdr-channel flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.8125rem]"
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

      <!--
        ⚠️ 模式在收合態是必要資訊，不是裝飾 —— 理由見檔頭。
           因此它**沒有** `ac-hdr-*` 這種會被 container query 藏掉的 class。
      -->
      <span
        class="flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.8125rem]"
        :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        :title="mode ? t(`mode.${mode}Hint`) : undefined"
      >
        <UIcon name="i-lucide-sliders-horizontal" class="size-3 shrink-0" />
        {{ mode ? t(`mode.${mode}`) : t('mode.none') }}
      </span>

      <span
        class="ac-hdr-presence flex shrink-0 items-center gap-1 text-[0.8125rem]"
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
        class="ac-hdr-msgcount ac-mono shrink-0 text-[0.8125rem]"
        :style="{ color: 'var(--text-3)' }"
      >{{ msgCountLabel }}</span>
    </div>

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

<style scoped>
/*
 * 收合列的**優先序讓位**（2026-09-01）—— 中欄寬度不夠時，由最軟的資訊先消失。
 *
 * ⚠️ 用 container query 而不是 `@media`：這一列的寬度**不是視窗寬度**，
 *    是視窗扣掉左欄（220–400px，可收合）與右欄（320–720px，可收合）之後剩下的。
 *    同一個視窗寬度下，兩欄拉滿與兩欄都收起，這一列會差到 800px 以上 ——
 *    用視窗寬度當條件等於在猜，猜錯的方向就是本次修掉的那個 bug（溢出到右欄上面）。
 *
 * ⚠️ 門檻是**估算**的（依各項的實際文字寬度往上取整），不是量出來的定值。
 *    估錯的後果被限制成「資訊區裡最右邊那項被裁掉一半」，不會再溢出到別欄 ——
 *    那層保護在 template 的 `overflow-hidden` 上，不在這裡。
 *
 * ⚠️ 模式（`mode`）、主要動作、展開鈕**不在這份清單裡**，任何寬度下都不得消失（見檔頭）。
 */
.ac-hdr-row {
  container-type: inline-size;
}

@container (max-width: 749px) {
  .ac-hdr-msgcount { display: none; }
}

@container (max-width: 639px) {
  .ac-hdr-presence { display: none; }
}

@container (max-width: 499px) {
  .ac-hdr-channel { display: none; }
}

@container (max-width: 419px) {
  .ac-hdr-status { display: none; }
}
</style>
