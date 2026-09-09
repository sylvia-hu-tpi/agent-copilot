/**
 * 健康檢查 —— docs/ARCHITECTURE.md §17。
 *
 * 不需登入、不碰 iMBrace：Dockerfile 的 HEALTHCHECK 與 compose 的 depends_on 都打這裡，
 * 它回答的是「process 起來了」，不是「平台連得上」。
 * `revision` 來自 image 建置時的 GIT_SHA（Dockerfile 的 APP_REVISION），
 * 換版後用它確認現在跑的是哪一版（§18 M3.5：image 以不可變 tag 指定）；本機 dev 為 null。
 */

export default defineEventHandler(() => ({
  ok: true,
  app: useRuntimeConfig().public.appName,
  revision: process.env.APP_REVISION || null,
  at: new Date().toISOString(),
}))
