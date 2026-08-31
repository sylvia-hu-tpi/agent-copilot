<script setup lang="ts">
/**
 * 欄寬拖曳把手 —— 畫布 §8.1 的「拖曳分隔線」逐字：
 *
 *     width:5px · cursor:col-resize · background:var(--border)
 *     └ 內含 width:1px / height:26px / background:var(--border-strong) 的握把短線
 *     title="拖曳調整寬度"
 *
 * ⚠️ **把手平時就有顏色（`--border`），不是透明的。** 實作先前是透明、只在拖曳時才變色 ——
 *    等於「要先猜到這裡可以拖，才看得到它可以拖」。畫布的 5px 實心細線本身就是那個提示。
 *
 * ⚠️ **hover 色統一用 `--navy-2`，畫布左右兩條不一致。**
 *    畫布的左把手 hover 是 `--border-strong`、右把手是 `--navy-2`，但兩者是同一種控制項，
 *    沒有任何理由給不同回饋。取較強的那個，因為深色主題下
 *    `--border`(#2a303a) → `--border-strong`(#3a4250) 的變化幾乎看不出來，
 *    而 5px 的命中區本來就需要明確的 hover 才找得到。
 *
 * ⚠️ 鍵盤可操作（憲法 8.2）：`role="separator"` ＋ 方向鍵，值由 `usePanelWidth()` 提供。
 *    畫布只畫了滑鼠拖曳，但那條 5px 的線對只用鍵盤的人等於不存在。
 */

const props = defineProps<{
  dragging: boolean
  /** 目前寬度與範圍，供 `aria-value*`（鍵盤使用者唯一能知道自己調到哪裡的來源） */
  value: number
  min: number
  max: number
  label: string
}>()

const emit = defineEmits<{
  pointerdown: [PointerEvent]
  keydown: [KeyboardEvent]
}>()

const hovering = ref(false)

const background = computed(() =>
  (props.dragging || hovering.value) ? 'var(--navy-2)' : 'var(--border)')
</script>

<template>
  <div
    class="ac-resize-handle flex w-[5px] shrink-0 cursor-col-resize items-center justify-center transition-colors"
    :style="{ background }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="label"
    :title="$t('layout.resizeHint')"
    :aria-valuenow="value"
    :aria-valuemin="min"
    :aria-valuemax="max"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false"
    @focus="hovering = true"
    @blur="hovering = false"
    @pointerdown.prevent="emit('pointerdown', $event)"
    @keydown="emit('keydown', $event)"
  >
    <!-- 握把短線：畫布 1×26px。拖曳／hover 時整條把手轉 navy，短線改用同族亮色才看得見 -->
    <span
      class="h-[26px] w-px rounded-sm"
      :style="{ background: (dragging || hovering) ? 'var(--navy-fg)' : 'var(--border-strong)' }"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.ac-resize-handle:focus-visible {
  outline: 2px solid var(--navy-2);
  outline-offset: 1px;
}
</style>
