<script setup lang="ts">
/**
 * 第 6 區塊：結案摘要自動填入（畫布 2a ⑥、`docs/DESIGN_TOKENS.md` §7.2）。
 *
 * ⚠️⚠️ **未進入結案流程時整塊不存在**（FR-047）—— 由 `pages/c/[conversationId].vue`
 *      以 `v-if` 決定，**不是 `v-show`**、不是收合、不是骨架。
 *      常駐一個空的結案區塊會讓每個對話看起來都「快要結案了」，
 *      而 §14.1.1 拒絕讓它常駐的理由（每個對話多跑一次 AI 呼叫）也還在。
 *
 * ⚠️ **`commit` 只能由「一鍵寫入 CRM」的 handler 經 store 呼叫**（SC-001、契約 R3.1）。
 *    本元件不自己打任何端點，一切經 `useClosureStore()`。
 *    `test/closure-commit-guard.test.ts` 會掃 `app/**` 確認全 repo 只有一處。
 *
 * ⚠️ **唯讀區的情緒三數值為 `null` 時顯示 `sentimentNote`，MUST NOT 顯示 0**（FR-022b）。
 *    「留空」與「0 分」是兩件事，顯示 0 會讓客服以為客戶情緒是最低分。
 *
 * ⚠️ **受控詞彙欄位沒有自由輸入**（憲法 4.6）。模型挑不到時該欄位留空並顯示
 *    「請選擇」—— MUST NOT 保留模型自己生成的值。
 */

import {
  ACTIONS_TAKEN,
  CATEGORIES,
  RESOLUTIONS,
  SENTIMENT_OUTCOMES,
} from '~~/config/categories'
import type { ClosureFollowUp, ClosurePeriodOrigin } from '#shared/types/copilot'
import { useClosureStore } from '~/stores/closure'

/*
  ⚠️ 刻意放寬成 `string[]`：`config/categories.ts` 的 `as const` 讓 `USelect` 把
     `model-value` 的型別窄化成那幾個字面值，而受控詞彙欄位**允許空字串**
     （模型挑不到、客服還沒補時就是留空，FR-015）。不放寬的話 typecheck 會逼人
     把「留空」實作成某個真實選項，而那正是憲法 4.6 禁止的事。
     ⚠️ 值域仍然只有這一份來源 —— 放寬的是型別，不是清單。
*/
const categoryItems: string[] = [...CATEGORIES]
const resolutionItems: string[] = [...RESOLUTIONS]
const sentimentOutcomeItems: string[] = [...SENTIMENT_OUTCOMES]
const actionItems: string[] = [...ACTIONS_TAKEN]

const props = defineProps<{ conversationId: string }>()
const emit = defineEmits<{ committed: [] }>()

const store = useClosureStore()
const { t, locale } = useI18n()
const toast = useToast()

const session = computed(() => store.get(props.conversationId) ?? null)
const status = computed(() => session.value?.status ?? null)
const draft = computed(() => session.value?.draft ?? null)
const busy = computed(() => status.value === 'loadingScopes' || status.value === 'generating')

const readonlyFields = computed(() => draft.value?.readonly ?? null)

const draftAt = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()))

// ── 編輯 ───────────────────────────────────────────────────────────────

const set = (key: Parameters<typeof store.updateField>[1], value: string | string[] | ClosureFollowUp[]): void =>
  store.updateField(props.conversationId, key, value)

function addFollowUp(): void {
  set('followUps', [...(draft.value?.followUps ?? []), { action: '' }])
}

function removeFollowUp(i: number): void {
  set('followUps', (draft.value?.followUps ?? []).filter((_, idx) => idx !== i))
}

function patchFollowUp(i: number, over: Partial<ClosureFollowUp>): void {
  set('followUps', (draft.value?.followUps ?? []).map((f, idx) => (idx === i ? { ...f, ...over } : f)))
}

function removeSop(id: string): void {
  set('citedSopIds', (draft.value?.citedSopIds ?? []).filter(x => x !== id))
}

// ── 動作 ───────────────────────────────────────────────────────────────

const onPick = (start: string, origin: ClosurePeriodOrigin): void => {
  void store.pick(props.conversationId, start, origin)
}

const onRegenerate = (): void => void store.regenerate(props.conversationId)
const onRetryScopes = (): void => void store.loadScopes(props.conversationId)

