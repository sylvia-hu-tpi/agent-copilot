/**
 * 防腐層：iMBrace SDK 形狀 → AgentCopilot 領域型別。
 *
 * 這個檔案是 M1 的正式程式碼。所有「SDK 給的東西跟我們要的東西不一樣」的
 * 醜陋處都集中在這裡，上層（SessionManager、AI pipeline、UI）永遠只看到
 * 乾淨的領域型別。
 *
 * ── 2026-08-25：依 stable 環境的真實資料重寫 ───────────────────
 * 初版是依 SDK 型別定義推測的，實測後有兩處關鍵錯誤，已修正：
 *
 *  1. ❌ 舊版假設 `from` 是不透明字串，只能比對 contact_id / users[] 反推。
 *     ✅ 實測：`from` 帶「型別前綴」——con_ / u_ / pub_。
 *        且反推法會出錯：實測對話的 users[] 是空的，但訊息中有兩個 u_ 客服，
 *        舊版會把他們全部誤判為 AI，撞單防護直接失效。
 *
 *  2. ❌ 舊版假設附件在 `content.url`，靠副檔名嗅探判斷種類。
 *     ✅ 實測：附件 content 是 `{ name, media_id }` —— 沒有 url。
 *        種類只能從檔名副檔名推測，且取檔案需另外解析 media_id。
 */

import type {
  ConversationMessage,
  Conversation as SdkConversation,
} from '@imbrace/sdk'
import type {
  Attachment,
  Conversation,
  Message,
  SenderType,
} from '../../shared/types/conversation.js'

// ─────────────────────────────────────────────────────────────
// Sender 判別 —— H-3
// ─────────────────────────────────────────────────────────────

/**
 * `from` 的前綴 → 發送者類型。
 *
 * 實測值域（stable 環境，2026-08-25）：
 *   con_…  客戶（contact）
 *   u_…    真人客服（user）
 *   pub_…  推測為 AI workflow —— ⚠️ 尚未由 iMBrace 確認，見 IMBRACE_QUESTIONS H-3b
 *
 * ⚠️ 未知前綴一律歸為 'unknown'，**不可**預設為 'ai'。
 * 撞單防護寧可漏判也不能誤判：把同事誤判成 AI 會讓客服收到假警報，
 * 而假警報比沒有警報更糟 —— 客服學會忽略提示後，真正的撞單也會被略過。
 */
const SENDER_PREFIX: ReadonlyArray<readonly [string, SenderType]> = [
  ['con_', 'customer'],
  ['u_', 'agent'],
  ['pub_', 'ai'],
]

export interface SenderResolution {
  type: SenderType
  id?: string
  name?: string
}

/** 僅依前綴判別，不需要任何對話上下文 */
export function senderTypeOf(from: string): SenderType {
  if (!from) return 'unknown'
  for (const [prefix, type] of SENDER_PREFIX) {
    if (from.startsWith(prefix)) return type
  }
  return 'unknown'
}

/**
 * 建立 sender 判別器。
 *
 * 前綴決定「類型」，對話上下文只用來補上「姓名」——
 * 反過來（用上下文決定類型）就是初版犯的錯。
 *
 * @param onUnresolved 遇到未知前綴時呼叫，供 spike 蒐集值域證據
 */
