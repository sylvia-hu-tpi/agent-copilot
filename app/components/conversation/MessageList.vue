<script setup lang="ts">
/**
 * 訊息流 —— 憲法 8.3：**不得一次渲染全部訊息節點**（歷史可經 skip 分頁無限回補）。
 * 現行實作為虛擬滾動；要換掉它，得先證明數千則訊息下捲動仍順暢。
 *
 * 理由不是理論上的：實測單一對話最多 398 則訊息（§9.3），
 * 全部直接渲染會在切換對話時明顯卡頓，而客服一天要切換數十次。
 *
 * ── 兩個虛擬滾動特有的坑 ─────────────────────────────────────────
 * ⚠️ ① **不能無條件捲到底。** 客服正在往上翻閱歷史時，新訊息進來若把畫面
 *    拉回底部，他會失去閱讀位置 —— 而且往往正在核對客戶稍早說過的話。
 *    因此只在「原本就貼在底部」時才自動跟隨。
 *
 * ⚠️ ② **高度必須「量」，不能只「估」。** `useVirtualList` 要知道每項多高，
 *    而訊息長度差異極大、換行又取決於可拖曳的欄寬 —— 估算不可能準。
 *    **估偏高或偏低都會壞**（底部一大段空白／永遠捲不到底），沒有安全的偏誤方向。
 *    因此渲染後量實際 `offsetHeight` 回饋給 `itemHeight()`，估算只是還沒渲染過那些列的第一猜。
 *    詳見下方「高度」一節 —— 2026-08-31 兩個方向各踩過一次。
 */

import type { Message } from '#shared/types/conversation'

const props = defineProps<{
  messages: Message[]
  myOperatorId?: string
  /** 客戶代號（`TWN#GW4772`）—— 訊息本身沒有這個欄位，由對話詳情帶下來（畫布 §8.3） */
  customerLabel?: string
  /** 撞單來源訊息的 id 集合（畫布 §8.3）。`unverified` 時為空集合 */
  collisionMessageIds?: Set<string>
  loadingMore?: boolean
  hasMore?: boolean
}>()

const emit = defineEmits<{ loadOlder: [] }>()

const { t } = useI18n()

/**
 * ── 高度：**量測為主，估算只是還沒渲染過那些列的第一猜** ──────────
 *
 * ⚠️ **估算偏高或偏低都會壞，只是壞法不同**（2026-08-31 兩次都踩到）：
 *
 *   · **低估** → 實際內容溢出 wrapper，容器的 `scrollHeight` 永遠比 wrapper 宣告的高度大，
 *     每往下捲一點就渲染出更多內容、`scrollHeight` 又長高 ⇒ **永遠捲不到底**。
 *   · **高估** → wrapper 宣告的高度比實際內容大 ⇒ **底部留下一大段空白**
 *     （空白約等於「每列高估的量 × 列數」，300 則時是幾百 px）。
 *
 * ⚠️ 因此「寧可高估」是錯的 —— 沒有安全的偏誤方向，唯一的解是**量到真的高度**。
 *    文字換行取決於欄寬（而欄寬現在可拖曳）、字型、內容，不可能靠常數算準。
 *
 * ── 作法 ────────────────────────────────────────────────────────
 * `useVirtualList` 的 `totalHeight`／`offsetTop` 都是 `computed`，只要 `itemHeight()`
 * 讀取**響應式**資料，它們就會自己重算（`useWatchForSizes` 還會順帶重算可視範圍）。
 * 所以：渲染後量每一列的 `offsetHeight` 存進 `measured`，`itemHeight()` 優先讀它。
 * 沒渲染過的列仍用估算 —— 那只影響捲軸長度，不影響視窗內的正確性，
 * 而捲到哪裡、哪裡就被量準。
 *
 * ⚠️ **欄寬改變時 MUST 清掉 `measured`**：文字會重新斷行，舊的高度全部作廢。
 */

