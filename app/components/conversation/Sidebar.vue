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
/**
 * 對話 status 的圓點配色（畫布 §8.2 逐字）。
 * ⚠️ 未列出的 status **不畫圓點**——憑空給一個顏色等於發明一個設計稿沒有的狀態。
 */
const STATUS_DOT: Record<string, string | undefined> = {
  active: 'var(--active)',
  open: 'var(--open)',
}

const CHANNEL_ICON: Record<string, string> = {
  web: '/icons/channel-web.png',
  line: '/icons/channel-line.png',
}

const props = defineProps<{
  items: Conversation[]
  activeId: string | null
  /** conversationId → 未讀批次數。⚠️ 會低估，原因見 `stores/conversations.ts` */
  unread: Map<string, number>
  loading: boolean
  error: string | null
  /** 篩選 chip 的計數（只數已載入的） */
  counts: { all: number, active: number, open: number }
  /** 平台回報的總數；null＝拿不到，此時不顯示分母 */
  total: number | null
  hasMore: boolean
  /** 已載到背景輪詢的涵蓋上限 —— 要說明原因，不能只是讓按鈕消失 */
  atCoverageLimit: boolean
}>()

const emit = defineEmits<{
  select: [string]
  refresh: []
  loadMore: []
  'update:query': [string]
}>()

const query = defineModel<string>('query', { default: '' })

/**
 * 篩選 chip（畫布 §8.2）—— 同一列 wrap，共五顆：
 * 「全部 N」「● active N」「● open N」「[icon] web」「[icon] line」。
 *
 * ⚠️ **狀態與頻道在畫布上是同一組單選**，不是兩個獨立維度 —— 五顆並排、只有一顆是選中態。
 * ⚠️ 頻道**由已載入的資料推導**，不寫死 web／line：組織開了新頻道時
 *    寫死的清單會安靜地少一顆 chip，而那不會有任何錯誤訊息。
 * ⚠️ 純前端篩選：計數與篩選都只作用在**已載入**的項目上，不是組織總量。
 */
type Filter = { kind: 'all' } | { kind: 'status', value: string } | { kind: 'channel', value: string }
const filter = ref<Filter>({ kind: 'all' })

function isActive(f: Filter): boolean {
  const cur = filter.value
  if (f.kind !== cur.kind) return false
  return f.kind === 'all' || f.value === (cur as { value: string }).value
}

/** 已載入資料裡出現過的頻道，依出現順序 —— 順序穩定，chip 不會每次重排 */
const channels = computed(() => {
  const seen: string[] = []
  for (const c of props.items) if (c.channel && !seen.includes(c.channel)) seen.push(c.channel)
  return seen
})

const channelCounts = computed(() => {
  const by: Record<string, number> = {}
  for (const c of props.items) if (c.channel) by[c.channel] = (by[c.channel] ?? 0) + 1
  return by
})

const visible = computed(() => {
  const f = filter.value
  if (f.kind === 'all') return props.items
  if (f.kind === 'status') return props.items.filter(c => c.status === f.value)
  return props.items.filter(c => c.channel === f.value)
})

