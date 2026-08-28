# Data Model：分析管線的觸發與失敗政策

**Feature**: `specs/003-analysis-trigger-policy` ｜ **Date**: 2026-08-28 ｜ 決策理由見 [research.md](./research.md)

> 本規格**不新增任何持久化形狀**，也不新增任何跨越 SSE 的欄位。
> 下面三個實體：一個附著於既有的 `CopilotAnalysisState`（§1），兩個是純執行期狀態（§2、§3）。
>
> ⚠️ **貫穿全文的一條約束**：SSE 的 `summary.updated`／`sentiment.updated`／`suggestion.updated`
> 送的是**整個 Block**（`publishBlock()`，`server/services/copilot-analysis.ts:140`）。
> 因此「放進 Block」＝「送到瀏覽器」＝「改了對外契約」，而型別檢查抓不到這個違反。
> 本規格所有新欄位一律**不在 Block 內**。

---

## §1 失敗批次記憶（`FailedBatch`）— FR-005～FR-008、FR-011

### 形狀

```ts
// server/state/types.ts
export interface FailedBatch {
  /** 這一批訊息的最後一則客戶訊息 id —— 判定「是不是同一批」的鍵（FR-005） */
  lastMessageId: string
  /** 這一批最近一次失敗的時間（ISO8601），供診斷與日後可能的觀測需求 */
  at: string
  /** 這一批累計失敗次數 —— 手動重試也失敗時遞增（spec.md edge case） */
  count: number
}

export interface CopilotAnalysisState {
  conversationId: string
  summaryBlock: SummaryBlock
  sentimentBlock: SentimentBlock
  suggestionBlock: SuggestionBlock
  /**
   * 新增（specs/003-analysis-trigger-policy）。
   * ⚠️ MUST 留在頂層，MUST NOT 併入任一 Block —— Block 會整塊經 SSE 送出。
   */
  failedBatches?: Partial<Record<AnalysisBlock, FailedBatch>>
}
```

`AnalysisBlock = 'summary' | 'sentiment' | 'suggestions'`（既有，`server/services/copilot-analysis.ts:46`）。

### 為何鍵是「區塊 ＋ 最後一則訊息 id」

這是 spec.md Clarifications 定案的**自癒機制的支點**，不是任意選擇：

```
客戶再說一句話 → 該批的最後一則變了 → 不再是同一批 → FR-007 自動再試一次
```

FR-010 之所以能夠成立（不加第二層自動退避重試），完全依賴這條路徑。若鍵改成「對話層級」或
「時間窗」，「對話還活著」的自癒就會消失，錯誤狀態會變成永久紅燈。

**為何不用訊息 id 集合的雜湊**：批次一律是時間上連續的尾段，最後一則不同即代表新的一批。
雜湊更精確但換不到任何行為差異，只多一份要維護的推導邏輯。

### 讀寫時機

| 動作 | 時機 | FR |
|---|---|---|
| **讀**（決定要不要跑） | 各區塊分析**進入點**，在 `beginAnalyzing()` 之前 | FR-006 |
| **寫**（記錄失敗） | `finishBlockError()`，需由呼叫端傳入該批的 `lastMessageId` | FR-005 |
| **清**（手動重試） | `retryBlock()` | FR-008 |
| **清**（冷啟動／重新 JOIN） | `runColdStart()` | FR-015 |
| **清**（分析成功） | 各成功寫入路徑 | 隱含 |

⚠️ **`beginAnalyzing()` 不是清除點**。直覺上會想寫在那裡（「開始分析就清掉」），但它是每次分析的
**共同入口**，包含被記憶擋下之前就已排入的那些 —— 寫在那裡會讓 FR-006 完全失效。
記憶必須在「決定要不要跑」之前被讀到，且只在有理由相信這次會不一樣時才清（research.md 決策 8）。

### 生命週期

跟隨 `CopilotAnalysisState` 的 2 小時 sliding TTL，**不另訂保存期限**（FR-011）。
spec.md 的 edge case「失敗記憶存活期間對話一直沒有新發言，直到分析狀態過期」因此不需要任何
額外程式碼 —— 記憶就在同一筆記錄裡，隨之消失，此後的觸發視同全新的一批。

多副本共享不在本規格範圍（spec.md Assumptions：M4 換上 Redis 時隨 `CopilotAnalysisState` 一起遷移）。

### `finishBlockError()` 的簽章變更

目前 `finishBlockError(conversationId, block, err)` 不知道「這批到哪一則」。需新增第四個參數
`batchLastMessageId: string | null`；為 `null` 時（例如 `retryBlock()` 走全量歷史而歷史為空）
不寫入記憶 —— 沒有可判定的批次，寧可下次再試一次，也不要用一個假的鍵擋住未來的分析。

