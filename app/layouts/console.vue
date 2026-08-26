<script setup lang="ts">
/**
 * 工作區外框 —— docs/ARCHITECTURE.md §14.1。
 *
 * ⚠️ `min-h-0` 這一串不是裝飾。三欄工作區的訊息流要在自己的容器內捲動，
 *    少了它 flex 子項的預設 `min-height: auto` 會讓內容把整頁撐高，
 *    虛擬滾動就完全失效（畫面看起來正常，但每則訊息都被渲染了）。
 */

const auth = useAuthStore()
const stream = useStreamStore()

async function logout() {
  stream.disconnect()
  await auth.logout()
  await navigateTo('/login')
}

const statusLabel = computed(() => {
  if (stream.status === 'open') return null
  if (stream.status === 'reconnecting') return 'stream.reconnecting'
  if (stream.status === 'connecting') return 'stream.connecting'
  return null
})
</script>

<template>
  <div class="flex h-dvh flex-col overflow-hidden">
    <header
      class="flex shrink-0 items-center gap-3 border-b px-4 py-2.5"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
    >
      <NuxtLink to="/" class="ac-eyebrow shrink-0 transition-opacity hover:opacity-80">AGENTCOPILOT</NuxtLink>

      <span v-if="auth.me?.orgName" aria-hidden="true" class="shrink-0" :style="{ color: 'var(--border-strong)' }">|</span>

      <NuxtLink
        v-if="auth.me?.orgName"
        to="/organization"
        class="flex min-w-0 items-center gap-1 truncate text-[0.9375rem] transition-opacity hover:opacity-70"
        :style="{ color: 'var(--text-2)' }"
        :title="$t('organization.switch')"
      >
        <span class="truncate">{{ auth.me.orgName }}</span>
        <UIcon v-if="auth.organizations.length > 1" name="i-lucide-chevron-down" class="size-3 shrink-0" />
      </NuxtLink>

      <!-- 連線狀態：只在不正常時才出現，正常時不佔視覺注意力 -->
      <span
        v-if="statusLabel"
        class="flex items-center gap-1.5 text-[0.84375rem]"
        :style="{ color: 'var(--text-3)' }"
      >
        <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
        {{ $t(statusLabel) }}
      </span>

      <div class="ml-auto flex items-center gap-3">
        <span class="truncate text-[0.9375rem]" :style="{ color: 'var(--text-2)' }">
          {{ auth.me?.operatorName }}
        </span>
        <button
          type="button"
          class="flex items-center gap-1.5 text-[0.875rem] transition-opacity hover:opacity-70"
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
