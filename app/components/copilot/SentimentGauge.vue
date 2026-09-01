<script setup lang="ts">
/**
 * 情緒 sparkline —— specs/001-sentiment-panel FR-002、FR-003、FR-009、FR-012、FR-014、FR-015。
 * 手刻 SVG polyline，不引圖表庫（docs/ARCHITECTURE.md §14.5）。
 *
 * ⚠️ 示警（FR-003、憲法 8.1）：MUST 以顏色＋圖示＋文字三者並呈，「挫折」與「生氣」
 *    MUST 可互相區分（不同色票＋不同圖示＋本就不同的標籤文字）。示警判定用
 *    `isSentimentAlerting()`（遲滯規則，見 shared/types/copilot.ts）而非單點判斷，
 *    避免批次中一則語氣稍緩的訊息誤導清除示警。文字標籤加 `aria-live="polite"`。
 *
 * ⚠️ 具體圖示樣式／文案措辭本規格刻意不預先鎖定（spec.md FR-003 2026-08-26 修訂）。
 *    ✅ **2026-09-01 已對照畫布原始檔核實** —— 先前那條「畫布的 `CopilotPanel` 是
 *    `dc-import` 動態渲染、擷取不到內部逐字內容」的限制**已經解除**：畫布匯出的 HTML
 *    把該元件存成獨立的 `CopilotPanel.dc.html` 資產（gzip＋base64），解出來就是完整原始碼。
 *    本檔的幾何、色票與字級自此以那份為準。
 *    ⚠️ 仍刻意不同的兩處（已登記於 `docs/DESIGN_FEEDBACK.md`）：示警 pill 的文案用五級分類
 *    而非畫布逐字的「焦慮偏高」；走勢摘要的 `advice` 半段加粗。
 */

import type { SentimentBlock, SentimentPoint, SentimentTimelineEntry } from '#shared/types/copilot'
import { isSentimentAlerting } from '#shared/types/copilot'

const props = defineProps<{ block: SentimentBlock }>()
const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()

/**
 * 圖表視窗的評分點上限。
 *
 * ⚠️ **這是上限，不是承諾 —— 實務上永遠達不到 50，真正的天花板約是它的一半。**
 *    因果鏈（2026-09-01 由使用者「只看得到 1–25 輪」一問查出，裁定維持現狀）：
 *
 *      冷啟動載入最新 50 則訊息（`DEFAULT_MESSAGE_LIMIT`，`server/sources/message-fetch.ts`）
 *        → 其中只有**客戶發的文字訊息**會變成評分點（`isTextCustomerMessage`）
 *          （客服／AI 的訊息不算；客戶的純附件訊息變成三角標記，不是點）
 *        → 一來一往的對話裡客戶訊息約佔半數 → **約 25 個點**
 *
 *    ⚠️ 中欄的「載入更早的訊息」**只影響顯示，不會補算情緒點** ——
 *       分析的輸入永遠是 JOIN 當下那 50 則。
 *    ⚠️ 實際點數還可能更少：自動恢復不補算先前失敗的批次（ARCHITECTURE §18 已記載的未修缺陷），
 *       而那一段缺席不會有任何提示。
 *
 *    要涵蓋更長的歷史就得提高 `DEFAULT_MESSAGE_LIMIT`，代價是情緒分析的批次數
 *    （`SENTIMENT_CHUNK_SIZE = 6`，依序送出）接近加倍，冷啟動時間跟著加倍。
 *    ⚠️ 因此**改這個常數沒有用**，要改的是那一邊。
 */
const MAX_POINTS = 50

/** 從尾端往前取，直到湊滿 MAX_POINTS 個 point，沿途遇到的 marker 一併保留（FR-012、FR-015） */
function recentWindow(timeline: SentimentTimelineEntry[]): SentimentTimelineEntry[] {
  let pointCount = 0
  let startIdx = timeline.length
  for (let i = timeline.length - 1; i >= 0; i--) {
    startIdx = i
    if (timeline[i]!.kind === 'point') pointCount++
    if (pointCount >= MAX_POINTS) break
  }
  return timeline.slice(startIdx)
}

