<script setup lang="ts">
/**
 * 建議卡清單（區塊層級狀態機）—— specs/002-suggestion-knowledge-search FR-014、FR-015、FR-024。
 *
 * 四種可互相區分的狀態：
 *   - `empty`                        → 「尚無資料」（FR-014）
 *   - `analyzing`／`retrying`        → 「產生中」／「重試中 (n/2)」
 *   - `ready` 且 `cards.length === 0` → 「本次未產生建議」（中性，非錯誤）
 *   - `error`                        → 「暫時無法產生建議」＋重試按鈕
 *
 * `ready && cards.length === 0` 底下有兩種語意（`knowledgeSearch.hitCount === 0` = 知識庫
 * 沒這題／`> 0` = 有命中但引用全遭白名單捨棄）：對客服的呈現一致（都是中性空狀態），
 * 但後者是模型杜撰引用的訊號，MUST 分別記錄供事後稽核（data-model.md §7）。
 *
 * ⚠️ **FR-024**：`ready` 狀態下 MUST NOT 出現任何一般性的「重新產生」按鈕；重試按鈕只在
 *    `error` 狀態可用。快取鍵（§11.3）是 `{conversationId}:{lastMessageId}`，同一狀態不會
 *    產生不同結果——任何「重新產生」都只是給出系統做不到的承諾。
 */

import type { SuggestionBlock } from '#shared/types/copilot'

/**
 * @prop citedAt 第二段剛整批換上有 SOP 依據的卡片的時間戳（004 FR-007）。
 *   由 `useCopilotSession()` 以**轉移**推導（見該處註解），本元件只負責顯示與淡出。
 */
const props = defineProps<{ block: SuggestionBlock, citedAt: number | null }>()
const emit = defineEmits<{ retry: [], insert: [text: string] }>()

const { t } = useI18n()

const statusText = computed(() => {
  switch (props.block.status) {
    case 'analyzing':
      return t('copilot.suggestion.analyzing')
    case 'retrying':
      return t('copilot.suggestion.retrying', { attempt: props.block.retryAttempt ?? 1 })
    case 'error':
      return t('copilot.suggestion.error')
    default:
      return null
  }
})

/**
 * 區塊 tag（畫布 2a：「3 則建議」）。
 *
 * ⚠️ **刻意不做畫布的「產生中 x / y」**：那個進度在 004 的兩段式生成下已經沒有對應語意 ——
 *    第一段先給整批不帶引用的卡，第二段再整批換掉，中途不存在「已完成 x 張、還剩 y 張」
 *    這種狀態。照抄會顯示一個永遠對不上實際流程的進度（2026-08-29 使用者裁示 D-15）。
 * ⚠️ 沒有卡片時不顯示 tag，而不是顯示「0 則建議」—— 空狀態的說明已經在區塊內容裡。
 */
const countTag = computed(() => (
  props.block.cards.length ? t('copilot.suggestion.count', { n: props.block.cards.length }) : null
))

const readyEmpty = computed(() => props.block.status === 'ready' && props.block.cards.length === 0)

/**
 * 004 FR-002：第二段（帶知識庫命中重新生成）還在跑。
 *
 * ⚠️ 與 `status` **正交** —— `ready` ＋ `pending` 是正常且常見的組合（卡片可用，
 *    只是還不知道有沒有 SOP 依據）。MUST NOT 把它畫成一種「還沒好」的狀態，
 *    也 MUST NOT 讓重試按鈕因此變成可按（FR-024：只有 `error` 可按）。
 */
const citationPending = computed(() => props.block.citation === 'pending')

/**
 * 004 FR-007：整批換卡是**程式主動**的更新，MUST 有區塊層級的明確提示 ——
 * 客服可能正盯著某一張卡讀到一半，內容悄悄換掉比沒有更新更糟。
 *
 * 提示 5 秒後自動淡出：它是「剛剛發生了什麼」的說明，不是需要處理的狀態。
 * ⚠️ `citedAt` 變回 `null`（新一輪分析、切換對話）時 MUST 立即隱藏，不等計時器。
 */
const CITED_CUE_MS = 5_000
const showCitedCue = ref(false)
let cueTimer: ReturnType<typeof setTimeout> | undefined

watch(() => props.citedAt, (at) => {
  clearTimeout(cueTimer)
  showCitedCue.value = at !== null
  if (at !== null) cueTimer = setTimeout(() => { showCitedCue.value = false }, CITED_CUE_MS)
})

/**
 * 畫布 2a 的「可捲動查看其餘建議」提示。
 *
 * ⚠️ **依實際是否溢出決定，不是寫死或依卡片數量。** 卡片高度隨內容長短差很多，
 *    兩張長卡就會溢出、三張短卡可能不會——用張數判斷會在兩個方向都說謊，
 *    而「說有得捲卻捲不動」比不提示更糟。
 * ⚠️ 量測要等 DOM 更新完（`nextTick`），否則拿到的是換卡前的高度。
 */
const scrollBox = ref<HTMLElement | null>(null)
const scrollable = ref(false)

