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
 *    ⚠️ **四個欄位一視同仁**：分類／處理結果／情緒結果（單選）＋ 採取的行動（多選）。
 *    留空是**合法**的寫入值（`commit.post.ts` 的 `enumOrEmpty` 允許空字串），
 *    因此畫面若不說，客服會直接寫入一筆欄位空白的正式紀錄而全程無錯誤 ——
 *    「請選擇」與其下那句提示是這條路徑上唯一的煞車。
 */

import {
  ACTIONS_TAKEN,
  CATEGORIES,
  RESOLUTIONS,
  SENTIMENT_OUTCOMES,
} from '~~/config/categories'
import type { ClosureCitedSop, ClosureFollowUp, ClosurePeriodOrigin } from '#shared/types/copilot'
import { useClosureStore } from '~/stores/closure'

/*
  ⚠️ 刻意放寬成 `string[]`：`config/categories.ts` 的 `as const` 會把型別窄化成
     那幾個字面值，而受控詞彙欄位**允許空字串**（模型挑不到、客服還沒補時就是留空，
     FR-015）。不放寬的話 typecheck 會逼人把「留空」實作成某個真實選項，
     而那正是憲法 4.6 禁止的事。
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

/**
 * 「接手時間」的**顯示**值。⚠️ 只換顯示，寫進 Data Board 的值不動。
 *
 * ⚠️ 這一格原本把 server 給的字串原樣印出來（`2026-09-08T02:13:19.700Z`）。
 *    那是 UTC，而客服在 UTC+8 讀它 —— 螢幕上是 02:13、
 *    他記得自己十點多才接手，於是這個「由系統計算、不可修改」的欄位變成沒人會去看的字。
 *
 * ⚠️ **Board 的值不受這裡影響，而且結構上不可能受影響**：`joined_at` 由
 *    `commit.post.ts` 以 server 端的 `computeReadonlyFields()` 重算，
 *    request body 帶來的一律忽略（契約 R3.7）。跨時區的比對基準因此恆為 UTC，
 *    這也是刻意不把「易讀版本」寫進 Board 的原因 —— 存進去的字串一旦帶了
 *    產生它的那台瀏覽器的時區，之後就再也無法確定它到底是哪個時刻。
 */
const joinedAtLabel = computed(() => {
  const iso = readonlyFields.value?.joinedAt
  return iso ? formatAbsolute(iso, locale.value) : ''
})

/**
 * 情緒三數值留空時那句說明（`sentimentNote`）裡的時間戳，一併換成易讀版本。
 *
 * ⚠️ **這是「就地改寫」而不是「重組句子」**：`sentimentNote` 是 server 在
 *    `sentiment-range.ts` 組好的一整句中文，句型有四種（沒有評分點／起點無法解析／
 *    評分未涵蓋第一則客戶發言／區間起點之後沒有評分點）。要在前端重組就得把那四句
 *    拆成 i18n key ＋ 參數，連帶改動契約欄位、Board schema 與四份規格文件 ——
 *    而客服要的只是「那個時間我看得懂」。因此只挑句子裡的 ISO 時間戳換掉，
 *    其餘一個字都不動。
 *
 * ⚠️ **只換畫面，Board 的 `period_sentiment_note` 仍存原始 ISO** ——
 *    理由同 `joinedAtLabel`：存進去的字串帶了瀏覽器時區之後就無法還原成確切時刻。
 *    這是刻意讓畫面與 Board／後端日誌在字面上不一致（2026-09-08 使用者裁示：
 *    前端以客服好比對為主，不強求與後端日誌逐字相同）。
 *
 * ⚠️ 比對不到就整段留原樣 —— 其中一句正是「區間起點無法解析（…）」，
 *    那一句裡的字串本來就不是合法時間，**它必須維持原樣**才說得通。
 */
const sentimentNoteLabel = computed(() => {
  const note = readonlyFields.value?.sentimentNote
  if (!note) return ''
  return humanizeTimestamps(note, locale.value)
})

// ── 編輯 ───────────────────────────────────────────────────────────────

const set = (
  key: Parameters<typeof store.updateField>[1],
  value: string | string[] | ClosureFollowUp[] | ClosureCitedSop[],
): void => store.updateField(props.conversationId, key, value)

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
  set('citedSops', (draft.value?.citedSops ?? []).filter(s => s.id !== id))
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