/**
 * 畫布 2a（2026-09-01 改版）的座標系：`viewBox="0 0 320 52"`，**等比縮放**
 * （`width:100%; height:auto`），繪圖區 x ∈ [6, 314]、y ∈ [6, 42]，基準線在 y=42。
 *
 * ⚠️ **不可退回 `viewBox="0 0 100 100"` ＋ `preserveAspectRatio="none"`。**
 *    非等比拉伸會讓折線的斜率隨面板寬度改變 —— 而面板是可拖曳的（320–720px），
 *    同一段情緒變化在寬面板看起來平緩、在窄面板看起來陡峭。
 *    那不是樣式問題，是**把判讀依據畫錯**：客服看的正是「升得多陡」。
 *    「端點改用 CSS 絕對定位以免被壓成橢圓」那個繞道隨這個改動消失（改回 SVG `<circle>`）。
 *
 * ⚠️ **但 `vector-effect="non-scaling-stroke"` 要留著，理由與先前完全不同，不是殘留。**
 *    畫布的畫板寬度是**固定 420px**，而我方的面板**可拖曳 320–720px**。等比 viewBox 之下
 *    筆畫會跟著寬度一起放大：320 單位的座標系拉到 654px 可視寬時，`stroke-width="2"`
 *    會被畫成約 4px 的粗線 —— 畫布不會露出這個問題，因為它沒有可調寬度。
 *    加上 `non-scaling-stroke` 之後，**幾何（斜率）仍完全等比、線寬則固定為畫布給的值**，
 *    兩件事各自正確。⚠️ 拿掉它會讓面板越寬、線越粗。
 */
const VB = { x0: 6, x1: 314, yTop: 6, yBase: 42 } as const

interface Positioned { entry: SentimentTimelineEntry, x: number }

const windowEntries = computed(() => recentWindow(props.block.timeline))

/**
 * 區塊 tag（畫布 2a：示範值「近 50 輪」）。
 *
 * ⚠️ 數字是**這張圖實際畫了幾輪**（`windowEntries.length`），不是寫死的值，
 *    也不是完整 `timeline` 的長度 —— 圖上只畫得下視窗內的那一段（`MAX_POINTS`），
 *    tag 卻報全部的話就是在謊報樣本量。沒有資料時不顯示 tag。
 *
 * ⚠️ **必須與軸標籤右端用同一個數字。** 三個候選（完整 `timeline` 長度／視窗內全部項目／
 *    視窗內評分點數）在有附件輪或長對話時會給出不同的值，而 x 軸實際是 map 在
 *    **視窗內全部項目**上 —— 另外兩個都會讓 tag 與軸標籤自相矛盾。
 *    ⚠️ 2026-09-01：畫布自己就出過這個錯（tag「近 5 輪」配軸標籤「第 50 輪」），
 *    我方回報後 Design 已訂正；同一天發現我方也有同樣的問題，一併修掉。
 */
const roundsTag = computed(() => (
  windowEntries.value.length ? t('copilot.sentiment.rounds', { n: windowEntries.value.length }) : null
))

const positioned = computed<Positioned[]>(() => {
  const entries = windowEntries.value
  if (entries.length === 0) return []
  return entries.map((entry, i) => ({
    entry,
    x: entries.length === 1
      ? (VB.x0 + VB.x1) / 2
      : VB.x0 + (i / (entries.length - 1)) * (VB.x1 - VB.x0),
  }))
})

const pointsOnly = computed(() =>
  positioned.value.filter((p): p is Positioned & { entry: SentimentPoint } => p.entry.kind === 'point'))

const markersOnly = computed(() => positioned.value.filter(p => p.entry.kind === 'attachment_only'))

/** score 越高（越正面）在圖上越高 —— 0 分落在基準線、100 分落在繪圖區頂端 */
function yOf(score: number): number {
  return VB.yBase - (score / 100) * (VB.yBase - VB.yTop)
}

const polylinePoints = computed(() =>
  pointsOnly.value.map(p => `${p.x.toFixed(1)},${yOf(p.entry.score).toFixed(1)}`).join(' '))

