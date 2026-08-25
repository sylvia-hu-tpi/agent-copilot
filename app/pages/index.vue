<script setup lang="ts">
/**
 * 對話列表首頁 —— M1 起改為「側欄 + 空工作區」。
 *
 * ⚠️ 這一頁刻意**不**自動導向第一個對話。客服開啟系統時預期看到的是
 *    自己的工作佇列，被直接丟進某個對話會失去對「還有哪些待處理」的掌握 ——
 *    而且那個對話還會被 JOIN 前的 presence 上報標記成有人在看。
 */

definePageMeta({ layout: 'console' })

const router = useRouter()
const conversations = useConversationsStore()
const stream = useStreamStore()

const sidebarWidth = ref(280)

let offStream: (() => void) | undefined

onMounted(() => {
  try {
    const w = Number(localStorage.getItem('ac.sidebarWidth'))
    if (Number.isFinite(w) && w >= 200 && w <= 480) sidebarWidth.value = w
  }
  catch { /* 預設值即可 */ }

  conversations.setActive(null)
  void conversations.load()
  stream.connect()
  offStream = stream.on(evt => conversations.apply(evt))
})

onBeforeUnmount(() => offStream?.())

watch(() => conversations.query, () => void conversations.load())

function select(id: string): void {
  void router.push(`/c/${id}`)
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="shrink-0" :style="{ width: `${sidebarWidth}px` }">
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

    <section class="flex min-h-0 flex-1 items-center justify-center">
      <div class="max-w-sm space-y-2 px-6 text-center">
        <UIcon name="i-lucide-messages-square" class="size-8" :style="{ color: 'var(--text-3)' }" />
        <p class="text-[13px]" :style="{ color: 'var(--text-2)' }">
          {{ $t('conversation.selectPrompt') }}
        </p>
      </div>
    </section>
  </div>
</template>
