<script setup lang="ts">
/**
 * 服務模式切換 —— docs/ARCHITECTURE.md §10.6。
 *
 * ⚠️ **Composer 上方必須有模式指示，且與官方介面一致。**
 *    客服會在 AgentCopilot 與 iMBrace 官方介面之間來回工作，
 *    同一個對話在兩處顯示不同狀態會直接造成誤送。
 *
 * ⚠️ **這不是本地偏好設定。** mode 是對話層級的共用狀態，切換會影響所有人，
 *    包含正在官方介面工作的同事 —— 尤其切到 `automation` 會讓**所有人**的
 *    Composer 都變成唯讀。介面必須讓客服意識到這一點，因此警語常駐而非 hover 才顯示。
 */

import type { ConversationMode } from '#shared/types/conversation'

const props = defineProps<{
  mode: ConversationMode | null
  disabled?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{ change: [ConversationMode] }>()

const { t } = useI18n()

/** 與官方介面的三個選項一一對應（§10.6 對照表） */
const OPTIONS: ConversationMode[] = ['manual', 'hybrid', 'automation']

const current = computed(() => props.mode)

function toneOf(mode: ConversationMode): Record<string, string> {
  if (mode === 'automation') return { background: 'var(--ai-bg)', borderColor: 'var(--ai-bd)', color: 'var(--ai)' }
  if (mode === 'hybrid') return { background: 'var(--open-bg)', borderColor: 'var(--border-strong)', color: 'var(--open)' }
  return { background: 'var(--active-bg)', borderColor: 'var(--border-strong)', color: 'var(--active)' }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <span class="ac-status-label">{{ t('mode.label') }}</span>

    <div class="flex items-center gap-1" role="radiogroup" :aria-label="t('mode.label')">
      <button
        v-for="opt in OPTIONS"
        :key="opt"
        type="button"
        role="radio"
        :aria-checked="current === opt"
        :disabled="disabled || busy"
        :title="t(`mode.${opt}Hint`)"
        class="rounded-full border px-2.5 py-0.5 text-[0.84375rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        :style="current === opt
          ? toneOf(opt)
          : { borderColor: 'var(--border)', color: 'var(--text-3)' }"
        @click="emit('change', opt)"
      >
        {{ t(`mode.${opt}`) }}
      </button>
    </div>

    <span v-if="current === null" class="text-[0.84375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('mode.none') }}
    </span>
    <span v-if="busy" class="text-[0.84375rem]" :style="{ color: 'var(--text-3)' }">
      {{ t('mode.switching') }}
    </span>

    <!-- ⚠️ 常駐警語。這不是提示，是防止誤操作的必要資訊 -->
    <p class="w-full text-[0.8125rem] leading-snug" :style="{ color: 'var(--text-3)' }">
      {{ t('mode.sharedWarning') }}
    </p>
  </div>
</template>