/** 目前應顯示的示警等級 —— isSentimentAlerting() 的遲滯規則，但需要知道「哪一級」供文字/圖示區分 */
const alertLabel = computed<'frustrated' | 'angry' | null>(() => {
  if (!isSentimentAlerting(props.block.timeline)) return null
  for (let i = props.block.timeline.length - 1; i >= 0; i--) {
    const e = props.block.timeline[i]!
    if (e.kind !== 'point') continue
    if (e.label === 'frustrated' || e.label === 'angry') return e.label
    if (e.label === 'calm' || e.label === 'neutral') return null
  }
  return null
})

const alertColor = computed(() => (alertLabel.value === 'angry' ? 'var(--danger)' : 'var(--warn)'))
const alertBg = computed(() => (alertLabel.value === 'angry' ? 'var(--danger-bg)' : 'var(--warn-bg)'))
const alertBd = computed(() => (alertLabel.value === 'angry' ? 'var(--danger-bd)' : 'var(--warn-bd)'))
const strokeColor = computed(() => (alertLabel.value ? alertColor.value : 'var(--navy-2)'))

/**
 * 情緒量表圖例（畫布 2a：五段橫條，目前所在區間以
 * `box-shadow: inset 0 -3px 0 <色>` 的底線強調）。
 *
 * ⚠️ **標籤用中文，不用畫布的 `calm`／`neutral`／…英文。** 與 D-17（語氣標籤）
 *    同一個理由：這是給客服看的即時輔助，不是給工程師看的列舉值。
 *    i18n 的 `copilot.sentiment.label.*` 早就是這五個中文詞，沿用同一組不另立。
 * ⚠️ 「生氣」在畫布上是反白的 `--warn`，這裡改用 `--danger` 系 ——
 *    FR-003 要求「挫折」與「生氣」可互相區分，兩級共用 `--warn` 就分不出來了。
 */
const SCALE = [
  { key: 'calm', fg: 'var(--active)', bg: 'var(--active-bg)', bd: 'var(--border)', strong: false },
  { key: 'neutral', fg: 'var(--text-2)', bg: 'var(--surface-2)', bd: 'var(--border)', strong: false },
  { key: 'concerned', fg: 'var(--open)', bg: 'var(--open-bg)', bd: 'var(--border)', strong: false },
  { key: 'frustrated', fg: 'var(--warn)', bg: 'var(--warn-bg)', bd: 'var(--border)', strong: false },
  /*
    ⚠️ 「生氣」兩處與其他四段不同，兩者都照畫布 2a：
       ① 左分隔線用 `--danger-bd` 而非 `--border`；② 字重固定 500（即使不是目前所在段）。
       這是量表最末一級，畫布刻意讓它在「還沒走到那裡」時就看得出份量不同。
  */
  { key: 'angry', fg: 'var(--danger)', bg: 'var(--danger-bg)', bd: 'var(--danger-bd)', strong: true },
] as const

/** 目前落在量表的哪一段 —— 取最新的一個評分點，沒有點就不強調任何一段 */
const currentLabel = computed(() => {
  for (let i = props.block.timeline.length - 1; i >= 0; i--) {
    const e = props.block.timeline[i]!
    if (e.kind === 'point') return e.label
  }
  return null
})

/**
 * 分數與走向（畫布 2a：`score 0.72 ↑`）。
 *
 * ⚠️ **我方的 score 是 0–100，畫布示範的是 0.72（0–1）。這裡照我方的刻度顯示 72，
 *    不做 /100 的換算** —— 換算出來的 `0.72` 與 `SentimentPoint.score` 的定義不一致，
 *    對照日誌或 API 回應時會變成兩套數字。
 */
/** 折線末端（最新的一個評分點）—— 供圖上的實心端點 */
const lastPoint = computed(() => pointsOnly.value.at(-1) ?? null)

const scoreText = computed(() => {
  const pts = pointsOnly.value
  const last = lastPoint.value
  if (!last) return null
  const prev = pts.at(-2)
  const arrow = !prev || last.entry.score === prev.entry.score
    ? '→'
    : last.entry.score > prev.entry.score ? '↑' : '↓'
  return `score ${Math.round(last.entry.score)} ${arrow}`
})

const hasContent = computed(() => props.block.timeline.length > 0)