/**
 * B7 那一列次要文字鈕的樣式（畫布 `hasFailSecond` 分支逐字）——
 * 無框無底、`--navy-2`、底線。⚠️ **底線不可省**：這一列沒有框也沒有底色，
 * 底線是它唯一「看得出來可以按」的訊號，而它出現的時機正是客服最慌的那一刻。
 */
const LINK_BTN = 'cursor-pointer border-none bg-transparent p-0 text-[0.8438rem] underline'


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
 * 「複製摘要文字」（B7 的次鈕之一）——照 `failFallback` 那句話，
 * 讓客服把手上這份草稿貼到 CRM 手動建檔。
 *
 * ⚠️ **這裡 MUST 複製草稿內文，與 `reportToIt` 正好相反。**
 *    `reportToIt` 的收件人是 IT，草稿內文是客戶對話個資、不該給他們（憲法 1.5）；
 *    這一顆的目的地是**客服自己的剪貼簿**，而他本來就正在螢幕上讀這些內容。
 *    寫入已經失敗了，此刻擋住他手動建檔只會讓那次服務完全沒有紀錄。
 *
 * ⚠️ 內容是**客服眼前這一份**（含他自己改過的欄位），不是 AI 的原始草稿 ——
 *    貼進 CRM 的必須跟他按下寫入時想寫的那一份相同。
 * ⚠️ 唯讀區的三個情緒數值與 `sentimentNote` 也帶上：CRM 那幾欄要填什麼，
 *    只有這裡看得到。時間一律用**易讀版本**（`formatAbsolute`）——
 *    這份文字的唯一讀者是人。
 */