/** 泡泡的基礎高度（發送者列 + 一行文字 + 間距），單位 px */
const BASE_HEIGHT = 60
/** 日期分隔列（pill + 上下 padding）的高度，單位 px */
const DATE_SEPARATOR_HEIGHT = 32
/** 每行約可容納的字元數（中欄寬度可拖曳，本來就只能取一個中間值） */
const CHARS_PER_LINE = 34
const LINE_HEIGHT = 25
/** 附件卡：30×34 圖示框 + `py-2` + 邊框 + 項目間距（見 MessageBubble.vue） */
const ATTACHMENT_HEIGHT = 58
/** 圖片縮圖的高度上限（見 MessageBubble.vue 的 `max-h-55` = 220px）+ 邊框與間距 */
const IMAGE_ATTACHMENT_HEIGHT = 230

/**
 * 量到的實際列高（key 為 messageId）。
 *
 * ⚠️ **必須是響應式的**（`shallowRef` + 換新 Map），否則 `useVirtualList` 的
 *    `totalHeight`／`offsetTop` 這兩個 computed 追蹤不到，量了也不會反映到版面上。
 */
const measured = shallowRef(new Map<string, number>())

/**
 * 日期分隔（畫布 §8.3：「08/25（今天）」）。
 *
 * ⚠️ **畫布是 `position:sticky` 的，這裡刻意不做 sticky。**
 *    虛擬滾動的可視項目包在一層 `transform: translateY()` 的 wrapper 裡，
 *    而 sticky 的定位基準是最近的 transform 祖先，不是捲動容器 ——
 *    加上 sticky 只會讓它黏在 wrapper 上、隨著 wrapper 一起被推走，
 *    看起來像「日期標籤自己在飄」。要做真 sticky 得先拆掉虛擬滾動（憲法 8.3 不允許）。
 */
function dayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (diff <= 0) return t('conversation.dateToday', { date: md })
  if (diff === 1) return t('conversation.dateYesterday', { date: md })
  return md
}

/** index → 該則訊息之上要不要插日期分隔（第一則一定要，之後只在跨日時） */
const separatorAt = computed(() => {
  const out = new Map<number, string>()
  let prev = ''
  props.messages.forEach((m, i) => {
    const key = dayKey(m.at)
    if (key && key !== prev) out.set(i, dateLabel(m.at))
    prev = key
  })
  return out
})

/**
 * index → 這一則是否與**上一則**屬同一位發送者的連續訊息（畫布 1c 的分組）。
 *
 * 為 true 時 `MessageBubble` 不重畫發送者列、時間改放泡泡下方、上下間距縮小。
 *
 * ⚠️ **判定要同時看 `type` 與 `id`。** 只看 `type === 'agent'` 會把兩位不同同事的
 *    連續發言併成一組，第二位的 email 就此消失 —— 而「是誰說的」正是撞單防護與
 *    presence 最不能出錯的地方（§10.2）。`ai`／`customer` 沒有 `id` 之分，只比 type。
 * ⚠️ **跨日分隔線之後一律不分組。** 那條線之下是新的一天，接著又不畫發送者列的話，
 *    看起來像分隔線把同一組硬切成兩半。
 * ⚠️ 刻意**不加時間間隔條件**（例如「五分鐘內才算同一組」）：我方的訊息時間來自平台，
 *    而 §9.3 已知同一批訊息的時間戳可能相同或極接近，用時間當條件會產生不穩定的分組。
 */
const groupedAt = computed(() => {
  const out = new Set<number>()
  props.messages.forEach((m, i) => {
    if (i === 0 || separatorAt.value.has(i)) return
    const prev = props.messages[i - 1]
    if (!prev) return
    if (prev.sender.type !== m.sender.type) return
    if (m.sender.type === 'agent' && prev.sender.id !== m.sender.id) return
    out.add(i)
  })
  return out
})

function estimateHeight(m: Message, index: number): number {
  const lines = Math.max(1, Math.ceil((m.text?.length ?? 0) / CHARS_PER_LINE))
  const explicitBreaks = (m.text?.match(/\n/g)?.length ?? 0)
  const attachmentsHeight = (m.attachments ?? []).reduce(
    (sum, a) => sum + (a.kind === 'image' && a.url ? IMAGE_ATTACHMENT_HEIGHT : ATTACHMENT_HEIGHT),
    0,
  )
  return BASE_HEIGHT
    + (lines - 1 + explicitBreaks) * LINE_HEIGHT
    + attachmentsHeight
    + (separatorAt.value.has(index) ? DATE_SEPARATOR_HEIGHT : 0)
}

