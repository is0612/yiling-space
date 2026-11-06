# 本地开发与数据迁移规范

本文说明如何在本地开发 Yiling Space、备份 PostgreSQL 数据，并将项目迁移到新电脑。脚本面向 Windows PowerShell；其他系统可按同样原则实现对应脚本。

> 当前实现状态：Nuxt 管理后台已经接入 PostgreSQL，角色 CRUD、记忆设置、会话录入/对话、快照版本、AI 记忆提炼、长期记忆、持久化任务队列、Scheduler/Worker、原始消息保留清理与审计、管理员登录与服务端会话、多用户（管理员 + 邮箱注册用户）与账号管理、QQ 小号（OneBot v11）与 B站 渠道适配器、以及 Windows 备份/恢复的**真实数据演练**均已有实现和验收。生产部署安全（HTTPS、反向代理、监控告警）见 `docs/deployment.md`，仍需在真实服务器上演练。

## 1. 文件职责

- `docker-compose.yml`：本地 PostgreSQL 服务。
- `.env.example`：环境变量模板，不含真实密钥。
- 本地真实配置放在根目录 `.env`，禁止提交到 Git。
- `prisma/schema.prisma`：Phase 0 初始数据模型；`prisma/migrations/`：Phase 2 审查并生成的数据库迁移历史。
- `scripts/backup-db.ps1`：生成 PostgreSQL 自定义格式逻辑备份。
- `scripts/restore-db.ps1`：将指定备份恢复到配置的开发数据库。
- `backups/`：本地备份输出目录，已加入 Git 忽略规则。

## 2. 首次设置（Windows）

> 想跳过手工步骤：`yarn install` 之后执行 `yarn setup`，向导会生成 `.env`（三处密码自动对齐）、拉起数据库、应用迁移并创建管理员账号。下面是等价的手动流程，适合想逐步控制每个环节的情况。

