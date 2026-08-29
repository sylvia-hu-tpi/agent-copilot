# Research: 建議卡的漸進式知識庫引用

**Feature**: `004-progressive-citations` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

本文件記錄 plan 階段的技術決策。每一項都寫「決定／理由／否決的替代方案」；
**數字一律引用 `docs/ARCHITECTURE.md` §8.2b 的實測基準**（第一段 p90 10.31 秒、第二段最慢 13.0 秒、
檢索中位 11.9／p90 16.9／最慢 20.1 秒），不自行推估。

## #1 兩段在哪裡分岔：`analyzeSuggestionsOnce()` 內部，不新增平行管線

**決定**：兩段式落在既有的 `server/services/copilot-analysis.ts::analyzeSuggestionsOnce()` 裡，
把現在的串行「檢索（8 秒逾時）→ `suggest()`」改成：

```
前景：
  t=0  同時啟動  (a) stage1 = withRetry(suggest({ knowledgeHits: [] }))      ← 沿用 001 FR-014 重試
                 (b) retrieval = search(query, { timeoutMs: KNOWLEDGE_SEARCH_TIMEOUT_MS })  ← 30 秒
  (a) 落地 → 白名單／confidence 歸零 → publish ready { citation: 'pending' }
  (b) 回來：
      hits > 0 → stage2 = suggest({ knowledgeHits: hits })（單發，不重試，見 #4）
                 → 白名單 → 有卡 → publish ready { citation: 'cited' }
                            → 全數捨棄／失敗／逾時 → publish { citation: 'none' }（cards 不動）
      hits = 0／失敗／逾時 → publish { citation: 'none' }（cards 不動）
背景：
  serial  retrieval(30 秒) → suggest(hits) 一次產出（FR-013，刻意與前景不一致）
```

**理由**：
- 建議卡的狀態機、失敗批次記憶、`runBlockDeduped()` 去重、`publishBlock()` 整塊覆蓋都已經在這一支
  函式周邊；另起一條「漸進式管線」會讓同一個區塊有兩個寫入者，而 003 才剛把「兩處判斷各自為政」
  修掉。
- 憲法 2.2：`AIProvider.suggest()` 與 `KnowledgeProvider.search()` 的介面**一個字都不用改** ——
  兩段只是同一個 `suggest()` 帶不同的 `knowledgeHits`。這也是 §8.2b「兩段 MUST 共用同一個 agent」
  結論在程式碼層的自然結果。

**否決的替代方案**：
- *新增 `progressive-suggestion.ts` 服務*：會把 `beginAnalyzing`／`finishBlockError`／`updateAnalysisState`
  這些私有工具拉成公開介面，或複製一份。不值得。
- *在 `AIProvider` 層做兩段*（provider 自己先無引用再有引用）：provider 看不到狀態與 SSE，
  而且會讓 `MockAIProvider` 也得懂兩段，測試面翻倍。

## #2 第二段是「尾巴」，不佔去重鎖；過期判定用世代計數

**決定**：`runBlockDeduped()` 的鎖只涵蓋**第一段**（前景）或**整段**（背景）。前景的第二段以
detached promise（下稱**尾巴**，tail）在鎖外繼續跑，並登記在模組層級的
`suggestionTails: Map<conversationId, { generation, stage1Abort, tailAbort, citedLanded, done, lastRetrieval }>`。
每次 `analyzeSuggestionsOnce()` 啟動即 `generation++`；尾巴落地前比對世代，不符即**丟棄不寫入**
（FR-006）。新世代啟動時對前一個尾巴 `tailAbort.abort()`（讓它在還沒送出第二段呼叫時就停，省一次成本；
已在飛的呼叫跑完後被世代比對擋下）。

**理由**：
- 若整個兩段式都待在鎖內，鎖會被握到第二段落地（最壞 JOIN 後 50 秒）。期間新的客戶發言只能排成
  `analysisRerunPending`，等於**新一輪分析被舊的第二段拖慢 50 秒** —— 那正是 FR-006 想避免的方向。