---

## §2 監看登記狀態（`WatchRegistration`）— FR-001～FR-004

### 形狀

```ts
// server/utils/stream-control.ts，createWatchRegistry() 的閉包內
interface WatchRegistration {
  /** 解除這次監看（退訂 topic + 解除 watcher）—— 既有的 Map<string, () => void> 值 */
  off: () => void
  /** ⚠️ 新增：上一次 attach() 用的參數。判斷「這次是真變化還是週期心跳」的唯一依據 */
  priority: 'foreground' | 'background'
  joined: boolean
}
```

原本的 `watched: Map<string, () => void>` 改為 `Map<string, WatchRegistration>`。

### 判定規則

```
watch(convId, priority, joined):
  prev = watched.get(convId)
  if (prev && prev.priority === priority && prev.joined === joined)
      → 週期心跳，什麼都不做（FR-001）
  else
      → 真實變化或首次監看：prev?.off()，attach()，記下新的 {priority, joined}（FR-002）
```

### 三條既有規則為何仍然成立

| 既有規則 | 出處 | 為何不受影響 |
|---|---|---|
| **重連復原**：連線建立時把已 JOIN 的對話以 background 掛回 | `stream-control.ts:76` ① | 新連線的 `watched` 是空的 → `prev` 為 undefined → 必定算「有變化」。⚠️ **但 `restoreJoined()` 也 MUST 寫入 `{priority, joined}`**，否則它掛上的對話會在 20 秒後的第一次心跳被誤判為首次而重跑一次 |
| **優先度升級 MUST NOT 略過** | `stream-control.ts:79` ② | background→foreground 是 `priority` 改變 → 算「有變化」→ 照常 attach → 摘要照常補跑（FR-004、002 US4 AC#5） |
| **001 FR-010 重連快照 2 秒門檻** | 001 spec | 同「重連復原」—— 首次必定 attach，快照照送（FR-003） |

### 生命週期

純執行期、per-SSE-連線，隨 `closeAll()` 一併消失。程序重啟後全部重建，無持久化需求。
`unwatch()` 刪除條目時連同記錄一併刪除 —— 下次 `watch()` 因此會被正確地視為「首次」。

---

## §3 同區塊併發去重狀態 — FR-009

### 形狀

```ts
// server/services/copilot-analysis.ts，模組層
/** 鍵：`${conversationId}:${block}` */
const analysisInFlight = new Map<string, Promise<void>>()
/** 同鍵。標記「這次跑完後還要再跑一次」——旗標而非佇列，見下 */
const analysisRerunPending = new Set<string>()
```

### 規則

```
runBlock(convId, block):
  key = `${convId}:${block}`
  if (analysisInFlight.has(key))
      analysisRerunPending.add(key)   // 合併，MUST NOT 直接丟棄（FR-009）
      return
  執行 → finally:
      analysisInFlight.delete(key)
      if (analysisRerunPending.delete(key)) 再跑一次
```

### 三個容易寫錯的地方

1. **粒度必須是「對話 ＋ 區塊」，不是對話**。三個區塊本來就是 `Promise.all` 併行的
   （`runColdStart()`、`runIncremental()`）；用對話粒度會把它們串成序列，直接拖慢 002 SC-001 的
   3 秒／10 秒門檻。
2. **不可與既有的 `stateLocks` 合併**（`copilot-analysis.ts:121`）。那份保護的是**狀態寫入**不互相
   覆蓋，粒度是整個對話，而且它會把兩份分析**依序都跑完** —— 那是序列化，不是去重。兩者解決不同問題。
3. **rerun 那一次 MUST 重新過一次 §1 的失敗記憶檢查**。否則「失敗 → 期間又被觸發 → rerun 無視記憶
   再跑一次」會在錯誤狀態上多出一輪呼叫，把 SC-001 的「不超過 1 輪」打破。

**為何是旗標而非佇列**：合併語意是「至少再跑一次最新的」。累積 N 次觸發就跑 N 次沒有意義 ——
分析的輸入是當下的狀態，不是被合併掉的那些事件。

---

## §4 待清除的排程（`cancelPendingAnalysis`）— FR-013

不是新的資料形狀，是既有 `debounceTimers`（`copilot-analysis.ts:735`）的一個新出口：

```ts
export function cancelPendingAnalysis(conversationId: string): void {
  const pending = debounceTimers.get(conversationId)
  if (!pending) return
  clearTimeout(pending.timer)
  debounceTimers.delete(conversationId)
}
```

⚠️ **這是清理層，不是保證層**。真正的保證是 `runIncremental()` 在 debounce **觸發的當下**檢查
`isJoined()` —— 那涵蓋所有路徑（心跳補跑、`onMessages` 增量、背景名額釋出後的重排），
且判斷的是觸發時的真實狀態而非排入時的。只做清理會漏掉「背景名額滿時 `runIncremental()` 自己
重新 `scheduleIncremental()`」那條路（research.md 決策 4）。

