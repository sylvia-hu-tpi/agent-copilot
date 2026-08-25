<script setup lang="ts">
/**
 * 單一訊息 —— docs/ARCHITECTURE.md §11.4 / §14.1.2。
 *
 * ⚠️ **發送者一律以 `sender.type` 標示，不可用時間分段推斷。**
 *    JOIN 之後 AI 仍持續運作（§10.5），所以「JOIN 之前是 AI、之後是真人」
 *    這個直覺是錯的 —— 該時點之後依然是混合狀態。
 *
 * ⚠️ `unknown` 型別必須誠實顯示為「未知來源」，不可預設歸給 AI。
 *    把同事誤判成 AI 會讓撞單防護失效（見 mappers.senderTypeOf）。
 */

import type { Message } from '#shared/types/conversation'
import { isWorkflowInternalMessage } from '#shared/types/conversation'

const props = defineProps<{ message: Message, mine: boolean }>()

/**
 * AI workflow 的內部訊息（`{"route":"T1"}` 這類）—— 客戶收不到。
 *
 * ⚠️ **降級顯示而不是隱藏。** 客服會同時開 iMBrace 官方介面對照，
 *    我方少顯示東西會讓他以為系統漏了訊息。灰底 + 明確標示，兩邊對得起來。
 */
const isInternal = computed(() => isWorkflowInternalMessage(props.message))

const { t } = useI18n()

/** 客戶靠左、客服／AI 靠右 —— 與一般客服介面的方向慣例一致 */
const alignRight = computed(() => props.message.sender.type !== 'customer')

const senderLabel = computed(() => {
  const { type, name } = props.message.sender
  if (type === 'agent') return name || t('sender.agent')
  return t(`sender.${type}`)
})

/**
 * 每一種發送者都有自己的色票，且**不只靠顏色**區分 ——
 * 泡泡上方永遠有文字標籤（憲法 8.1 的同一個原則：資訊不可只靠顏色傳達）。
 */
const tone = computed(() => {
  switch (props.message.sender.type) {
    case 'customer':
      return { bg: 'var(--surface-2)', bd: 'var(--border)', fg: 'var(--text)' }
    case 'ai':
      return { bg: 'var(--ai-bg)', bd: 'var(--ai-bd)', fg: 'var(--text)' }
    case 'agent':
      return { bg: 'var(--agent-bg)', bd: 'var(--agent-bd)', fg: 'var(--text)' }
    default:
      return { bg: 'var(--surface-3)', bd: 'var(--border-dash)', fg: 'var(--text-2)' }
  }
})

const senderIcon = computed(() => {
  switch (props.message.sender.type) {
    case 'customer': return 'i-lucide-user'
    case 'ai': return 'i-lucide-sparkles'
    case 'agent': return 'i-lucide-headset'
    default: return 'i-lucide-help-circle'
  }
})

const time = computed(() => {
  const d = new Date(props.message.at)
  return Number.isNaN(d.getTime())
    ? props.message.at
    : d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
})

const attachmentIcon: Record<string, string> = {
  image: 'i-lucide-image',
  audio: 'i-lucide-mic',
  video: 'i-lucide-video',
  file: 'i-lucide-paperclip',
}
</script>

<template>
  <div class="flex flex-col gap-1 px-4 py-1.5" :class="alignRight ? 'items-end' : 'items-start'">
    <div class="flex items-center gap-1.5 px-1 text-[10.5px]" :style="{ color: 'var(--text-3)' }">
      <UIcon :name="senderIcon" class="size-3" />
      <span class="font-medium">{{ senderLabel }}</span>
      <span v-if="mine" class="ac-mono">·</span>
      <time class="ac-mono">{{ time }}</time>
    </div>

    <div
      class="max-w-[min(78%,44rem)] rounded-xl border px-3 py-2 leading-relaxed"
      :class="isInternal ? 'text-[11.5px] border-dashed opacity-70' : 'text-[13px]'"
      :style="isInternal
        ? { background: 'var(--surface-2)', borderColor: 'var(--border-dash)', color: 'var(--text-3)' }
        : { background: tone.bg, borderColor: tone.bd, color: tone.fg }"
    >
      <p
        v-if="isInternal"
        class="ac-status-label mb-0.5 flex items-center gap-1"
      >
        <UIcon name="i-lucide-code-2" class="size-2.5" />
        {{ $t('sender.workflowInternal') }}
      </p>
      <p v-if="message.text" class="whitespace-pre-wrap break-words" :class="{ 'ac-mono': isInternal }">{{ message.text }}</p>

      <!--
        ⚠️ 附件目前只顯示檔名 —— 實測 content 只有 { name, media_id }，沒有 url，
           取檔需另外解析 media_id（IMBRACE_QUESTIONS H-2d）。這是 M1 刻意接受的暫行方案。
      -->
      <ul v-if="message.attachments?.length" class="mt-1.5 space-y-1">
        <li
          v-for="a in message.attachments"
          :key="a.id"
          class="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-[11.5px]"
          :style="{ borderColor: 'var(--border-dash)', color: 'var(--text-2)' }"
        >
          <UIcon :name="attachmentIcon[a.kind] ?? 'i-lucide-paperclip'" class="size-3.5 shrink-0" />
          <span class="ac-mono truncate">{{ a.filename }}</span>
          <span class="shrink-0 opacity-70">{{ $t(`attachment.${a.kind}`) }}</span>
        </li>
      </ul>

      <p
        v-if="!message.text && message.attachments?.length"
        class="mt-1 text-[10.5px] italic"
        :style="{ color: 'var(--text-3)' }"
      >
        {{ $t('attachment.noPreview') }}
      </p>
    </div>
  </div>
</template>
