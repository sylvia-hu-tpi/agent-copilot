/** 健康檢查 —— docs/ARCHITECTURE.md §17 */

export default defineEventHandler(() => ({
  ok: true,
  app: useRuntimeConfig().public.appName,
  at: new Date().toISOString(),
}))
