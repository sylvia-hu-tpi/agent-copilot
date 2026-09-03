<script setup lang="ts">
/**
 * 對話摘要 —— 畫布 2a 區塊②（`docs/DESIGN_TOKENS.md` §7.2），
 * specs/001-sentiment-panel FR-001、FR-006、FR-009、FR-011、FR-014。
 *
 * 版面自上而下（逐字對照畫布 2026-09-01 版）：
 *
 *     ⚠ 無正文時的虛線降級提示（`noBody`）
 *     摘要正文（一段）
 *     主題／風險 pill 列
 *     ──────────────────────────────
 *     ▸ 詳細內容            四段 · 掃完摘要後查
 *     產生於 HH:MM:SS  ←彈性→  同一則訊息不會有不同結果，僅產生失敗時可重試
 *
 * ✅ **「詳細內容」四段已被畫布採納**（2026-09-01 改版；先前是實作自訂、畫布只有一段正文，
 *    舊 `DESIGN_FEEDBACK.md` C-13 已結清）。仍與畫布不同的是那四段內部用 `<ul>` 而非整段
 *    文字 —— 我方的 `keyFacts`／`attempted`／`openIssues` 是字串陣列，攤平會失去
 *    「這是幾件獨立的事」這個資訊。
 *
 * 五態呈現（`AnalysisBlockStatus`，憲法 8.1 擴大適用至所有狀態資訊）：
 * empty／analyzing／retrying／ready／error，彼此視覺上可區分。
 *
 * ⚠️ `ready → analyzing`（增量重新分析）期間 MUST 保留舊內容疊加「更新中」提示，
 *    不得清空重回骨架屏（data-model.md「呈現規則」）。
 * ⚠️ **重試入口只有一個，在 error 告示框裡。**（2026-09-01 改判，取代 2026-08-26 的 CHK033
 *    「維持可見但停用」。）畫布這一版把 ready 態的「重新產生」整顆拿掉，改成一句說明 ——
 *    理由正是我方 C-15 提的那個：快取鍵是「對話 ＋ 最後一則訊息」，同一個狀態重按不會有
 *    不同結果，常駐一顆按鈕等於給出系統做不到的承諾。⚠️ 常駐 `disabled` 版本 MUST NOT 回來。
 *    不額外加冷卻節流（既有 409 已足夠防重疊，CHK032）。
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
      首次 analyzing，尚無任何舊內容可疊加 —— 畫布 2a 是**三條** 10px skeleton
      （首條帶 shimmer，寬 100%／94%／62%）＋ 兩顆 20px 高的 pill skeleton，
      形狀照抄才不會在載入完成瞬間抽動
    -->
    <div v-else-if="!hasContent && block.status === 'analyzing'" class="mt-3 space-y-[7px]">
      <div class="ac-skel ac-skel-shimmer h-2.5 w-full" />
      <div class="ac-skel h-2.5 w-[94%]" />
      <div class="ac-skel h-2.5 w-[62%]" />
      <div class="flex gap-[7px] pt-[3px]">
        <div class="ac-skel h-5 w-[82px] rounded-full" />
        <div class="ac-skel h-5 w-[70px] rounded-full" />
      </div>
    </div>

    <!--
      從未成功過的 error：無內容可顯示。
      畫布是一個帶標題與說明的告示框，不是一行字 —— 客服要知道的是
      「只有這一塊壞了、其他還能用」，而不只是「壞了」。
    -->
    <div
      v-else-if="!hasContent && block.status === 'error'"
      class="ac-alert-warn mt-3 flex items-start gap-2 rounded-[9px] px-[11px] py-[9px]"
    >
      <UIcon name="i-lucide-alert-triangle" class="mt-px size-[15px] shrink-0" />
      <div class="flex min-w-0 flex-col items-start gap-1.5">
        <span class="text-[0.90625rem] font-medium">{{ t('copilot.summary.errorTitle') }}</span>
        <span class="text-[0.875rem] leading-[1.6]" :style="{ color: 'var(--text-2)' }">
          {{ t('copilot.summary.errorHint') }}
        </span>
        <!--
          ⚠️ 這裡的文案是「重試」不是「重新產生」（畫布逐字）——
             ready 態已經沒有按鈕了（見底列），這顆是**唯一**的重試入口，
             它的語意是「再試一次剛剛失敗的那件事」，不是「重新產生一份不同的摘要」。
        -->
        <button
          type="button"
          class="flex h-[27px] items-center gap-[5px] rounded-[7px] border px-2.5 text-[0.875rem] transition-opacity hover:opacity-70"
          :style="{ borderColor: 'var(--warn-bd)', background: 'var(--surface)', color: 'var(--warn)' }"
          @click="emit('retry')"
        >
          <UIcon name="i-lucide-refresh-cw" class="size-3 shrink-0" />
          {{ t('copilot.summary.errorRetry') }}
        </button>
      </div>
    </div>

    <!-- ready／retrying／analyzing(保留舊內容)／error(曾成功過，仍顯示上次內容) -->
    <div v-else-if="block.summary" class="mt-3 space-y-2.5">
      <!--
        沒有 `narrative` 時的降級說明（畫布 2a `noBody` 態，2026-09-01 新增）。
        ⚠️ 少了這個框，缺正文時畫面上**看不出是降級** —— 只會看到一句較短的文字
           （退回 `intent`）與一個莫名其妙自己展開的細節區，像是版面壞了。
           畫布把「為什麼變成這樣」直接寫出來，比讓客服自己猜好。
      -->
      <div
        v-if="!block.summary.narrative"
        class="flex items-start gap-[7px] rounded-lg border border-dashed px-2.5 py-2"
        :style="{ borderColor: 'var(--border-dash)', background: 'var(--surface-2)' }"
      >
        <UIcon name="i-lucide-file-question" class="mt-0.5 size-[13px] shrink-0" :style="{ color: 'var(--text-3)' }" />
        <span class="text-[0.875rem] leading-[1.65]" :style="{ color: 'var(--text-2)' }">
          {{ t('copilot.summary.noBody') }}
        </span>
      </div>

      <p class="text-[0.9375rem] leading-[1.75]">{{ narrative }}</p>

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
        結構化細節 —— **畫布 2026-09-01 版已採納這一段**（先前是實作自訂、畫布沒有的，
        舊 DESIGN_FEEDBACK C-13）。整段包在 `border-top` 的區塊裡，與上方正文／pill 分層。
        ⚠️ 原生 `<button>` ＋ `aria-expanded`（憲法 8.2），不是畫布的 `<div role="button">`。
        ⚠️ 段落內容用 `<ul>` 而非畫布的整段文字 —— 我方的 `keyFacts`／`attempted`／
           `openIssues` 是**字串陣列**，攤平成一段會失去「這是三件獨立的事」這個資訊。
           已登記於 DESIGN_FEEDBACK。
      -->
      <div v-if="hasDetails" class="border-t pt-2" :style="{ borderColor: 'var(--border)' }">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md text-[0.90625rem] font-medium transition-opacity hover:opacity-70"
          :style="{ color: 'var(--text-2)' }"
          :aria-expanded="detailsOpen"
          @click="detailsOpen = !detailsOpen"
        >
          <UIcon
            :name="detailsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-[13px] shrink-0"
          />
          {{ t('copilot.summary.details') }}
          <span class="flex-1" />
          <span class="text-[0.8125rem] font-normal" :style="{ color: 'var(--text-3)' }">
            {{ t('copilot.summary.detailsHint') }}
          </span>
        </button>

        <div v-if="detailsOpen" class="flex flex-col gap-[9px] px-0.5 pb-0.5 pt-[9px]">
          <div v-if="block.summary.keyFacts.length > 0" class="flex flex-col gap-[3px]">
            <span class="ac-detail-label">{{ t('copilot.summary.keyFacts') }}</span>
            <ul class="ac-detail-body list-disc space-y-0.5 pl-4">
              <li v-for="(fact, i) in block.summary.keyFacts" :key="i">{{ fact }}</li>
            </ul>
          </div>

          <div v-if="block.summary.attempted.length > 0" class="flex flex-col gap-[3px]">
            <span class="ac-detail-label">{{ t('copilot.summary.attempted') }}</span>
            <ul class="ac-detail-body list-disc space-y-0.5 pl-4">
              <li v-for="(item, i) in block.summary.attempted" :key="i">{{ item }}</li>
            </ul>
          </div>

          <div v-if="block.summary.openIssues.length > 0" class="flex flex-col gap-[3px]">
            <span class="ac-detail-label">{{ t('copilot.summary.openIssues') }}</span>
            <ul class="ac-detail-body list-disc space-y-0.5 pl-4">
              <li v-for="(issue, i) in block.summary.openIssues" :key="i">{{ issue }}</li>
            </ul>
          </div>

          <div v-if="block.summary.advice" class="flex flex-col gap-[3px]">
            <span class="ac-detail-label">{{ t('copilot.summary.advice') }}</span>
            <p class="ac-detail-body">{{ block.summary.advice }}</p>
          </div>
        </div>
      </div>

      <!-- 曾成功過但這一輪失敗：舊內容留著，另外說明這一輪的狀況 -->
      <p v-if="block.status === 'error'" class="ac-alert-warn flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ t('copilot.summary.error') }}</span>
      </p>

      <!--
        底列（畫布 2a，2026-09-01 版）：左「產生於 HH:MM:SS」、右一句說明。
        ⚠️ **ready 態沒有按鈕。** 畫布這一版直接把「重新產生」拿掉，改成一句說明 ——
           比我方原本「常駐但 disabled」更進一步，而理由正是我方 C-15 提的那個：
           快取鍵是「對話 ＋ 最後一則訊息」，同一個狀態重按不會有不同結果。
           重試入口只留在 error 告示框裡（那裡按下去才真的會有不同結果）。
        ⚠️ 等寬字**只包時間**，「產生於」是一般字（畫布逐字）——
           要逐字核對的是時間本身，不是那三個中文字。
      -->
      <div class="flex items-center gap-[7px]">
        <span v-if="generatedAt" class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
          {{ t('copilot.summary.generatedAt') }} <span class="ac-mono">{{ generatedAt }}</span>
        </span>
        <span class="flex-1" />
        <span class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
          {{ t('copilot.summary.regenerateHint') }}
        </span>
      </div>
    </div>
  </CopilotBlockShell>
</template>
