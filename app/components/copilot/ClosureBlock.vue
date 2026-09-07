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
const actionItems: string[] = [...ACTIONS_TAKEN]

const props = defineProps<{
  conversationId: string
  /**
   * 情緒區塊此刻仍在分析（`analyzing`／`retrying`）。
   *
   * ⚠️ **為什麼要知道這件事**：結案草稿不等分析完成（兩條路徑並行），但它會讀
   *    情緒時間軸來算 `sentimentStart`／`End`／`Trough`。分析還沒回來時三個數值
   *    一起留空（FR-022b，且 `sentiment-range.ts` 有保護不會拿半段資料算出假的分數）
   *    —— 問題是 `sentimentNote` 只說「現在沒有」，沒說「還在算」。客服因此無從得知
   *    「再等一下就會有」，就這樣把一筆情緒欄位空白的紀錄寫進 CRM。
   * ⚠️ 由頁面傳入而不是自己訂閱 —— 這個元件只消費 closure store，
   *    多開一份 SSE 訂閱會多一份要對齊的狀態。
   */
  sentimentPending?: boolean
}>()
const emit = defineEmits<{ committed: [] }>()

const store = useClosureStore()
const { t, locale } = useI18n()

/*
  ⚠️ **display 與 value 是兩件事。** `RESOLUTIONS`／`SENTIMENT_OUTCOMES` 的值是
     英文 snake_case，而且 `config/categories.ts` 註明「值域來自 `ARCHITECTURE.md`
     §11.5，MUST 逐字相同」—— 它們是寫進 Board `SingleSelection` 的值，不能翻譯。
     把 `string[]` 直接餵給 `USelect` 會讓 display 等於 value，客服看到的是
     `unresolved`／`still_negative`（2026-09-04 手動驗收發現）。
     `CATEGORIES`／`ACTIONS_TAKEN` 的值本身就是中文，因此不需要對照。

  ⚠️ **`escalated` 在兩張表裡語意不同**，MUST NOT 共用一份對照：
     `resolution.escalated` ＝ 案子往上轉；`sentimentOutcome.escalated` ＝
     客戶情緒惡化。同一個英文值、相反的好壞方向，翻錯一邊會讓報表把
     「已升級處理」讀成「客戶更生氣了」。
*/
const resolutionItems = computed<{ label: string, value: string }[]>(() =>
  RESOLUTIONS.map(v => ({ label: t(`closure.vocab.resolution.${v}`), value: v })))

const sentimentOutcomeItems = computed<{ label: string, value: string }[]>(() =>
  SENTIMENT_OUTCOMES.map(v => ({ label: t(`closure.vocab.sentimentOutcome.${v}`), value: v })))
const toast = useToast()

const session = computed(() => store.get(props.conversationId) ?? null)
const status = computed(() => session.value?.status ?? null)
const draft = computed(() => session.value?.draft ?? null)
const busy = computed(() => status.value === 'loadingScopes' || status.value === 'generating')

/**
 * `generating` 有兩種完全不同的畫面（`DESIGN_TOKENS.md` §7.5 的 `regen`）：
 * - **首次產生** → 一整塊「正在產生結案摘要」。
 * - **重新產生**（改了涵蓋範圍或按了「重新產生」）→ 提示卡 ＋ 按鈕收成單一忙碌鍵。
 *
 * ⚠️ **判斷來源是 store 的 `regenerating` 旗標，MUST NOT 用 `draft !== null` 推導。**
 *    契約 R2.2 要求發請求前先清空 `draft`，所以 `generating` 期間 `draft` 恆為 `null`；
 *    用它推導的話 `regenerating` 永遠是 `false`，這一整段畫面變成死程式碼
 *    —— 2026-09-04 實際發生過，而且測試沒抓到（守衛只掃原始碼、不驗行為）。
 */
const regenerating = computed(() => session.value?.regenerating === true)
const loadingFirstDraft = computed(() => busy.value && !regenerating.value)

const readonlyFields = computed(() => draft.value?.readonly ?? null)

/**
 * 「草稿產生於 HH:mm:ss」。
 *
 * ⚠️ **MUST 依賴 `draftId`**（2026-09-08 修）。原本寫成 `format(new Date())` 且沒有任何
 *    反應式依賴（`locale` 除外），因此 `computed` 的快取值就是**第一次渲染**的時間：
 *    按下「重新產生」拿到新草稿之後，畫面上那個時間還停在二十分鐘前，
 *    而客服正是靠它判斷手上這份是新的還是舊的。
 * ⚠️ 這裡沒有 server 端的產生時間可用（`ClosureDraft` 不帶時間戳），
 *    因此退而求其次：以 `draftId` 當依賴，在**收到新草稿的那一刻**重算一次。
 *    兩者的差距是一次網路往返，遠小於「永遠不更新」。
 */