async function copySummaryText(): Promise<void> {
  const d = draft.value
  if (!d) return
  const ro = d.readonly
  const line = (label: string, value: string): string => `${label}：${value || '—'}`
  const lines = [
    line(t('closure.fields.summary'), d.summary),
    line(t('closure.fields.intent'), d.intent),
    line(t('closure.fields.category'), d.category),
    line(t('closure.fields.resolution'), resolutionItems.value.find(o => o.value === d.resolution)?.label ?? ''),
    line(t('closure.fields.sentimentOutcome'), sentimentOutcomeItems.value.find(o => o.value === d.sentimentOutcome)?.label ?? ''),
    line(t('closure.fields.actionsTaken'), d.actionsTaken.join('、')),
    line(t('closure.fields.citedSops'), d.citedSops.map(c => c.title).join('、')),
    line(
      t('closure.fields.followUps'),
      d.followUps.map(f => [f.action, f.owner, f.dueHint].filter(Boolean).join(' / ')).join('；'),
    ),
    line(t('closure.fields.operators'), ro.operatorLabels.join('、')),
    line(t('closure.fields.joinedAt'), formatAbsolute(ro.joinedAt, locale.value)),
    ro.sentimentStart === null
      ? line(t('closure.fields.sentimentStart'), humanizeTimestamps(ro.sentimentNote ?? '', locale.value))
      : [
          line(t('closure.fields.sentimentStart'), String(ro.sentimentStart)),
          line(t('closure.fields.sentimentEnd'), String(ro.sentimentEnd)),
          line(t('closure.fields.sentimentTrough'), String(ro.sentimentTrough)),
        ].join('\n'),
  ].join('\n')
  try {
    await navigator.clipboard.writeText(lines)
    toast.add({ title: t('closure.fail.summaryCopied'), color: 'neutral' })
  }
  catch {
    // 剪貼簿被瀏覽器擋下（非安全來源、未授權）—— 靜默降級，不要再彈一個錯誤蓋住原本的失敗
  }
}

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
          <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
            {{ $t('closure.fields.summary') }}
          </span>
          <!--
            ⚠️ **`regen` 期間不做淡出，這是契約 R2.2 的直接結果，不是省略。**
               R2.2 要求發請求前先把 `draft` 清空（理由：保留舊內容的話畫面顯示的是
               上一個區間的摘要，而兩份長得一樣、客服看不出來）。`draft` 是 `null` 時
               這個 textarea 根本不會渲染，沒有正文可以淡出 —— 綁 opacity 只會是死程式碼。
               ✅ 2026-09-08 版畫布已採納此決議：舊的 `sumOpacity`（B4 的 `opacity:0.45`）
               整個移除，B4 改為「重算期間整份表單不存在 ＋ 單一忙碌鍵」，並逐字加註
               「舊內容不留半透明殘影」。畫布與 R2.2 現在同義，`DESIGN_FEEDBACK.md` D-8 已結清。
          -->
          <textarea
            class="ac-field min-h-[104px] resize-y px-[11px] py-[9px] text-[0.9375rem] leading-[1.7]"
            :value="draft.summary"
            @input="set('summary', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
            {{ $t('closure.fields.intent') }}
          </span>
          <input
            class="ac-field h-[34px] px-[11px]"
            :value="draft.intent"
            @input="set('intent', ($event.target as HTMLInputElement).value)"
          >
        </label>

        <!--
          ⚠️ **三個受控詞彙欄位是原生 `<select>`，不是 `USelect`**（2026-09-08 照畫布改）。
             畫布 §7.2 ⑥ 訂的是 34px／radius 9px／`--surface-2` 底／`--border-strong` 框
             ＋ 右側絕對定位的 `chevron-down`，而 `USelect` 走的是 Nuxt UI 自己的預設尺寸
             與色盤 —— 對不上，且不會有任何錯誤或型別問題。
             這也讓第 6 區塊與專案其餘部分一致：全 repo 的表單控制項都是手刻 ＋ 畫布 token。
          ⚠️ **首項固定是 `value=""` 的「請選擇」**，且文字色依有無值切換
             （有值 `--text`／留空 `--text-2`）—— 留空是合法的寫入值，
             它必須看得出來是「還沒填」而不是「填了空白」。
        -->
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
              {{ $t('closure.fields.category') }}
            </span>
            <span class="relative block">
              <select
                class="ac-field h-[34px] cursor-pointer appearance-none py-0 pl-[11px] pr-7"
                :style="{ color: draft.category ? 'var(--text)' : 'var(--text-2)' }"
                :value="draft.category"
                @change="set('category', ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ $t('closure.fields.choose') }}</option>
                <option v-for="c in categoryItems" :key="c" :value="c">{{ c }}</option>
              </select>
              <UIcon
                name="i-lucide-chevron-down"
                class="pointer-events-none absolute right-[9px] top-1/2 size-3.5 -translate-y-1/2"
                :style="{ color: 'var(--text-3)' }"
              />
            </span>
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
              {{ $t('closure.fields.resolution') }}
            </span>
            <span class="relative block">
              <select
                class="ac-field h-[34px] cursor-pointer appearance-none py-0 pl-[11px] pr-7"
                :style="{ color: draft.resolution ? 'var(--text)' : 'var(--text-2)' }"
                :value="draft.resolution"
                @change="set('resolution', ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ $t('closure.fields.choose') }}</option>
                <option v-for="r in resolutionItems" :key="r.value" :value="r.value">
                  {{ r.label }}
                </option>
              </select>
              <UIcon
                name="i-lucide-chevron-down"
                class="pointer-events-none absolute right-[9px] top-1/2 size-3.5 -translate-y-1/2"
                :style="{ color: 'var(--text-3)' }"
              />
            </span>
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
              {{ $t('closure.fields.sentimentOutcome') }}
            </span>
            <span class="relative block">
              <select
                class="ac-field h-[34px] cursor-pointer appearance-none py-0 pl-[11px] pr-7"
                :style="{ color: draft.sentimentOutcome ? 'var(--text)' : 'var(--text-2)' }"
                :value="draft.sentimentOutcome"
                @change="set('sentimentOutcome', ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ $t('closure.fields.choose') }}</option>
                <option v-for="o in sentimentOutcomeItems" :key="o.value" :value="o.value">
                  {{ o.label }}
                </option>
              </select>
              <UIcon
                name="i-lucide-chevron-down"
                class="pointer-events-none absolute right-[9px] top-1/2 size-3.5 -translate-y-1/2"
                :style="{ color: 'var(--text-3)' }"
              />
            </span>
          </label>
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
            {{ $t('closure.fields.actionsTaken') }}
          </span>
          <!--
            ⚠️ **這一顆刻意保留 `USelectMenu`，不像另外三個那樣手刻。**
               畫布對它要的正是 `aria-haspopup="listbox"` ＋ `aria-multiselectable`
               ＋ `role="option"` ＋ 鍵盤操作與焦點管理 —— 那些 `USelectMenu` 現成就有，
               而手刻重寫最容易出錯的也正是這一段，且**無障礙壞掉不會報錯**。
               外觀差異用 `:ui` 對到畫布的 token 即可（`ac-field` 與另外三個共用）。
          -->
          <USelectMenu
            :model-value="draft.actionsTaken"
            multiple
            :items="actionItems"
            :placeholder="$t('closure.fields.choose')"
            :search-input="{ placeholder: $t('closure.fields.actionSearch') }"
            :ui="{
              base: 'ac-field h-[34px] py-0 pl-[11px] pr-[9px] cursor-pointer',
              placeholder: 'text-[var(--text-2)]',
              content: 'rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)]',
            }"
            @update:model-value="set('actionsTaken', ($event as string[]))"
          >
            <!--
              ⚠️ **搜尋框與空結果的文案 MUST 自己給。** `USelectMenu` 內建的字串走
                 `@nuxt/ui` 自己的 locale，而本專案沒有設定 `UApp` 的 `locale` ——
                 於是它落回英文預設（`Search…`／`No matching data`），在一個全中文的
                 內部工具裡漏出兩句英文。**這不會報錯，也不在我方的 i18n 檔裡**，
                 因此 grep 自己的語系檔永遠找不到它（2026-09-08 比對畫布時才發現）。
              ⚠️ 逐字取畫布：placeholder「搜尋行動…」、空結果「沒有符合的行動」。
              ⚠️ **畫布另外要 `aria-label="搜尋行動"`，這裡沒有給** —— `searchInput` 的型別是
                 `InputProps`，而它用 `@vue-ignore` 把 `InputHTMLAttributes` 從 props 型別裡拿掉了，
                 傳 `aria-label` 會是型別錯誤。執行期其實會落到 `<input>` 上
                 （`UInput` 是 `inheritAttrs: false` ＋ `v-bind="{ ...$attrs, ...ariaAttrs }"`），
                 但為此加一個「型別說不行、實際可以」的 cast 不划算：
                 那個 aria-label 的字與 placeholder 完全相同，少了它並不會讓這個控制項失去名稱。
                 ⚠️ 要補的話**連同 cast 的理由一起寫**，不要只加一個 `as any`。
            -->
            <template #empty>
              <span class="text-[0.875rem]" :style="{ color: 'var(--text-3)' }">
                {{ $t('closure.fields.actionEmpty') }}
              </span>
            </template>
          </USelectMenu>
        </label>

        <!--
          模型留空的受控詞彙欄位：明白要求客服補上（FR-015、FR-020a）。

          ⚠️ **四個欄位共用這一句，因此位置在四個欄位之後**（2026-09-08 從三個單選
             之間移到這裡）—— 三個單選並排時每欄僅約 120px，逐欄各掛一句排不下。
          ⚠️ **`actionsTaken` 也算留空**：`ai/schemas.ts` 用 `filter` 濾掉白名單外的值，
             因此「模型挑不到」與「客服真的沒採取任何行動」都會得到空陣列，
             在資料上**不可區分**；而後者在結案流程裡幾乎不存在（都結案了總做了什麼）。
             既然分不出來就一律提醒，代價只是偶爾多一句提示 —— 反過來漏提醒的代價是
             一筆行動欄空白的紀錄直接進了正式報表，而寫入本身不會擋（`enumOrEmpty` 允許空）。
        -->
        <p
          v-if="!draft.category || !draft.resolution || !draft.sentimentOutcome || !draft.actionsTaken.length"
          class="flex items-start gap-[5px] text-[0.8125rem] leading-relaxed"
          :style="{ color: 'var(--open)' }"
        >
          <UIcon name="i-lucide-info" class="mt-[3px] size-3 shrink-0" />
          {{ $t('closure.fields.chooseHint') }}
        </p>

        <!--
          ⚠️⚠️ **chip 上顯示的 MUST 是 `title`（清理過的檔名），MUST NOT 是 `id`。**
               知識庫沒有正式的 SOP 編號制度，檔案 id 對客服不對應任何外部識別
               —— 002 research #2「二次訂正」逐字撤銷過「用檔案 id 當顯示編號」這個做法，
               `shared/types/knowledge.ts` 的 `KnowledgeHit.id` 也註明「MUST NOT 顯示於 UI」。
               這一欄在 2026-09-08 之前渲染的正是 `id`：客服看到 `knowledge-fallback-1a2b3c`
               這種字串，等於要他認得檔案 id 才能判斷該不該刪掉這筆來源。
          ⚠️ `:key` 用 id 而非 title —— 兩份不同文件清理後可能同名（版本後綴被去掉了）。
             來源清單本身已在 server 端依 id 去重（`cited-sops.ts`）。
        -->
        <div class="flex flex-col gap-[5px]">
          <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
            {{ $t('closure.fields.citedSops') }}
          </span>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="sop in draft.citedSops"
              :key="sop.id"
              class="ac-mono flex h-[26px] min-w-0 max-w-full items-center gap-1.5 rounded-[7px] py-0 pl-[9px] pr-1.5 text-[0.8438rem]"
              :style="{
                background: 'var(--navy-soft)',
                border: '1px solid var(--navy-soft-bd)',
                color: 'var(--navy-2)',
              }"
            >
              <span class="min-w-0 truncate">{{ sop.title }}</span>
              <button
                type="button"
                class="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors hover:bg-[var(--navy-soft-bd)]"
                :aria-label="$t('closure.fields.sopRemove')"
                :title="$t('closure.fields.sopRemove')"
                @click="removeSop(sop.id)"
              >
                <UIcon name="i-lucide-x" class="size-3" />
              </button>
            </span>
            <!--
              ⚠️ **刪光之後這一欄不消失**（2026-09-08 照畫布改；先前是整塊 `v-if` 隱藏）。
                 整欄消失會讓客服以為自己弄壞了什麼，而且看不出「這次寫入不帶來源」
                 是他自己造成的 —— 那正是他下一步要確認的事。
            -->
            <span
              v-if="!draft.citedSops.length"
              class="text-[0.8438rem]"
              :style="{ color: 'var(--text-3)' }"
            >
              {{ $t('closure.fields.sopsAllRemoved') }}
            </span>
          </div>
        </div>

        <div class="flex flex-col gap-[5px]">
          <span class="text-[0.8438rem]" :style="{ color: 'var(--text-2)' }">
            {{ $t('closure.fields.followUps') }}
          </span>
          <!--
            ⚠️ **每列兩行，不是三欄並排**（2026-09-08 照畫布改）——
               面板寬 420px 時三欄並排每欄只剩約 120px，「負責人」與時間都塞不下。
               第一行是整列寬的「待辦事項」，第二行才是負責人／時間／移除。
            ⚠️ 空白的「要做什麼」會讓寫入被 server 擋下（見 script 區的
               `invalidFollowUpRows`）。錯誤 MUST 標在客服打字的那一格上，
               且說明 MUST 就地放在**該列下方** —— 只把寫入鍵停用、或把說明統一放在
               整組之後，客服都得自己一列一列找是哪一列空著。
          -->
          <div
            v-for="(f, i) in draft.followUps"
            :key="i"
            class="flex flex-col gap-[3px] pb-0.5"
          >
            <div class="flex flex-col gap-1.5">
              <input
                class="ac-field h-[34px] px-[11px]"
                :style="invalidFollowUpRows.has(i) ? { borderColor: 'var(--danger)' } : undefined"
                :value="f.action"
                :placeholder="$t('closure.fields.followUpAction')"
                :aria-invalid="invalidFollowUpRows.has(i)"
                @input="patchFollowUp(i, { action: ($event.target as HTMLInputElement).value })"
              >
              <div class="flex items-center gap-1.5">
                <input
                  class="ac-field h-[34px] min-w-0 flex-1 px-[11px]"
                  :value="f.owner ?? ''"
                  :placeholder="$t('closure.fields.followUpOwner')"
                  @input="patchFollowUp(i, { owner: ($event.target as HTMLInputElement).value })"
                >
                <input
                  class="ac-field h-[34px] min-w-0 flex-1 px-[11px]"
                  :value="f.dueHint ?? ''"
                  :placeholder="$t('closure.fields.followUpDueHint')"
                  @input="patchFollowUp(i, { dueHint: ($event.target as HTMLInputElement).value })"
                >
                <!-- 畫布逐字：30×30、無框透明底、radius 7px、`--text-3`；hover 轉 `--surface-3` 底 ＋ `--text` 字 -->
                <button
                  type="button"
                  class="flex size-[30px] shrink-0 items-center justify-center rounded-[7px] border-none bg-transparent transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
                  :style="{ color: 'var(--text-3)' }"
                  :aria-label="$t('closure.fields.followUpRemove')"
                  @click="removeFollowUp(i)"
                >
                  <UIcon name="i-lucide-x" class="size-3.5" />
                </button>
              </div>
            </div>
            <p
              v-if="invalidFollowUpRows.has(i)"
              class="text-[0.8125rem] leading-relaxed"
              :style="{ color: 'var(--danger)' }"
            >
              {{ $t('closure.fields.followUpActionRequired') }}
            </p>
          </div>
          <!--
            ⚠️ **虛線框是這顆鈕的語意，不只是裝飾**（畫布 §7.2 ⑥ 逐字）——
               它與上方那幾列實線框的輸入框放在一起，虛線是「這裡還沒有東西、按了才會長出來」
               的既有視覺語彙（同 `ClosureScopePicker` 未選中的安全網列）。
               用 `variant="ghost"` 的話它就只是一段可以點的文字，跟旁邊的欄位失去關係。
          -->
          <button
            type="button"
            class="flex h-[28px] cursor-pointer items-center gap-[5px] self-start rounded-[7px] border border-dashed border-[var(--border-strong)] bg-transparent pl-1.5 pr-2.5 text-[0.875rem] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            :style="{ color: 'var(--text-2)' }"
            @click="addFollowUp"
          >
            <UIcon name="i-lucide-plus" class="size-[13px] shrink-0" />
            {{ $t('closure.fields.followUpAdd') }}
          </button>
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
              <dd class="ac-mono truncate" :title="readonlyFields.operators.join('、')">{{ readonlyFields.operatorLabels.join('、') }}</dd>
            </div>
            <div class="contents">
              <dt>{{ $t('closure.fields.joinedAt') }}</dt>
              <dd class="ac-mono truncate" :title="readonlyFields.joinedAt">{{ joinedAtLabel }}</dd>
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
              <span v-else :style="{ color: 'var(--text-3)' }" :title="readonlyFields.sentimentNote ?? undefined">{{ sentimentNoteLabel }}</span>
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

        <!--
          ⑧-b 次要文字鈕列（畫布 `hasFailSecond` 分支）——**只有 B7 有**。
          B8 的出路是「人工查驗後重試」，多給兩個出口只會讓人繞過那個查驗。

          ⚠️ **兩顆的內容不同，不可互相取代**：
             - 「複製摘要文字」複製的是**草稿內文**，供客服照 `failFallback` 那句話
               貼到 CRM 手動建檔 —— 目的地是他自己的剪貼簿，不外流。
             - 「回報 IT」複製的是 `failMeta` ＋ `draftId` ＋ `conversationId`，
               **刻意不含草稿內文**（憲法 1.5）—— IT 拿 `reqId` 就能串起三步寫入。
          ⚠️ 2026-09-08 之前這一列只有「回報 IT」，而且做成按鈕列裡的 outline 按鈕：
             錯誤區塊逐字要客服「複製摘要並貼到 CRM 手動建檔」，畫面上卻沒有那顆鈕。
        -->
        <div v-if="showFailure && failKind === 'failed'" class="flex items-center gap-[7px]">
          <button type="button" :class="LINK_BTN" :style="{ color: 'var(--navy-2)' }" @click="copySummaryText">
            {{ $t('closure.buttons.copySummary') }}
          </button>
          <span class="text-[0.8438rem]" :style="{ color: 'var(--border-strong)' }">·</span>
          <button type="button" :class="LINK_BTN" :style="{ color: 'var(--navy-2)' }" @click="reportToIt">
            {{ $t('closure.buttons.reportIt') }}
          </button>
        </div>

        <p class="text-[0.8125rem] leading-relaxed" :style="{ color: 'var(--text-3)' }">
          {{ $t('closure.writeWarning') }}
        </p>
      </template>
    </div>
  </CopilotBlockShell>
</template>
