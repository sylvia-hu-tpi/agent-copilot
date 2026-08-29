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

/**
 * 切換組織（U-3）—— 退回 pending_org 再導向選組織頁。
 *
 * ⚠️ MUST 先 `stream.disconnect()`：session 一旦退回 pending_org，那條 SSE 的
 *    憑證就不再有效，留著只會讓前端一直重連並吃到 401。與 `logout()` 同樣的理由。
 */
const switching = ref(false)

async function switchOrganization() {
  if (switching.value) return
  switching.value = true
  try {
    stream.disconnect()
    await auth.reselectOrganization()
    await navigateTo('/organization')
  }
  finally {
    switching.value = false
  }
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

      <!--
        ⚠️ **不是 NuxtLink**：直接連到 /organization 會停在一個永遠不會長出清單的畫面 ——
           換組織要先把 session 退回 pending_org（見 server/api/auth/reselect-organization.post.ts）。
        ⚠️ 只有一個組織時不給切換入口，但**名稱仍要顯示**（那是「我在哪個組織」的指示）。
      -->
      <button
        v-if="auth.me?.orgName && auth.organizations.length > 1"
        type="button"
        class="flex min-w-0 items-center gap-1 truncate text-[0.9375rem] transition-opacity hover:opacity-70 disabled:opacity-50"
        :style="{ color: 'var(--text-2)' }"
        :title="$t('organization.switch')"
        :disabled="switching"
        @click="switchOrganization"
      >
        <span class="truncate">{{ auth.me.orgName }}</span>
        <UIcon
          :name="switching ? 'i-lucide-loader-circle' : 'i-lucide-chevron-down'"
          class="size-3 shrink-0"
          :class="{ 'animate-spin': switching }"
        />
      </button>
      <span
        v-else-if="auth.me?.orgName"
        class="min-w-0 truncate text-[0.9375rem]"
        :style="{ color: 'var(--text-2)' }"
      >{{ auth.me.orgName }}</span>

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
