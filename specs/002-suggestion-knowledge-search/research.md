# Phase 0 Research: 建議卡與知識庫快查

本功能大部分的架構決策在 `docs/ARCHITECTURE.md`（§8.2、§8.2b、§10.4-10.7、§11、§12、§14.6、§15.2）與
`docs/CONSTITUTION.md`（第三、四、六條）已定案；`specs/001-sentiment-panel` 也已建立
`AIProvider`／`CopilotAnalysisState`／重試退避／SSE 整塊覆蓋等模式，本功能沿用而非重新發明。

本文件只記錄**本功能新增、既有正典文件未直接回答**的實作決策。已定案項目不重複列出，直接於
plan.md／data-model.md 引用章節號。

## 1. `KnowledgeProvider` 的真實資料形狀（RAGknowledge 工具輸出）——與 §8.2 的介面草案有落差

**證據**：`scripts/spike/out/11-宏宏企業-knowledge-raw.json` 是一次真實的 `RAGknowledge` 工具呼叫，
`tool-output-available` 事件的 `output` 形狀為：

```json
{
  "status": "success",
  "result": "📁 Sources:\n- <urlencode 檔名>.pdf\n\n📄 Context:\n[Source: <urlencode 檔名>]\n<chunk 原文>\n\n[Source: <urlencode 檔名>]\n<chunk 原文>\n…",
  "folder_info": "{\"folders\":[{\"files\":[{\"id\":\"<uuid>\",\"name\":\"<原始檔名>.pdf\",\"remarks\":null}, …]}]}",
  "metadata": { "result_count": 1, "timestamp": "…" }
}
```

這與 §8.2 草案假設的「每筆 hit 各自有 `id`／`score`／`updatedAt` 的結構化陣列」有兩處實質落差：

1. **`result` 是單一字串**，多筆命中以重複出現的 `[Source: <檔名>]` 標記串接，不是 JSON 陣列。
2. **`folder_info` 裡的檔案清單沒有任何日期欄位**（`remarks` 恆為 `null`），且 `folder_info` 是
   **整個知識庫的資料夾快照**，不是本次查詢的命中範圍——不能拿它當作「這次搜尋到幾筆」的依據。

**Decision**：`AgentKnowledgeProvider.search()` 的解析流程：

1. 呼叫知識庫 agent（掛 Knowledge Hub，見下方決策 4）的 `streamChat()`，過濾 `tool-output-available`
   且 `toolName === 'RAGknowledge'` 的事件，取其 `output.result`。
   ⚠️ **實作時二次核對 fixture 發現**：`tool-output-available` 事件本身**不帶 `toolName`**——
   該欄位只出現在同一次工具呼叫較早的 `tool-input-start`／`tool-input-available` 事件上，
   兩者以 `toolCallId` 相關聯。因此實作（`AgentKnowledgeProvider`）改為先建立
   `toolCallId → toolName` 對照表，再用它反查 `tool-output-available` 屬於哪個工具——
   直接比對 `tool-output-available` 事件的 `toolName` 恆為 `undefined`，會靜默找不到任何輸出。
   本節原描述的資料流向不變，只有比對方式修正。
2. 以正則 `/\[Source: ([^\]]+)\]\n([\s\S]*?)(?=\n\[Source: |$)/g` 切出「(檔名, chunk 原文)」配對——
   **每個 chunk 出現即為一筆 `KnowledgeHit`**，同一檔名重複出現也各自成一筆（見決策 2 的理由）。
3. 檔名先做 `decodeURIComponent()`（樣本檔名是雙重 URL-encode，需 decode 兩次）還原可讀標題。
4. 以還原後的檔名比對 `folder_info.folders[].files[].name`，取得該檔案的 `id`（UUID）作為
   `KnowledgeHit.id`；比對不到時（`folder_info` 未涵蓋到，理論上不應發生但需容錯）退回以檔名本身
   雜湊出一個穩定 id，避免整筆結果被丟棄。
5. `title`／`updatedAt`：見決策 2。`score`：恆為 `null`（平台無分數來源，§8.2 已定案，本功能不變）。
   `sourceRef`：`{ type: 'knowledge', ref: <檔案 id> }`。

**Rationale**：這個切法直接對應 FR-010／FR-022「插入為回覆帶入的是**本次檢索命中的內容片段原文**，
非條目全文」——`result` 字串裡的每個 `[Source: X]` 段落本來就是一個 chunk，而不是一份文件，
**這正好印證 spec 選擇「片段而非全文」的理由是有真實 API 形狀支撐的，不是憑空的產品決策**。

