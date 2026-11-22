#!/usr/bin/env node
/**
 * 桌面端数据备份：数据库 dump + 解密密钥 + SnowLuma 目录配置。
 *
 * 只读数据库、只写 <data>/backups/；不会停应用、不会覆盖现有备份。
 * 恢复仍走现有的 restore 流程（应用必须停掉）；这个脚本只负责把「一套能恢复的东西」放在一起。
 *
 * 用法：
 *   node scripts/desktop-backup.mjs backup
 *   node scripts/desktop-backup.mjs backup --label pre-migrate
 *   node scripts/desktop-backup.mjs list
 */

import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopDatabaseMode, openBoundDesktopDatabase, desktopPgBin } from "./desktop-database-config.mjs";
import { createDesktopPgBackup } from "./desktop-pg-backup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] || "backup";
const label = (() => {
  const index = args.indexOf("--label");
  return index >= 0 ? String(args[index + 1] || "").replace(/[^a-zA-Z0-9_-]/g, "") : "";
})();

function readEnvFile() {
  const values = {};
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const dataDir = path.resolve(process.env.YILING_DATA_DIR?.trim() || path.join(ROOT, ".data"));
const runtimeMode = resolveDesktopDatabaseMode(dataDir);
const envFile = runtimeMode === "embedded" ? {} : readEnvFile();
const databaseUrl = process.env.DATABASE_URL || envFile.DATABASE_URL || "";
const backupRoot = path.join(dataDir, "backups");
const container = (process.env.YILING_DB_CONTAINER || envFile.YILING_DB_CONTAINER || "yiling-hub-db").trim();

function fail(message, hint = "") {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function databaseIdentity() {
  if (!databaseUrl) fail("缺少 DATABASE_URL。", "先在 .env 里配置数据库连接。");
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    fail("DATABASE_URL 格式不对。", "例子：postgresql://yiling_hub:密码@localhost:5432/yiling_hub");
  }
  const user = decodeURIComponent(url.username || "yiling_hub");
  const database = decodeURIComponent(url.pathname.replace(/^\//, "") || "yiling_hub");
  return { user, database };
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backup() {
  const { user, database } = databaseIdentity();
  mkdirSync(backupRoot, { recursive: true });
  const name = `desktop-${timestamp()}${label ? `-${label}` : ""}`;
  const target = path.join(backupRoot, name);
  mkdirSync(target, { recursive: true });
  const dumpFile = path.join(target, "database.dump");

  console.log(`备份数据库到 ${dumpFile}`);
  const output = openSync(dumpFile, "w");
  let dump;
  try {
    dump = spawnSync(
      "docker",
      ["exec", container, "pg_dump", "--username", user, "--dbname", database, "--format=custom", "--no-owner", "--no-privileges"],
      { stdio: ["ignore", output, "inherit"], env: process.env },
    );
  } finally {
    closeSync(output);
  }
  if (dump.error?.code === "ENOENT") fail("找不到 docker。", "先安装并启动 Docker Desktop。");
  if (dump.status !== 0) fail("pg_dump 失败。", `确认容器 ${container} 正在运行，且数据库用户/库名正确。`);
  if (!existsSync(dumpFile) || statSync(dumpFile).size <= 0) fail("备份文件为空。");

  const copied = [];
  for (const file of ["credentials-encryption.key", "snowluma-home.json"]) {
    const source = path.join(dataDir, file);
    if (!existsSync(source)) continue;
    copyFileSync(source, path.join(target, file));
    copied.push(file);
  }
  if (!copied.includes("credentials-encryption.key")) {
    console.warn("⚠ 没有找到 credentials-encryption.key；恢复后渠道/模型凭据需要重新填写。");
  }

  writeFileSync(path.join(target, "manifest.json"), JSON.stringify({
    createdAt: new Date().toISOString(),
    database,
    user,
    container,
    files: ["database.dump", ...copied],
    note: "恢复前先停应用；database.dump 用 pg_restore 恢复，key 放回 <data>。",
  }, null, 2), "utf8");

  prune();
  console.log(`✓ 备份完成：${target}`);
  console.log(`  大小：${(statSync(dumpFile).size / 1024 / 1024).toFixed(1)} MB`);
  return target;
}

function prune() {
  if (!existsSync(backupRoot)) return;
  const entries = readdirSync(backupRoot)
    .filter((name) => name.startsWith("desktop-") && !name.endsWith(".partial"))
    .map((name) => ({ name, full: path.join(backupRoot, name), at: statSync(path.join(backupRoot, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const entry of entries.slice(10)) {
    try {
      rmSync(entry.full, { recursive: true, force: true });
      console.log(`  清理旧备份：${entry.name}`);
    } catch {
      // 删不掉就留着；备份宁可多不可少
    }
  }
}

if (command === "list") {
  if (!existsSync(backupRoot)) {
    console.log("还没有备份。");
    process.exit(0);
  }
  const names = readdirSync(backupRoot).filter((name) => name.startsWith("desktop-") && !name.endsWith(".partial")).sort().reverse();
  if (!names.length) console.log("还没有备份。");
  for (const name of names) {
    const file = path.join(backupRoot, name, "database.dump");
    const size = existsSync(file) ? `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB` : "缺少 dump";
    console.log(`${name}  ${size}`);
  }
  process.exit(0);
}

if (command !== "backup") fail(`未知命令：${command}`, "可用：backup / list");
if (runtimeMode === "embedded") {
  // A running supervisor owns this instance lock. Do not bypass it for a torn SQL/assets snapshot.
  const runtime = await openBoundDesktopDatabase({ dataDir, binDir: desktopPgBin(ROOT) });
  try {
    const target = await createDesktopPgBackup({ runtime, dataDir, label: label || "manual", quiescent: true });
    console.log(`✓ 内嵌数据库与配套文件备份完成：${target}`);
  } finally { await runtime.close(); }
} else if (runtimeMode === "external") {
  fail("外部数据库的桌面备份工具尚未配置。", "请使用与该服务端匹配的备份流程；不会自动改用Docker容器。");
} else backup();
