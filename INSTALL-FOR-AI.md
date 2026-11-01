# 让 AI 帮你装

> **这份文件是写给 AI 助手读的，不是给人读的。**
> 人只需要把仓库地址和下面第 0 节那段话一起丢给 AI，剩下的由它照着做。
> 如果你就是那个 AI：按顺序执行，每一步都有「怎么算过」；失败先查第 6 节，不要跳步，也不要自己发明 API Key。

---

## 0. 用户只需要复制这一段

```
请帮我在本机安装这个项目：https://github.com/is0612/yiling-space

要求：
1. 先读仓库根目录的 INSTALL-FOR-AI.md，严格按它的步骤做。
2. 每一步执行完告诉我结果，失败就按文档第 6 节排查，不要跳步。
3. 需要管理员权限、需要我输入模型 API Key、需要我点"允许"的地方，停下来让我自己操作。
4. 装完跑 `yarn check:env`，把最后一段输出贴给我。
5. 不要动我已有的数据库和 Docker 容器，不要执行任何删除命令。
```

---

## 1. 动手前先问用户三件事

别猜，直接问，答案会改变后面所有步骤：

| 问题 | 为什么问 |
|---|---|
| 「你电脑上装 Docker Desktop 了吗？」 | 没装 → 第 3 节走「自备 PostgreSQL」分支，或先让用户装 Docker |
| 「有 OpenAI 兼容的模型 API Key 吗？（DeepSeek / 硅基流动 / 中转都行）」 | 没有 → 能装能开页面，但 AI 一个字不会回，要提前说清楚 |
| 「装在哪个盘？C 盘还剩多少？」 | Docker 数据默认落 C 盘且只增不减；C 盘剩余 < 15 GB 必须先处理 |

---

## 2. 前置检查（每条都要跑）

在终端里逐条执行，看输出判断：

| 检查 | 命令 | 通过标准 |
|---|---|---|
| Node.js | `node -v` | `v20.19.0` 及以上（22 最稳） |
| Yarn | `yarn -v` | `1.22.x`。没有就 `npm i -g yarn@1.22.22` |
| Git | `git -v` | 能打印版本即可 |
| Docker（可选） | `docker info` | 能打印 Server Version。报错但第 1 节用户说有自备 PostgreSQL → 可跳过 |
| 磁盘 | Windows：`Get-PSDrive C` | C 盘 Free ≥ 15 GB |
| 网络 | `curl -s -o /dev/null -w "%{http_code}" https://github.com` | `200`。连不上见下一步 |

**网络兜底**：国内访问 `github.com` 经常超时（`api.github.com` 却正常）。DNS 解析到的 IP 不通时，改用可用 IP 直连：

```bash
git -c http.curloptResolve=github.com:443:140.82.112.3 clone https://github.com/is0612/yiling-space.git
```

备用 IP（前一个失效就换）：`140.82.113.3`、`20.27.177.113`、`20.200.245.247`。
这条参数只对当次命令生效，不改用户配置。

---

## 3. 安装

### 3.1 有 Docker（推荐）

```bash
cd yiling-space
yarn install          # 首次约 2–5 分钟，会顺带 nuxt prepare；还没有 .env 时跳过 prisma generate（yarn setup 会补）
yarn setup            # 交互式向导
```

`yarn setup` 会依次问：数据库用 Docker 还是已有实例、端口、管理员账号密码。**全部有默认值，回车即可**。

- 想先看它要做什么：`yarn setup --dry-run --yes`（不写文件、不启动容器）
- 想全自动：`yarn setup --yes`（随机库密码 + 管理员 `admin` / `admin123`，装完提醒用户改密码）

> AI 跑向导**一律带 `--yes`**。交互版需要真实终端：在 AI、CI、管道里跑会因为拿不到输入直接报错退出（旧版本会卡在提问上直到超时）。

向导会做四件事，缺一件都不算完成：生成 `.env` 并对齐三处数据库密码 → 端口冲突自动换端口 → 拉起 PostgreSQL 容器并等它真正可连 → 应用迁移 + 建管理员账号。

> **Docker 数据盘**：安装 Docker Desktop 时不会问数据放哪，默认塞进 `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`（C 盘），而且只增不减。装完先让用户在 Docker Desktop → Settings → Resources → Advanced → **Disk image location** 换到非系统盘，再跑 `yarn setup`。搬完确认旧 `docker_data.vhdx` 已删除。

### 3.2 没有 Docker（自备 PostgreSQL）

先让用户装好 PostgreSQL 13+ 并启动，然后在 `yarn setup` 里对「用 Docker 起一个本地 PostgreSQL 容器？」选 **否**。向导会问：数据库名、用户名、端口、以及现有库的密码（主机按 `localhost` 处理）。填的信息必须和库里实际一致，否则迁移会报认证失败。

### 3.3 启动

两种方式，效果一样：

- **给非程序员**：让用户双击仓库根目录的 `启动忆灵空间.bat`。它会自检 Node / yarn / 依赖 / Prisma Client，连不上数据库就拉容器，然后起 dev server 并自动开浏览器。
- **命令行**：`yarn dev`，打开 `http://localhost:3000`。

> 端口默认 3000，读 `.env` 的 `PORT` / `NUXT_PORT`；被占用时 Nuxt 会自动换一个并在终端打印实际地址，**以终端输出为准**。想固定端口就写进 `.env`。

---

## 4. 让它能说话（必须有，否则装完是空壳）

二选一，**推荐第一个**：

1. **页面里填**：登录 → 角色 →「AI 对话 → 模型参数」→ 填 Base URL、API Key、模型名 → 点「测试连通性」。Key 用 AES-256-GCM 加密存库，页面不回显。
2. **写进 `.env`**：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`，作为没单独配置模型的角色的兜底。

常见组合：DeepSeek `https://api.deepseek.com` + `deepseek-chat`；硅基流动 `https://api.siliconflow.cn/v1`。

