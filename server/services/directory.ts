/**
 * 客服姓名查表（organization 層級）。
 *
 * ── 為何這裡可以用 `users[]`，而 presence 不行 ────────────────────
 * §10.2 二次實測的結論是「`Conversation.users[]` 是**團隊名冊**，
 * 不是這個對話的參與者」—— 因此它不能回答「誰在這個對話裡」。
 *
 * 但**團隊名冊正是一份姓名對照表**。`u_xxx → display_name` 這個對應本身是正確的，
 * 錯的只是把「名冊上有這個人」讀成「這個人在這個對話裡」。
 * 本模組只取前者：給一個 `u_` id，回一個可顯示的名字。
 *
 * ⚠️ 這個界線很細，但很重要。判斷準則是：
 *    **只回答「這個 id 叫什麼名字」，永遠不回答「誰在哪裡」。**
 *    若日後有人想在這裡加一支 `whoIsInConversation()`，那就是踩回 §10.2 的坑。
 */

import type { Operator } from '../../shared/types/conversation.js'

const TTL_MS = 30 * 60 * 1000

interface Entry {
  name: string
  expiresAt: number
}

const KEY = Symbol.for('agent-copilot.operator-directory')
type Directory = Map<string, Map<string, Entry>>
type Global = typeof globalThis & { [KEY]?: Directory }

function directory(): Directory {
  const g = globalThis as Global
  if (!g[KEY]) g[KEY] = new Map()
  return g[KEY]
}

function forOrg(orgId: string): Map<string, Entry> {
  const dir = directory()
  let byId = dir.get(orgId)
  if (!byId) {
    byId = new Map()
    dir.set(orgId, byId)
  }
  return byId
}

/** 把一批 operator 記進名冊（通常來自 `conversations.get()` 的 users[]） */
export function rememberOperators(orgId: string, operators: Operator[]): void {
  const byId = forOrg(orgId)
  const expiresAt = Date.now() + TTL_MS
  for (const op of operators) {
    if (op.id && op.name) byId.set(op.id, { name: op.name, expiresAt })
  }
}

/**
 * 查名字。查不到回 `undefined` —— **呼叫端不可自行編一個名字**。
 *
 * UI 對「知道有這個人但不知道名字」與「不知道有人」必須有不同呈現（§10.2）。
 */
export function operatorName(orgId: string, operatorId: string): string | undefined {
  const entry = forOrg(orgId).get(operatorId)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    forOrg(orgId).delete(operatorId)
    return undefined
  }
  return entry.name
}

/** 測試用 */
export function resetDirectory(): void {
  directory().clear()
}
