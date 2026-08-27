# Contract: 知識庫自然語言快查 API

一次性 request/response，**不經 SSE、不進 `CopilotAnalysisState`**——理由見 research.md #7。

## 端點

```
POST /api/conversations/{id}/knowledge-search
```

### Request Body

```ts
{ query: string }
```

### Response（200）

```ts
{ hits: KnowledgeHit[] }
```

`KnowledgeHit` 定義見 `data-model.md` §2。`score` 恆為 `null`（iMBrace 路徑無分數來源，UI 不顯示，
FR-007）；`updatedAt` 可能為 `null`（research.md #2）。

### 錯誤狀態

| 狀況 | HTTP | body | 對應 FR |
|---|---|---|---|
| `query` 為空白或僅空白字元 | 200 | `{ hits: [] }`，**不呼叫** `KnowledgeProvider` | FR-008——這不是「查無結果」，是「尚未查詢」，前端 MUST 依請求是否曾送出（而非依 `hits.length`）決定顯示「尚未輸入查詢」還是「查無相關結果」，不可只看回應內容判斷 |
| 客服未 JOIN 該對話 | 403 | `{ message: '需先加入對話' }` | FR-025——前端收到後顯示「需先 JOIN 才能使用」，與空白查詢／查無結果／錯誤狀態视觉可區分 |
| `KnowledgeProvider.search()` 逾時或拋錯 | 200 | `{ hits: [], degraded: true }` | 憲法 3.1/3.2——**MUST NOT** 讓這支端點的失敗變成 5xx 打斷前端的錯誤處理流程；`degraded: true` 讓前端顯示「知識庫服務暫時無法使用」＋重試，而非「查無相關結果」 |

`degraded` 僅用於區分「錯誤」與「真的查不到」——兩者都是 `hits: []`。此欄位已收進
`data-model.md` §5 的 `KnowledgeSearchResponse`（`expandRef` 同樣已收進 `KnowledgeSearchRequest`），
型別定義以 `data-model.md` 為準，本契約不另立形狀。

檢索呼叫 MUST 帶逾時上限（`KNOWLEDGE_SEARCH_TIMEOUT_MS`，見 `plan.md` Constraints），
逾時即走上表最後一列的 `degraded` 路徑——SC-002 的門檻靠這個上限成立，不靠 provider 自律。

⚠️ **本端點（快查）與建議卡生成用的是兩個不同的逾時值**，MUST NOT 共用：快查是客服主動
發起、畫面上有骨架的同步查詢，用 `KNOWLEDGE_SEARCH_TIMEOUT_MS`；建議卡走「先檢索再生成」
的串行流程且受 SC-001 的 10 秒約束，用明顯更短的 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`。
兩者的完整理由與實測數據見 `server/services/knowledge/agent-knowledge-provider.ts`。

## 前端契約（`useKnowledgeSearch.ts`）

- 輸入 debounce 300ms（`docs/ARCHITECTURE.md` §12.3 既有建議值）。
- debounce 到期時，若輸入為空白，**不送請求**，且清除任何既有結果（回到「尚未輸入查詢」狀態，
  不是清空後顯示「查無結果」）。
- 送出中若使用者又輸入新字元，沿用既有 in-flight 取消慣例（比照 `useDraft`/`useConversationView`
  的模式：不特別 abort 舊請求，但只採用最後一次的回應——用一個遞增的請求序號比對，避免競態下
  舊回應覆蓋新查詢的結果）。
- 每筆結果的「插入為回覆」：帶入 `hit.snippet`（原文，不經 AI 改寫，FR-022），同受 FR-018
  草稿覆蓋確認約束。
- 「展開全文」：呼叫同一端點的變化版本（見 research.md #3），本 MVP 不另開新端點，而是同一支
  `knowledge-search` 端點新增可選欄位 `expandRef`：

```ts
{ query: string, expandRef?: string }  // expandRef 有值時，query 沿用原查詢字串，
                                        // 但限定在該 sourceRef.ref 對應的檔案內搜尋
```

  回應形狀不變（`{ hits: KnowledgeHit[] }`），前端將回應的多筆 `snippet` 依序串接顯示，並標示
  「本次可取得的相關內容，可能未涵蓋完整文件」（research.md #3 的誠實標示要求）。
