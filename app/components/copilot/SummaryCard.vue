<script setup lang="ts">
/**
 * 對話摘要 —— 畫布 2a 區塊②（`docs/DESIGN_TOKENS.md` §7.2），
 * specs/001-sentiment-panel FR-001、FR-006、FR-009、FR-011、FR-014。
 *
 * 版面自上而下（逐字對照畫布）：
 *
 *     摘要正文（一段）
 *     主題／風險 pill 列
 *     ▸ 詳細內容（keyFacts／已嘗試／待解／建議行動）
 *     產生於 HH:MM:SS  ←彈性→  [重新產生]
 *
 * ⚠️ **「詳細內容」那四段是畫布沒有的**（2026-09-01 使用者裁定方案 B）：畫布只畫一段正文，
 *    但 `keyFacts`／`openIssues`／`advice` 正是接手前最有用的內容，為了版面丟掉不划算。
 *    折衷是「正文在上、細節收起來」——畫布那個形狀是為「接手前 10 秒掃完」設計的，
 *    細節是掃完之後才要查的東西。
 *
 * 五態呈現（`AnalysisBlockStatus`，憲法 8.1 擴大適用至所有狀態資訊）：
 * empty／analyzing／retrying／ready／error，彼此視覺上可區分。
 *
 * ⚠️ `ready → analyzing`（增量重新分析）期間 MUST 保留舊內容疊加「更新中」提示，
 *    不得清空重回骨架屏（data-model.md「呈現規則」）。
 * ⚠️ 重試按鈕（憲法 8.2 可鍵盤操作）MUST 維持可見但停用，非 error 狀態時 disabled
 *    （2026-08-26 定案 CHK033），不額外加冷卻節流（既有 409 已足夠防重疊，CHK032）。
 *    ⚠️ 它的位置在**卡片底列**（畫布），不是區塊標題列 —— 這一塊在畫布上唯一的
 *    標題列右側內容是 tag「AI 產生 · 接手前必讀」。
 */

import type { ConversationSummary, SummaryBlock } from '#shared/types/copilot'

const props = defineProps<{ block: SummaryBlock }>()
const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()

/**
 * 風險旗標的配色與圖示 —— 畫布把「重複進線」畫成 `--open` 系（`--open` 字／`--open-bg` 底／
 * 邊框同為 `--open-bg`），與主題標籤的 `--navy-soft` 系分屬兩色，一眼分得出
 * 「在談什麼」與「有什麼風險」。
 *
 * ⚠️ 五種各給不同 icon：憲法 8.1 要求資訊不可只靠顏色，而五個 pill 同色同形時
 *    掃過去只會看到「一排橘色」。文字本身已足夠，icon 是加速辨識用的。
 */
const RISK_FLAG_ICON: Record<ConversationSummary['riskFlags'][number], string> = {
  churn: 'i-lucide-trending-down',
  escalation: 'i-lucide-circle-arrow-up',
  compliance: 'i-lucide-scale',
  vip: 'i-lucide-star',
  repeat_contact: 'i-lucide-repeat',
}

const RISK_FLAG_TONE = { background: 'var(--open-bg)', borderColor: 'var(--open-bg)', color: 'var(--open)' }

/**
 * 主題標籤 —— `--navy-soft` 底 ＋ `tag` icon。
 *
 * ⚠️ 文字用 `--info` 而**不是**畫布寫的 `--navy-2`：後者同時是按鈕的 hover 底色，
 *    為了這裡調亮會讓按鈕上的白字失去對比（`DESIGN_FEEDBACK.md` B-2）。
 */
const TOPIC_TONE = { background: 'var(--navy-soft)', borderColor: 'var(--navy-soft-bd)', color: 'var(--info)' }

const hasContent = computed(() => props.block.summary !== null)

/**
 * 摘要正文。
 *
 * ⚠️ `narrative` 缺值時退回 `intent` —— 那個欄位由 iMBrace 後台的
 *    `AgentCopilot_摘要_agent` 產生，後台還沒更新（或被改回舊版）時就會是 `undefined`。
 *    此時卡片仍要看得懂，不能開天窗。
 */
const narrative = computed(() => props.block.summary?.narrative || props.block.summary?.intent || '')