**Alternatives considered**：
- 把同一檔名的多個 chunk 合併成一筆 hit（更接近「一份文件一筆」的直覺）：否決——會讓
  `sourceRef` 對應到「檔案的哪一段」這個資訊消失，而「插入為回覆」需要的正是段落級的原文，
  合併後客服會拿到一大段混雜不同段落的文字，不符 FR-022。
- 等 iMBrace 回覆是否有結構化的檢索端點（§0-3f）後再實作：否決——RAG 品質（#19）與資料形狀
  （本節）是兩個獨立問題，不必互相阻塞；本節的解析邏輯全部封裝在 `AgentKnowledgeProvider`
  內部，換 `VikiKnowledgeProvider` 時不影響上層。

## 2. `KnowledgeHit.updatedAt` 在真實資料中並不存在，「SOP 編號」根本不需要——兩者都是設計稿過度設計

**證據**：同上一節的 `folder_info` 樣本，檔名為
`收益不動產事業部金融大樓-部門作業-金融大樓電梯困人SOP_V1_20250925_部門可見.pdf`——
檔名裡有版本與日期片段，但**沒有任何「SOP #NN」形式的編號**。ARCHITECTURE §12.3／
DESIGN_TOKENS §7.2 的「SOP #12」「SOP #47」是設計稿示範用的**illustrative 文案**，不是平台真實會
回傳的欄位；iMBrace 的知識庫檔案就是一般檔案，沒有獨立的編號系統。

**Decision（2026-08-27 二次訂正）**：**不設 `KnowledgeHit.code` 欄位，也不試圖用檔案 id 頂替一個
顯示用編號。** 本節原先的做法是「杜撰一個看起來像編號的顯示值（檔案 id 短版本）去滿足『SOP 編號』
這個需求」——但退一步看，這個需求本身就只是在附和設計稿的示範文案，客服真正需要的是「這是哪一份
文件」（`title` 就夠了）與「這份文件多新」（`updatedAt`），一個額外的、不對應真實編號制度的
「引用代碼」對客服判斷是否採用建議沒有任何實際幫助，純粹是為了讓畫面「看起來」跟設計稿一致而
存在的裝飾欄位。**改為只保留 `title`（清理過的檔名，去除 `_V\d+_\d{8}_部門可見` 一類版本／日期／
可見範圍後綴）與 `updatedAt` 作為對客服顯示的欄位**；`id`（原始檔案 id）保留但**僅供系統內部
FR-003 白名單核對使用，不進 UI**。`spec.md` FR-002／FR-007／FR-009／Key Entities 已同步移除
「SOP 編號」的獨立顯示要求（2026-08-27，見該檔 Assumptions）。

- `KnowledgeHit.updatedAt`：**改為 `string | null`**（§8.2 草案原寫死 `string`，不可為 `null`）。
  嘗試以正則 `/_V\d+_(\d{4})(\d{2})(\d{2})_/i` 從檔名擷取日期並轉為 ISO8601；擷取不到時為 `null`。
  ⚠️ **`i` 旗標不可省**（2026-08-27 重跑 `npm run spike:contract` 取樣時發現）：同一個資料夾的 9 個檔案
  裡有 2 個把版本片段寫成小寫 `_v1_20200926_`（分隔符也從 `-` 改成 `_`），大小寫敏感的版本會讓這些檔案
  靜默落入下面的 `null` 分支、顯示「更新日期未知」，而日期其實就在檔名上。`deriveTitle()` 清理後綴的
  正則同理。
  FR-009「超過 12 個月標示過舊提醒」僅在 `updatedAt !== null` 時計算並顯示；`updatedAt === null`
  時該筆結果顯示「更新日期未知」的中性狀態，**不觸發過舊提醒，也不謊稱是最新的**——這與憲法
  4.4／4.5「無真實依據不得填充」是同一個原則的延伸：日期跟信心度一樣，沒有就是沒有，不用檔案
  的存在時間或當下時間去猜。

**Rationale**：檔名日期只是一個**啟發式**（heuristic），不是平台保證的欄位——與 §10.4 註解裡
`byAi` 內部訊息判斷「純 JSON 視為內部訊息」同一種性質的暫行做法：先求「不謊報」，其次求「盡量
有用」。若之後 iMBrace 提供真正的檔案 metadata API（含最後修改時間），只需替換這裡的擷取邏輯，
`KnowledgeHit` 介面與下游 UI 都不用改（因為介面本來就是 nullable）。拿掉 `code` 欄位則是單純的
「不為不存在的需求做設計」——憲法 2.4 的反面教訓（抽象只用於規格未定的依賴）在這裡有一個對稱版本：
**顯示欄位也只該對應真實存在的資訊，不該為了呼應設計稿而無中生有一個欄位**。

