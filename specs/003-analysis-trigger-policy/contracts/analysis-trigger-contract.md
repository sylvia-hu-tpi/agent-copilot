# 契約：分析管線的觸發、失敗與可見性

**Feature**: `specs/003-analysis-trigger-policy` ｜ **Date**: 2026-08-28

> **本規格不新增、不修改任何對外契約。** 這份文件的用途相反：把「哪些東西**不准**變」寫死，
> 並記錄三條新的**行為不變式** —— 它們沒有型別可以承載，只能靠文件與測試守住。
>
> ⚠️ 本規格修的三處都是「靜默失效」型缺陷：寫錯不會報錯、不會有型別錯誤，
> 只會安靜地做錯事（正是 `CLAUDE.md` 列出的那一類）。因此每條不變式都附「寫錯時的症狀」。

---

## 第一部分：不得變更的既有契約

以下形狀在本規格中**一字不改**。任何 PR 若動到它們，代表實作偏離了 spec.md 的 Assumptions。

### 1.1 SSE 事件（`shared/types/events.ts`）

三個分析事件的形狀不變，**內容也不變** —— 送的仍是整個 Block：

```ts
| { type: 'summary.updated',    conversationId: string, summary:    SummaryBlock }
| { type: 'sentiment.updated',  conversationId: string, sentiment:  SentimentBlock }
| { type: 'suggestion.updated', conversationId: string, suggestion: SuggestionBlock }
```

⚠️ **本規格新增的 `failedBatches` MUST NOT 出現在這三個事件裡。** 它放在
`CopilotAnalysisState` 頂層（server-only），不進任何 Block —— 因為 Block 會整塊送出去。
**寫錯時的症狀**：型別檢查全過、測試全綠，但失敗記錄悄悄流到瀏覽器，等於默默改了契約。
**驗法**：`grep -n "failedBatches" shared/` 必須**零結果**。

### 1.2 重試端點（`POST /api/conversations/:id/copilot/retry`）

```
Request  { block: 'summary' | 'sentiment' | 'suggestions' }
Response 202 { conversationId, block }
錯誤     404（尚無分析狀態）／409（該區塊不是 error 狀態）
```

「全部重試」（FR-018）在**前端**對每個 `error` 區塊各發一次這支端點。
**MUST NOT** 新增 `POST /copilot/retry-all` 或讓 `block` 接受陣列。

### 1.3 `AnalysisBlockStatus`

五個值 `empty | analyzing | retrying | ready | error` **不新增第六個**。
面板的隱藏與收合是呈現層的事，不是區塊狀態 —— 加值會讓每一處既有的 status 判斷都得跟著改。

### 1.4 001 FR-014 的單輪重試預算

最多 2 次、退避 1s→4s、總預算 40 秒、429 不重試 —— **原封不動**。
本規格只處理「那一輪用盡之後」的政策（FR-010）。

---

## 第二部分：三條新的行為不變式

### 不變式 A：`watch` 的冪等性（FR-001、FR-002）

> 對同一個 `conversationId`，以**完全相同**的 `{ priority, joined }` 重複呼叫 `watch()`，
> 除了第一次以外 MUST 不產生任何副作用 —— 不重新 attach、不送快照、不補跑分析、不重建訂閱。

| 觸發來源 | `{priority, joined}` 是否改變 | 應有行為 |
|---|---|---|
| 每 20 秒的 presence 心跳（狀態未變） | 否 | **no-op** |
| 客服切到背景分頁 | `priority` foreground→background | attach |
| 客服切回前景 | `priority` background→foreground | attach（並補跑摘要，002 US4 AC#5） |
| 按下 JOIN | `joined` false→true | attach |
| 按下離開／結案 | `joined` true→false | attach（隨後 `isJoined()` 翻轉，分析停止） |
| SSE 重連／瀏覽器重新整理 | 註冊表為空，視為首次 | attach（送快照，001 FR-010） |
| `restoreJoined()` 復原背景 watch | 註冊表為空，視為首次 | attach，**且 MUST 寫入 `{priority, joined}`** |

⚠️ **`restoreJoined()` 漏寫記錄時的症狀**：它掛上的對話會在 20 秒後的第一次心跳被誤判為「首次」，
於是每條新連線都額外重跑一輪分析 —— 缺陷只縮小而未消除，且只在「重連後恰好滿 20 秒」時出現。

### 不變式 B：每批訊息、每個區塊，最多自動嘗試一輪（FR-005～FR-010）

> 同一個 `(區塊, 該批最後一則訊息 id)` 失敗之後，MUST NOT 再被**自動**分析。
> 只有三件事能讓它再跑：客服手動重試（FR-008）、出現新的客戶發言而形成新的一批（FR-007）、
> 重新 JOIN 走冷啟動（FR-015）。

推論（這些是 SC-001 能否成立的實際判準）：

- **MUST NOT** 有任何形式的自動退避重試時鐘（FR-010）。
- **MUST NOT** 新增「X 秒後自動重試」的倒數文案或事件欄位。
- FR-009 的 rerun（併發合併後再跑的那一次）**MUST 重新過一次失敗記憶檢查** ——
  否則錯誤狀態上會多出一輪呼叫，SC-001 的「不超過 1 輪」立刻被打破。

