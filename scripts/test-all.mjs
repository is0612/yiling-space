/**
 * 一把跑完所有测试。
 *
 * 为什么需要这个：`package.json` 里已经有 197 个 `test:*`，但它们只是「各自能被点名叫到」，
 * 没有一条命令能跑全部。结果是 CI 只手写了 40 个 step，剩下的 156 个从来没在流水线上跑过 ——
 * 测试存在，但不构成门禁。这个脚本把「定义了什么」和「跑了什么」变成同一件事。
 *
 * 为什么读 package.json 而不是遍历 scripts/ 目录：目录里有一批不会被任何人调用的脚本
 * （临时排查、回填数据、CI 专用），而 `test:*` 是作者明确认可「这是一条测试」的集合。
 * 以 package.json 为准，加测试就自动进入跑批，不需要记得再改这里。
 *
 * 用法：
 *   yarn test:all                 全部，顺序执行
 *   yarn test:all --only=memory   只跑名字匹配正则的
 *   yarn test:all --skip=-db      排除名字匹配正则的
 *   yarn test:all --db            只跑数据库相关（-db）
 *   yarn test:all --bail          第一个失败就停
 *   yarn test:all --timeout=600000  单条超时（默认 300s）
 *   yarn test:all --verbose       成功的用例也打印输出
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const matched = raw.match(/^--([^=]+)(?:=([\s\S]*))?$/);
    return matched ? [matched[1], matched[2] ?? "true"] : [raw.replace(/^--/, ""), "true"];
  }),
);

const timeoutMs = Number(args.timeout ?? 300_000);
const bail = args.bail === "true";
const verbose = args.verbose === "true";
const only = args.only ? new RegExp(args.only, "i") : null;
const skip = args.skip ? new RegExp(args.skip, "i") : null;

const SCRIPT_REF = /scripts\/[A-Za-z0-9._-]+\.(?:ts|mjs)/g;

const all = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts)
  .filter(([name]) => name.startsWith("test:"))
  // 自己不能跑自己。`test` / `test:all` 都指向本脚本，不过滤掉就是无限递归 ——
  // 第一次跑的时候就踩到了：第 1 条 `test:all` 挂在那里，外面看起来像「测试卡住了」。
  // 判据用「命令里引用了本文件」而不是写死名字，以后换入口名也不会漏。
  .filter(([name, command]) => !/test-all\.mjs/.test(command) && name !== "test" && name !== "test:all");

/**
 * 有一部分 `test:*-db` 不能单独跑：它们自己会断言「只能在一次性数据库里执行」，
 * 因为写的是真表，跑在主库上会污染真实数据。父运行器 `test:*-isolated` 会先建临时库、
 * 跑迁移、再逐个拉起这些子测试。
 *
 * 守卫有两种写法，都要认：
 *   - 库名断言：`yiling_memory_test_<32hex>`（memory 那一族）
 *   - 环境变量：`YILING_CHAT_ISOLATED_DB=1`（chat 那一族）
 *
 * 识别分两步，缺一不可：
 *   1. 这个测试源码里**确实有**守卫（不是靠名字后缀猜 —— 后缀会骗人，守卫不会）；
 *   2. 它确实被别的测试引用：父运行器在自己的 TS 源码里 spawn 它，不在 npm 命令里，
 *      所以要读父脚本的源码找引用。
 */
const ISOLATION_GUARD = /yiling_memory_test_|ISOLATED_DB/;
const childRefs = new Set();
function readScript(file) {
  try { return fs.readFileSync(path.join(ROOT, file), "utf8"); } catch { return ""; }
}
for (const [, command] of all) {
  const own = (command.match(SCRIPT_REF) ?? [])[0];
  if (!own) continue;
  const source = readScript(own);
  if (!ISOLATION_GUARD.test(source)) continue;
  for (const ref of source.match(/[A-Za-z0-9._-]+\.(?:ts|mjs)/g) ?? []) childRefs.add(ref);
}
function basenameOf(command) {
  const own = (command.match(SCRIPT_REF) ?? [])[0];
  return own ? own.split("/").pop() : null;
}
const children = all.filter(([, command]) => childRefs.has(basenameOf(command)));
const standalone = all.filter(([, command]) => !childRefs.has(basenameOf(command)));

