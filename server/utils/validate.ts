/**
 * 請求驗證 —— docs/ARCHITECTURE.md §15.1「最高原則」。
 *
 * ⚠️ 為何需要這層：直接寫 `Schema.parse(await readBody(event))` 時，
 *    ZodError 會以「未處理例外」的形式冒出去，Nitro 回的是 **500**。
 *    使用者打錯 email 格式卻收到「伺服器錯誤」，是把自己的 bug 賴給對方。
 *    這裡統一轉成 400 並帶上第一則可讀訊息。
 *
 * ⚠️ 用 `message` 而非 `statusMessage`：h3 已警告 statusMessage 未來會被消毒，
 *    較長的訊息應放在 message。
 */

import type { H3Event } from 'h3'
import type { ZodError, ZodTypeAny, z } from 'zod'

/** 取第一則問題，並補上欄位名 —— 使用者要的是「哪裡錯」，不是整包 issues */
function firstIssue(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return '請求格式不正確'
  const field = issue.path.join('.')
  return field ? `${field}：${issue.message}` : issue.message
}

/**
 * ⚠️ 泛型綁在 schema 本身（`S extends ZodTypeAny` + `z.infer<S>`）而非結果型別。
 *    若寫成 `ZodSchema<T>`，帶 `.default()` 的欄位會被推成輸入型別（可為 undefined），
 *    呼叫端就得對一個其實永遠有值的欄位做多餘的空值處理。
 *
 * @param opts.data 附加到 400 錯誤的 `data` 欄位。
 *   ⚠️ 加這個參數是為了讓 `closure/commit.post.ts` 也能走這裡 ——
 *      它的每一則錯誤都必須帶 `reqId`／`failKind`（FR-035a、契約 R3.14）。
 *      沒有它的話那支端點只能自己再抄一份 safeParse，而抄出來的那份
 *      **沒有欄位名**：客服看到的是籠統的「格式不正確」，重試永遠一樣失敗，
 *      畫面上沒有任何地方指出是哪一欄。2026-09-08 審查就是這樣抓到的。
 */
export async function readBodyAs<S extends ZodTypeAny>(
  event: H3Event,
  schema: S,
  opts: { data?: unknown } = {},
): Promise<z.infer<S>> {
  const result = schema.safeParse(await readBody(event))
  if (!result.success) {
    throw createError({
      statusCode: 400,
      message: firstIssue(result.error),
      ...(opts.data === undefined ? {} : { data: opts.data }),
    })
  }
  return result.data
}

export function getQueryAs<S extends ZodTypeAny>(event: H3Event, schema: S): z.infer<S> {
  const result = schema.safeParse(getQuery(event))
  if (!result.success) {
    throw createError({ statusCode: 400, message: firstIssue(result.error) })
  }
  return result.data
}