⚠️ **寫錯時的症狀**：一切正常，只是故障期間的呼叫量不降反升 —— 而且只有在真實故障時才看得出來，
自動化測試若沒做故障注入就永遠是綠的。這正是 2026-08-27 那晚的原始情境。

### 不變式 C：面板可見 ⟺ 該客服已 JOIN（FR-016、FR-016a、SC-006）

> 客服未 JOIN 某對話時：右側面板 MUST 不存在，且伺服器 MUST NOT 把該對話的三個分析事件
> 送給這條連線。中欄所需的其餘事件 MUST 不受影響。

**事件過濾的完整清單**（`server/api/stream.get.ts` 的 `forward()`）：

| 事件 | 未 JOIN 時 | 為什麼 |
|---|---|---|
| `summary.updated` | **過濾** | 面板不在，沒有消費者 |
| `sentiment.updated` | **過濾** | 同上 |
| `suggestion.updated` | **過濾** | 同上 |
| `messages.appended` | 照送 | 中欄的訊息流 |
| `presence.updated` | 照送（仍依收訊者身分重算） | 中欄的 presence 列 |
| `control.updated` | 照送 | 服務模式與 Composer 可用性 |
| `conversation.updated` | 照送 | 側欄清單 |
| `session.opened`／`session.closed` | 照送 | 連線狀態 |
| `stream.heartbeat` | 照送 | 連線保活（**過濾掉會直接斷線**） |

⚠️ **判斷資料 MUST 取自 `WatchRegistration.joined`**（data-model.md §2）——
就是不變式 A 為了心跳去重必須新增的那個欄位。**MUST NOT** 另立第二份「這條連線 JOIN 了哪些對話」
的記錄：兩份必然不同步，而症狀是「面板明明不在，前端 store 卻在背景被更新」，
重新 JOIN 或切換對話時會閃出一份不知何時來的舊內容 —— 極難重現、極難追查。

⚠️ **可見性 MUST NOT 由「Block 是否為 empty」推出**。JOIN 之後、首次分析完成之前三個 Block
都是 `empty`，但那時面板必須已經在（客服要看到「分析中」的骨架）。用內容判斷會讓面板晚一拍才出現。

---

## 第三部分：`MessageSource` 介面的唯一新增

```ts
export interface MessageSource {
  // …既有四個方法不變…

  /**
   * 該對話目前是否**仍有任何人 JOIN**（我方系統內）。
   * 目前無任何訂閱者時回傳 `false`（安全預設，比照 getPriority() 的 'background'）。
   */
  isJoined(conversationId: string): boolean
}
```

- 與既有的 `getPriority()` 完全對稱 —— 同一份 `aggregateState()` 的另一個欄位、同樣的安全預設約定。
- 憲法 2.2 檢核：改動只落在 `polling-message-source.ts` 與測試替身，未擴散到
  `SessionManager` 或 `server/api/**` 的既有職責。M4 換 webhook 實作時照樣要回答這個問題。
- ⚠️ **它答的是「我方系統內」**。同事若直接在 iMBrace 官方介面 JOIN，此方法回傳 `false`
  （`docs/ARCHITECTURE.md` §10.2：平台回傳的 `users[]` 是團隊名冊而非對話參與者）。
  這是既有的平台能力缺口，spec.md「已知限制」已載明，**MUST NOT** 在此處用猜測填補。

---

## 第四部分：留給 M3 的銜接點（FR-020～FR-022）

本規格交付兩個並列出口的**行為與文案**，但只實作到「停止分析 → 隱藏面板」：

| 出口 | 003 交付 | M3 接上 |
|---|---|---|
| 離開對話 | 完整 —— 退出、停止分析、隱藏面板、不留紀錄 | 無 |
| 結案 | 退出、停止分析、隱藏面板（**階段性行為**） | 在「停止分析」與「隱藏面板」之間插入整段結案流程；且屆時**不再**停止分析（FR-023） |

⚠️ **憲法 5.1 是硬性的**：結案摘要 MUST 經客服編輯確認才寫入，**MUST NOT** 做成
「按下結案就自動產生並寫入」，也 **MUST NOT** 做成「閒置逾時自動寫入」——沒有操作就是沒有確認。
003 若把結案實作成「等同離開對話」，M3 接上時**不得**因為「反正已經有一個結案按鈕」
就直接在其後串上自動寫入 —— 中間那道人審是規則本身，不是流程裝飾。

**003 的實作 MUST 讓「結案」是獨立的程式碼路徑**（自己的 handler，FR-022a），
不是「離開對話」的別名或某個參數值 —— 否則 M3 要插入流程時得先把它拆開，
而拆的過程中很容易把兩個出口的差異弄丟。

⚠️ **003 交付的「結案 = 停止分析」是階段性行為，不是要保留的語意。** M3 落地後結案期間
分析照常執行（FR-023，門檻維持 FR-012 的單一條件）。M3 接手時 MUST NOT 把這個差異
當成 regression 而回頭「修正」。

⚠️ **一項待修憲事項會影響 M3 的資料模型**：憲法 5.3 現行的「以 `conversation_id` 為唯一鍵覆蓋」
與「同一對話可被不同人在不同時間結案多次」牴觸。修訂方向為 uuid 主鍵 ＋ **以草稿 id 為冪等鍵**
（保留 5.3 原本要防的「寫入逾時後重按產生重複紀錄」）。MAJOR 變更，**MUST 在 M3 開工前完成**，
詳見 spec.md「待修憲事項」。