- 世代計數而非比對 `basedOnMessageId`：手動重試會用**同一個**錨點再跑一次（`retryBlock()` 用全量歷史，
  錨點不變），錨點比對會放行舊尾巴覆蓋新結果。世代計數是「哪一次啟動」的身分，沒有這個漏洞。
  `basedOnMessageId` 仍寫進 `SuggestionBlock` 供稽核與 UI（見 data-model.md），但**不拿來做控制判斷**。
- 與 003 的 `analysisInFlight`／`backgroundInFlight` 同一種「純執行期、程序重啟即重來」的狀態，
  多副本的限制也相同（憲法 9.2：換 Redis 前只有單副本）。不另闢持久化。

**否決的替代方案**：
- *尾巴也進鎖，但新觸發時 abort 舊尾巴以提早釋放鎖*：abort 只能擋「還沒送出」的呼叫，已在飛的
  HTTP 沒辦法取消，鎖仍會被握到那次呼叫結束（第一段最多 15 秒、第二段最多 20 秒）。世代比對在鎖外解決同一個問題，且不阻塞。
- *用 `AbortController` 取消檢索 HTTP*：SDK 的 `streamChat()` 未暴露 signal（`docs/SDK_FINDINGS.md`），
  且 `withTimeout()` 只是 `Promise.race`。不做。

## #3 「命中已在手」的來源只有一個：上一世代的檢索備忘

**決定**：FR-005 的「第一段尚未啟動而命中結果已在手」只在**同一對話、同一批次錨點**下成立，
來源是尾巴留下的備忘 `lastRetrieval: { anchor, hits, at }`（放在 `suggestionTails` 同一筆記錄）。
新世代啟動時若 `anchor` 相同且備忘存在 → **不啟動第一段**，直接以備忘的 hits 跑單段（`citation` 依
hits 是否 > 0 為 `'cited'`／`'none'`）。備忘在世代更替時被下一次的檢索結果覆蓋，不另設 TTL
（它跟著 `suggestionTails` 這筆執行期狀態走），並在 `cancelPendingAnalysis()`（LEAVE）時
連同整筆登記一起 `delete`——LEAVE 後沒有人能按重試，備忘從那一刻起就沒有意義，
留著只是讓 Map 逐對話累積（2026-08-29 `/speckit-analyze` 補上，見 data-model.md §4）。

⚠️ **憲法 6.2 的相容性**：沿用備忘不等於「略過檢索」——那次檢索確實跑過，備忘就是它的結果，
且錨點相同保證是**同一批訊息**。憲法 6.2 已於 **v3.0.2** 把量詞由「每一次生成」澄清為
「每一批至少一次，且該批的重新生成 MUST 建立在那次檢索的真實結果上」，正是為了涵蓋這條路徑
與兩段式本身（憲法附錄 C）。跨批次仍是每批一次。

觸發得到這條路的實際情境只有兩個：① 第一段失敗轉 `error`、客服按重試時檢索已回來（spec Edge Cases）；
② 第一段在退避等待、檢索回來了（FR-006a）—— 後者由 #4 的 abort 機制把「重試」變成「不啟動」，
再走到這裡。

**理由**：spec Assumptions 明說「快取鍵不必為兩段各存一份」。真正的快取是 `CopilotAnalysisState` 本身
（同一批次不會重跑，`runBlockDeduped` ＋ 失敗批次記憶已擋住）；備忘只是讓「檢索已經付過錢」這件事
在同一批次內不白費，範圍刻意收到最小。

**否決的替代方案**：*獨立的檢索快取（以 query 雜湊為鍵、TTL 數分鐘）* —— 跨批次的命中會過期
（客戶又說了新的話，query 變了），命中率極低，卻多一份要失效的狀態。

## #4 第二段不重試：擴充 `withRetry()` 的選項，不繞過它

