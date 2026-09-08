# syntax=docker/dockerfile:1.7
# AgentCopilot 的 image —— 形狀定義在 docs/ARCHITECTURE.md §16.1「image 的形狀」，
# 建置後用 deploy/verify-image.sh 檢查（§18 M3.5 驗收第 1、2 條）。
#
# ⚠️ 基底鎖精確版本，禁 :latest／:24-alpine 這類會漂移的標籤（§16.1）。
#    升級時改這一行並重建；本機開發的 node 版本以此為準（package.json 的 engines 只寫 >=24）。
ARG NODE_IMAGE=node:24.20.0-alpine

# ── 建置階段 ──────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=1 \
    NUXT_TELEMETRY_DISABLED=1

# 先只複製 lockfile 裝相依，原始碼變動時 npm ci 這一層仍可快取。
# --ignore-scripts：postinstall 的 `nuxt prepare` 需要 nuxt.config.ts 與 app/，此時尚未複製，下面補跑。
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# 建置內容由 .dockerignore 的白名單決定：.env* 與 scripts/spike/out/ 不在 context 裡，
# 所以 nuxt.config.ts 的 loadEnvFile 找不到檔案會直接跳過 —— 建置 image 不需要任何憑證。
COPY . .

# `npm run build` ＝ typecheck（nuxt typecheck ＋ tsc scripts/test）→ nuxt build，
# 與本機／CI 走同一條路：型別不過的程式碼建不出 image。
RUN npx nuxt prepare && npm run build

# ── 執行階段 ──────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="agent-copilot" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/sylvia-hu-tpi/agent-copilot"

# 設定值全部由執行期的 NUXT_* 環境變數注入（deploy/agent-copilot.env.example 列了鍵），
# 同一份 image 跨環境不重建。APP_REVISION 由 GET /api/health 回報，用來確認「現在跑的是哪一版」。
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000 \
    APP_REVISION="${GIT_SHA}"

WORKDIR /app
# 只帶 .output —— Nitro 已把執行期相依打包進 .output/server/node_modules，
# 原始碼、devDependencies、lockfile 都不進執行階段。
COPY --from=build --chown=node:node /src/.output ./.output

USER node
EXPOSE 3000

# alpine 沒有 curl／wget，用 node 自己打（§16.1）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
