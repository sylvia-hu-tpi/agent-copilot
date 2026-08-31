<script setup lang="ts">
/**
 * 工作區外框 —— docs/ARCHITECTURE.md §14.1、畫布 §8.1 的 48px 全寬頂列。
 *
 * ⚠️ `min-h-0` 這一串不是裝飾。三欄工作區的訊息流要在自己的容器內捲動，
 *    少了它 flex 子項的預設 `min-height: auto` 會讓內容把整頁撐高，
 *    虛擬滾動就完全失效（畫面看起來正常，但每則訊息都被渲染了）。
 *
 * ⚠️ **頂列右上角刻意只放頭像，沒有姓名也沒有 email 文字**（2026-08-31 使用者裁示）。
 *    起因是平台在我們探測過的兩個來源裡都沒有人名（登入回應沒有 `display_name`；
 *    團隊名冊 `users[]` 的 `display_name` 實測 12/12 全是 email，見 §7.2b 與 H-9）——
 *    畫布畫的是「(林) 林佩君」，而我們只有一串 email。把 email 攤在頂列上
 *    既佔寬度、又讓「身分」看起來像一個沒設定好的欄位，因此收進頭像的下拉裡。
 *
 * ⚠️ **頭像沒有 chevron。** 前一版有（那時旁邊還有姓名文字，需要一個明確的下拉指示），
 *    現在整顆頭像本身就是唯一的按鈕，再掛一個箭頭只是噪音。
 *    可發現性改由 `title`（hover 顯示 email）與 `aria-haspopup` 承擔。
 *
 * ⚠️ **不要在這裡自作聰明地從 email 裁出一個假名字**（§7.2b 三條原則之一）。
 *    頭像縮寫取前兩碼是**視覺錨點**，不是姓名宣稱 —— 那是被允許的；
 *    「agent.lin@… → 林」那種推導不是。
 */

const auth = useAuthStore()
const stream = useStreamStore()

async function logout() {
  stream.disconnect()
  await auth.logout()
  await navigateTo('/login')
}

/**
 * 切換組織（U-3）—— 退回 pending_org 再導向選組織頁。
 *
 * ⚠️ MUST 先 `stream.disconnect()`：session 一旦退回 pending_org，那條 SSE 的
 *    憑證就不再有效，留著只會讓前端一直重連並吃到 401。與 `logout()` 同樣的理由。
 */
const switching = ref(false)

async function switchOrganization() {
  if (switching.value) return
  switching.value = true
  try {
    stream.disconnect()
    await auth.reselectOrganization()
    await navigateTo('/organization')
  }
  finally {
    switching.value = false
  }
}

/**
 * 連線狀態 pill（畫布 §8.1，2026-08-31 裁示 F-21a：**常駐**）。
 *
 * ⚠️ 常駐的理由不是畫布有畫，是**「畫面上沒有東西」有兩種解讀** ——
 *    一切正常，或這顆狀態元件本身卡住了。常駐的綠燈把「正常」變成一個明確的斷言，
 *    而先前「只在異常時出現」的做法把兩者混成同一個畫面。
 * ⚠️ 文案是「已連線」，**不是畫布的「已連線 · 即時同步」**（使用者裁示：後者過長）。
 *    畫布的 1d 本來也只寫「已連線」，統一取短的那個。
 */
const connection = computed(() => {
  switch (stream.status) {
    case 'reconnecting':
      return { key: 'stream.reconnecting', tone: 'warn' as const, spin: true }
    case 'connecting':
      return { key: 'stream.connecting', tone: 'muted' as const, spin: true }
    default:
      return { key: 'stream.connected', tone: 'ok' as const, spin: false }
  }
})

const connectionStyle = computed(() => {
  if (connection.value.tone === 'warn') {
    return { background: 'var(--warn-bg)', borderColor: 'var(--warn-bd)', color: 'var(--warn)' }
  }
  return { background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-2)' }
})

/**
 * 帳號選單 —— 由上到下：身分（姓名／email）、分隔線、「登出」。
 *
 * ⚠️ 切換組織**不在這裡**：畫布把 chevron 掛在組織名上，那顆 chevron 本來就是為了
 *    切換組織而設計的。把它搬進頭像選單等於把「我在哪個組織」與「我是誰」混成一件事。
 * ⚠️ 身分那一列**不是 menuitem**（不可點、不進 Tab 順序），因此 `role="menu"`
 *    只包住下面真正可操作的項目 —— 把純資訊列標成 menuitem 會讓螢幕閱讀器
 *    報出一個按了沒反應的選項。
 */
const accountMenuOpen = ref(false)
const accountMenu = ref<HTMLElement | null>(null)

onClickOutside(accountMenu, () => { accountMenuOpen.value = false })

/**
 * 頭像縮寫與 hover 提示的來源。
 *
 * ⚠️ `operatorName` 目前**多半就等於 email**（§7.2b）。因此選單裡只在兩者**不同**時
 *    才多印一行姓名 —— 相同時印兩次同一串字，看起來像畫面壞了。
 *    H-9 若回覆「平台有人名」，這裡不必改：多出來的姓名會自動出現。
 */
const identity = computed(() => {
  const email = auth.me?.email ?? ''
  const name = auth.me?.operatorName ?? ''
  return { email, name: name && name !== email ? name : null, label: name || email }
})
</script>

