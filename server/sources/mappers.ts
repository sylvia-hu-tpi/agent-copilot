/**
 * 防腐層：iMBrace SDK 形狀 → AgentCopilot 領域型別。
 *
 * 這個檔案是 spike 的核心產出，也是 M1 的正式程式碼。
 * 所有「SDK 給的東西跟我們要的東西不一樣」的醜陋處都集中在這裡，
 * 上層（SessionManager、AI pipeline、UI）永遠只看到乾淨的領域型別。
 *
 * ── 已知的 SDK 缺口（靜態分析 @imbrace/sdk@1.4.0 得出，待 live 驗證）──
 *  1. ConversationMessage.from 是單一 string，沒有 sender type 判別欄位
 *     → 必須靠 conversation.contact_id / users[] 反推。見 createSenderResolver。
 *  2. MessageType 沒有 'audio'/'voice'，語音可能落在 'file'
 *     → 靠副檔名嗅探。見 detectAttachmentKind。
 *  3. MessageContent 沒有 transcript / description / ocr 欄位
 *     → 平台端很可能未做文字化，transcriptSource 多半會是 'none'。
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
// Sender 判別 —— H-3 的答案就在這裡
// ─────────────────────────────────────────────────────────────

export interface SenderResolution {
  type: SenderType
  id?: string
  name?: string
}

/**
 * 建立一個 sender 判別器。
 *
 * 判別順序：
 *   from === contact_id        → customer
 *   from ∈ conversation.users  → agent（附上 operatorId 與姓名）
 *   其餘                        → ai（推定）或 unknown
 *
 * ⚠️ 最後一段是推定。若 live 資料顯示 `from` 出現無法歸類的值，
 *    onUnresolved 會被呼叫 —— spike 用它來蒐集證據（見 01-sender-type.ts）。
 */
export function createSenderResolver(
  conv: Pick<SdkConversation, 'contact_id' | 'users'>,
  onUnresolved?: (from: string) => void,
) {
  const userById = new Map(
    (conv.users ?? []).map(u => [u.id, u] as const),
  )

  return function resolveSender(from: string): SenderResolution {
    if (from && from === conv.contact_id) {
      return { type: 'customer', id: from }
    }

    const user = userById.get(from)
    if (user) {
      return { type: 'agent', id: user.id, name: user.display_name }
    }

    // 落到這裡的可能是：AI workflow、已離開對話的客服、系統訊息
    onUnresolved?.(from)
    return { type: 'ai', id: from || undefined }
  }
}

// ─────────────────────────────────────────────────────────────
// 附件 —— H-2 的答案就在這裡
// ─────────────────────────────────────────────────────────────

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|amr|caf)(\?|$)/i
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|bmp)(\?|$)/i
const VIDEO_EXT = /\.(mp4|mov|webm|avi|mkv)(\?|$)/i

/**
 * SDK 的 MessageType 只有 text|image|quick_reply|file|pdf —— 沒有 audio。
 * 語音訊息若存在，最可能偽裝成 'file'，因此需嗅探副檔名。
 */
export function detectAttachmentKind(
  type: string,
  url?: string,
): Attachment['kind'] | null {
  if (type === 'image') return 'image'
  if (type === 'pdf') return 'file'
  if (type === 'text' || type === 'quick_reply') return null

  const u = url ?? ''
  if (AUDIO_EXT.test(u)) return 'audio'
  if (IMAGE_EXT.test(u)) return 'image'
  if (VIDEO_EXT.test(u)) return 'video'
  return 'file'
}

function filenameFromUrl(url?: string): string {
  if (!url) return ''
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    return url.split('/').pop() ?? ''
  }
}

// ─────────────────────────────────────────────────────────────
// 主 mapper
// ─────────────────────────────────────────────────────────────

export function toMessage(
  raw: ConversationMessage,
  resolveSender: (from: string) => SenderResolution,
): Message {
  const c = raw.content ?? {}
  const kind = detectAttachmentKind(raw.type, c.url)

  const attachments: Attachment[] | undefined = kind
    ? [{
        id: raw.id,
        kind,
        filename: c.title || filenameFromUrl(c.url) || raw.id,
        url: c.url,
        // ⚠️ SDK 的 MessageContent 沒有 transcript 欄位。
        //    caption 是使用者附的說明文字，不是 AI 產生的描述 —— 不可混用。
        transcriptSource: 'none',
      }]
    : undefined

  // 統一的可分析文字。附件訊息在平台未文字化的情況下，
  // text 會是空字串或僅有 caption —— 這正是 M2 是否需自建 STT/vision 的判斷依據。
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
 * PollingEventSource 的核心邏輯（§8.1），M1 直接沿用。
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
