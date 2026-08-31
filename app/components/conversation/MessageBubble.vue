<script setup lang="ts">
/**
 * 單一訊息 —— docs/ARCHITECTURE.md §11.4 / §14.1.2、畫布 §8.3。
 *
 * ⚠️ **發送者一律以 `sender.type` 標示，不可用時間分段推斷。**
 *    JOIN 之後 AI 仍持續運作（§10.5），所以「JOIN 之前是 AI、之後是真人」
 *    這個直覺是錯的 —— 該時點之後依然是混合狀態。
 *
 * ⚠️ `unknown` 型別必須誠實顯示為「未知來源」，不可預設歸給 AI。
 *    把同事誤判成 AI 會讓撞單防護失效（見 mappers.senderTypeOf）。
 *
 * ⚠️ **泡泡四角一律 `9px`（2026-08-31 畫布撤掉了「尖角」）。**
 *    先前三種發送者各有一個直角（客戶左下／AI 左上／真人客服右下），畫布這一版把六處
 *    ——連同 1d 的骨架泡泡——全部改成均勻的 `9px`。**不要**照舊版「訂正」回去。
 *
 *    ⚠️ 這等於**移掉了一個區分維度**，所以要確認剩下的仍然夠：
 *      · 客戶 vs 其餘：**左右對齊**不同，且只有客戶那側有頭像。
 *      · AI vs 真人客服（兩者都靠右、只差底色）：AI 另有 **3px `--ai` 左側色條**，
 *        以及泡泡上方的「AI 自動回覆」**文字徽章**；真人客服上方是姓名 ＋「真人客服 · 你」。
 *    憲法 8.1「資訊不可只靠顏色傳達」因此仍然成立 —— 但現在是靠**文字標籤**滿足的，
 *    幾何已經不再幫忙。動到那些標籤前請先回來讀這一段。
 *
 * ⚠️ **只有客戶那一側有頭像**（畫布 §8.3：26px 圓、`flex` 列、`gap:8px`）。
 *    AI／真人客服靠右且已各有徽章與姓名，再放頭像只會把泡泡往中間擠。
 *    縮寫走 `avatarLabel()`，與側欄列項、中欄標題列**同一個算法** ——
 *    同一個對話在三處縮寫不一樣會讓客服以為點錯對話，而那不會有型別錯誤。
 *
 * ⚠️ **但配色刻意不用 `avatarColor()`，改用畫布的中性色**
 *    （`--surface-3` 底 ＋ `--border` 框 ＋ `--text-2` 字）。這是本檔與另外兩處的**唯一**差異：
 *    `AVATAR_PALETTE` 裡有一組是 `--ai-bg`／`--ai`，而在**訊息流這個畫面裡 `--ai` 是語意色**
 *    ——它的意思是「這則是 AI 發的」。用它去畫客戶頭像，等於在同一個畫面上讓同一個顏色
 *    講兩件相反的事（憲法 8.1）。而且這不是理論風險：畫布自己的示範代號 `TWN#GW4772`
 *    雜湊後正好落在那一組，客戶頭像會直接變成紫色。
 *    側欄與標題列沒有這個問題（那兩處沒有「AI 發的」這個並存語意），故維持 `avatarColor()`。
 *
 * ⚠️ 客戶泡泡**只有均勻的 1px 外框，沒有左側色條**。左側 3px 色條是
 *    **AI 專屬**的標記（畫布逐字），拿來給客戶用等於把兩種發送者畫成同一類。
 */

import type { Message } from '#shared/types/conversation'
import { isWorkflowInternalMessage } from '#shared/types/conversation'

const props = defineProps<{
  message: Message
  mine: boolean
  /** 客戶代號（`TWN#GW4772`）—— 訊息 payload 沒有，由對話詳情帶下來 */
  customerLabel?: string
  /** 這一則是不是撞單攔截的來源（畫布 §8.3 的橘色「N 秒前送出」＋外框） */
  collisionSource?: boolean
}>()

/**
 * AI workflow 的內部訊息（`{"route":"T1"}` 這類）—— 客戶收不到。
 *
 * ⚠️ **降級顯示而不是隱藏。** 客服會同時開 iMBrace 官方介面對照，
 *    我方少顯示東西會讓他以為系統漏了訊息。灰底 + 明確標示，兩邊對得起來。
 */
