# 忆灵空间 · Yiling Space

**让 AI 角色拥有自己的经历、记忆与持续成长能力。**

忆灵空间（Yiling Space）是一个可以自行部署的多角色 AI 养成平台。你可以创建不同的 AI 角色，为它们配置独立的人设和模型，让它们通过网页、QQ 等入口与你互动。系统会从对话中提炼重要经历，逐步形成忆泡、周期快照和长期记忆，让角色不再只是一次性的聊天对象。

[![License: MIT](https://img.shields.io/badge/license-MIT-4C8DF6)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-3AC36A)](package.json)
[![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82)](https://nuxt.com)


## 不想看安装说明？让 AI 帮你装

如果你使用的 AI 助手能够操作本机终端和文件，可以直接把下面这段话发给它。它会按照项目安装手册检查环境、执行安装，并在需要你授权或提供信息时停下来。

```text
请帮我在本机安装这个项目：https://github.com/is0612/yiling-space

1. 先阅读仓库根目录的 INSTALL-FOR-AI.md，严格按文档步骤执行。
2. 每一步完成后告诉我结果；遇到问题先按文档排查，不要跳步。
3. 需要管理员权限、需要我提供模型 API Key 或需要我点击允许时，停下来让我自己操作。
4. 不要修改我已有的数据库或 Docker 容器，不要执行任何删除数据的命令。
5. 安装完成后运行 yarn check:env，并告诉我如何启动和登录。
```

完整安装指引：[INSTALL-FOR-AI.md](INSTALL-FOR-AI.md)。

> 这需要 AI 助手具备本机终端/文件操作能力；普通聊天机器人可以提供步骤指导，但不能代替你在电脑上执行命令。首次安装建议使用交互式向导并设置自己的管理员密码。不要把非交互安装默认的 `admin / admin123` 用于公网或多人部署。


## 核心能力

| 能力 | 说明 |
| --- | --- |
| **多角色管理** | 创建和管理不同 AI 角色，维护各自的人设、模型配置、对话与记忆档案。 |
| **分层记忆引擎** | 将原始对话整理为忆泡、周期快照和长期记忆，区分具体经历与长期有效的信息。 |
| **记忆来源追溯** | 记忆条目保留来源关联，支持回看相关原始对话或事件依据。 |
| **日记与手账** | 将角色经历整理为独立的日记和手账，支持编辑、版本查看与恢复。 |
| **多渠道互动** | 支持网页工作台、QQ OneBot v11，以及 B站值班台等功能模块。 |
| **自主部署与数据管理** | 使用自己的 PostgreSQL 数据库；模型凭据加密保存，支持数据备份与恢复。 |

### 记忆如何形成

`原始对话 → 忆泡（按天整理的事件） → 周期快照（阶段总结） → 长期记忆（持续有效的信息）`

- **原始对话**：保留对话事实，是后续提炼和追溯的依据。
- **忆泡**：按天整理具体发生的事情，记录事件、时间、参与者和来源。
- **周期快照**：按角色配置的周期归纳一段时间内的重要经历、事实变化、关系和目标。默认周期为 8 天，可调整。
- **长期记忆**：维护值得长期保留的事实、偏好、关系和承诺，并支持状态管理。

> 记忆提炼需要配置模型服务，并运行后台调度器与 Worker。聊天页面能打开，不代表后台记忆任务已经启动。

## 快速开始

### 环境要求

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **20.19+**（建议使用 LTS） | 必需 |
| Yarn Classic | **1.22.x** | 必需；项目使用 Yarn 1 |
| PostgreSQL | 可连接的数据库 | 必需；可以使用本机安装的 PostgreSQL |
| Docker Desktop | 可选 | 方便在本机启动 PostgreSQL；不用 Docker 时需要自行准备数据库 |

安装 Yarn Classic：

```bash
npm install --global yarn@1.22.22
```

### 安装并启动

在项目根目录执行：

```bash
yarn install
yarn setup
yarn dev
```

打开 [http://localhost:3000](http://localhost:3000)，使用初始化向导最后显示的管理员账号登录。

`yarn setup` 会检查运行环境、生成 `.env`、准备 PostgreSQL、应用数据库迁移并创建管理员账号。检测到 Docker 时可以选择使用 Docker 启动本地数据库；也可以连接自己已有的 PostgreSQL。

> **安全提醒：** 首次安装建议使用交互式 `yarn setup`，自行设置管理员密码。`yarn setup --yes` 是便于脚本运行的非交互模式，当前默认管理员凭据为 `admin / admin123`，只适合隔离的本机测试。不要将这组默认凭据用于公网或多人部署。

Windows 用户也可以双击仓库根目录的 **`启动忆灵空间.bat`**，按提示完成自检、启动数据库和开发服务。

已有账号和数据，想在这台电脑日常使用时，先停止开发版及其后台进程，再双击源码根目录的 **`启动忆灵空间-使用版.bat`**。它用生产模式运行，默认网页端口为 **8801**，沿用原 `.env`、数据库、账号密码及 `.data` 中的密钥和素材；首次缺少构建时自动构建，不需要另装 Docker 使用版镜像。对应命令为：

```bash
node scripts/launch.mjs --production
```

更新本地源码后，双击源码根目录的 **`更新到最新版.bat`**，或执行 `node scripts/launch.mjs --production --rebuild`，重新构建并启动当前源码。它不会自动从 GitHub 下载代码，也不会重设原账号密码。开发模式与本地生产模式共用数据库，切换时应停止上一套服务和 Worker，避免后台任务重复运行。

给其他电脑分发的 **Docker 发布包**是另一种安装方式：包内同名批处理运行镜像，使用独立数据库和新安装账号。构建、分发和更新步骤见[使用版打包与分发](docs/使用版打包与分发.md)。

其他初始化方式：

| 命令 | 用途 |
| --- | --- |
| `yarn setup` | 交互式初始化，适合首次安装 |
| `yarn setup --dry-run` | 检查环境并显示执行计划，不写文件、不启动容器 |
| `yarn setup --yes` | 非交互初始化；默认凭据仅限本机测试，见上方安全提醒 |
| `yarn check:env` | 只读检查配置、数据库连接、迁移、管理员账号和加密密钥状态 |

遇到安装或迁移问题，先运行：

```bash
yarn check:env
```

再参考[本地开发与数据迁移](docs/local-development-and-data-migration.md)中的手动安装和故障排查步骤。

## 配置 AI 模型

完成安装后，页面可以正常打开、创建角色，但**没有配置模型时，AI 无法生成回复或执行记忆提炼**。

推荐在网页中配置：

1. 登录忆灵空间。
2. 进入「角色」并打开对应角色。
3. 找到「模型设置 → 模型参数」。
4. 填写 API Base URL、API Key 和模型名称。
5. 点击「测试连通性」。

项目支持 OpenAI 兼容接口。你可以使用 OpenAI、DeepSeek、硅基流动或其他兼容服务，也可以填写自己部署的模型服务地址。

也可以在 `.env` 中配置 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`，作为角色未单独配置模型时的默认值。

> **数据与隐私：** 模型请求会发送到你配置的 API 服务地址。记忆提炼可能包含所选聊天片段、角色范围和相关记忆上下文。请先了解模型服务商的数据保留、训练使用和区域处理政策，并在需要时告知相关用户、取得同意。模型 Key 使用 AES-256-GCM 加密保存；加密密钥位于本机被 Git 忽略的 `.data/credentials-encryption.key`。备份数据库时，必须同时安全备份这个密钥文件，否则恢复后已保存的模型 Key 将无法解密。

## 启动记忆引擎

忆灵空间把周期调度与记忆处理放在独立后台进程中，不依赖 Web 服务进程内的定时器。

在两个独立终端中分别运行：

```bash
# 检查到期周期，并把记忆任务写入 PostgreSQL 队列
yarn scheduler:watch
```

```bash
# 消费队列，调用模型执行忆泡整理、快照和相关记忆任务
yarn worker:watch
```

两个进程都需要持续运行。生产部署时，建议使用 Docker、systemd、进程管理器或其他守护方式管理它们。进程启动不代表任务一定正常推进，可以使用以下命令检查：

```bash
yarn watchdog:run
```

完整进程模型、监控与部署说明见[部署与扩展](docs/deployment.md)。

## 可选渠道接入

渠道适配器需要单独配置和启动；不接入这些渠道，也不影响网页端的基本使用。

| 渠道 | 能力概览 | 文档 / 入口 |
| --- | --- | --- |
| **QQ 小号** | 通过 OneBot v11 接入 QQ 群聊与私聊，支持角色绑定、上下文管理和消息收发。建议使用独立小号，不要直接使用日常主账号测试。 | [QQ 小号部署](docs/qq-onebot-deploy.md) |
| **B站值班台** | 配置账号和角色后，按值班计划浏览与筛选内容，记录处理结果并生成轮次报告。 | 管理员「系统管理 → B站值班台」；[集成说明](docs/bili-desk-integration.md) |

QQ 渠道需要额外的 OneBot v11 服务与连接配置，启动命令：

```bash
yarn onebot:stack
```

B站适配器与值班服务的部署方式见对应集成文档。

## 文档导航

### 安装、使用与部署

- [给 AI 助手的安装说明](INSTALL-FOR-AI.md) — 面向新电脑的安装流程与失败排查。
- [本地开发与数据迁移](docs/local-development-and-data-migration.md) — 手动安装、数据盘迁移、备份与恢复。
- [部署与扩展](docs/deployment.md) — 生产进程模型、HTTPS、反向代理、监控、日志和 Watchdog。
- [QQ 小号部署](docs/qq-onebot-deploy.md) · [B站值班集成](docs/bili-desk-integration.md)。
- [安全与隐私规范](docs/security.md) — 鉴权、数据隔离、凭据和记忆数据处理。

### 产品功能与技术设计

- [功能总表](<docs/忆灵空间 · 功能总表.md>) — 按模块查看已实现能力与状态。
- [记忆系统与周期快照规则](docs/memory-system.md) — 四层记忆的职责、来源和运行规则。
- [记忆与成长：现状、改动与方案](docs/memory-and-growth.md) — 2026-11 的复盘：记忆为什么断、改了什么、成长怎么做。
- [日记与手账](docs/journal.md) · [主动消息](docs/proactive-messaging.md) · [语音](docs/voice.md)。
- [互动经验](docs/interaction-experiences.md) · [表达习惯](docs/expression-habits.md) · [社交系统](docs/social-relationship-system.md) — 私聊教育如何经审核变成跨场景可用的抽象规则。
- [QQ 空间](docs/qq-qzone.md) — 发说说、看好友动态、评论别人的说说（草稿 + 确认）。
- [角色卡导入导出](docs/character-card.md) · [跨平台身份](docs/cross-platform-identity.md)。
- [数据模型](docs/data-model.md) · [Prisma Schema](prisma/schema.prisma) · [OpenAPI 契约](docs/openapi.yaml)。

### 参与开发

- [CLAUDE.md](CLAUDE.md) — 代码约束与协作规则。
- [开发阶段与验收标准](docs/development-phases.md)。
- [GitHub Issues](https://github.com/is0612/yiling-space/issues) — 报告问题或提出功能建议。

## 交流与反馈

**QQ 群：大肥鱼养殖基地ovo（1127648581）**

安装遇到问题、希望交流使用方式或讨论实现细节，都欢迎加入。确定是 Bug 或希望增加功能，建议优先提交 [GitHub Issue](https://github.com/is0612/yiling-space/issues)，方便跟踪处理。

提交问题时，可以附上 `yarn check:env` 的输出和 `docker compose ps` 的结果。检查输出不包含密钥，但可能包含角色名等信息，公开前请自行检查并删除不希望披露的内容。

## 许可与合规

本项目采用 [MIT License](LICENSE)，© 2026 is0612。

- 仓库不包含任何官方角色素材、图片或语音模型；角色人设、台词和音色由使用者自行准备。
- 导入第三方作品的角色内容时，请遵守原权利人的授权与使用规则。项目的 MIT 许可不覆盖这些第三方素材。
- 聊天记录、忆泡、快照和备份可能包含敏感信息。部署给他人使用前，请明确数据用途、访问范围、保留期限和删除规则，并妥善保护数据库与备份。
- 公开部署前，请完成 HTTPS、反向代理、数据库访问限制、备份恢复演练和监控告警配置。具体要求见[安全规范](docs/security.md)与[部署文档](docs/deployment.md)。
