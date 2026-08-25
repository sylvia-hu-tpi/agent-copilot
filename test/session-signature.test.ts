/**
 * Session cookie 簽章 —— docs/ARCHITECTURE.md §7.2
 *
 * 簽章失效的後果不是「登不進去」而是「任何人都能偽造 session id」，
 * 因此竄改路徑必須逐一驗證，不能只測 happy path。
 */

import { describe, expect, it } from 'vitest'
import { signSessionId, unsignSessionId } from '../server/utils/session-signature.js'

const SECRET = 'test-secret-do-not-use-in-production'

describe('signSessionId / unsignSessionId', () => {
  it('簽出來的值可以驗回原本的 id', () => {
    const signed = signSessionId('abc123', SECRET)
    expect(unsignSessionId(signed, SECRET)).toBe('abc123')
  })

  it('cookie 值本身不得等於 session id —— 否則等於沒簽', () => {
    expect(signSessionId('abc123', SECRET)).not.toBe('abc123')
  })

  it('竄改 id 會被擋下', () => {
    const signed = signSessionId('abc123', SECRET)
    const tampered = signed.replace('abc123', 'abc124')
    expect(unsignSessionId(tampered, SECRET)).toBeNull()
  })

  it('竄改簽章會被擋下', () => {
    const signed = signSessionId('abc123', SECRET)
    expect(unsignSessionId(`${signed}x`, SECRET)).toBeNull()
  })

  it('換一把 secret 驗不過 —— 這是多副本 secret 不一致時的症狀來源', () => {
    const signed = signSessionId('abc123', SECRET)
    expect(unsignSessionId(signed, 'another-secret')).toBeNull()
  })

  it('沒有簽章分隔符、空值、undefined 都回 null 而不是丟例外', () => {
    expect(unsignSessionId('abc123', SECRET)).toBeNull()
    expect(unsignSessionId('.sig', SECRET)).toBeNull()
    expect(unsignSessionId('', SECRET)).toBeNull()
    expect(unsignSessionId(undefined, SECRET)).toBeNull()
  })

  it('id 本身含有點號時仍可正確還原（取最後一個點作分隔）', () => {
    const signed = signSessionId('a.b.c', SECRET)
    expect(unsignSessionId(signed, SECRET)).toBe('a.b.c')
  })
})