1. 安装 Git、Node.js LTS 和 Docker Desktop。

   | 装什么 | 地址 |
   | --- | --- |
   | Git | <https://git-scm.com/download/win> |
   | Node.js LTS（≥ 20.19） | <https://nodejs.org/> |
   | Docker Desktop | <https://docs.docker.com/desktop/setup/install/windows-install/> |

   > **Docker Desktop 国内直连经常下不动**：官网安装包走国外 CDN，几个 G 传一半断掉是常事。备用下载放在开发交流群里——QQ 群 **大肥鱼养殖基地ovo（1127648581）**，群文件里有安装包；装的过程中卡住了也可以直接在群里问。
   >
   > **装之前先想好数据放哪。** Docker Desktop 不会问这一步，默认全在系统盘，本项目的 PostgreSQL 就在里面。装完先改 **Disk image location**，见 [§3.2](#32-docker-数据盘默认在系统盘)。

2. 克隆仓库并进入项目根目录。
3. 复制环境变量模板：

   ```powershell
   Copy-Item .env.example .env
   ```

4. 编辑 `.env`，至少修改 `POSTGRES_PASSWORD` 与 `DEV_OWNER_PASSWORD`（至少 8 位，推荐 12 位以上），并确保 `DATABASE_URL` 中的用户名、密码、主机、端口和数据库名与上方设置一致。保持 `YILING_LOCAL_API_ENABLED=true` 仅用于本机开发；这些示例值不能用于公开服务。
5. 使用仓库锁文件安装依赖（项目统一使用 Yarn Classic 1.22.22，不要额外生成 `package-lock.json`）。先确认版本对：

   ```powershell
   yarn --version          # 应该是 1.22.x
   npm i -g yarn@1.22.22   # 不是的话装这个；Yarn 2+ (Berry) 会打乱本项目的依赖布局
   yarn install --frozen-lockfile
   ```

6. 创建备份目录并启动数据库：

   ```powershell
   New-Item -ItemType Directory -Force backups
   docker compose up -d db
   docker compose ps
   ```

7. 仓库已经包含 Prisma Schema 与初始迁移。首次使用时先校验并应用迁移、生成 Prisma Client，再创建本地开发用户：

   ```powershell
   yarn db:validate
   yarn db:migrate:deploy
   yarn db:generate
   yarn db:seed:dev
   ```

   初始迁移面向全新、空的本地开发数据库。若数据库中已有重要数据或手动创建的表，先停止并备份；不要对已有数据数据库运行重置命令。

8. 启动开发服务器，打开 `http://localhost:3000`，用 `.env` 里的 `DEV_OWNER_USERNAME` / `DEV_OWNER_PASSWORD` 登录：

   ```powershell
   yarn dev
   ```

几个容易漏掉的点：

- **`.env` 里三处数据库配置必须对上**：`POSTGRES_PASSWORD`、`DATABASE_URL` 里的密码、以及 `docker-compose.yml` 读到的那份。这是手改最容易错的地方，`yarn setup` 会自动对齐。
- **`db:seed:dev` 是幂等的**，只创建/更新 `.env` 里指定的那个本地账号，不植入任何演示角色。忘记管理员密码就改 `DEV_OWNER_PASSWORD` 再跑一次。
- **`LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` 是可选的兜底配置**，供「没有单独配置模型」的角色使用；正常应该在页面的「模型设置 → 模型参数」里按角色填。这两处都不写也能跑起来，只是 AI 不会回话。
- **周期任务不在 Web 进程里**：`yarn scheduler:run` 负责排期入队，`yarn worker:run` 负责消费，调试时用各自的 `watch` 版本。命令与间隔变量见 `docs/deployment.md` §9。

## 2.1 本地全量校验

日常开发完成后，一条命令跑完主要静态检查、自动化测试和生产构建：

```powershell
yarn verify:local
```

它会依次校验 Prisma Schema、重新生成 Client、准备 Nuxt 类型信息，然后跑 TypeScript 检查、周期调度单元测试、PostgreSQL 调度与清理集成测试、AI 来源校验与请求凭据隔离、记忆检索、角色模型参数、聊天提示词凭据隔离、私人记忆范围隔离（含数据库集成）、聊天请求幂等、登录会话与 CSRF、会话与登录限流、跨平台身份隔离、QQ 小号（OneBot）端到端（自带模拟网关与模拟模型）、B站 命令目录/值班判定/解析层与数据库集成，最后是 ESLint 和生产构建。

运行前：

- 先启动 PostgreSQL，确认 `.env` 的 `DATABASE_URL` 指向本机开发/测试库，且已应用迁移。
- 数据库集成测试会创建并清理临时数据，**不要指向含重要数据的库**。
- 该命令不会重置数据库，也不会启动 Nuxt 服务；QQ 小号测试自己拉起模拟网关与模拟模型。B站 相关测试不需要本机装 `bili` CLI。

CI 还会额外启动本地模拟模型与 Nuxt，执行完整 API 冒烟测试，并检查数据库迁移与 OpenAPI 契约。

## 3. 本地数据存放位置

PostgreSQL 的运行数据存放在 Docker named volume `yiling_postgres_data`。不要将这个卷当作唯一备份。

数据库迁移优先使用 PostgreSQL 逻辑备份（`pg_dump` 的 custom 格式）和 `pg_restore` 恢复。该方式比直接拷贝 Docker 卷更适合不同电脑、不同 Docker 环境或迁移到 Linux 服务器。

如果上传图片或其他文件存放在本地目录，还必须单独备份这些文件。仅备份 PostgreSQL 不会自动包含文件系统中的图片或附件。角色的表情包就属于这一类：清单在 `character_stickers` 表，图片本体在 `.data/stickers/<角色 id>/`，迁移时两边都要搬；只搬库的话页面会显示“图片文件不在本机”。

另外，网页中保存的角色 API Key 使用本机生成的加密密钥 `.data/credentials-encryption.key` 加密。备份/迁移包含 API Key 的数据库时，必须将该文件安全地一并备份并恢复到新电脑项目根目录的 `.data/` 下；如果丢失，原有 API Key 无法解密，需要在角色的“模型设置 → 模型参数”中重新录入。该文件已被 Git 忽略，不能提交到仓库。

## 3.1 只搬角色：角色卡

换电脑时如果只想带走「角色和她记得的事」，不必整库 dump。角色管理里可以把一个角色导出成 `.json` 角色卡，在另一台机器上导入。

- **导出**：角色管理 → 选中角色 → 「更多」里有两条：「导出角色（含朋友）」搬家自己用；「导出（不含朋友，可分享）」发给别人用。
- **导入**：角色管理页头「导入角色」→ 选文件 → 看预检摘要 → 确认。导入**总是新建角色**，同名加「副本」后缀，不覆盖已有角色。

包里装着：人设与对话示例、称呼、别名 / 简介 / 头像配色、少量模型参数（模型名、Base URL、温度、Token 上限）；所有状态为 ACTIVE 的长期记忆（角色全局 + 导出者本人的私人记忆）、忆泡、忆泡日历（哪些天整理过、整理到哪一刻）、日记与手账（含历史版本）、梗语录、当前版本的阶段总结；以及**她的朋友**（默认带）：昵称、平台账号、她私底下的叫法（备注）、聊过几次、从哪认识的、认识多久，和该朋友名下的记忆与阶段总结。

**明确不装**，以及为什么：

| 不带 | 原因 / 换机器后怎么办 |
| --- | --- |
| API Key、渠道 Token | 导出时就从 JSON 里剥掉了。换个环境本来就要重填；带出去等于把凭据交给任何拿到这个文件的人。导入后到「模型设置」重新填。 |
| 表情包图片 | 图在 `.data/stickers/<角色 id>/`，库里只有清单。换机器后在「表情包」里从 QQ 收藏夹重新同步即可。 |
| 会话原文 | 体积大且属于具体账号的聊天记录；记忆和忆泡是它的提炼结果，已经带走了。 |
| 阶段总结的来源记录 | 来源消息没跟过来，指针会指向不存在的消息。所以导入只保留总结正文，记作第 1 版。 |
| 日记/手账的来源消息与忆泡 id | 同上，换台机器就是死指针。正文、版本号、今日一句的出处（按版本号）都保留。 |
| 朋友的账号绑定（`status` / `linkedUserId`） | 那是「这个 QQ 号已验证绑定到本站某用户」的结果，属于本机本站的判断。导入只按 `(平台, 平台账号)` 认人：已有身份就沿用，不新建、不改绑定。 |
| 其他站内用户的私人记忆 | 那不是导出者的数据，导出 SQL 里就直接排除了。 |
| 账号绑定与血缘以外的身份 | 卡片里只有血缘 id（`origin.characterId`，来源角色行的标记），不含用户名、邮箱或任何账号。 |
| 渠道绑定、任务队列、用量与审计 | 与具体机器 / 账号绑定，搬过去只会制造幽灵任务和错账。 |

**朋友段要不要带，由你自己决定**：它是「她的人际关系」，但同时也装着别人的 QQ 号和「她怎么看他们」。换电脑继续养就带上；把卡发给别人前，用「导出（不含朋友，可分享）」，整段不会写进文件。群里出现过但没被搭理的残留（互动 0 次）本来就不算朋友，两种导出都不带。

**合并**：如果本机已经有「同一个她」（同一份数据导出来过，或它就是当初导出的那一个），导入时弹窗会认出来并默认走「合并进去」——本地内容一版都不删，导入的按内容去重后追加，日记/手账接成新版本。认人的依据是卡片里的血缘 id（`origin.characterId`），不按名字猜；老卡没有这段，只能新建。详见 [角色卡](character-card.md) 第 4 节。

导入后建议核对：角色列表里的记忆条数、忆泡日历能翻到旧日子、日记手账能翻到旧日期、时间线里能看到旧的阶段总结、侧栏「她的朋友」里人还在且互动次数没归零、每个人名下原来那些备注（叫法）还在。要连账号、会话、审计一起搬，请继续用下面的整库备份方案；两者可以并存 —— 先恢复整库，再按需用角色卡在不同环境之间搬单个角色。

### 删角色是不可逆的

删除没有回收站，也没有「归档」这一档。一次删除会带走：

| 一起删 | 说明 |
| --- | --- |
| 角色、会话与消息 | 会话是外键 Restrict，服务端在事务里先删会话再删角色 |
| 记忆范围及其下所有数据 | 长期记忆、忆泡、忆泡事件与日索引、阶段总结、任务队列 |
| 渠道绑定与 B 站账本 | 值班报告、已看视频、已做的动作一起走 |
| 梗、表情包清单、记忆设置、主动意图 | 都是 Cascade |
| `.data/stickers/<角色 id>/`、`.data/sticker-originals/<角色 id>/` | 磁盘上的图会整目录删掉，库里删了但图留着就是纯垃圾 |
| 群活跃度、群公告草稿、请求幂等记录 | 这三张表**没有外键**，靠服务端显式清理（历史上漏过，现在不会了） |

| 保留 | 为什么 |
| --- | --- |
| 审计日志 | `characterId` 置空；另外会写一条 `character.deleted`（含角色名和删除量），否则「她是什么时候没的」事后查不到 |
| token 用量 | 账单不该因为删角色而消失；用量页按角色聚合，孤儿行不会串到别的角色上 |
| 外部身份 | `(平台, 平台账号)` 全局唯一，同一个 QQ 号可能同时是几个角色的朋友，删一个不该动它 |

想知道某个角色到底删干净没，用 `yarn check:deleted-character <角色名或 id>`（按名字查时会翻审计日志捞 id）。

所以换电脑的正确顺序是：**先导出角色卡 → 新机器导入并核对 → 确认无误后再回旧机器删**。

历史上删过的角色会留下孤儿行和孤儿目录，用 `yarn clean:character-orphans` 先看统计（干跑，不删），确认后加 `--apply` 清理。回归验证：`yarn test:character-delete-db`。

## 3.2 Docker 数据盘默认在系统盘

**安装 Docker Desktop 时没有「数据放哪」这一步，默认就在 C 盘。** 本项目的 PostgreSQL 数据并不在仓库目录里，而在 Docker 的 WSL 虚拟磁盘中：

```
C:\Users\<用户名>\AppData\Local\Docker\wsl\disk\docker_data.vhdx
```

这个文件里装的是**整台 Docker**：所有镜像、所有卷、所有项目的数据。所以「别人装好 Docker、clone 仓库、直接跑 `yarn setup`」的结果就是数据落在系统盘。而且它**只增不减**——删角色、删会话、清空数据库都不会让它变小。

新机器上先做这一步，再跑 `yarn setup`：

1. Docker Desktop → Settings → Resources → Advanced → **Disk image location**
2. 换到非系统盘（例如 `D:\Docker\data`），Apply & restart（容器会停一会儿，属正常）
3. 回到 `C:\Users\<用户名>\AppData\Local\Docker\wsl\disk\`，确认旧的 `docker_data.vhdx` 已消失；没删就手动删掉，否则那几 GB 不会真正释放

`yarn check:env` 的 `[Docker 数据盘]` 一节会直接报出数据盘在哪个分区、占多大、还剩多少；在系统盘或剩余空间不足 15 GB 时会给出提醒。判断依据是这个 vhdx 文件，不是 `docker info` 的输出（后者只显示容器内的 `/var/lib/docker`）。

几条注意：

- **不要拿这个 vhdx 当备份。** 跨机器、跨 Docker 版本恢复会失败，也可能把容器状态一起搬坏。备份永远走第 4 节的 `.dump` + `.key`。
- 搬之前先完成一次备份并做 5.1 的恢复演练，确认备份真的能恢复，再动 Docker 设置。
- 如果项目目录本身在系统盘，`.data/`（表情包图片 + 解密密钥）和 `backups/` 也在系统盘——这三样都是必须备份的数据，只关心 Docker 位置是不够的。

## 4. 备份数据库

从仓库根目录运行（或直接双击 `scripts\backup-db.bat`）：

```powershell
.\scripts\backup-db.ps1
```

脚本会启动数据库容器（如果尚未运行），并在 `backups/` 生成带时间戳的 `.dump` 文件。

> 注意：脚本会自动定位 `docker.exe`（先查 PATH，再回退到 Docker Desktop 的默认安装路径），因此即使 `docker` 不在 PATH 中也能运行。2026-10-25 已在本机完成一次真实演练：备份生成、恢复到临时库、并逐表核对 18 张表的行数与源库完全一致后清理。

备份文件可能包含私人聊天与角色记忆，必须视为敏感数据：
- 不要提交到 Git。
- 不要放入公开共享目录。
- 需要异地保存时，使用有访问控制的存储，必要时先加密。
- 保留多个可恢复版本，定期清理过期的本地备份。
- 定期进行恢复测试，确认文件不仅“存在”而且“可用”。

## 5. 恢复数据库

> 警告：恢复脚本会清理目标数据库中的既有对象并恢复备份内容。先确认目标数据库正确，并确保已备份目标数据库中需要保留的数据。

运行（或把 `.dump` 文件拖到 `scripts\restore-db.bat` 上）：

```powershell
.\scripts\restore-db.ps1 -BackupFile ".\backups\yiling-hub-YYYYMMDD-HHMMSS.dump" -ConfirmOverwrite
```

将示例文件名替换为实际备份文件名。必须显式传入 `-ConfirmOverwrite`，脚本才会继续执行。

首次恢复到新电脑时，优先恢复到一个空的本地开发数据库。恢复完成后，检查角色数量、消息、长期记忆、快照版本、任务记录和迁移历史，再启动应用。不要在未经检查的情况下把开发数据库备份恢复到含有真实用户数据的生产数据库。

### 5.1 恢复演练（推荐每次改完 schema 跑一次）

备份从没被恢复过，就等于没有备份。用 `-TargetDb` 把备份恢复到一个临时库，生产过程库完全不受影响，也不会有交互式确认：

```powershell
.\scripts\restore-db.ps1 -BackupFile ".\backups\yiling-hub-YYYYMMDD-HHMMSS.dump" -ConfirmOverwrite -TargetDb "yiling_hub_drill"
```

脚本会自动创建临时库并恢复。恢复完逐表比对行数（`characters` / `messages` / `memory_items` / `memory_snapshots` / `memory_jobs` / `platform_connections` / `audit_logs`）与内容（记忆的 `sourceMessageId`、连接的 `credentialsCiphertext` 字节数），确认无误后删掉临时库：

```powershell
docker exec yiling-hub-db dropdb --username yiling_hub yiling_hub_drill
```

⚠️ 备份是**两个文件**：`.dump` 负责数据库，同名的 `.key` 是凭据解密密钥（`backup-db.ps1` 会一并拷贝）。只恢复 `.dump` 而不恢复 `.key`，所有渠道 Token 与模型 API Key 都会解不开——而且**不报错**，只表现为那些字段一片空白。

## 6. 更换电脑的完整流程

### 旧电脑

1. 停止正在执行写入的开发任务。
2. 执行备份脚本并确认备份文件生成。
3. 将备份文件安全地复制到加密移动硬盘或受访问控制的云盘。
4. 确认代码已提交并推送到 Git；真实 `.env` 不要提交。
5. 单独备份不在 Git 中的用户上传文件（如果有）。

### 新电脑

1. 安装 Git、Node.js LTS、Docker Desktop。
2. 克隆仓库。
3. 复制 `.env.example` 为 `.env`，设置本机开发密码和数据库连接串。
4. 创建 `backups/`，将备份文件复制到该目录。
5. 运行 `docker compose up -d db`。
6. 使用恢复脚本恢复数据库。
7. 安装项目依赖（`yarn install --frozen-lockfile`），确认 `.data/credentials-encryption.key` 已安全恢复，然后执行 `yarn db:generate` 并按当前 README 检查迁移状态。
8. 在本地启动应用，检查角色、消息、快照、版本和周期设置。
9. 测试无误后，再继续开发。

## 7. 迁移到云服务器

1. 在云环境准备独立数据库或受保护的 PostgreSQL 服务。
2. 先备份本地数据库并保留原副本。
3. 在目标环境建立与项目版本兼容的数据库。
4. 在目标环境执行已提交的迁移文件，或按经验证的恢复流程导入数据；两种方式不可不加判断地混用。
5. 通过独立且受保护的环境变量配置连接串和模型密钥。
6. 验证数据库、权限、周期设置、Worker 和备份流程。
7. 确认目标服务可用后再切换流量。
8. 生产备份必须存放在服务器之外，并定期测试恢复。

不要将本地 `.env` 原样复制到公开服务器；要为目标环境单独配置凭据。

## 8. 故障处理

先跑 `yarn check:env` 体检：它只读不改，会逐项核对 `.env` 占位符、三处密码/端口是否一致、数据库能否连接、迁移是否跑完、管理员账号是否存在、模型 Key 与加密密钥是否就位，并给出对应的修复命令。

- **数据库未启动：** 检查 `docker compose ps` 与容器日志。
- **端口冲突：** 修改 `.env` 中的 `POSTGRES_PORT`，同时同步更新 `DATABASE_URL`。
- **恢复失败：** 保留原备份文件，查看完整错误信息；不要反复对含重要数据的目标数据库尝试破坏性恢复。
- **版本不兼容：** 先确认 PostgreSQL 版本与扩展需求，测试迁移后再操作真实数据。
- **项目能运行但数据缺失：** 确认连接的是预期的数据库，不要误把空库当成恢复成功。

## 9. 保持文档同步

凡是更改 Docker 服务、数据库版本、环境变量、Prisma 命令或备份/恢复行为，都必须同步修改本文、`.env.example` 和相关脚本。脚本变更需要在本地测试；文档不能声称未经验证的命令已成功执行。