# deploy/ —— SIT 單機 compose 的部署步驟

> 部署**形態**與兩個前提的正典在 `docs/ARCHITECTURE.md` §16.1，環境定位在 §16.5，驗收在 §18 M3.5。
> 本檔只寫**現場操作**；形態為什麼這樣選不在這裡重述。

## 這個目錄裡有什麼

| 檔案 | 用途 | 進版控？ |
|---|---|---|
| `docker-compose.sit.yml` | `app`（AgentCopilot）＋ `proxy`（nginx：TLS 終端與 SSE 設定） | ✅ |
| `nginx.conf` | 掛進 proxy 的 `/etc/nginx/conf.d/default.conf` | ✅ |
| `agent-copilot.env.example` | 執行期設定的**鍵清單**，值全空 | ✅ |
| `agent-copilot.env` | 上面複製後填值的實值檔，compose 以 `env_file` 注入 | ❌ `.gitignore` |
| `certs/fullchain.pem`、`certs/privkey.pem` | TLS 憑證與私鑰 | ❌ `.gitignore` |
| `.env` | 只有一行 `AGENT_COPILOT_TAG=<sha>`，由 `redeploy.sh` 寫入，給 compose 插值用 | ❌ `.gitignore` |
| `redeploy.sh <sha>` | 換版：檢查前置 → `pull` → `up -d` → 等 healthy | ✅ |
| `verify-image.sh <image>` | 建置後檢查 image：`USER node`、不含 `.env*` 與 `scripts/spike/out/`、health 回 200 | ✅ |

## 前置（SI 提供，與 iMBrace 無關）

1. 一台 Linux VM，裝好 Docker Engine ＋ Compose plugin（`docker compose version` 能跑）。
2. 對外 443 白名單：iMBrace 的兩個網域（`app-gatewayv2.imbrace.co`、`cloud.imbrace.co`）與 Docker Hub（`registry-1.docker.io`、`auth.docker.io`、`production.cloudflare.docker.com`）。
3. 內網主機名稱（例：`agent-copilot.sit.example.internal`）與對應的 TLS 憑證。
   ⚠️ **HTTPS 不是偏好，是登入的硬前提**：session cookie 的 `Secure` 旗標是建置期決定的，
   純 HTTP 下瀏覽器直接丟掉 cookie，症狀是「OTP 驗證成功但下一頁又回到登入」（§16.1 前提 1）。
   內部 CA 簽的憑證可以，但 demo 用的瀏覽器要先信任那個 CA。
4. Docker Hub `systalk/agent-copilot` 的**拉取**權限（VM 上 `docker login` 一次即可）。
5. 對內開放辦公室網段到 VM 的 **443**（服務）、**80**（只做 301 轉向到 https）與 **22**（ssh）。
   ssh 帳號給我方，加進 `docker` 群組即可、不需 sudo；請一併建立 `/opt/agent-copilot` 並把擁有者設為該帳號。
   其餘埠不需開放：app 容器不對主機開埠，只有 nginx 監聽。

## 首次部署

```bash
git clone <repo> && cd agent-copilot/deploy        # 只需要 deploy/ 這個目錄，其他都在 image 裡
cp agent-copilot.env.example agent-copilot.env
$EDITOR agent-copilot.env                           # 逐鍵填值，說明在檔內；值不加引號
mkdir -p certs && cp <fullchain> certs/fullchain.pem && cp <privkey> certs/privkey.pem
./redeploy.sh <commit 短 sha>                       # 例：./redeploy.sh 5bd938d
```

`redeploy.sh` 會拒絕 `latest`／`develop` 這類可變標籤——SIT 上 MUST 用不可變 tag（§18 M3.5），
否則「現在跑的是哪一版」無法回答。跑完會印 `GET /api/health` 的回應，其中 `revision` 就是建置時的 commit sha。

### demo 專用 Data Board（MUST，§16.5）

結案摘要是**真寫入**，Board 是正式 CRM。demo MUST 用專用 Board，MUST NOT 填客戶正式 Board 的 id：

```bash
# 在有 .env.local（IMBRACE_* 憑證）的開發機上，IMBRACE_CLOSURE_BOARD_ID 留空：
npm run board:setup            # 印出新建 Board 的 id
# 把 id 填到 VM 的 agent-copilot.env → NUXT_IMBRACE_CLOSURE_BOARD_ID，再 ./redeploy.sh <同一個 sha>
```