const isInternal = computed(() => isWorkflowInternalMessage(props.message))

const { t } = useI18n()

/** 客戶靠左、客服／AI 靠右 —— 與一般客服介面的方向慣例一致 */
const alignRight = computed(() => props.message.sender.type !== 'customer')

const senderType = computed(() => props.message.sender.type)

/** 客戶：優先用對話詳情帶來的代號；沒有才退回訊息自帶的名字／id */
const customerName = computed(() =>
  props.customerLabel || props.message.sender.name || props.message.sender.id || t('sender.customer'),
)

const agentName = computed(() => props.message.sender.name || t('sender.agent'))

/**
 * ⚠️ **AI 泡泡不淡化，四項全部用原色 token**（`--ai-bg`／`--ai-bd`／`--ai`／`--text`）。
 *
 *    畫布 2026-08-31 起已移除整顆的 `opacity:.82`，文字色也由 `--text-2` 改為 `--text`。
 *    在那之前實作用的是「逐項混色」（底色／邊框／色條混到 82%、文字以 `--text` 混到 65%），
 *    那是為了在畫布仍套 `opacity` 時**還能過 WCAG AA** 的補償措施 ——
 *    `--text-2` ＋ `.82` 在淺色主題只有 **3.74:1**，而內文需 ≥ 4.5:1。
 *
 *    畫布自己解決之後，那層補償反而讓我們的對比**比畫布低**（4.76:1 vs 8.25:1），
 *    因此整個移除。⚠️ **不要再把淡化加回來** —— 若日後想表達「AI 的份量較輕」，
 *    手段只能是底色／邊框／色條，**不能碰文字的對比**。
 *
 * ⚠️ 「這則是 AI 發的」由三個東西共同表達，不是只靠淡不淡：泡泡上方的文字徽章、
 *    `--ai-bg`／`--ai-bd` 的紫色系、以及左側 3px 的 `--ai` 色條（憲法 8.1）。
 */

/**
 * 每一種發送者都有自己的色票，且**不只靠顏色**區分 ——
 * 泡泡上方永遠有文字標籤（憲法 8.1 的同一個原則：資訊不可只靠顏色傳達）。
 *
 * ⚠️ 四角一律 `9px`，四種發送者**都一樣** —— 見檔頭關於「尖角已被畫布撤銷」的說明。
 *    因此 `radius` 不再是 `tone` 的一部分，直接寫死在樣板上，避免下次有人以為它該分歧。
 */
const tone = computed(() => {
  switch (senderType.value) {
    case 'customer':
      return { bg: 'var(--surface)', bd: 'var(--border)', fg: 'var(--text)' }
    case 'ai':
      return { bg: 'var(--ai-bg)', bd: 'var(--ai-bd)', fg: 'var(--text)' }
    case 'agent':
      return { bg: 'var(--agent-bg)', bd: 'var(--agent-bd)', fg: 'var(--text)' }
    default:
      return { bg: 'var(--surface-3)', bd: 'var(--border-dash)', fg: 'var(--text-2)' }
  }
})

/** 畫布 §8.3 的訊息時間一律到**秒**——撞單判斷靠的正是秒級先後 */
const time = computed(() => {
  const d = new Date(props.message.at)
  return Number.isNaN(d.getTime())
    ? props.message.at
    : d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
})

/**
 * 撞單來源的「N 秒前送出」（畫布 §8.3）。
 *
 * ⚠️ **必須自己走動。** 側欄的相對時間就是因為「字串不會自己更新、十分鐘後仍寫著
 *    3 分鐘前」而改成絕對時間（F-22b）。這裡之所以還能用相對時間，是因為它
 *    **只在撞單期間存在**（幾十秒）且有計時器推著走 —— 少了計時器就是同一個錯。
 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

watch(() => props.collisionSource, (on) => {
  if (timer) { clearInterval(timer); timer = undefined }
  if (!on) return
  now.value = Date.now()
  timer = setInterval(() => { now.value = Date.now() }, 1_000)
}, { immediate: true })

onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const sentAgo = computed(() => {
  const secs = Math.max(0, Math.round((now.value - new Date(props.message.at).getTime()) / 1000))
  if (!Number.isFinite(secs)) return null
  return secs < 60
    ? t('conversation.sentSecondsAgo', { n: secs })
    : t('conversation.sentMinutesAgo', { n: Math.floor(secs / 60) })
})

/** 附件說明（畫布 2a 區塊④ 逐字，三種型別各有自己的措辭） */
const ATTACHMENT_ICON: Record<string, string> = {
  image: 'i-lucide-image',
  pdf: 'i-lucide-file-text',
  file: 'i-lucide-paperclip',
}
</script>