<template>
  <div class="flex h-dvh flex-col overflow-hidden">
    <header
      class="flex h-12 shrink-0 items-center gap-3 border-b px-3.5"
      :style="{ borderColor: 'var(--border)', background: 'var(--surface)' }"
    >
      <NuxtLink to="/" class="ac-eyebrow shrink-0 transition-opacity hover:opacity-80">AGENTCOPILOT</NuxtLink>

      <!--
        ⚠️ **不是 NuxtLink**：直接連到 /organization 會停在一個永遠不會長出清單的畫面 ——
           換組織要先把 session 退回 pending_org（見 server/api/auth/reselect-organization.post.ts）。
        ⚠️ 只有一個組織時不給切換入口，但**名稱仍要顯示**（那是「我在哪個組織」的指示）。
      -->
      <div
        v-if="auth.me?.orgName"
        class="flex min-w-0 items-center gap-1.5 border-l pl-3"
        :style="{ borderColor: 'var(--border)', color: 'var(--text-2)' }"
      >
        <UIcon name="i-lucide-building-2" class="size-3.5 shrink-0" aria-hidden="true" />
        <button
          v-if="auth.organizations.length > 1"
          type="button"
          class="flex min-w-0 items-center gap-1 truncate text-[0.9375rem] transition-opacity hover:opacity-70 disabled:opacity-50"
          :title="$t('organization.switch')"
          :disabled="switching"
          @click="switchOrganization"
        >
          <span class="truncate">{{ auth.me.orgName }}</span>
          <UIcon
            :name="switching ? 'i-lucide-loader-circle' : 'i-lucide-chevron-down'"
            class="size-3 shrink-0"
            :class="{ 'animate-spin': switching }"
          />
        </button>
        <span v-else class="min-w-0 truncate text-[0.9375rem]">{{ auth.me.orgName }}</span>
      </div>

      <div class="ml-auto flex items-center gap-2.5">
        <!-- 連線狀態：常駐（F-21a）。異常時整顆換成橘色，不是只換文字 -->
        <span
          class="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.84375rem]"
          :style="connectionStyle"
          aria-live="polite"
        >
          <UIcon
            v-if="connection.spin"
            name="i-lucide-loader-circle"
            class="size-3 shrink-0 animate-spin"
            aria-hidden="true"
          />
          <span
            v-else
            class="size-1.5 shrink-0 rounded-full"
            :style="{ background: 'var(--active)' }"
            aria-hidden="true"
          />
          {{ $t(connection.key) }}
        </span>

        <div ref="accountMenu" class="relative border-l pl-2.5" :style="{ borderColor: 'var(--border)' }">
          <!--
            ⚠️ 整顆按鈕**只有頭像**（26px，畫布 §8.1 的尺寸）。`p-0.5` 是為了把可點區域
               撐到 30px —— 26px 對觸控與精細度較差的滑鼠操作偏小，但頭像本身照畫布不放大。
            ⚠️ `title` 帶 email：頂列不再有身分文字，hover 是「不用點開就確認我是誰」的唯一途徑。
          -->
          <button
            type="button"
            class="flex rounded-full p-0.5 transition-opacity hover:opacity-70"
            :aria-label="$t('auth.accountMenu')"
            :aria-haspopup="true"
            :aria-expanded="accountMenuOpen"
            :title="identity.label"
            @click="accountMenuOpen = !accountMenuOpen"
          >
            <!--
              與側欄列項、中欄標題列共用 `app/utils/conversation-display.ts` 的縮寫規則 ——
              三處各算一份就會長不一樣，而那不會有型別錯誤。
            -->
            <span
              class="flex size-[26px] shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-bold"
              :style="{
                background: 'var(--navy-soft)',
                borderColor: 'var(--navy-soft-bd)',
                color: 'var(--navy-2)',
              }"
              aria-hidden="true"
            >{{ avatarLabel(identity.label) }}</span>
          </button>

          <div
            v-if="accountMenuOpen"
            class="ac-card absolute right-0 top-10 z-30 w-max min-w-52 max-w-72 p-1"
          >
            <!--
              身分列：純資訊，刻意不是 menuitem、不可點（見 script 的說明）。
              ⚠️ email 用等寬字並允許換行 —— 它是要**逐字核對**的東西（是不是我的帳號），
                 截斷成「agent.lin@compa…」正好蓋掉最能區分帳號的網域部分。
            -->
            <div class="px-2 py-1.5">
              <p v-if="identity.name" class="truncate text-[0.9375rem]" :style="{ color: 'var(--text)' }">
                {{ identity.name }}
              </p>
              <p class="ac-mono break-all text-[0.84375rem]" :style="{ color: 'var(--text-3)' }">
                {{ identity.email }}
              </p>
            </div>

            <div class="my-1 h-px" :style="{ background: 'var(--border)' }" aria-hidden="true" />

            <div role="menu">
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.9375rem] transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                :style="{ color: 'var(--text-2)' }"
                @click="logout"
              >
                <UIcon name="i-lucide-log-out" class="size-3.5 shrink-0" />
                {{ $t('auth.logout') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <main class="min-h-0 flex-1">
      <slot />
    </main>
  </div>
</template>