/**
 * 「有資料，但畫不出折線」—— 恰好一個評分點時的狀態（2026-08-28 真實環境發現）。
 *
 * ⚠️ `hasContent`（`timeline.length > 0`）決定要不要渲染內容區，折線卻要
 *    `pointsOnly.length > 1`。兩者不一致時會走進繪圖分支卻畫不出任何東西，
 *    呈現一個 64px 高、沒有數字也沒有文字的空白框——三個文字分支
 *    （`empty`／`analyzing`／`error`）都已經被 `hasContent` 跳過了。
 *    自動恢復後特別容易發生：`runIncremental()` 只補新訊息的點，先前失敗那批不補算。
 */
const singlePoint = computed(() => (pointsOnly.value.length === 1 ? pointsOnly.value[0]! : null))

const statusText = computed(() => {
  switch (props.block.status) {
    case 'analyzing':
      return hasContent.value ? t('copilot.sentiment.updating') : t('copilot.sentiment.analyzing')
    case 'retrying':
      return t('copilot.sentiment.retrying', { attempt: props.block.retryAttempt ?? 1 })
    case 'error':
      return t('copilot.sentiment.error')
    default:
      return null
  }
})

const statusColor = computed(() => (props.block.status === 'error' || props.block.status === 'retrying' ? 'var(--warn)' : 'var(--text-3)'))
</script>

