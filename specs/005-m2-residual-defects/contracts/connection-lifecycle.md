# 契約：連線生命週期與計數（US1）

**Spec**: [../spec.md](../spec.md)（FR-001～FR-006a、SC-001／SC-002／SC-002a）
**日期**: 2026-09-02

> 這份契約回答一件事：**一條 SSE 連線的出現與消失，各自會讓哪些計數變動。**
> 本規格的所有靜默失效都出在這張表被某一處寫成「以客服身分為單位」。

---

## §1 三個層級，不要混

| 層級 | 單位 | 誰持有 | 消失的條件 |
|---|---|---|---|
| **連線** | `connectionId`（server 端 UUID） | 憑證登記、`session.watchers`、`pipeline.refs` | 這條連線關閉，或存活兜底逾期 |
| **分頁** | `clientId`（前端 `sessionStorage`） | 控制通道 topic、心跳定址 | 分頁關閉（⚠️ 可能與另一分頁重複，見 §4） |
| **客服** | `operatorId` | presence、JOIN 持久紀錄、主動離開 | 該客服 LEAVE 或所有連線消失 |

⚠️ **「主動離開」是客服層級，「關掉分頁」是連線層級 —— 兩者 MUST NOT 共用清理路徑。**
今天它們天然是分開的（LEAVE 走 `removeJoinedConversation()` ＋ 廣播 `control.updated`，
完全不經 `watchers`）。本規格 MUST NOT 把它們接在一起（SC-002a）。

---

## §2 連線建立時（`stream.get.ts`）

```
connectionId = crypto.randomUUID()          // server 端產生，不信任 client
registerCredential({ connectionId, clientId, operatorId, orgId, accessToken })
  → 新增一筆登記，lastSeenAt = now
```

`attach(conversationId)` 時（每條連線每個對話一次）：

```
watchConversation({ conversationId, connectionId, operator, ... })
  → session.watchers.push({ operatorId, connectionId })
  → pipeline.refs++（0→1 時建立 publisher）
```

**後置條件**：`session.watchers.length === pipeline.refs`。

---

## §3 連線關閉時

```
releasePipeline(conversationId, connectionId)
  → watchers = watchers.filter(w => w.connectionId !== connectionId)
  → watchers.length === 0 ? deleteCopilotSession() : setCopilotSession({...})
  → refs--；refs === 0 時拆 publisher 並 publish session.closed
registerCredential() 回傳的 unsubscribe（該條連線各自持有）
  → 只移除這一筆
```

⚠️ **登記的移除沒有獨立的具名函式** —— 它是 `registerCredential()` 回傳的閉包，
由 `stream.get.ts` 推進 `cleanups` 陣列、連線關閉時執行（現況即如此）。
本契約 MUST NOT 被讀成「要新增一支 `unregisterCredential()`」。

**後置條件**：等式仍成立；同一客服的其他連線**完全不受影響**（FR-006、SC-001）。

### 必須通過的四個情境

| # | 情境 | 期望 |
|---|---|---|
| 1 | 同一客服兩條連線，關掉一條 | `borrowCredential()` 仍回傳；另一條持續收到新訊息 |
| 2 | 同一客服兩條連線都 attach 同一對話，關掉一條 | session **不被刪除**、錨點繼續前推 |
| 3 | 同一客服所有連線都關閉 | 憑證與 session 才真正清掉 |
| 4 | 兩位不同客服各一條，其中一位離開 | 另一位不受影響（既有行為不得退步） |

---

## §4 存活兜底（FR-005a）

### 端點

```
POST /api/connection/beat
body: { clientId: string }
→ 200 { ok: true }
```

- 前端在 SSE 連線建立後每 `CREDENTIAL_HEARTBEAT_MS`（20 秒）送一次，
  **與有沒有進入對話無關**（分頁開著但還沒點進任何對話時仍須送達）。
- server 端把 `(orgId, operatorId, clientId)` 命中的**全部**登記的 `lastSeenAt` 更新為 `now`。
  ⚠️ **定址時 MUST NOT 先套 TTL 濾網**（2026-09-02 裁定）：命中「已逾期但尚未被讀取剔除」的
  舊筆時直接刷新它 —— 原 `connectionId` 保留，SSE 關閉時的 unsubscribe 仍打得中，
  I-1 完全成立。回收是惰性的（下方「回收」），逾期筆只有在 `borrowCredential()` 等讀取點
  跑過之後才會真的消失；只有那時心跳才會命中 0 筆而走下一條的 upsert。
  先套濾網再比對的寫法會讓每一次漏拍都製造一筆孤兒登記，I-1 的例外窗口白白變大。
- **命中 0 筆時 MUST 重新登記一筆**（upsert 語意），身分與憑證取自
  `requireActiveBffSession(event)` —— 與 `stream.get.ts` 同一個來源，
  端點**仍不接受、也不回傳任何 token**（憲法 1.1）。
  該筆的 `connectionId` **由 server 現場另產**（`crypto.randomUUID()`）——
  `connectionId` 維持「永不離開 server、不信任 client」（§2），body 一如既往只有 `clientId`。
  ⚠️ 連線關閉時，那條 SSE 手上的 unsubscribe 拿的是**舊** `connectionId`，移除會打空；
  重建的那一筆改由**心跳的生命週期**擁有，分頁關掉後心跳停止，≤ `CREDENTIAL_TTL_MS`（45 秒）
  由惰性回收清掉 —— 與 SC-002 對「異常中斷」已接受的保證是同一個，不是新的洩漏類別。

