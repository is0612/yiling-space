#!/usr/bin/env node
/**
 * 打「使用版」发布包：构建镜像 → 导出 tar → 生成一个可以直接发给别人的文件夹。
 *
 * 为什么要有这个脚本：使用版的用户不装 Node、不装 git、不碰源码，
 * 他们只需要 Docker Desktop + 一个文件夹 + 两个 .bat。所以发布物必须是
 * 「镜像 + 编排 + 启动/更新脚本 + 中文说明」，而不是仓库。
 *
 * 产出（默认 dist/使用版-<版本>/）：
 *   启动忆灵空间-使用版.bat   双击启动
 *   更新到最新版.bat          双击更新（镜像 + 数据库结构）
 *   docker-compose.prod.yml   编排（只引用镜像，不在对方机器上构建）
 *   prod.env.example          首次启动自动复制成 .env（已填入随机数据库密码与管理员密码）
 *   使用说明.md               中文说明，含本次生成的管理员密码
 *   updates/yiling-space-*.tar.gz   镜像包
 *
 * 用法：
 *   node scripts/docker-pack.mjs                 # 构建 + 打包
 *   node scripts/docker-pack.mjs --skip-build    # 复用已有镜像，只重新打包
 *   node scripts/docker-pack.mjs --no-save       # 只构建镜像，不导出 tar（自己机器上用）
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const noSave = args.has("--no-save");

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version ?? "0.0.0");
const imageName = "yiling-space";
const tagVersion = `${imageName}:${version}`;
const tagLatest = `${imageName}:latest`;

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
  // 故意不用 shell：docker 是真 exe，走 shell 反而会让中文输出路径（dist\使用版-x）被 cmd 代码页弄坏。
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) fail(`${command} 执行失败：${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} 退出码 ${result.status}`);
}

/** 给每位收件人一份独立的随机密码：分发包里不出现「所有人共用同一个密码」。 */
function randomPassword(bytes = 18) {
  return randomBytes(bytes).toString("base64url");
}

step("检查 Docker");
const dockerCheck = spawnSync("docker", ["info"], { stdio: "ignore", shell: process.platform === "win32" });
if (dockerCheck.status !== 0) fail("Docker 没在运行，先启动 Docker Desktop。");
ok("Docker 可用");

if (!skipBuild) {
  step(`构建镜像 ${tagVersion}`);
  run("docker", [
    "build",
    "--build-arg", `APP_VERSION=${version}`,
    "-t", tagVersion,
    "-t", tagLatest,
    ".",
  ]);
  ok(`镜像已构建：${tagVersion} / ${tagLatest}`);
} else {
  const inspect = spawnSync("docker", ["image", "inspect", tagLatest], { stdio: "ignore", shell: process.platform === "win32" });
  if (inspect.status !== 0) fail(`本地没有 ${tagLatest}，去掉 --skip-build 重新构建。`);
  ok(`复用已有镜像 ${tagLatest}`);
}

if (noSave) {
  console.log("\n完成（--no-save：没有导出分发包）。用 docker-compose.prod.yml 直接跑就行。");
  process.exit(0);
}

