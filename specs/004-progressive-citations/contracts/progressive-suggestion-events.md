# Contract: 漸進式建議卡的 SSE 序列與消費端保證

沿用 `specs/002-suggestion-knowledge-search/contracts/copilot-suggestion-events.md`
（`suggestion.updated`、整塊覆蓋、重連快照、重試 API），本文件只規定**兩段式帶來的序列與欄位語意**。
事件型別不新增。

## 1. 事件與欄位

```ts
{ type: 'suggestion.updated', conversationId: string, suggestion: SuggestionBlock }
// SuggestionBlock 新增：citation / basedOnMessageId / provenance（data-model.md §1）
```

## 2. 前景兩段式的序列保證（伺服器端）

同一批客戶訊息（同一世代），伺服器 MUST 依下列順序之一送出，**不會有其他順序**：

| 情境 | 序列（每行一個 `suggestion.updated`） |
|---|---|
| 正常：第一段先落地，第二段有命中且成功 | `analyzing` → `ready/pending`（第一段卡）→ `ready/cited`（第二段卡） |
| 檢索無命中／失敗／逾時 | `analyzing` → `ready/pending` → `ready/none`（**cards 與前一則完全相同**，只有 `citation`／`knowledgeSearch`／`updatedAt` 變） |
| 第二段失敗／逾時／全數遭白名單捨棄 | 同上一列 |
| 命中已在手（research.md #3）／背景對話 | `analyzing` → `ready/cited`（或 `ready/none`）—— **沒有 `pending`** |
| 第一段重試中、第二段先落地（FR-006a） | `analyzing` → `retrying` → `ready/cited`；之後 MUST NOT 再出現該世代的 `pending` |
| 第一段用盡轉 error | `analyzing` → `retrying`×n → `error`；尾巴若之後有命中，MUST NOT 自行把 `error` 改成 `ready`（那要等客服按重試；重試時走「命中已在手」單段） |
| 第一段被取消（FR-006a）且第二段也失敗 | `analyzing` → `retrying`×n → `error`（FR-003a ②）——第一段從未發布，客服手上沒有卡，MUST NOT 停在 `retrying`，也 MUST NOT 送出 `cards` 為空的 `ready` |
| 新一批訊息到達、舊尾巴仍在飛 | 新世代的 `analyzing` 之後，舊世代的任何事件 MUST NOT 再出現 |

⚠️ **`ready/none` MUST NOT 早於 `ready/pending`**（FR-003a ①）。上表第二、三列的 `none` 落定
MUST 等第一段落定後才送出——檢索可能比第一段先回來（實測不罕見），先送 `none` 會被隨後落地的
第一段寫回 `pending`，而該輪已無路徑再落定它。`'none' → 'pending'` 不是合法序列。

**時序上限**（前景，自 `analyzing` 起算）：
- `pending`：**最晚約 40 秒**——由 001 FR-014 的 `BUDGET_MS = 40_000` **總預算**截斷，
  不是「15 秒 × 次數」。實際序列是 15（首次逾時）＋1（退避）＋15＋4＋15 ＝ 50 秒 > 預算，
  因此第三次呼叫在最壞情境下發不完就被預算切掉。⚠️ 本行原寫「15 秒 × (1 + 重試次數)」，
  忽略了退避等待與總預算兩者，2026-08-29 `/speckit-analyze` 訂正。
- `cited`／`none`：最晚 30 秒（檢索）＋ `SUGGESTION_STAGE2_CALL_TIMEOUT_MS`（20 秒）＝ **50 秒**。
  ⚠️ FR-003a ① 讓 `none` 還要等第一段落定，因此嚴格說是 `max(檢索＋第二段, 第一段預算 40 秒)`——
  仍是 **50 秒**，上限不變（第一段的 40 秒預算短於 50 秒）。
沒有「`pending` 永久不落定」的合法序列——唯一會造成它的路徑（程序重啟、尾巴消失）由重連快照修正（§4）。

## 3. 消費端保證（`app/composables/useCopilotSession.ts`、`SuggestionList.vue`）

