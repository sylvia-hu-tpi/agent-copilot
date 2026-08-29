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
 *   pub_…  推測為 AI workflow —— ⚠️ 尚未由 iMBrace 確認，見 IMBRACE_QUESTIONS H-3c ③
 *          （原 H-3b「pub_ 是否即代表 AI」已於 2026-08-29 撤回：後續分析顯示 pub_ 是
 *           publisher 實體 id，該問法答不到我們要的東西，改由 H-3c 承接）
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
  [/\.(jpe?g|png|gif|webp|heic|bmp)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
]

/**
 * SDK 的 MessageType 是 text|image|quick_reply|file|pdf。
 * 實測資料中圖片也可能落在 'file'，因此 `file` 需再看檔名副檔名。
 *
 * ⚠️ **`pdf` 不可併入 `file`**（§11.4）。兩者的能力邊界相反：
 * `pdf` 有直接可用的 url、走 vision／文件分析、已納入 MVP；
 * 舊資料型 `file` 只有 `{name, media_id}`、無 url、排除在 MVP 外。
 * 併成同一個值不會有型別錯誤，只會讓 UI 把可分析的 PDF 標成「無法預覽」。
 */
export function detectAttachmentKind(
  type: string,
  filename?: string,
): Attachment['kind'] | null {
  if (type === 'text' || type === 'quick_reply') return null
  if (type === 'image') return 'image'
  if (type === 'pdf') return 'pdf'

  const name = filename ?? ''
  for (const [re, kind] of EXT_KIND) {
    if (re.test(name)) return kind
  }
  return 'file'
}

/**
 * 實測的附件 content 形狀依型別而定（§11.4、§19.1 #11）：
 * `image`／`pdf` 帶直接可用的 `url`；舊資料型 `file` 只有 `{ name, media_id }`。
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
// 識別碼正規化
// ─────────────────────────────────────────────────────────────

/**
 * 對話 id 的正規形式 —— **不帶** `conv_` 前綴。
 *
 * ⚠️ 平台對「一個對話」總共有三種識別碼，這是實測（2026-08-25）確認的：
 *
 *   | 來源 | 欄位 | 範例 | 是什麼 |
 *   |---|---|---|---|
 *   | `conversations.search()` | `id` | `b6f76f09-…` | 對話 id，裸 UUID |
 *   | 訊息 | `conversation_id` | `conv_b6f76f09-…` | 同一個對話，帶前綴 |
 *   | `conversations.get()` | `id` / `_id` | `tcu_6cd3cee1-…` | **不是對話 id** —— 是
 *     team_conversation 這筆關聯記錄自己的 id，與對話 id 毫無關係 |
 *
 *   `get()` 回的物件另有 `conversation_id: conv_<裸 UUID>` 欄位，那才是對話 id。
 *
 * 若不在防腐層統一，`Conversation.id` 與 `Message.conversationId` 會是兩個不同的
 * 字串，所有以對話 id 為鍵的查表（CopilotSession、presence、EventBus topic、
 * 共享訂閱的 refcount）都會靜默失準 —— 症狀是「訊息進來了但面板沒反應」。
 *
 * 取裸 UUID 為正規形式的理由：它是列表／詳情 API 的主鍵，
 * 而訊息查詢端點 `?conversation_id=` 兩種形式都接受（已實測）。
 */
export function normalizeConversationId(id: string): string {
  return id.startsWith('conv_') ? id.slice('conv_'.length) : id
}

/** 兩個對話 id 是否指同一個對話（容忍前綴差異） */
export function sameConversation(a: string, b: string): boolean {
  return normalizeConversationId(a) === normalizeConversationId(b)
}

/**
 * 兩個客服 id 是否為同一人（容忍 `u_` 前綴差異）。
 *
 * ⚠️ 為何不能直接用 `===`：
 * 訊息的 `from` 是 `u_xxx`，而登入回應的 `user_id` 不保證帶前綴 ——
 * 兩者是同一個人卻比不相等。這正是 §10.4 撞單檢查
 * 「必須以 `sender.id !== me.operatorId` 過濾自己」那一行的輸入，
 * **比錯的後果是客服每次送出都看到「你自己剛剛回覆過」的假警報**，
 * 而假警報比沒有警報更糟 —— 客服學會忽略提示後，真正的撞單也會被一併略過。
 */
export function sameOperator(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return stripOperatorPrefix(a) === stripOperatorPrefix(b)
}

