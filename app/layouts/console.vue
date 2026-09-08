<script setup lang="ts">
/**
 * 工作區外框 —— docs/ARCHITECTURE.md §14.1、畫布 §8.1 的 48px 全寬頂列。
 *
 * ⚠️ `min-h-0` 這一串不是裝飾。三欄工作區的訊息流要在自己的容器內捲動，
 *    少了它 flex 子項的預設 `min-height: auto` 會讓內容把整頁撐高，
 *    虛擬滾動就完全失效（畫面看起來正常，但每則訊息都被渲染了）。
 *
 * ⚠️ **頂列右上角的「身分」這一格刻意只放頭像，沒有姓名也沒有 email 文字**（2026-08-31 使用者裁示）。
 *    ⚠️ 講的是身分那一格，**不是整個右上角** —— 頭像左側的分隔線外還有一顆
 *    淺／深色主題切換鈕（畫布 2026-09-08 17:03 版新增，`DESIGN_TOKENS.md` §8.1）。
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
 * ⚠️ 文案是「已連線」。曾經偏離畫布的「已連線 · 即時同步」（使用者裁示：後者過長），
 *    但 **2026-09-08 17:03 版畫布全檔只剩「已連線」**（1c 與 1d 皆是），已不再是偏離。
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
 * 淺／深色主題切換（畫布 2026-09-08 17:03 版新增，`DESIGN_TOKENS.md` §8.1）。
 *
 * ⚠️ **在這顆鈕之前，`main.css` 的整組 `.dark` token 是死碼** —— 深色畫得很完整，
 *    但產品裡沒有任何地方加得上那個 class。這種缺陷不會報錯、不會有型別錯誤，
 *    只會讓「深色已經做好了」這個印象一直成立。
 *
 * ⚠️ **寫 `preference` 不是 `value`。** `colorMode.value` 只改當下畫面，
 *    重新整理就回到 `preference`；只有 `preference` 會進 localStorage。
 *    兩者型別相同、都不會報錯 —— 寫錯的唯一症狀是「重新整理後主題自己跳回去」。
 *
 * ⚠️ **icon 畫的是「按下去會變成什麼」，不是「現在是什麼」**：淺色時顯示月亮。
 *    反過來做同樣不會報錯，只會讓每個使用者按錯一次。
 *
 * ⚠️ path 是**畫布逐字給的**，不是 lucide 的 `moon`／`sun`（兩者的 `d` 不同）。
 *    因此這裡用 inline `<svg>` 而不是 `UIcon` —— 換成 lucide 會靜默偏離畫布。
 */
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const THEME_ICON = {
  /** 月亮：目前淺色，按了變深色 */
  toDark: 'M20.5 14.8A8.5 8.5 0 1 1 9.2 3.5a6.8 6.8 0 0 0 11.3 11.3z',
  /** 太陽：目前深色，按了變淺色 */
  toLight: 'M12 3v1.5M12 19.5V21M4.2 4.2l1.1 1.1M18.7 18.7l1.1 1.1M3 12h1.5M19.5 12H21M4.2 19.8l1.1-1.1M18.7 5.3l1.1-1.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
} as const

const themeIconPath = computed(() => (isDark.value ? THEME_ICON.toLight : THEME_ICON.toDark))

