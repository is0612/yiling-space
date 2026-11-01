/**
 * postinstall 的第二段（nuxt prepare 之后跑）。
 *
 * 只做一件事：在能读到 DATABASE_URL 时执行 `prisma generate`，读不到就跳过。
 *
 * 为什么要跳过：`prisma.config.ts` 用 `env("DATABASE_URL")` 取连接串，变量缺失时
 * Prisma 直接抛 `PrismaConfigEnvError`。而全新 clone 上还没有 `.env`（它由后面的
 * `yarn setup` 生成），于是 `yarn install` 会在 postinstall 这一步整条失败 ——
 * 2026-11-01 实测：全新目录第一条命令就红着退出，依赖其实已经装好了。
 *
 * 跳过是安全的：生成客户端不需要真实连接，`yarn setup` 写好 `.env` 后会自己再跑一次
 * `prisma generate`（见 scripts/setup.ts 第 6 步）。已经有 `.env` 的机器行为不变。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readDatabaseUrl() {
  const fromEnv = (process.env.DATABASE_URL ?? "").trim();
  if (fromEnv) return fromEnv;
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return "";
  const match = fs.readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.*)$/m);
  return (match?.[1] ?? "").trim();
}

if (!readDatabaseUrl()) {
  console.log("[postinstall] 还没有 .env / DATABASE_URL，先跳过 prisma generate；跑完 yarn setup 会自动生成。");
  process.exit(0);
}

const bin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);
const result = spawnSync(bin, ["generate"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
