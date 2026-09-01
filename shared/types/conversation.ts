/**
 * AgentCopilot 的領域型別（前後端共用）。
 *
 * ⚠️ 這是「我們的」型別，不是 iMBrace SDK 的型別。
 * SDK 的 `ConversationMessage` 形狀與此不同，兩者之間的轉換一律走
 * `server/sources/mappers.ts` —— 這是防腐層（anti-corruption layer）。
 *
 * 對應 docs/ARCHITECTURE.md §11.4。
 */

/** ⚠️ 撞單防護（§10.4）與對話分段（§14.1.2）皆依賴此欄位 */
export type SenderType = 'customer' | 'ai' | 'agent' | 'unknown'

export interface Attachment {
  id: string
  /**
   * ⚠️ `pdf` 必須與 `file` 分開 —— 兩者的能力邊界完全不同（§11.4）：
   * `image`／`pdf` 有直接可用的 `url`，走自建 vision／文件分析，已納入 MVP；
   * 舊資料型 `file` 只有 `{name, media_id}`、無 url，僅顯示檔名標示「無法預覽」。
   * 併成同一個值就抹掉了這個區分，UI 會把可分析的 PDF 當成不可預覽的檔案。
   *
   * 不含 `audio`／`video`：iMBrace 平台不支援語音訊息，且客戶端上傳介面
   * 只接受圖片與 PDF（H-2a／H-2e 已確認）。
   */
  kind: 'image' | 'pdf' | 'file'
  filename: string
  url?: string
  /** 我方產生的文字化內容（vision／文件分析）。平台不提供描述或 OCR */
  transcript?: string
  /** transcript 的來源，供成本控制與品質判斷 */
  transcriptSource?: 'platform' | 'ours' | 'none'
}

export interface Message {
  id: string
  conversationId: string
  at: string
  sender: {
    type: SenderType
    /** agent 時為 operatorId；customer 時為 contactId */
    id?: string
    name?: string
  }
  /** 統一的可分析文字：原文，或附件的 vision／文件分析描述 */
  text: string
  attachments?: Attachment[]
}

export interface Operator {
  id: string
  name: string
}

/**
 * 對話的服務模式 —— 對應官方介面 Composer 上方的下拉選單（§10.6）。
 *
 * ⚠️ 這是**對話層級的共用狀態**，不是每位客服各自的偏好。
 *    任一位客服切換，其他所有人（含我方）都會跟著改變。
 */
export type ConversationMode = 'manual' | 'hybrid' | 'automation'

export interface Conversation {
  /** 對話 id（裸 UUID）。訊息查詢用這個 */
  id: string
  /**
   * team_conversation 記錄的 id（`tcu_` 前綴）。
   *
   * ⚠️ JOIN / LEAVE / 切換 mode **都必須用這個**，不能用 `id`（§10.6）。
   * ⚠️ 只有 `conversations.get()` 會回傳，**清單 payload 沒有** ——
   *    因此從對話列表要 JOIN 之前，必須先取一次詳情。
   */
  teamConversationId?: string
  channel: string
  contactId: string
  status: string
  name: string
  /**
   * `null` 代表從未 JOIN。
   * ⚠️ `automation` 有歧義：可能沒人，也可能有人但選了 Automation Only（唯讀）。
   *    判定「是否有他人可能送出訊息」請用 `manual | hybrid`，見 §10.2。
   */
  mode?: ConversationMode | null
  /**
   * ⚠️ 這是**團隊名冊**，不是「這個對話的參與者」（§10.2 二次實測）。
   *
   * 兩個不同對話的 `users[]` 實測為同一批 14 人，含 Bot 與 observer。
   * **不可作為 presence 來源**，也不可用來反推訊息發送者 ——
   * 前者會把整個團隊標成「正在檢視」，後者會把同事誤判為 AI。
   * 清單 payload 中此欄為 `null`，只有 `conversations.get()` 才有值。
   */
  operators: Operator[]
  /**
   * 最後一則訊息的時間 —— §9.3.1 第一層輪詢的變動偵測依據。
   *
   * ⚠️ 實測填充率僅 83%，部分對話為空。為空者無法靠清單輪詢偵測新訊息，
   *    必須退回逐對話輪詢（見 `PollingMessageSource` 的 `listCovered`）。
   */
  lastMessageAt?: string
  /**
   * 對話建立時間（畫布 §8.3 中欄 meta 列「建立於 08/25 13:58」）。
   *
   * ⚠️ 與 `lastMessageAt` 不同，這一個實測填充率 **100%**
   *    （`scripts/spike/out/08-D1-conversation-shape.json`：`created_at`），
   *    因此 meta 列不需要為「拿不到」另備一套呈現。
   */
  createdAt?: string
  updatedAt: string
  /**
   * **「我」有沒有 JOIN 這一則** —— 左欄列項第二行的「你在此對話中」（畫布 §8.2）。
   *
   * ⚠️ **這個欄位不是平台清單 payload 給的，是 BFF 解析後補上的。**
   *    實測清單 16 筆之中 **0 筆**帶 `is_joined`（§10.2.1、`out/23-list-join-fields.json`），
   *    那個欄位只有單筆 `conversations.get()` 才有。解析邏輯與成本控制見
   *    `server/services/viewer-joined.ts`。
   *
   * ⚠️ **`undefined` 不等於 `false`。** 它代表「這一輪還沒解析」——
   *    候選集合有單輪上限，排不進來的會留到下一輪；解析失敗時也是 `undefined`。
   *    UI MUST 用 `=== true` 判斷，MUST NOT 用 `!viewerJoined` 去斷言「不是我」，
   *    後者會在還沒解析完的那一瞬間說出一個我們還不知道的結論。
   */
  viewerJoined?: boolean
}

