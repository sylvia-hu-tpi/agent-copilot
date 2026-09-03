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

/**
 * 選中態的三組配色 —— 畫布 1c 逐字（2026-09-01 版）。
 *
 * ⚠️ **三個模式的色系與「AI 參與程度」對應，不是隨意分配的**：
 *    全真人＝`--navy-soft`（我方主色，人在主導）、協作＝`--ai`（AI 也在說話）、
 *    全自動＝`--active`（系統自行運作）。先前 `automation` 用 `--ai`、`hybrid` 用 `--open`，
 *    等於把「AI 也在說話」這件事標在錯的那一個上。
 */
function toneOf(mode: ConversationMode): Record<string, string> {
  if (mode === 'automation') return { background: 'var(--active-bg)', borderColor: 'var(--active)', color: 'var(--active)' }
  if (mode === 'hybrid') return { background: 'var(--ai-bg)', borderColor: 'var(--ai-bd)', color: 'var(--ai)' }
  return { background: 'var(--navy-soft)', borderColor: 'var(--navy-soft-bd)', color: 'var(--navy-2)' }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <!-- ⚠️ 畫布這一顆是普通字重的 `--text-3` 文字，不是 `.ac-status-label`（700＋letter-spacing） -->
    <span class="text-[0.84375rem]" :style="{ color: 'var(--text-3)' }">{{ t('mode.label') }}</span>

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

    <!--
      ⚠️ 常駐警語。這不是提示，是防止誤操作的必要資訊。
      ⚠️ 前綴用 `UIcon` 而**不是文案裡的 ⚠️ emoji**（畫布 1c 是 11px 的 `alert-triangle`／`--open`）：
         emoji 在不同 OS 會渲染成各自的彩色圖，與整套線性 icon 不同族，且大小不受控。
         文案裡不留 emoji，i18n 字串才是純文字。
    -->
    <p class="flex w-full items-start gap-1.5 text-[0.8125rem] leading-snug" :style="{ color: 'var(--text-3)' }">
      <UIcon name="i-lucide-alert-triangle" class="mt-0.5 size-[11px] shrink-0" :style="{ color: 'var(--open)' }" />
      <span>{{ t('mode.sharedWarning') }}</span>
    </p>
  </div>
</template>
