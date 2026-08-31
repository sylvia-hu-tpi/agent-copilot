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

/** ⚠️ 範圍與 clamp 規則 MUST 與工作區頁一致，否則兩頁的側欄會不同寬 */
const sidebar = usePanelWidth({ key: 'ac.sidebarWidth', def: 280, min: 220, max: 400 })

let offStream: (() => void) | undefined

onMounted(() => {
  sidebar.restore()

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

/**
 * 「處理最舊的 active 對話」（畫布 §9）—— 以 `lastMessageAt` 最舊者為準。
 *
 * ⚠️ 只在**已載入**的清單裡挑，不另外打 API。措辭因此是「最舊的 active 對話」而非
 *    「最久沒人理的對話」—— 後者要看整個組織，而側欄只涵蓋最近 N 筆（`atCoverageLimit`）。
 * ⚠️ 沒有 active 對話時整顆按鈕不出現，而不是出現一顆按了沒反應的按鈕。
 */
const oldestActiveId = computed(() => {
  const actives = conversations.items.filter(c => c.status === 'active')
  if (actives.length === 0) return null
  const at = (c: typeof actives[number]) => new Date(c.lastMessageAt ?? c.updatedAt).getTime() || 0
  return actives.reduce((oldest, c) => (at(c) < at(oldest) ? c : oldest)).id
})
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="shrink-0" :style="{ width: `${sidebar.width.value}px` }">
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
      />
    </div>

    <!--
      未選擇對話（畫布 §9 / 1d-empty）：虛線方框 icon ＋ 標題 ＋ 說明 ＋ 兩個動作。
      ⚠️ 畫布的第二顆按鈕是「只看未回覆」，**刻意不做** —— 「未回覆」要知道最後一則
         訊息是誰送的，而平台的對話清單 payload 沒有這個欄位（D-12／F-22c 同一個阻塞）。
         用 `status === 'active'` 頂替是把兩件不同的事說成同一件：active 是「對話進行中」，
         不等於「輪到我們回」。
    -->
    <section class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div class="flex max-w-[26rem] flex-col items-center gap-3 text-center">
        <span
          class="flex size-[46px] items-center justify-center rounded-xl border border-dashed"
          :style="{ borderColor: 'var(--border-dash)', color: 'var(--text-3)' }"
          aria-hidden="true"
        >
          <UIcon name="i-lucide-messages-square" class="size-5" />
        </span>
        <h1 class="text-[1.03125rem] font-bold">{{ $t('conversation.noneSelected') }}</h1>
        <p class="text-[0.90625rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
          {{ $t('conversation.noneSelectedHintBefore') }}
          <span class="inline-flex items-center gap-1" :style="{ color: 'var(--active)' }">
            <span class="size-1.5 rounded-full" :style="{ background: 'var(--active)' }" aria-hidden="true" />active
          </span>
          {{ $t('conversation.noneSelectedHintAfter') }}
        </p>
        <button
          v-if="oldestActiveId"
          type="button"
          class="ac-btn-primary mt-1 h-8 px-3 text-[0.90625rem]"
          @click="select(oldestActiveId)"
        >
          {{ $t('conversation.openOldestActive') }}
        </button>
      </div>
    </section>
  </div>
</template>