/** `narrative` 缺值時正文只剩一句意圖 —— 這種情況下細節區預設展開，否則整張卡幾乎是空的 */
const detailsOpen = ref(false)
watch(() => props.block.summary?.narrative, (n) => { detailsOpen.value = !n }, { immediate: true })

const hasDetails = computed(() => {
  const s = props.block.summary
  if (!s) return false
  return s.keyFacts.length > 0 || s.attempted.length > 0 || s.openIssues.length > 0 || Boolean(s.advice)
})

/**
 * 產生時間 —— 畫布逐字是 `generated 14:20:11`（英文 ＋ mono）。
 * ⚠️ 文案**刻意中文化**為「產生於 …」，與建議卡的「推薦理由：」（D-20）同一個方向：
 *    面板是給客服看的即時輔助，不是給工程師看的欄位名。時間本身維持 mono ＋ 到秒。
 */
const generatedAt = computed(() => {
  const iso = props.block.summary?.updatedAt
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
})

const statusText = computed(() => {
  switch (props.block.status) {
    case 'analyzing':
      return hasContent.value ? t('copilot.summary.updating') : t('copilot.summary.analyzing')
    case 'retrying':
      return t('copilot.summary.retrying', { attempt: props.block.retryAttempt ?? 1 })
    case 'error':
      return t('copilot.summary.error')
    default:
      return null
  }
})

const statusColor = computed(() => {
  if (props.block.status === 'error') return 'var(--warn)'
  if (props.block.status === 'retrying') return 'var(--warn)'
  return 'var(--text-3)'
})
</script>

