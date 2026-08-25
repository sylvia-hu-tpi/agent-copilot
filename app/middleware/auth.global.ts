/**
 * 全域路由守衛 —— docs/ARCHITECTURE.md §7.2 / §5.1 ①
 *
 * 三條規則：
 *  1. 未登入 → /login，並把原本要去的路徑存進 ?redirect（token 過期後能回到原處）
 *  2. 已驗 OTP 但未選組織 → /organization
 *     ⚠️ 這條是「重新整理 organization.vue 不會被踢回輸 email」的實作點
 *  3. 已選組織卻停在登入流程頁 → 導回 redirect 或首頁
 */

const PUBLIC_ROUTES = new Set(['/login'])
const LOGIN_FLOW_ROUTES = new Set(['/login', '/organization'])

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()
  const me = await auth.ensure()

  if (!me) {
    if (PUBLIC_ROUTES.has(to.path)) return
    return navigateTo({
      path: '/login',
      // fullPath 而非 path —— §7.2 要求保留 conversationId 等查詢參數
      query: to.fullPath === '/' ? undefined : { redirect: to.fullPath },
    })
  }

  if (me.stage === 'pending_org') {
    return to.path === '/organization'
      ? undefined
      : navigateTo({ path: '/organization', query: to.query })
  }

  if (LOGIN_FLOW_ROUTES.has(to.path)) {
    const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/'
    return navigateTo(redirect)
  }
})
