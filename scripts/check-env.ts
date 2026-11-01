/**
 * 环境自检：只读不改，逐项指出哪里填错了、哪里还没填。
 *
 *   yarn check:env
 *
 * 面向「向导跑过但中途失败」和「能启动但行为不对」两种情况。它不修任何东西，
 * 也不会打印密码原文——只判断，给出可以照着做的下一步。
 *
 * 退出码：有 [x] 阻塞项时 1，只有 [!] 提醒时 0，方便挂到 CI 或计划任务里。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { isChatModelConfigured } from "../server/utils/chat-model-config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(repoRoot, ".env");
const EXAMPLE_PATH = path.join(repoRoot, ".env.example");
const CREDENTIAL_KEY_PATH = path.join(repoRoot, ".data", "credentials-encryption.key");
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";

// 一致性检查走自己解析的文件值；模型配置那部分（isChatModelConfigured）读的是 process.env，
// 所以要先把 .env 灌进去，否则「在 .env 里配了 LLM_API_KEY」会被误判成没配。
loadEnv({ path: ENV_PATH, quiet: true });

type Level = "ok" | "warn" | "error" | "info";

const counts = { error: 0, warn: 0 };
const fixes: string[] = [];

function line(level: Level, message: string): void {
  const tag = { ok: "[ok]  ", warn: "[!]   ", error: "[x]   ", info: "      " }[level];
  console.log(`  ${tag} ${message}`);
  if (level === "error") counts.error += 1;
  if (level === "warn") counts.warn += 1;
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

function fix(text: string): void {
  fixes.push(text);
}

function mask(value: string): string {
  if (!value) return "(空)";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// .env 解析：直接读文件，不走 dotenv——需要区分「没写这一项」和「写了空值」
// ---------------------------------------------------------------------------

type EnvMap = Map<string, string>;

function readEnvFile(filePath: string): EnvMap {
  const map: EnvMap = new Map();
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = raw.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(match[1] ?? "", value);
  }
  return map;
}

function get(env: EnvMap, key: string): string {
  return (env.get(key) ?? "").trim();
}

function parseDatabaseUrl(raw: string): { user: string; password: string; host: string; port: string; database: string } | null {
  try {
    const url = new URL(raw);
    if (!url.protocol.startsWith("postgres")) return null;
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: url.port || "5432",
      database: url.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

function checkEnvFile(): EnvMap | null {
  section("配置文件");
  if (!fs.existsSync(ENV_PATH)) {
    if (fs.existsSync(`${ENV_PATH}.bak`)) {
      line("error", ".env 不存在，但发现 .env.bak（向导备份过一份）");
      line("info", `可以复制回来：cp .env.bak .env，或者重新跑 yarn setup`);
    } else {
      line("error", ".env 不存在");
    }
    fix("运行 yarn setup 生成配置");
    return null;
  }

  const env = readEnvFile(ENV_PATH);
  const size = fs.statSync(ENV_PATH).size;
  line("ok", `.env 存在（${env.size} 项，${size} 字节）`);

  // .env 有没有被误纳入版本控制
  const ignored = spawnSync("git", ["check-ignore", "-q", ".env"], { cwd: repoRoot });
  if (ignored.status === 0) {
    line("ok", "已被 .gitignore 忽略，不会误提交");
  } else if (ignored.status === 1) {
    line("error", ".env 没有被 .gitignore 忽略，数据库密码会被提交到仓库！");
    fix("在 .gitignore 里加上 .env，并确认它还没进过 git 历史");
  }

  // 还是模板吗
  const placeholderKeys = [...env.entries()]
    .filter(([, value]) => value.startsWith("replace_with_"))
    .map(([key]) => key);
  if (placeholderKeys.length > 0) {
    line("error", `这些项还是模板占位符：${placeholderKeys.join("、")}`);
    fix("跑 yarn setup 让向导填好，或手动改成真实值");
  }

  // 管理员密码规则（和 seed-dev-user.ts 保持一致）
  const adminPassword = get(env, "DEV_OWNER_PASSWORD");
  if (!adminPassword) {
    line("error", "DEV_OWNER_PASSWORD 是空的，db:seed:dev 会失败");
    fix("在 .env 里设置 DEV_OWNER_PASSWORD（至少 8 位）");
  } else if (adminPassword.length < 8) {
    line("error", `DEV_OWNER_PASSWORD 只有 ${adminPassword.length} 位，seed 要求至少 8 位`);
    fix("把 DEV_OWNER_PASSWORD 改成 8 位以上");
  } else if (adminPassword.startsWith("replace_with_")) {
    line("error", "DEV_OWNER_PASSWORD 还是占位符");
  } else {
    line("ok", `管理员密码已设置（${mask(adminPassword)}，${adminPassword.length} 位）`);
  }

  return env;
}

function checkConsistency(env: EnvMap): string | null {
  section("一致性");
  const rawUrl = get(env, "DATABASE_URL");
  if (!rawUrl) {
    line("error", "DATABASE_URL 为空，Prisma 无法连接数据库");
    fix("跑 yarn setup 生成 DATABASE_URL");
    return null;
  }

  const parsed = parseDatabaseUrl(rawUrl);
  if (!parsed) {
    line("error", "DATABASE_URL 不是合法的 postgresql:// 连接串");
    fix("格式应为 postgresql://用户:密码@主机:端口/库名?schema=public");
    return null;
  }

  const envPassword = get(env, "POSTGRES_PASSWORD");
  const envPort = get(env, "POSTGRES_PORT");
  const envUser = get(env, "POSTGRES_USER");
  const envDb = get(env, "POSTGRES_DB");

  let mismatch = 0;
  if (envPassword && envPassword !== parsed.password) {
    line("error", "POSTGRES_PASSWORD 和 DATABASE_URL 里的密码不一致");
    line("info", `docker 容器用的是 ${mask(envPassword)}，Prisma 用的是 ${mask(parsed.password)}`);
    fix("两处改成同一个值（跑 yarn setup 会自动对齐）");
    mismatch += 1;
  }
  if (envPort && envPort !== parsed.port) {
    line("error", `POSTGRES_PORT=${envPort}，但 DATABASE_URL 连的是 ${parsed.port} 端口`);
    fix("两处端口改成同一个值");
    mismatch += 1;
  }
  if (envUser && envUser !== parsed.user) {
    line("error", `POSTGRES_USER=${envUser}，但 DATABASE_URL 用的是 ${parsed.user}`);
    fix("两处用户名改成同一个值");
    mismatch += 1;
  }
  if (envDb && envDb !== parsed.database) {
    line("error", `POSTGRES_DB=${envDb}，但 DATABASE_URL 连的是 ${parsed.database}`);
    fix("两处库名改成同一个值");
    mismatch += 1;
  }
  if (mismatch === 0) {
    line("ok", `四处配置一致：${parsed.user}@${parsed.host}:${parsed.port}/${parsed.database}`);
  }

  return rawUrl;
}

async function checkDatabase(rawUrl: string, env: EnvMap): Promise<void> {
  section("数据库");
  const client = new Client({ connectionString: rawUrl, connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    line("error", `连不上数据库：${message.split("\n")[0]}`);
    if (/ECONNREFUSED/i.test(message)) {
      line("info", "端口没人在听：容器没起（docker compose up -d db），或自备的 PostgreSQL 没启动");
      fix("docker compose up -d db，或启动你本机的 PostgreSQL");
    } else if (/password|authentication/i.test(message)) {
      line("info", "认证没过：端口能通，但用户名/密码对不上");
      line("info", "也可能是这个端口上跑的是另一个 PostgreSQL 实例（本机另装过一个库时很常见）");
      fix("核对密码，并确认 POSTGRES_PORT 指向的就是本项目那个库");
    } else if (/does not exist/i.test(message)) {
      line("info", "库不存在：POSTGRES_DB 指向的数据库还没建");
      fix("改库名，或用 docker compose up -d db 让它按 POSTGRES_DB 初始化");
    }
    return;
  }

  try {
    line("ok", "连接成功");

    const migrationTable = await client.query<{ t: string | null }>("SELECT to_regclass('public._prisma_migrations') AS t");
    if (!migrationTable.rows[0]?.t) {
      line("error", "表还没建（找不到 _prisma_migrations）");
      fix("yarn db:migrate:deploy");
    } else {
      const applied = await client.query<{ total: number; unfinished: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished
           FROM _prisma_migrations`,
      );
      const row = applied.rows[0];
      if (row && row.unfinished > 0) {
        line("error", `有 ${row.unfinished} 条迁移没跑完，数据库结构可能不完整`);
        fix("yarn db:migrate:deploy 重新执行");
      } else {
        line("ok", `迁移已应用（${row?.total ?? 0} 条）`);
      }
    }

    const admins = await client.query<{ username: string; role: string }>(
      `SELECT username, role FROM users WHERE role = 'ADMIN' ORDER BY "createdAt" LIMIT 5`,
    );
    if (admins.rowCount === 0) {
      line("error", "没有任何管理员账号，无法登录");
      fix("yarn db:seed:dev");
    } else {
      const names = admins.rows.map((row) => row.username).join("、");
      line("ok", `管理员账号：${names}`);
      const owner = admins.rows.find((row) => row.role === "ADMIN");
      if (owner && owner.username === "local-dev") {
        line("warn", "管理员用户名还是默认的 local-dev，登录时容易记错");
      }
    }

    const ownerExists = await client.query(`SELECT 1 FROM users WHERE id = $1`, [ADMIN_USER_ID]);
    if (ownerExists.rowCount === 0) {
      line("warn", "DEV_OWNER_ID 指向的账号不存在");
      line("info", "本地 localhost 免登录回退会失效，只能用账号密码登录");
    }

    const characters = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM characters`);
    const characterCount = characters.rows[0]?.total ?? 0;
    if (characterCount === 0) {
      line("info", "还没有角色：登录后先建一个角色，才能聊天");
    } else {
      line("ok", `角色 ${characterCount} 个`);
    }

    // ---- AI 是否配好 ----
    section("AI 模型");
    if (get(env, "LLM_API_KEY")) {
      line("ok", ".env 里配了 LLM_API_KEY（作为没单独配置的角色的默认值）");
    }
    const configs = await client.query<{ modelConfig: unknown; name: string }>(
      `SELECT name, "modelConfig" FROM characters ORDER BY "createdAt" LIMIT 50`,
    );
    const configured = configs.rows.filter((row) => isChatModelConfigured(row.modelConfig));
    if (configured.length > 0) {
      line("ok", `${configured.length} 个角色配了自己的模型 Key：${configured.map((row) => row.name).slice(0, 3).join("、")}${configured.length > 3 ? " 等" : ""}`);
    } else if (characterCount > 0) {
      line("warn", "没有任何角色配置模型 Key，聊天不会有回复");
      fix("登录 → 角色 →「AI 对话 → 模型参数」填 API Key，或设置 .env 的 LLM_API_KEY");
    }

    // ---- 凭据加密密钥 ----
    section("凭据加密");
    let encryptedKeys = 0;
    for (const row of configs.rows) {
      if (isChatModelConfigured(row.modelConfig)) encryptedKeys += 1;
    }
    if (encryptedKeys > 0 && !fs.existsSync(CREDENTIAL_KEY_PATH)) {
      line("error", `.data/credentials-encryption.key 不存在，但库里有 ${encryptedKeys} 个加密的 Key —— 它们解不开`);
      fix("从备份里恢复 credentials-encryption.key，或到页面上重新填一次 API Key");
    } else if (fs.existsSync(CREDENTIAL_KEY_PATH)) {
      line("ok", ".data/credentials-encryption.key 存在，已配置的 Key 可以正常解密");
    } else {
      line("info", "还没有加密的凭据，密钥文件会在第一次保存时自动生成");
    }
  } catch (error) {
    line("error", `查询数据库时出错：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Docker 数据盘：安装 Docker Desktop 时不会问数据放哪，默认落在系统盘，而本项目
// PostgreSQL 的全部数据就在那个 WSL 虚拟磁盘里。所以这里要能看见它在哪、还剩多少。
// 数字部分只读，不改任何东西。
// ---------------------------------------------------------------------------

const DOCKER_LOW_FREE_BYTES = 15 * 1024 ** 3;

function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function availableBytes(target: string): number | null {
  try {
    const stat = fs.statfsSync(target);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function findDockerDisks(root: string, depth = 0): { file: string; bytes: number }[] {
  if (depth > 6 || !fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { file: string; bytes: number }[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...findDockerDisks(full, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".vhdx")) {
      try {
        found.push({ file: full, bytes: fs.statSync(full).size });
      } catch {
        // Docker 正占用时可能读不到大小，跳过这一个文件即可
      }
    }
  }
  return found;
}

// 装了 Docker Desktop 才有这些目录；没装就什么都不输出，别吓人。
function dockerDataRoots(): string[] {
  const roots: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) {
    for (const file of ["settings-store.json", "settings.json"]) {
      const settingsPath = path.join(appData, "Docker", file);
      if (!fs.existsSync(settingsPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        const configured = parsed.DataFolder ?? parsed.dataFolder;
        if (typeof configured === "string" && configured.trim()) roots.push(configured.trim());
      } catch {
        // 设置文件坏了不影响后面的默认路径兜底
      }
    }
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) roots.push(path.join(localAppData, "Docker"));
  return [...new Set(roots)];
}

function checkDockerDisk(): void {
  if (process.platform !== "win32") return;

  const disks = dockerDataRoots().flatMap((root) => findDockerDisks(root));
  if (disks.length === 0) return;

  section("Docker 数据盘");
  const totalBytes = disks.reduce((sum, disk) => sum + disk.bytes, 0);
  const largest = disks.reduce((a, b) => (a.bytes >= b.bytes ? a : b));
  const diskRoot = path.parse(largest.file).root;
  const systemDrive = `${process.env.SystemDrive ?? "C:"}\\`;
  const onSystemDrive = diskRoot.toLowerCase() === systemDrive.toLowerCase();

  if (onSystemDrive) {
    line("warn", `Docker 数据盘在系统盘 ${diskRoot}（${humanBytes(totalBytes)}）`);
    line("info", "本项目的 PostgreSQL 数据全在这个虚拟磁盘里；安装 Docker Desktop 时没有「选目录」这一步");
  } else {
    line("ok", `Docker 数据盘在 ${diskRoot}（${humanBytes(totalBytes)}）`);
  }

  const free = availableBytes(diskRoot);
  if (free === null) {
    line("info", "读不到该分区的剩余空间，跳过容量检查");
  } else if (free < DOCKER_LOW_FREE_BYTES) {
    line("warn", `该分区只剩 ${humanBytes(free)}，聊天记录和忆泡会持续把它吃满`);
  } else {
    line("ok", `该分区剩余 ${humanBytes(free)}`);
  }

  if (onSystemDrive) {
    line("info", "这个虚拟磁盘只增不减：删角色、删会话都不会让它变小");
    if (path.parse(repoRoot).root.toLowerCase() === diskRoot.toLowerCase()) {
      line("info", "项目目录也在系统盘，.data/（表情包图片 + 解密密钥）与 backups/ 同样在系统盘");
    }
    line("info", "改法：Docker Desktop → Settings → Resources → Advanced → Disk image location，换到非系统盘");
    fix("装完 Docker 先把 Disk image location 改到非系统盘（如 D:\\Docker\\data），再跑 yarn setup");
  }
}

function checkRuntime(env: EnvMap): void {
  section("运行环境");

  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", shell: process.platform === "win32" });
  if (docker.status === 0) {
    const status = spawnSync("docker", ["ps", "--filter", "name=yiling-hub-db", "--format", "{{.Status}}"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const running = (status.stdout ?? "").trim();
    if (running) {
      line("ok", `数据库容器正在运行（${running}）`);
    } else {
      const exists = spawnSync("docker", ["ps", "-a", "--filter", "name=yiling-hub-db", "--format", "{{.Status}}"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      const stopped = (exists.stdout ?? "").trim();
      if (stopped) {
        line("warn", `数据库容器存在但没在跑（${stopped}）`);
        fix("docker compose up -d db");
      } else {
        line("info", "没有 yiling-hub-db 容器：你在用自己装的 PostgreSQL，或还没启动过");
      }
    }
  } else {
    line("info", "没有可用的 Docker（用自备 PostgreSQL 时正常）");
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 20) {
    line("ok", `Node.js ${process.versions.node}`);
  } else {
    line("error", `Node.js ${process.versions.node} 低于要求（需要 20.19+，推荐 22）`);
    fix("升级 Node.js 到 22 LTS");
  }

  if (fs.existsSync(EXAMPLE_PATH) && fs.existsSync(ENV_PATH)) {
    const templateKeys = [...readEnvFile(EXAMPLE_PATH).keys()];
    const envKeys = new Set(env.keys());
    const missing = templateKeys.filter((key) => !envKeys.has(key));
    if (missing.length > 0) {
      // 不是错误：旧版模板生成的 .env 天然少几项，缺的都走代码里的内置默认值。
      // 只有真启动报「缺某个变量」时才需要重新生成。
      line("info", `.env 比 .env.example 少 ${missing.length} 项（多半是 .env 来自旧版模板），缺的走内置默认值`);
      line("info", `涉及：${missing.slice(0, 4).join("、")}${missing.length > 4 ? " 等" : ""}`);
    } else {
      line("ok", "变量清单和 .env.example 对齐");
    }
  }

  checkDockerDisk();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("忆灵空间 · 环境自检（只读，不会改任何文件）");

  const env = checkEnvFile();

  if (env) {
    const rawUrl = checkConsistency(env);
    if (rawUrl) await checkDatabase(rawUrl, env);
    checkRuntime(env);
  }

  console.log("\n" + "=".repeat(56));
  if (counts.error === 0 && counts.warn === 0) {
    console.log("全部正常。");
  } else {
    const parts: string[] = [];
    if (counts.error > 0) parts.push(`${counts.error} 个阻塞问题`);
    if (counts.warn > 0) parts.push(`${counts.warn} 个提醒`);
    console.log(`小结：${parts.join("，")}`);
    if (fixes.length > 0) {
      console.log("\n可以照着做：");
      for (const [index, text] of [...new Set(fixes)].entries()) {
        console.log(`  ${index + 1}. ${text}`);
      }
    }
  }
  console.log("=".repeat(56) + "\n");

  process.exit(counts.error > 0 ? 1 : 0);
}

await main();