## 換版

```bash
./redeploy.sh <新的 commit 短 sha>
```

⚠️ **換版 ＝ 所有客服被登出、分析結果歸零**（單副本、記憶體狀態，§18 M3.5 的警語）。demo 前不換版。
⚠️ 不要用 `--scale app=2` 或第二台機器擋負載：兩個實例並存就是「隨機被登出」（§16.1）。

回滾就是 `./redeploy.sh <上一個 sha>`，沒有別的機制。

## 檢查與除錯

```bash
docker compose -f docker-compose.sit.yml ps            # app 應為 healthy
docker compose -f docker-compose.sit.yml logs -f app   # 應用 log（含建議卡引用稽核的 NDJSON）
docker compose -f docker-compose.sit.yml exec proxy nginx -t
```

| 症狀 | 最可能的原因 | 看哪裡 |
|---|---|---|
| OTP 驗證成功，下一頁又回到登入 | 瀏覽器走的是 HTTP，或憑證不被信任導致降級 | 網址列鎖頭；§16.1 前提 1 |
| JOIN 後面板永遠空白、無錯誤 | 代理把 SSE 緩衝住了（`proxy_buffering` 被改回 on、或前面又多了一層代理） | DevTools 的 EventStream 分頁從連線建立起看；`nginx.conf` 的 `/api/stream` 區塊 |
| 面板閒置一兩分鐘後斷線重連 | 中間某層的 read timeout 小於 25 秒心跳 | `proxy_read_timeout`；若 VM 前面還有負載平衡器，那一層也要設 |
| 面板有內容但都是假的 | 五個 agent id 缺了前四個之一，靜默退回 Mock provider | `logs app` 開頭的警告；`agent-copilot.env` |
| 按下結案在「產生草稿」就 502 | `NUXT_IMBRACE_CLOSURE_AGENT_ID` 缺或錯（刻意不退 Mock） | 同上 |
| 所有登入回 500 | `NUXT_SESSION_SECRET` 空 | `logs app` |
| `redeploy.sh` 後版本沒變 | tag 打錯（`revision` 沒變），或 `pull` 被拿掉 | health 的 `revision` |

## 本機先跑一遍（交付前 MUST，§18 M3.5 驗收第 3 條）

VM 沒有任何本機測不到的東西，除了網路位置。在開發機上：

```bash
# 直接用 compose 會找的名稱打 tag，不要另外打別名 —— 多一個標籤就多一個會讓人誤讀的名字
docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t systalk/agent-copilot:local .
./deploy/verify-image.sh systalk/agent-copilot:local

cd deploy
# 自簽憑證（瀏覽器會警告，點「繼續」即可；Git Bash 要先 export MSYS_NO_PATHCONV=1）
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout certs/privkey.pem -out certs/fullchain.pem
# agent-copilot.env：把 .env.local 的 IMBRACE_* 值抄成 NUXT_*（對照表在 nuxt.config.ts 的 ENV_BRIDGE）
# 本機沒有 Docker Hub 上的 image，用上面那個 local tag 直接 up（略過 redeploy.sh 的 pull）：
echo 'AGENT_COPILOT_TAG=local' > .env
docker compose -f docker-compose.sit.yml up -d
```

然後用瀏覽器開 `https://localhost/`，走完：登入 → 列表 → JOIN → 摘要／情緒／建議卡三區塊 → 送出 → 結案寫入，
並把面板放著 ≥ 2 分鐘確認 SSE 不斷。收工 `docker compose -f docker-compose.sit.yml down`。

## Jenkins：建置與推送

走公司 Jenkins 的 `select-to-build-image` pipeline，在其 case 清單加一個 `agent-copilot`：

- Dockerfile：repo 根目錄的 `Dockerfile`（build context ＝ repo 根目錄，`.dockerignore` 是白名單）
- build arg：`GIT_SHA=<commit 短 sha>`（進 image label 與 `/api/health` 的 `revision`）
- 推送：`systalk/agent-copilot:<commit 短 sha>`。**不推 `latest`**，也不推分支名
- 建置需要能拉 `node:24.20.0-alpine`，並且 `npm ci` 要連得到 npm registry

pipeline 本身在公司的 Jenkins repo，不在這裡；上面是它需要知道的全部。
