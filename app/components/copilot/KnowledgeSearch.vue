<script setup lang="ts">
/**
 * 知識庫自然語言快查 —— specs/002-suggestion-knowledge-search FR-007～FR-011、FR-022。
 *
 * 四種可互相區分的狀態：尚未輸入查詢／查無相關結果（FR-011）／錯誤（degraded）＋重試／需先 JOIN。
 *
 * ⚠️ 不顯示 `score` 或任何獨立編號——iMBrace 知識庫沒有正式的 SOP 編號制度，
 *    硬湊一個只是呼應設計稿的過度設計（research.md #2）。
 */

import type { KnowledgeHit } from '#shared/types/knowledge'

const props = defineProps<{ conversationId: string }>()
const emit = defineEmits<{ insert: [text: string] }>()

const { t } = useI18n()
const conversationId = computed(() => props.conversationId)
const search = useKnowledgeSearch(conversationId)

/** 超過 12 個月視為過舊（FR-009），updatedAt 為 null 時不觸發（研究 #2：不謊報） */
function isStale(updatedAt: string | null): boolean {
  if (!updatedAt) return false
  const ms = Date.now() - new Date(updatedAt).getTime()
  return ms > 365 * 24 * 60 * 60 * 1000
}

/**
 * 更新日期 —— 畫布 2a 是 `2026/05`（年／月，等寬字），不是完整日期。
 *
 * ⚠️ 只到月份是刻意的：知識庫文件的「更新日」精確到天並不會改變客服的判斷
 *    （要判斷的是「這份夠不夠新」），而完整日期在 420px 寬的面板裡會逼標題再縮一截。
 */
