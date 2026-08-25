<script setup lang="ts">
/**
 * 對話列表 —— M0 驗收「能列出對話清單」。
 *
 * M1 會把它換成側欄 + 三欄工作區（§14.1），並接上輪詢與 SSE。
 * 此處刻意只做一次性讀取，不做輪詢 —— 輪詢策略是 M1 的主題（§9）。
 */

import type { Conversation } from '#shared/types/conversation'

definePageMeta({ layout: 'console' })

const q = ref('')
const { data, status, error, refresh } = await useFetch<{ items: Conversation[] }>(
  '/api/conversations',
  { query: { q }, default: () => ({ items: [] }) },
)

const items = computed(() => data.value?.items ?? [])

function messageOf(err: unknown): string {
  const e = err as { statusMessage?: string, data?: { message?: string } }
  return e?.statusMessage || e?.data?.message || '讀取對話清單失敗'
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-4 space-y-4">
    <div class="flex gap-2">
      <UInput v-model="q" placeholder="搜尋對話…" class="flex-1" />
      <UButton
        variant="subtle"
        icon="i-lucide-refresh-cw"
        :loading="status === 'pending'"
        @click="refresh()"
      >
        重新整理
      </UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :description="messageOf(error)" />

    <USkeleton v-else-if="status === 'pending' && items.length === 0" class="h-24 w-full" />

    <p v-else-if="items.length === 0" class="py-8 text-center text-sm text-muted">
      沒有符合的對話。
    </p>

    <ul v-else class="divide-y divide-default rounded-lg border border-default">
      <li v-for="c in items" :key="c.id" class="px-4 py-3">
        <div class="flex items-baseline gap-2">
          <span class="truncate font-medium text-highlighted">{{ c.name || c.contactId }}</span>
          <UBadge color="neutral" variant="subtle" size="sm">{{ c.channel }}</UBadge>
          <UBadge color="neutral" variant="outline" size="sm">{{ c.status }}</UBadge>
          <time class="ml-auto shrink-0 text-xs text-muted">{{ c.updatedAt }}</time>
        </div>
        <p v-if="c.operators.length" class="mt-1 text-xs text-muted">
          {{ c.operators.map(o => o.name).join('、') }}
        </p>
      </li>
    </ul>
  </div>
</template>