**Alternatives considered**：
- 用 `folder_info` 拿不到就整批標示錯誤：否決——會讓 FR-011「查無相關結果」與「日期不明」兩種
  完全不同的狀態被混為一談，客服無法判斷是搜尋壞了還是只是沒有日期資訊。
- 用「現在」當作 `updatedAt`：否決——直接違反憲法 4.5「事實不得推測」的精神，且會讓 FR-009 的
  過舊提醒永遠不會觸發，是比留空更糟的沉默失效。
- 保留 `code` 欄位，內容用檔案 id 短版本頂替：否決（本節二次訂正的內容）——這是第一版決策，
  經重新檢視後認為它只是為了滿足「畫面要有一個編號」這個表面需求而杜撰資料，客服拿到一個
  「知識庫 #a3f9c21e」這種既不是真編號、也無法對應到任何外部制度的字串，除了徒增畫面雜訊之外
  沒有實際用途，撤銷。

**待辦**：已於 `docs/IMBRACE_QUESTIONS.md` 新增一題（見該檔），詢問知識庫檔案是否有可查詢的
「最後修改時間」中繼資料 API，以及貴司內部是否有正式的 SOP 編號制度可供串接（若確實有正式編號
制度，屆時再評估是否值得恢復顯示一個編號欄位——但那會是一個新決策，不是本節的 fallback）。

## 3.「展開全文」在只有 chunk 級檢索 API 的前提下如何實作——已知限制，非完整方案

**Decision**：`RAGknowledge` 只回傳片段，平台沒有「取得檔案完整內容」的獨立端點（§12.1 已確認
無檢索 API；`document-ai` 是抽取導向非檢索導向）。因此「展開全文」**MVP 做法**：對同一個
`sourceRef.ref`（檔案 id）**重新呼叫一次** `KnowledgeProvider.search()`，但將原始查詢字串換成較
寬泛的檢索詞（沿用本次查詢字串本身即可，不另外生成），並在呼叫端把 `RAGknowledge` 的
`document_file_ids` 輸入參數限定為該檔案 id（`input.document_file_ids: [ref]`，該參數已在
`tool-input-available` 的 schema 裡出現，用途正是「限定在特定檔案內搜尋」）。把這次呼叫拿到的
所有 chunk（依 §1 的解析法）依原文出現順序串接、去重後顯示為「本次可取得的相關內容」。

**Rationale**：這是目前平台能力下最接近「全文」的做法，但**誠實地說它不是真正的全文**——RAG
工具本身可能仍只回傳 top-K 相關片段而非整份文件。FR-010 的「展開全文」文案與行為**必須在實作時
註明此為儘量呈現，不保證涵蓋整份文件**，記錄為已知限制（見下方，比照
`specs/001-sentiment-panel` 對 §11.8 的做法，新增 `ARCHITECTURE.md` §12.4）。

**Alternatives considered**：
- 直接顯示原始 `result` 字串裡跟該檔案有關的所有既有 chunk（不重新呼叫）：否決——使用者按「展開
  全文」時通常想看比原本片段更多的內容，只重複顯示同一段沒有意義；重新呼叫才可能取得該文件內
  其他部分。
- 完全不做「展開全文」，只做「插入為回覆」：否決——直接違反 FR-010 的 MUST 要求，且該功能是
  User Story 2 驗收的一部分。

**待辦**：新增 `docs/ARCHITECTURE.md` §12.4「知識庫快查已知限制」記錄此節結論（本次 plan 一併
完成，見下方「文件同步」）。

## 4. 新增哪些 AI Agent／環境變數——沿用 `server/services/ai/index.ts` 的裝配模式

**Decision**：新增兩個 iMBrace AI Agent（比照既有 `AgentCopilot_摘要_agent`／
`AgentCopilot_情緒評分_agent` 的命名慣例）：