const draftAt = computed(() => {
  if (!draft.value?.draftId) return ''
  return new Intl.DateTimeFormat(locale.value, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date())
})

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

/**
 * 「要做什麼」還沒填的後續事項列。
 *
 * ⚠️⚠️ **沒有這道守門時，客服會卡在一個出不去的迴圈**（2026-09-08 修）。
 *      「新增後續事項」推入的是一列 `{ action: '' }`，而 commit 端點的 zod
 *      要求 `action` 至少一個字 —— 直接按寫入會收到 400。
 *      前端把 400 歸成「寫入失敗」，顯示的是 B7 的
 *      「CRM 未收到這筆結案紀錄⋯可直接重試」，
 *      而重試送的是一模一樣的 body，於是永遠失敗，
 *      畫面上也沒有任何地方指得出是那一列空白造成的。
 *
 * ⚠️ 處置刻意選「**擋下並就地標示**」而不是「送出前默默濾掉」：
 *    客服可能已經填了負責人或期限，靜默丟棄等於吃掉他打的字，而他不會知道。
 */
const invalidFollowUpRows = computed(() => {
  const rows = draft.value?.followUps ?? []
  return new Set(rows.flatMap((f, i) => (f.action.trim() ? [] : [i])))
})

const hasInvalidFollowUps = computed(() => invalidFollowUpRows.value.size > 0)

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
/**
 * 按鈕列的六種組合（畫布 §7.2 ⑥ 的 `freshIdle`／`staleIdle`／`scopeRegen`／
 * `writing`／`writeFail=failed`／`writeFail=unverified`）。
 *
 * ⚠️ 逐字取畫布的色票，**不用 Nuxt UI 的 color／variant 近似值** —— 差最多的是
 *    `staleIdle`：畫布刻意把「重新產生」升成 `--open` 系的主要動作、把「仍要寫入」
 *    降成白底次要。用 primary／neutral 近似會做出**相反的引導** —— 寫入鈕仍是畫面上
 *    最醒目的藍鍵，等於在推客服直接寫入已經過期的摘要（2026-09-04 比對畫布時發現）。
 */
const BTN = 'flex h-[30px] items-center justify-center gap-1.5 rounded-[7px] text-[0.9063rem] transition-colors'

const regenBtnStyle = computed(() => {
  if (status.value === 'writing') {
    return {
      border: '1px solid var(--border)',
      background: 'var(--surface-3)',
      color: 'var(--text-3)',
      opacity: 0.6,
    }
  }
  // 摘要過期：升為主要動作
  if (!showFailure.value && session.value?.stale) {
    return {
      border: '1px solid var(--open)',
      background: 'var(--open-bg)',
      color: 'var(--open)',
      fontWeight: 500,
    }
  }
  return {
    border: '1px solid var(--border-strong)',
    background: 'var(--surface)',
    // ⚠️ B7／B8 降為次要（畫布寫明理由：此刻重產只會蓋掉待寫入的內容）
    color: showFailure.value ? 'var(--text-2)' : 'var(--text)',
  }
})

const commitBtnStyle = computed(() => {
  if (showFailure.value) {
    return { border: 'none', background: 'var(--danger)', color: '#fff', fontWeight: 500 }
  }
  if (status.value === 'writing') {
    return {
      border: 'none',
      background: 'var(--navy)',
      color: 'var(--navy-fg)',
      fontWeight: 500,
      opacity: 0.85,
    }
  }
  // 摘要過期：降為次要
  if (session.value?.stale) {
    return {
      border: '1px solid var(--border-strong)',
      background: 'var(--surface)',
      color: 'var(--text)',
      fontWeight: 500,
    }
  }
  return { border: 'none', background: 'var(--navy)', color: 'var(--navy-fg)', fontWeight: 500 }
})

const commitIcon = computed(() => {
  if (status.value === 'writing') return 'i-lucide-loader-2'
  if (showFailure.value) {
    return failKind.value === 'unverified' ? 'i-lucide-shield-check' : 'i-lucide-rotate-cw'
  }
  return 'i-lucide-database'
})

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
    // ⚠️ `err.message` 為空 ＝ 從回應裡取不到原因。文案在 i18n（憲法 8.5），
    //    store 不再自己塞一句寫死的「未知錯誤」。
    : t('closure.fail.metaFailed', {
        time,
        reason: err.message || t('closure.fail.unknownReason'),
        reqId: err.reqId ?? '—',
      })
})

