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
  /**
   * 對話詳情還沒回來（畫布 §9 / 1d：「連線建立後才可輸入」）。
   *
   * ⚠️ **這個狀態不能併進 `composerBlockReason()`。** 那支函式回答的是「授權上為什麼
   *    不能送」，而載入中根本還不知道答案 —— 併進去等於在資料還沒到之前就宣稱
   *    「尚未接手此對話」，那是**猜的**，而且多數情況下猜錯（客服點進來的多半是自己已接手的）。
   */
  initializing?: boolean
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

const disabled = computed(() => props.initializing || blockedReason.value !== null || props.sending)

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

/**
 * 輸入框高度（畫布 1c，2026-09-01 新增）—— 可拖曳，也可鍵盤調整。
 *
 * ⚠️ **範圍的下限 72px 是「兩行」，不是隨手取的數字**（畫布副標逐字「兩行 72px – 320px」）。
 *    再低就會讓「Shift+Enter 換行」看起來像壞掉 —— 換了行卻看不到第二行。
 *    ⚠️ 預設值也是 72（畫布 3a 的 `composerH: 72`）—— 即「預設就是最小」，
 *    客服要更高時自己拖，而不是一開始就吃掉訊息流的空間。
 *    ⚠️ 步進 12／Shift 48 同樣照畫布，**與欄寬的 16／64 不同**，見 `usePaneSize` 的說明。
 * ⚠️ 高度**存在 `localStorage`**，與欄寬同一套機制：客服調整輸入框高度多半是因為
 *    自己的打字習慣（長回覆 vs 一句話），那是跨對話、跨 session 穩定的偏好。
 * ⚠️ `axis: 'y'` ＋ `invert: true` —— 把手在輸入框**上方**，滑鼠往上拖 → 變高。
 */
const composer = usePaneSize({
  key: 'ac.composerHeight',
  def: 72,
  min: 72,
  max: 320,
  axis: 'y',
  invert: true,
  step: 12,
})

onMounted(() => composer.restore())

defineExpose({ focus })
</script>