**API Key 必须由用户自己提供**。不要编造、不要用示例值、不要从网上找公开 Key 填进去。

---

## 5. 验收（这四条全过才算装好）

```bash
yarn check:env
```

| 验收项 | 通过标准 |
|---|---|
| 体检 | 没有 `[x]` 阻塞项；退出码 0（`[!]` 提醒不影响使用，但要看一眼） |
| 页面 | 浏览器打开后是登录页/工作台，不是白屏或 500 |
| 登录 | 用向导最后打印的账号密码能进 |
| 数据库 | `[ok] 连接成功`、`[ok] 迁移已应用`、`[ok] 管理员账号：…` 三行都在 |

`yarn check:env` 只读不改，输出里不含密钥，可以放心贴给用户或贴到 issue。

---

## 6. 常见失败与处置

| 现象 | 原因 | 怎么修 |
|---|---|---|
| `git clone` 卡住 / `Connection was reset` | github.com 被挡 | 用第 2 节的 `-c http.curloptResolve=...` |
| `yarn install` 卡在 `sharp` / `prisma` | 网络慢或没装构建依赖 | 重试一次；仍失败就 `npm config set registry https://registry.npmmirror.com` 后重试 |
| `yarn setup` 说端口 5432 被占用 | 本机已有 PostgreSQL | 让引导自动换端口；手改要同时改 `.env` 的 `POSTGRES_PORT` 和 `DATABASE_URL` 里的端口 |
| 连接被拒 `ECONNREFUSED` | 数据库容器没起 | `docker compose up -d db`，再 `docker compose logs db` 看原因 |
| `password authentication failed` | `.env` 三处密码不一致 | 重跑 `yarn setup`（会自动对齐），或手动核对 `POSTGRES_PASSWORD` / `DATABASE_URL` |
| 表不存在 / 迁移没跑 | 跳过迁移 | `yarn db:migrate:deploy` |
| 页面能开，AI 不回话 | 没配模型 Key | 见第 4 节 |
| 页面 500 且日志提 Prisma Client | 生成物缺失 | `yarn db:generate` 后重启 |
| `[x] .data/credentials-encryption.key 不存在` | 备份迁移时漏了密钥文件 | 从备份恢复；没有就重填所有 Key |

排不动就把 `yarn check:env` 的完整输出和 `docker compose ps` 的结果贴出来 —— 这两样足够定位大部分问题。

---

## 7. 你（AI）不要做的事

- **不要**编造或借用任何 API Key、数据库密码、管理员密码。
- **不要**执行 `docker volume rm`、`docker compose down -v`、`DROP DATABASE`、`rm -rf` 这类不可逆命令。
- **不要**为了"让服务起来"而关掉鉴权（`YILING_LOCAL_API_ENABLED`、`YILING_ALLOW_DEV_OWNER_BYPASS`）后当成装好了 —— 那只是本机调试通道。
- **不要**改用户已有的数据库、容器、端口占用中的服务；装不下就停下来问。
- **不要**用 `sudo` / 管理员权限静默安装系统级软件，装 Node、Docker 这类必须让用户自己点确认。
- **不要**把 `.env`、`.data/` 的内容贴到公开地方或提交进 Git。

---

## 8. 必须由用户本人做的三件事

| 事情 | 为什么 AI 做不了 |
|---|---|
| 安装 Node.js / Docker Desktop | 需要管理员授权、UAC 弹窗、可能要重启 WSL |
| 提供模型 API Key | AI 没有，也不该去猜 |
| 决定数据放哪个盘、是否备份 | 涉及用户自己的数据取舍 |

---

## 9. 可选：QQ 和 B站

这两块都要额外进程，**不装不影响网页端使用**，别在第一次安装时一起做，先把第 5 节跑通。

| 渠道 | 额外要什么 | 文档 |
|---|---|---|
| QQ 小号 | QQ 客户端 + SnowLuma 面板 + 一个不常用的小号 | [QQ 小号部署](docs/qq-onebot-deploy.md) |
| B站 值班 | `bili` CLI + 账号绑定 | [B站 值班集成](docs/bili-desk-integration.md) |

B站 值班台依赖的 `bili` 是一个独立的 PyPI 包（`bili-agent`），**不在 npm 依赖里，`yarn setup` 不会替你装**。
要用的话在项目根跑：

```bash
uv venv .venv && uv pip install --python .venv/Scripts/python.exe bili-agent==0.6.0
.venv/Scripts/bili.exe --version   # {"ok": true, "data": {"version": "0.6.0"}}
```

macOS / Linux 把 `Scripts/python.exe` 换成 `bin/python`。没装也不影响其他功能，
但进「B站值班台」会看到空数据 —— 先跑 `yarn check:env`，里面「B站 值班台（可选）」一节会明确告诉你
装没装、装在哪、有没有扫码登录。

记忆任务不在 Web 进程里跑定时器，需要另开两个常驻进程：

```bash
yarn scheduler:watch   # 排期入队
yarn worker:watch      # 消费队列
```

不跑这两个，页面照常能用，但周期快照和忆泡不会生成。

---

## 10. 装完之后

- 备份：`.\scripts\backup-db.ps1`（Windows）会生成 `.dump` + 同名 `.key`，**两个文件必须一起保存**。见 [本地开发与数据迁移](docs/local-development-and-data-migration.md)。
- 换电脑 / 迁移：同上文档第 3、6 节。
- 公网部署：见 [部署与扩展](docs/deployment.md)，HTTPS 和反向代理需要自己在服务器上演练。