const source = computed(() => props.messages)

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(source, {
  itemHeight: (index: number) => {
    const m = source.value[index]
    if (!m) return BASE_HEIGHT
    // ⚠️ 量過的一律以量到的為準；估算只服務「還沒渲染過」的列
    return measured.value.get(m.id) ?? estimateHeight(m, index)
  },
  overscan: 8,
})

/** 距離底部多少 px 以內算「貼在底部」—— 留一點餘裕，不必剛好到 0 */
const STICK_THRESHOLD = 80
const stickToBottom = ref(true)

/** 捲動容器本身 —— `containerProps.ref` 綁的就是那個 DOM 元素 */
const containerEl = containerProps.ref

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

/**
 * 真正捲到底 —— **不能只靠 `scrollTo(lastIndex)`**。
 *
 * ⚠️ `scrollTo()` 捲到的是「估算」出來的位移。估算與實際只要有落差（見上方高度估算的說明），
 *    它就會停在離真正的底部還有一段的地方，畫面上看起來就是「按了沒反應」。
 *    因此最後一定要以**當下真實的 `scrollHeight`** 收尾。
 *
 * ⚠️ 要推**多次**：捲過去之後虛擬清單才會渲染出那一段的實際內容，`scrollHeight` 這時才定案；
 *    只推一次會停在「用舊的 scrollHeight 算出來的底部」。三次足以收斂，收斂了就提早跳出。
 */
async function settleToBottom(): Promise<void> {
  if (props.messages.length === 0) return
  scrollTo(props.messages.length - 1)

  for (let i = 0; i < 3; i++) {
    await nextTick()
    await nextFrame()
    const el = containerEl.value
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    if (el.scrollTop >= max - 1) break
    el.scrollTop = max
  }
  stickToBottom.value = true
}

function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD

  // 捲到最上面時回補更早的歷史
  if (el.scrollTop < 40 && props.hasMore && !props.loadingMore) emit('loadOlder')
}

watch(
  () => props.messages.length,
  async (next, prev) => {
    if (next === 0) return
    // ⚠️ 只在原本就貼底時才跟隨，否則會打斷正在翻閱歷史的客服
    if (!stickToBottom.value && prev !== 0) return
    await nextTick()
    await settleToBottom()
  },
  { immediate: true },
)

/** 手動回到底部 —— 沒有貼底時才顯示按鈕 */
async function jumpToBottom(): Promise<void> {
  await settleToBottom()
}

// ── 實際高度量測 ────────────────────────────────────────────────────

/** 目前渲染出來的列（key 為 messageId），由 template 的函式 ref 維護 */
const rowEls = new Map<string, HTMLElement>()

function setRow(id: string, el: unknown): void {
  if (el instanceof HTMLElement) rowEls.set(id, el)
  else rowEls.delete(id)
}

/**
 * 量目前渲染出來的每一列，回報有沒有任何一列的高度變了。
 *
 * ⚠️ 用 **1px 的門檻**：次像素捨入會讓 `offsetHeight` 在同一份 DOM 上微幅跳動，
 *    沒有門檻的話「量測 → 高度變 → 重算 → 再量測」會停不下來。
 */
function measureRows(): boolean {
  const current = measured.value

  // ⚠️ 先偵測、後複製。這個函式在捲動時每一幀都會跑，而 Map 可能有數百筆 ——
  //    無條件 `new Map(...)` 等於每一幀複製整份，而多數幀根本沒有任何高度變化。
  let pending: Array<[string, number]> | null = null
  for (const [id, el] of rowEls) {
    const h = el.offsetHeight
    if (h <= 0) continue
    const prev = current.get(id)
    if (prev !== undefined && Math.abs(prev - h) <= 1) continue
    ;(pending ??= []).push([id, h])
  }
  if (!pending) return false

  const next = new Map(current)
  for (const [id, h] of pending) next.set(id, h)
  measured.value = next
  return true
}

