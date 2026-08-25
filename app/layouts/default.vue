<script setup lang="ts">
/**
 * 登入／選組織頁的外框（未進工作區前）—— docs/ARCHITECTURE.md §5。
 *
 * 刻意不放任何標題或品牌列：artboard 1a/1b 的卡片本身就帶 header row，
 * 外框只負責置中與頁面底色。
 */
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center px-4 py-10">
    <slot />
  </div>
</template>