/** 分組鍵：畫布只畫了「今天／昨天」，更早的用日期本身當標題 */
function groupKeyOf(c: Conversation): string {
  const iso = c.lastMessageAt ?? c.updatedAt
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 依分組切成區段。
 * ⚠️ 依賴 `items` 已經排好序（store 的 `sorted`）——這裡不重排，
 *    重排會讓側欄的順序與其他地方不一致。
 */
const sections = computed(() => {
  const out: Array<{ key: string, items: Conversation[] }> = []
  for (const c of visible.value) {
    const key = groupKeyOf(c)
    const last = out.at(-1)
    if (last && last.key === key) last.items.push(c)
    else out.push({ key, items: [c] })
  }
  return out
})

/**
 * 列項時間 —— 畫布 §8.2 是**絕對時間** `14:32`，不是相對時間。
 *
 * ⚠️ 這裡刻意不用相對時間（「3 分」）：那個字串**不會自己更新**，
 *    放著十分鐘後仍顯示「3 分」，是會過期的錯誤資訊。絕對時間沒有這個問題。
 * ⚠️ 只給時分、不給日期是安全的——跨日由日期分組標題（今天／昨天／MM/DD）承擔。
 *    若日後拿掉分組，這裡必須一併補上日期，否則昨天 14:32 與今天 14:32 看起來一樣。
 */
function clockTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
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

    <!--
      篩選 chip（畫布 §8.2）：同一列 wrap，五顆並排單選。
      ⚠️ 選中態是**實心 navy**（`--navy` 底、`--navy-fg` 字、無 border），
         不是淡底 —— 淡底在深色主題下與未選中幾乎分不出來。
      ⚠️ active／open 前面各有一個 6px 狀態圓點，配色與列項的圓點同一組 token。
    -->
    <div class="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pb-2" role="tablist" :aria-label="$t('sidebar.filter')">
      <button
        type="button"
        role="tab"
        :aria-selected="isActive({ kind: 'all' })"
        class="rounded-full px-2 py-0.5 text-[0.8125rem] transition-colors"
        :style="isActive({ kind: 'all' })
          ? { background: 'var(--navy)', color: 'var(--navy-fg)' }
          : { border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        @click="filter = { kind: 'all' }"
      >
        {{ $t('sidebar.filterAll') }} {{ counts.all }}
      </button>

      <button
        v-for="st in (['active', 'open'] as const)"
        :key="st"
        type="button"
        role="tab"
        :aria-selected="isActive({ kind: 'status', value: st })"
        class="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.8125rem] transition-colors"
        :style="isActive({ kind: 'status', value: st })
          ? { background: 'var(--navy)', color: 'var(--navy-fg)' }
          : { border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        @click="filter = { kind: 'status', value: st }"
      >
        <span class="size-1.5 shrink-0 rounded-full" :style="{ background: STATUS_DOT[st] }" aria-hidden="true" />
        {{ st }} {{ counts[st] }}
      </button>

      <!-- 頻道 chip：由已載入資料推導，不寫死 web／line -->
      <button
        v-for="ch in channels"
        :key="ch"
        type="button"
        role="tab"
        :aria-selected="isActive({ kind: 'channel', value: ch })"
        class="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.8125rem] transition-colors"
        :style="isActive({ kind: 'channel', value: ch })
          ? { background: 'var(--navy)', color: 'var(--navy-fg)' }
          : { border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        @click="filter = { kind: 'channel', value: ch }"
      >
        <img
          v-if="CHANNEL_ICON[ch]"
          :src="CHANNEL_ICON[ch]"
          :alt="ch"
          class="size-3 shrink-0 rounded-[3px] object-contain"
        >
        {{ ch }} {{ channelCounts[ch] }}
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
      v-else-if="visible.length === 0"
      class="px-3 py-8 text-center text-[0.90625rem]"
      :style="{ color: 'var(--text-3)' }"
    >
      {{ $t('sidebar.empty') }}
    </p>

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <template v-for="section in sections" :key="section.key">
        <!-- 日期分組（畫布 §8.2）：sticky，捲動時仍看得到目前在哪一天 -->
        <div
          class="sticky top-0 z-[1] border-b px-3 py-1 text-[0.8125rem] font-bold tracking-[.08em]"
          :style="{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-3)' }"
        >
          {{ section.key }}
        </div>
        <ul>
          <li v-for="c in section.items" :key="c.id">
        <button
          type="button"
          class="w-full border-b border-l-[3px] px-3 py-2.5 text-left transition-colors"
          :style="{
            borderBottomColor: 'var(--border)',
            // 畫布 §8.2：選中態是 navy-soft 底 ＋ 左側 3px navy 色條。
            // ⚠️ 未選中時左邊框是透明而非 0 寬——否則選中時整列會位移 3px。
            borderLeftColor: c.id === activeId ? 'var(--navy)' : 'transparent',
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

            <span class="ac-mono min-w-0 truncate text-[0.9375rem] font-medium">
              {{ c.name || c.contactId }}
            </span>

            <!--
              對話 status 圓點（畫布 §8.2）。
              ⚠️ **這是 status，不是 presence。** 畫布原始碼的 title 只有 active／open 兩個值，
                 配色 --active／--open。presence 標記是另一回事，在第二行末端。
              ⚠️ 憲法 8.1：顏色不是唯一資訊來源，故一律帶 title/aria-label。
            -->
            <span
              v-if="STATUS_DOT[c.status]"
              class="size-1.5 shrink-0 rounded-full"
              :style="{ background: STATUS_DOT[c.status] }"
              :title="c.status"
              :aria-label="c.status"
            />

            <span class="flex-1" />

            <!--
              未讀徽記：只在非聚焦對話上亮。
              ⚠️ **刻意是圓點而不是畫布的數字**（2026-08-29 使用者裁定）：
                 我方唯一的新訊息訊號是 `last_message_at` 跳動，一次輪詢間隔（前景 3 秒）內
                 來幾則都只跳一次，數出來的是「批次數」不是「則數」。與其顯示一個會低估的
                 數字，不如只表達準確的那一件事——「有新訊息」。
                 平台若日後提供未讀數或訊息則數，這裡再改回數字。
            -->
            <span
              v-if="unread.has(c.id)"
              class="size-1.5 shrink-0 rounded-full"
              :style="{ background: 'var(--navy-2)' }"
              :aria-label="$t('sidebar.unread')"
            />

            <time class="ac-mono shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
              {{ clockTime(c.lastMessageAt ?? c.updatedAt) }}
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
      </template>

      <!-- 底部三項（畫布 §8.2） -->
      <div class="space-y-1 px-3 py-3 text-center text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        <button
          v-if="hasMore"
          type="button"
          class="w-full rounded-md border py-1 transition-opacity hover:opacity-70 disabled:opacity-50"
          :style="{ borderColor: 'var(--border)' }"
          :disabled="loading"
          @click="emit('loadMore')"
        >
          {{ loading ? $t('common.loading') : $t('sidebar.loadMore') }}
        </button>
        <p>
          {{ total === null
            ? $t('sidebar.shownOnly', { n: visible.length })
            : $t('sidebar.shown', { n: visible.length, total }) }}
        </p>
        <!-- ⚠️ 按鈕消失時 MUST 說明原因，否則看起來像壞掉（憲法 3.2：降級要看得見） -->
        <p v-if="atCoverageLimit">{{ $t('sidebar.coverageLimit', { n: items.length }) }}</p>
        <p>{{ $t('sidebar.sortedBy') }}</p>
      </div>
    </div>
  </aside>
</template>
