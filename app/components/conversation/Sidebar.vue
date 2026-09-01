<script lang="ts">
/**
 * 日期區間的收合狀態 —— **刻意宣告在模組層，不在 `setup()` 裡。**
 *
 * ⚠️ 放進元件內會有一個看起來完全不相干的症狀：**點另一則對話，收起來的區間全部彈開**
 *    （2026-09-01 實機驗收發現）。成因不在這個元件：`<NuxtPage>` 預設的 key 是
 *    **把路由參數代入後的路徑**（Nuxt 的 `generateRouteKey` → `interpolatePath`），
 *    `/c/A` 換到 `/c/B` 就是換了一個 key，整個 page 元件連同左欄一起 unmount／remount，
 *    元件內的 `ref` 回到初始值。畫面上像是「收合狀態被重設」，實際上是整個左欄重建了。
 *    ⚠️ **不要改用 `definePageMeta({ key })` 去阻止 remount** —— 那會讓對話頁的其他狀態
 *    跨對話殘留（草稿、面板、SSE 訂閱都掛在 page 上），代價遠大於這個問題本身。
 *
 * ⚠️ 模組層 `ref` 在此是安全的：本專案 `ssr: false`（`nuxt.config.ts`），
 *    沒有跨請求共用狀態的問題；同一時間也只會有一個左欄實例。
 *
 * ⚠️ **記「收起來的」而不是「展開的」** —— 新的一天會長出新的區間，
 *    存展開集合的話新區間預設會是收合的（不在集合裡），而預設必須是展開。
 *
 * ⚠️ **仍然刻意不存 `localStorage`**（左右欄寬與中欄資訊列都有存）。
 *    這裡的 key 是日期，存下去等於在瀏覽器裡累積一份永遠不會被清掉的舊日期清單，
 *    而「三週前那天是收合的」對明天的工作沒有任何意義。
 *    ⚠️ 這與上面那條不衝突：**重新整理後回到全展開**是對的，
 *    **切換對話時保持不變**也是對的 —— 前者是新的一次使用，後者是同一次使用裡的同一個動作。
 */
const collapsedGroups = ref(new Set<string>())
</script>

<script setup lang="ts">
/**
 * 側欄對話列表 —— docs/ARCHITECTURE.md §14.1 / §14.2。
 *
 * ⚠️ 對話名稱實際是 `TWN#GW4772` 這類代號而非人名，因此以等寬字顯示 ——
 *    這類代號是要逐字核對的東西。`name` 可能為空，退回 `contactId`。
 *
 * ⚠️ **第二行的 presence 標記只顯示「有人能送出訊息」，不顯示「有人在看」。**
 *    `automation` 對「沒人」與「有人但唯讀觀察」無法區分（§10.2），
 *    所以沒有值的時候什麼都不標，而不是標成「無人」。
 *
 * ⚠️ **`viewerJoined`（「你在此對話中」）不是平台清單給的欄位，是 BFF 解析後補上的**
 *    —— 清單實測 0/16 沒有 `is_joined`（§10.2.1）。解析有單輪上限，因此它可能是
 *    `undefined`（＝「還不知道」）。判斷一律用 `=== true`，見 template 內的說明。
 */

import type { Conversation } from '#shared/types/conversation'
import { someoneElseCanSend } from '#shared/types/conversation'

/**
 * ⚠️ 頭像／status 色／頻道 icon 一律從 `app/utils/conversation-display.ts` 取，
 *    **不要在這裡另寫一份** —— 中欄標題列用的是同一組規則，兩處長不一樣時
 *    客服點進對話會看到「換了一個對話」的錯覺，而那不會有任何型別錯誤。
 */

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
  /**
   * 這一頁支不支援收合側欄（畫布 §8.1 的收合鈕在搜尋列右側）。
   *
   * ⚠️ 首頁（`index.vue`）刻意**不給**：那一頁的內容就是這份清單，收掉它之後
   *    整頁只剩一個空狀態，等於做出一個「把唯一內容藏起來」的按鈕。
   */
  collapsible?: boolean
}>()

