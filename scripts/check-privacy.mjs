#!/usr/bin/env node
/**
 * 隐私门禁：这个仓库是公开的（github.com/is0612/yiling-space，MIT），
 * 已提交的文件里不该出现能**定位到具体人或账号**的内容。
 *
 * 为什么需要它：`.gitignore` 里那条「docs/ 只放工程与产品文档——聊天记录、别人的昵称、
 * 真实群号不要写进仓库」是注释，不是校验。规矩只写在注释里，就会在「这次赶时间」的时候
 * 被绕过——2026-11-04 清过一次，2026-11-05 又有人把真实群号写进 openapi 的示例文案。
 * 注释拦不住人，能失败的检查才拦得住。
 *
 * 两条规则：
 *   1. digit —— 散文文件（docs/、仓库根目录的 .md、.github/）里的 5~12 位独立数字。
 *      真实 QQ 号、群号就是这种形状；正文里出现基本只有一种解释：抄了真实数据。
 *      **只扫散文，不扫代码与测试**：UUID 片段、时长常量、贴纸 ID 在代码里遍地都是，
 *      全量扫等于天天误报，而 `scripts/privacy-allowlist.txt` 会被加到没人再看。
 *   2. term —— 真实昵称黑名单，扫所有文件。名单放 `.data/privacy-denylist.txt`
 *      （该目录被忽略）：**名单本身就含真实昵称，所以它不能进仓库**。
 *      代价是 CI 查不了昵称（公开仓库里没法存「要禁止出现的名字」），只能靠本机
 *      pre-commit。这是有意的取舍，不是遗漏。
 *
 * 用法：
 *   node scripts/check-privacy.mjs              # 扫全部已跟踪文件
 *   node scripts/check-privacy.mjs docs/        # 只扫某个路径
 *   node scripts/check-privacy.mjs --init       # 生成 .data/privacy-denylist.txt 模板
 *
 * 误报怎么办：往 `scripts/privacy-allowlist.txt` 加一行数字（占位符、时长、设备号）。
 * 那类数字是假的，公开无害；真实号码永远不要加进去。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const ALLOWLIST_PATH = resolve(ROOT, "scripts/privacy-allowlist.txt");
const DENYLIST_PATH = resolve(ROOT, ".data/privacy-denylist.txt");

/** 只看这些扩展名：二进制、图片、lock 文件跳过。 */
const TEXT_EXT = /\.(md|ts|tsx|mjs|cjs|js|vue|json|ya?ml|sql|prisma|css|scss|html|bat|ps1|toml|txt)$/i;

/** 散文文件：真实号码出现在这里的风险最高，也最没有正当理由。 */
function isProse(file) {
  if (!file.endsWith(".md")) return false;
  return !file.includes("/") || file.startsWith("docs/") || file.startsWith(".github/");
}

/**
 * 5~12 位独立数字。
 * 前后不能紧跟字母 / 数字 / 下划线 / 连字符 / 斜杠 / `#`：
 * 这样 UUID 片段、`10000001_0_0_0_...`、`f797889`、`#101620`、`180_000` 都不会命中。
 * `:` 和 `.` 不算边界字符，所以 `g:389834620` 这种会话 ID 仍然会被抓到。
 */
const DIGIT = /(?<![0-9A-Za-z_#\-/])([0-9]{5,12})(?![0-9A-Za-z_\-/])/g;

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean);
}

function loadAllowlist() {
  const numbers = new Set();
  for (const line of readLines(ALLOWLIST_PATH)) numbers.add(line);
  return numbers;
}

function loadDenylist() {
  return readLines(DENYLIST_PATH);
}

/** 中间打码：终端输出和 CI 日志都可能被贴到别处。 */
function mask(number) {
  if (number.length <= 6) return number.slice(0, 2) + "*".repeat(number.length - 2);
  return number.slice(0, 4) + "*".repeat(number.length - 6) + number.slice(-2);
}

function listFiles(targets) {
  const args = ["ls-files", "-z"];
  if (targets.length > 0) args.push("--", ...targets);
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean).filter((file) => TEXT_EXT.test(file));
}

if (process.argv.includes("--init")) {
  if (existsSync(DENYLIST_PATH)) {
    console.log(`名单已存在：${DENYLIST_PATH}`);
    process.exit(0);
  }
  mkdirSync(dirname(DENYLIST_PATH), { recursive: true });
  writeFileSync(
    DENYLIST_PATH,
    [
      "# 一行一个，命中即失败。只在本地生效（.data/ 被 git 忽略）。",
      "# 放：真实昵称、角色名、别人的 bot 名、群名、手机号等能定位到人的字符串。",
      "# 不要放：文档里本来就有的普通词（会误伤）。",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`已生成模板：${DENYLIST_PATH}`);
  process.exit(0);
}

const allowlist = loadAllowlist();
const denylist = loadDenylist();
const targets = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const files = listFiles(targets);

if (files.length === 0) {
  console.error("check:privacy —— 没有找到可扫描的文件（不在 git 仓库里？）");
  process.exit(1);
}

const problems = [];

for (const file of files) {
  let source;
  try {
    source = readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    continue;
  }
  if (source.includes("\0")) continue; // 二进制

  const lines = source.split(/\r?\n/);
  const prose = isProse(file);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;

    if (prose) {
      for (const match of line.matchAll(DIGIT)) {
        const number = match[1];
        if (allowlist.has(number)) continue;
        problems.push({
          file, line: lineNo, kind: "digit",
          detail: `疑似真实号码 ${mask(number)}`,
          hint: "换成 123456789 这类占位符；确实是假数据就加进 scripts/privacy-allowlist.txt",
        });
      }
    }

    for (const term of denylist) {
      if (line.includes(term)) {
        problems.push({
          file, line: lineNo, kind: "term",
          detail: `命中黑名单词「${term}」`,
          hint: "改成泛称（某个群友 / 外部 bot / 我们的角色）",
        });
      }
    }
  }
}

if (problems.length === 0) {
  const scope = denylist.length === 0 ? "（未配置昵称名单，只查了号码）" : "";
  console.log(`check:privacy —— ${files.length} 个文件通过${scope}`);
  process.exit(0);
}

const byFile = new Map();
for (const problem of problems) {
  if (!byFile.has(problem.file)) byFile.set(problem.file, []);
  byFile.get(problem.file).push(problem);
}

for (const [file, items] of byFile) {
  console.error(`\n✗ ${file}`);
  for (const item of items) {
    console.error(`  ${item.line}: ${item.detail}`);
    console.error(`      → ${item.hint}`);
  }
}

console.error(
  `\ncheck:privacy —— ${problems.length} 处可疑内容，分布在 ${byFile.size} 个文件。`
  + "\n这个仓库是公开的：凡是你不想让陌生人顺着找到某个具体的人或群的内容，都不该进 git。",
);
process.exit(1);
