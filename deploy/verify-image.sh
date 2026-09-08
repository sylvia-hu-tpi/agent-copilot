#!/usr/bin/env bash
# 建置後檢查 image —— docs/ARCHITECTURE.md §18 M3.5 驗收第 1、2 條。
# 用法：./verify-image.sh <image:tag>     例：./verify-image.sh agent-copilot:local
#
# 檢查的四件事裡，②「不含 .env* 與 scripts/spike/out/」最重要：那兩條不會報錯，
# 只會靜默把本機憑證與真實對話樣本帶進 image（§16.1）。
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash 會把 / 開頭的參數改寫成 Windows 路徑，關掉

IMAGE="${1:?用法：./verify-image.sh <image:tag>}"
fail=0
ok()   { printf '✅ %s\n' "$*"; }
bad()  { printf '❌ %s\n' "$*"; fail=1; }

# ① 預設使用者是 node，不是 root
u="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -un')"
[ "$u" = node ] && ok "USER node" || bad "預設使用者是 $u，不是 node"

# ② image 內不含 .env* 與 scripts/spike/out/
hits="$(docker run --rm --entrypoint sh "$IMAGE" -c \
  'find / -xdev \( -name ".env" -o -name ".env.*" -o -path "*/scripts/spike/out*" \) 2>/dev/null' || true)"
if [ -z "$hits" ]; then ok "無 .env* 與 scripts/spike/out/"; else bad "找到不該進 image 的檔案："; printf '%s\n' "$hits"; fi

# ③ 只帶 .output：原始碼與 devDependencies 不在執行階段
src="$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls -A /app; [ -d /src ] && echo /src' || true)"
[ "$src" = ".output" ] && ok "執行階段只有 /app/.output" || bad "執行階段多了東西：$src"

# ④ 容器起得來、healthcheck 轉 healthy、GET /api/health 回 200
#    不給任何 NUXT_* —— health 不需要憑證；縮短 interval 讓檢查快一點
cid="$(docker run -d --rm --health-interval=3s --health-start-period=5s "$IMAGE")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
st=none
for _ in $(seq 1 30); do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
  [ "$st" = healthy ] && break
  sleep 2
done
if [ "$st" = healthy ]; then
  body="$(docker exec "$cid" node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(r.status, await r.text()))")"
  ok "GET /api/health → $body"
else
  bad "healthcheck 未在 60 秒內轉 healthy（狀態：$st）"; docker logs "$cid" 2>&1 | tail -20
fi

printf 'node：%s\n' "$(docker run --rm --entrypoint node "$IMAGE" -v)"
printf 'revision label：%s\n' "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
printf 'size：%s\n' "$(docker image inspect --format '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1024/1024}')"

[ "$fail" -eq 0 ] && ok "全部通過" || { bad "有項目未通過"; exit 1; }
