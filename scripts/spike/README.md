# Spike 執行手冊

目的：把 `docs/ARCHITECTURE.md` §19 的 16 條未定事項，從**假設**變成**事實**。

## 為什麼這不是拋棄式程式碼

| 檔案 | Spike 用途 | 正式開發用途 |
|---|---|---|
| `shared/types/conversation.ts` | 領域型別 | **M0/M1 正式型別**，前後端共用 |
| `server/sources/mappers.ts` | 驗證 SDK → 領域型別轉得過去 | **M1 防腐層**，SessionManager 直接用 |
| `server/sources/message-fetch.ts` | 找出可行的取數策略 | **M1 PollingMessageSource 的取數核心** |
| `server/services/imbrace.ts` | 建 client | **M0 client factory**（§7.3） |
| `server/utils/redact.ts` | 讓樣本可安全落地 | **憲法第 8 條**的 logger 基礎 |
| `scripts/spike/out/*.json` | 證據 | **M2 mock 資料**與單元測試 fixture |
| `scripts/spike/*.ts` | 探測 | 演化成 M4 的部署後健康檢查 |

唯一真正只服務 spike 的是 `lib/harness.ts` 的報告輸出。

## 執行

```bash
npm install
cp .env.example .env.local     # 填入 IMBRACE_ENV 與 IMBRACE_EMAIL

npm run spike:auth             # ① 互動式 OTP，產出 access token
                               #    把印出的兩行貼回 .env.local
                               #    順帶回答 H-5（角色）與 F-2（token 續期）

# ② 在 .env.local 填入 SPIKE_CONVERSATION_ID
#    ⚠️ 挑選標準見下方「測試資料的選擇」

npm run spike                  # ③ 跑完 01~05，產出 out/SPIKE_RESULT.md
```

單獨重跑某一題：`npm run spike:sender` / `spike:media` / `spike:poll` / `spike:knowledge` / `spike:ai`

## 測試資料的選擇 ← 最容易搞砸的一步

`SPIKE_CONVERSATION_ID` 必須指向一個**內容夠雜**的對話，理想上同時包含：

- [ ] 客戶的文字訊息
- [ ] AI workflow 的自動回覆
- [ ] **至少一位真人客服的回覆**（否則 H-3 的一半驗不出來）
- [ ] 至少一張圖片
- [ ] 至少一則語音訊息（否則 H-2 —— 影響最大的那題 —— 直接落空）

若手上沒有這種對話，**先去平台上造一個**，這比跑十次 spike 都值得。
probe 遇到資料不足會回報 `❓ unknown` 並說明缺什麼，不會假裝有答案。

## 產出

```
scripts/spike/out/
├── SPIKE_RESULT.md          ← 可直接貼進 docs 的結論表
├── 0X-findings.json         ← 每題的結構化結果
└── 0X-*.json                ← 已遮蔽 PII 的真實樣本（→ M2 fixture）
```

`out/` 已在 `.gitignore` 中（含真實對話樣本）。確認遮蔽無誤後可手動挑選需要的 fixture 移入 `tests/fixtures/` 進版控。

## 跑完之後

1. 把 `SPIKE_RESULT.md` 的結論回填 `docs/ARCHITECTURE.md` §19
2. 在 `docs/IMBRACE_QUESTIONS.md` 標記已自行解答的項目 —— 清單會大幅縮短，
   剩下的才是真正需要佔用 iMBrace 團隊時間的問題
3. 依 `impact` 欄位調整 M1–M4 的工時估算
