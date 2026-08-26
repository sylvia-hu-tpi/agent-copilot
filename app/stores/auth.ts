/**
 * 登入狀態 —— docs/ARCHITECTURE.md §7。
 *
 * ⚠️ 這個 store 裡永遠不會有 token。瀏覽器只拿得到 httpOnly cookie 與身分資訊，
 *    所有憑證都留在 BFF session（憲法 1.1）。
 */

import { defineStore } from 'pinia'
import type { MeResponse, OrganizationChoice } from '#shared/types/auth'

export const useAuthStore = defineStore('auth', () => {
  const me = ref<MeResponse | null>(null)
  /** 是否已向 /api/auth/me 問過。用來避免每次路由切換都重打 */
  const resolved = ref(false)

  const stage = computed(() => me.value?.stage ?? null)
  const isActive = computed(() => stage.value === 'active')
  const organizations = computed<OrganizationChoice[]>(() => me.value?.organizations ?? [])

  /** 讀取目前狀態。未登入不是錯誤 —— 回 null 讓守衛決定怎麼做 */
  async function refresh(): Promise<MeResponse | null> {
    try {
      me.value = await $fetch<MeResponse>('/api/auth/me')
    }
    catch {
      me.value = null
    }
    resolved.value = true
    return me.value
  }

  /** 確保問過一次；已問過就直接用快取 */
  async function ensure(): Promise<MeResponse | null> {
    if (resolved.value) return me.value
    return refresh()
  }

  async function requestOtp(email: string): Promise<void> {
    await $fetch('/api/auth/otp', { method: 'POST', body: { email } })
  }

  async function verifyOtp(email: string, otp: string): Promise<OrganizationChoice[]> {
    const res = await $fetch<{ organizations: OrganizationChoice[] }>('/api/auth/login', {
      method: 'POST',
      body: { email, otp },
    })
    await refresh()
    return res.organizations
  }

  async function selectOrganization(organizationId: string): Promise<void> {
    await $fetch('/api/auth/organization', {
      method: 'POST',
      body: { organizationId },
    })
    await refresh()
  }

  async function logout(): Promise<void> {
    await $fetch('/api/auth/logout', { method: 'POST' })
    me.value = null
    resolved.value = true
  }

  /** 收到 401 時呼叫：把本地狀態歸零，守衛下次會導回登入 */
  function invalidate(): void {
    me.value = null
    resolved.value = true
  }

  return {
    me, resolved, stage, isActive, organizations,
    refresh, ensure, requestOtp, verifyOtp, selectOrganization, logout, invalidate,
  }
})