let selected = args.children === "true" ? all : standalone;
if (args.children === "true" && children.length) {
  console.log(`（--children：连 ${children.length} 条「由 isolated 运行器带起来的子测试」也一起跑，会失败，仅供排查）`);
}
if (args.db === "true") selected = selected.filter(([name]) => /-db\b/.test(name));
if (only) selected = selected.filter(([name]) => only.test(name));
if (skip) selected = selected.filter(([name]) => !skip.test(name));

if (!selected.length) {
  console.error("没有匹配的 test 脚本。");
  process.exit(1);
}

// --list 只列清单不跑：想知道「这条命令到底会跑什么」时用，比读代码快。
if (args.list === "true") {
  for (const [name] of selected) console.log(name);
  console.log(`\n共 ${selected.length} 条（另有 ${children.length} 条隔离库子测试由父运行器带起来，不在此列）`);
  process.exit(0);
}

/** 时间要按人看得懂的方式显示：一条 0.3s 和一条 42s 差两个数量级，统一成秒不够用。 */
function duration(ms) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * 超时要杀整棵进程树。
 *
 * 测试脚本是 `tsx xxx && node yyy` 这种 shell 串起来的，`child.kill()` 只杀得掉中间那层
 * shell；下面的 tsx / node 会变成孤儿继续跑，接着占着数据库连接和端口，后面每一条都连锁失败。
 */
function killTree(pid) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已经退出了 */ }
  }
}

function runOne(name, command) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // `tsx` / `prisma` 这些只在 node_modules/.bin 里，是 npm/yarn 调脚本时临时加进 PATH 的。
    // 这里直接 spawn 不走包管理器，得自己补上，否则每条都是「'tsx' 不是内部或外部命令」。
    const binDir = path.join(ROOT, "node_modules", ".bin");
    // Windows 控制台默认 GBK，子进程的中文报错抓回来会变乱码；先切到 UTF-8 再执行。
    const fullCommand = process.platform === "win32" ? `chcp 65001 >nul && ${command}` : command;
    const child = spawn(fullCommand, {
      cwd: ROOT,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX 下开独立进程组，超时才能整组杀掉
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        FORCE_COLOR: "0",
      },
    });

    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ name, ok: false, ms: Date.now() - startedAt, output: `${output}\n${error.message}` });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        name,
        ok: code === 0 && !timedOut,
        ms: Date.now() - startedAt,
        output: timedOut ? `${output}\n[超时] 超过 ${duration(timeoutMs)} 仍未结束，已杀掉进程树。` : output,
      });
    });
  });
}

const failures = [];
const startedAll = Date.now();
let ran = 0;
console.log(`准备跑 ${selected.length} 条测试（单条超时 ${duration(timeoutMs)}）\n`);

for (const [index, [name, command]] of selected.entries()) {
  ran += 1;
  const prefix = `[${String(index + 1).padStart(3, " ")}/${selected.length}]`;
  process.stdout.write(`${prefix} ${name} … `);
  const result = await runOne(name, command);
  if (result.ok) {
    console.log(`ok  ${duration(result.ms)}`);
    if (verbose && result.output.trim()) console.log(indent(result.output.trim()));
    continue;
  }
  console.log(`失败  ${duration(result.ms)}`);
  console.log(indent(result.output.trim() || "（没有任何输出）"));
  failures.push(result);
  if (bail) {
    console.log("\n--bail：遇到第一个失败，停止。");
    break;
  }
}

function indent(text) {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

const totalMs = Date.now() - startedAll;
console.log(`\n${"─".repeat(56)}`);
console.log(`通过 ${ran - failures.length} / ${ran}，用时 ${duration(totalMs)}`);

if (failures.length) {
  console.log(`\n失败清单：`);
  for (const failure of failures) console.log(`  - ${failure.name}`);
  process.exitCode = 1;
} else {
  console.log("全部通过。");
}