| Agent | 用途 | 新環境變數 |
|---|---|---|
| `AgentCopilot_知識庫檢索_agent` | 掛 Knowledge Hub，供 `AgentKnowledgeProvider.search()` 呼叫 | `IMBRACE_KNOWLEDGE_AGENT_ID` |
| `AgentCopilot_建議回覆_agent` | 供 `AIProvider.suggest()` 呼叫，**不掛 Knowledge Hub**——知識庫檢索由 `copilot-analysis.ts` 先呼叫 `KnowledgeProvider.search()` 取得 hits 後作為 prompt context 傳入（§11.6①的流程），不假手模型自己再查一次 | `IMBRACE_SUGGESTION_AGENT_ID` |

兩者皆比照 `server/services/ai/index.ts::envVar()` 的雙鍵名讀法（`NUXT_IMBRACE_*` 優先、
`IMBRACE_*` 次之）。缺任一憑證時，`useKnowledgeProvider()`／`useAIProvider()` 分別退回
`MockKnowledgeProvider`／保留現有 Mock 的 `suggest()` 實作（見決策 6），並印出既有格式的警告訊息。

**Rationale**：直接沿用已驗證可行的裝配模式（`ImbraceAgentProvider` 已上線），不重新設計組裝方式；
兩個 agent 分開（而非合併進摘要/情緒 agent 或彼此合併）是因為 §2.4「抽象只用於規格未定的依賴」
的反面教訓不適用於這裡——這兩者的 prompt 任務（檢索 vs. 生成建議）本質不同，合併會讓 prompt
臃腫且難以個別調校（檢索 agent 需要保留 Knowledge Hub 存取，建議 agent 不需要，混在一起會讓建議
agent 也意外具備自行查詢知識庫的能力，違反「檢索與生成分離、後端白名單後驗」的設計）。

**Alternatives considered**：讓 `AIProvider.suggest()` 內部的 agent 自己掛 Knowledge Hub、自己
決定要不要查：否決——這樣白名單後驗（FR-003）會需要反過來從模型的 tool call 記錄回推它查了什麼，
而不是「先給 hits、模型只能從 hits 裡選」的單向流程，複雜度與可稽核性都變差，且與 §11.6①
既有定案的流程矛盾。

## 5. `suggest()` 的檢索查詢字從何而來（建議卡場景，非使用者手動輸入）

**Decision**：`copilot-analysis.ts` 在觸發建議卡重算時，以**本次分析涵蓋的客戶發言文字**（`history`
裡 `sender.type === 'customer'` 的訊息，取最近幾則串接，長度上限比照摘要 prompt 的量級）作為
`KnowledgeProvider.search()` 的查詢字串，`topK` 預設 `5`。

**Rationale**：最簡單、不需要額外一次 AI 呼叫去「生成檢索查詢」，且與冷啟動/增量觸發本來就在處理
的輸入完全一致，不增加延遲預算（§14.6 的 3 秒／10 秒門檻已經很緊）。

**Alternatives considered**：先用一次 AI 呼叫把客戶發言改寫成更適合檢索的查詢句：否決，理由是
額外延遲與成本在 RAG 品質本身仍是 P0 風險（#19）未解之前不值得投入；若之後確認這是檢索命中率
的瓶頸，可在不改變 `KnowledgeProvider` 介面的前提下加這一步（純屬 `copilot-analysis.ts` 內部
組裝細節）。

## 6. `AIProvider.suggest()` 的驗證：白名單捨棄是「整卡捨棄」，與既有 schema 慣例不同

**Decision**：新增 `server/services/ai/schemas.ts::SuggestionCardSchema`（Zod，形狀對照
`shared/types/copilot.ts` 的 `SuggestionCard`，`tone` 用 `z.enum`、`confidence` 為
`z.number().min(0).max(100).nullable()`、`sopId`/`sopTitle` 為 `z.string().nullable()`）与
`parseSuggestionCards(raw): SuggestionCard[]`，驗證失敗的**單張**卡片直接跳過（不讓整批因一張
格式錯誤而全部失敗，比照既有 `riskFlags` 的容錯精神）。

**但白名單後驗（FR-003，憲法 4.3）是另一層、且語意不同**：schema 驗證管「格式對不對」，
白名單管「這個 `sopId` 是否真的在本次 `knowledgeHits` 集合裡」——**後者失敗時 MUST 整卡捨棄
（含 `text`／`rationale` 等其餘欄位），不是只清空 `sopId` 後繼續顯示**（FR-003 明文、
edge case 也明文禁止「退而顯示被捨棄卡片的殘餘內容」）。因此白名單檢查**不放進 Zod schema**，
而是 `copilot-analysis.ts::analyzeSuggestions()` 在 schema 驗證之後、寫入
`CopilotAnalysisState` 之前的獨立一步：

