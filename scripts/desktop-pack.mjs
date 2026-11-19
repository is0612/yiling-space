#!/usr/bin/env node
/**
 * 打 Windows「桌面便携版」：把运行时、Electron、生产依赖和已构建的 .output 收进一个文件夹。
 *
 * 目标：目标机器只要有 Docker Desktop，不需要 Node / yarn / 源码，双击文件夹里的 bat 就能起。
 * 仍然复用现有 PostgreSQL 容器方案；不把数据库塞进安装包。
 *
 * 产出（默认 dist/桌面便携版-<version>/）：
 *   启动忆灵空间-桌面版.bat
 *   runtime/node.exe
 *   app/                       .output + server/scripts/prisma + 生产 node_modules
 *   app/desktop/               Electron 壳 + electron 运行时
 *   README.txt
 *
 * 用法：
 *   node scripts/desktop-pack.mjs                 # 构建并打包（不带 .env）
 *   node scripts/desktop-pack.mjs --skip-build    # 复用已有 .output
 *   node scripts/desktop-pack.mjs --with-env      # 连同 .env 一起打（仅限自己迁移，别发给别人）
 *   node scripts/desktop-pack.mjs --with-data     # 连 .data（密钥/表情/SnowLuma 配置）一起打
 *   node scripts/desktop-pack.mjs --force         # 覆盖已有输出目录
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const withEnv = args.has("--with-env");
const withData = args.has("--with-data");
const force = args.has("--force");
const outArg = (() => {
  const index = process.argv.indexOf("--out");
  return index >= 0 ? process.argv[index + 1] : "";
})();

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version ?? "0.0.0");
const outDir = path.resolve(ROOT, outArg || path.join("dist", `桌面便携版-${version}`));
const appDir = path.join(outDir, "app");

function step(text) {
  console.log(`\n▶ ${text}`);
}
function ok(text) {
  console.log(`  ✓ ${text}`);
}
function fail(text, hint) {
  console.error(`\n✗ ${text}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) fail(`${command} 执行失败：${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} 退出码 ${result.status}`);
}
function sizeOf(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

if (existsSync(outDir) && !force) {
  fail(`输出目录已存在：${outDir}`, "确认要覆盖就加 --force；不要把别人的数据目录一起删掉。");
}
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

step("检查构建产物");
if (!existsSync(path.join(ROOT, ".output", "server", "index.mjs"))) {
  if (skipBuild) fail("没有 .output/server/index.mjs；去掉 --skip-build 先构建。");
  step("构建 .output");
  run("yarn", ["build"]);
} else {
  ok(".output 已存在");
}

step("准备目录");
mkdirSync(appDir, { recursive: true });
mkdirSync(path.join(outDir, "runtime"), { recursive: true });

const appItems = [
  ".output",
  "server",
  "scripts",
  "shared",
  ".nuxt",
  "prisma",
  "src/generated",
  "package.json",
  "yarn.lock",
  "nuxt.config.ts",
  "prisma.config.ts",
  "tsconfig.json",
  "tsconfig.server.json",
  ".env.example",
  "README.md",
];
for (const item of appItems) {
  const source = path.join(ROOT, item);
  if (!existsSync(source)) {
    console.log(`  - 跳过不存在的 ${item}`);
    continue;
  }
  cpSync(source, path.join(appDir, item), { recursive: true });
}
ok("应用文件已复制");

step("复制 Electron 壳");
cpSync(path.join(ROOT, "desktop"), path.join(appDir, "desktop"), {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}node_modules`),
});
cpSync(
  path.join(ROOT, "desktop", "node_modules", "electron"),
  path.join(appDir, "desktop", "node_modules", "electron"),
  { recursive: true },
);
ok("Electron 壳已复制");

step("安装生产依赖（不跑 postinstall）");
run("yarn", ["install", "--production", "--frozen-lockfile", "--ignore-scripts"], {
  cwd: appDir,
  env: { ...process.env, NODE_ENV: "production" },
});
ok("生产依赖已安装");

step("复制 Node 运行时");
const nodeExe = process.execPath;
cpSync(nodeExe, path.join(outDir, "runtime", path.basename(nodeExe)));
ok(`Node 运行时：${nodeExe}`);

step("补齐 Prisma 引擎");
const prismaEngine = path.join(ROOT, "node_modules", "@prisma", "engines", "schema-engine-windows.exe");
if (!existsSync(prismaEngine)) fail("找不到 schema-engine-windows.exe；先在仓库跑一次 prisma migrate 或 yarn install。");
cpSync(prismaEngine, path.join(appDir, "node_modules", "@prisma", "engines", "schema-engine-windows.exe"));
ok("schema-engine-windows.exe");

if (withEnv) {
  step("复制 .env（会含数据库密码与模型 Key）");
  if (!existsSync(path.join(ROOT, ".env"))) fail("没有 .env，无法 --with-env。");
  cpSync(path.join(ROOT, ".env"), path.join(appDir, ".env"));
  console.warn("  ⚠ 这个包只适合自己迁移；不要把它发给别人或上传。");
}

if (withData) {
  step("复制 .data（凭据密钥、SnowLuma 配置、表情包等）");
  if (!existsSync(path.join(ROOT, ".data"))) fail("没有 .data，无法 --with-data。");
  cpSync(path.join(ROOT, ".data"), path.join(appDir, ".data"), { recursive: true });
  console.warn("  ⚠ .data 里含凭据密钥和聊天相关文件；不要把这个包发给别人。");
}

const required = [
  ["app/.output/server/index.mjs", "Nitro 构建"],
  ["app/node_modules/tsx/dist/cli.mjs", "tsx"],
  ["app/node_modules/prisma/build/index.js", "Prisma CLI"],
  ["app/node_modules/@prisma/engines/schema-engine-windows.exe", "Prisma schema engine"],
  ["app/node_modules/pg/package.json", "pg"],
  ["app/node_modules/sharp/package.json", "sharp"],
  ["app/src/generated/prisma/client.ts", "Prisma client"],
  ["app/desktop/node_modules/electron/dist/electron.exe", "Electron"],
];
step("自检");
for (const [relative, label] of required) {
  if (!existsSync(path.join(outDir, relative))) fail(`缺少 ${relative}（${label}）`);
  ok(label);
}

const bat = `@echo off
setlocal
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo Missing runtime\\node.exe. The package is incomplete.
  pause
  exit /b 1
)
if not exist "app\\.env" (
  echo.
  echo No app\\.env found.
  echo Copy app\\.env.example to app\\.env, then fill DATABASE_URL and model keys.
  echo For personal migration, rebuild with: --with-env --with-data
  echo.
  pause
  exit /b 1
)

"runtime\\node.exe" "app\\desktop\\launch.cjs"
if errorlevel 1 (
  echo.
  echo Startup failed. See app\\.data\\logs\\desktop.log.
  pause
)
`;
writeFileSync(path.join(outDir, "启动忆灵空间-桌面版.bat"), bat.replace(/\n/g, "\r\n"), "ascii");

const backupBat = `@echo off
setlocal
cd /d "%~dp0"
if not exist "app\\.env" (
  echo No app\\.env found.
  pause
  exit /b 1
)
"runtime\\node.exe" "app\\scripts\\desktop-backup.mjs" backup
pause
`;
writeFileSync(path.join(outDir, "备份数据.bat"), backupBat.replace(/\n/g, "\r\n"), "ascii");

const readme = `忆灵空间 · Windows 桌面便携版 ${version}

前提
  1. Windows 10/11
  2. Docker Desktop 已安装并启动（数据库仍用 PostgreSQL 容器）
  3. app\\.env 已配置（DATABASE_URL、模型 Key 等）

启动
  双击「启动忆灵空间-桌面版.bat」。
  首次启动会检查数据库、跑迁移、起 Worker/Scheduler；QQ 栈是可选链路。
  日志在 app\\.data\\logs\\。

说明
  - 这个包不需要目标机器安装 Node / yarn；runtime\\node.exe 已带。
  - Electron 和 Chromium 的缓存放在 app\\.tmp\\electron（写不了会回退）。
  - 数据目录默认 app\\.data；也可以设置 YILING_DATA_DIR 指到别处。
  - 如果打包时加了 --with-env，app\\.env 里含数据库密码和模型 Key，不要转发这个包。
  - 首次空库会自动建管理员；没有可用 DEV_OWNER_PASSWORD 时密码写在 app\\.data\\first-run-admin.txt。
  - 备份：双击「备份数据.bat」，文件在 app\\.data\\backups\\；恢复前必须先停应用。
`;
writeFileSync(path.join(outDir, "README.txt"), readme.replace(/\n/g, "\r\n"), "utf8");

console.log(`\n✓ 便携版已生成：${outDir}`);
console.log(`  大小：${(sizeOf(outDir) / 1024 / 1024).toFixed(0)} MB`);
console.log("  下一步：把 app/.env 配好（或重新用 --with-env 打包），双击启动 bat 验证。");
