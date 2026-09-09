#!/usr/bin/env sh
# 換版：pull ＋ up -d，image 以不可變 tag 指定 —— docs/ARCHITECTURE.md §16.1、§18 M3.5。
# 用法：./redeploy.sh <commit 短 sha>     （在 deploy/ 目錄外執行也可以，會自己 cd）
#
# 為什麼要有這支：compose 刻意不設 pull_policy，少了 `pull` 就不會換版；
# 而 tag 一旦允許 develop／latest 這類可變標籤，「現在跑的是哪一版」就無法回答。
set -eu
cd "$(dirname "$0")"

TAG="${1:-}"
case "$TAG" in
  ""|latest|develop|main|master|stable|sit|prod|production)
    echo "用法：./redeploy.sh <commit 短 sha>" >&2
    echo "拒絕可變標籤（latest／develop／main…）：SIT 上 MUST 用不可變 tag（§18 M3.5）" >&2
    exit 2 ;;
esac

[ -f agent-copilot.env ] || {
  echo "缺 agent-copilot.env —— cp agent-copilot.env.example agent-copilot.env 後填值" >&2; exit 2; }
[ -f certs/fullchain.pem ] && [ -f certs/privkey.pem ] || {
  echo "缺 certs/fullchain.pem 或 certs/privkey.pem —— HTTPS 是登入的硬前提，不是偏好（§16.1 前提 1）" >&2; exit 2; }

# compose 的變數插值只讀同目錄的 .env（不是 env_file），tag 寫在這裡讓 `docker compose ps` 等指令也看得到
printf 'AGENT_COPILOT_TAG=%s\n' "$TAG" > .env

COMPOSE="docker compose -f docker-compose.sit.yml"
echo "→ pull systalk/agent-copilot:$TAG"
$COMPOSE pull app
echo "→ up -d（同名 service 先停舊、再起新）"
$COMPOSE up -d --remove-orphans

# 等 app 的 healthcheck 轉 healthy；proxy 有 depends_on condition，app 不健康它不會起
cid="$($COMPOSE ps -q app)"
i=0
while [ "$i" -lt 45 ]; do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
  [ "$st" = healthy ] && break
  i=$((i + 1)); sleep 2
done
$COMPOSE ps
if [ "$st" != healthy ]; then
  echo "❌ app 未在 90 秒內轉 healthy（狀態：$st）。最後 30 行 log：" >&2
  $COMPOSE logs --tail 30 app >&2
  exit 1
fi
echo "✅ 換版完成：$(docker exec "$cid" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>console.log(t))")"