```ts
function whitelistFilter(cards: SuggestionCard[], hits: KnowledgeHit[]): SuggestionCard[] {
  const validIds = new Set(hits.map(h => h.id))
  return cards.filter(c => c.sopId === null || validIds.has(c.sopId))
}
```

**Rationale**：把「格式驗證」與「業務層白名單」分成兩個函式，是因為兩者的失敗處置完全不同
（前者是「這筆資料本身壞掉」，後者是「資料格式合法但引用了不存在的來源，屬幻覺」），混在同一個
`schemas.ts` 裡的 `parse*()` 函式會讓呼叫端搞不清楚一次呼叫失敗到底是哪一層原因，也不利於
`test/suggestion-whitelist.test.ts` 單獨測試白名單邏輯而不必構造完整的 AI 呼叫上下文。

**Alternatives considered**：把白名單檢查也塞進 Zod 的 `.refine()`：否決——`.refine()` 失敗會讓
整個陣列驗證失敗或需要額外的 per-item transform 邏輯，且 `knowledgeHits` 是呼叫當下的動態上下文
（不是 schema 能感知的靜態規則），硬塞進 schema 會讓 schema 定義依賴呼叫時的參數，違反 Zod
schema 應該是純資料形狀驗證的慣例。

## 7. 建議卡與知識庫快查在 SSE／HTTP 分工上並不對稱——快查不進 `CopilotAnalysisState`

**Decision**：
- **建議卡**：比照摘要／情緒的既有模式——`SuggestionBlock`（含 `status: AnalysisBlockStatus`）
  併入 `CopilotAnalysisState`，新增 SSE 事件 `suggestion.updated`（整塊覆蓋式，比照
  `summary.updated`/`sentiment.updated`），可重試（FR-012，比照既有 `/copilot/retry` 端點新增
  `block: 'suggestions'` 的合法值）。
- **知識庫快查**：**不使用 SSE、不寫入 `CopilotAnalysisState`**。這是客服主動、即時的查詢動作
  （比對 §12.3「debounce 300ms 的輸入框」），本質是一次 request/response，不是需要背景持續更新、
  跨重連保留的分析狀態——沒有「客服切走再切回，快查結果還在」的需求（spec 沒有這條 FR；跟摘要/
  情緒/建議卡不同，快查結果是這次操作的暫時產物，切走再切回本來就該是空的輸入框）。因此新增一支
  普通的 BFF 端點 `POST /api/conversations/[id]/knowledge-search`，同步回傳 `KnowledgeHit[]`，
  前端用一個新 composable（`useKnowledgeSearch.ts`）管理 loading/error/results，不涉及
  `StateStore`／SSE。

**Rationale**：避免把一個無狀態的請求硬套進「持久化分析狀態＋SSE 推播」的重量級模式——那是為了
「背景仍在跑、切走要保留」這個需求設計的，快查沒有這個需求，硬套只會多出不需要的持久化與跨連線
同步邏輯。

**Alternatives considered**：讓快查也走 SSE（觸發後由 server 推播結果）：否決——多一層非同步與
狀態追蹤的複雜度，換不到任何好處（沒有背景更新、沒有跨頁保留的需求），且與 §12.3 設計稿「debounce
輸入框直接出結果」的即時互動預期不符（同步 HTTP 回應在使用者體感上更直接）。

## 8. 多對話背景分析——目前程式碼「切走即停」的真正原因，以及最小修正點

**證據**（追蹤現有程式碼實際行為，非規格臆測）：

- `useConversationView.ts` 切換 `conversationId` 時，對**前一個**對話送出
  `POST /api/presence { state: 'away', joined: false, … }`——`joined` 被寫死為 `false`，
  不論客服是否真的仍 JOIN 著那個對話。
- `server/api/presence.post.ts` 收到 `state === 'away'` 時，**不論 `joined` 值為何**一律送出
  控制通道訊息 `{ kind: 'unwatch' }`，這會讓 `server/services/session-manager.ts::watchConversation()`
  回傳的 `Unsubscribe` 被呼叫，進而 `releasePipeline()`：若該對話已無其他 watcher，
  `messageSource` 的訂閱直接被取消——**該對話從此收不到新訊息通知，`scheduleIncremental()`
  永遠不會再被呼叫**。這正是憲法 v3.0.0 附錄 C 描述的觸發情境的程式碼根因：不是「背景對話的分析
  邏輯寫成只跑輕量情緒」，而是**背景對話的訂閱本身在切走的當下就被砍斷了**，比規格原先假設的
  問題更底層。

