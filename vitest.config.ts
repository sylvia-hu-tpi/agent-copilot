import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    /**
     * `#shared/*` 是 Nuxt 的別名（`shared/` 目錄）。`tsconfig.scripts.json` 的 `paths` 已對應它，
     * 但那只影響 tsc；vitest 要能**執行**到 `app/` 底下以值匯入 `#shared` 的模組
     * （例如 `app/stores/stream.ts` 的 `CONNECTION_HEARTBEAT_MS`），需要 resolver 層也認得。
     * ⚠️ 少了這條，型別匯入照樣過（執行期被抹除），值匯入才會 `Cannot find module` ——
     *    是「typecheck 綠、測試紅」這種難看的不一致；反過來把常數抄進 app/ 又會讓兩份數字各自漂移。
     */
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