- **整塊覆蓋不變**：收到即以 `evt.suggestion` 取代，不做 partial merge。
- **更新提示由轉移推導，不由事件旗標**（research.md #7）：
  `prev.citation !== 'cited' && next.citation === 'cited' && prev.cards.length > 0` → 顯示提示。
  重連快照不會觸發（快照前 `prev` 是空 block）。提示 5 秒後自動淡出；切換對話、或收到新一批
  `analyzing`／`pending` 時立即清除。
- **提示 MUST 為圖示＋文字**（憲法 8.1），容器 `role="status"`（`aria-live="polite"`），
  文案 `copilot.suggestion.citedUpdated`。
- `citation` 決定區塊與卡片的標示：

  | `citation` | 區塊標頭 | 卡片來源列（`sopTitle` 為 null 時） |
  |---|---|---|
  | `'pending'` | 「尚未引用知識庫・檢索中」＋轉圈圖示 | 「尚未引用知識庫」（`noKnowledgeRefPending`） |
  | `'cited'` | （無額外標頭；剛落地時顯示本節上方的更新提示） | 「未引用知識庫」（既有 `noKnowledgeRef`） |
  | `'none'` | （無） | 「未引用知識庫」（既有 `noKnowledgeRef`） |

- **重試按鈕**：規則不變——只在 `status === 'error'` 可按。`pending` 期間與期滿後都不是 error，
  因此 MUST NOT 出現可按的重試（spec Edge Cases）。
- **Composer**：本 composable MUST NOT import `useDraft`／觸碰 Composer 狀態（FR-008）。
  `test/contract-guards.test.ts` 以原始碼掃描守住。⚠️ 這是**靜態**守衛，不是 SC-003 的行為驗證——
  「第二段更新時 Composer 一字不變」目前只有 quickstart US2 的手動場景在驗（見 quickstart 覆蓋表註記）。

## 4. 重連快照的補充

`sendAnalysisSnapshotAndResume()` 送 `suggestionBlock` 前：若 `citation === 'pending'` 且
`suggestionTails` 沒有該對話的尾巴（程序重啟過），MUST 先把 `citation` 改為 `'none'` 寫回狀態再送——
否則客服會永遠看到「檢索中」。有尾巴在跑時照送 `pending`，尾巴落地會再推一次。

## 5. 重試 API（`POST /copilot/retry { block: 'suggestions' }`）

契約不變（002 contracts）。語意補充：重試啟動新世代；若上一世代的尾巴已留下**同一錨點**的檢索備忘，
`retryBlock()` 走單段、不啟動第一段（research.md #3、spec Edge Cases「第一段失敗、檢索仍在等」）。
⚠️ 判準是「該批檢索已完成並留下結果」，**`hits` 為空陣列同樣成立**（spec FR-003a 之外的另一項
2026-08-29 裁決，見 spec FR-005）：此時單段照樣重新生成一批卡並把標示落定為 `'none'`，
但 MUST NOT 再發一次檢索。序列與上表「命中已在手」那一列相同：`analyzing` → `ready/none`，沒有 `pending`。

## 6. 第二段整批換卡時的搶答標記（FR-015）

`cards` 有第三個寫入者 `checkSuggestionsSuperseded()`，它由訊息到達驅動、不受世代管轄
（data-model.md §8）。伺服器在**前景第二段**整批覆蓋 `cards` 前，MUST 把該次尾巴等待期間抵達的
同事／AI 回覆重新套用一次搶答標記，順序在白名單與 `confidence` 歸零之後。
回覆本身由 `checkSuggestionsSuperseded()` 於訊息抵達當下留存在尾巴上——
**MUST NOT** 從分析函式手上的那份歷史推導（那裡沒有同事回覆，會靜默 no-op，見 data-model.md §8）。
消費端不需要知道這件事——它收到的仍是一個已標記完成的 block。

⚠️ **本條只涵蓋前景第二段。** 背景單段與「命中已在手」單段沒有尾巴，也就沒有留存位置；
它們的整批覆蓋期間若恰好有人搶答，標記仍可能被抹掉。殘餘風險有界（單次生成，窗口約 10～20 秒，
且抵達落在覆蓋之後仍會補上），本規格接受，**MUST NOT** 把它寫成已保護——
本節原寫「任何整批覆蓋 `cards` 的路徑」，2026-08-29 訂正。