**Decision（最小修正，重用既有基礎設施，不新增平行機制）**：

1. **`useConversationView.ts`**：切換對話時，改送出客服**離開前那一刻**的真實 `viewerJoined` 值
   （即 `detail.value?.viewerJoined`），而非寫死 `false`。
2. **`server/api/presence.post.ts`**：`state === 'away'` 時，依 `joined` 分流——
   `joined === true` → 送出 `{ kind: 'watch', priority: 'background' }`（**不是** `unwatch`，
   訂閱與分析管線持續運作，只是降頻）；`joined === false`（真的沒 JOIN 過，或已 LEAVE）→ 才送
   `{ kind: 'unwatch' }`。**presence-viewing 的清除邏輯不變**（`clearViewing()` 仍然執行——
   「有沒有人在看」與「這個對話還要不要繼續跑背景分析」是兩件事，前者影響 PresenceBar，
   後者影響 Copilot 管線，不應該共用同一個判斷）。
3. **`server/api/stream.get.ts`**：`attach()` 目前對已在 `watched` 裡的 `conversationId` 會直接
   `return`（見 `if (watched.has(convId)) return`），導致同一對話收到「優先度改變」的第二次
   `watch` 訊息時不會真的更新訂閱優先度。改為：若已存在，先呼叫舊的 `Unsubscribe` 再以新優先度
   重新 `attach()`（訂閱本身輕量，重建成本可忽略，`PollingMessageSource.subscribe()` 本來就設計
   成可重複呼叫）。
4. **重新整理／重新連線後的背景管線復原**：目前「客服 JOIN 了哪些對話」只活在**當次 SSE 連線**
   的 `watched` Map 裡，一斷線（含瀏覽器重新整理）就全部遺失，只有客服當下正在看的那個對話會在
   新連線建立後被重新 `attach()`。新增 `StateStore` 方法
   `addJoinedConversation(operatorId, conversationId)` / `removeJoinedConversation(...)` /
   `listJoinedConversations(operatorId): Promise<string[]>`——這是一份**獨立於 watcher refcount**
   的持久記錄（比照 `CopilotAnalysisState` 不掛在 `CopilotSession` 上的理由，見
   `specs/001-sentiment-panel/research.md` #5），由 `join.post.ts`／`leave.post.ts` 維護。
   `stream.get.ts` 建立連線時，先查這份清單，把清單裡除了「即將由客服自己的第一次 presence
   beat upgrade 為 foreground」那個以外的所有對話，一律以 `background` 優先度 `attach()`。

**Rationale**：整個修正都是在**既有的控制通道與訂閱機制**上打補丁，不新增平行的第二套「多對話
訂閱系統」——這正是憲法 2.2「若替換實作需要改動 SessionManager 或任何 API 路由，代表邊界劃錯了」
的反面驗證：這裡不需要改邊界，只需要修兩處判斷邏輯上的錯誤（寫死的 `joined:false`、
`away` 無條件等於 `unwatch`）加一份新的持久化清單。**這也解釋了為何憲法 6.2 的 v3.0.0 修訂條文本身
不需要改「分級機制」的骨架**——附錄 C 已經說明「分級機制本身仍然存在，被推翻的只是『背景分級
= 不跑』這個對應關係」，而程式碼層級的根因分析在此進一步確認：連分級機制都還沒真正跑到「背景」
這一分支，problem 出在訂閱本身沒撐住。

**Alternatives considered**：
- 前端另外維護一份「我 JOIN 過的對話」清單並在重連時主動逐一送 `watch`：否決——這份資訊本來就
  該是後端權威（`join`/`leave` 是我方自己的 API，不依賴 iMBrace 的 `users[]` 参与者限制，見
  §10.2），前端重建一份容易與後端狀態不同步（例如客服在另一台裝置或另一個分頁 LEAVE 了，這個
  分頁的本地清單不會知道）。
- 用 TTL／心跳讓「已 JOIN」自然過期：否決——JOIN／LEAVE 是明確的操作，不是像 presence 那樣需要
  容忍「忘記回報」的模糊狀態；用 TTL 反而會在客服長時間不切換分頁時，讓已 JOIN 的背景對話悄悄
  被判定為過期。

## 9. 背景並行上限與 debounce（FR-021、憲法 6.2）——沿用 `PollingMessageSource` 已有的 aggregate 模式