**決定**：`server/services/ai/retry-policy.ts::withRetry()` 新增兩個選項：

```ts
interface WithRetryOptions {
  // 既有：onRetry / callTimeoutMs / budgetMs
  /** 最多自動重試次數；預設 BACKOFF_MS.length（＝2，001 FR-014）。第二段傳 0 */
  maxRetries?: number
  /** 退避等待中被 abort → 拋 RetryAbortedError，呼叫端視為「靜默放棄」而非失敗 */
  signal?: AbortSignal
}
```

第二段呼叫 `withRetry(fn, { maxRetries: 0, signal: tail.tailAbort.signal })`；
第一段呼叫 `withRetry(fn, { onRetry, signal: tail.stage1Abort.signal })`。
`stage1Abort` 在「檢索回來且有命中」或「第二段已落地」時被 abort（FR-006a）；
`tailAbort` 在「新世代啟動」或「`cancelPendingAnalysis()`（LEAVE）」時被 abort。
**abort 只在退避等待與「下一次呼叫送出前」生效**，已在飛的呼叫讓它跑完（spec Q2 決議：已付費的結果
不丟；它落地後若第二段已到，由世代內的 `citedLanded` 旗標擋下不寫入）。

⚠️ **兩個 signal MUST 分開**（2026-08-29 `/speckit-analyze` 修訂）。原設計只有一個 `abort`，
於是第二段在成功路徑上先把它 abort 掉去擋第一段的重試，之後 LEAVE 再 abort 就是 no-op ——
plan 憲法檢核表第七條那句「沒人 JOIN 就不花第二段的錢」變成一句沒有機制支撐的宣稱，
而且不會有任何錯誤。詳見 data-model.md §4。

**理由**：
- `withRetry()` 集中了逾時、失敗分類（`classifyFailure`）、憲法 1.5 的日誌內容約束。第二段若直接呼叫
  provider 再自己包逾時，等於複製一份分類邏輯，而 001 research #2 已經把它收斂到一處。
- `maxRetries: 0` 讓「不重試」是**呼叫端的明示選擇**，程式碼註解能寫理由（FR-014 要求）；且 001 FR-014
  的三個數字（15s／1s→4s／40s）**一個都不動** —— 它們只在 `maxRetries > 0` 時有意義。
- 這是 001 FR-014「暫時性失敗 MUST 自動重試」的明確例外，004 FR-014 已宣告；需在 001 spec 的
  FR-014 加一行指向 004（CLAUDE.md 的 grep 規則：例外不能只寫在例外那一邊）。

**否決的替代方案**：*第二段也重試但 budget 縮短* —— 仍會多一次完整的第二段呼叫（20 秒，見 #5），
落地時間推到 JOIN 後 70 秒以上；spec Q5 已否決。

## #5 第二段的單次逾時：**20 秒**（2026-08-29 裁決），以獨立常數承載

**決定**：第二段呼叫 `withRetry(fn, { maxRetries: 0, callTimeoutMs: SUGGESTION_STAGE2_CALL_TIMEOUT_MS })`，
常數 `= 20_000`。

✅ **2026-08-29 已裁決為 20 秒**（本文件原建議、spec 原字面為 15 秒）。spec FR-003、
Clarifications Q3／Q5、已知限制的「50 秒」、plan Constraints 與 data-model §5 皆已同步改寫。
下表是裁決依據，保留原貌：

