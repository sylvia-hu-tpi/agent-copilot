<script setup lang="ts">
/**
 * 側欄對話列表 —— docs/ARCHITECTURE.md §14.1 / §14.2。
 *
 * ⚠️ 對話名稱實際是 `TWN#GW4772` 這類代號而非人名，因此以等寬字顯示 ——
 *    這類代號是要逐字核對的東西。`name` 可能為空，退回 `contactId`。
 *
 * ⚠️ **`mode` 徽記只顯示「有人能送出訊息」，不顯示「有人在看」。**
 *    `automation` 對「沒人」與「有人但唯讀觀察」無法區分（§10.2），
 *    所以沒有值的時候什麼都不標，而不是標成「無人」。
 */

import type { Conversation } from '#shared/types/conversation'
import { someoneElseCanSend } from '#shared/types/conversation'

/** 頭像色階：沿用既有 token 配對，不另外發明新色票 */
const AVATAR_PALETTE = [
  { bg: 'var(--navy-soft)', fg: 'var(--navy)' },
  { bg: 'var(--active-bg)', fg: 'var(--active)' },
  { bg: 'var(--ai-bg)', fg: 'var(--ai)' },
  { bg: 'var(--agent-bg)', fg: 'var(--navy-2)' },
  { bg: 'var(--warn-bg)', fg: 'var(--warn)' },
  { bg: 'var(--open-bg)', fg: 'var(--open)' },
] as const

/** 依名稱／代號決定固定的頭像配色，同一對話每次渲染都要拿到同一組顏色 */
function avatarColor(key: string): { bg: string, fg: string } {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]!
}

/**
 * 頭像縮寫：`TWN#GW4772` 這類代號取 `#` 後兩個字母（如 `GW`）；
 * 真人姓名（如「高翊庭」）無此樣式，中文取首字、其餘取前兩碼並轉大寫。
 */
function avatarLabel(c: Conversation): string {
  const src = (c.name || c.contactId || '').trim()
  const coded = src.match(/#([a-zA-Z]{2})/)
  if (coded) return coded[1]!.toUpperCase()
  if (!src) return '?'
  return /[一-鿿]/.test(src[0]!) ? src.slice(0, 1) : src.slice(0, 2).toUpperCase()
}

/**
 * 頻道 icon：自訂圖檔，放在 `public/icons/`（見檔名對應）。
 * 沒有對應圖檔的頻道維持原本的文字徽記。
 */
const CHANNEL_ICON: Record<string, string> = {
  web: '/icons/channel-web.png',
  line: '/icons/channel-line.png',
}

defineProps<{
  items: Conversation[]
  activeId: string | null
  unread: Set<string>
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  select: [string]
  refresh: []
  'update:query': [string]
}>()

const query = defineModel<string>('query', { default: '' })

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return '剛剛'
  if (mins < 60) return `${mins} 分`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 時`
  return `${Math.floor(hours / 24)} 天`
}
</script>

<template>
  <aside
    class="flex h-full min-h-0 w-full flex-col border-r"
    :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
  >
    <div class="flex shrink-0 items-center gap-2 px-3 py-2.5">
      <div class="ac-input flex h-9 flex-1 items-center gap-2 px-2.5">
        <UIcon name="i-lucide-search" class="size-[14px] shrink-0" :style="{ color: 'var(--text-3)' }" />
        <input
          v-model="query"
          type="search"
          :placeholder="$t('common.search')"
          :aria-label="$t('common.search')"
          class="h-full w-full bg-transparent text-[0.9375rem] outline-none placeholder:opacity-60"
          @keydown.enter="emit('refresh')"
        >
      </div>
      <button
        type="button"
        class="shrink-0 rounded-md p-1.5 transition-opacity hover:opacity-70 disabled:opacity-50"
        :style="{ color: 'var(--text-3)' }"
        :disabled="loading"
        :aria-label="$t('common.refresh')"
        :title="$t('common.refresh')"
        @click="emit('refresh')"
      >
        <UIcon name="i-lucide-refresh-cw" class="size-3.5" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <p v-if="error" class="ac-alert-warn mx-3 flex items-start gap-2 px-2.5 py-1.5">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ error }}</span>
    </p>

    <div v-else-if="loading && items.length === 0" class="space-y-3 p-3">
      <div v-for="n in 5" :key="n" class="space-y-1.5">
        <div class="ac-skel ac-skel-shimmer h-3" :style="{ width: `${70 - n * 6}%` }" />
        <div class="ac-skel h-2 w-1/3" />
      </div>
    </div>

    <p
      v-else-if="items.length === 0"
      class="px-3 py-8 text-center text-[0.90625rem]"
      :style="{ color: 'var(--text-3)' }"
    >
      {{ $t('sidebar.empty') }}
    </p>

    <ul v-else class="min-h-0 flex-1 overflow-y-auto">
      <li v-for="c in items" :key="c.id">
        <button
          type="button"
          class="w-full border-b px-3 py-2.5 text-left transition-colors"
          :style="{
            borderColor: 'var(--border)',
            background: c.id === activeId ? 'var(--navy-soft)' : 'transparent',
          }"
          :aria-current="c.id === activeId ? 'true' : undefined"
          @click="emit('select', c.id)"
        >
          <div class="flex items-center gap-2">
            <span
              class="ac-mono flex size-7 shrink-0 items-center justify-center rounded-full text-[0.8125rem] font-semibold"
              :style="{ background: avatarColor(c.name || c.contactId).bg, color: avatarColor(c.name || c.contactId).fg }"
            >{{ avatarLabel(c) }}</span>

            <!-- 未讀徽記：只在非聚焦對話上亮 -->
            <span
              v-if="unread.has(c.id)"
              class="size-1.5 shrink-0 rounded-full"
              :style="{ background: 'var(--navy-2)' }"
              :aria-label="$t('sidebar.unread')"
            />
            <span class="ac-mono min-w-0 flex-1 truncate text-[0.9375rem] font-medium">
              {{ c.name || c.contactId }}
            </span>
            <time class="ac-mono shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
              {{ relativeTime(c.lastMessageAt ?? c.updatedAt) }}
            </time>
          </div>

          <div class="mt-1 flex items-center gap-1.5 pl-9 text-[0.8125rem]">
            <img
              v-if="CHANNEL_ICON[c.channel]"
              :src="CHANNEL_ICON[c.channel]"
              :alt="c.channel"
              :title="c.channel"
              class="size-3.5 shrink-0 object-contain"
            >
            <span
              v-else
              class="rounded-full px-1.5 py-0.5"
              :style="{ background: 'var(--surface-3)', color: 'var(--text-2)' }"
            >{{ c.channel }}</span>
            <span
              class="rounded-full border px-1.5 py-0.5"
              :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-3)' }"
            >{{ c.status }}</span>
            <!--
              ⚠️ 只在「有人能送出訊息」時標記。沒有值的時候什麼都不標 ——
                 automation 對「沒人」與「有人但唯讀」無法區分（§10.2）
            -->
            <span
              v-if="someoneElseCanSend(c.mode)"
              class="ml-auto flex items-center gap-1 rounded-full px-1.5 py-0.5"
              :style="{ background: 'var(--active-bg)', color: 'var(--active)' }"
              :title="$t('presence.unidentified')"
            >
              <UIcon name="i-lucide-user-check" class="size-3.5" />
            </span>
          </div>
        </button>
      </li>
    </ul>
  </aside>
</template>