/*
  ── 兩種寫入失敗態（B7／B8，`docs/DESIGN_TOKENS.md` §7.2）───────────────

  ⚠️ **拆成兩態的判準是「客服接下來該做什麼」不同，不是錯誤碼不同。**
     B7（`failed`）：CRM 沒收到，可直接重試。
     B8（`unverified`）：平台說寫成功了但查不到 —— MUST 先請客服到 CRM 查驗，
        因此主鈕的文字本身就綁著那一步（「已確認沒有，重試寫入」）。
  ⚠️ **兩者只切文案與按鈕，MUST NOT 在 store 開第二條狀態路徑**
     （`test/nuxt/closure-store-failures.test.ts` 會驗四種的狀態轉移完全相同）。
  ⚠️ **摘要不清空** —— 錯誤區塊插在按鈕列上方、摘要正文下方。
*/
const failKind = computed(() => session.value?.error?.failKind ?? null)
const showFailure = computed(() => status.value === 'ready' && !!failKind.value)

const failIcon = computed(() =>
  (failKind.value === 'unverified' ? 'i-lucide-shield-alert' : 'i-lucide-x-circle'))

const failMeta = computed(() => {
  const err = session.value?.error
  if (!err) return ''
  const time = new Intl.DateTimeFormat(locale.value, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(err.at))
  return failKind.value === 'unverified'
    ? t('closure.fail.metaUnverified', { time, reqId: err.reqId ?? '—' })
    : t('closure.fail.metaFailed', { time, reason: err.message, reqId: err.reqId ?? '—' })
})

