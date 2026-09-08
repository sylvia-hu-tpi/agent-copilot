/**
 * 知識庫檢索命中 → 結案草稿的「相關的知識庫來源」清單（契約 R2.7）。
 *
 * ⚠️ **一次命中不等於一筆來源。** `AgentKnowledgeProvider` 依 `[Source: 檔名]` 標記切段，
 *    同一份文件命中多個片段就是多筆 `KnowledgeHit`（002 research #1 決策 2）——
 *    快查那側刻意逐段列出（每段是「插入為回覆」的單位），但結案來源清單的單位是**文件**。
 *    不去重的話：畫面上同一個檔名出現兩次、`v-for` 的 `:key` 重複（Vue 只會在
 *    console 警告，畫面照常渲染）、按一次 `×` 兩顆一起消失、Board 的 `cited_sops`
 *    寫進重複 id。四個症狀沒有一個會讓測試變紅。
 *
 * ⚠️ **保留第一次出現的順序** —— 那是檢索的相關性順序，重排等於丟掉排序資訊。
 *
 * ⚠️ 這裡刻意**不**過濾 `knowledge-fallback-*` 的容錯 id（`folder_info` 比對不到檔名時
 *    由檔名雜湊產生）：那筆命中是真的，`title` 也是從檔名還原的、對客服完全可讀，
 *    只是 id 不是平台的真實檔案 id。丟掉它等於因為稽核欄位不夠漂亮而不告訴客服
 *    有這份文件 —— 反了。
 */

import type { ClosureCitedSop } from '../../../shared/types/copilot.js'
import type { KnowledgeHit } from '../../../shared/types/knowledge.js'

export function toCitedSops(hits: readonly KnowledgeHit[]): ClosureCitedSop[] {
  const seen = new Set<string>()
  const out: ClosureCitedSop[] = []
  for (const hit of hits) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    out.push({ id: hit.id, title: hit.title })
  }
  return out
}