function measure(): void {
  const el = scrollBox.value
  scrollable.value = el ? el.scrollHeight > el.clientHeight + 1 : false
}

watch(() => props.block.cards, () => void nextTick(measure), { deep: true, immediate: true })

/**
 * ⚠️ 面板寬度**可拖曳**，變窄會讓卡片換行變高、原本捲不動的變成捲得動。
 *    只在卡片變動時量測會讓提示與實際狀態脫節，所以一併觀察尺寸。
 */
let observer: ResizeObserver | undefined
onMounted(() => {
  void nextTick(measure)
  if (scrollBox.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(scrollBox.value)
  }
})

onBeforeUnmount(() => {
  clearTimeout(cueTimer)
  observer?.disconnect()
})
</script>

<template>
  <CopilotBlockShell :title="t('copilot.suggestion.title')" :tag="countTag">
    <template #actions>
      <!-- 檢索中（004 FR-002）：圖示＋文字，兩者缺一不可（憲法 8.1） -->
      <span v-if="citationPending" class="flex shrink-0 items-center gap-1 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 shrink-0 animate-spin" />
        {{ t('copilot.suggestion.citationPending') }}
      </span>
      <span v-if="statusText" class="shrink-0 text-[0.8125rem]" :style="{ color: block.status === 'error' ? 'var(--warn)' : 'var(--text-3)' }">
        {{ statusText }}
      </span>
      <!-- FR-024：重試按鈕只在 error 狀態可用，非一般性的「重新產生」 -->
      <button
        type="button"
        class="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
        :style="{ color: 'var(--text-3)' }"
        :disabled="block.status !== 'error'"
        :aria-label="t('copilot.retry')"
        :title="t('copilot.retry')"
        @click="emit('retry')"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" />
      </button>
    </template>

    <!-- empty：尚無資料（FR-014） -->
    <p v-if="block.status === 'empty'" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.suggestion.empty') }}
    </p>

    <!-- 首次 analyzing／retrying，尚無任何卡片可疊加 -->
    <div v-else-if="block.cards.length === 0 && (block.status === 'analyzing' || block.status === 'retrying')" class="mt-3 space-y-2">
      <div class="ac-skel ac-skel-shimmer h-16 w-full" />
    </div>

    <!-- 從未成功過的 error：無卡片可顯示 -->
    <p v-else-if="block.cards.length === 0 && block.status === 'error'" class="ac-alert-warn mt-3 flex items-start gap-2 px-3 py-2">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.suggestion.error') }}</span>
    </p>

    <!--
      ready 且 cards.length === 0：本次未產生建議（中性，非錯誤）。
      ⚠️ 這個狀態下 `citation` 仍可能是 `'pending'`（第一段白名單後為空、第二段還在跑），
         此時 MUST 一併說明還在檢索——否則客服會以為「就是沒有建議」而不再回頭看。
    -->
    <div v-else-if="readyEmpty" class="mt-3 space-y-1">
      <p class="text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
        {{ t('copilot.suggestion.readyEmpty') }}
      </p>
      <p v-if="citationPending" class="flex items-center gap-1 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 shrink-0 animate-spin" />
        {{ t('copilot.suggestion.citationPending') }}
      </p>
    </div>

    <!-- 有卡片：ready／retrying(保留舊卡)／error(曾成功過，仍顯示上次卡片) -->
    <div v-else class="mt-3">
      <!-- 004 FR-007：第二段整批換上有 SOP 依據的版本 —— 圖示＋文字（憲法 8.1），role="status" -->
      <p
        v-if="showCitedCue"
        role="status"
        aria-live="polite"
        class="mb-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.8125rem] transition-opacity"
        :style="{ background: 'var(--surface-3)', color: 'var(--text-2)' }"
      >
        <UIcon name="i-lucide-book-check" class="size-3.5 shrink-0" />
        {{ t('copilot.suggestion.citedUpdated') }}
      </p>

      <!--
        ⚠️ `max-h-120`（480px）是畫布 `max-height:392px` 依 C-10 換算後的等效值 ——
           實作的字級整體加大約 2.5px（約 1.2 倍），照抄 392px 會比畫布少露出約一張卡。
           這是**幾何跟著字級一起縮放**的少數幾處之一，不是漏抄。
      -->
      <div ref="scrollBox" class="max-h-120 space-y-2 overflow-y-auto">
        <CopilotSuggestionCard
          v-for="card in block.cards"
          :key="card.id"
          :card="card"
          :citation="block.citation"
          @insert="emit('insert', $event)"
        />
      </div>

      <!-- 捲動提示（畫布 2a）：**置中** ＋ `chevrons-down` icon ＋ 文字，不是靠左的一行純文字 -->
      <p
        v-if="scrollable"
        class="mt-2 flex items-center justify-center gap-1.5 text-[0.8125rem]"
        :style="{ color: 'var(--text-3)' }"
      >
        <UIcon name="i-lucide-chevrons-down" class="size-3 shrink-0" />
        {{ t('copilot.suggestion.scrollHint') }}
      </p>
    </div>
  </CopilotBlockShell>
</template>