/**
 * §10.6 —— 兩個正交維度，不可建模成三種模式列舉。
 *
 * ⚠️ 2026-08-25 修訂：原本是 `aiMode: 'collab' | 'human_only'`，
 *    與 §10.6 實測後定案的兩維度模型不一致。四個平台 mode 全數實測後，
 *    「AI 會不會自動回覆」與「客服能不能送出」確認是**互相獨立**的兩件事
 *    （Automation Only 時 AI 會回、客服不能送），單一列舉表達不了。
 */
export interface ConversationControl {
  /** AI 是否自動回覆 —— 為 true 時 AI 是撞單對象之一（§10.5） */
  aiReplies: boolean
  /** 客服能否送出 —— Automation Only 時為 false，平台端也會拒絕 */
  agentCanSend: boolean
  /** 產生上述兩維度的平台 mode，供 UI 顯示與除錯 */
  mode: ConversationMode | null
  /**
   * 主管強制介入（我方自訂，平台無此概念）。
   *
   * ⚠️ 這是全系統唯一的真鎖，但強制力僅及於 AgentCopilot 內部 ——
   *    直接使用 iMBrace 官方介面的同事擋不住。介面必須明示此邊界（§10.6）。
   */
  lock: null | {
    by: string
    name: string
    at: string
  }
}

/**
 * 平台 mode → 兩個正交維度（§10.6 對照表）。
 *
 * ⚠️ `null`（從未 JOIN）視同 automation：AI 在跑、我方尚未取得送出權。
 *    JOIN 之後才會變成 `manual`。
 */
export function controlFromMode(
  mode: ConversationMode | null | undefined,
  lock: ConversationControl['lock'] = null,
): ConversationControl {
  const m = mode ?? null
  return {
    aiReplies: m !== 'manual',
    agentCanSend: m === 'manual' || m === 'hybrid',
    mode: m,
    lock,
  }
}

/**
 * 是否有「我以外的人」可能送出訊息（§10.2 presence 來源 ③）。
 *
 * ⚠️ 回答的**不是**「有沒有人在」。`automation` 對「根本沒人」與
 *    「有人但選了 Automation Only（唯讀）」無法區分 —— 但那個歧義對撞單防護無害，
 *    因為 Automation Only 的同事送不出訊息，撞不了單。
 */
export function someoneElseCanSend(mode: ConversationMode | null | undefined): boolean {
  return mode === 'manual' || mode === 'hybrid'
}

// ── Presence（docs/ARCHITECTURE.md §10.2）───────────────────────────────

export type PresenceState = 'viewing' | 'composing' | 'joined'