const emit = defineEmits<{
  select: [string]
  refresh: []
  loadMore: []
  collapse: []
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

/**
 * 分組：畫布只畫了「今天／昨天」，更早的用日期本身當標題。
 *
 * 回傳**兩個**值：`key` 是穩定的日期識別（收合狀態掛在它上面），
 * `label` 是會隨時間改變的顯示文字。理由見函式內的說明。
 */
function groupKeyOf(c: Conversation): { key: string, label: string } {
  const iso = c.lastMessageAt ?? c.updatedAt
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { key: '-', label: '—' }
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  /*
    ⚠️ **`key` 是日期本身，不是顯示文字。** 收合狀態掛在 `key` 上，而顯示文字會變
       ——今天的那一組明天就叫「昨天」。用文字當 key 的話，跨過午夜或使用者長時間開著
       分頁時，收合狀態會**留在「今天」這個位置上**而不是跟著那批對話走，
       看起來就像自己跳到別組去了。這不會有型別錯誤。
  */
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  if (diff <= 0) return { key, label: '今天' }
  if (diff === 1) return { key, label: '昨天' }
  return { key, label: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}` }
}

/**
 * 依分組切成區段。
 * ⚠️ 依賴 `items` 已經排好序（store 的 `sorted`）——這裡不重排，
 *    重排會讓側欄的順序與其他地方不一致。
 */
const sections = computed(() => {
  const out: Array<{ key: string, label: string, items: Conversation[] }> = []
  for (const c of visible.value) {
    const { key, label } = groupKeyOf(c)
    const last = out.at(-1)
    if (last && last.key === key) last.items.push(c)
    else out.push({ key, label, items: [c] })
  }
  return out
})

/** 日期區間的收合（畫布 §8.2，2026-08-31 新增）—— 狀態本身在檔首的模組層 `<script>` 裡，理由見該處 */
function toggleGroup(key: string): void {
  // ⚠️ 換一個新的 Set —— 直接 mutate 的話 `has()` 的依賴追蹤不會觸發重繪
  const next = new Set(collapsedGroups.value)
  if (!next.delete(key)) next.add(key)
  collapsedGroups.value = next
}

/**
 * 列項時間 —— 畫布 §8.2 是**絕對時間** `14:32`，不是相對時間。
 *
 * ⚠️ 這裡刻意不用相對時間（「3 分」）：那個字串**不會自己更新**，
 *    放著十分鐘後仍顯示「3 分」，是會過期的錯誤資訊。絕對時間沒有這個問題。
 * ⚠️ 只給時分、不給日期是安全的——跨日由日期分組標題（今天／昨天／MM/DD）承擔。
 *    若日後拿掉分組，這裡必須一併補上日期，否則昨天 14:32 與今天 14:32 看起來一樣。
 */
/**
 * 「清除搜尋與篩選」（畫布 §9）。
 * ⚠️ 只有真的有東西可清才顯示按鈕 —— 見 template 的說明。
 */
const canClear = computed(() => query.value.trim() !== '' || filter.value.kind !== 'all')

function clearFilters(): void {
  query.value = ''
  filter.value = { kind: 'all' }
}

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

      <!-- 收合鈕（畫布 §8.1）：在搜尋列右側，不在中欄標題列 —— 收合的對象是這一欄，
           按鈕就該在這一欄上，而不是在被它擠開的那一欄上 -->
      <button
        v-if="collapsible"
        type="button"
        class="flex size-[30px] shrink-0 items-center justify-center rounded-lg border transition-opacity hover:opacity-70"
        :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        :aria-label="$t('sidebar.collapse')"
        :aria-expanded="true"
        :title="$t('sidebar.collapse')"
        @click="emit('collapse')"
      >
        <UIcon name="i-lucide-panel-left-close" class="size-3.5" />
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
        {{ $t('sidebar.filterAll') }}<span class="ac-mono">{{ counts.all }}</span>
      </button>

      <button
        v-for="st in (['active', 'open'] as const)"
        :key="st"
        type="button"
        role="tab"
        :aria-selected="isActive({ kind: 'status', value: st })"
        class="flex items-center gap-[5px] rounded-full px-[9px] py-1 text-[0.84375rem] leading-[1.35] transition-colors"
        :style="isActive({ kind: 'status', value: st })
          ? { background: 'var(--navy)', color: 'var(--navy-fg)' }
          : { border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        @click="filter = { kind: 'status', value: st }"
      >
        <span class="size-1.5 shrink-0 rounded-full" :style="{ background: STATUS_COLOR[st]?.fg }" aria-hidden="true" />
        {{ st }}<span class="ac-mono" :style="isActive({ kind: 'status', value: st }) ? undefined : { color: 'var(--text)' }">{{ counts[st] }}</span>
      </button>

      <!-- 頻道 chip：由已載入資料推導，不寫死 web／line -->
      <button
        v-for="ch in channels"
        :key="ch"
        type="button"
        role="tab"
        :aria-selected="isActive({ kind: 'channel', value: ch })"
        class="flex items-center gap-[5px] rounded-full px-[9px] py-1 text-[0.84375rem] leading-[1.35] transition-colors"
        :style="isActive({ kind: 'channel', value: ch })
          ? { background: 'var(--navy)', color: 'var(--navy-fg)' }
          : { border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
        @click="filter = { kind: 'channel', value: ch }"
      >
        <img
          v-if="CHANNEL_ICON[ch]"
          :src="CHANNEL_ICON[ch]"
          :alt="ch"
          class="block size-3 shrink-0 self-center rounded-[3px] object-contain"
        >
        {{ ch }}<span class="ac-mono" :style="isActive({ kind: 'channel', value: ch }) ? undefined : { color: 'var(--text)' }">{{ channelCounts[ch] }}</span>
      </button>
    </div>

    <p v-if="error" class="ac-alert-warn mx-3 flex items-start gap-2 px-2.5 py-1.5">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ error }}</span>
    </p>

    <!-- 骨架：畫布 §9 是 **6 列**，每列為圓形頭像 ＋ 兩行文字 —— 列數與形狀都照抄，
         否則載入完成的瞬間版面會抽動一下（骨架與真實列不同高） -->
    <div v-else-if="loading && items.length === 0" class="space-y-3 p-3">
      <div v-for="n in 6" :key="n" class="flex items-center gap-2.5">
        <div class="ac-skel size-[30px] shrink-0 rounded-full" />
        <div class="flex-1 space-y-1.5">
          <div class="ac-skel ac-skel-shimmer h-2.5 w-[64%]" />
          <div class="ac-skel h-2 w-[86%]" />
        </div>
      </div>
    </div>

    <!--
      清單為空（畫布 §9 / 1d-empty）：icon ＋ 標題 ＋ 說明 ＋「清除搜尋與篩選」。
      ⚠️ 按鈕**只在真的有東西可清時才出現**。組織本來就沒有對話時按它不會有任何變化，
         那種「按了沒反應」的按鈕比沒有按鈕更讓人懷疑系統壞了。
    -->
    <div
      v-else-if="visible.length === 0"
      class="flex flex-col items-center gap-2 px-5 py-8 text-center"
    >
      <UIcon name="i-lucide-search-x" class="size-5" :style="{ color: 'var(--text-3)' }" />
      <p class="text-[0.90625rem] font-medium">{{ $t('sidebar.emptyTitle') }}</p>
      <p class="text-[0.84375rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
        {{ $t('sidebar.emptyHint') }}
      </p>
      <button
        v-if="canClear"
        type="button"
        class="mt-1 h-7 rounded-lg border px-2.5 text-[0.84375rem]"
        :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text)' }"
        @click="clearFilters"
      >
        {{ $t('sidebar.clearFilters') }}
      </button>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <template v-for="(section, si) in sections" :key="section.key">
        <!--
          日期分組（畫布 §8.2）：sticky，捲動時仍看得到目前在哪一天。
          右端是收合鈕（畫布 2026-08-31 新增）—— 20×20、無邊框、透明底，
          hover 才浮出 `--surface-3`。它是次要控制項，常態下不該與列項搶注意力。
        -->
        <div
          class="sticky top-0 z-[1] flex items-center gap-2 border-b py-[3px] pl-3 pr-1.5"
          :class="{ 'border-t': si > 0 }"
          :style="{ background: 'var(--surface-2)', borderColor: 'var(--border)' }"
        >
          <span
            class="text-[0.8125rem] font-bold tracking-[.08em]"
            :style="{ color: 'var(--text-3)' }"
          >{{ section.label }}</span>

          <span class="min-w-0 flex-1" />

          <!--
            ⚠️ 收合後**必須讓「裡面還有幾個」看得見**（畫布只畫了箭頭）。
               收起來之後那一整批對話從畫面上消失，沒有數量的話這一列等於在說
               「這裡什麼都沒有」——而客服收合的目的正是「先擱著，等一下回來看」。
               同一個理由已經用在左欄收合態的徽記上（D-21）。
          -->
          <span
            v-if="collapsedGroups.has(section.key)"
            class="ac-mono shrink-0 text-[0.75rem]"
            :style="{ color: 'var(--text-3)' }"
          >{{ section.items.length }}</span>

          <button
            type="button"
            class="ac-group-toggle flex size-5 shrink-0 items-center justify-center rounded-[5px]"
            :aria-expanded="!collapsedGroups.has(section.key)"
            :aria-label="collapsedGroups.has(section.key)
              ? $t('sidebar.expandGroup', { date: section.label })
              : $t('sidebar.collapseGroup', { date: section.label })"
            :title="collapsedGroups.has(section.key)
              ? $t('sidebar.expandGroupHint')
              : $t('sidebar.collapseGroupHint')"
            @click="toggleGroup(section.key)"
          >
            <UIcon
              :name="collapsedGroups.has(section.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
              class="size-3.5"
            />
          </button>
        </div>
        <ul v-if="!collapsedGroups.has(section.key)">
          <li v-for="c in section.items" :key="c.id">
        <button
          type="button"
          class="w-full border-b border-l-[3px] px-3 py-2.5 text-left transition-colors"
          :style="{
            /*
              ⚠️ **選中列不畫下框線**（畫布 1c）：選中態是一整塊 `--navy-soft` 底，
                 一條 `--border` 橫切過去會把那一塊切成上下兩半，看起來像兩列各選了一半。
                 用 transparent 而非拿掉 border 寬度 —— 否則選中時整列會位移 1px。
            */
            borderBottomColor: c.id === activeId ? 'transparent' : 'var(--border)',
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
            >{{ avatarLabel(c.name || c.contactId) }}</span>

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
              v-if="STATUS_COLOR[c.status]"
              class="size-1.5 shrink-0 rounded-full"
              :style="{ background: STATUS_COLOR[c.status]?.fg }"
              :title="c.status"
              :aria-label="c.status"
            />

            <span class="flex-1" />

            <time class="ac-mono shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
              {{ clockTime(c.lastMessageAt ?? c.updatedAt) }}
            </time>
          </div>

          <!--
            第二行（畫布 §8.2，2026-09-01 版）：
            `[頻道 icon] [presence icon＋文字] ←彈性→ [未讀圓點＋「未讀」]`

            ⚠️ **未讀在第二行右端，不在第一行。** 第一行是「代號 · status · 時間」——
               那三樣是這則對話的身分，未讀是它此刻的狀態，畫布把兩者分層了。
            ⚠️ presence 與未讀都是 **icon／圓點 ＋ 文字**，不是純圖示（憲法 8.1：
               顏色與形狀不是唯一資訊來源）。先前 presence 是一顆沒有文字的綠色 chip。
          -->
          <div class="mt-1 flex items-center gap-1.5 pl-9 text-[0.8125rem]">
            <img
              v-if="CHANNEL_ICON[c.channel]"
              :src="CHANNEL_ICON[c.channel]"
              :alt="c.channel"
              :title="c.channel"
              class="block size-[13px] shrink-0 self-center object-contain"
            >
            <span
              v-else
              class="rounded-full px-1.5 py-0.5"
              :style="{ background: 'var(--surface-3)', color: 'var(--text-2)' }"
            >{{ c.channel }}</span>

            <!--
              presence 標記 —— 畫布有三態（「你在此對話中」／「無客服在此」／「{email} 在此」），
              我方做得出其中**兩態**（2026-09-01，證據見 §10.2.1 與
              `scripts/spike/out/23-list-join-fields.json`）：

              ⚠️ **`viewerJoined` 用 `=== true` 判斷，不可用 `!viewerJoined` 反推「不是我」。**
                 `undefined` 是「這一輪還沒解析」（候選有單輪上限，見 `viewer-joined.ts`），
                 不是「不是我」—— 反推會在還沒解析完的那一瞬間說出我們還不知道的結論。
                 此時退回下面那一態（「有客服在此」）是**安全的方向**：它不指名，
                 頂多是該標成「你」的暫時標成一般的「有客服」，不會把同事的對話標成你的。

              ⚠️ **不寫「無客服在此」** —— `mode` 為 `automation`／`null` 時，「沒人」與
                 「有人但選了 Automation Only（唯讀觀察）」是同一個值（§10.2）。
                 ⚠️ 也**不可**改用 `is_agent_joined` 來補：實測它 LEAVE 後仍維持 `true`
                 （16 筆裡沒有任何一筆是 `false`），代表的是「曾經有人 JOIN 過」而非「現在有人」。
              ⚠️ **不寫是誰** —— 清單 payload 沒有參與者身分（`users[]` 是團隊名冊）。
              ⚠️ 第二態的措辭是「有**客服**」而不是「有**同事**」—— 它涵蓋
                 「`viewerJoined` 還沒解析出來」的情況，那時裡面的人也可能是你自己。
                 寫「同事」等於斷言那個人不是你。
            -->
            <span
              v-if="c.viewerJoined === true"
              class="flex min-w-0 items-center gap-1 leading-none"
              :style="{ color: 'var(--navy-2)' }"
              :title="$t('presence.youHere')"
            >
              <UIcon name="i-lucide-user-check" class="block size-3 shrink-0" />
              <span class="truncate">{{ $t('presence.youHere') }}</span>
            </span>
            <span
              v-else-if="someoneElseCanSend(c.mode)"
              class="flex min-w-0 items-center gap-1 leading-none"
              :style="{ color: 'var(--text-2)' }"
              :title="$t('presence.someoneHereHint')"
            >
              <UIcon name="i-lucide-eye" class="block size-3 shrink-0" />
              <span class="truncate">{{ $t('presence.someoneHere') }}</span>
            </span>

            <span class="min-w-0 flex-1" />

            <!--
              未讀徽記。
              ⚠️ **刻意是圓點＋「未讀」而不是畫布早期版本的數字**（2026-08-29 使用者裁定）：
                 我方唯一的新訊息訊號是 `last_message_at` 跳動，一次輪詢間隔（前景 3 秒）內
                 來幾則都只跳一次，數出來的是「批次數」不是「則數」。與其顯示一個會低估的
                 數字，不如只表達準確的那一件事——「有新訊息」。
                 2026-09-01 的畫布本身也已改成「圓點＋『未讀』」，兩邊現在一致。
            -->
            <span
              v-if="unread.has(c.id)"
              class="flex shrink-0 items-center gap-1"
              :style="{ color: 'var(--navy-2)' }"
              :aria-label="$t('sidebar.unread')"
            >
              <span class="size-[7px] shrink-0 rounded-full" :style="{ background: 'var(--navy)' }" aria-hidden="true" />
              {{ $t('sidebar.unreadLabel') }}
            </span>
          </div>
        </button>
          </li>
        </ul>
      </template>

      <!--
        「載入更多」留在捲動區內 —— 它是清單的延續，位置就該在最後一列之後。
        ⚠️ 刻意維持**可按的按鈕**而不是畫布的 spinner 自動載入（2026-09-01 使用者裁定）：
           自動載入會在客服往下捲時持續打 API 且無法中止，載入時機交給人決定。
      -->
      <div v-if="hasMore || atCoverageLimit" class="space-y-1 px-3 pb-3 pt-1 text-center text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
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
        <!-- ⚠️ 按鈕消失時 MUST 說明原因，否則看起來像壞掉（憲法 3.2：降級要看得見） -->
        <p v-if="atCoverageLimit">{{ $t('sidebar.coverageLimit', { n: items.length }) }}</p>
      </div>
    </div>

    <!--
      統計列（畫布 1c）：**捲動區之外**的固定 footer，左右分置。
      ⚠️ 先前它在 `overflow-y-auto` 容器**裡面**，會跟著清單一起捲走 ——
         而「顯示 N / M」正是客服想確認「我看到的是不是全部」時要找的東西，
         那個時機通常是已經捲到一半、正在找某一則對話的時候。
    -->
    <div
      class="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-[7px] text-[0.8125rem]"
      :style="{ borderColor: 'var(--border)', color: 'var(--text-3)' }"
    >
      <span class="ac-mono">
        {{ total === null
          ? $t('sidebar.shownOnly', { n: visible.length })
          : $t('sidebar.shown', { n: visible.length, total }) }}
      </span>
      <span>{{ $t('sidebar.sortedBy') }}</span>
    </div>
  </aside>
</template>

<style scoped>
/*
 * 日期分組的收合鈕 —— 畫布逐字：常態 `--text-3` ＋ 透明底，
 * hover 才是 `--surface-3` 底 ＋ `--text-2` 字。
 *
 * ⚠️ 寫在 CSS 而不是 `:style` ＋ `hover:` utility：**inline style 會蓋過 hover class**，
 *    顏色用 `:style` 綁上去的話 hover 那半永遠不會生效（而且不會報錯）。
 */
.ac-group-toggle {
  color: var(--text-3);
  transition: background-color .12s ease, color .12s ease;
}

.ac-group-toggle:hover {
  background: var(--surface-3);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .ac-group-toggle {
    transition: none;
  }
}
</style>