---

## §5 面板可見性與收合偏好（前端，無新契約）— FR-016、FR-016a、FR-017、FR-017a

### 5.1 可見性：一個布林的衍生，沒有新實體

```
面板是否呈現 ⟺ view.viewerJoined === true
```

就這一條。`viewerJoined` 是既有狀態（`useConversationView.ts:81`，由 `detail.viewerJoined` 推出，
JOIN／LEAVE 當下即時翻轉）。**不需要任何新的資料形狀**，也不參考 `presence.updated` ——
「有沒有別人 JOIN」與「我的面板要不要出現」是兩個問題，本規格刻意讓後者只取決於前者。

⚠️ **MUST NOT 用「三個 Block 是否為 empty」當作可見性條件**。JOIN 之後、首次分析完成之前，
三個 Block 都是 `empty`，但那時面板 MUST 已經在（客服要看到「分析中」的骨架，
`05-copilot-panel_4status_01.png` 第三態）。用內容判斷可見性會讓面板在 JOIN 後晚一拍才出現。

### 5.2 伺服器端的推播過濾（FR-016a）

前端不渲染還不夠 —— 伺服器 MUST 不把三個分析事件送給未 JOIN 的連線。

| 事件 | 未 JOIN 時 |
|---|---|
| `summary.updated`／`sentiment.updated`／`suggestion.updated` | **MUST 過濾** |
| `messages.appended`／`presence.updated`／`control.updated`／`conversation.updated`／`stream.heartbeat` | **MUST NOT 過濾** —— 服務的是中欄，與 JOIN 無關（US2 AC#3） |

過濾點：`server/api/stream.get.ts` 的 `forward()` —— 它本來就是「依收訊者自己的身分決定送什麼」
的那一層（目前已在為 presence 做同樣的事）。

判斷資料來自 **§2 的 `WatchRegistration.joined`** —— 決策 1 為了心跳去重本來就要新增的那個欄位。
⚠️ 同一份新狀態同時餵兩個需求，**MUST NOT** 另立第二份「這條連線 JOIN 了哪些對話」的記錄，
否則兩份必然不同步，而症狀會是「面板明明不在，內容卻在背景被更新」這種查不出來的鬼影。

### 5.3 收合偏好（FR-017a）

```ts
/** localStorage 鍵；per 對話。同一瀏覽器的不同客服由既有 session 隔離 */
`ac.copilotCollapsed.${conversationId}` → '1' | '0'
```

| 決策 | 內容 | 理由 |
|---|---|---|
| 粒度 | **每個對話各自記** | 客服對不同對話的依賴程度不同。一份全域偏好會讓「上一個對話收起來了，下一個也跟著收起來」，而那不是他的意思 |
| 儲存位置 | `localStorage`，比照既有 `ac.copilotWidth` | 純個人視覺偏好，不需跨裝置同步，也不該進伺服器狀態 |
| 預設值 | 未存過 → **展開** | JOIN 的目的就是要用面板；預設收起會讓新對話每次都要多按一次 |
| 與 JOIN 的關係 | **正交** | 收合不影響分析（FR-017b）；未 JOIN 時面板與收合按鈕都不存在，偏好值原封保留，下次 JOIN 時沿用 |

⚠️ 鍵以 `conversationId` 為字尾會隨對話數線性成長。對話數量級為數十至數百（`§9.3` 實測單一組織
的清單規模），且值只有一個字元，不需要淘汰機制；若日後需要，清理是純本地行為，不影響任何契約。

---

## §6 未變更但需確認未退步的既有形狀

| 形狀 | 為何列出 |
|---|---|
| `SummaryBlock.firstFailureAt`／`retryAttempt` | 是**單輪重試序列**的狀態（001 FR-014 的 40 秒預算），語意是「這一輪從何時開始失敗」。⚠️ MUST NOT 被挪用為失敗批次記憶 —— 會讓兩個 FR 綁死在同一欄位上 |
| `SentimentBlock.timeline` | 失敗時**仍然不推進**（那是正確的：沒分析成功就不該有點）。本規格不改這個行為，改的是「不推進」不再等於「會被無限重跑」 |
| `AnalysisBlockStatus` 五個值 | 不新增值。面板的可見與收合是面板層的呈現，不是區塊狀態 —— 加第六個值會讓所有既有的 status 判斷都要跟著改 |
| 重試端點的請求／回應 | `{ block }` → 202 `{ conversationId, block }`，一字不改（FR-018 的「全部重試」對每個 error 區塊各發一次） |