/**
 * ⚠️ `source` 不是除錯欄位，是 UI 的必要輸入。
 *
 * §10.2：`sse` 代表「此刻確實開著這個對話」，`message` 只代表「N 分鐘前發言過」。
 * 把後者顯示成「正在檢視」會讓客服以為有人守著而實際沒人 —— 比不顯示更糟。
 * 各來源的涵蓋範圍與可信度不同，PresenceBar 必須據此分開呈現。
 *
 * ⚠️ §10.2 的第三個來源（`mode ∈ {manual, hybrid}`）**不在這個列舉裡** ——
 *    它只知道「有人能送出訊息」，不知道是誰，塞不進以 operatorId 為鍵的條目。
 *    它落在 `PresenceSnapshot.unidentifiedActor`（shared/types/events.ts）。
 */
export type PresenceSource =
  /** ① 自家 SSE 上報 —— 只涵蓋我方使用者，延遲 < 200ms，可信度高 */
  | 'sse'
  /** ② 訊息 `u_` 前綴反推 —— 涵蓋官方介面的同事，僅代表「曾經發言」 */
  | 'message'
  /** ④ JOIN/LEAVE webhook —— 全涵蓋，待規格（M4） */
  | 'webhook'

export interface PresenceEntry {
  operatorId: string
  operatorName: string
  state: PresenceState
  /**
   * 這個人有沒有 JOIN 這個對話。
   *
   * ⚠️ 為何不併進 `state`：「正在輸入」與「已 JOIN」是**兩個正交的維度**，
   *    一個人可以同時是這兩者。併成一個列舉的話，心跳送出 `composing`
   *    就會把 `joined` 蓋掉 —— 症狀是客服 JOIN 之後開始打字，
   *    自己就從「已加入」變回「觀察中」，而 Composer 的可用性判斷跟著失準。
   *
   *    這與 §10.6 拒絕把三種平台模式建模成單一列舉是同一個判斷。
   */
  joined: boolean
  source: PresenceSource
  /** 此狀態的發生時間（ISO8601）。source 為 `message` 時即該則訊息的時間 */
  at: string
}

/**
 * 這則訊息是不是 AI workflow 的**內部訊息**（路由、分類等），而非給客戶看的回覆。
 *
 * ── 2026-08-25 實測發現 ─────────────────────────────────────────
 * 同一個 workflow 會在同一個對話裡送出兩種東西，而**平台完全無法區分**：
 *
 * ```
 * pub_486c5cab…  text  抱歉造成您使用上的不便，請協助確認…      ← 真的回給客戶
 * pub_486c5cab…  text  {"category":"DEV-001","confidence":"high"} ← 內部分類
 * pub_486c5cab…  text  {"route": "T1"}                           ← 內部路由
 * ```
 *
 * 同一個 `from`、同樣 `type: "text"`、**所有欄位完全一致**，沒有任何旗標。
 *
 * ⚠️ 為何這是正確性問題而不只是體驗問題：
 * §10.4 的撞單檢查在 Hybrid 模式下把 `sender.type === 'ai'` 視為撞單對象。
 * workflow 在客服組字期間吐一個 `{"route":"T1"}`，客服就會收到
 * 「AI 已經自動回覆」的警告 —— 但客戶那邊什麼都沒收到。
 * **假警報比沒有警報更糟**：客服學會忽略提示後，真正的撞單也會被一併略過。
 *
 * ⚠️ 這是**啟發式判斷，不是規格**。已列為 `IMBRACE_QUESTIONS.md` H-3c 請 iMBrace
 *    提供正式的區分方式；屆時只需改這一個函式。
 *    採「整段文字可解析為 JSON 物件／陣列」這個條件的理由：
 *    對一個以中文回覆終端客戶的客服 bot，正式回覆剛好是純 JSON 的機率極低，
 *    而漏判（把內部訊息當成真回覆）的代價是假警報，比誤判嚴重。
 */
export function isWorkflowInternalMessage(message: Message): boolean {
  if (message.sender.type !== 'ai') return false

  const text = message.text?.trim()
  if (!text) return false
  // 先看首字元，避免對每一則長訊息都做一次 JSON.parse
  if (!text.startsWith('{') && !text.startsWith('[')) return false

  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null
  }
  catch {
    // 以 { 開頭但不是合法 JSON —— 那就是普通文字（例如「{...}是什麼意思？」）
    return false
  }
}
