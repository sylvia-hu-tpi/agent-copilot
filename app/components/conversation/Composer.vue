<script setup lang="ts">
/**
 * 回覆輸入框 —— docs/ARCHITECTURE.md §10.4 / §10.6、憲法 8.4。
 *
 * ── 四個硬性要求 ─────────────────────────────────────────────────
 * ⚠️ ① **`automation` 時必須停用，不能只是送出後失敗。**
 *    讓客服打完一整段話才發現送不出去，比一開始就停用更糟（§10.6）。
 *    而且要**說明原因** —— 同事在別處切了模式，這裡看起來就像壞掉。
 *
 * ⚠️ ② **草稿絕不遺失**（憲法 8.4）。送出失敗、撞單被攔、斷線、重新整理
 *    都不得清空。只有「確定送出成功」與「客服自己選擇捨棄」才清。
 *
 * ⚠️ ③ **鍵盤可操作**（憲法 8.2）。客服以打字為主，滑鼠切換成本高。
 *
 * ⚠️ ④ **`composing` 狀態要即時上報。** 那是 presence ① 唯一能提供、
 *    而其他來源都給不了的資訊 —— 也是最能阻止撞單的一種提示。
 */

import type { ConversationControl } from '#shared/types/conversation'
import type { CollisionReport } from '#shared/types/events'

const props = defineProps<{
  control: ConversationControl | null
  viewerJoined: boolean
  sending: boolean
  sendError: string | null
  collision: CollisionReport | null
  draft: string
  myOperatorId?: string
}>()

const emit = defineEmits<{
  'update:draft': [string]
  'send': [force: boolean]
  'discard': []
  'dismissCollision': []
  'composing': []
}>()

const { t } = useI18n()

const textarea = ref<HTMLTextAreaElement | null>(null)

/**
 * 為什麼不能送 —— 每一種原因都要有自己的說明。
 * 統一顯示「無法送出」會讓客服無從判斷該做什麼（是要 JOIN？還是去改模式？）。
 *
 * ⚠️ 判斷順序抽到 `app/utils/composer-block.ts` 並有專屬測試 ——
 *    M1 手動驗收時抓到這裡的順序寫反過（未加入被顯示成「全自動唯讀」），
 *    而 typecheck / 單元測試 / smoke 全都驗不到「理由對不對」。
 */
const blockedReason = computed(() => composerBlockReason({
  control: props.control,
  viewerJoined: props.viewerJoined,
  myOperatorId: props.myOperatorId,
}))

const disabled = computed(() => blockedReason.value !== null || props.sending)

const value = computed({
  get: () => props.draft,
  set: (v: string) => emit('update:draft', v),
})

/** ⚠️ 節流：不必每一次按鍵都打一次 API，但要夠即時才有意義 */
const COMPOSING_THROTTLE_MS = 3_000
let lastComposingAt = 0

function onInput(): void {
  const now = Date.now()
  if (now - lastComposingAt < COMPOSING_THROTTLE_MS) return
  lastComposingAt = now
  emit('composing')
}

/**
 * Enter 送出、Shift+Enter 換行。
 *
 * ⚠️ 必須排除 IME 組字中的 Enter（`isComposing`）——
 *    中文輸入法選字時按 Enter 是「確認選字」，不是「送出」。
 *    少了這個判斷，客服每打一個中文詞就會送出一次半成品。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey) return
  if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) return
  e.preventDefault()
  if (!disabled.value && value.value.trim()) emit('send', false)
}

function focus(): void {
  textarea.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="space-y-2 border-t px-4 py-3" :style="{ borderColor: 'var(--border)' }">
    <!-- 撞單攔截：擋在輸入框之上，但草稿仍原封不動保留在下方 -->
    <ConversationCollisionDialog
      v-if="collision"
      :collision="collision"
      :sending="sending"
      @send-anyway="emit('send', true)"
      @discard="emit('discard')"
      @review="emit('dismissCollision')"
    />

    <!-- ① 不能送出時，一定要說明是哪一種原因 -->
    <div
      v-if="blockedReason"
      class="flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[0.875rem]"
      :style="{
        background: 'var(--surface-2)',
        borderColor: 'var(--border)',
        color: 'var(--text-2)',
      }"
    >
      <UIcon name="i-lucide-info" class="mt-px size-3.5 shrink-0" />
      <div>
        <p v-if="blockedReason.key === 'automation'">{{ t('composer.readonlyAutomation') }}</p>
        <p v-else-if="blockedReason.key === 'notJoined'">{{ t('composer.notJoined') }}</p>
        <template v-else-if="blockedReason.key === 'locked'">
          <p>{{ t('composer.locked', { name: blockedReason.name }) }}</p>
          <!-- ⚠️ 憲法 7.1：不得讓使用者誤判保護範圍 -->
          <p class="mt-0.5 opacity-80">{{ t('composer.lockBoundary') }}</p>
        </template>
      </div>
    </div>

    <div
      class="flex items-end gap-2 rounded-lg border px-2.5 py-2 transition-colors"
      :style="{
        background: disabled ? 'var(--surface-3)' : 'var(--surface-2)',
        borderColor: 'var(--border)',
      }"
    >
      <textarea
        ref="textarea"
        v-model="value"
        rows="2"
        :disabled="disabled"
        :placeholder="blockedReason ? t('composer.placeholderReadonly') : t('composer.placeholder')"
        :aria-label="t('composer.placeholder')"
        class="max-h-40 min-h-[42px] w-full resize-y bg-transparent text-[0.96875rem] leading-relaxed outline-none placeholder:opacity-60 disabled:cursor-not-allowed"
        :style="{ color: 'var(--text)' }"
        @input="onInput"
        @keydown="onKeydown"
      />

      <button
        type="button"
        class="ac-btn-primary flex shrink-0 items-center gap-1.5 px-3"
        :disabled="disabled || !value.trim()"
        @click="emit('send', false)"
      >
        <UIcon
          :name="sending ? 'i-lucide-loader-circle' : 'i-lucide-send-horizontal'"
          class="size-3.5"
          :class="{ 'animate-spin': sending }"
        />
        {{ sending ? t('composer.sending') : t('composer.send') }}
      </button>
    </div>

    <div class="flex items-center justify-between gap-3 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
      <span>{{ t('composer.hint') }}</span>
      <!-- ⚠️ 憲法 8.4：讓客服看得到草稿確實被保住了 -->
      <span v-if="draft.trim()" class="flex items-center gap-1">
        <UIcon name="i-lucide-check" class="size-3" />
        {{ t('composer.draftSaved') }}
      </span>
    </div>

    <p v-if="sendError" class="ac-alert-warn flex items-start gap-2 px-2.5 py-1.5">
      <UIcon name="i-lucide-alert-circle" class="mt-px size-3.5 shrink-0" />
      <span>{{ sendError }}</span>
    </p>
  </div>
</template>
