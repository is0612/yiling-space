#!/usr/bin/env node
/**
 * 使用版（生产）启动器。
 *
 * 和开发版的 `launch.mjs` 是两件事：那边要 yarn、要装依赖、跑 `nuxt dev`、带热更新；
 * 这边只做「把已经构建好的东西跑起来」，一个容器里同时承担三件事：
 *
 *   1. 数据库结构升级：`prisma migrate deploy` —— 每次启动都跑，幂等。
 *      这就是「使用者更新到新版本」时数据库自动跟上的地方，他们不需要敲任何命令。
 *   2. 首个管理员：库里一个用户都没有时，用 .env 里的 DEV_OWNER_* 建一个 ADMIN。
 *      只建一次；之后密码以网页里改的为准，绝不在每次启动时重置。
 *   3. 起 Web（Nitro 产物）+ 常驻 Worker（记忆提炼 / 忆泡快照 / 关系评估 / 成长事件）。
 *
 * 进程关系的约定：任何一个先死就整体退出，交给 Docker 的 restart 策略重启 ——
 * 半死不活（网页在、Worker 不在）比直接退出更难查。
 */

import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { superviseMemoryWorker } from "./memory-worker-supervisor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || "3000";
const PRISMA_BIN = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
const WORKER_DISABLED = process.env.YILING_WORKER_DISABLED === "1";

function log(message) {
  console.log(`[使用版] ${message}`);
}

function die(message, hint) {
  console.error(`\n[使用版] ✗ ${message}`);
  if (hint) console.error(`          ${hint}`);
  process.exit(1);
}

/** 结构升级。失败必须停在这里：带着旧表结构起服务，只会静默写坏数据。 */
function migrateDatabase() {
  if (!existsSync(PRISMA_BIN)) die("找不到 Prisma CLI（node_modules/prisma 缺失），镜像不完整。", "请重新拉取/加载使用版镜像。");
  if (!process.env.DATABASE_URL) die("缺少 DATABASE_URL。", "检查 .env 是否挂进了容器（docker-compose.prod.yml 的 env_file）。");
  log("检查数据库结构（prisma migrate deploy）…");
  const result = spawnSync(process.execPath, [PRISMA_BIN, "migrate", "deploy"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    die("数据库迁移失败，服务没有启动。", "数据库连不上或迁移脚本出错；修好后重启容器即可，已应用的迁移不会重跑。");
  }
  log("数据库结构已是最新。");
}

/** 首次启动建管理员。库里已经有用户就完全不动它。 */
async function ensureFirstAdmin() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;
  const client = new Client({ connectionString });
  let userCount = -1;
  try {
    await client.connect();
    const { rows } = await client.query('SELECT count(*)::int AS n FROM "users"');
    userCount = rows[0]?.n ?? 0;
  } catch (error) {
    // users 表不存在说明迁移刚建完但还没成功，交给上面的 migrate 报错；这里不掩盖。
    log(`跳过管理员自检：${error instanceof Error ? error.message : String(error)}`);
    return;
  } finally {
    await client.end().catch(() => {});
  }
  if (userCount !== 0) return;

  const password = process.env.DEV_OWNER_PASSWORD ?? "";
  if (!password || password.startsWith("replace_with_") || password.length < 8) {
    log("库里还没有用户，但 .env 的 DEV_OWNER_PASSWORD 不可用；请手动创建管理员。");
    return;
  }
  log("库里还没有用户，用 .env 的 DEV_OWNER_* 创建首个管理员…");
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-dev-user.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error("[使用版] ⚠ 管理员创建失败，网页仍会启动，但你需要用别的方式建账号。");
    return;
  }
  log(`首次管理员：${process.env.DEV_OWNER_USERNAME || "local-dev"}（密码见 .env 的 DEV_OWNER_PASSWORD，登录后请改掉）`);
}

let web = null;
let worker = null;
let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("收到停止信号，正在收尾…");
  if (worker) {
    await worker.stop().catch(() => {});
  }
  if (web && !web.killed) {
    web.kill("SIGTERM");
    // 给 Nitro 10 秒把在途请求写完，再强杀。
    const killer = setTimeout(() => { if (!web.killed) web.kill("SIGKILL"); }, 10_000);
    killer.unref?.();
  }
  process.exit(code);
}

async function main() {
  log(`启动使用版 · 端口 ${PORT}${WORKER_DISABLED ? "（Worker 已按 YILING_WORKER_DISABLED 关闭）" : ""}`);
  if (!existsSync(path.join(ROOT, ".output", "server", "index.mjs"))) {
    die("找不到 .output/server/index.mjs，这个镜像没有构建过网页。", "请使用正式发布的使用版镜像，而不是源码目录。");
  }

  migrateDatabase();
  await ensureFirstAdmin();

  if (!WORKER_DISABLED) {
    worker = await superviseMemoryWorker({ root: ROOT });
    log("后台 Worker 已启动（记忆 / 忆泡 / 关系评估 / 成长事件）。");
  }

  web = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PORT, NITRO_HOST: process.env.NITRO_HOST || "0.0.0.0" },
  });
  log(`网页服务启动中：http://127.0.0.1:${PORT}`);

  web.once("error", (error) => {
    console.error(`[使用版] ✗ 网页服务起不来：${error.message}`);
    void shutdown(1);
  });
  web.once("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[使用版] ✗ 网页服务退出（code=${code ?? "signal"}），整体停止以便 Docker 重启。`);
    void shutdown(code ?? 1);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void shutdown(0); });
  }
}

await main();
