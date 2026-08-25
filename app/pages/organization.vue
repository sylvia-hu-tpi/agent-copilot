<script setup lang="ts">
/**
 * ③ 選擇組織 —— docs/ARCHITECTURE.md §5.1 ①
 *
 * ⚠️ 即使只有一個組織也一律顯示，不做自動選取。
 *    之後所有 JOIN、回覆、稽核軌跡都掛在這個身分上，靜默替他選會讓誤入錯組織難以察覺。
 *
 * ⚠️ 這是獨立路由：組織清單來自 BFF session（GET /api/auth/me），
 *    因此重新整理本頁不會回到輸 email 的步驟。
 */

definePageMeta({ layout: 'default' })

const auth = useAuthStore()
const route = useRoute()

const pending = ref('')
const error = ref('')

async function useAnotherAccount() {
  await auth.logout()
  await navigateTo('/login')
}

async function choose(organizationId: string) {
  error.value = ''
  pending.value = organizationId
  try {
    await auth.selectOrganization(organizationId)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await navigateTo(redirect)
  }
  catch (err) {
    const e = err as { statusMessage?: string, data?: { message?: string } }
    error.value = e.statusMessage || e.data?.message || '切換組織失敗，請稍後再試'
  }
  finally {
    pending.value = ''
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium text-highlighted">選擇組織</h2>
      <p class="mt-1 text-sm text-muted">
        接下來的加入對話與回覆都會以此身分留下紀錄。
      </p>
    </template>

    <UAlert v-if="error" color="error" variant="subtle" class="mb-4" :description="error" />

    <div v-if="auth.organizations.length === 0" class="text-sm text-muted">
      這個帳號目前沒有可用的組織，請聯絡管理者。
    </div>

    <ul v-else class="space-y-2">
      <li v-for="org in auth.organizations" :key="org.id">
        <UButton
          block
          color="neutral"
          variant="outline"
          size="lg"
          class="justify-between"
          :loading="pending === org.id"
          :disabled="pending !== '' && pending !== org.id"
          @click="choose(org.id)"
        >
          <span class="truncate">{{ org.name }}</span>
          <!-- role / is_admin 語意待確認（H-5），此處僅顯示不做權限判定 -->
          <UBadge v-if="org.role" color="neutral" variant="subtle" size="sm">
            {{ org.role }}
          </UBadge>
        </UButton>
      </li>
    </ul>

    <template #footer>
      <UButton variant="ghost" size="sm" @click="useAnotherAccount">
        改用其他帳號登入
      </UButton>
    </template>
  </UCard>
</template>
