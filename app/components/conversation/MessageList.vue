<script setup lang="ts">
/**
 * 訊息流 —— 憲法 8.3：**不得一次渲染全部訊息節點**（歷史可經 skip 分頁無限回補）。
 * 現行實作為虛擬滾動；要換掉它，得先證明數千則訊息下捲動仍順暢。
 *
 * 理由不是理論上的：實測單一對話最多 398 則訊息（§9.3），
 * 全部直接渲染會在切換對話時明顯卡頓，而客服一天要切換數十次。
 *
 * ── 兩個虛擬滾動特有的坑 ─────────────────────────────────────────
 * ⚠️ ① **不能無條件捲到底。** 客服正在往上翻閱歷史時，新訊息進來若把畫面
 *    拉回底部，他會失去閱讀位置 —— 而且往往正在核對客戶稍早說過的話。
 *    因此只在「原本就貼在底部」時才自動跟隨。
 *
 * ⚠️ ② **高度必須估算。** `useVirtualList` 需要知道每項多高，
 *    但訊息長度差異極大。用固定值會讓捲軸長度嚴重失準（長訊息被裁掉、
 *    短訊息之間出現空白），所以依文字長度粗估，並讓實際 DOM 決定最終高度。
 */

import type { Message } from '#shared/types/conversation'

const props = defineProps<{
  messages: Message[]
  myOperatorId?: string
  loadingMore?: boolean
  hasMore?: boolean
}>()

const emit = defineEmits<{ loadOlder: [] }>()

/** 泡泡的基礎高度（發送者列 + 一行文字 + 間距），單位 px */
const BASE_HEIGHT = 62
/** 每行約可容納的字元數（以中欄寬度與 13px 字級估） */
const CHARS_PER_LINE = 42
const LINE_HEIGHT = 20
const ATTACHMENT_HEIGHT = 26
/** 圖片縮圖的高度上限（見 MessageBubble.vue 的 `max-h-55` = 220px）+ 邊框與間距 */
const IMAGE_ATTACHMENT_HEIGHT = 228

function estimateHeight(m: Message): number {
  const lines = Math.max(1, Math.ceil((m.text?.length ?? 0) / CHARS_PER_LINE))
  const explicitBreaks = (m.text?.match(/\n/g)?.length ?? 0)
  const attachmentsHeight = (m.attachments ?? []).reduce(
    (sum, a) => sum + (a.kind === 'image' && a.url ? IMAGE_ATTACHMENT_HEIGHT : ATTACHMENT_HEIGHT),
    0,
  )
  return BASE_HEIGHT
    + (lines - 1 + explicitBreaks) * LINE_HEIGHT
    + attachmentsHeight
}

const source = computed(() => props.messages)

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(source, {
  itemHeight: (index: number) => {
    const m = source.value[index]
    return m ? estimateHeight(m) : BASE_HEIGHT
  },
  overscan: 8,
})

/** 距離底部多少 px 以內算「貼在底部」—— 留一點餘裕，不必剛好到 0 */
const STICK_THRESHOLD = 80
const stickToBottom = ref(true)

function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD

  // 捲到最上面時回補更早的歷史
  if (el.scrollTop < 40 && props.hasMore && !props.loadingMore) emit('loadOlder')
}

watch(
  () => props.messages.length,
  async (next, prev) => {
    if (next === 0) return
    // ⚠️ 只在原本就貼底時才跟隨，否則會打斷正在翻閱歷史的客服
    if (!stickToBottom.value && prev !== 0) return
    await nextTick()
    scrollTo(next - 1)
  },
  { immediate: true },
)

/** 手動回到底部 —— 沒有貼底時才顯示按鈕 */
async function jumpToBottom(): Promise<void> {
  stickToBottom.value = true
  await nextTick()
  scrollTo(props.messages.length - 1)
}
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <div v-bind="containerProps" class="h-full overflow-y-auto" @scroll="onScroll">
      <div v-bind="wrapperProps">
        <div v-if="hasMore || loadingMore" class="flex justify-center py-2">
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[0.875rem] transition-opacity hover:opacity-70 disabled:opacity-50"
            :style="{ color: 'var(--text-3)' }"
            :disabled="loadingMore"
            @click="emit('loadOlder')"
          >
            {{ loadingMore ? $t('common.loading') : $t('common.loadMore') }}
          </button>
        </div>

        <ConversationMessageBubble
          v-for="item in list"
          :key="item.data.id"
          :message="item.data"
          :mine="!!myOperatorId && item.data.sender.id === myOperatorId"
        />
      </div>
    </div>

    <Transition name="fade">
      <button
        v-if="!stickToBottom && messages.length > 0"
        type="button"
        class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.875rem] shadow-sm"
        :style="{ background: 'var(--surface)', borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
        @click="jumpToBottom"
      >
        <UIcon name="i-lucide-arrow-down" class="size-3.5" />
        {{ $t('conversation.messageCount', { n: messages.length }) }}
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity .15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active {
    transition: none;
  }
}
</style>
