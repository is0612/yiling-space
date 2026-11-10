# 使用版（生产）镜像：一次构建，之后只分发镜像，不在对方机器上编译代码。
#
# 为什么运行层要带上 server/ scripts/ src/ 和完整 node_modules：
# 使用版不是「只有网页」。记忆提炼、忆泡/快照、社交关系评估、成长事件消费都由
# `scripts/run-memory-worker.ts` 常驻执行，而它是用 tsx 直接跑 TypeScript 源码的，
# 依赖 server/utils、src/generated/prisma 和 tsx/prisma 这两个 devDependency。
# 只复制 .output 的镜像会让网页能打开、但所有后台能力静默不工作 —— 这是最容易踩的坑。
#
# 构建：node scripts/docker-pack.mjs（会同时产出分发包）
# 手动：docker build -t yiling-space:latest .

# ---------- 构建层 ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma 引擎要 libssl；证书用于 yarn 拉包。
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1 \
    NUXT_TELEMETRY_DISABLED=1
RUN corepack enable

# 依赖层单独一层：只要 lock 不变，改业务代码不会重装依赖。
#
# 这一层先只复制 package.json / yarn.lock，所以必须 --ignore-scripts：
# 否则 postinstall 里的 `nuxt prepare` 会因为没有源码目录直接 MODULE_NOT_FOUND，
# 整条 install 失败（第一次构建就是这么红的）。
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --network-timeout 600000

COPY . .

# 源码到位后再跑一次（包已在层里，这一步很快）：让需要的 postinstall 真正执行，
# 包括 `nuxt prepare`。prisma generate 显式跑，因为 postinstall 在没有 DATABASE_URL 时会跳过它。
RUN yarn install --frozen-lockfile --network-timeout 600000
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" yarn prisma generate
RUN yarn build

# ---------- 运行层 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NUXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    NITRO_HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json

# 版本写进镜像：一个文件给更新脚本读（batch 里解析 label 要跟引号斗智），一个 label 给 docker inspect。
ARG APP_VERSION=0.0.0
RUN echo "${APP_VERSION}" > /app/VERSION
LABEL org.opencontainers.image.title="Yiling Space" \
      org.opencontainers.image.version="${APP_VERSION}" \
      yiling.version="${APP_VERSION}"

# /app/.data 存 credentials-encryption.key —— 必须挂卷，丢了已保存的 API Key 就解不开。
RUN mkdir -p /app/.data /backups
VOLUME ["/app/.data"]

EXPOSE 3000

# 存活探针走 /api/health（不依赖数据库）。运行层没有 curl，用 node 自带的 fetch。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 负责转发信号：停容器时 launch-prod 才有机会让 Worker 收尾。
ENTRYPOINT ["/usr/bin/tini", "--", "node", "scripts/launch-prod.mjs"]