step("准备分发包");
const outDir = path.join(ROOT, "dist", `使用版-${version}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "updates"), { recursive: true });
mkdirSync(path.join(outDir, "backups"), { recursive: true });

const adminPassword = randomPassword(12);
const dbPassword = randomPassword(18);

const envTemplate = readFileSync(path.join(ROOT, "prod.env.example"), "utf8")
  .replace("__POSTGRES_PASSWORD__", dbPassword)
  .replace("__ADMIN_PASSWORD__", adminPassword);
writeFileSync(path.join(outDir, "prod.env.example"), envTemplate, "utf8");

for (const file of ["docker-compose.prod.yml", "启动忆灵空间-使用版.bat", "更新到最新版.bat"]) {
  cpSync(path.join(ROOT, file), path.join(outDir, file));
}

/**
 * 批处理必须是 CRLF。
 *
 * LF 的 .bat 在 cmd 里会被拆错行（实测：整段 if(...) 块失效，报 "xxx was unexpected at this time"），
 * 而对面的用户只会看到一堆乱码报错。仓库在 Windows 上是 CRLF，但如果这个包在某台 Linux/macOS 上打包，
 * 复制过来就是 LF —— 所以在这一层统一转一次，别指望打包机的默认行为。
 */
for (const file of ["启动忆灵空间-使用版.bat", "更新到最新版.bat"]) {
  const target = path.join(outDir, file);
  const text = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  writeFileSync(target, text.replace(/\n/g, "\r\n"), "utf8");
}

const readme = `# Yiling Space 使用版 ${version}

## 装什么

只需要 **Docker Desktop**（Windows / macOS 都行）。不需要 Node、不需要 git、不需要改任何代码。

## 第一次使用

1. 安装并打开 Docker Desktop，等它显示 Running。
2. 双击 **启动忆灵空间-使用版.bat**。
   - 第一次会自动用 \`prod.env.example\` 生成 \`.env\`；
   - 会自动建好数据库、跑完数据库结构、启动网页和后台任务；
   - 浏览器会打开 http://127.0.0.1:8801。
3. 用管理员账号登录：

   - 用户名：\`admin\`
   - 密码：\`${adminPassword}\`

   登录后请到设置里改掉密码。

4. 模型 API Key 不在配置文件里填：进网页后按角色配置「API 地址 / Key / 模型」，加密保存在数据库。

## 更新到新版本

把新版本的发布包里的 \`updates\\yiling-space-*.tar.gz\` 放进本目录的 \`updates\\\`，然后双击
**更新到最新版.bat**。它会：

1. 先导出一份数据库备份到 \`backups\\pre-update-<时间>.dump\`；
2. 加载新镜像；
3. 重启容器，容器启动时自动执行 \`prisma migrate deploy\`——**数据库结构跟着更新，不用你手动跑 SQL**。

更新不会动 \`.env\`（管理员密码、端口都保留），也不会动数据卷（聊天记录、记忆、角色都在）。

## 常用命令

\`\`\`bat
启动：docker compose -f docker-compose.prod.yml up -d
停止：docker compose -f docker-compose.prod.yml down
看日志：docker compose -f docker-compose.prod.yml logs -f app
\`\`\`

停止不会删数据。只有 \`down -v\` 才会删数据卷——**别随手加 -v**。

## 数据存在哪

- 数据库：Docker 卷 \`yiling_space_prod_pg_data\`
- 加密密钥与运行数据：Docker 卷 \`yiling_space_prod_app_data\`
  （里面有 \`credentials-encryption.key\`，删了它，网页里存过的 API Key 就解不开了）
- 备份文件：本目录的 \`backups\\\`

## 想给局域网/公网用

1. 编辑 \`docker-compose.prod.yml\`，把 app 的端口改成 \`"0.0.0.0:8801:3000"\`；
2. 用反向代理配 HTTPS（见仓库 \`docs/deployment.md\`），并把 \`.env\` 里的
   \`YILING_COOKIE_SECURE\` 改成 \`true\`；
3. 管理员密码务必换成强密码。

## 出问题先看哪里

\`\`\`bat
docker compose -f docker-compose.prod.yml logs --tail 100 app
\`\`\`

- 一直转圈：数据库第一次初始化要几十秒，等一会再看。
- 说 8801 被占用：改 \`.env\` 里的 \`APP_PORT\`。
- 更新后起不来：\`backups\\\` 里有更新前的备份，可以 \`pg_restore\` 回去（见仓库 \`docs/local-development-and-data-migration.md\`）。
`;
writeFileSync(path.join(outDir, "使用说明.md"), readme, "utf8");

step("导出镜像（这一步慢，压缩后通常 500MB~1.2GB）");
const tarName = `${imageName}-${version}.tar`;
const tarPath = path.join(outDir, "updates", tarName);
run("docker", ["save", "-o", tarPath, tagVersion, tagLatest]);
ok(`镜像已导出：updates/${tarName}`);

const sizeMb = (statSync(tarPath).size / 1024 / 1024).toFixed(0);
console.log(`\n完成：${path.relative(ROOT, outDir)}  （镜像包 ${sizeMb} MB）`);
console.log("把这个文件夹整个压缩发给对方即可；对方解压后双击「启动忆灵空间-使用版.bat」。");
console.log(`\n本包管理员：admin / ${adminPassword}（也写在 使用说明.md 里）`);
