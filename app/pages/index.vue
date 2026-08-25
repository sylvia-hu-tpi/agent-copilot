<script setup lang="ts">
/**
 * 對話列表 —— M0 驗收「能列出對話清單」。
 *
 * M1 會把它換成側欄 + 三欄工作區（§14.1，設計稿 artboard 1c/1d），並接上輪詢與 SSE。
 * 此處刻意只做一次性讀取，不做輪詢 —— 輪詢策略是 M1 的主題（§9）。
 *
 * ⚠️ 對話名稱實際是 `TWN#GW4772` 這類代號而非人名，故以等寬字顯示，
 *    且 name 可能為空 —— 退回 contactId。
 */

import type { Conversation } from '#shared/types/conversation'

definePageMeta({ layout: 'console' })

const q = ref('')
const { data, status, error, refresh } = await useFetch<{ items: Conversation[] }>(
  '/api/conversations',
  { query: { q }, default: () => ({ items: [] }) },
)

const items = computed(() => data.value?.items ?? [])
const loading = computed(() => status.value === 'pending')

function messageOf(err: unknown): string {
  const e = err as { statusMessage?: string, data?: { message?: string } }
  return e?.data?.message || e?.statusMessage || '讀取對話清單失敗'
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-4 p-5">
    <div class="flex gap-2">
      <div class="ac-input flex flex-1 items-center gap-2 px-3">
        <UIcon name="i-lucide-search" class="size-[15px] shrink-0" :style="{ color: 'var(--text-3)' }" />
        <input
          v-model="q"
          type="search"
          placeholder="搜尋對話…"
          class="h-full w-full bg-transparent text-[13.5px] outline-none placeholder:opacity-60"
        >
      </div>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg border px-3 text-[12.5px] transition-colors disabled:opacity-50"
        :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
        :disabled="loading"
        @click="refresh()"
      >
        <UIcon
          name="i-lucide-refresh-cw"
          class="size-3.5"
          :class="{ 'animate-spin': loading }"
        />
        重新整理
      </button>
    </div>

    <p v-if="error" class="ac-alert-warn flex items-start gap-2 px-3 py-2.5">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ messageOf(error) }}</span>
    </p>

    <div v-else-if="loading && items.length === 0" class="ac-card space-y-4 p-4">
      <div v-for="n in 3" :key="n" class="space-y-2">
        <div class="ac-skel ac-skel-shimmer h-3.5" :style="{ width: `${60 - n * 8}%` }" />
        <div class="ac-skel h-2.5 w-1/4" />
      </div>
    </div>

    <p
      v-else-if="items.length === 0"
      class="py-10 text-center text-[12.5px]"
      :style="{ color: 'var(--text-3)' }"
    >
      沒有符合的對話。
    </p>

    <ul v-else class="ac-card divide-y overflow-hidden" :style="{ borderColor: 'var(--border)' }">
      <li
        v-for="c in items"
        :key="c.id"
        class="px-4 py-3"
        :style="{ borderColor: 'var(--border)' }"
      >
        <div class="flex items-baseline gap-2">
          <span class="ac-mono truncate text-[13.5px] font-medium">
            {{ c.name || c.contactId }}
          </span>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[10.5px]"
            :style="{ background: 'var(--surface-3)', color: 'var(--text-2)' }"
          >{{ c.channel }}</span>
          <span
            class="shrink-0 rounded-full border px-2 py-0.5 text-[10.5px]"
            :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-3)' }"
          >{{ c.status }}</span>
          <time class="ac-mono ml-auto shrink-0 text-[11px]" :style="{ color: 'var(--text-3)' }">
            {{ c.updatedAt }}
          </time>
        </div>
        <!-- ⚠️ §10.2：users[] 實測 12/12 全空，這一行大多數時候不會出現，這是常態 -->
        <p v-if="c.operators.length" class="mt-1 text-[11.5px]" :style="{ color: 'var(--text-3)' }">
          {{ c.operators.map(o => o.name).join('、') }}
        </p>
      </li>
    </ul>
  </div>
</template>
