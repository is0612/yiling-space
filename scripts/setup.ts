/**
 * 一键初始化向导：从「刚 clone 完」到「能在浏览器登录」。
 *
 *   yarn setup            交互式，每一项都有默认值，一路回车即可
 *   yarn setup --yes      完全非交互（随机数据库密码 + admin/admin123）
 *   yarn setup --dry-run  只检测环境并打印计划，不写 .env、不启动容器
 *
 * 只负责「让它跑起来」。模型 API Key 不在命令行里问——密钥落到 shell history 和明文环境变量里
 * 都不合适，页面上填的会 AES-256-GCM 加密存库。所以这里只把人送到登录页为止。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(repoRoot, ".env");
const EXAMPLE_PATH = path.join(repoRoot, ".env.example");
const DB_SERVICE = "db";
const CONTAINER_NAME = "yiling-hub-db";

const flags = new Set(process.argv.slice(2));
const NON_INTERACTIVE = flags.has("--yes") || flags.has("-y");
const DRY_RUN = flags.has("--dry-run");

export type SetupValues = {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbPort: number;
  adminUsername: string;
  adminPassword: string;
};

/**
 * 把模板里的关键项替换掉，其余注释与可选项原样保留。
 * 密码按 URI 规则编码进 DATABASE_URL：直接拼接时，密码里的 @ / : / 会把连接串拆坏，
 * 而 POSTGRES_PASSWORD 必须保持原文——这是「三处必须一致」里唯一容易搞错的地方。
 */
export function buildEnvContent(template: string, values: SetupValues): string {
  const replacements = new Map<string, string>([
    ["POSTGRES_DB", values.dbName],
    ["POSTGRES_USER", values.dbUser],
    ["POSTGRES_PASSWORD", values.dbPassword],
    ["POSTGRES_PORT", String(values.dbPort)],
    [
      "DATABASE_URL",
      `postgresql://${values.dbUser}:${encodeURIComponent(values.dbPassword)}@localhost:${values.dbPort}/${values.dbName}?schema=public`,
    ],
    ["DEV_OWNER_USERNAME", values.adminUsername],
    ["DEV_OWNER_PASSWORD", values.adminPassword],
  ]);

  return template
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      if (!match) return line;
      const replacement = replacements.get(match[1] ?? "");
      return replacement === undefined ? line : `${match[1]}=${replacement}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const stepTotal = 6;
let stepIndex = 0;
function step(title: string): void {
  stepIndex += 1;
  console.log(`\n[${stepIndex}/${stepTotal}] ${title}`);
}
function ok(message: string): void {
  console.log(`  [ok]   ${message}`);
}
function warn(message: string): void {
  console.log(`  [!]    ${message}`);
}
function info(message: string): void {
  console.log(`         ${message}`);
}

function fail(message: string, hint?: string): never {
  console.error(`\n[失败] ${message}`);
  if (hint) console.error(`        ${hint}`);
  process.exit(1);
}

/** 终端里回显密码时只留头尾，避免初始化日志被整段抄走。 */
function mask(value: string): string {
  if (!value) return "(空)";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** 遮蔽一行 .env 的敏感内容：密码整段抹掉，连接串只保留结构。 */
function maskEnvLine(line: string): string {
  if (/^(POSTGRES_PASSWORD|DEV_OWNER_PASSWORD|LLM_API_KEY|VOICE_TTS_API_KEY|VOICE_ASR_API_KEY)=/.test(line)) {
    return line.replace(/=(.*)$/, "=***");
  }
  if (line.startsWith("DATABASE_URL=")) {
    return line.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
  }
  return line;
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

let rl: ReturnType<typeof createInterface> | null = null;

async function ask(question: string, fallback: string): Promise<string> {
  if (NON_INTERACTIVE) return fallback;
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${question} [${fallback}]: `)).trim();
  return answer || fallback;
}