export function createSenderResolver(
  conv?: Pick<SdkConversation, 'contact_id' | 'users'>,
  onUnresolved?: (from: string) => void,
) {
  const nameById = new Map(
    (conv?.users ?? []).map(u => [u.id, u.display_name] as const),
  )

  return function resolveSender(from: string): SenderResolution {
    const type = senderTypeOf(from)
    if (type === 'unknown') onUnresolved?.(from)

    return {
      type,
      id: from || undefined,
      // users[] 可能不含已離開對話的客服，取不到姓名是正常情況
      name: nameById.get(from),
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 附件 —— H-2
// ─────────────────────────────────────────────────────────────

const EXT_KIND: ReadonlyArray<readonly [RegExp, Attachment['kind']]> = [
  [/\.(mp3|m4a|aac|ogg|opus|wav|amr|caf)$/i, 'audio'],
  [/\.(jpe?g|png|gif|webp|heic|bmp)$/i, 'image'],
  [/\.(mp4|mov|webm|avi|mkv)$/i, 'video'],
]

/**
 * SDK 的 MessageType 是 text|image|quick_reply|file|pdf —— 沒有 audio。
 * 實測資料中語音與圖片都可能落在 'file'，因此需再看檔名副檔名。
 */
export function detectAttachmentKind(
  type: string,
  filename?: string,
): Attachment['kind'] | null {
  if (type === 'text' || type === 'quick_reply') return null
  if (type === 'image') return 'image'
  if (type === 'pdf') return 'file'

  const name = filename ?? ''
  for (const [re, kind] of EXT_KIND) {
    if (re.test(name)) return kind
  }
  return 'file'
}

/**
 * 實測的附件 content 形狀：`{ name, media_id }`。
 * SDK 的 MessageContent 型別未宣告 media_id，故此處自行擴充。
 */
interface AttachmentContent {
  name?: string
  media_id?: string
  text?: string
  caption?: string
  title?: string
  url?: string
}

// ─────────────────────────────────────────────────────────────
// 主 mapper
// ─────────────────────────────────────────────────────────────

export function toMessage(
  raw: ConversationMessage,
  resolveSender: (from: string) => SenderResolution,
): Message {
  const c = (raw.content ?? {}) as AttachmentContent
  const filename = c.name ?? c.title ?? ''
  const kind = detectAttachmentKind(raw.type, filename)

  const attachments: Attachment[] | undefined = kind
    ? [{
        id: c.media_id ?? raw.id,
        kind,
        filename: filename || raw.id,
        // ⚠️ 實測 content 沒有 url，只有 media_id —— 取檔需另外解析。
        url: c.url,
        // ⚠️ 平台未提供轉錄或圖片描述。caption 是使用者附註，不是 AI 產生的
        //    描述，兩者不可混用（見 IMBRACE_QUESTIONS H-2c）。
        transcriptSource: 'none',
      }]
    : undefined

  // 統一的可分析文字。附件訊息在平台未文字化的情況下會是空字串 ——
  // 這正是 M2 是否需自建 STT / vision 的判斷依據。
  const text = c.text ?? c.caption ?? ''

  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    at: raw.created_at,
    sender: resolveSender(raw.from),
    text,
    attachments,
  }
}

export function toConversation(raw: SdkConversation): Conversation {
  return {
    id: raw.id,
    channel: raw.channel_type,
    contactId: raw.contact_id,
    status: raw.status,
    name: raw.name,
    operators: (raw.users ?? []).map(u => ({
      id: u.id,
      name: u.display_name,
    })),
    updatedAt: raw.timestamp,
  }
}

/**
 * 比對兩次快照的 operators，推斷 JOIN / LEAVE。
 * PollingEventSource 的核心邏輯（§8.1）。
 *
 * ⚠️ 實測發現 users[] 可能為空，即使對話中確實有客服發過言 ——
 * 這代表 users[] 反映的是「目前在對話中的人」而非「曾經參與的人」。
 * 對 JOIN/LEAVE 推斷而言這是正確語意，但不可拿來判斷歷史訊息的發送者。
 */
export function diffOperators(
  prev: Conversation | undefined,
  next: Conversation,
): Array<{ type: 'join' | 'leave'; operator: { id: string; name: string } }> {
  if (!prev) return []
  const prevIds = new Set(prev.operators.map(o => o.id))
  const nextIds = new Set(next.operators.map(o => o.id))

  return [
    ...next.operators
      .filter(o => !prevIds.has(o.id))
      .map(o => ({ type: 'join' as const, operator: o })),
    ...prev.operators
      .filter(o => !nextIds.has(o.id))
      .map(o => ({ type: 'leave' as const, operator: o })),
  ]
}

/**
 * 解開 SDK 的分頁回應。
 *
 * ⚠️ 為何需要這個：SDK 的型別標成 `PagedResponse<T>`，但實測回傳的容器鍵不一致
 * （`data` / `items` / `results` / `hits` 都出現過），也有直接回陣列的情況。
 * 型別靠不住，只能在執行期逐一探。這正是防腐層該吸收的髒東西。
 */
export function unwrapPaged<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  const r = res as Record<string, unknown> | null | undefined
  for (const key of ['data', 'items', 'results', 'hits']) {
    if (Array.isArray(r?.[key])) return r[key] as T[]
  }
  return []
}
