<script setup lang="ts">
/**
 * Copilot 面板的區塊外殼 —— 畫布 artboard 2a（`docs/DESIGN_TOKENS.md` §7）。
 *
 * 五個區塊的**標題列結構完全一致**，只有內容不同：
 *
 *     [chevron ▾]  [標題徽章]  ←撐開→  [tag 小灰字]  [動作按鈕]
 *
 * ⚠️ **標題是實心藍底徽章（`.ac-eyebrow`），不是灰色純文字。**
 *    畫布逐字為 `background:var(--navy)`／`color:var(--navy-fg)`／`padding:3px 9px`／
 *    `border-radius:5px` —— 與面板 header 的 `COPILOT` 徽章、登入頁的 eyebrow 同一顆元件。
 *    2026-08-29 逐字核對時發現五個區塊全都用錯成 `.ac-status-label`。
 *
 * ⚠️ **切換鈕與動作按鈕 MUST 是兄弟，不可巢狀。** 畫布把整個標題列做成可點區域，
 *    但區塊右上角還有「重試」這類按鈕 —— `<button>` 裡包 `<button>` 是無效 HTML，
 *    瀏覽器會自行拆開，結果是點重試會連帶觸發折疊。因此切換鈕只包到 tag 為止，
 *    動作按鈕放在它外面。
 *
 * ⚠️ 折疊狀態**刻意不持久化**：畫布沒有這項規格，而「換一個對話後某幾塊還是收合的」
 *    需要先想清楚是依對話記住還是全域記住。在有規格之前不猜。
 */

const props = withDefaults(defineProps<{
  /** 標題徽章的文字 */
  title: string
  /** 右側 tag（畫布：情緒「近 N 輪」、建議「N 則建議」）。快查區塊在畫布上沒有 tag */
  tag?: string | null
  /** 預設是否展開 —— 畫布五塊都是展開 */
  defaultOpen?: boolean
}>(), {
  tag: null,
  /**
   * ⚠️ **這個預設值 MUST 明寫，不能靠 `props.defaultOpen ?? true` 兜。**
   *    Vue 對宣告為 boolean 的 prop 有「boolean casting」：沒有傳值時它是 **`false`**
   *    而不是 `undefined`，於是 `?? true` 永遠不會生效 —— 結果是五個區塊
   *    **全部預設收合**，而型別檢查與測試都不會有任何反應。
   *    2026-08-29 首次交付時就是這樣，由使用者在畫面上發現。
   */
  defaultOpen: true,
})

const open = ref(props.defaultOpen)
const { t } = useI18n()

const toggleLabel = computed(() =>
  open.value
    ? t('copilot.block.collapse', { title: props.title })
    : t('copilot.block.expand', { title: props.title }),
)
</script>

<template>
  <section class="ac-card overflow-hidden">
    <div class="flex items-center gap-2 px-3 py-2.5">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        :aria-expanded="open"
        :aria-label="toggleLabel"
        :title="toggleLabel"
        @click="open = !open"
      >
        <UIcon
          :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-3.5 shrink-0"
          :style="{ color: 'var(--text-3)' }"
        />
        <h2 class="ac-eyebrow shrink-0">{{ title }}</h2>
        <span class="flex-1" />
        <!-- tag 預設是小灰等寬字；需要圖示或動態內容的區塊改用 slot 覆寫 -->
        <slot name="tag">
          <span v-if="tag" class="ac-mono shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
            {{ tag }}
          </span>
        </slot>
      </button>

      <slot name="actions" />
    </div>

    <div v-if="open" class="px-3 pb-3">
      <slot />
    </div>
  </section>
</template>
