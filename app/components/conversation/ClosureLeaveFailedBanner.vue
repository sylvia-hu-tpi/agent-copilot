<script setup lang="ts">
/**
 * C1：**結案摘要已寫入，但離開對話失敗**（`docs/DESIGN_TOKENS.md` §8.5、FR-033、FR-047b）。
 *
 * ⚠️ 這條橫幅存在的理由是「結案已經完成了」。紀錄在 CRM 上，回退它只會製造孤兒 ——
 *    因此這裡**沒有**「取消結案」或「重新寫入」的出路，只有「重試離開」。
 * ⚠️ 此時第 6 區塊**已經消失**，右欄回到 `expanded`：結案本身已經完成，
 *    面板上留著一份已經寫進去的草稿只會讓人以為還沒寫。
 *
 * ⚠️ `role="status"` 而非 `alert`：這是「事情做完了但還差一步」的通知，
 *    不是需要立刻打斷閱讀的錯誤。
 */

defineProps<{ recordId: string, busy?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div
    role="status"
    class="flex items-start gap-2 border-b px-4 py-2.5"
    :style="{
      background: 'var(--warn-bg)',
      borderColor: 'var(--warn-bd)',
      color: 'var(--text)',
    }"
  >
    <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" :style="{ color: 'var(--warn)' }" />
    <div class="min-w-0 flex-1">
      <p class="text-[0.9063rem] font-medium">{{ $t('closure.leaveFailed.title') }}</p>
      <p class="mt-0.5 text-[0.875rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
        {{ $t('closure.leaveFailed.body', { recordId }) }}
      </p>
    </div>
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      :loading="busy"
      class="shrink-0"
      @click="$emit('retry')"
    >
      {{ $t('closure.leaveFailed.retry') }}
    </UButton>
  </div>
</template>