/**
 * 候選查詢失敗的**真正原因**（R1.4）。
 *
 * ⚠️ 固定文案只說得出「查不到這個對話過去的結案紀錄……請重試」，但 `loadScopes()`
 *    把**任何**失敗都收斂成 `scopesError`：設定缺失（500）、找不到對話（404）、
 *    Board 查詢真的失敗（502）在畫面上長得一模一樣，而只有最後一種重試才有意義。
 *    2026-09-08 的實例：`IMBRACE_CLOSURE_BOARD_ID` 沒填，每一個對話按結案都回 500，
 *    畫面卻說「這不代表沒有結案過，請重試」—— 重試一萬次都不會好，
 *    而截圖裡沒有任何線索指向設定。
 *
 * ⚠️ 原因**本來就在** `error.message` 裡（store 的 `messageOf()` 早就取出來了），
 *    只是沒有任何地方顯示它。這裡比照 B7／B8 的 `failMeta` 把它露出來 ——
 *    客服未必看得懂那句技術訊息，但看不懂也比看到一句錯的好：至少轉給 IT 的截圖是對的。
 *
 * ⚠️ 這條路徑**沒有** `reqId`（那是寫入三步才有的，FR-035a），因此樣板只有時間與原因，
 *    MUST NOT 為了與 `failMeta` 對稱而補一個 `—` 上去 —— 那會讓人以為它有而取不到。
 */