<template>
  <!--
    畫布 §8.3 的一列訊息＝`flex` 橫列（`gap:8px`／`padding:5px 16px`）：
    客戶那一側先放 26px 頭像再放內容欄，AI／真人客服那一側整列靠右且沒有頭像。
  -->
  <div class="flex gap-2 px-4 py-[5px]" :class="{ 'justify-end': alignRight }">
    <!--
      客戶頭像 —— `mt` 讓它對齊泡泡的第一行（畫布是 `margin-top:14px`，
      我方發送者列字級較大，對應值隨之放大）。
    -->
    <span
      v-if="!alignRight"
      class="ac-mono mt-[17px] flex size-[26px] shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-bold"
      :style="{ background: 'var(--surface-3)', borderColor: 'var(--border)', color: 'var(--text-2)' }"
      aria-hidden="true"
    >{{ avatarLabel(customerName) }}</span>

    <div
      class="flex min-w-0 max-w-[min(62%,44rem)] flex-col gap-[3px]"
      :class="alignRight ? 'items-end' : 'items-start'"
    >
      <!--
        發送者列（畫布 §8.3）：三種發送者各有自己的組合，不是同一個模板換字。
        ⚠️ 高度用 `min-h` 而不是畫布的固定 `height:14px` —— AI 那顆有框有底的徽章
           比純文字高，寫死高度會讓它上下各溢出約 2.5px 而貼到下方的泡泡。
           客戶／真人客服那兩種是純文字，實際高度仍等於這裡的 18px，
           所以頭像的 `mt-[17px]` 對齊不受影響。
      -->
      <div class="flex min-h-[18px] items-center gap-[7px] px-1">
        <template v-if="senderType === 'customer'">
          <span class="ac-mono text-[0.8125rem]" :style="{ color: 'var(--text-2)' }">{{ customerName }}</span>
          <span class="text-[0.78125rem]" :style="{ color: 'var(--text-3)' }">{{ t('sender.customer') }}</span>
        </template>

        <template v-else-if="senderType === 'ai'">
          <span
            class="ac-mono flex items-center gap-1 rounded px-1.5 py-px text-[0.78125rem] font-bold tracking-[.04em]"
            :style="{ color: 'var(--ai)', background: 'var(--ai-bg)', border: '1px solid var(--ai-bd)' }"
          >
            <UIcon name="i-lucide-sparkles" class="size-2.5" />
            {{ t('sender.ai') }}
          </span>
        </template>

        <template v-else-if="senderType === 'agent'">
          <span class="text-[0.8125rem] font-medium" :style="{ color: 'var(--text-2)' }">{{ agentName }}</span>
          <span class="text-[0.78125rem]" :style="{ color: 'var(--text-3)' }">
            {{ mine ? t('sender.agentRoleMine') : t('sender.agentRole') }}
          </span>
        </template>

        <template v-else>
          <span class="text-[0.78125rem]" :style="{ color: 'var(--text-3)' }">{{ t('sender.unknown') }}</span>
        </template>

        <!-- 撞單來源：畫布把時間換成橘色的「N 秒前送出」，讓「就是這一則」一眼可見 -->
        <span
          v-if="collisionSource && sentAgo"
          class="rounded px-1.5 py-px text-[0.78125rem]"
          :style="{ color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)' }"
        >{{ sentAgo }}</span>
        <time v-else class="ac-mono text-[0.78125rem]" :style="{ color: 'var(--text-3)' }">{{ time }}</time>
      </div>

      <div
        class="border px-3 py-2 leading-relaxed"
        :class="isInternal ? 'text-[0.875rem] border-dashed opacity-70' : 'text-[0.96875rem]'"
        :style="isInternal
          ? { background: 'var(--surface-2)', borderColor: 'var(--border-dash)', color: 'var(--text-3)', borderRadius: '9px' }
          : {
            background: tone.bg,
            borderColor: tone.bd,
            color: tone.fg,
            borderRadius: '9px',
            /*
              ⚠️ **條件展開，不可寫成 `borderLeft: cond ? x : undefined`。**
                 那個寫法會讓非 AI 的泡泡長出一條深色左框（2026-08-31 由使用者的截圖抓到）：

                 Vue 的 patchStyle 會**逐一走過物件的每個 key**，值是 undefined 時執行
                 `el.style.borderLeft = ''`。依 CSSOM，把**簡寫屬性**設成空字串等於
                 `removeProperty('border-left')`，而它會連帶移除三個長寫
                 —— 包含上面那行 `borderColor` 才剛寫進去的 `border-left-color`。

                 於是左邊框的顏色掉回層疊：Tailwind 的 `border` 只給了 width 與 style、
                 **沒有給 color**，所以 `border-left-color` 取初始值 `currentColor`，
                 也就是同一個物件裡的 `color: tone.fg`（客戶是 `--text`＝近黑）。
                 結果就是三邊淺灰、左邊一條深色線。

                 ⚠️ 這個錯**沒有型別錯誤、沒有 runtime 警告、測試也測不到**，
                    只有把畫面與設計稿並排看才會發現。同類寫法出現在任何
                    **簡寫屬性**上都會重演（`border`、`background`、`font`、`margin`…）。
                    值可能是「不設定」時，key 就不要出現。
            */
            ...(senderType === 'ai' ? { borderLeft: '3px solid var(--ai)' } : {}),
            ...(collisionSource ? { boxShadow: '0 0 0 3px var(--warn-bg)' } : {}),
          }"
      >
        <p
          v-if="isInternal"
          class="ac-status-label mb-0.5 flex items-center gap-1"
        >
          <UIcon name="i-lucide-code-2" class="size-2.5" />
          {{ t('sender.workflowInternal') }}
        </p>
        <p v-if="message.text" class="whitespace-pre-wrap break-words" :class="{ 'ac-mono': isInternal }">{{ message.text }}</p>

        <!--
          ⚠️ 三種附件的能力邊界完全不同（§11.4），說明文字也各自不同（畫布 2a 區塊④ 逐字）：
             圖片可預覽縮圖／PDF 有 url 可下載但畫面上不預覽／舊型 file 連 url 都沒有。
             併成同一句會讓客服以為 PDF 也拿不到。
        -->
        <ul v-if="message.attachments?.length" class="mt-1.5 space-y-1.5">
          <li v-for="a in message.attachments" :key="a.id">
            <a
              v-if="a.kind === 'image' && a.url"
              :href="a.url"
              target="_blank"
              rel="noopener noreferrer"
              class="block max-w-55 overflow-hidden rounded-md border"
              :style="{ borderColor: 'var(--border-dash)' }"
            >
              <img :src="a.url" :alt="a.filename" class="block max-h-55 w-full object-cover">
            </a>

            <!-- 畫布 §8.3 的附件卡：圖示框 ＋ 檔名／說明 ＋「下載」 -->
            <div
              v-else
              class="flex items-center gap-2.5 rounded-lg border px-2.5 py-2"
              :style="{ background: 'var(--surface)', borderColor: 'var(--border)' }"
            >
              <span
                class="flex h-[34px] w-[30px] shrink-0 items-center justify-center rounded-md border"
                :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text-3)' }"
                aria-hidden="true"
              >
                <UIcon :name="ATTACHMENT_ICON[a.kind] ?? 'i-lucide-paperclip'" class="size-3.5" />
              </span>

              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="ac-mono truncate text-[0.875rem]" :style="{ color: 'var(--text)' }">{{ a.filename }}</span>
                <span class="text-[0.78125rem]" :style="{ color: 'var(--text-3)' }">{{ t(`attachment.desc.${a.kind}`) }}</span>
              </span>

              <a
                v-if="a.url"
                :href="a.url"
                target="_blank"
                rel="noopener noreferrer"
                class="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[0.84375rem] transition-opacity hover:opacity-70"
                :style="{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text)' }"
              >
                <UIcon name="i-lucide-download" class="size-3" />
                {{ t('attachment.download') }}
              </a>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
