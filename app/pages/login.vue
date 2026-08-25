<script setup lang="ts">
/**
 * ① 寄 OTP → ② 驗證 OTP —— docs/ARCHITECTURE.md §7.1
 *
 * ⚠️ 第 ③ 步（選組織）在獨立的 organization.vue，不是這裡的第三個步驟。
 *    理由見 §5.1 ①：此時 login_acc_ token 已存在 BFF session，
 *    重新整理不該把使用者踢回輸 email。
 */

definePageMeta({ layout: 'default' })

const auth = useAuthStore()
const toast = useToast()

const step = ref<'email' | 'otp'>('email')
const email = ref('')
const otp = ref('')
const pending = ref(false)
const error = ref('')

function messageOf(err: unknown): string {
  const e = err as { statusMessage?: string, data?: { message?: string } }
  return e.statusMessage || e.data?.message || '操作失敗，請稍後再試'
}

async function sendOtp() {
  error.value = ''
  pending.value = true
  try {
    await auth.requestOtp(email.value)
    step.value = 'otp'
    toast.add({ title: '驗證碼已寄出', description: `請至 ${email.value} 查收`, color: 'success' })
  }
  catch (err) {
    error.value = messageOf(err)
  }
  finally {
    pending.value = false
  }
}

async function verify() {
  error.value = ''
  pending.value = true
  try {
    await auth.verifyOtp(email.value, otp.value)
    // ⚠️ 一律導向選組織頁，即使只有一個組織（§5.1 ①）
    await navigateTo({ path: '/organization', query: useRoute().query })
  }
  catch (err) {
    error.value = messageOf(err)
  }
  finally {
    pending.value = false
  }
}

function backToEmail() {
  step.value = 'email'
  otp.value = ''
  error.value = ''
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium text-highlighted">
        {{ step === 'email' ? '登入' : '輸入驗證碼' }}
      </h2>
    </template>

    <form v-if="step === 'email'" class="space-y-4" @submit.prevent="sendOtp">
      <UFormField label="公司 email" name="email">
        <UInput
          v-model="email"
          type="email"
          autocomplete="email"
          placeholder="you@example.com"
          autofocus
          class="w-full"
        />
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" :description="error" />
      <UButton type="submit" block :loading="pending" :disabled="!email">
        寄送驗證碼
      </UButton>
    </form>

    <form v-else class="space-y-4" @submit.prevent="verify">
      <p class="text-sm text-muted">
        驗證碼已寄至 <span class="text-highlighted">{{ email }}</span>
      </p>
      <UFormField label="驗證碼" name="otp">
        <UInput
          v-model="otp"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="6 位數字"
          autofocus
          class="w-full"
        />
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" :description="error" />
      <UButton type="submit" block :loading="pending" :disabled="!otp">
        登入
      </UButton>
      <UButton variant="ghost" block :disabled="pending" @click="backToEmail">
        改用其他 email
      </UButton>
    </form>
  </UCard>
</template>