function toggleTheme() {
  colorMode.preference = isDark.value ? 'light' : 'dark'
}

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

      <!--
        ⚠️ `gap-3`（12px）是頂列的統一間距，與左半的 badge／組織名同一個值 ——
           整條頂列只有一處例外，就是下面頭像那一組的 `-ml-0.5`（見該處說明）。
      -->
      <div class="ml-auto flex items-center gap-3">
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

        <!--
          主題切換鈕（畫布 §8.1）。
          ⚠️ **位置在連線 pill 之後、頭像那條 `border-l` 之前** —— 它不屬於身分那一組。
             主題是畫面偏好，不是身分，那條分隔線兩邊刻意是兩件事。
          ⚠️ `rounded-[7px]` 的方角圓，**不是頭像那種正圓**：旁邊就是 `rounded-full` 的頭像，
             兩顆都做成正圓，右上角會看起來像兩個帳號。
          ⚠️ 底色與字色寫在 `<style>` 裡而不是 `:style` ＋ `hover:` utility ——
             inline style 會蓋過 hover class，hover 那半永遠不會生效（而且不會報錯）。
             同 `Sidebar.vue` 的 `.ac-group-toggle`。
        -->
        <button
          type="button"
          class="ac-theme-toggle flex size-7 shrink-0 items-center justify-center rounded-[7px] border"
          :style="{ borderColor: 'var(--border)' }"
          :title="$t(isDark ? 'theme.toLight' : 'theme.toDark')"
          :aria-label="$t(isDark ? 'theme.toLight' : 'theme.toDark')"
          :aria-pressed="isDark"
          @click="toggleTheme"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0"
            aria-hidden="true"
          >
            <path :d="themeIconPath" />
          </svg>
        </button>

        <!--
          ⚠️ `-ml-0.5`（-2px）是畫布逐字的做法，**不是隨手微調** ——
             頂列的 `gap` 是 12px，而分隔線兩側要各 10px（2026-09-08 17:03 版畫布定案）。
             負 margin 把左側從 12 拉回 10，`pl-2.5` 給右側 10。
             改成 `gap-2.5` 讓整排都變 10px 看起來一樣，但那會把「連線 pill ↔ 主題鈕」
             也一起縮掉 2px，與畫布不符（`DESIGN_TOKENS.md` §8.1）。
        -->
        <div ref="accountMenu" class="relative -ml-0.5 border-l pl-2.5" :style="{ borderColor: 'var(--border)' }">
          <!--
            ⚠️ 整顆按鈕**只有頭像**（28px，畫布 §8.1 的尺寸）。
               ⚠️ 這裡曾經是 26px、註解卻寫著「畫布 §8.1 的尺寸」—— 那句話從來不成立
               （2026-09-08 核對畫布時發現，同日改為 28px 對齊）。`p-0.5` 是為了把可點區域
               撐到 32px —— 28px 對觸控與精細度較差的滑鼠操作仍偏小，但頭像本身照畫布不放大。
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
              class="ac-mono flex size-7 shrink-0 items-center justify-center rounded-full border text-[0.8125rem] font-bold tracking-[.02em]"
              :style="{
                background: 'var(--navy-soft)',
                borderColor: 'var(--navy-soft-bd)',
                color: 'var(--navy-2)',
              }"
              aria-hidden="true"
            >{{ avatarLabel(identity.label) }}</span>
          </button>

          <!--
            ⚠️ **不沿用 `.ac-card`**（畫布 1c）：卡片的 `--border` ＋ `0 1px 2px` 是「平貼在版面上」
               的東西，而下拉是**浮在版面之上**的。用同一組陰影會讓它看起來像被壓在底下的一塊卡片，
               與後面的內容分不開。畫布給的是 `--border-strong` ＋ `0 8px 24px`。
          -->
          <div
            v-if="accountMenuOpen"
            class="absolute right-0 top-10 z-30 w-max min-w-52 max-w-72 rounded-[9px] border p-1.5"
            :style="{
              background: 'var(--surface)',
              borderColor: 'var(--border-strong)',
              boxShadow: '0 8px 24px rgba(16, 24, 40, .14)',
            }"
          >
            <!--
              身分列：純資訊，刻意不是 menuitem、不可點（見 script 的說明）。
              ⚠️ email 用等寬字並允許換行 —— 它是要**逐字核對**的東西（是不是我的帳號），
                 截斷成「agent.lin@compa…」正好蓋掉最能區分帳號的網域部分。
            -->
            <div class="flex flex-col gap-[3px] border-b px-2 pb-2 pt-2" :style="{ borderColor: 'var(--border)' }">
              <span class="ac-status-label">{{ $t('account.signedInAs') }}</span>
              <p v-if="identity.name" class="truncate text-[0.9375rem]" :style="{ color: 'var(--text)' }">
                {{ identity.name }}
              </p>
              <!-- ⚠️ 用 `--text` 不是 `--text-3`：這是要逐字核對「是不是我的帳號」的字串 -->
              <p class="ac-mono break-all text-[0.875rem] leading-[1.55]" :style="{ color: 'var(--text)' }">
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

<style scoped>
/*
 * 主題切換鈕 —— 畫布逐字：常態 `--surface-2` 底 ＋ `--text-2` 字，
 * hover 轉 `--surface-3` 底 ＋ `--text` 字（框線不變，因此框留在 `:style` 上）。
 *
 * ⚠️ 寫在 CSS 而不是 `:style` ＋ `hover:` utility：**inline style 會蓋過 hover class**，
 *    顏色用 `:style` 綁上去的話 hover 那半永遠不會生效（而且不會報錯）。
 *    同 `Sidebar.vue` 的 `.ac-group-toggle`。
 */
.ac-theme-toggle {
  background: var(--surface-2);
  color: var(--text-2);
  transition: background-color .12s ease, color .12s ease;
}

.ac-theme-toggle:hover {
  background: var(--surface-3);
  color: var(--text);
}

@media (prefers-reduced-motion: reduce) {
  .ac-theme-toggle {
    transition: none;
  }
}
</style>
