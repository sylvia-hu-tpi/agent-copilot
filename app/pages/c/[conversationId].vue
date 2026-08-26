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

// ── 側欄 ────────────────────────────────────────────────────────────

const sidebarWidth = ref(280)
const sidebarCollapsed = ref(false)

const WIDTH_KEY = 'ac.sidebarWidth'
const COLLAPSED_KEY = 'ac.sidebarCollapsed'

// ── 右欄 Copilot 面板（可拖曳調寬，範圍依 docs/DESIGN_TOKENS.md §7.1：320–520px）───

const copilotWidth = ref(380)
const COPILOT_WIDTH_KEY = 'ac.copilotWidth'

onMounted(() => {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(w) && w >= 200 && w <= 480) sidebarWidth.value = w
    sidebarCollapsed.value = localStorage.getItem(COLLAPSED_KEY) === '1'

    const cw = Number(localStorage.getItem(COPILOT_WIDTH_KEY))
    if (Number.isFinite(cw) && cw >= 320 && cw <= 520) copilotWidth.value = cw
  }
  catch {
    // 隱私模式下讀不到就用預設值，不影響功能
  }
  void conversations.load()
})

watch([sidebarWidth, sidebarCollapsed, copilotWidth], ([w, c, cw]) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(w))
    localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0')
    localStorage.setItem(COPILOT_WIDTH_KEY, String(cw))
  }
  catch { /* 存不下來不影響本次操作 */ }
})

/** 拖曳調寬 */
const dragging = ref(false)
function startDrag(e: PointerEvent): void {
  dragging.value = true
  const startX = e.clientX
  const startWidth = sidebarWidth.value
  const move = (ev: PointerEvent) => {
    sidebarWidth.value = Math.min(480, Math.max(200, startWidth + ev.clientX - startX))
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** 右欄拖曳把手在面板的左邊緣，往左拖（滑鼠 X 變小）要讓面板變寬，方向與左側欄相反 */
const copilotDragging = ref(false)
function startCopilotDrag(e: PointerEvent): void {
  copilotDragging.value = true
  const startX = e.clientX
  const startWidth = copilotWidth.value
  const move = (ev: PointerEvent) => {
    copilotWidth.value = Math.min(520, Math.max(320, startWidth - (ev.clientX - startX)))
  }
  const up = () => {
    copilotDragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

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

const title = computed(() =>
  view.detail.value?.name || view.detail.value?.contactId || conversationId.value,
)
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- ── 側欄（可收合、可拖曳調寬）── -->
    <div
      v-if="!sidebarCollapsed"
      class="shrink-0"
      :style="{ width: `${sidebarWidth}px` }"
    >
      <ConversationSidebar
        v-model:query="conversations.query"
        :items="conversations.sorted"
        :active-id="conversations.activeId"
        :unread="conversations.unread"
        :loading="conversations.loading"
        :error="conversations.error"
        @select="select"
        @refresh="conversations.load()"
      />
    </div>

    <div
      v-if="!sidebarCollapsed"
      class="w-1 shrink-0 cursor-col-resize transition-colors"
      :style="{ background: dragging ? 'var(--navy-2)' : 'transparent' }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown.prevent="startDrag"
    />

    <!-- ── 中欄：對話視窗 ── -->
    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        class="shrink-0 border-b px-4 py-2"
        :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
      >
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-md p-1 transition-opacity hover:opacity-70"
            :style="{ color: 'var(--text-3)' }"
            :aria-label="sidebarCollapsed ? $t('sidebar.expand') : $t('sidebar.collapse')"
            :title="sidebarCollapsed ? $t('sidebar.expand') : $t('sidebar.collapse')"
            @click="sidebarCollapsed = !sidebarCollapsed"
          >
            <UIcon :name="sidebarCollapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="size-4" />
          </button>

          <h1 class="ac-mono min-w-0 truncate text-[1.03125rem] font-semibold">{{ title }}</h1>

          <div class="ml-auto flex shrink-0 items-center gap-2">
            <button
              v-if="!view.viewerJoined.value"
              type="button"
              class="ac-btn-primary h-8 px-3 text-[0.9375rem]"
              :disabled="view.busy.value"
              @click="view.join()"
            >
              {{ view.busy.value ? $t('conversation.joining') : $t('conversation.join') }}
            </button>
            <button
              v-else
              type="button"
              class="h-8 rounded-lg border px-3 text-[0.9375rem] transition-colors disabled:opacity-50"
              :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
              :disabled="view.busy.value"
              @click="view.leave()"
            >
              {{ view.busy.value ? $t('conversation.leaving') : $t('conversation.leave') }}
            </button>
          </div>
        </div>

        <div class="mt-1.5">
          <ConversationModeSelect
            :mode="view.control.value?.mode ?? null"
            :disabled="!view.viewerJoined.value || view.busy.value"
            :busy="view.busy.value"
            @change="switchMode"
          />
        </div>
      </header>

      <!-- 即時更新中斷：靜默降級但必須讓使用者知道畫面可能不是最新的（憲法 3.2） -->
      <p
        v-if="stream.degraded"
        class="ac-alert-warn flex shrink-0 items-center gap-2 px-4 py-1.5"
      >
        <UIcon name="i-lucide-wifi-off" class="size-3.5 shrink-0" />
        <span>{{ $t('stream.offline') }}</span>
      </p>

      <ConversationPresenceBar :presence="view.presence.value" />

      <p v-if="view.error.value" class="ac-alert-warn mx-4 flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ view.error.value }}</span>
      </p>

      <div v-if="view.loading.value && view.messages.value.length === 0" class="flex-1 space-y-4 p-4">
        <div v-for="n in 4" :key="n" class="space-y-2">
          <div class="ac-skel h-2.5 w-20" />
          <div class="ac-skel ac-skel-shimmer h-10" :style="{ width: `${70 - n * 7}%` }" />
        </div>
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
        :loading-more="view.loadingMore.value"
        :has-more="view.hasMore.value"
        @load-older="view.loadOlder()"
      />

      <ConversationComposer
        ref="composer"
        v-model:draft="draft.text.value"
        :control="view.control.value"
        :viewer-joined="view.viewerJoined.value"
        :sending="view.sending.value"
        :send-error="view.sendError.value"
        :collision="view.collision.value"
        :my-operator-id="auth.me?.operatorId"
        @send="send"
        @discard="discard"
        @dismiss-collision="view.dismissCollision()"
        @composing="view.beat('composing')"
      />
    </section>

    <!-- ── 右欄與中欄之間的拖曳把手（可拖曳調寬，320–520px）── -->
    <div
      v-if="conversationId"
      class="w-1 shrink-0 cursor-col-resize transition-colors"
      :style="{ background: copilotDragging ? 'var(--navy-2)' : 'transparent' }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown.prevent="startCopilotDrag"
    />

    <!--
      右欄 Copilot 面板 —— specs/001-sentiment-panel（M2）。
      §14.1.1 規劃的其餘區塊（建議卡、知識庫快查等）仍是後續功能，先留白。
    -->
    <div
      v-if="conversationId"
      class="shrink-0 space-y-3 overflow-y-auto border-l p-3"
      :style="{ width: `${copilotWidth}px`, borderColor: 'var(--border)', background: 'var(--bg)' }"
    >
      <CopilotSummaryCard :block="copilot.summary.value" @retry="copilot.retry('summary')" />
      <CopilotSentimentGauge :block="copilot.sentiment.value" @retry="copilot.retry('sentiment')" />
    </div>
  </div>
</template>
