<script setup lang="ts">
/**
 * ① 寄 OTP → ② 驗證 OTP —— docs/ARCHITECTURE.md §7.1，版面對應設計稿 artboard 1a。
 *
 * ⚠️ 第 ③ 步（選組織）在獨立的 organization.vue，不是這裡的第三個步驟。
 *    理由見 §5.1 ①：此時 login_acc_ token 已存在 BFF session，
 *    重新整理不該把使用者踢回輸 email。
 */

definePageMeta({ layout: 'default' })

const OTP_LENGTH = 6
/** 重新寄送的冷卻秒數。設計稿示意為 00:47 倒數，這裡取整分鐘 */
const RESEND_COOLDOWN_SEC = 60

const auth = useAuthStore()
const route = useRoute()

const step = ref<'email' | 'otp'>('email')
const email = ref('')
const digits = ref<string[]>(Array.from({ length: OTP_LENGTH }, () => ''))
const pending = ref(false)
const error = ref('')

const otp = computed(() => digits.value.join(''))
const otpComplete = computed(() => otp.value.length === OTP_LENGTH)

/** 遮蔽 email 中段 —— 畫面上要能認出是自己的信箱，但不必完整揭露 */
const maskedEmail = computed(() => {
  const [name = '', domain = ''] = email.value.split('@')
  if (!domain) return email.value
  const head = name.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`
})

// ── 重新寄送倒數 ──────────────────────────────────────────────────────
const remaining = ref(0)
let ticker: ReturnType<typeof setInterval> | undefined

function startCooldown() {
  remaining.value = RESEND_COOLDOWN_SEC
  clearInterval(ticker)
  ticker = setInterval(() => {
    remaining.value -= 1
    if (remaining.value <= 0) clearInterval(ticker)
  }, 1000)
}

onBeforeUnmount(() => clearInterval(ticker))

const countdown = computed(() => {
  const m = Math.floor(remaining.value / 60).toString().padStart(2, '0')
  const s = (remaining.value % 60).toString().padStart(2, '0')
  return `${m}:${s}`
})

// ── OTP 格子輸入 ──────────────────────────────────────────────────────
const boxes = ref<HTMLInputElement[]>([])

function focusBox(i: number) {
  boxes.value[i]?.focus()
  boxes.value[i]?.select()
}

function onDigitInput(i: number, event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.value.replace(/\D/g, '')

  if (value.length > 1) {
    // 貼上整串驗證碼時，從目前這一格開始逐格填入
    fill(value, i)
    return
  }

  digits.value[i] = value
  input.value = value
  if (value && i < OTP_LENGTH - 1) focusBox(i + 1)
}

function onKeydown(i: number, event: KeyboardEvent) {
  if (event.key === 'Backspace' && !digits.value[i] && i > 0) {
    // 空格子按退格 → 退回前一格並清掉，符合一般驗證碼輸入的直覺
    event.preventDefault()
    digits.value[i - 1] = ''
    focusBox(i - 1)
    return
  }
  if (event.key === 'ArrowLeft' && i > 0) {
    event.preventDefault()
    focusBox(i - 1)
  }
  if (event.key === 'ArrowRight' && i < OTP_LENGTH - 1) {
    event.preventDefault()
    focusBox(i + 1)
  }
}

function onPaste(i: number, event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.replace(/\D/g, '')
  if (!text) return
  event.preventDefault()
  fill(text, i)
}

function fill(value: string, from: number) {
  for (let n = 0; n < value.length && from + n < OTP_LENGTH; n++) {
    digits.value[from + n] = value[n] ?? ''
  }
  const next = Math.min(from + value.length, OTP_LENGTH - 1)
  nextTick(() => focusBox(next))
}

function resetDigits() {
  digits.value = Array.from({ length: OTP_LENGTH }, () => '')
  nextTick(() => focusBox(0))
}

// ── 動作 ──────────────────────────────────────────────────────────────
function messageOf(err: unknown, fallback: string): string {
  const e = err as { statusMessage?: string, data?: { message?: string } }
  return e?.data?.message || e?.statusMessage || fallback
}

async function sendOtp() {
  error.value = ''
  pending.value = true
  try {
    await auth.requestOtp(email.value)
    step.value = 'otp'
    startCooldown()
    resetDigits()
  }
  catch (err) {
    error.value = messageOf(err, '此 Email 不在內部名單中，請聯絡系統管理員開通。')
  }
  finally {
    pending.value = false
  }
}

async function resend() {
  if (remaining.value > 0 || pending.value) return
  error.value = ''
  pending.value = true
  try {
    await auth.requestOtp(email.value)
    startCooldown()
    resetDigits()
  }
  catch (err) {
    error.value = messageOf(err, '重新寄送失敗，請稍後再試。')
  }
  finally {
    pending.value = false
  }
}

async function verify() {
  if (!otpComplete.value) return
  error.value = ''
  pending.value = true
  try {
    await auth.verifyOtp(email.value, otp.value)
    // ⚠️ 一律導向選組織頁，即使只有一個組織（§5.1 ①）
    await navigateTo({ path: '/organization', query: route.query })
  }
  catch (err) {
    // ⚠️ 設計稿的「還可嘗試 N 次」需要平台回傳剩餘次數，目前 API 沒有這個欄位，
    //    故不顯示次數 —— 寧可少講，也不要編一個會誤導客服的數字。
    error.value = messageOf(err, '驗證碼不正確，請確認後再試一次。')
    resetDigits()
  }
  finally {
    pending.value = false
  }
}

function backToEmail() {
  step.value = 'email'
  error.value = ''
  resetDigits()
  clearInterval(ticker)
  remaining.value = 0
}
</script>

<template>
  <div class="ac-card w-[440px] max-w-full">
    <!-- ── ① Email 步驟 ────────────────────────────────────────────── -->
    <form v-if="step === 'email'" class="px-7 pb-6 pt-7" @submit.prevent="sendOtp">
      <div class="mb-5 flex items-center justify-between">
        <span class="ac-eyebrow">AGENTCOPILOT</span>
        <span class="ac-mono text-[11px]" :style="{ color: 'var(--text-3)' }">v1.0 · internal</span>
      </div>

      <h1 class="ac-title">登入</h1>
      <p class="ac-subtitle mt-2">
        輸入公司 Email，我們會寄送 6 位數驗證碼。此工具僅供內部客服團隊使用。
      </p>

      <div class="mt-6">
        <label for="ac-email" class="ac-label">公司 Email</label>
        <div class="ac-input mt-1.5 flex items-center gap-2 px-3" :class="{ 'ring-0': true }">
          <UIcon name="i-lucide-mail" class="size-[15px] shrink-0" :style="{ color: 'var(--text-3)' }" />
          <input
            id="ac-email"
            v-model="email"
            type="email"
            autocomplete="email"
            placeholder="you@company.com"
            autofocus
            required
            class="h-full w-full bg-transparent text-[13.5px] outline-none placeholder:opacity-60"
          >
        </div>
        <p class="mt-1.5 flex items-center gap-1.5 text-[11px]" :style="{ color: 'var(--text-3)' }">
          <UIcon name="i-lucide-info" class="size-3 shrink-0" />
          僅接受已建檔的內部網域
        </p>
      </div>

      <p v-if="error" class="ac-alert-warn mt-4 flex items-start gap-2 px-3 py-2.5">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ error }}</span>
      </p>

      <button type="submit" class="ac-btn-primary mt-5 flex w-full items-center justify-center gap-2" :disabled="pending || !email">
        <template v-if="pending">
          <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
          正在寄送驗證碼…
        </template>
        <template v-else>
          傳送驗證碼
          <UIcon name="i-lucide-arrow-right" class="size-4" />
        </template>
      </button>
    </form>

    <!-- ── ② 驗證碼步驟 ────────────────────────────────────────────── -->
    <form v-else class="p-7" @submit.prevent="verify">
      <div class="mb-5 flex items-center gap-2.5">
        <button
          type="button"
          class="flex size-[26px] items-center justify-center rounded-md border transition-colors"
          :style="{ borderColor: 'var(--border)', color: 'var(--text-2)' }"
          aria-label="返回上一步"
          @click="backToEmail"
        >
          <UIcon name="i-lucide-arrow-left" class="size-3.5" />
        </button>
        <span class="ac-eyebrow">步驟 2 / 2</span>
      </div>

      <h1 class="ac-title">輸入驗證碼</h1>
      <p class="ac-subtitle mt-2">
        已寄送至 <span class="ac-mono">{{ maskedEmail }}</span>，10 分鐘內有效。
      </p>

      <div class="mt-6 flex justify-between gap-2">
        <input
          v-for="(_, i) in digits"
          :key="i"
          :ref="el => { if (el) boxes[i] = el as HTMLInputElement }"
          :value="digits[i]"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="1"
          :aria-label="`驗證碼第 ${i + 1} 碼`"
          class="size-14 rounded-[9px] border text-center font-[var(--font-mono)] text-[22px] outline-none transition-colors"
          :style="error
            ? { background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)', color: 'var(--warn)' }
            : { background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text)' }"
          @input="onDigitInput(i, $event)"
          @keydown="onKeydown(i, $event)"
          @paste="onPaste(i, $event)"
          @focus="($event.target as HTMLInputElement).select()"
        >
      </div>

      <p v-if="error" class="ac-alert-warn mt-4 flex items-start gap-2 px-3 py-2.5">
        <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
        <span>{{ error }}</span>
      </p>

      <button type="submit" class="ac-btn-primary mt-5 w-full" :disabled="pending || !otpComplete">
        <span v-if="pending" class="flex items-center justify-center gap-2">
          <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
          驗證中…
        </span>
        <span v-else>驗證並登入</span>
      </button>

      <div class="mt-4 flex items-center justify-between">
        <span class="text-[11.5px]" :style="{ color: 'var(--text-3)' }">
          沒收到？
          <template v-if="remaining > 0">
            <span class="ac-mono">{{ countdown }}</span> 後可重新寄送
          </template>
        </span>
        <button
          type="button"
          class="flex items-center gap-1.5 text-[11.5px] transition-opacity disabled:opacity-40"
          :style="{ color: 'var(--text-2)' }"
          :disabled="remaining > 0 || pending"
          @click="resend"
        >
          <UIcon name="i-lucide-refresh-cw" class="size-3" />
          重新寄送
        </button>
      </div>
    </form>
  </div>
</template>
