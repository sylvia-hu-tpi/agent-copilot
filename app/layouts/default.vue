<script setup lang="ts">
/** 登入／選組織頁的外框（未進工作區前）—— docs/ARCHITECTURE.md §5 */
const { public: pub } = useRuntimeConfig()
</script>

<template>
  <div class="min-h-dvh flex flex-col items-center justify-center bg-default px-4">
    <main class="w-full max-w-sm">
      <h1 class="mb-6 text-center text-xl font-semibold text-highlighted">
        {{ pub.appName }}
      </h1>
      <slot />
    </main>
  </div>
</template>
