<script setup lang="ts">
/**
 * 知識庫自然語言快查 —— specs/002-suggestion-knowledge-search FR-007～FR-011、FR-022。
 *
 * 四種可互相區分的狀態：尚未輸入查詢／查無相關結果（FR-011）／錯誤（degraded）＋重試／需先 JOIN。
 *
 * ⚠️ 不顯示 `score` 或任何獨立編號——iMBrace 知識庫沒有正式的 SOP 編號制度，
 *    硬湊一個只是呼應設計稿的過度設計（research.md #2）。
 */

import type { KnowledgeHit } from '#shared/types/knowledge'

const props = defineProps<{ conversationId: string }>()
const emit = defineEmits<{ insert: [text: string] }>()

const { t, locale } = useI18n()
const conversationId = computed(() => props.conversationId)
const search = useKnowledgeSearch(conversationId)

/** 超過 12 個月視為過舊（FR-009），updatedAt 為 null 時不觸發（研究 #2：不謊報） */
function isStale(updatedAt: string | null): boolean {
  if (!updatedAt) return false
  const ms = Date.now() - new Date(updatedAt).getTime()
  return ms > 365 * 24 * 60 * 60 * 1000
}

function formatDate(updatedAt: string | null): string {
  if (!updatedAt) return t('copilot.knowledgeSearch.updatedAtUnknown')
  return new Date(updatedAt).toLocaleDateString(locale.value)
}

/** ref（sourceRef.ref）→ 展開全文取回的片段列表；只有按過「展開全文」的項目才有值 */
const expanded = ref<Record<string, string[]>>({})
const expanding = ref<Record<string, boolean>>({})

async function onExpand(hit: KnowledgeHit): Promise<void> {
  const ref = hit.sourceRef.ref
  expanding.value = { ...expanding.value, [ref]: true }
  try {
    const more = await search.expand(ref)
    expanded.value = { ...expanded.value, [ref]: more.map(h => h.snippet) }
  }
  finally {
    expanding.value = { ...expanding.value, [ref]: false }
  }
}
</script>

<template>
  <section class="ac-card space-y-3 p-4">
    <h2 class="ac-status-label">{{ t('copilot.knowledgeSearch.title') }}</h2>

    <input
      v-model="search.query.value"
      type="text"
      class="w-full rounded-lg border px-3 py-2 text-[0.9375rem]"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
      :placeholder="t('copilot.knowledgeSearch.placeholder')"
    >

    <!-- 需先 JOIN -->
    <p v-if="search.notJoined.value" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
      <UIcon name="i-lucide-lock" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.knowledgeSearch.notJoined') }}</span>
    </p>

    <!-- 錯誤（degraded）＋重試 -->
    <div v-else-if="search.degraded.value" class="ac-alert-warn flex items-center justify-between gap-2 px-3 py-2">
      <span class="flex items-center gap-2">
        <UIcon name="i-lucide-wifi-off" class="size-3.5 shrink-0" />
        {{ t('copilot.knowledgeSearch.degraded') }}
      </span>
      <button type="button" class="rounded-md p-1 transition-opacity hover:opacity-70" @click="search.search()">
        <UIcon name="i-lucide-rotate-cw" class="size-4" />
      </button>
    </div>

    <p v-else-if="search.error.value" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ search.error.value }}</span>
    </p>

    <!-- 尚未輸入查詢 -->
    <p v-else-if="!search.hasQueried.value" class="text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.knowledgeSearch.empty') }}
    </p>

    <!-- 查無相關結果（FR-011） -->
    <p v-else-if="!search.loading.value && search.hits.value.length === 0" class="text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.knowledgeSearch.noResults') }}
    </p>

    <div v-else-if="search.loading.value && search.hits.value.length === 0" class="space-y-2">
      <div class="ac-skel ac-skel-shimmer h-10 w-full" />
    </div>

    <!-- 結果列表 -->
    <ul v-else class="space-y-3">
      <li v-for="hit in search.hits.value" :key="hit.id" class="space-y-1.5 border-t pt-2 first:border-t-0 first:pt-0" :style="{ borderColor: 'var(--border)' }">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[0.9375rem] font-medium">{{ hit.title }}</span>
          <span
            class="flex items-center gap-1 text-[0.8125rem]"
            :style="{ color: isStale(hit.updatedAt) ? 'var(--warn)' : 'var(--text-3)' }"
          >
            <UIcon v-if="isStale(hit.updatedAt)" name="i-lucide-alert-triangle" class="size-3" />
            {{ formatDate(hit.updatedAt) }}
          </span>
        </div>
        <p class="text-[0.875rem]" :style="{ color: 'var(--text-2)' }">{{ hit.snippet }}</p>

        <div v-if="expanded[hit.sourceRef.ref]" class="space-y-1 rounded-lg p-2" :style="{ background: 'var(--surface-3)' }">
          <p v-for="(snippet, i) in expanded[hit.sourceRef.ref]" :key="i" class="text-[0.8125rem]" :style="{ color: 'var(--text-2)' }">
            {{ snippet }}
          </p>
          <p class="text-[0.75rem]" :style="{ color: 'var(--text-3)' }">{{ t('copilot.knowledgeSearch.expandDisclaimer') }}</p>
        </div>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="h-7 rounded-lg border px-2.5 text-[0.8125rem]"
            :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
            :disabled="expanding[hit.sourceRef.ref]"
            @click="onExpand(hit)"
          >
            {{ t('copilot.knowledgeSearch.expand') }}
          </button>
          <button
            type="button"
            class="ac-btn-primary h-7 px-2.5 text-[0.8125rem]"
            @click="emit('insert', hit.snippet)"
          >
            {{ t('copilot.knowledgeSearch.insert') }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