**Decision**：
- `PollingMessageSource` 新增公開方法 `getPriority(conversationId): WatchPriority`，直接回傳其
  內部 `aggregateState(entry).priority`（該邏輯已存在，只是目前只供輪詢頻率使用，未對外暴露）。
  `MessageSource` 介面（`server/sources/types.ts`）新增此方法簽章。
- `server/services/session-manager.ts` 的新訊息處理流程（原本直接呼叫
  `scheduleIncremental(conversationId, customerMessages)`），改為先取得
  `const priority = runtime.messageSource.getPriority(conversationId)`，一併傳入。
- `copilot-analysis.ts::scheduleIncremental(conversationId, customerMessages, priority)`：
  `priority === 'foreground'` 沿用現行 `DEBOUNCE_MS = 1_000`；`priority === 'background'` 改用
  新常數 `BACKGROUND_DEBOUNCE_MS`（建議 8000，明顯長於前景，數值可於實作階段依 §11.2「建議 10」
  一類的建議值調整，非本 plan 鎖死）。
- 新增模組層級（globalThis-keyed，比照既有單例的 HMR 安全模式）的背景並行計數：一個
  `Set<conversationId>` 記錄「目前正在執行背景重算」的對話，上限常數
  `BACKGROUND_CONCURRENCY_LIMIT = 10`（§11.2 建議值）。背景 debounce 到期時，若集合已達上限
  且本對話不在集合中，**不執行 `runIncremental`，也不清空 `pending`**——保留待處理的訊息，並
  重新排一次相同長度的 debounce（相當於輪詢式重試候補名額），直到有名額釋出。上限判斷與集合的
  增減皆包在 `runIncremental` 的呼叫前後（進入時加入集合、`finally` 移出）。
- `runIncremental(conversationId, newCustomerMessages, priority)`：`priority === 'background'`
  時**跳過 `analyzeSummary()` 呼叫**（憲法 6.2、FR-020），只執行
  `analyzeSentimentBatch()` 與新增的 `analyzeSuggestions()`（決策 5）。

**Rationale**：不新增第二套並行控制機制，直接重用 `PollingMessageSource` 早已為輪詢頻率算好的
「這個對話對任何一位客服而言是不是前景」聚合邏輯——同一份「前景蓋過背景」的規則沒有理由在
AI 分析這一層重新定義一次，否則兩處判斷可能日後跑偏而互相矛盾（例如輪詢認為是前景、AI 分析卻
認為是背景）。

**Alternatives considered**：
- 背景並行採「新的擠掉舊的」（LRU 淘汰最舊的背景任務名額給新任務）：否決——`spec.md` edge case
  明文「暫不重算，待名額釋出或客服聚焦時才處理，MUST NOT 顯示為錯誤狀態」，暗示的是排隊等候而非
  搶占，搶占會讓某個一直有新訊息的背景對話永遠佔用不到名額（飢餓），排隊＋輪詢式重試更公平
  也更簡單實作。

## 10. `catchUpSummary`：客服重新聚焦背景對話時，摘要如何補跑（FR-020、US4 #5）

**Decision**：新增 `copilot-analysis.ts::catchUpSummaryIfStale(conversationId)`，在
`server/api/stream.get.ts::attach()` 每次以 `priority: 'foreground'` 呼叫時觸發（與既有
`sendAnalysisSnapshotAndResume()` 並列呼叫，不是取代）：

```ts
export async function catchUpSummaryIfStale(conversationId: string): Promise<void> {
  const state = await useStateStore().getAnalysisState(conversationId)
  if (!state) return
  const anchor = state.summaryBlock.summary?.basedOnMessageId ?? null
  const since = await /* messageSource.fetchSince 由呼叫端注入或走既有 runtime 取得 */ 0
  // …過濾 sender.type === 'customer'，若為空即已是最新，no-op
  // 否則：先發布 summaryBlock.status = 'analyzing'（讓 UI 顯示「更新中」，US4 #5），
  //       再呼叫 analyzeSummary()，完成後發布最終結果
}
```

比對基準是 `summaryBlock.summary.basedOnMessageId`（既有欄位，冷啟動/前景增量都會更新它），
**不是**情緒時間軸的 `lastCoveredMessageId()`——兩者現在可能不同步（背景期間情緒持續更新、摘要
不動），必須各自追蹤各自的涵蓋進度，不可誤用對方的錨點。

