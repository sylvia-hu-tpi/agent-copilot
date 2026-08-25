<script setup lang="ts">
/**
 * 工作區外框 —— docs/ARCHITECTURE.md §14.1。
 *
 * M0 只有頂欄 + 內容區。側欄與三欄工作區於 M1 加入
 * （對應設計稿 artboard 1c/1d，規格尚未取得）。
 */

const auth = useAuthStore()

async function logout() {
  await auth.logout()
  await navigateTo('/login')
}
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header
      class="flex items-center gap-3 border-b px-4 py-2.5"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
    >
      <span class="ac-eyebrow">AGENTCOPILOT</span>
      <span
        v-if="auth.me?.orgName"
        class="truncate text-[12.5px]"
        :style="{ color: 'var(--text-2)' }"
      >{{ auth.me.orgName }}</span>

      <div class="ml-auto flex items-center gap-3">
        <span class="truncate text-[12.5px]" :style="{ color: 'var(--text-2)' }">
          {{ auth.me?.operatorName }}
        </span>
        <button
          type="button"
          class="flex items-center gap-1.5 text-[11.5px] transition-opacity hover:opacity-70"
          :style="{ color: 'var(--text-3)' }"
          @click="logout"
        >
          <UIcon name="i-lucide-log-out" class="size-3" />
          登出
        </button>
      </div>
    </header>

    <main class="min-h-0 flex-1">
      <slot />
    </main>
  </div>
</template>
