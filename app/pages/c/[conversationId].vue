<script setup lang="ts">
/**
 * 對話工作區 —— docs/ARCHITECTURE.md §14.1。
 *
 * M1 只有側欄 + 中欄。右欄的 Copilot 面板（摘要卡、情緒 sparkline、建議卡）
 * 是 M2 的內容，這裡先留出可拖曳的分隔位置，讓屆時加入不必重排版面。
 *
 * ⚠️ 分欄寬度存 `localStorage`（§14.1）—— 不同客服對「對話 vs 建議」的
 *    比重偏好差異很大，每次開啟都要重調是很惱人的。
 */

import type { ConversationMode } from '#shared/types/conversation'

definePageMeta({ layout: 'console' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const conversations = useConversationsStore()
const stream = useStreamStore()

const conversationId = computed(() => String(route.params.conversationId ?? ''))

const view = useConversationView(conversationId)
const copilot = useCopilotSession(conversationId)
const draft = useDraft(conversationId)
const composer = ref<{ focus: () => void } | null>(null)

// 建議卡「一鍵帶入」的草稿覆蓋確認（FR-018、憲法 8.4，research.md #11）
const overwriteConfirm = useOverwriteConfirm(draft.text, (text) => { draft.text.value = text })

// ── 兩欄的寬度（畫布 §8.1：左欄 220–400／預設 280，右欄 320–720／預設 420）──

/**
 * ⚠️ 兩欄的拖曳範圍在畫布的 script 裡是逐字寫死的，不是示意：
 *    `startDragLeft` → `Math.min(400, Math.max(220, …))`、
 *    `startDrag` → `Math.min(720, Math.max(320, …))`。
 *
 * ⚠️ **右欄上限 720 遠大於預設的 420，那是刻意的** —— Copilot 面板在某些情境下會成為
 *    客服主要在看的畫面（逐條讀建議卡、展開知識庫全文），不是永遠的輔助欄。
 *    拉到 720 時中欄會被壓縮，但中欄是 `flex-1 min-w-0`、標題已 truncate，不會破版。
 */
const sidebar = usePanelWidth({ key: 'ac.sidebarWidth', def: 280, min: 220, max: 400 })
/** 右欄的把手在面板**左**緣，往左拖（滑鼠 X 變小）要讓面板變寬 —— 方向與左欄相反 */
const copilotPane = usePanelWidth({ key: 'ac.copilotWidth', def: 420, min: 320, max: 720, invert: true })

const sidebarCollapsed = ref(false)
const COLLAPSED_KEY = 'ac.sidebarCollapsed'

/**
 * 中欄「對話資訊列」的收合（畫布 1c：標題列 ＋ 服務模式 ＋ Presence 三段收成 38px 一列）。
 *
 * ⚠️ 與左欄／右欄一樣**記在 localStorage**。這三個收合狀態是同一種偏好
 *    （客服自己決定畫面要留給訊息流還是留給狀態），只有這一個不記住的話，
 *    每次切換對話都要重收一次 —— 而切換對話一天要發生數十次。
 */
const headerCollapsed = ref(false)
const HEADER_COLLAPSED_KEY = 'ac.headerCollapsed'

/**
 * 面板的可見性與收合（specs/003-analysis-trigger-policy FR-016、FR-017）。
 * ⚠️ `visible` 直接由 `viewerJoined` 推出，MUST NOT 由 Block 是否 empty 推出 ——
 *    理由見 `useCopilotPanel()` 的檔頭。
 */
const panel = useCopilotPanel(conversationId, view.viewerJoined)

onMounted(() => {
  sidebar.restore()
  copilotPane.restore()
  try {
    sidebarCollapsed.value = localStorage.getItem(COLLAPSED_KEY) === '1'
    headerCollapsed.value = localStorage.getItem(HEADER_COLLAPSED_KEY) === '1'
  }
  catch {
    // 隱私模式下讀不到就用預設值，不影響功能
  }
  void conversations.load()
})

watch(sidebarCollapsed, (c) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0')
  }
  catch { /* 存不下來不影響本次操作 */ }
})

