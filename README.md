# 忆灵空间 · Yiling Space

**一个自己部署的多角色 AI 养成空间。** 角色在 QQ 群、QQ 私聊、B站 值班台、网页工作台四处活动，所有经历写进同一份分层记忆。数据存在你自己的 PostgreSQL 里，模型 Key 加密入库，不经过第三方中转。

[![License: MIT](https://img.shields.io/badge/license-MIT-4C8DF6)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-3AC36A)](package.json)
[![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82)](https://nuxt.com)

> 已经能用的部分：角色档案、四层记忆（原文 / 忆泡 / 快照 / 长期记忆）、AI 对话与记忆检索、日记手账、多用户与管理员、QQ 小号（OneBot v11）、B站 值班台、角色卡导入导出、备份恢复。
> 公网部署加固（HTTPS、反向代理、监控告警）需要在真实服务器上自行演练，见 [部署与扩展](docs/deployment.md)。
> **完整功能清单**（13 模块 / 122 接口 / 32 表）见 [功能总表](<docs/忆灵空间 · 功能总表.md>)。

---

## 1. 5 分钟跑起来

前提：装三样东西。

| 装什么 | 从哪装 |
| --- | --- |
| Node.js **20.19+**（实测 22） | [nodejs.org](https://nodejs.org/) 下 LTS 即可 |
| Yarn Classic **1.22.x** | `npm i -g yarn@1.22.22` |
| Docker Desktop | [官方安装说明](https://docs.docker.com/desktop/setup/install/windows-install/) |

> **两个和 Docker 有关的坑，都是装的时候就要处理：**
>
> 1. **下不动。** 官网走国外 CDN，几个 G 的安装包国内直连经常半路断掉。开发交流群里放了安装包备份：QQ 群 **大肥鱼养殖基地ovo**（群号 **1127648581**）。
> 2. **数据默认落在系统盘。** 安装时不会问你放哪，全部塞进 `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`，而且只增不减。装完先把 **Disk image location** 换到非系统盘，再跑 `yarn setup`——原因和步骤见 [Docker 数据盘默认在系统盘](docs/local-development-and-data-migration.md#32-docker-数据盘默认在系统盘)。

没有 Docker 也能用——本机装好 PostgreSQL，向导会问你连接信息。

```bash
yarn install
yarn setup      # 交互式；AI / 脚本 / CI 里改用 yarn setup --yes
yarn dev
```

打开 `http://localhost:3000`，用向导最后打印的账号密码登录。

> 不想自己敲命令？仓库根目录有 **`启动忆灵空间.bat`**，双击即可：自检 → 拉起数据库 → 起服务 → 开浏览器。
> 想让 AI 帮你装？把仓库地址和 [INSTALL-FOR-AI.md](INSTALL-FOR-AI.md) 第 0 节那段话一起发给它。

`yarn setup` 替你做这些事：

- 生成 `.env`，**把三处数据库密码自动对齐**（手改最容易错的地方）
- 端口被占用时自动换下一个空闲端口，并同步改连接串
- 拉起 PostgreSQL 容器，**等它真正就绪**再往下走
- 应用数据库迁移、创建管理员账号

| 命令 | 用途 |
| --- | --- |
| `yarn setup` | 交互式，每项都有默认值，一路回车即可（需要真实终端；AI / 脚本 / CI 里跑会直接报错退出） |
| `yarn setup --dry-run` | 只检测环境、打印将要做什么，不写文件不动数据库 |
| `yarn setup --yes` | 完全非交互（随机库密码 + `admin` / `admin123`），AI / 脚本 / 管道里用这个 |

重复运行是安全的：检测到已有 `.env` 会问要不要重建，重建前备份成 `.env.bak`。
不想走向导就按 [手动步骤](docs/local-development-and-data-migration.md#2-首次设置windows) 一步步来。

## 2. 让它开口说话

**跑起来不等于会聊天。** 没配模型时页面能进、能建角色，但 AI 一个字都不会回。二选一：

1. **页面里填（推荐）**：登录 → 角色 →「AI 对话 → 模型参数」→ 填 API Base URL、API Key、模型名 → 点「测试连通性」。Key 用 AES-256-GCM 加密存库，页面不回显原文。
2. **写进 `.env`**：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`，作为没单独配置模型时的兜底默认值。

任何 OpenAI 兼容接口都能用（OpenAI、DeepSeek、硅基流动、各类中转）。

> 加密密钥在 `.data/credentials-encryption.key`，已被 Git 忽略。**备份数据库时它必须一起备份**，丢了就得重填所有 Key。

## 3. 出问题先体检

```bash
yarn check:env
```

只读、不改文件，逐项核对：`.env` 是否为占位符、三处密码/端口对不对得上、数据库连不连得上、迁移跑没跑完、管理员账号在不在、模型 Key 配没配、加密密钥文件丢没丢、**Docker 数据盘在哪个分区/还剩多少**。每处问题都用大白话说明并给出可照做的修复步骤；有阻塞问题时退出码为 1，可以直接挂 CI。

| 症状 | 原因与处理 |
| --- | --- |
| `yarn setup` 说端口 5432 被占用 | 本机装过 PostgreSQL 又想用 Docker。向导会自动换端口；手改要同时改 `.env` 的 `POSTGRES_PORT` 和 `DATABASE_URL` 里的端口 |
| 提示「密码至少 8 位」 | `scripts/seed-dev-user.ts` 的硬性下限，且不能是 `replace_with_` 开头的占位符 |
| 忘记管理员密码 | 改 `.env` 的 `DEV_OWNER_PASSWORD`，再跑一次 `yarn db:seed:dev`（幂等） |
| 页面能打开但 AI 不回话 | 没配模型 Key，见上一节 |
| 迁移报认证失败 | `.env` 里的密码和数据库实际密码不一致，用 `yarn setup` 重建或手动核对三处 |
| 数据库起不来 | `docker compose ps` 看状态，`docker compose logs db` 看原因 |
| 想让本地也必须登录 | `.env` 设 `YILING_ALLOW_DEV_OWNER_BYPASS=false`（默认 localhost 免登录，方便调试） |

## 4. 想接 QQ 和 B站

这两块都要额外进程，不装也不影响网页端正常使用。

| 渠道 | 做什么 | 怎么开 |
| --- | --- | --- |
| QQ 小号 | OneBot v11 挂个人号，群聊/私聊收发、按话题参与、限流、群公告 | `yarn onebot:stack`，清单见 [QQ 部署](docs/qq-onebot-deploy.md) |
| B站 值班 | 自动刷 B站、判重、写日报、札记回写记忆 | 管理员「系统管理 → B站 值班台」，见 [集成说明](docs/bili-desk-integration.md) |

记忆任务不在 Web 进程里跑定时器，走 PostgreSQL 持久化队列：

```bash
yarn scheduler:watch   # 排期入队，默认每 60 秒一轮
yarn worker:watch      # 消费队列
```

进程活着 ≠ 任务在走，`yarn watchdog:run` 会判「排期没跑」还是「Worker 没跑」。完整说明见 [部署与扩展 §8–9](docs/deployment.md)。

## 5. 文档地图

**想把它跑起来 / 部署出去**

- [给 AI 的安装说明](INSTALL-FOR-AI.md) — 让 AI 助手照着一台新电脑装好，含失败排查
- [本地开发与数据迁移](docs/local-development-and-data-migration.md) — 手动步骤、全量校验 `yarn verify:local`、备份恢复
- [部署与扩展](docs/deployment.md) — 进程模型、HTTPS、监控、日志、Watchdog
- [QQ 小号部署](docs/qq-onebot-deploy.md)｜[B站 值班集成](docs/bili-desk-integration.md)
- [安全与隐私规范](docs/security.md)

**想搞懂它怎么设计的**

- [功能总表](<docs/忆灵空间 · 功能总表.md>) — 13 个模块逐项列，带状态标记
- [记忆系统与周期快照规则](docs/memory-system.md) — 四层记忆的完整定义
- [日记与手账](docs/journal.md)｜[主动消息](docs/proactive-messaging.md)｜[语音](docs/voice.md)
- [角色卡导入导出](docs/character-card.md)｜[跨平台身份](docs/cross-platform-identity.md)
- [数据模型](docs/data-model.md)｜[Prisma Schema](prisma/schema.prisma)｜[OpenAPI 契约](docs/openapi.yaml)

**想改代码**

- [CLAUDE.md](CLAUDE.md) — 代码约束与协作规则
- [开发阶段与验收标准](docs/development-phases.md)

## 6. 交流与反馈

**QQ 群：大肥鱼养殖基地ovo（1127648581）** — 装不上、跑挂了、想聊实现都在这儿问。群文件里有 Docker Desktop 的安装包备份（官网国内直连经常下不动）。

确定是 bug 或想要功能，开 [issue](https://github.com/is0612/yiling-space/issues) 更不容易漏。附上 `yarn check:env` 的输出会有帮助——它不含任何密钥，但会带角色名，发之前自己扫一眼。

## 7. 许可与合规

[MIT](LICENSE) © 2026 is0612

- 仓库**不包含**任何官方角色素材、图片或语音模型。角色人设、台词、音色均由使用者自行准备。
- 若你导入的角色来自第三方作品，其版权归原权利人，请在授权范围内使用；本项目的 MIT 许可不覆盖这些内容。
- 部署给他人使用时：聊天记录和快照属于敏感数据，AI 提炼会把消息片段发送到你配置的模型服务，请先确认供应商的数据条款并取得用户同意。详见 [安全规范 §5](docs/security.md)。
