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

// 建議卡「一鍵帶入」的草稿覆蓋確認（FR-018、憲法 8.4，research.md #11）
const overwriteConfirm = useOverwriteConfirm(draft.text, (text) => { draft.text.value = text })

// ── 側欄 ────────────────────────────────────────────────────────────

const sidebarWidth = ref(280)
const sidebarCollapsed = ref(false)

const WIDTH_KEY = 'ac.sidebarWidth'
const COLLAPSED_KEY = 'ac.sidebarCollapsed'

// ── 右欄 Copilot 面板（可拖曳調寬，範圍依 docs/DESIGN_TOKENS.md §7.1：320–520px）───

/**
 * ⚠️ 預設 420px，不是 380 —— 畫布已於 2026-08-28 統一為 420px 為所有狀態共用的展開寬度
 * （`docs/DESIGN_TOKENS.md` §7.1；先前的 380/420 差異來自畫布尚未統一，不是設計區分）。
 * 拖曳範圍 320–520 不變，此值只影響首次開啟。
 */
const copilotWidth = ref(420)
const COPILOT_WIDTH_KEY = 'ac.copilotWidth'

/**
 * 面板的可見性與收合（specs/003-analysis-trigger-policy FR-016、FR-017）。
 * ⚠️ `visible` 直接由 `viewerJoined` 推出，MUST NOT 由 Block 是否 empty 推出 ——
 *    理由見 `useCopilotPanel()` 的檔頭。
 */
const panel = useCopilotPanel(conversationId, view.viewerJoined)

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

          <!--
            兩個並列出口（FR-020、FR-022、SC-007）。
            ⚠️ 憲法 8.1：「離開對話」與「結案」的差別 MUST 由**文案**讀得出來（下方輔助說明），
               MUST NOT 只靠主／次按鈕的視覺層級表達 —— 視覺層級是強化，不是資訊本身。
          -->
          <div class="ml-auto flex shrink-0 items-center gap-2">
            <template v-if="!view.viewerJoined.value">
              <div class="relative flex">
                <button
                  type="button"
                  class="ac-btn-primary h-8 rounded-r-none px-3 text-[0.9375rem]"
                  :disabled="view.busy.value"
                  @click="joinAs('manual')"
                >
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
      <div
        v-if="!panel.collapsed.value"
        class="w-1 shrink-0 cursor-col-resize transition-colors"
        :style="{ background: copilotDragging ? 'var(--navy-2)' : 'transparent' }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown.prevent="startCopilotDrag"
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
        :style="{ width: `${copilotWidth}px`, borderColor: 'var(--border)', background: 'var(--bg)' }"
      >
        <CopilotPanelHeader
          :collapsed="panel.collapsed.value"
          :has-error="copilot.hasError.value"
          @toggle="panel.toggle()"
          @retry-all="copilot.retryAll()"
        />
        <CopilotSummaryCard :block="copilot.summary.value" @retry="copilot.retry('summary')" />
        <CopilotSentimentGauge :block="copilot.sentiment.value" @retry="copilot.retry('sentiment')" />
        <CopilotSuggestionList
          :block="copilot.suggestions.value"
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