watch(headerCollapsed, (c) => {
  try {
    localStorage.setItem(HEADER_COLLAPSED_KEY, c ? '1' : '0')
  }
  catch { /* 存不下來不影響本次操作 */ }
})

// ── 側欄與 SSE 的連動 ───────────────────────────────────────────────

watch(conversationId, id => conversations.setActive(id || null), { immediate: true })

let offStream: (() => void) | undefined
onMounted(() => {
  stream.connect()
  offStream = stream.on(evt => conversations.apply(evt))
})
onBeforeUnmount(() => offStream?.())

watch(() => conversations.query, () => void conversations.load())

/**
 * 側欄清單的 `mode` 只在整批重載（`conversations.load()`）時更新，JOIN／LEAVE／
 * 切換模式当下不會連動——側欄的小綠人圖示（`someoneElseCanSend(c.mode)`）因此要等
 * 下一次整批重載才會反映，客服會覺得「JOIN 了但列表沒反應」。
 *
 * `view.control.value.mode` 已經是即時的（本人操作或其他客服／SSE 推播都會更新），
 * 直接同步進側欄快取的對應項目，不必整批重打 API。
 */
watch(() => view.control.value?.mode, (mode) => {
  const item = conversations.items.find(c => c.id === conversationId.value)
  if (item) item.mode = mode ?? null
})

function select(id: string): void {
  if (id === conversationId.value) return
  void router.push(`/c/${id}`)
}

// ── 送出 ────────────────────────────────────────────────────────────

async function send(force: boolean): Promise<void> {
  const text = draft.text.value
  if (!text.trim()) return

  const ok = await view.send(text, force)
  // ⚠️ 憲法 8.4：只有「確定送出成功」才清草稿。
  //    撞單被攔截、網路失敗都必須原封不動保留 —— 那正是客服最需要它的時候。
  if (ok) draft.clear()
}

function discard(): void {
  draft.clear()
  view.dismissCollision()
}

async function switchMode(mode: ConversationMode): Promise<void> {
  await view.setMode(mode)
}

// ── 接手／離開／結案（FR-020、FR-022，對照 docs/wireframe/03-workspace_assignment02.png）──

/**
 * 未 JOIN 時的「接手對話」下拉。⚠️ 憲法 8.1：兩個選項的差別 MUST 由**文案的後果**讀得出來
 * （「AI 不再自動發話」／「AI 繼續自動回覆」），MUST NOT 只寫模式名稱。
 */
const joinMenuOpen = ref(false)

async function joinAs(mode: 'manual' | 'hybrid'): Promise<void> {
  joinMenuOpen.value = false
  await view.join(mode)
}

const title = computed(() =>
  view.detail.value?.name || view.detail.value?.contactId || conversationId.value,
)

// ── 中欄標題列的 meta（畫布 §8.3：`conv_8f21c0 · 建立於 08/25 13:58 · 訊息 312 則`）──

/**
 * ⚠️ **「訊息 N 則」的 N 是「目前已載入的則數」，不是對話總則數。**
 *    平台的訊息 API 只回一頁 ＋ `hasMore`，沒有總數欄位（`useConversationView`
 *    的 `MessagesResponse`）。把已載入數直接標成「訊息 312 則」是謊報 ——
 *    因此還有更早的歷史沒載完時，措辭改為「已載入 N 則」，全部載完才說「訊息 N 則」。
 *    平台日後提供總數時，這裡改回單一措辭即可。
 */
const metaParts = computed<string[]>(() => {
  const parts: string[] = [shortConversationId(conversationId.value)]
  const created = createdAtLabel(view.detail.value?.createdAt)
  if (created) parts.push(t('conversation.createdAt', { time: created }))
  const n = view.messages.value.length
  if (n > 0) {
    parts.push(view.hasMore.value
      ? t('conversation.messagesLoaded', { n })
      : t('conversation.messagesTotal', { n }))
  }
  return parts
})