/**
 * ⚠️ 量完之後若還「貼在底部」，要再收一次尾 —— 高度被修正的那一刻內容會位移，
 *    不補這一下就會停在離底部一小段的地方，而那正是「按鈕不消失」的症狀。
 *    `settling` 是防重入，不是防迴圈：量測本身會收斂（同一份 DOM 量到同一個值）。
 */
let settling = false

watch(list, async () => {
  await nextTick()
  const changed = measureRows()
  if (!changed || !stickToBottom.value || settling) return
  settling = true
  try {
    await settleToBottom()
  }
  finally {
    settling = false
  }
}, { flush: 'post' })

/**
 * ⚠️ 欄寬一變，文字重新斷行，**所有量到的高度立刻作廢** ——
 *    左右兩欄都可以拖曳（畫布 §8.1），這不是罕見情況。
 *    不清掉的話會退化成「用舊欄寬的高度排新欄寬的版面」，兩種壞法都會回來。
 */
let lastWidth = 0
useResizeObserver(containerEl, (entries) => {
  const w = entries[0]?.contentRect.width ?? 0
  if (w <= 0 || Math.abs(w - lastWidth) <= 1) return
  lastWidth = w
  if (measured.value.size > 0) measured.value = new Map()
})

/** 換一個對話：上一個對話的量測結果留著只是佔記憶體，不會被用到 */
watch(() => props.messages[0]?.conversationId, () => {
  rowEls.clear()
  if (measured.value.size > 0) measured.value = new Map()
})
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <div v-bind="containerProps" class="h-full overflow-y-auto" @scroll="onScroll">
      <div v-bind="wrapperProps">
        <!--
          畫布 §8.3 頂端：圓角 pill ＋ 上箭頭。
          ⚠️ 畫布寫的是「載入較早的 **305** 則訊息」，我方沒有那個數字（只有 hasMore），
             因此不帶數量。編一個數字比不講更糟。
        -->
        <div v-if="hasMore || loadingMore" class="flex justify-center py-2">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.875rem] transition-opacity hover:opacity-70 disabled:opacity-50"
            :style="{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-2)' }"
            :disabled="loadingMore"
            @click="emit('loadOlder')"
          >
            <UIcon
              :name="loadingMore ? 'i-lucide-loader-circle' : 'i-lucide-arrow-up'"
              class="size-3"
              :class="{ 'animate-spin': loadingMore }"
            />
            {{ loadingMore ? $t('common.loading') : $t('common.loadMore') }}
          </button>
        </div>

        <!--
          ⚠️ 每一列包一層 `<div>` 是為了**量得到高度**（見 script 的高度量測一節）——
             `itemHeight()` 算的是「日期分隔 + 泡泡」的總和，量測的單位必須與它一致。
        -->
        <div
          v-for="item in list"
          :key="item.data.id"
          :ref="el => setRow(item.data.id, el)"
        >
          <!--
            ⚠️ `sticky`（畫布 1c）—— 往回捲讀舊訊息時，日期會停在頂端，
               不必往上找才知道自己讀到哪一天。z-1 讓它蓋在泡泡之上而不是被蓋住。
          -->
          <div v-if="separatorAt.get(item.index)" class="sticky top-0 z-[1] flex justify-center py-1">
            <span
              class="ac-mono rounded-full border px-2.5 py-0.5 text-[0.8125rem]"
              :style="{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-2)' }"
            >{{ separatorAt.get(item.index) }}</span>
          </div>

          <ConversationMessageBubble
            :message="item.data"
            :mine="!!myOperatorId && item.data.sender.id === myOperatorId"
            :customer-label="customerLabel"
            :collision-source="!!collisionMessageIds?.has(item.data.id)"
            :grouped="groupedAt.has(item.index)"
          />
        </div>
      </div>
    </div>

    <Transition name="fade">
      <button
        v-if="!stickToBottom && messages.length > 0"
        type="button"
        class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.875rem] shadow-sm"
        :style="{ background: 'var(--surface)', borderColor: 'var(--border-strong)', color: 'var(--text-2)' }"
        @click="jumpToBottom"
      >
        <UIcon name="i-lucide-arrow-down" class="size-3.5" />
        {{ $t('conversation.jumpToLatest') }}
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity .15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active {
    transition: none;
  }
}
</style>