function stripOperatorPrefix(id: string): string {
  return id.startsWith('u_') ? id.slice('u_'.length) : id
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
        // ⚠️ `image`／`pdf` 有直接可用的 url；舊資料型 `file` 只有 media_id，
        //    此處會是 undefined —— 取檔需另外解析（§19.1 #11）。
        url: c.url,
        // ⚠️ 平台未提供轉錄或圖片描述（H-2a）。caption 是上傳時系統帶入的
        //    原始檔名，非使用者輸入也非 AI 描述，且客戶上傳時為空（H-2c）——
        //    因此不可拿它當描述來源，vision／文件分析是必要的。
        transcriptSource: 'none',
      }]
    : undefined

  // 統一的可分析文字。平台不做描述／OCR，因此附件訊息在 M1 多半是空字串
  // （客戶上傳時連 caption 都沒有）—— M2 由自建 vision／文件分析補上。
  const text = c.text ?? c.caption ?? ''

  return {
    id: raw.id,
    // ⚠️ 一律正規化 —— 訊息帶 conv_ 前綴，對話物件不帶（見 normalizeConversationId）
    conversationId: normalizeConversationId(raw.conversation_id),
    at: raw.created_at,
    sender: resolveSender(raw.from),
    text,
    attachments,
  }
}

export function toConversation(raw: SdkConversation): Conversation {
  // ⚠️ 必須優先取 conversation_id。
  //    search() 的 id 就是對話 id，但 get() 的 id 是 tcu_ 開頭的關聯記錄 id ——
  //    若直接用 raw.id，同一個對話經由兩支 API 取得會得到兩個不同的鍵，
  //    CopilotSession、presence、EventBus topic 全部對不起來。
  const withConvId = raw as SdkConversation & {
    conversation_id?: string
    mode?: string | null
    /** §9.3.1 第一層輪詢的變動偵測依據。SDK 型別未宣告，實測存在（填充率 83%） */
    last_message_at?: string | null
    updated_at?: string | null
  }
  // `tcu_` 開頭者才是 team_conversation 記錄 id（JOIN/LEAVE/mode 要用）；
  // 清單 payload 的 id 是對話 id，沒有 tcu → 維持 undefined
  const teamConversationId = raw.id?.startsWith('tcu_') ? raw.id : undefined

  return {
    id: normalizeConversationId(withConvId.conversation_id ?? raw.id),
    teamConversationId,
    mode: (withConvId.mode ?? null) as Conversation['mode'],
    channel: raw.channel_type,
    contactId: raw.contact_id,
    status: raw.status,
    name: raw.name,
    // ⚠️ 這是團隊名冊，不是對話參與者（§10.2）。留著只為顯示，不可作為 presence。
    operators: (raw.users ?? []).map(u => ({
      id: u.id,
      name: u.display_name,
    })),
    lastMessageAt: withConvId.last_message_at ?? undefined,
    // ⚠️ 取 updated_at 優先於 timestamp：實測 JOIN／LEAVE／切換 mode 時
    //    只有 updated_at 會跳動，而 §9.3.1 的第一層輪詢正是靠它偵測狀態變動。
    updatedAt: withConvId.updated_at ?? raw.timestamp,
  }
}

/**
 * 比對兩次快照的 operators，推斷 JOIN / LEAVE。
 *
 * ⚠️⚠️ **這個函式目前沒有可用的輸入，不得接上 presence 或 JOIN/LEAVE 偵測。**
 *
 * 2026-08-25 二次實測（§10.2）：`users[]` 不是「這個對話的參與者」，
 * 而是**團隊名冊** —— 兩個不同對話拿到同一批 14 人，含 Bot 與 observer。
 * 拿它做 diff，結果會是「整個團隊同時 JOIN 了每一個對話」，比空陣列更糟。
 *
 * 目前只保留給 `scripts/spike/03-incremental.ts` 作為證據蒐集之用。
 * M1 的 JOIN/LEAVE 偵測改走 §9.3.1 的清單輪詢 + `mode` 欄位
 * （見 `conversation-list-poller.ts`），M4 換 webhook 後才會有真正的 operator 清單。
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
 *
 * ⚠️ `server/services/imbrace.ts` 有一份 `unwrapPagedRaw()` 是同一段邏輯的複本
 *    （該檔須維持零內部相依，供 spike 以 tsx 直接 import）。改這裡時兩處都要改。
 */
export function unwrapPaged<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  const r = res as Record<string, unknown> | null | undefined
  for (const key of ['data', 'items', 'results', 'hits']) {
    if (Array.isArray(r?.[key])) return r[key] as T[]
  }
  return []
}