**Rationale**：直接對應 US4 Acceptance Scenario 5「對話摘要則於此時才補跑，並在補跑期間明確標示
更新中」與 FR-020「延後至客服重新聚焦時才補跑」。用既有 `basedOnMessageId` 欄位當比對基準是
零成本的（不需要新欄位），且與「增量分析回傳 patch」（憲法 6.3、§11.6③）的既有機制完全相容——
補跑本質上就是一次遲到的增量分析，只是觸發時機是「重新聚焦」而非「新訊息抵達」。

**Alternatives considered**：另開一個獨立欄位追蹤「摘要涵蓋到哪」：否決——`basedOnMessageId`
已經是為此存在的欄位（見 `shared/types/copilot.ts` 對它的既有註解「版本錨點，用於增量與快取」），
重複開一個欄位只是多一個可能不同步的資料來源。

## 11. 一鍵帶入／插入為回覆覆蓋非空白草稿前的確認（FR-018，憲法 8.4）

**Decision**：新增一個共用的小型確認流程（非新元件，行為層級）：`SuggestionCard.vue` 與
`KnowledgeSearch.vue` 的「一鍵帶入」／「插入為回覆」動作，呼叫前先讀
`useDraft(conversationId).text.value`；非空白時，觸發一個輕量的 inline 確認 UI（沿用既有
`ac-alert-warn` 一類的樣式慣例，而非瀏覽器原生 `confirm()`——後者無法鍵盤導覽測試也不符合
憲法 8.2 的一致互動慣例），確認後才呼叫 `draft.setText(cardText)`；草稿為空白時直接帶入。

**Rationale**：FR-018 與憲法 8.4 都要求「絕不無預警覆蓋既有草稿」，而現有 `useDraft` 尚未有
「帶入前確認」的介面——這是本功能第一次出現「非使用者手動輸入、而是程式主動要覆蓋草稿」的操作，
之前的摘要／情緒面板都是唯讀展示，沒有寫入 Composer 的動作，因此這個確認流程是本功能新增，
不是既有元件的缺陷。

**Alternatives considered**：一律以「附加」而非「取代」的方式插入（草稿後面接上建議文字）：
否決——spec 的 acceptance scenario 明確要求「覆蓋前先確認」，而非自動決定合併策略；附加也可能
產生語意上不通順的混合文字，把決定權交還客服（確認對話框：覆蓋或取消）更符合 FR-018 的字面要求。

## 12. `docs/ARCHITECTURE.md` 里程碑內容同步——知識庫快查從 M3 併入本功能（M2 分支）

**背景**：`docs/ARCHITECTURE.md` §18 目前 M2「內容」只列摘要卡／情緒／建議卡／一鍵帶入，
「知識庫快查（inline 面板）」被列在 **M3**「內容」裡（與「定案知識庫來源」「429 全域佇列」並列）。
但本規格（在 `feat/m2-copilot-panel` 分支上）的 User Story 2 就是知識庫快查，且與建議卡共用同一個
`KnowledgeProvider`（決策 1、4），拆開實作反而要重複組裝一次 provider。

**Decision**：本次 plan 一併把 `docs/ARCHITECTURE.md` §18 的 M2/M3「內容」與 M2「驗收」清單同步：
知識庫快查移入 M2 內容；M3 內容改為「依 #19 RAG 品質的回覆結果，**視情況**由 `AgentKnowledgeProvider`
換上 `VikiKnowledgeProvider`」（拿掉「知識庫快查」子句，換 provider 與知識庫快查本身的 UI/功能是
兩件事）；M2 驗收新增知識庫快查的驗收項。這屬於 CLAUDE.md／CONSTITUTION.md B.3「修訂正典文件後
必須 grep 舊說法」的即時實踐——本節本身就是為此變更留下的紀錄。

**Rationale**：避免「規格已經把知識庫快查排進這個分支，但架構文件的里程碑清單還說它是下一個
里程碑才做」這種正典間互相矛盾的狀態被合併進主幹。

---

## 待補文件同步清單（本次 plan 隨附完成，非留待實作階段）

- [ ] `docs/ARCHITECTURE.md` §18 M2/M3 內容與 M2 驗收清單（決策 12）
- [ ] `docs/ARCHITECTURE.md` 新增 §12.4「知識庫快查已知限制」（決策 3）
- [ ] `docs/IMBRACE_QUESTIONS.md` 新增一題：知識庫檔案的最後修改時間中繼資料、正式 SOP 編號制度
  是否存在（決策 2）
