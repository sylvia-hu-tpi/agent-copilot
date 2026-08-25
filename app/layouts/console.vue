<script setup lang="ts">
/**
 * 工作區外框 —— docs/ARCHITECTURE.md §14.1。
 *
 * M0 只有頂欄 + 內容區。側欄與三欄工作區於 M1 加入。
 */

const auth = useAuthStore()
const { public: pub } = useRuntimeConfig()

async function logout() {
  await auth.logout()
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-dvh flex flex-col bg-default">
    <header class="flex items-center gap-3 border-b border-default px-4 py-2">
      <span class="font-semibold text-highlighted">{{ pub.appName }}</span>
      <span v-if="auth.me?.orgName" class="text-sm text-muted truncate">
        {{ auth.me.orgName }}
      </span>

      <div class="ml-auto flex items-center gap-2">
        <span class="text-sm text-muted truncate">{{ auth.me?.operatorName }}</span>
        <UButton variant="ghost" size="sm" @click="logout">登出</UButton>
      </div>
    </header>

    <main class="flex-1 min-h-0">
      <slot />
    </main>
  </div>
</template>
