<script setup lang="ts">
/**
 * ③ 選擇組織 —— docs/ARCHITECTURE.md §5.1 ①，版面對應設計稿 artboard 1b。
 *
 * ⚠️ 即使只有一個組織也一律顯示，不做自動選取。
 *    之後所有 JOIN、回覆、稽核軌跡都掛在這個身分上，靜默替他選會讓誤入錯組織難以察覺。
 *
 * ⚠️ 這是獨立路由：組織清單來自 BFF session（GET /api/auth/me），
 *    因此重新整理本頁不會回到輸 email 的步驟。
 *
 * 與設計稿的兩處落差（皆為資料面限制，非版面取捨）：
 *  · 組織列的「N 個進行中」pill —— loginWithOtp 回傳的 organizations[] 沒有這個計數，
 *    要另外對每個組織打 conversations.getViewsCount()。在選組織前尚未取得該組織的
 *    access token，這筆呼叫做不到，故不顯示。
 *  · 「唯讀」pill —— 需要能判定角色，但 role / is_admin 的值域待 iMBrace 確認（H-5），
 *    在確認前不做語意對應，只把 role 原樣顯示在 meta 行。
 */

import type { OrganizationChoice } from '#shared/types/auth'

definePageMeta({ layout: 'default' })

const auth = useAuthStore()
const route = useRoute()

const pending = ref('')
const error = ref('')

/** 圖示方塊的 2 字縮寫。拉丁字母取首兩碼大寫，中文取前兩字 */
function initialsOf(org: OrganizationChoice): string {
  const ascii = org.name.replace(/[^a-zA-Z]/g, '')
  if (ascii.length >= 2) return ascii.slice(0, 2).toUpperCase()
  return org.name.slice(0, 2)
}

async function choose(organizationId: string) {
  if (pending.value) return
  error.value = ''
  pending.value = organizationId
  try {
    await auth.selectOrganization(organizationId)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await navigateTo(redirect)
  }
  catch (err) {
    const e = err as { statusMessage?: string, data?: { message?: string } }
    error.value = e?.data?.message || e?.statusMessage || '切換組織失敗，請稍後再試。'
  }
  finally {
    pending.value = ''
  }
}

async function logout() {
  await auth.logout()
  await navigateTo('/login')
}
</script>

<template>
  <!-- ── 載入中：骨架屏，不是 spinner ─────────────────────────────── -->
  <div v-if="!auth.resolved" class="ac-card w-[400px] max-w-full p-5">
    <span class="ac-status-label">載入中</span>
    <div class="mt-4 space-y-4">
      <div v-for="n in 2" :key="n" class="flex items-center gap-3">
        <div class="ac-skel ac-skel-shimmer size-[38px] rounded-[9px]" />
        <div class="flex-1 space-y-2">
          <div class="ac-skel ac-skel-shimmer h-3" :style="{ width: n === 1 ? '52%' : '40%' }" />
          <div class="ac-skel h-2.5" :style="{ width: n === 1 ? '34%' : '28%' }" />
        </div>
      </div>
    </div>
  </div>

  <!-- ── 無組織 ──────────────────────────────────────────────────── -->
  <div v-else-if="auth.organizations.length === 0" class="ac-card w-[400px] max-w-full p-5">
    <span class="ac-status-label">無組織</span>
    <div
      class="mt-4 flex flex-col items-center rounded-[10px] border border-dashed px-5 py-8 text-center"
      :style="{ borderColor: 'var(--border-dash)' }"
    >
      <UIcon name="i-lucide-building-2" class="size-[22px]" :style="{ color: 'var(--text-3)' }" />
      <p class="mt-3 text-[1rem] font-medium">此帳號尚未加入任何組織</p>
      <p class="ac-subtitle mt-1.5">
        請聯絡系統管理員將你加入客服組織後，再重新登入。
      </p>
      <button
        type="button"
        class="mt-4 rounded-lg border px-3 py-1.5 text-[0.90625rem] transition-colors"
        :style="{ borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
        @click="auth.refresh()"
      >
        重新整理
      </button>
    </div>
  </div>

  <!-- ── 組織清單 ────────────────────────────────────────────────── -->
  <div v-else class="ac-card w-[560px] max-w-full overflow-hidden">
    <header class="border-b px-[22px] pb-4 pt-5" :style="{ borderColor: 'var(--border)' }">
      <div class="flex items-center justify-between">
        <span class="ac-eyebrow">選擇組織</span>
        <span class="ac-mono text-[0.875rem]" :style="{ color: 'var(--text-3)' }">
          {{ auth.me?.email }}
        </span>
      </div>
      <p class="ac-subtitle mt-2">
        你隸屬於 {{ auth.organizations.length }} 個組織。選擇要進入的組織，之後可從右上角切換。
      </p>
    </header>

    <p v-if="error" class="ac-alert-warn mx-[22px] mt-4 flex items-start gap-2 px-3 py-2.5">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ error }}</span>
    </p>

    <ul class="space-y-1 p-3">
      <li v-for="org in auth.organizations" :key="org.id">
        <button
          type="button"
          class="ac-org-row flex w-full items-center gap-3 rounded-[9px] border border-transparent p-3 text-left transition-colors disabled:opacity-50"
          :disabled="pending !== '' && pending !== org.id"
          @click="choose(org.id)"
        >
          <span
            class="flex size-[38px] shrink-0 items-center justify-center rounded-[9px] text-[0.96875rem] font-medium"
            :style="{ background: 'var(--surface-3)', color: 'var(--text-2)' }"
          >{{ initialsOf(org) }}</span>

          <span class="min-w-0 flex-1">
            <span class="block truncate text-[1.03125rem] font-medium">{{ org.name }}</span>
            <span class="ac-mono block truncate text-[0.875rem]" :style="{ color: 'var(--text-3)' }">
              {{ org.id }}<template v-if="org.role"> · {{ org.role }}</template>
            </span>
          </span>

          <UIcon
            :name="pending === org.id ? 'i-lucide-loader-2' : 'i-lucide-chevron-right'"
            class="size-4 shrink-0"
            :class="{ 'animate-spin': pending === org.id }"
            :style="{ color: 'var(--text-3)' }"
          />
        </button>
      </li>
    </ul>

    <footer
      class="flex items-center justify-between border-t px-[22px] py-3"
      :style="{ borderColor: 'var(--border)' }"
    >
      <span class="text-[0.875rem]" :style="{ color: 'var(--text-3)' }">
        組織清單由後台權限決定，無法自行加入。
      </span>
      <button
        type="button"
        class="flex items-center gap-1.5 text-[0.875rem] transition-opacity hover:opacity-70"
        :style="{ color: 'var(--text-2)' }"
        @click="logout"
      >
        <UIcon name="i-lucide-log-out" class="size-3" />
        登出
      </button>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 設計稿把第一列畫成「選中」樣式純粹是示範用 ——
 * 這是點擊即導航的清單，不是持久選取的表單，所以只做 hover 態。
 */
.ac-org-row:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--border);
}
</style>