| | 15 秒（spec 字面） | 20 秒（本文件建議考慮） |
|---|---|---|
| 實測第二段最慢（n=15） | 13.0 秒，餘裕 2.0 秒（13%） | 餘裕 7.0 秒（35%） |
| 平台漂移 36% 後的最慢 | 13.0 × 1.36 ≈ **17.7 秒 → 逾時** | 仍在內 |
| 逾時的後果 | 第二段**靜默**落成 `'none'`（不重試、不轉 error），該對話拿不到引用 | — |
| 對 SC-002（90% 取得引用）的影響 | 漂移日可能整段時間窗全數逾時 | 幾乎不受影響 |
| 最壞落地時間 | 30 ＋ 15 ＝ 45 秒（spec 已知限制的數字） | 30 ＋ 20 ＝ 50 秒 |
| 與 001 FR-014 三數綁定的關係 | 無 | **無** —— 綁定（`1+15+4+15=35 ≤ 40`）只存在於重試迴圈；第二段 `maxRetries: 0`，不進迴圈，改它不需要動退避預算 |
| 要改的文件 | — | 004 spec FR-003／Clarifications Q3／已知限制的 45 秒；`ARCHITECTURE.md` §8.2b「FR-014 的裁決」一段 |

§8.2b 明文「FR-014 的裁決 MUST 在 004 的設計定案後才做，判準應以第二段為準」——設計現在定了：
第二段是**單發、無人等待、失敗靜默**的呼叫，它跟 001 那個「有人在等、失敗會轉 error、有退避預算」的
迴圈是兩種東西，用同一個數字只是巧合而非耦合。**本文件建議第二段改 20 秒、第一段維持 15 秒不動**
—— ✅ 該建議已於 2026-08-29 採納，`SUGGESTION_STAGE2_CALL_TIMEOUT_MS = 20_000`。
**001 FR-014 的 15s／1s→4s／40s 三數一字不動**，退避預算不需重議（綁定只存在於重試迴圈，
第二段 `maxRetries: 0` 不進迴圈）。`docs/ARCHITECTURE.md` §8.2b「FR-014 的裁決」段由 tasks T027 落定。

## #6 `SuggestionBlock` 新增三個欄位，`status` 五態機不變

**決定**：`citation: 'pending' | 'cited' | 'none'`、`basedOnMessageId: string | null`、
`provenance: { stage: 1 | 2, stage1RetryAttempt: number }`。完整定義與轉移表見 data-model.md。
`status` 在第二段等待期間**維持 `'ready'`**（卡片可用），不新增 `'updating'` 狀態。

**理由**：
- 五態機是三個區塊共用的（`AnalysisBlockStatus`），加一個只有建議卡用的狀態會污染摘要／情緒的
  型別與 UI 分支。`citation` 是建議卡自己的正交維度。
- `basedOnMessageId` 有既有先例（`ConversationSummary.basedOnMessageId`），語意相同：這批產物依據到
  哪一則訊息。
- `provenance` 是 FR-014／SC-005 的稽核證據（spec Assumptions 要求能回答「第一段還是第二段」
  「第一段重試了幾次」）；`knowledgeSearch { ran, hitCount }` 維持原語意（憲法 6.2 v3.0.1）。

**否決的替代方案**：*用 `retryAttempt`／`updatedAt` 反推*——`retryAttempt` 在 `ready` 時已被清空，
反推不出。

## #7 「更新提示」在前端由狀態轉移推導，後端不送額外事件

**決定**：`useCopilotSession.ts::handle()` 在收到 `suggestion.updated` 時比對前後兩個 block：
`prev.citation !== 'cited' && next.citation === 'cited' && prev.cards.length > 0` → 設定
`suggestionCitedAt = Date.now()`；`SuggestionList.vue` 據此顯示區塊層級提示（圖示＋文字，`role="status"`），
5 秒後自動淡出；切換對話或新一批 `pending` 到達時清除。

**理由**：SSE 契約是「整塊覆蓋」（001 contracts/copilot-sse-events.md），事件裡不帶「這次是不是替換」
這種**只對 UI 有意義的旗標** —— 重連快照送的也是同一個 block，若旗標在 block 裡，重連會再閃一次提示。
轉移由消費端推導，快照不會觸發（快照時 `prev` 是 `emptySuggestionBlock()`，`cards.length === 0`）。

**否決的替代方案**：*新增 `suggestion.cited` 事件*——多一個事件型別、多一份契約，且重連快照仍要另外處理。

