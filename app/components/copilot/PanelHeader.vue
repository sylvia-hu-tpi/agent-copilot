<script setup lang="ts">
/**
 * Copilot 面板的標題列 —— specs/003-analysis-trigger-policy FR-017、FR-018、FR-019。
 *
 * 兩個動作：收合／展開（純視覺，FR-017b）與「全部重試」（對每個 error 區塊各發一次
 * 既有的單區塊重試端點，契約 1.2 —— **MUST NOT** 新增 retry-all 端點）。
 *
 * ⚠️ **這是 `flex:none` 的固定列，不屬於捲動區**（畫布 2a：`height:42px`／`--surface` 底／
 *    `border-bottom:1px solid var(--border)`／`padding:0 13px`／`gap:9px`）。
 *    先前它被放進面板的捲動容器裡，往下捲就整條消失 —— 而「全部重試」正是在
 *    某個區塊失敗時才出現的東西，那時客服很可能已經捲到下面在看別的區塊。
 *
 * ⚠️ 憲法 8.2：兩個按鈕都是原生 `<button>`，因此天生可 Tab 聚焦、可 Enter／Space 觸發。
 */

const props = defineProps<{
  collapsed: boolean
  /** 三個區塊之中有沒有處於 error 的 —— 「全部重試」的出現條件（FR-019） */
  hasError: boolean
  /** 有任一區塊正在分析／重試 —— 決定副標顯示「分析中」還是「即時輔助」 */
  analyzing: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'retry-all'): void
}>()

const { t } = useI18n()

const toggleLabel = computed(() => (props.collapsed ? t('copilot.expand') : t('copilot.collapse')))

/**
 * 面板副標（畫布 2a 的 `headNote`）：展開「即時輔助」／載入中「分析中」／準備結案「準備結案」。
 *
 * ⚠️ **「準備結案」屬 M3，這裡刻意只做兩態**（2026-08-29 使用者裁示 D-14）。
 *    第三態要等結案流程本身存在才有東西可偵測 —— 現在做一個永遠不會出現的分支，
 *    等於留一段沒有人驗證過的死碼。
 */
const subtitle = computed(() => (props.analyzing ? t('copilot.subtitleAnalyzing') : t('copilot.subtitleLive')))

/**
 * ⚠️ **刻意不做樂觀 disable**（research.md 決策 7）：往返期間按鈕仍可按是**預期行為**，
 *    面板狀態一律由伺服器推播驅動。重複按下由 FR-009 的同區塊併發去重吸收，
 *    不會跑出兩份分析。
 */
</script>

<template>
  <header
    class="flex h-[42px] shrink-0 items-center gap-[9px] border-b px-[13px]"
    :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
  >
    <!--
      ⚠️ MUST 用 `.ac-eyebrow`（實心藍底白字 pill），不是 `.ac-status-label`（純灰字）——
         畫布 2a 的 COPILOT 徽章是 `background:var(--navy)`／`color:var(--navy-fg)`，
         與登入頁／選組織頁是同一顆元件。2026-08-29 逐字核對時訂正。
         畫布的面板徽章是 10.5px、登入頁 eyebrow 是 11px，差 0.5px —— 刻意不為此另做變體，
         因為實作的字級本來就整體加大過（見 DESIGN_TOKENS §2 的 ⚠️）。
    -->
    <h2 class="ac-eyebrow shrink-0">{{ t('copilot.panelTitle') }}</h2>
    <span class="min-w-0 truncate text-[0.84375rem]" :style="{ color: 'var(--text-2)' }">{{ subtitle }}</span>

    <span class="flex-1" />

    <!--
      「全部重試」—— 畫布逐字：**只在有區塊失敗時才出現**，`--warn-bd` 框／`--warn-bg` 底／
      `--warn` 字／`radius:6px`／`refresh-cw` icon。

      ⚠️ 先前是常駐但 disabled 的純文字按鈕（憲法 8.1「不可按 MUST 用 disabled 表達」）。
         2026-09-01 使用者裁定改回畫布做法：這顆按鈕**本身就是「現在有東西壞了」的訊號**，
         常駐會讓那個訊號永遠亮著而失去意義。憲法 8.1 管的是「已經在畫面上的控制項
         不可只靠對比度表達不可按」，不是「所有控制項都必須常駐」——
         沒有失敗區塊時它沒有任何語意，讓它不存在比讓它灰著更誠實。
    -->
    <button
      v-if="hasError"
      type="button"
      class="flex h-6 shrink-0 items-center gap-[5px] rounded-md border px-2.5 text-[0.84375rem] font-medium transition-opacity hover:opacity-70"
      :style="{ borderColor: 'var(--warn-bd)', background: 'var(--warn-bg)', color: 'var(--warn)' }"
      :title="t('copilot.retryAllHint')"
      @click="emit('retry-all')"
    >
      <UIcon name="i-lucide-refresh-cw" class="size-3 shrink-0" />
      {{ t('copilot.retryAll') }}
    </button>

    <!-- 收合鈕：畫布是 `26×26`／`--border` 框／`--surface-2` 底／`radius:6px` 的有框按鈕 -->
    <button
      type="button"
      class="flex size-[26px] shrink-0 items-center justify-center rounded-md border transition-opacity hover:opacity-70"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-3)' }"
      :aria-label="toggleLabel"
      :aria-expanded="!collapsed"
      :title="toggleLabel"
      @click="emit('toggle')"
    >
      <UIcon :name="collapsed ? 'i-lucide-panel-right-open' : 'i-lucide-panel-right-close'" class="size-3.5" />
    </button>
  </header>
</template>