function formatDate(updatedAt: string | null): string {
  if (!updatedAt) return t('copilot.knowledgeSearch.updatedAtUnknown')
  const d = new Date(updatedAt)
  if (Number.isNaN(d.getTime())) return t('copilot.knowledgeSearch.updatedAtUnknown')
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** ref（sourceRef.ref）→ 展開全文取回的片段列表；只有按過「展開全文」的項目才有值 */
const expanded = ref<Record<string, string[]>>({})
const expanding = ref<Record<string, boolean>>({})

async function onExpand(hit: KnowledgeHit): Promise<void> {
  const ref = hit.sourceRef.ref
  expanding.value = { ...expanding.value, [ref]: true }
  try {
    const more = await search.expand(ref)
    expanded.value = { ...expanded.value, [ref]: more.map(h => h.snippet) }
  }
  finally {
    expanding.value = { ...expanding.value, [ref]: false }
  }
}
</script>

<template>
  <!-- ⚠️ 快查在畫布 2a 上**沒有** tag（其餘四塊都有），不要為了整齊而發明一個 -->
  <CopilotBlockShell :title="t('copilot.knowledgeSearch.title')">
    <div class="space-y-3">

    <!-- 畫布 2a：搜尋框內含放大鏡 icon、`--surface-2` 底、`--border-strong` 框 -->
    <div
      class="flex h-9 items-center gap-2 rounded-lg border px-2.5"
      :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)' }"
    >
      <UIcon name="i-lucide-search" class="size-3.5 shrink-0" :style="{ color: 'var(--text-3)' }" />
      <input
        v-model="search.query.value"
        type="text"
        class="h-full w-full bg-transparent text-[0.90625rem] outline-none placeholder:opacity-70"
        :style="{ color: 'var(--text)' }"
        :aria-label="t('copilot.knowledgeSearch.title')"
        :placeholder="t('copilot.knowledgeSearch.placeholder')"
      >
    </div>

    <!-- 需先 JOIN -->
    <p v-if="search.notJoined.value" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
      <UIcon name="i-lucide-lock" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.knowledgeSearch.notJoined') }}</span>
    </p>

    <!-- 錯誤（degraded）＋重試 -->
    <div v-else-if="search.degraded.value" class="ac-alert-warn flex items-center justify-between gap-2 px-3 py-2">
      <span class="flex items-center gap-2">
        <UIcon name="i-lucide-wifi-off" class="size-3.5 shrink-0" />
        {{ t('copilot.knowledgeSearch.degraded') }}
      </span>
      <button type="button" class="rounded-md p-1 transition-opacity hover:opacity-70" @click="search.search()">
        <UIcon name="i-lucide-rotate-cw" class="size-4" />
      </button>
    </div>

    <p v-else-if="search.error.value" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ search.error.value }}</span>
    </p>

    <!-- 尚未輸入查詢 -->
    <p v-else-if="!search.hasQueried.value" class="text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.knowledgeSearch.empty') }}
    </p>

    <!-- 查無相關結果（FR-011） -->
    <p v-else-if="!search.loading.value && search.hits.value.length === 0" class="text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.knowledgeSearch.noResults') }}
    </p>

    <div v-else-if="search.loading.value && search.hits.value.length === 0" class="space-y-2">
      <div class="ac-skel ac-skel-shimmer h-10 w-full" />
    </div>

    <!-- 結果列表 -->
    <!-- ⚠️ 列與列之間**不留間距**（畫布是純 flex column）—— 分隔靠每一列自己的上框線與 padding -->
    <ul v-else class="flex flex-col">
      <!--
        ⚠️ **每一筆都有上分隔線，包含第一筆**（畫布 2a）—— 上方緊接著的是搜尋框，
           那條線分開的是「輸入」與「結果」，不是結果與結果。先前的 `first:border-t-0`
           讓第一筆與搜尋框黏在一起。
      -->
      <li v-for="hit in search.hits.value" :key="hit.id" class="flex flex-col gap-[5px] border-t px-0.5 py-[9px]" :style="{ borderColor: 'var(--border)' }">
        <div class="flex items-center gap-2">
          <!--
            ⚠️ 標題**單行截斷**（畫布）：長標題換行會把右側的更新日期推開，
               而那個日期正是判斷「這筆能不能引用」的依據。
          -->
          <span class="min-w-0 truncate text-[0.9375rem] font-medium">{{ hit.title }}</span>
          <div class="flex-1" />
          <span class="ac-mono shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
            {{ formatDate(hit.updatedAt) }}
          </span>
        </div>
        <!--
          ⚠️ 摘錄**兩行截斷**（畫布 `-webkit-line-clamp:2`）—— 這是「三筆結果能不能
             一屏內掃完」的關鍵；一筆長摘錄整段展開就會把後面兩筆推到視窗外。
        -->
        <p class="line-clamp-2 text-[0.875rem] leading-[1.65]" :style="{ color: 'var(--text-2)' }">{{ hit.snippet }}</p>

        <!--
          過期警示（畫布 2a）：**獨立一列、`--open` 系、帶文字**。
          ⚠️ 先前只把右上角的日期染成 `--warn` 並加一個驚嘆號圖示 —— 那違反憲法 8.1
             （顏色與圖示不是唯一資訊來源），而且沒有任何地方說明「過期」是指多久。
          ⚠️ 色系是 `--open` 不是 `--warn`：這不是錯誤，是「引用前請確認」的提醒。
        -->
        <div
          v-if="isStale(hit.updatedAt)"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.84375rem]"
          :style="{ color: 'var(--open)', background: 'var(--open-bg)' }"
        >
          <UIcon name="i-lucide-clock-alert" class="size-3 shrink-0" />
          {{ t('copilot.knowledgeSearch.staleWarning') }}
        </div>

        <div v-if="expanded[hit.sourceRef.ref]" class="space-y-1 rounded-lg p-2" :style="{ background: 'var(--surface-3)' }">
          <p v-for="(snippet, i) in expanded[hit.sourceRef.ref]" :key="i" class="text-[0.8125rem]" :style="{ color: 'var(--text-2)' }">
            {{ snippet }}
          </p>
          <p class="text-[0.75rem]" :style="{ color: 'var(--text-3)' }">{{ t('copilot.knowledgeSearch.expandDisclaimer') }}</p>
        </div>

        <!--
          畫布 2a 的按鈕列**靠左**，且「插入為回覆」在前、「展開全文」在後（無框、帶 chevron）。
          ⚠️ 兩顆都不是 primary —— 快查的每一筆都是候選，把其中一顆做成 primary
             等於暗示「就選這個」，而知識庫命中排序沒有強到可以那樣暗示。
        -->
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="h-[25px] rounded-md border px-[9px] text-[0.875rem] transition-opacity hover:opacity-70"
            :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text)' }"
            @click="emit('insert', hit.snippet)"
          >
            {{ t('copilot.knowledgeSearch.insert') }}
          </button>
          <button
            type="button"
            class="flex h-[25px] items-center gap-[5px] px-2 text-[0.875rem] transition-opacity hover:opacity-70 disabled:opacity-50"
            :style="{ color: 'var(--text-2)' }"
            :disabled="expanding[hit.sourceRef.ref]"
            @click="onExpand(hit)"
          >
            <UIcon
              :name="expanding[hit.sourceRef.ref] ? 'i-lucide-loader-circle' : 'i-lucide-chevron-down'"
              class="size-3"
              :class="{ 'animate-spin': expanding[hit.sourceRef.ref] }"
            />
            {{ t('copilot.knowledgeSearch.expand') }}
          </button>
        </div>
      </li>
    </ul>
    </div>
  </CopilotBlockShell>
</template>