/**
 * 撞單來源訊息（畫布 §8.3）—— 在訊息流上把「害你被攔下」的那幾則標出來。
 * ⚠️ 只有 `agent`／`ai` 才有具體訊息；`unverified` 是「檢查本身失敗」，
 *    沒有任何一則訊息可指，此時 `messages` 為空、不標任何東西。
 */
const collisionMessageIds = computed(
  () => new Set((view.collision.value?.messages ?? []).map(m => m.id)),
)

const statusColor = computed(() => STATUS_COLOR[view.detail.value?.status ?? ''])
const channelIcon = computed(() => CHANNEL_ICON[view.detail.value?.channel ?? ''])

/**
 * 收合態那一列的 presence 摘要（畫布 1c 的 `presenceShort`）。
 *
 * ⚠️ **措辭沿用 `ConversationPresenceBar` 的同一套保守標準**：只講「偵測到幾個人」，
 *    沒偵測到時說「你正在檢視」而**不是**「沒有其他人」—— `mode` 的 `automation`
 *    對「真的沒人」與「有人但唯讀」無法區分（§10.2），後者等於宣稱我們分得出來。
 *    收合態字少，最容易把「保守」寫成「斷言」，這一行因此不可簡化成「1 人」。
 */
const presenceShort = computed(() => {
  const p = view.presence.value
  const others = p.operators.length + (p.unidentifiedActor ? 1 : 0)
  return others === 0
    ? t('presence.youViewing')
    : t('presence.shortOthers', { n: others })
})
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- ── 側欄（可收合、可拖曳調寬）── -->
    <div
      v-if="!sidebarCollapsed"
      class="shrink-0"
      :style="{ width: `${sidebar.width.value}px` }"
    >
      <ConversationSidebar
        v-model:query="conversations.query"
        :items="conversations.sorted"
        :active-id="conversations.activeId"
        :unread="conversations.unread"
        :counts="conversations.counts"
        :total="conversations.total"
        :has-more="conversations.hasMore"
        :at-coverage-limit="conversations.atCoverageLimit"
        @load-more="conversations.loadMore()"
        :loading="conversations.loading"
        :error="conversations.error"
        @select="select"
        @refresh="conversations.load()"
        collapsible
        @collapse="sidebarCollapsed = true"
      />
    </div>

    <!-- 收合態：48px 窄直條（畫布 §8.1、D-21）。整欄消失的話，收合期間就沒有任何
         「還有幾個對話、有沒有新訊息」的出口 —— 客服得先展開才知道要不要展開 -->
    <ConversationSidebarCollapsed
      v-else
      :total="conversations.total"
      :loaded="conversations.items.length"
      :has-unread="conversations.unread.size > 0"
      @expand="sidebarCollapsed = false"
    />

    <ConversationResizeHandle
      v-if="!sidebarCollapsed"
      :dragging="sidebar.dragging.value"
      :value="sidebar.width.value"
      :min="sidebar.min"
      :max="sidebar.max"
      :label="$t('layout.resizeSidebar')"
      @pointerdown="sidebar.startDrag"
      @keydown="sidebar.onKeydown"
    />

    <!-- ── 中欄：對話視窗 ── -->
    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <!--
        即時更新中斷：靜默降級但必須讓使用者知道畫面可能不是最新的（憲法 3.2）。
        ⚠️ 位置在資訊列**之上**且**不隨收合消失** —— 「畫面可能不是最新的」在收合態
           只會更難察覺（收合正是為了長時間讀訊息流），那時反而更需要這一條。
      -->
      <p
        v-if="stream.degraded"
        class="ac-alert-warn flex shrink-0 items-center gap-2 px-4 py-1.5"
      >
        <UIcon name="i-lucide-wifi-off" class="size-3.5 shrink-0" />
        <span>{{ $t('stream.offline') }}</span>
      </p>

      <!--
        對話資訊列的展開／收合（畫布 1c）—— 收合的是**標題列 ＋ 服務模式 ＋ Presence**
        這一整組，不是只收其中一段。畫布把 Presence 列一起關在展開態裡，
        收合態則把模式與 presence 各壓成一個徽記帶走（見 ConversationHeaderCollapsed）。
      -->
      <ConversationHeaderCollapsed
        v-if="headerCollapsed"
        :title="title"
        :status="view.detail.value?.status"
        :channel="view.detail.value?.channel"
        :mode="view.control.value?.mode ?? null"
        :presence-short="presenceShort"
        :joined="view.viewerJoined.value"
        :busy="view.busy.value"
        @expand="headerCollapsed = false"
        @join="joinAs('manual')"
        @close="view.closeConversation()"
      />

      <template v-else>
        <header
          class="shrink-0 border-b px-4 py-2"
          :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
        >
          <div class="flex items-center gap-2">
            <!--
              畫布 §8.3 標題列：頭像 ＋ 代號 ＋ status pill ＋ 頻道 pill，第二行是 meta。
              ⚠️ 頭像／status 色／頻道 icon 與側欄共用 `app/utils/conversation-display.ts` ——
                 兩處算法各寫一份時會長不一樣，而那不會有型別錯誤。
            -->
            <span
              class="ac-mono flex size-8 shrink-0 items-center justify-center rounded-full text-[0.8125rem] font-semibold"
              :style="{
                background: avatarColor(title).bg,
                color: avatarColor(title).fg,
              }"
              aria-hidden="true"
            >{{ avatarLabel(title) }}</span>

            <div class="flex min-w-0 flex-col gap-0.5">
              <div class="flex min-w-0 items-center gap-2">
                <h1 class="ac-mono min-w-0 truncate text-[1.03125rem] font-medium">{{ title }}</h1>

                <span
                  v-if="statusColor"
                  class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.8125rem]"
                  :style="{ background: statusColor.bg, color: statusColor.fg }"
                >
                  <span class="size-1 rounded-full" :style="{ background: statusColor.fg }" aria-hidden="true" />
                  {{ view.detail.value?.status }}
                </span>

                <span
                  v-if="view.detail.value?.channel"
                  class="flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.8125rem]"
                  :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-2)' }"
                >
                  <img
                    v-if="channelIcon"
                    :src="channelIcon"
                    :alt="view.detail.value.channel"
                    class="size-3 shrink-0 rounded-[3px] object-contain"
                  >
                  {{ view.detail.value.channel }}
                </span>
              </div>

              <p class="ac-mono truncate text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
                {{ metaParts.join(' · ') }}
              </p>
            </div>

            <!--
              兩個並列出口（FR-020、FR-022、SC-007）。
              ⚠️ 憲法 8.1：「離開對話」與「結案」的差別 MUST 由**文案**讀得出來（下方輔助說明），
                 MUST NOT 只靠主／次按鈕的視覺層級表達 —— 視覺層級是強化，不是資訊本身。
            -->
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <template v-if="!view.viewerJoined.value">
                <div class="relative flex">
                  <!--
                    ⚠️ 畫布 §8.3 的主按鈕帶 `user-check` icon（13px、gap 6px）——
                       這顆按鈕是整個標題列唯一的 primary 動作，icon 是它與旁邊次要按鈕的
                       主要視覺區分，少了它在深色主題下更難一眼認出。
                  -->
                  <button
                    type="button"
                    class="ac-btn-primary flex h-8 items-center gap-1.5 rounded-r-none px-3 text-[0.9375rem]"
                    :disabled="view.busy.value"
                    @click="joinAs('manual')"
                  >
                    <UIcon
                      :name="view.busy.value ? 'i-lucide-loader-circle' : 'i-lucide-user-check'"
                      class="size-3.5 shrink-0"
                      :class="{ 'animate-spin': view.busy.value }"
                    />
                    {{ view.busy.value ? $t('conversation.joining') : $t('conversation.join') }}
                  </button>
                  <button
                    type="button"
                    class="ac-btn-primary h-8 rounded-l-none border-l border-white/20 px-1.5"
                    :disabled="view.busy.value"
                    :aria-label="$t('conversation.joinModeLabel')"
                    :aria-expanded="joinMenuOpen"
                    @click="joinMenuOpen = !joinMenuOpen"
                  >
                    <UIcon name="i-lucide-chevron-down" class="size-4" />
                  </button>

                  <div
                    v-if="joinMenuOpen"
                    class="ac-card absolute right-0 top-9 z-20 w-72 p-1 text-left"
                    role="menu"
                  >
                    <button
                      v-for="opt in ([
                        { mode: 'manual', icon: 'i-lucide-user-round', label: $t('conversation.joinAsManual'), hint: $t('conversation.joinAsManualHint') },
                        { mode: 'hybrid', icon: 'i-lucide-sparkles', label: $t('conversation.joinAsHybrid'), hint: $t('conversation.joinAsHybridHint') },
                      ] as const)"
                      :key="opt.mode"
                      type="button"
                      role="menuitem"
                      class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                      @click="joinAs(opt.mode)"
                    >
                      <UIcon :name="opt.icon" class="mt-0.5 size-4 shrink-0" :style="{ color: 'var(--text-3)' }" />
                      <span class="min-w-0">
                        <span class="block text-[0.9375rem]">{{ opt.label }}</span>
                        <span class="block text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">{{ opt.hint }}</span>
                      </span>
                    </button>
                  </div>
                </div>
              </template>

              <template v-else>
                <button
                  type="button"
                  class="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[0.9375rem] transition-colors disabled:opacity-50"
                  :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
                  :disabled="view.busy.value"
                  @click="view.leave()"
                >
                  <UIcon name="i-lucide-log-out" class="size-4" />
                  {{ view.busy.value ? $t('conversation.leaving') : $t('conversation.leave') }}
                </button>
                <button
                  type="button"
                  class="ac-btn-primary flex h-8 items-center gap-1.5 px-3 text-[0.9375rem]"
                  :disabled="view.busy.value"
                  @click="view.closeConversation()"
                >
                  <UIcon name="i-lucide-clipboard-check" class="size-4" />
                  {{ view.busy.value ? $t('conversation.closing') : $t('conversation.close') }}
                </button>
              </template>
            </div>
          </div>

          <!-- 兩個出口的差別（憲法 8.1：資訊在文案裡，不在視覺層級裡） -->
          <p
            v-if="view.viewerJoined.value"
            class="mt-1 text-right text-[0.8125rem]"
            :style="{ color: 'var(--text-3)' }"
          >
            {{ $t('conversation.exitHint') }}
          </p>

          <!--
            收合鈕在**服務模式區塊的右下角**（畫布 2026-08-31 第三版：`position:absolute`
            ＋ `right:14px; bottom:8px`，即該區塊 padding box 的右下角，與最後一行警語齊底）。

            ⚠️ 不放標題列：那一排是「接手／離開／結案」這種有後果的動作，
               把一顆純視覺的收合鈕擠進去會讓它看起來像同一類東西。
            ⚠️ 用 `absolute` 而不是 flex 的第三個項目 —— 它要對齊的是**整個區塊的底部**
               （警語那一行），不是模式按鈕那一列。畫布上一版就是放在按鈕列裡，這一版特地改掉了。
            ⚠️ `pr-8` 是給按鈕讓出的空間：警語是可換行的整行文字，沒有這段留白會被按鈕壓住。
          -->
          <div class="relative mt-1.5 pr-8">
            <ConversationModeSelect
              :mode="view.control.value?.mode ?? null"
              :disabled="!view.viewerJoined.value || view.busy.value"
              :busy="view.busy.value"
              @change="switchMode"
            />
            <button
              type="button"
              class="absolute bottom-0 right-0 flex size-6 items-center justify-center rounded-md border transition-opacity hover:opacity-70"
              :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface)', color: 'var(--text-2)' }"
              :aria-label="$t('conversation.collapseHeader')"
              :aria-expanded="true"
              :title="$t('conversation.collapseHeader')"
              @click="headerCollapsed = true"
            >
              <UIcon name="i-lucide-chevrons-up" class="size-3.5" />
            </button>
          </div>
        </header>

        <ConversationPresenceBar :presence="view.presence.value" />
      </template>

      <p v-if="view.error.value" class="ac-alert-warn mx-4 flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ view.error.value }}</span>
      </p>

      <!--
        1d 載入中（畫布 §9）：骨架泡泡 ＋ 底部一行「正在載入訊息…」。
        ⚠️ 畫布寫的是「正在載入 **312** 則訊息…」，我方沒有那個數字 ——
           訊息 API 只回一頁 ＋ hasMore，沒有總數。與其編一個數，不如不講。
      -->
      <div v-if="view.loading.value && view.messages.value.length === 0" class="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <div v-for="n in 4" :key="n" class="space-y-2">
          <div class="ac-skel h-2.5 w-20" />
          <div class="ac-skel ac-skel-shimmer h-10" :style="{ width: `${70 - n * 7}%` }" />
        </div>
        <p class="mt-auto flex items-center justify-center gap-2 text-[0.84375rem]" :style="{ color: 'var(--text-3)' }">
          <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
          {{ $t('conversation.loadingMessages') }}
        </p>
      </div>

      <p
        v-else-if="view.messages.value.length === 0"
        class="flex flex-1 items-center justify-center text-[0.9375rem]"
        :style="{ color: 'var(--text-3)' }"
      >
        {{ $t('conversation.empty') }}
      </p>

      <ConversationMessageList
        v-else
        :messages="view.messages.value"
        :my-operator-id="auth.me?.operatorId"
        :customer-label="view.detail.value?.name || view.detail.value?.contactId"
        :collision-message-ids="collisionMessageIds"
        :loading-more="view.loadingMore.value"
        :has-more="view.hasMore.value"
        @load-older="view.loadOlder()"
      />

      <!-- 一鍵帶入／插入為回覆覆蓋非空白草稿前的確認（FR-018、憲法 8.4） -->
      <div
        v-if="overwriteConfirm.pending.value !== null"
        class="ac-alert-warn mx-4 mb-2 flex items-center justify-between gap-3 px-3 py-2"
      >
        <span class="flex items-center gap-2">
          <UIcon name="i-lucide-alert-triangle" class="size-3.5 shrink-0" />
          {{ $t('copilot.draftOverwrite.message') }}
        </span>
        <span class="flex shrink-0 gap-2">
          <button type="button" class="ac-btn-primary h-7 px-2.5 text-[0.8125rem]" @click="overwriteConfirm.confirm()">
            {{ $t('copilot.draftOverwrite.confirm') }}
          </button>
          <button
            type="button"
            class="h-7 rounded-lg border px-2.5 text-[0.8125rem]"
            :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
            @click="overwriteConfirm.cancel()"
          >
            {{ $t('copilot.draftOverwrite.cancel') }}
          </button>
        </span>
      </div>

      <ConversationComposer
        ref="composer"
        v-model:draft="draft.text.value"
        :control="view.control.value"
        :viewer-joined="view.viewerJoined.value"
        :sending="view.sending.value"
        :send-error="view.sendError.value"
        :collision="view.collision.value"
        :initializing="view.loading.value && !view.control.value"
        :my-operator-id="auth.me?.operatorId"
        @send="send"
        @discard="discard"
        @dismiss-collision="view.dismissCollision()"
        @composing="view.beat('composing')"
      />
    </section>

    <!--
      ── 右欄 Copilot 面板 —— specs/001-sentiment-panel（摘要卡／情緒）、
         specs/002-suggestion-knowledge-search（建議卡與知識庫快查）、
         specs/003-analysis-trigger-policy（可見性與收合）。

      ⚠️ **未 JOIN 時整欄不渲染**（FR-016，含分隔拖曳把手），中欄自然延伸至可用寬度。
         MUST NOT 用變灰／空狀態／骨架代替 —— 那些仍然佔位，骨架還會讓客服以為正在載入而空等。
         「可見 ⟺ 已 JOIN」讓「看得到就是新的」成為恆真命題（SC-006），
         客服不必再分辨畫面上的東西新不新。

      ⚠️ 面板的 `v-if` **只包住面板子樹**，`ConversationComposer` 在上面的中欄裡 ——
         草稿因此不受面板出現／消失影響（憲法 8.4，由 test/nuxt/copilot-panel-collapse.test.ts 守著）。
    -->
    <template v-if="conversationId && panel.visible.value">
      <!-- 收合態沒有可調寬度，把手一併隱藏 -->
      <ConversationResizeHandle
        v-if="!panel.collapsed.value"
        :dragging="copilotPane.dragging.value"
        :value="copilotPane.width.value"
        :min="copilotPane.min"
        :max="copilotPane.max"
        :label="$t('layout.resizeCopilot')"
        @pointerdown="copilotPane.startDrag"
        @keydown="copilotPane.onKeydown"
      />

      <!-- 收合態：窄直條（對照 docs/wireframe/03-workspace_toggleCopilot.png） -->
      <div
        v-if="panel.collapsed.value"
        class="flex w-11 shrink-0 flex-col items-center gap-3 border-l py-3"
        :style="{ borderColor: 'var(--border)', background: 'var(--bg)' }"
      >
        <button
          type="button"
          class="rounded-md p-1 transition-opacity hover:opacity-70"
          :style="{ color: 'var(--text-3)' }"
          :aria-label="$t('copilot.expand')"
          :aria-expanded="false"
          :title="$t('copilot.expand')"
          @click="panel.toggle()"
        >
          <UIcon name="i-lucide-panel-right-open" class="size-4" />
        </button>
        <span
          class="ac-status-label [writing-mode:vertical-rl]"
          :style="{ color: 'var(--text-3)' }"
        >
          {{ $t('copilot.panelTitle') }}
        </span>
      </div>

      <div
        v-else
        class="shrink-0 space-y-3 overflow-y-auto border-l p-3"
        :style="{ width: `${copilotPane.width.value}px`, borderColor: 'var(--border)', background: 'var(--bg)' }"
      >
        <CopilotPanelHeader
          :collapsed="panel.collapsed.value"
          :has-error="copilot.hasError.value"
          :analyzing="copilot.analyzing.value"
          @toggle="panel.toggle()"
          @retry-all="copilot.retryAll()"
        />
        <!--
          ⚠️ **區塊順序照畫布 artboard 2a，不要隨手調動。**
             畫布的排序有記載的理由（ARCHITECTURE §「右欄自上而下共五個區塊」）——依處理中的
             使用頻率排：情緒「最常看」→ 建議「最常用」→ 快查「隨時可能用」→ 對話紀錄
             「偶爾回顧」→ 結案摘要「只在結案時」。
             摘要卡是畫布沒有的第六個區塊，2026-08-29 由使用者裁定插在情緒與建議之間。
        -->
        <CopilotSentimentGauge :block="copilot.sentiment.value" @retry="copilot.retry('sentiment')" />
        <CopilotSummaryCard :block="copilot.summary.value" @retry="copilot.retry('summary')" />
        <CopilotSuggestionList
          :block="copilot.suggestions.value"
          :cited-at="copilot.suggestionCitedAt.value"
          @retry="copilot.retry('suggestions')"
          @insert="overwriteConfirm.request($event)"
        />
        <CopilotKnowledgeSearch
          :conversation-id="conversationId"
          @insert="overwriteConfirm.request($event)"
        />
      </div>
    </template>
  </div>
</template>
