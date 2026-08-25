<script setup lang="ts">
/**
 * 撞單攔截 —— docs/ARCHITECTURE.md §10.4、憲法 3.3。
 *
 * **這是全系統唯一允許阻斷使用者的介面。**
 * 理由：重複回覆客戶的傷害，遠大於多按一次按鈕的成本。
 *
 * ── 設計上的三個硬性要求 ─────────────────────────────────────────
 * ⚠️ ① **必須顯示對方到底說了什麼。** 只說「有人回覆過」而不給內容，
 *    客服無從判斷自己的稿子是重複、矛盾、還是剛好補足 ——
 *    他只能盲目選一個，那等於把決定權還給了擲骰子。
 *
 * ⚠️ ② **「仍要送出」必須存在且不可藏起來。** 我們的偵測有誤判的可能
 *    （例如同事只是回了一句「我看看」），把路堵死會逼客服去官方介面繞過，
 *    那比讓他自己判斷更糟。
 *
 * ⚠️ ③ **草稿不在這裡清除。** 客服選「捨棄」時才由呼叫端清，
 *    關掉這個對話框只是回到編輯狀態。
 */

import type { CollisionReport } from '#shared/types/events'

const props = defineProps<{ collision: CollisionReport, sending?: boolean }>()

const emit = defineEmits<{
  sendAnyway: []
  discard: []
  review: []
}>()

const { t } = useI18n()

const headline = computed(() => {
  if (props.collision.kind === 'unverified') return t('collision.unverified')
  if (props.collision.kind === 'ai') return t('collision.byAi')

  const latest = props.collision.messages.at(-1)
  return t('collision.byAgent', {
    name: latest?.sender.name || t('presence.unknownName'),
  })
})

function timeOf(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div
    class="rounded-lg border p-3"
    :style="{ background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)' }"
    role="alertdialog"
    aria-live="assertive"
  >
    <div class="flex items-start gap-2">
      <UIcon
        name="i-lucide-alert-triangle"
        class="mt-0.5 size-4 shrink-0"
        :style="{ color: 'var(--warn)' }"
      />
      <div class="min-w-0 flex-1 space-y-2">
        <div>
          <p class="text-[12.5px] font-semibold" :style="{ color: 'var(--warn)' }">
            {{ t('collision.title') }}
          </p>
          <p class="mt-0.5 text-[12px]" :style="{ color: 'var(--text)' }">{{ headline }}</p>
        </div>

        <!-- ① 一定要看得到對方說了什麼，否則客服無從判斷 -->
        <div v-if="collision.messages.length" class="space-y-1">
          <p class="ac-status-label">{{ t('collision.theirMessage') }}</p>
          <ul class="space-y-1">
            <li
              v-for="m in collision.messages"
              :key="m.id"
              class="rounded-md border px-2 py-1.5 text-[12px] leading-relaxed"
              :style="{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }"
            >
              <span class="ac-mono mr-1.5 text-[10.5px]" :style="{ color: 'var(--text-3)' }">
                {{ timeOf(m.at) }}
              </span>
              <span class="whitespace-pre-wrap break-words">{{ m.text || '（無文字內容）' }}</span>
            </li>
          </ul>
        </div>

        <div class="flex flex-wrap gap-2 pt-0.5">
          <!-- ② 不可藏起來：我們的偵測有誤判可能，堵死會逼客服去官方介面繞過 -->
          <button
            type="button"
            class="rounded-md border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50"
            :style="{ borderColor: 'var(--warn-bd)', color: 'var(--warn)' }"
            :disabled="sending"
            @click="emit('sendAnyway')"
          >
            {{ sending ? t('composer.sending') : t('collision.sendAnyway') }}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-[12px] transition-opacity hover:opacity-70"
            :style="{ color: 'var(--text-2)' }"
            :disabled="sending"
            @click="emit('review')"
          >
            {{ t('collision.review') }}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1 text-[12px] transition-opacity hover:opacity-70"
            :style="{ color: 'var(--text-3)' }"
            :disabled="sending"
            @click="emit('discard')"
          >
            {{ t('collision.discard') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