<template>
  <div>
    <!--
      輸入框高度把手（畫布 1c）：6px 橫桿，**取代原本 Composer 的 border-top**。
      ⚠️ 未接手時退回一條 1px 的線（畫布 `notClaimed` 態）—— 那時沒有輸入框可調，
         留一個調不動的把手只會讓人以為壞了。但那條線本身要留著，
         否則 Composer 區塊會與訊息流連成一片。
      ⚠️ `role="separator"` ＋ `aria-orientation="horizontal"` ＋ `tabindex=0`（憲法 8.2）：
         6px 的橫桿對只用鍵盤的人等於不存在，方向鍵是 ARIA 的標準做法。
    -->
    <div
      v-if="blockedReason?.key === 'notJoined' || initializing"
      class="h-px shrink-0"
      :style="{ background: 'var(--border)' }"
    />
    <!--
      ⚠️ **沿用 `ConversationResizeHandle`，不要另寫一份 markup。**
         2026-09-01 第一版曾自己寫一份，結果 hover 沒有任何反應 —— 因為底色寫在
         inline `:style` 上，而 inline style 的優先權高於 `hover:` class，
         那顆 class 被靜默蓋掉。共用元件裡已經用 `hovering` ref 解決過這件事。
    -->
    <ConversationResizeHandle
      v-else
      orientation="horizontal"
      :dragging="composer.dragging.value"
      :value="composer.size.value"
      :min="composer.min"
      :max="composer.max"
      :label="t('composer.resizeLabel')"
      :hint="t('composer.resizeHint')"
      @pointerdown="composer.startDrag"
      @keydown="composer.onKeydown"
    />

    <div class="space-y-2 px-4 py-3">
    <!-- 撞單攔截：擋在輸入框之上，但草稿仍原封不動保留在下方 -->
    <ConversationCollisionDialog
      v-if="collision"
      :collision="collision"
      :sending="sending"
      @send-anyway="emit('send', true)"
      @discard="emit('discard')"
      @review="emit('dismissCollision')"
    />

    <!-- 載入中：還不知道能不能送，只講「還沒好」，不編一個理由 -->
    <div
      v-if="initializing"
      class="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[0.875rem]"
      :style="{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-2)' }"
    >
      <UIcon name="i-lucide-loader-circle" class="size-3.5 shrink-0 animate-spin" />
      <span>{{ t('composer.initializing') }}</span>
    </div>

    <!--
      未接手：**整個輸入區換成虛線提示框**（畫布 1c `notClaimed` 態），不再另外渲染
      一個 disabled 的 textarea。
      ⚠️ 一個永遠打不出字的輸入框比沒有輸入框更難理解 —— 客服會先試著點進去打字，
         失敗兩次才會去讀上面那行說明。虛線框本身就說明了「這裡現在不能用」。
      ⚠️ 只有 `notJoined` 這樣處理。`automation`（唯讀觀察）與 `locked`（同事鎖）
         維持說明框＋停用輸入框：前兩者是**暫時**的狀態，客服可能想先把草稿打好，
         而畫布沒有涵蓋這兩種情況。
    -->
    <div
      v-else-if="blockedReason?.key === 'notJoined'"
      class="flex items-center gap-[9px] rounded-[9px] border border-dashed p-3.5"
      :style="{ borderColor: 'var(--border-dash)', background: 'var(--surface-2)', color: 'var(--text-3)' }"
    >
      <UIcon name="i-lucide-lock" class="size-[15px] shrink-0" />
      <span class="text-[0.9375rem]">{{ t('composer.notJoined') }}</span>
    </div>

    <!--
      ① 其餘兩種不能送出的原因（`automation` 唯讀、`locked` 同事鎖）。
      ⚠️ `notJoined` **不在這裡** —— 它已由上面的虛線框整段取代輸入區（畫布 1c）。
         在這裡再寫一支 `notJoined` 分支會是不可達的死碼（TS 會直接報 TS2367）。
    -->
    <div
      v-else-if="blockedReason"
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
        <template v-else-if="blockedReason.key === 'locked'">
          <p>{{ t('composer.locked', { name: blockedReason.name }) }}</p>
          <!-- ⚠️ 憲法 7.1：不得讓使用者誤判保護範圍 -->
          <p class="mt-0.5 opacity-80">{{ t('composer.lockBoundary') }}</p>
        </template>
      </div>
    </div>

    <!--
      輸入區（畫布 1c）：**上下兩列** —— 上為整寬 textarea，下為帶 `border-top` 的工具列。
      ⚠️ 先前是 textarea 與送出鍵左右並排的一列。改成兩列不只是版面：工具列那一列是
         日後放附件鈕的位置（M3，卡在 `IMBRACE_QUESTIONS.md` H-6c），先把結構做對，
         補按鈕時就不必整段重排。
      ⚠️ 附件鈕**現在仍然不放**，連 disabled 佔位鈕都不放 —— 在拿到 H-6c 的答案前
         那顆按鈕按下去沒有任何可走的路，而「按了不會有任何變化的按鈕比沒有按鈕更像壞掉」。
      ⚠️ 外框是 `--border-strong` 不是 `--border`（畫布）：輸入區要比周圍的卡片更「實」，
         那是整個畫面上唯一可以打字的地方。
    -->
    <div
      class="overflow-hidden rounded-[9px] border transition-colors"
      :style="{
        background: disabled ? 'var(--surface-3)' : 'var(--surface-2)',
        borderColor: 'var(--border-strong)',
      }"
    >
      <textarea
        ref="textarea"
        v-model="value"
        rows="2"
        :disabled="disabled"
        :placeholder="initializing ? t('composer.initializing') : blockedReason ? t('composer.placeholderReadonly') : t('composer.placeholder')"
        :aria-label="t('composer.placeholder')"
        class="w-full resize-none border-none bg-transparent px-3 py-2.5 text-base leading-[1.6] outline-none placeholder:opacity-60 disabled:cursor-not-allowed"
        :style="{ color: 'var(--text)', height: `${composer.size.value}px` }"
        @input="onInput"
        @keydown="onKeydown"
      />

      <div class="flex items-center gap-2 border-t px-2.5 py-[7px]" :style="{ borderColor: 'var(--border)' }">
        <span class="flex-1" />
        <!--
          ⚠️ 撞單期間送出鍵 MUST 明說是「已攔截」而不是只變灰（畫布 1c，憲法 8.1）——
             只變灰的話客服會以為是壞掉或還在送，而正確的下一步在上方的三個選項裡。
          ⚠️ 攔截態用 `--warn` 三色（底／框／字）而非停用的主按鈕：灰掉的主按鈕
             與「還在送出中」看起來一樣，而這兩件事要客服做的處置完全不同。
        -->
        <button
          type="button"
          class="flex h-[30px] shrink-0 items-center gap-[7px] rounded-[7px] px-3.5 text-[0.96875rem] font-medium transition-opacity"
          :class="collision ? 'border' : 'ac-btn-primary'"
          :style="collision
            ? { background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)', color: 'var(--warn)' }
            : undefined"
          :disabled="disabled || !value.trim() || Boolean(collision)"
          :aria-disabled="Boolean(collision)"
          @click="emit('send', false)"
        >
          <UIcon
            :name="collision ? 'i-lucide-lock' : sending ? 'i-lucide-loader-circle' : 'i-lucide-send-horizontal'"
            class="size-3.5"
            :class="{ 'animate-spin': sending && !collision }"
          />
          {{ collision ? t('composer.blocked') : sending ? t('composer.sending') : t('composer.send') }}
        </button>
      </div>
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
  </div>
</template>