<template>
  <CopilotBlockShell :title="t('copilot.summary.title')" :tag="statusText ? null : t('copilot.summary.tag')">
    <template #actions>
      <span
        v-if="statusText"
        class="shrink-0 text-[0.8125rem]"
        :style="{ color: statusColor }"
        :aria-live="block.status === 'error' ? 'polite' : undefined"
      >
        {{ statusText }}
      </span>
    </template>

    <!-- empty：尚無可分析內容（FR-009），與 error／loading 視覺上可區分 -->
    <p v-if="block.status === 'empty'" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.summary.empty') }}
    </p>

    <!--
      首次 analyzing，尚無任何舊內容可疊加 —— 畫布是四條 skeleton（首條帶 shimmer，
      寬 100%／94%／62%）＋ 兩顆 pill skeleton，形狀照抄才不會在載入完成瞬間抽動
    -->
    <div v-else-if="!hasContent && block.status === 'analyzing'" class="mt-3 space-y-2">
      <div class="ac-skel ac-skel-shimmer h-3 w-full" />
      <div class="ac-skel h-3 w-[94%]" />
      <div class="ac-skel h-3 w-[62%]" />
      <div class="flex gap-2 pt-1">
        <div class="ac-skel h-5 w-20 rounded-full" />
        <div class="ac-skel h-5 w-16 rounded-full" />
      </div>
    </div>

    <!--
      從未成功過的 error：無內容可顯示。
      畫布是一個帶標題與說明的告示框，不是一行字 —— 客服要知道的是
      「只有這一塊壞了、其他還能用」，而不只是「壞了」。
    -->
    <div
      v-else-if="!hasContent && block.status === 'error'"
      class="ac-alert-warn mt-3 flex items-start gap-2 px-3 py-2"
    >
      <UIcon name="i-lucide-alert-triangle" class="mt-0.5 size-3.5 shrink-0" />
      <div class="flex min-w-0 flex-col items-start gap-1.5">
        <span class="font-medium">{{ t('copilot.summary.errorTitle') }}</span>
        <span class="text-[0.84375rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
          {{ t('copilot.summary.errorHint') }}
        </span>
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.84375rem] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          :style="{ borderColor: 'var(--warn-bd)', background: 'var(--surface)', color: 'var(--warn)' }"
          :disabled="block.status !== 'error'"
          @click="emit('retry')"
        >
          <UIcon name="i-lucide-refresh-cw" class="size-3 shrink-0" />
          {{ t('copilot.summary.regenerate') }}
        </button>
      </div>
    </div>

    <!-- ready／retrying／analyzing(保留舊內容)／error(曾成功過，仍顯示上次內容) -->
    <div v-else-if="block.summary" class="mt-3 space-y-2.5">
      <p class="text-[0.9375rem] leading-relaxed">{{ narrative }}</p>

      <!-- 主題標籤（在談什麼）與風險旗標（有什麼風險）同一列、不同色系 -->
      <div
        v-if="(block.summary.topics?.length ?? 0) > 0 || block.summary.riskFlags.length > 0"
        class="flex flex-wrap gap-1.5"
      >
        <span
          v-for="topic in block.summary.topics ?? []"
          :key="`topic-${topic}`"
          class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.8125rem]"
          :style="TOPIC_TONE"
        >
          <UIcon name="i-lucide-tag" class="size-2.5 shrink-0" />
          {{ topic }}
        </span>
        <span
          v-for="flag in block.summary.riskFlags"
          :key="`risk-${flag}`"
          class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.8125rem]"
          :style="RISK_FLAG_TONE"
        >
          <UIcon :name="RISK_FLAG_ICON[flag]" class="size-2.5 shrink-0" />
          {{ t(`copilot.summary.riskFlags.${flag}`) }}
        </span>
      </div>

      <!--
        結構化細節 —— 畫布沒有這一段（見檔頭）。
        ⚠️ 原生 `<button>` ＋ `aria-expanded`（憲法 8.2），不是 `<div @click>`。
      -->
      <template v-if="hasDetails">
        <button
          type="button"
          class="flex items-center gap-1 text-[0.84375rem] transition-opacity hover:opacity-70"
          :style="{ color: 'var(--text-2)' }"
          :aria-expanded="detailsOpen"
          @click="detailsOpen = !detailsOpen"
        >
          <UIcon
            :name="detailsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3 shrink-0"
          />
          {{ t('copilot.summary.details') }}
        </button>

        <div v-if="detailsOpen" class="space-y-3 text-[0.9375rem]">
          <div v-if="block.summary.keyFacts.length > 0">
            <h3 class="ac-label">{{ t('copilot.summary.keyFacts') }}</h3>
            <ul class="list-disc space-y-0.5 pl-4">
              <li v-for="(fact, i) in block.summary.keyFacts" :key="i">{{ fact }}</li>
            </ul>
          </div>

          <div v-if="block.summary.attempted.length > 0">
            <h3 class="ac-label">{{ t('copilot.summary.attempted') }}</h3>
            <ul class="list-disc space-y-0.5 pl-4">
              <li v-for="(item, i) in block.summary.attempted" :key="i">{{ item }}</li>
            </ul>
          </div>

          <div v-if="block.summary.openIssues.length > 0">
            <h3 class="ac-label">{{ t('copilot.summary.openIssues') }}</h3>
            <ul class="list-disc space-y-0.5 pl-4">
              <li v-for="(issue, i) in block.summary.openIssues" :key="i">{{ issue }}</li>
            </ul>
          </div>

          <div v-if="block.summary.advice">
            <h3 class="ac-label">{{ t('copilot.summary.advice') }}</h3>
            <p>{{ block.summary.advice }}</p>
          </div>
        </div>
      </template>

      <!-- 曾成功過但這一輪失敗：舊內容留著，另外說明這一輪的狀況 -->
      <p v-if="block.status === 'error'" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ t('copilot.summary.error') }}</span>
      </p>

      <!-- 底列（畫布）：產生時間靠左、「重新產生」靠右 -->
      <div class="flex items-center gap-2">
        <span v-if="generatedAt" class="ac-mono text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
          {{ t('copilot.summary.generatedAt', { time: generatedAt }) }}
        </span>
        <span class="flex-1" />
        <button
          type="button"
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[0.84375rem] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface)', color: 'var(--text-2)' }"
          :disabled="block.status !== 'error'"
          :title="block.status === 'error' ? t('copilot.summary.regenerate') : t('copilot.retryOnlyOnError')"
          @click="emit('retry')"
        >
          <UIcon name="i-lucide-refresh-cw" class="size-3 shrink-0" />
          {{ t('copilot.summary.regenerate') }}
        </button>
      </div>
    </div>
  </CopilotBlockShell>
</template>
