/**
 * 知識庫檢索的資料契約 —— specs/002-suggestion-knowledge-search/data-model.md §2、§5。
 *
 * ⚠️ 一次寫入最終形狀（含 `fileId`／`timeoutMs`／`expandRef`／`degraded`），
 *    不分批擴充——同一個檔案在同一個功能內建立後又自我翻修沒有理由（research.md）。
 */

export interface KnowledgeHit {
  /** 僅供系統內部 FR-003 白名單核對使用，MUST NOT 顯示於 UI（research.md #2 二次訂正） */
  id: string
  /** 清理過的來源檔名，是對客服顯示的唯一來源識別方式——不另設「編號」欄位 */
  title: string
  /** 本次檢索命中的內容片段原文——「插入為回覆」的帶入單位，非條目全文（FR-022） */
  snippet: string
  /** 檢索分數；iMBrace 路徑恆為 null（無分數來源），見憲法 4.4 同一原則 */
  score: number | null
  /** ISO8601；無法從來源可靠推得時為 null（research.md #2），null 時 UI 不觸發 FR-009 過舊提醒 */
  updatedAt: string | null
  sourceRef: { type: 'knowledge', ref: string }
}

export interface KnowledgeProvider {
  /**
   * @param opts.fileId 限定在單一檔案內檢索（「展開全文」用，research.md #3）
   * @param opts.timeoutMs 逾時上限；預設 KNOWLEDGE_SEARCH_TIMEOUT_MS（快查用，見 plan.md Constraints）。
   *                       ⚠️ 建議卡生成的檢索 MUST 明確傳入 SUGGESTION_RETRIEVAL_TIMEOUT_MS，
   *                       MUST NOT 沿用這個預設 —— 那條路徑受 SC-001 的 10 秒約束，
   *                       沿用快查的長逾時會讓建議卡遲到（見該常數註解）。
   */
  search(query: string, opts?: { topK?: number, fileId?: string, timeoutMs?: number }): Promise<KnowledgeHit[]>
}

// ── 知識庫快查的請求／回應型別（不進 CopilotEvent，見 research.md #7）────────

export interface KnowledgeSearchRequest {
  query: string
  /** 有值時 query 沿用原查詢字串，但限定在該 sourceRef.ref 對應的檔案內搜尋（「展開全文」，FR-010） */
  expandRef?: string
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeHit[]
  /**
   * 檢索呼叫失敗或逾時（憲法 3.1／3.2：這支端點 MUST NOT 回 5xx）。
   * 前端據此顯示「知識庫服務暫時無法使用」＋重試，而非「查無相關結果」——
   * 兩者都會是 `hits: []`，少了這個欄位就無法區分。
   */
  degraded?: boolean
}