## #8 檢索逾時常數：刪除 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`，不留別名

**決定**：刪除 `server/services/knowledge/agent-knowledge-provider.ts` 的 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`
與其 40 行註解（那段註解的結論「建議卡目前拿不到引用」正是本功能要終結的現況），建議卡路徑改傳
`KNOWLEDGE_SEARCH_TIMEOUT_MS`（spec FR-003：MUST NOT 另訂數字）。`shared/types/knowledge.ts` 的
`search()` 文件註解同步改寫；`test/copilot-analysis.test.ts` 對它的 import 與斷言移除；
`test/contract-guards.test.ts` 新增守衛：`server/` 底下不得再出現 `SUGGESTION_RETRIEVAL_TIMEOUT_MS`
（防止有人為了「讓第一段更快」把短逾時加回來——那會讓第二段永遠等不到命中，且不報錯）。

**理由**：留一個 `= KNOWLEDGE_SEARCH_TIMEOUT_MS` 的別名會讓兩者日後又各自漂移，回到 002 那個「兩個數字」
的狀態；FR-003 的意思是「同一個數字」，程式碼就該只有一個識別項。

## #9 背景路徑的實作：同一支函式、一個 `strategy` 參數

**決定**：`analyzeSuggestionsOnce(conversationId, input, strategy: 'progressive' | 'single')`。
`runIncremental()` 的背景分支傳 `'single'`；冷啟動（JOIN 者必為前景）、前景增量、手動重試傳
`'progressive'`；`'single'` 也是 #3「命中已在手」時的執行路徑。函式開頭的註解 MUST 寫明
FR-013 的理由（背景沒有人在等、第一段沒有人會看到、省的是背景並行上限 10 個對話份的呼叫），
否則會被當 bug 修回一致。

**否決的替代方案**：*背景也走兩段但不 publish 第一段*——仍付第一段的 AI 呼叫成本，只是不顯示；
spec Clarifications 已否決。

## #10 測試策略：以 `MockAIProvider`／`MockKnowledgeProvider` 的延遲開關控制交錯順序

**決定**：既有 mock 都有 `*DelayMs` 與 `*Failure` 開關，兩段的交錯順序（第一段先／檢索先／第二段先於
第一段重試落地）全部用延遲組合＋`vi.useFakeTimers()` 重現，不引入新的測試替身。
新增 `awaitSuggestionTail(conversationId)`（僅供測試）等待尾巴結束，避免測試用 sleep 猜時間。
AI 呼叫次數的上限（FR-014）以「`suggest()` 被呼叫的次數」直接斷言。

`smoke:realtime` 用的是 Mock provider，檢索零延遲 → 第一段與第二段幾乎同時落地；為了在 smoke 觀察到
`pending → cited` 序列，`MockKnowledgeProvider` 新增環境變數 `AC_SMOKE_KNOWLEDGE_DELAY_MS`（比照既有
`AC_SMOKE_FORCE_KNOWLEDGE_FAILURE`，只在已退回 Mock 的路徑生效）。

## #11 未解決／留待實作觀察

- 前景兩段同時啟動時，檢索與第一段各自打 iMBrace；`callAgent()` 目前未傳 `user_id`（§8.2b），
  兩段各多一趟 `auth/user` 往返（54ms）。該修正屬衛生問題、與本功能正交，**不併入本 feature**，
  另立 chore。
- `sendAnalysisSnapshotAndResume()` 重連時送的是當下的 block；若當下 `citation: 'pending'` 而尾巴
  仍在跑，客服重連後會看到 pending，尾巴落地時再收到 cited——行為正確，不需特別處理；但若程序重啟
  （尾巴消失），block 會永遠停在 `pending`。**處置**：重連快照送出前，若 `citation === 'pending'`
  且 `suggestionTails` 沒有該對話的尾巴 → 改寫為 `'none'` 再送（並寫回狀態）。單副本下這是唯一會讓
  「尚未」永久卡住的路徑。