async function askRequired(question: string, hint: string): Promise<string> {
  for (;;) {
    if (NON_INTERACTIVE) fail(`${question} 不能为空。`, hint);
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`  ${question}: `)).trim();
    if (answer) return answer;
    warn("这一项必须填，不能直接回车。");
  }
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (NON_INTERACTIVE) return defaultYes;
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${question} (${defaultYes ? "Y/n" : "y/N"}): `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return ["y", "yes", "是"].includes(answer);
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

function runCapture(command: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "") + (result.stderr ?? "") };
}

function runInherit(stepLabel: string, command: string): void {
  console.log(`         $ ${command}`);
  if (DRY_RUN) return;
  const result = spawnSync(command, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    fail(`${stepLabel} 失败。`, "上面的输出里有具体原因；修好后重新运行 yarn setup。");
  }
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function dbContainerRunning(): boolean {
  const services = runCapture("docker compose ps --status running --services", []);
  return services.ok && services.stdout.split(/\s+/).includes(DB_SERVICE);
}

function randomPassword(): string {
  // base64url 只含 A-Za-z0-9-_，不需要 URL 编码，也不会破坏连接串
  return randomBytes(15).toString("base64url").slice(0, 20);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(dbUser: string, dbName: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = spawnSync("docker", [
      "compose", "exec", "-T", DB_SERVICE, "pg_isready", "-U", dbUser, "-d", dbName,
    ], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
    if (probe.status === 0) return true;
    await sleep(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("忆灵空间 · 本地初始化向导");
  info(`项目目录 ${repoRoot}`);
  if (DRY_RUN) info("当前是 --dry-run：只做检测和提问，不写文件、不启动容器。");

  // --- 1. 环境 ---
  step("检查运行环境");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) fail(`Node.js 版本过低（当前 ${process.version}）。`, "请安装 Node.js 22 LTS 后重试。");
  ok(`Node.js ${process.version}`);

  if (!fs.existsSync(EXAMPLE_PATH)) fail("找不到 .env.example。", "请确认在项目根目录运行，或重新 clone 仓库。");

  const dockerVersion = runCapture("docker info --format {{.ServerVersion}}", []);
  const hasDocker = dockerVersion.ok && dockerVersion.stdout.trim().length > 0;
  if (hasDocker) {
    ok(`Docker ${dockerVersion.stdout.trim()}`);
  } else {
    warn("没有检测到可用的 Docker（未安装，或 Docker Desktop 没启动）。");
  }

  // --- 2. 现有配置 ---
  step("检查现有配置");
  let previous: SetupValues | null = null;
  /** 用户在已有 .env 时选择了「保留」：后续不再提问，也不重写文件。 */
  let keepExisting = false;
  if (fs.existsSync(ENV_PATH)) {
    const current = fs.readFileSync(ENV_PATH, "utf8");
    const read = (key: string): string => current.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
    previous = {
      dbName: read("POSTGRES_DB") || "yiling_hub",
      dbUser: read("POSTGRES_USER") || "yiling_hub",
      dbPassword: read("POSTGRES_PASSWORD"),
      dbPort: Number(read("POSTGRES_PORT") || 5432),
      adminUsername: read("DEV_OWNER_USERNAME") || "admin",
      adminPassword: read("DEV_OWNER_PASSWORD"),
    };
    warn("已经存在 .env。");
    // 没有密码的 .env 是不完整的（多半是模板直接复制来的），默认重建
    const overwrite = await askYesNo("重新生成 .env？（旧的备份成 .env.bak）", !previous.dbPassword);
    if (overwrite) previous = null;
    else keepExisting = true;
  } else {
    ok("还没有 .env，将从 .env.example 生成。");
  }

  // --- 3. 收集配置 ---
  step("确认配置");
  let values: SetupValues;
  /** 本次是否由向导启动容器；「保留现有 .env」时为 false，不碰已有的数据库。 */
  let useDocker = false;

  if (keepExisting && previous) {
    info("沿用现有 .env，不再逐项提问。");
    if (!previous.dbPassword) fail("现有 .env 里的 POSTGRES_PASSWORD 是空的。", "删掉 .env 后重新运行 yarn setup，让向导生成一份完整配置。");
    if (!previous.adminPassword) fail("现有 .env 里的 DEV_OWNER_PASSWORD 是空的。", "同上。");
    values = previous;
  } else {
    useDocker = hasDocker
      ? await askYesNo("用 Docker 起一个本地 PostgreSQL 容器？", true)
      : false;

    if (!useDocker) {
      info("那就用你自己已经装好的 PostgreSQL，下面填的信息必须和它一致。");
    }

    const dbName = await ask("数据库名", previous?.dbName ?? "yiling_hub");
    const dbUser = await ask("数据库用户名", previous?.dbUser ?? "yiling_hub");

    let dbPort = Number(await ask("数据库端口", String(previous?.dbPort ?? 5432)));
    if (!Number.isInteger(dbPort) || dbPort <= 0 || dbPort > 65535) fail(`端口 ${dbPort} 不合法。`);

    if (useDocker && !(await portAvailable(dbPort)) && !dbContainerRunning()) {
      warn(`端口 ${dbPort} 已被其它程序占用（常见于本机装过 PostgreSQL）。`);
      let candidate = dbPort + 1;
      while (candidate < dbPort + 20 && !(await portAvailable(candidate))) candidate += 1;
      if (await askYesNo(`改用 ${candidate} 起容器？`, true)) {
        dbPort = candidate;
        ok(`容器将使用端口 ${dbPort}（.env 里的端口会一并改掉）`);
      } else {
        fail("端口被占用，无法启动容器。", "关掉占用该端口的程序，或换一个端口后重新运行。");
      }
    }

    const dbPassword = useDocker
      ? await ask("数据库密码（回车＝随机生成）", previous?.dbPassword || randomPassword())
      : await askRequired("现有 PostgreSQL 的密码", "自备数据库时密码必须和库里一致，否则迁移会报认证失败。");

    const adminUsername = await ask("管理员用户名", previous?.adminUsername ?? "admin");
    const adminPassword = await ask("管理员密码（至少 8 位，含字母和数字）", previous?.adminPassword || "admin123");
    if (adminPassword.length < 8) fail("管理员密码至少 8 位。", "这是 scripts/seed-dev-user.ts 的硬性下限。");
    if (adminPassword.startsWith("replace_with_")) fail("管理员密码不能是 .env.example 里的占位符。");

    values = { dbName, dbUser, dbPassword, dbPort, adminUsername, adminPassword };

    // 非交互模式（--yes）下没有任何提问回显，这里把最终采用的值打出来，方便核对
    console.log("");
    info(`数据库  ${values.dbName} @ localhost:${values.dbPort}  用户 ${values.dbUser}`);
    info(`库密码  ${mask(values.dbPassword)}`);
    info(`管理员  ${values.adminUsername} / ${mask(values.adminPassword)}`);
  }

  // --- 4. 写 .env ---
  step("生成 .env");
  if (keepExisting) {
    ok("沿用现有 .env，未改动文件。");
  } else {
    const template = fs.readFileSync(EXAMPLE_PATH, "utf8");
    const content = buildEnvContent(template, values);
    if (DRY_RUN) {
      info("（dry-run 不写文件）将要写入的关键项：");
      for (const line of content.split("\n")) {
        if (/^(POSTGRES_|DATABASE_URL|DEV_OWNER_)/.test(line)) info(maskEnvLine(line));
      }
    } else {
      if (fs.existsSync(ENV_PATH)) fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
      fs.writeFileSync(ENV_PATH, content, "utf8");
      ok(`已写入 ${path.relative(repoRoot, ENV_PATH)}${fs.existsSync(`${ENV_PATH}.bak`) ? "（旧配置备份为 .env.bak）" : ""}`);
    }
  }

  // --- 5. 数据库 ---
  step("准备数据库");
  if (useDocker) {
    runInherit("启动数据库容器", "docker compose up -d db");
    if (!DRY_RUN) {
      const ready = await waitForDatabase(values.dbUser, values.dbName);
      if (!ready) {
        fail("数据库 60 秒内没有就绪。", `看日志：docker compose logs ${DB_SERVICE}（常见原因是端口冲突或旧数据卷密码不匹配）。`);
      }
      ok("数据库已就绪");
    }
  } else {
    info("跳过容器启动，按你自备的 PostgreSQL 直接迁移。");
  }

  // --- 6. 建表 + 建账号 ---
  step("建表并创建管理员账号");
  runInherit("应用数据库迁移", "npx prisma migrate deploy");
  runInherit("生成 Prisma Client", "npx prisma generate");
  runInherit("创建管理员账号", "npx tsx scripts/seed-dev-user.ts");

  // --- 收尾 ---
  console.log("\n" + "=".repeat(56));
  if (DRY_RUN) {
    console.log("dry-run 结束：上面就是正式运行时会做的事。去掉 --dry-run 即可执行。");
  } else {
    console.log("完成。下一步：");
    console.log("");
    console.log("  yarn dev");
    console.log("");
    console.log("然后用浏览器打开  http://localhost:3000");
    console.log(`  账号  ${values.adminUsername}`);
    console.log(`  密码  ${values.adminPassword}`);
    console.log("");
    console.log("AI 还不会说话——还需要给它填模型 Key（二选一）：");
    console.log("  · 页面里填（推荐）：登录 → 角色 →「AI 对话 → 模型参数」，Key 加密存库");
    console.log("  · 或者写进 .env 的 LLM_API_KEY / LLM_MODEL / LLM_BASE_URL，作为全局默认");
  }
  console.log("=".repeat(56) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().finally(() => rl?.close());
}