const scopesErrorMeta = computed(() => {
  const err = session.value?.error
  if (!err) return ''
  const time = new Intl.DateTimeFormat(locale.value, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(err.at))
  // ⚠️ `err.message` 為空 ＝ 從回應裡取不到原因，與 `failMeta` 同一個判斷與同一句補字
  return t('closure.scopesError.meta', {
    time,
    reason: err.message || t('closure.fail.unknownReason'),
  })
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
  <!--
    置頂列：只說「已進入結案流程」。⚠️ 不在此處解釋「為什麼其他區塊收合了」。

    ⚠️ **它在卡片之外**（畫布 `order:0`，第 6 區塊是 `order:1`）——
       塞進卡片裡當一條 `--surface-2` 的頂欄會讓它讀成「這張卡的標題」，
       而它講的是**整個右欄現在處於結案流程**，範圍比這張卡大。
       樣式逐字照畫布：`--navy-soft` 底 ＋ `--navy-soft-bd` 框 ＋ radius 8px ＋ padding 7px 10px。
    ⚠️ 文案拆成兩個 key 是為了「結案流程」四個字的強調（畫布逐字：`--text` ＋ 500）——
       同一句話拆鍵通常是 i18n 的壞味道，這裡是刻意的，改文案時兩個 key 要一起看。
  -->
  <div
    class="flex items-center gap-[7px] rounded-lg border px-2.5 py-[7px]"
    :style="{ background: 'var(--navy-soft)', borderColor: 'var(--navy-soft-bd)' }"
  >
    <UIcon name="i-lucide-flag" class="size-3.5 shrink-0" :style="{ color: 'var(--navy-2)' }" />
    <span class="text-[0.875rem]" :style="{ color: 'var(--text-2)' }">
      {{ $t('closure.enteredBannerPrefix')
      }}<span class="font-medium" :style="{ color: 'var(--text)' }">{{ $t('closure.enteredBannerStrong') }}</span>
    </span>
  </div>

  <!--
    ⚠️ **本區塊自己也可收合**（§7.5 容器表：chevron 在最左邊）——
       它與另外五塊共用 `BlockShell`，因此收合行為、徽章與 focus 樣式都不會各自漂移。
       先前這裡自己畫了一組不可收合的標題列，第 6 區塊因此是面板裡唯一收不起來的一塊。
  -->
  <CopilotBlockShell :title="$t('closure.blockTitle')">
    <!-- ⚠️ tag 覆寫成非等寬：畫布 ⑥ 的「AI 草稿 · 可修改」沒有 mono（分隔是 U+00B7，不是「・」） -->
    <template #tag>
      <span class="shrink-0 text-[0.8125rem]" :style="{ color: 'var(--text-3)' }">
        {{ $t('closure.blockTag') }}
      </span>
    </template>

    <div class="flex flex-col gap-2.5">
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
        <!--
          真正的原因（見 `scopesErrorMeta` 的說明）。取不到就整行不出現 ——
          MUST NOT 留一個只有時間的空殼，那會讓人以為原因是「沒有原因」。
        -->
        <p
          v-if="scopesErrorMeta"
          class="ac-mono mt-1.5 text-[0.8125rem] break-all"
          :style="{ color: 'var(--text-3)' }"
        >
          {{ scopesErrorMeta }}
        </p>
        <UButton size="xs" class="mt-2" color="neutral" variant="outline" @click="onRetryScopes">
          {{ $t('closure.buttons.retry') }}
        </UButton>
      </div>

      <!--
        過期標記（FR-044）。⚠️ 與 Composer 上方的常駐橫幅是兩個獨立呈現。
        ⚠️ 位置在**選擇器之上**（畫布逐字：它是內容區的第一項）——
           「對話有新內容」講的是這份草稿整體過期了，不是涵蓋範圍選錯了；
           擺在選擇器下方會讀成在解釋剛剛那個選擇。
      -->
      <p
        v-if="session?.stale"
        class="flex items-start gap-[7px] rounded-[7px] border px-[9px] py-[7px] text-[0.875rem] leading-relaxed"
        :style="{ background: 'var(--open-bg)', borderColor: 'var(--open-bg)', color: 'var(--open)' }"
      >
        <UIcon name="i-lucide-clock-alert" class="mt-0.5 size-3.5 shrink-0" />
        {{ $t('closure.staleNotice') }}
      </p>

      <!--
        ② 涵蓋範圍選擇器
        ⚠️ `regenerating` 傳的是 `regenerating` 而**不是** `status === 'generating'` ——
           後者在「按下結案的首次產生」也是 true，於是選擇器會冒出一行
           「涵蓋範圍已改為…正在重新產生摘要」，而客服根本沒改過範圍。
           真正的 regen 的前提是**手上已經有一份草稿**（見 script 區的定義）。
      -->
      <CopilotClosureScopePicker
        v-if="session?.scopes"
        :scopes="session.scopes"
        :selected="session.selected"
        :regenerating="regenerating"
        :period="draft?.period ?? null"
        @pick="onPick"
      />

      <!-- ③ 首次產生中：忙碌鍵 ＋ 旋轉 loader。⚠️ 文案不含秒數（FR-046a） -->
      <div
        v-if="loadingFirstDraft"
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

      <!--
        ③-b `regen` 的單一忙碌鍵（§7.5 逐字）。

        ⚠️ **它必須獨立掛在這裡，不能放進 ⑧ 按鈕列** —— 契約 R2.2 要求發請求前先清空
           `draft`，而 ⑧ 整段包在 `v-if="draft"` 裡，因此 regen 期間那一列根本不會渲染。
           放在裡面的話畫面中間會是一片空白（2026-09-04 發現）。
        ⚠️ 它是**灰的 disabled 鍵**（`--surface-3` 底 ＋ `--text-3` 字），不是 primary ——
           primary 會讀成「可以按、而且是主要動作」，而它什麼都不做。
        ⚠️ 此刻**刻意沒有**「一鍵寫入 CRM」：正在重算的這一份還不存在，
           能寫的只有已經被清掉的舊草稿。
      -->
      <div v-if="regenerating" class="flex items-center gap-2">
        <button
          type="button"
          disabled
          :class="BTN"
          class="min-w-0 flex-1 cursor-not-allowed px-3"
          :style="{
            border: '1px solid var(--border)',
            background: 'var(--surface-3)',
            color: 'var(--text-3)',
          }"
        >
          <UIcon name="i-lucide-loader-2" class="size-3.5 shrink-0 animate-spin" />
          {{ $t('closure.buttons.regenerating') }}
        </button>
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
        <label class="flex flex-col gap-1">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-3)' }">
            {{ $t('closure.fields.summary') }}
          </span>
          <!--
            ⚠️ **畫布的 `regen` 淡出（`opacity:0.45`）在這裡做不到，刻意不做。**
               畫布 B4 讓舊的摘要正文淡出，但契約 R2.2 要求發請求前先把 `draft` 清空
               （理由：保留舊內容的話畫面顯示的是上一個區間的摘要，而兩份長得一樣、
               客服看不出來）。`draft` 是 `null` 時這個 textarea 根本不會渲染，
               沒有正文可以淡出 —— 綁上 opacity 只會是死程式碼。
               這個規格衝突已記入 `DESIGN_FEEDBACK.md` D-8，等 Design 與 R2.2 二選一。
          -->
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
            <!--
              ⚠️ 空白的「要做什麼」會讓寫入被 server 擋下（見 script 區的
                 `invalidFollowUpRows`）。錯誤 MUST 標在客服打字的那一格上 ——
                 只把寫入鍵停用而不指出是哪一列，等於換一種方式卡住他。
            -->
            <UInput
              class="flex-1"
              :model-value="f.action"
              :placeholder="$t('closure.fields.followUpAction')"
              :color="invalidFollowUpRows.has(i) ? 'error' : undefined"
              :aria-invalid="invalidFollowUpRows.has(i)"
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
          <p
            v-if="hasInvalidFollowUps"
            class="text-[0.8125rem]"
            :style="{ color: 'var(--danger)' }"
          >
            {{ $t('closure.fields.followUpActionRequired') }}
          </p>
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
            <!--
              ⚠️ 留空的原因有兩種，客服的下一步完全不同：
                 「還在算」→ 等一下按「重新產生」就有值；
                 「客戶沒發言／評分未涵蓋區間起點」→ 等也不會有。
                 `sentimentNote` 描述的是後者的形狀，因此**仍在分析時要換一句**，
                 否則客服會把「再等十秒就有」讀成「本來就沒有」。
            -->
            <div v-else class="col-span-2">
              <span
                v-if="sentimentPending"
                class="flex items-start gap-1.5"
                :style="{ color: 'var(--open)' }"
              >
                <UIcon name="i-lucide-loader-2" class="mt-0.5 size-3 shrink-0 animate-spin" />
                {{ $t('closure.fields.sentimentPending') }}
              </span>
              <span v-else :style="{ color: 'var(--text-3)' }">{{ readonlyFields.sentimentNote }}</span>
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

        <!--
          ⑧ 按鈕列（畫布 §7.2 ⑥ 的六種組合）。版面逐字：左鈕 `flex:none`、
             右鈕 `flex:1` 撐滿剩餘寬度，因此整列是滿寬而不是靠右對齊。
          ⚠️ `regen` 的單一忙碌鍵**不在這裡**（見 ③-b）—— 這一列整段包在
             `v-if="draft"` 內，而 regen 期間 `draft` 依契約 R2.2 已被清空。
          ⚠️ 「重新產生」在 B7／B8 **降為次要**（畫布逐字寫明理由）：
             此刻重產只會蓋掉待寫入的內容 —— 客服要的是把手上這一份寫進去。
        -->
        <div class="flex items-center gap-2">
          <button
            type="button"
            :class="BTN"
            class="shrink-0 px-[11px] disabled:cursor-not-allowed"
            :style="regenBtnStyle"
            :disabled="status === 'writing'"
            @click="onRegenerate"
          >
            <UIcon name="i-lucide-refresh-cw" class="size-3.5 shrink-0" />
            {{ $t('closure.buttons.regenerate') }}
          </button>

          <!-- ⚠️ 次鈕只有 B7 有 —— B8 的出路是人工查驗後重試，不是回報 -->
          <UButton
            v-if="showFailure && failKind === 'failed'"
            color="neutral"
            variant="outline"
            @click="reportToIt"
          >
            {{ $t('closure.buttons.reportIt') }}
          </UButton>

          <button
            type="button"
            :class="BTN"
            class="min-w-0 flex-1 px-3 disabled:cursor-not-allowed disabled:opacity-60"
            :style="commitBtnStyle"
            :title="hasInvalidFollowUps ? $t('closure.fields.followUpActionRequired') : undefined"
            :disabled="status === 'writing' || hasInvalidFollowUps"
            @click="onCommit"
          >
            <UIcon
              :name="commitIcon"
              class="size-3.5 shrink-0"
              :class="status === 'writing' ? 'animate-spin' : ''"
            />
            {{ status === 'writing'
              ? $t('closure.buttons.writing')
              : showFailure
                ? (failKind === 'unverified'
                  ? $t('closure.buttons.retryWriteUnverified')
                  : $t('closure.buttons.retryWrite'))
                : session?.stale ? $t('closure.buttons.commitStale') : $t('closure.buttons.commit') }}
          </button>
        </div>

        <p class="text-[0.8125rem] leading-relaxed" :style="{ color: 'var(--text-3)' }">
          {{ $t('closure.writeWarning') }}
        </p>
      </template>
    </div>
  </CopilotBlockShell>
</template>