const failFallback = computed(() => {
  if (failKind.value !== 'unverified') return t('closure.fail.failed.fallback')
  return t('closure.fail.unverified.fallback', {
    when: new Intl.DateTimeFormat(locale.value, {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(session.value?.error?.at ?? Date.now())),
    category: draft.value?.category || '—',
  })
})

/**
 * 「回報 IT」（B7 的次鈕）。畫布只定義了按鈕文字，行為由本規格補上。
 *
 * ⚠️ **MUST NOT 複製草稿內容**（`summary`／`intent`）—— 那是客戶對話個資
 *    （憲法 1.5 的同一個理由）。要貼給 IT 的是「哪一次請求、哪一份草稿、哪一通對話」，
 *    IT 拿 `reqId` 就能在日誌裡把三步寫入串起來（FR-035a），不需要看到內容。
 * ⚠️ 不開 mailto、不引入新環境變數 —— 那會是一條沒有人維護的對外設定。
 */
async function reportToIt(): Promise<void> {
  const lines = [
    failMeta.value,
    `draftId: ${draft.value?.draftId ?? '—'}`,
    `conversationId: ${props.conversationId}`,
  ].join('\n')
  try {
    await navigator.clipboard.writeText(lines)
    toast.add({ title: t('closure.fail.reportCopied'), color: 'neutral' })
  }
  catch {
    // 剪貼簿被瀏覽器擋下（非安全來源、未授權）—— 靜默降級，不要再彈一個錯誤蓋住原本的失敗
  }
}

/** ⚠️ **全元件唯一觸發寫入的地方** —— 由「一鍵寫入 CRM」按鈕直接呼叫，沒有其他路徑 */
async function onCommit(): Promise<void> {
  const result = await store.commit(props.conversationId)
  if (!result) return
  // FR-034：告知而非攔截 —— 紀錄已經寫入，這裡只是多說一句
  for (const other of result.newClosuresSincePanelOpen) {
    toast.add({
      title: t('closure.othersClosed', {
        name: other.operatorName,
        time: new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' })
          .format(new Date(other.closedAt)),
      }),
      color: 'neutral',
    })
  }
  emit('committed')
}
</script>

<template>
  <section class="ac-card overflow-hidden">
    <!-- 置頂列：只說「已進入結案流程」。⚠️ 不在此處解釋「為什麼其他區塊收合了」 -->
    <div
      class="flex items-center gap-2 border-b px-3 py-2"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface-2)' }"
    >
      <UIcon name="i-lucide-flag" class="size-3.5" :style="{ color: 'var(--navy-2)' }" />
      <span class="text-[0.8438rem] font-medium">{{ $t('closure.enteredBanner') }}</span>
    </div>

    <div class="flex items-center gap-2 px-3 py-[11px]">
      <h2 class="ac-eyebrow shrink-0 px-[9px]">{{ $t('closure.blockTitle') }}</h2>
      <span class="flex-1" />
      <!-- ⚠️ 分隔是 U+00B7，不是「・」 -->
      <span class="ac-mono shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ $t('closure.blockTag') }}
      </span>
    </div>

    <div class="flex flex-col gap-3 px-3 pb-3">
      <!-- ① 候選查詢失敗：MUST NOT 以任何預設區間頂替、MUST NOT 產生草稿（R1.4） -->
      <div
        v-if="status === 'scopesError'"
        class="rounded-lg border p-3"
        :style="{ background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)' }"
      >
        <p class="text-[0.9063rem] font-medium">{{ $t('closure.scopesError.title') }}</p>
        <p class="mt-1 text-[0.875rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
          {{ $t('closure.scopesError.body') }}
        </p>
        <UButton size="xs" class="mt-2" color="neutral" variant="outline" @click="onRetryScopes">
          {{ $t('closure.buttons.retry') }}
        </UButton>
      </div>

      <!-- ② 涵蓋範圍選擇器 -->
      <CopilotClosureScopePicker
        v-if="session?.scopes"
        :scopes="session.scopes"
        :selected="session.selected"
        :regenerating="status === 'generating'"
        @pick="onPick"
      />

      <!-- ③ 產生中：忙碌鍵 ＋ 旋轉 loader。⚠️ 文案不含秒數（FR-046a） -->
      <div
        v-if="busy"
        class="flex items-start gap-2 rounded-lg border px-3 py-2.5"
        :style="{ background: 'var(--surface-2)', borderColor: 'var(--border)' }"
      >
        <UIcon name="i-lucide-loader-2" class="mt-0.5 size-4 shrink-0 animate-spin" :style="{ color: 'var(--navy-2)' }" />
        <div class="min-w-0 flex-1">
          <p class="text-[0.9063rem] font-medium">{{ $t('closure.generating.title') }}</p>
          <p class="mt-0.5 text-[0.875rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
            {{ $t('closure.generating.body') }}
          </p>
        </div>
      </div>

      <!-- ④ 產生失敗：顯示錯誤與重試，⚠️ **不呈現空白草稿**（FR-046） -->
      <div
        v-if="status === 'draftError'"
        class="rounded-lg border p-3"
        :style="{ background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)' }"
      >
        <p class="text-[0.9063rem] font-medium">{{ $t('closure.draftError.title') }}</p>
        <p class="mt-1 text-[0.875rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
          {{ $t('closure.draftError.body') }}
        </p>
        <UButton size="xs" class="mt-2" color="neutral" variant="outline" @click="onRegenerate">
          {{ $t('closure.buttons.retry') }}
        </UButton>
      </div>

      <!-- ⑤ 草稿本體 -->
      <template v-if="draft">
        <!-- 過期標記（FR-044）。⚠️ 與 Composer 上方的常駐橫幅是兩個獨立呈現 -->
        <p
          v-if="session?.stale"
          class="flex items-center gap-1.5 rounded px-2 py-1.5 text-[0.8125rem]"
          :style="{ background: 'var(--open-bg)', color: 'var(--open)' }"
        >
          <UIcon name="i-lucide-clock-alert" class="size-3" />
          {{ $t('closure.staleNotice') }}
        </p>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.summary') }}
          </span>
          <UTextarea
            :model-value="draft.summary"
            :rows="5"
            autoresize
            @update:model-value="set('summary', String($event))"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.intent') }}
          </span>
          <UInput
            :model-value="draft.intent"
            @update:model-value="set('intent', String($event))"
          />
        </label>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label class="flex flex-col gap-1">
            <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
              {{ $t('closure.fields.category') }}
            </span>
            <USelect
              :model-value="draft.category"
              :items="categoryItems"
              :placeholder="$t('closure.fields.choose')"
              @update:model-value="set('category', String($event))"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
              {{ $t('closure.fields.resolution') }}
            </span>
            <USelect
              :model-value="draft.resolution"
              :items="resolutionItems"
              :placeholder="$t('closure.fields.choose')"
              @update:model-value="set('resolution', String($event))"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
              {{ $t('closure.fields.sentimentOutcome') }}
            </span>
            <USelect
              :model-value="draft.sentimentOutcome"
              :items="sentimentOutcomeItems"
              :placeholder="$t('closure.fields.choose')"
              @update:model-value="set('sentimentOutcome', String($event))"
            />
          </label>
        </div>

        <!-- 模型留空的受控詞彙欄位：明白要求客服補上（FR-015） -->
        <p
          v-if="!draft.category || !draft.resolution || !draft.sentimentOutcome"
          class="text-[0.8125rem]"
          :style="{ color: 'var(--open)' }"
        >
          {{ $t('closure.fields.chooseHint') }}
        </p>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.actionsTaken') }}
          </span>
          <USelectMenu
            :model-value="draft.actionsTaken"
            multiple
            :items="actionItems"
            @update:model-value="set('actionsTaken', ($event as string[]))"
          />
        </label>

        <div v-if="draft.citedSopIds.length" class="flex flex-col gap-1">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.citedSops') }}
          </span>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="id in draft.citedSopIds"
              :key="id"
              class="flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.8125rem]"
              :style="{ background: 'var(--navy-soft)', color: 'var(--info)' }"
            >
              {{ id }}
              <button
                type="button"
                :aria-label="$t('closure.fields.sopRemove')"
                :title="$t('closure.fields.sopRemove')"
                @click="removeSop(id)"
              >
                <UIcon name="i-lucide-x" class="size-3" />
              </button>
            </span>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.followUps') }}
          </span>
          <div v-for="(f, i) in draft.followUps" :key="i" class="flex items-center gap-1.5">
            <UInput
              class="flex-1"
              :model-value="f.action"
              :placeholder="$t('closure.fields.followUpAction')"
              @update:model-value="patchFollowUp(i, { action: String($event) })"
            />
            <UInput
              class="w-28"
              :model-value="f.owner ?? ''"
              :placeholder="$t('closure.fields.followUpOwner')"
              @update:model-value="patchFollowUp(i, { owner: String($event) })"
            />
            <UInput
              class="w-28"
              :model-value="f.dueHint ?? ''"
              :placeholder="$t('closure.fields.followUpDueHint')"
              @update:model-value="patchFollowUp(i, { dueHint: String($event) })"
            />
            <UButton
              size="xs" color="neutral" variant="ghost" icon="i-lucide-x"
              :aria-label="$t('closure.fields.followUpRemove')"
              @click="removeFollowUp(i)"
            />
          </div>
          <UButton
            size="xs" color="neutral" variant="ghost" icon="i-lucide-plus"
            class="self-start"
            @click="addFollowUp"
          >
            {{ $t('closure.fields.followUpAdd') }}
          </UButton>
        </div>

        <!-- ⑥ 唯讀區 —— 由系統計算，客服改不了（FR-010a，寫入時 server 會重算） -->
        <div
          v-if="readonlyFields"
          class="rounded-lg border p-2.5 text-[0.8438rem]"
          :style="{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-2)' }"
        >
          <p class="mb-1 text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.readonlyTitle') }}
          </p>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-1">
            <div class="contents">
              <dt>{{ $t('closure.fields.operators') }}</dt>
              <dd class="ac-mono truncate">{{ readonlyFields.operators.join('、') }}</dd>
            </div>
            <div class="contents">
              <dt>{{ $t('closure.fields.joinedAt') }}</dt>
              <dd class="ac-mono truncate">{{ readonlyFields.joinedAt }}</dd>
            </div>
            <!--
              ⚠️ 三個數值為 null 時**顯示原因，不顯示 0**（FR-022b）。
                 顯示 0 會讓「這段情緒不可信」被讀成「客戶情緒是最低分」。
            -->
            <template v-if="readonlyFields.sentimentStart !== null">
              <div class="contents">
                <dt>{{ $t('closure.fields.sentimentStart') }}</dt>
                <dd class="ac-mono">{{ readonlyFields.sentimentStart }}</dd>
              </div>
              <div class="contents">
                <dt>{{ $t('closure.fields.sentimentEnd') }}</dt>
                <dd class="ac-mono">{{ readonlyFields.sentimentEnd }}</dd>
              </div>
              <div class="contents">
                <dt>{{ $t('closure.fields.sentimentTrough') }}</dt>
                <dd class="ac-mono">{{ readonlyFields.sentimentTrough }}</dd>
              </div>
            </template>
            <div v-else class="col-span-2">
              <span :style="{ color: 'var(--text-3)' }">{{ readonlyFields.sentimentNote }}</span>
            </div>
          </dl>
        </div>

        <p class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
          {{ $t('closure.draftAt', { time: draftAt }) }}
        </p>

        <!--
          ⑦ 兩種寫入失敗態（B7／B8）。⚠️ 插在**按鈕列上方、摘要正文下方**，
             摘要不清空 —— 客服編了半天的內容不能因為一次寫入失敗就消失。
        -->
        <div
          v-if="showFailure"
          class="flex flex-col gap-[7px] rounded-lg p-[9px_11px]"
          :style="{
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-bd)',
            borderLeft: '3px solid var(--danger)',
          }"
        >
          <div class="flex items-start gap-2">
            <UIcon :name="failIcon" class="mt-0.5 size-3.5 shrink-0" :style="{ color: 'var(--danger)' }" />
            <div class="min-w-0 flex-1">
              <p class="text-[0.9063rem] font-semibold" :style="{ color: 'var(--danger)' }">
                {{ failKind === 'unverified'
                  ? $t('closure.fail.unverified.title')
                  : $t('closure.fail.failed.title') }}
              </p>
              <p class="mt-0.5 text-[0.875rem] leading-relaxed" :style="{ color: 'var(--text-2)' }">
                {{ failKind === 'unverified'
                  ? $t('closure.fail.unverified.body')
                  : $t('closure.fail.failed.body') }}
              </p>
            </div>
          </div>

          <!-- ⚠️ meta 列的 `req` 是 FR-035a 的請求識別碼：客服看不懂也不需要懂，
               但那是事後唯一能判斷「平台沒建」還是「我方回查用錯 id」的線索 -->
          <p class="flex items-center gap-1.5 pl-[21px]">
            <UIcon name="i-lucide-clock" class="size-[11px] shrink-0" :style="{ color: 'var(--text-3)' }" />
            <span class="ac-mono text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">{{ failMeta }}</span>
          </p>
          <p class="flex items-start gap-1.5 pl-[21px]">
            <UIcon name="i-lucide-corner-down-right" class="mt-0.5 size-[11px] shrink-0" :style="{ color: 'var(--text-3)' }" />
            <span class="text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">{{ failFallback }}</span>
          </p>
        </div>

        <!-- ⑧ 兩顆按鈕（畫布的六種組合） -->
        <div class="flex items-center justify-end gap-2">
          <!--
            ⚠️ 「重新產生」在 B7／B8 **降為次要**（畫布逐字寫明理由）：
               此刻重產只會蓋掉待寫入的內容 —— 客服要的是把手上這一份寫進去。
          -->
          <UButton
            color="neutral"
            :variant="!showFailure && session?.stale ? 'solid' : 'ghost'"
            :disabled="status === 'writing'"
            @click="onRegenerate"
          >
            {{ $t('closure.buttons.regenerate') }}
          </UButton>

          <!-- ⚠️ 次鈕只有 B7 有 —— B8 的出路是人工查驗後重試，不是回報 -->
          <UButton
            v-if="showFailure && failKind === 'failed'"
            color="neutral"
            variant="outline"
            @click="reportToIt"
          >
            {{ $t('closure.buttons.reportIt') }}
          </UButton>

          <UButton
            :color="showFailure ? 'error' : 'primary'"
            :icon="showFailure
              ? (failKind === 'unverified' ? 'i-lucide-shield-check' : 'i-lucide-rotate-cw')
              : undefined"
            :loading="status === 'writing'"
            :disabled="status === 'writing'"
            @click="onCommit"
          >
            {{ status === 'writing'
              ? $t('closure.buttons.writing')
              : showFailure
                ? (failKind === 'unverified'
                  ? $t('closure.buttons.retryWriteUnverified')
                  : $t('closure.buttons.retryWrite'))
                : session?.stale ? $t('closure.buttons.commitStale') : $t('closure.buttons.commit') }}
          </UButton>
        </div>

        <p class="text-[0.8125rem] leading-relaxed" :style="{ color: 'var(--text-3)' }">
          {{ $t('closure.writeWarning') }}
        </p>
      </template>
    </div>
  </section>
</template>