<template>
  <CopilotBlockShell :title="t('copilot.sentiment.title')" :tag="roundsTag">
    <template #actions>
      <span v-if="statusText" class="shrink-0 text-[0.8125rem]" :style="{ color: statusColor }">
        {{ statusText }}
      </span>
      <!--
        ⚠️ **只在這一塊失敗時才出現**（畫布 2a 的標題列右側只有 tag，沒有按鈕）。
           先前是常駐但 `disabled` 的版本，與 2026-09-01 對 header「全部重試」的裁示
           自相矛盾：這顆按鈕本身就是「這一塊壞了」的訊號，常駐會讓訊號永遠亮著而失去意義。
           ⚠️ `disabled` 版本 MUST NOT 回來。
      -->
      <button
        v-if="block.status === 'error'"
        type="button"
        class="shrink-0 rounded-md p-1 transition-opacity hover:opacity-70"
        :style="{ color: 'var(--text-3)' }"
        :aria-label="t('copilot.retry')"
        :title="t('copilot.retry')"
        @click="emit('retry')"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" />
      </button>
    </template>

    <!--
      示警 pill（畫布 2a）：圓角膠囊、`--warn` 系底＋框，顏色＋圖示＋文字三者並呈
      （FR-003、憲法 8.1），frustrated／angry 可互相區分。
      右側是走勢分數 `score NN ↑` —— 畫布把兩者放在同一列。
    -->
    <div v-if="alertLabel || scoreText" class="mt-2 flex items-center gap-2">
      <span
        v-if="alertLabel"
        class="flex shrink-0 items-center gap-[5px] rounded-full border px-3 py-[5px] text-[0.96875rem] font-medium"
        :style="{ color: alertColor, background: alertBg, borderColor: alertBd }"
        aria-live="polite"
      >
        <UIcon :name="alertLabel === 'angry' ? 'i-lucide-flame' : 'i-lucide-alert-triangle'" class="size-[14px] shrink-0" />
        {{ t(`copilot.sentiment.alert.${alertLabel}`) }}
      </span>
      <span v-if="scoreText" class="ac-mono ml-auto shrink-0 text-[0.84375rem]" :style="{ color: 'var(--text-3)' }">
        {{ scoreText }}
      </span>
    </div>

    <!-- empty：尚無可分析內容（FR-009） -->
    <p v-if="block.status === 'empty'" class="mt-3 text-[0.9375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('copilot.sentiment.empty') }}
    </p>

    <!-- 首次 analyzing，尚無任何舊內容可疊加 -->
    <div v-else-if="!hasContent && block.status === 'analyzing'" class="mt-3">
      <div class="ac-skel ac-skel-shimmer h-16 w-full" />
    </div>

    <!-- 從未成功過的 error：無內容可顯示 -->
    <p
      v-else-if="!hasContent && block.status === 'error'"
      class="ac-alert-warn mt-3 flex items-start gap-2 px-3 py-2"
    >
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ t('copilot.sentiment.error') }}</span>
    </p>

    <!-- ready／retrying／analyzing(保留舊內容)／error(曾成功過，仍顯示上次內容) -->
    <div v-else-if="hasContent" class="mt-3">
      <!--
        圖表容器（畫布 2a）：圖、基準線、軸標籤與圖例是**同一組視覺單元**，
        因此包在自己的框裡而不是直接落在卡片底上。
      -->
      <div
        class="flex flex-col gap-[5px] rounded-lg border px-[9px] pb-1.5 pt-2"
        :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)' }"
      >
        <svg viewBox="0 0 320 52" fill="none" class="block h-auto w-full">
          <!--
            基準線（畫布 y=42）。⚠️ 少了它，折線就只是一條浮空的線 ——
            「相對於什麼在上升」沒有參照物。

            ⚠️ **色票刻意不照畫布的 `--border`，改用 `--border-strong`。**
               畫布逐字是 `stroke="var(--border)"`，但那是疊在 `--surface-2` 上：
               淺色 `#e2e5ea` on `#f8f9fb` 只有 **1.07:1**、深色 `#2a303a` on `#1e232c`
               約 1.2:1 —— 兩個主題都等於畫了一條看不見的線。
               而基準線的**整個用途就是被看見**（否則折線沒有參照物），
               看不見的基準線等於沒做。改用與附件虛線同一階的 `--border-strong`，
               仍明顯淡於資料線，不會與折線爭視覺。
          -->
          <line
            :x1="VB.x0" :y1="VB.yBase" :x2="VB.x1" :y2="VB.yBase"
            stroke="var(--border-strong)" stroke-width="1" vector-effect="non-scaling-stroke"
          />

          <!--
            純附件輪（FR-012）：虛線貫穿 ＋ 基準線下方的實心小三角（畫布 2a）。
            ⚠️ 先前是圖底部的 16px 圓形徽章 —— 在 50 點壓縮下那顆徽章會蓋住折線本身。
               虛線是「這一輪發生了什麼」的貫穿標記，不佔用折線的視覺空間。
          -->
          <template v-for="(m, i) in markersOnly" :key="`m${i}`">
            <line
              :x1="m.x.toFixed(1)" :y1="VB.yTop" :x2="m.x.toFixed(1)" :y2="VB.yBase"
              stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="2 3"
              vector-effect="non-scaling-stroke"
            />
            <path :d="`M${m.x.toFixed(1)} 44.5 l3 4.5 h-6 z`" fill="var(--text-3)">
              <title>{{ t('copilot.sentiment.attachmentMarker') }}</title>
            </path>
          </template>

          <polyline
            v-if="pointsOnly.length > 1"
            :points="polylinePoints"
            fill="none"
            :stroke="strokeColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
            class="transition-all duration-300"
          />

          <!--
            折線末端的實心圓點（畫布 `r=2.8`）——「現在在哪」是這張圖最重要的一個位置，
            而折線的尾端在 50 點壓縮之後很難一眼定位。
          -->
          <circle
            v-if="lastPoint && pointsOnly.length > 1"
            :cx="lastPoint.x.toFixed(1)" :cy="yOf(lastPoint.entry.score).toFixed(1)" r="2.8"
            :fill="strokeColor"
          />

          <!-- 恰好一個評分點：畫不出折線，但那個分數本身仍是資訊，以圓點呈現而非留白 -->
          <circle
            v-if="singlePoint"
            :cx="singlePoint.x.toFixed(1)" :cy="yOf(singlePoint.entry.score).toFixed(1)" r="3.2"
            :fill="strokeColor"
          >
            <title>{{ t(`copilot.sentiment.label.${singlePoint.entry.label}`) }}</title>
          </circle>
        </svg>

        <!--
          軸標籤與圖例（畫布 2a）。
          ⚠️ 右端是**這張圖實際畫了幾輪**，不是畫布逐字的「第 50 輪」（50 是視窗上限）。
             ⚠️ **MUST 與區塊 tag 用同一個 `windowEntries.length`** —— 否則同一張圖上
             兩個數字會互相矛盾（見 `roundsTag` 的說明）。
             ⚠️ 三角圖例只在真的有附件標記時才出現，否則是在解釋一個不存在的記號。
        -->
        <div v-if="pointsOnly.length > 1" class="flex items-center gap-2 text-[0.78125rem]" :style="{ color: 'var(--text-3)' }">
          <span class="ac-mono">{{ t('copilot.sentiment.axisRound', { n: 1 }) }}</span>
          <span class="flex-1" />
          <span v-if="markersOnly.length" class="flex items-center gap-1">
            <svg width="7" height="7" viewBox="0 0 6 6" aria-hidden="true"><path d="M3 0 l3 6 H0 z" fill="var(--text-3)" /></svg>
            {{ t('copilot.sentiment.attachmentLegend') }}
          </span>
          <span class="flex-1" />
          <span class="ac-mono">{{ t('copilot.sentiment.axisRound', { n: windowEntries.length }) }}</span>
        </div>
      </div>

      <!-- ⚠️ 沒有這一行，恰好一個評分點時整個區塊就只是一個沒有任何說明的空白框 -->
      <p v-if="singlePoint" class="mt-2 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ t('copilot.sentiment.singlePoint') }}
      </p>

      <!--
        走勢文字摘要（畫布 2a、D-19）。
        ⚠️ `narrative` 為 `null` 時**整段不顯示**（尚未產出／產出失敗／只有一個評分點）——
           不放預設句、不放骨架。這一段是次要內容，缺了不影響上面的分數與示警，
           而一個永遠佔位的空框會讓客服以為系統壞了。
        ⚠️ `advice` 與 `trend` 同段呈現（畫布是一整段），但 `advice` 加粗 ——
           客服真正要用的是那一句，走勢那半在折線圖上已經看得到。
      -->
      <p
        v-if="block.narrative"
        class="mt-2.5 text-[0.90625rem] leading-[1.7]"
        :style="{ color: 'var(--text-2)' }"
      >
        {{ block.narrative.trend }}
        <span class="font-medium" :style="{ color: 'var(--text)' }">{{ block.narrative.advice }}</span>
      </p>

      <!--
        情緒量表圖例（畫布 2a）：五段等寬橫條，目前所在區間以底線強調。
        ⚠️ 強調用的是 `inset 0 -3px 0`（底線）而不是換底色 —— 五段本來就各有底色，
           再換一次色會讓「目前在哪一段」與「這一段代表什麼」兩件事混在一起。
      -->
      <div
        class="mt-2.5 flex overflow-hidden rounded-lg border"
        :style="{ borderColor: 'var(--border)' }"
        role="img"
        :aria-label="currentLabel ? t('copilot.sentiment.scaleNow', { label: t(`copilot.sentiment.label.${currentLabel}`) }) : t('copilot.sentiment.scale')"
      >
        <!--
          ⚠️ 條件用**展開**而不是 `key: cond ? x : undefined` —— 後者會讓 Vue 執行
             `style.borderLeft = ''`，而把**簡寫屬性**設成空字串等於 `removeProperty()`，
             會連帶清掉同一個物件稍早寫入的長寫。這裡目前沒有東西可被清掉
             （元素上沒有 border utility），但同樣的寫法在 MessageBubble.vue 已經真的
             造成過一條多餘的深色左框，寫法統一才不會下次又中。詳見該檔的註解。
        -->
        <span
          v-for="(seg, i) in SCALE"
          :key="seg.key"
          class="flex-1 py-1 text-center text-[0.84375rem]"
          :class="{ 'font-bold': seg.key === currentLabel, 'font-medium': seg.strong && seg.key !== currentLabel }"
          :style="{
            color: seg.fg,
            background: seg.bg,
            ...(i === 0 ? {} : { borderLeft: `1px solid ${seg.bd}` }),
            ...(seg.key === currentLabel ? { boxShadow: `inset 0 -3px 0 ${seg.fg}` } : {}),
          }"
        >{{ t(`copilot.sentiment.label.${seg.key}`) }}</span>
      </div>

      <p v-if="block.status === 'error'" class="ac-alert-warn mt-2 flex items-start gap-2 px-3 py-2">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ t('copilot.sentiment.error') }}</span>
      </p>
    </div>
  </CopilotBlockShell>
</template>
