# Contract: `POST /api/presence` 控制通道語意變更（背景 JOIN 持續運作）

這不是新端點，是既有 `server/api/presence.post.ts` 的行為修正——修正後的語意即為本功能對外
（前後端之間）的契約，記錄於此供實作與測試對照，避免退回舊行為。

## 修正前（現況，切走即停）

```
state === 'away' → 一律送 { kind: 'unwatch' }，不論 joined 為何
```

`useConversationView.ts` 切換對話時把 `joined` 寫死為 `false`——結果是任何一次對話切換都會讓
前一個對話的 Copilot 管線被卸載，即使客服其實仍 JOIN 著它。這是憲法 v3.0.0 修訂動機的程式碼根因
（見 `research.md` #8）。

## 修正後

| 呼叫端送出 | `state` | `joined` | 控制通道行為 | presence-viewing |
|---|---|---|---|---|
| 聚焦某對話（既有行為，不變） | `viewing`/`composing`/`joined` | — | `{ kind: 'watch', priority: visible ? 'foreground' : 'background' }` | `reportViewing()` |
| 切走到別的對話，**仍 JOIN 著**（本功能修正） | `away` | `true` | `{ kind: 'watch', priority: 'background' }`（**不是** `unwatch`） | `clearViewing()`（不變——沒人在看這個對話了，presence 要如實反映） |
| 切走、**從未 JOIN 或已 LEAVE**（不變） | `away` | `false` | `{ kind: 'unwatch' }` | `clearViewing()` |

**presence-viewing 與 Copilot 管線的存續是兩件事**：前者回答「現在有沒有人在看」（給
PresenceBar／§10.2 用），後者回答「這個對話的背景分析要不要繼續跑」（給 §11.2 分級用）。修正前
兩者被同一個 `state === 'away'` 分支耦合在一起，是本次要拆開的核心錯誤。

## 呼叫端契約：`joined` 必須是離開前那一刻的真實值

`useConversationView.ts` 切換 `conversationId` 時，送出的 `joined` 值**必須**取自即將被替換掉的
`detail.value?.viewerJoined`（在 `loadAll()` 覆蓋 `detail` 之前讀取），不可寫死常數。這是本契約
唯一要求呼叫端配合修改之處。

## SSE 連線建立時的背景管線復原

`server/api/stream.get.ts` 建立連線（含重連、含瀏覽器重新整理後的全新連線）時，除既有的
「① 訂閱組織事件、② 借憑證」外，新增第零步：

```
const joined = await store.listJoinedConversations(session.operatorId)
for (const convId of joined) {
  await attach(convId, 'background', true)
}
```

客服稍後對「當下實際正在看」的那個對話送出第一次 `POST /api/presence`（頁面 mount 時既有行為）
時，會再送一次 `watch(priority: foreground)`——`attach()` 對已存在的 `watched` 項目**必須**更新
優先度（見 research.md #8 決策 3：不可因為 `watched.has(convId)` 就直接略過）。

## 測試對照

- `test/presence-away-joined.test.ts`（NEW）：`state:'away', joined:true` → 期望送出
  `watch(background)`，`clearViewing()` 仍被呼叫。
- `test/stream-reconnect-background.test.ts`（NEW）：模擬 `listJoinedConversations` 回傳多筆，
  驗證 `attach()` 對每一筆都以 `background` 呼叫，且對「稍後才 focus」的那筆能被第二次 `watch`
  升級為 `foreground`（驗證 `attach()` 的升級路徑，而非被 `watched.has()` 擋下）。