### ⚠️ 心跳 MUST 是 upsert，MUST NOT 是「純更新」

> **本節是這段論證的正典。** spec FR-005a 與 Clarifications、`data-model.md` §1、
> `tasks.md` 必讀 3a 都是它的摘要 —— 改動時以這裡為準，並 grep 其餘四處。

**這是本契約最容易照抄錯的一行。** 45 秒 TTL ／ 20 秒心跳這組數字抄自 presence
（`PRESENCE_TTL_MS`／`PRESENCE_HEARTBEAT_MS`），但 presence 真正的安全網不是那組數字，
而是 `reportViewing()` 是 **upsert** —— 項目被 TTL 清掉後，下一拍心跳會把它重建。

若心跳寫成「找不到就 no-op」，**背景分頁會自己觸發本規格要修的那個缺陷**：
瀏覽器對隱藏分頁的計時器有節流（Chrome 在分頁隱藏數分鐘後壓到約每分鐘一次），
60 秒 > 45 秒 → 登記被回收 → 而 SSE 連線還開著、沒有任何東西會重新登記 →
**那條連線的憑證永遠回不來**。症狀與 US1 要修的原始缺陷一模一樣：畫面正常、不報錯、
訊息不再進來。等於用一個看得見的缺陷，換一個更難查的。

⚠️ 「下一次重連會重新登記」**不成立** —— SSE 連線沒有斷，不會有重連。

### 回收

`borrowCredential()`／`hasForegroundOperator()`／`registeredOrgIds()` 讀取當下，
先剔除 `now - lastSeenAt > CREDENTIAL_TTL_MS`（45 秒）的登記。
沒有計時器（research.md #4）。

### ⚠️ 四條容易寫錯的地方

1. **MUST NOT 用 server 端的 `stream.heartbeat` 當存活訊號。**
   它證明的是「server 還認為連線在」，在半開連線下**恆真** —— 兜底變成永不觸發的裝飾。
   存活訊號必須由對側發出。
2. **MUST NOT 沿用 `POST /api/presence`。** 它的 body 必填 `conversationId`，
   分頁還沒進入任何對話時完全不送，會留一個永遠洩漏的視窗。
3. **心跳與 activity 更新 MUST 命中全部、MUST NOT「取一筆」。**
   複製分頁會共用 `clientId`；只更新其中一筆會讓另一條活著的連線在 45 秒後被回收。
4. **心跳 MUST 是 upsert（見上）。** 抄了 presence 的 45／20 秒，就 MUST 一併抄它的
   `reportViewing()` upsert 語意；只抄數字不抄語意，背景分頁節流會讓兜底自己變成缺陷。

### 為什麼這條是 FR-001 的必要配套，不是保險

現行以客服身分為鍵的實作有一個**意外的自癒**：同一客服下次登記會覆蓋上一筆，
所以就算關閉事件沒觸發，洩漏最多活到他下次上線。
改成「每次登記各自唯一」之後這個自癒消失，**每次洩漏都永久累積** ——
`borrowCredential()` 永遠不回 null（該組織的輪詢永遠不停，用著已登出的 token）、
`hasForegroundOperator()` 永遠回 true（維持 3 秒快輪詢）。
少了本節，US1 等於用一個看得見的缺陷換一個看不見的。

---

## §5 活躍度（既有缺陷的順手修正）

```
setCredentialActivity(orgId, operatorId, clientId, activity)
  → 更新命中的全部登記
hasForegroundOperator(orgId)
  → 該組織任一未逾期登記的 activity === 'foreground'
```

⚠️ 現行簽章沒有 `clientId`、以客服身分整筆覆寫。兩個分頁一前景一背景時後送者贏，
第一層清單輪詢因此會在 3 秒與 30 秒之間跳，而沒有任何訊號。
這是 FR-001／FR-002 的直接後果，不是額外範圍。

---

## §6 不變式清單（測試逐條對應）

| # | 不變式 | 對應 |
|---|---|---|
| I-1 | 一條 SSE 連線 ⟺ 恰好一筆憑證登記。**心跳漏拍導致登記被 TTL 剔除時，下一拍心跳 MUST 把它重建**（upsert，見 §4）。⚠️ **唯一例外**：重建的那一筆 `connectionId` 另產、不屬於任何 SSE 連線的關閉路徑，改由心跳擁有，連線關閉後 ≤45 秒由 TTL 回收（spec FR-005 第二句）。逾期但尚未被讀取剔除的舊筆由心跳直接刷新、不重建，因此例外只在「讀取點已跑過」之後才出現 | FR-001、FR-005、FR-005a |
| I-2 | 逾期登記不被 `borrowCredential()` 回傳 | FR-005a、SC-002 |
| I-3 | `hasForegroundOperator()` ＝ 任一登記為前景 | FR-002 |
| I-4 | `watchers.length === pipeline.refs`（單副本） | **FR-004** |
| I-5 | `deleteCopilotSession()` ⟺ `refs` 歸零 | FR-003 |
| I-6 | 同一 `connectionId` 對同一對話至多一筆 | FR-003 |
| I-7 | LEAVE 對該客服**所有**連線生效 | FR-006a、SC-002a |
| I-8 | 連線關閉只影響該條連線 | FR-006、SC-001 |

⚠️ I-7 與 I-8 是**一對夾擊條件**，MUST 同時驗。只驗其中一條時，
把兩條路徑合併的錯誤修法會通過測試。
