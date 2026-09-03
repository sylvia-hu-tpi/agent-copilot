/**
 * Nuxt 設定 —— 對應 docs/ARCHITECTURE.md §6。
 *
 * 與文件 §6 的三處差異（實作時確認，文件待同步）：
 *
 *  1. `@nuxt/icon` 與 `@nuxtjs/color-mode` 已由 `@nuxt/ui@4` 內建並自動註冊，
 *     重複列在 modules 會產生「module already registered」警告 → 此處移除。
 *
 *  2. `runtimeConfig` 的秘密欄位預設值一律留空字串。若在此填入實際值，
 *     它們會被烘進 `.output`（憲法 1.1 / §16.2 的精神不只是「不進 public」，
 *     而是「不進建置產物」）。實際值一律由執行環境的 `NUXT_*` 環境變數注入。
 *
 *  3. `.env.local` 以 `IMBRACE_*` 命名（spike 腳本共用同一份），
 *     此處橋接成 Nuxt 的 `NUXT_*` 慣例，避免同一組憑證要維護兩套鍵名。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ── .env 橋接（僅 dev / build 時執行；正式環境直接給 NUXT_* 即可）─────────
for (const f of ['.env.local', '.env']) {
  const p = resolve(process.cwd(), f)
  if (existsSync(p)) {
    process.loadEnvFile(p)
    break
  }
}

const ENV_BRIDGE: Record<string, string> = {
  NUXT_IMBRACE_API_KEY: 'IMBRACE_API_KEY',
  NUXT_IMBRACE_ORGANIZATION_ID: 'IMBRACE_ORGANIZATION_ID',
  NUXT_IMBRACE_BASE_URL: 'IMBRACE_BASE_URL',
  NUXT_SESSION_SECRET: 'SESSION_SECRET',
  NUXT_WEBHOOK_SECRET: 'WEBHOOK_SECRET',
  NUXT_AI_API_KEY: 'AI_API_KEY',
  NUXT_REDIS_URL: 'REDIS_URL',
  NUXT_PUBLIC_IMBRACE_ENV: 'IMBRACE_ENV',
  // specs/001-sentiment-panel 換上 ImbraceAgentProvider（見 server/services/ai/）——
  // 兩個 agent 是使用者在 iMBrace 後台手動建立的，assistant_id 因環境而異，不可寫死進程式碼
  NUXT_IMBRACE_SUMMARY_AGENT_ID: 'IMBRACE_SUMMARY_AGENT_ID',
  NUXT_IMBRACE_SENTIMENT_AGENT_ID: 'IMBRACE_SENTIMENT_AGENT_ID',
  // specs/002-suggestion-knowledge-search 新增：知識庫檢索／建議卡生成 agent
  NUXT_IMBRACE_KNOWLEDGE_AGENT_ID: 'IMBRACE_KNOWLEDGE_AGENT_ID',
  NUXT_IMBRACE_SUGGESTION_AGENT_ID: 'IMBRACE_SUGGESTION_AGENT_ID',
}
for (const [nuxtKey, plainKey] of Object.entries(ENV_BRIDGE)) {
  const plain = process.env[plainKey]
  if (!process.env[nuxtKey] && plain) process.env[nuxtKey] = plain
}

export default defineNuxtConfig({
  compatibilityDate: '2026-08-24',

  // SPA 模式，但保留完整 Nitro server。
  // ⚠️ 這不等於靜態網站：以 `nuxt build` + `node .output/server/index.mjs` 啟動，
  //    server/api/** 完全正常運作。得到的是「SPA 前端 + 完整 Node BFF」。
  ssr: false,

  nitro: {
    preset: 'node-server',
  },

  modules: [
    '@nuxt/ui',
    '@nuxtjs/i18n',
    '@pinia/nuxt',
    '@vueuse/nuxt',
  ],

  css: ['~/assets/css/main.css'],

  i18n: {
    defaultLocale: 'zh-TW',
    locales: [{ code: 'zh-TW', file: 'zh-TW.json' }],
    strategy: 'no_prefix',
  },

  runtimeConfig: {
    // ⚠️ 憲法 1.1：以下僅存在於 server，絕不可移入 public
    imbraceApiKey: '',
    imbraceOrganizationId: '',
    imbraceBaseUrl: '',
    sessionSecret: '',
    webhookSecret: '',
    aiApiKey: '',
    redisUrl: '',
    imbraceSummaryAgentId: '',
    imbraceSentimentAgentId: '',

    public: {
      appName: 'AgentCopilot',
      imbraceEnv: 'stable',
    },
  },

  // §6 寫的是 typeCheck: true，此處必須關掉 —— 但保證沒有放鬆：
  // `npm run build` 已改成先跑 `npm run typecheck` 再 `nuxt build`。
  //
  // ⚠️ 為何不能用 typeCheck: true / 'build'：本專案路徑含空白
  //    （…/03 FE products/…），Nuxt 內部以未加引號的方式把專案路徑傳給 vue-tsc，
  //    會裂成三段並報 TS5083 Cannot read file 'C:/Sylvia/03/tsconfig.json'。
  //    `nuxt typecheck` 這條路徑沒有這個問題，故走 script 串接。
  typescript: { strict: true, typeCheck: false },

  devtools: { enabled: true },
})
