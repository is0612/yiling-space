# 桌面数据库：显式接入、迁移与备份恢复

> 本文记录显式接入阶段；后续已增加安装包默认接线，当前构建、目录策略、VC 运行库前置和验收限制见 [Windows 安装包记录](desktop-installer.md)。

## 本阶段边界

本阶段在已有 Windows 内嵌 PG 基础上增加显式数据目录绑定、Prisma 迁移闸门、数据库与已登记持久文件的备份包、新目录恢复，以及 supervisor 的 embedded 分支。现有安装没有自动换库；默认无绑定时仍走旧 Docker 路径，Docker 故障不回落新空库。

不包含：对外安装包、任意中文程序路径支持、Docker → embedded 自动迁移、跨平台排序兼容、桌面免登录、真实用户数据库切换。所有真实回归只用了新建隔离实例和合成数据。

## 显式创建与模式选择

- `scripts/desktop-database-config.mjs` 将 `desktop-database.json` 保存在指定应用数据目录内，记录 schema 版本、embedded 模式、固定子目录 `database`、实例 ID、PG 系统标识与 initializing/restoring/ready 阶段，不保存连接密码。
- `desktop:db:init` 必须提供**不存在的新数据目录**，其父目录须已存在。即使旧目录看起来为空也不接管。创建前检查工具、平台和程序路径；进入初始化后失败则保留未完成状态，后续启动拒绝接管，不回退 Docker。
- 已有 ready 绑定优先；显式指定与绑定矛盾的 docker/external 会报错。embedded 无绑定、未知模式和 auto 一律拒绝。无绑定、无本运行时遗留标记的旧安装保持原路径。
- `YILING_PG_BIN` 必须是已验证 PG16 的绝对 bin 路径；未设置时只查预定安装包位置 `../runtime/pgsql/bin`，不猜本机其他 PostgreSQL。当前未给打包器添加该发行物。

手工隔离测试示例（路径仅作示例，先确认父目录存在且目标不存在）：

```powershell
$env:YILING_PG_BIN = 'D:\YilingRuntime\pgsql\bin'
yarn desktop:db:init --data-dir 'D:\YilingData\new-install'
$env:YILING_DATA_DIR = 'D:\YilingData\new-install'
$env:YILING_DB_RUNTIME = 'embedded'
yarn desktop
```

这不是一键安装完成态，登录仍走原账号体系。新空库的首个管理员沿用当前首次建号机制，未改变密码策略或开放免登录。

## Prisma 迁移闸门

`desktop-pg-migrations.mjs` 只接受已验证的 embedded runtime。按本地 migration.sql 的 SHA256 与数据库 `_prisma_migrations` 记录计算待执行项；不解析 `migrate status` 的自然语言输出。

拒绝未知历史、校验和不符、迁移顺序不一致、重复完成记录、未处理失败记录、矛盾状态，以及没有合法迁移历史的非空 public 业务表。正常 rolled-back 记录不算完成。只靠账本不能检测任意手工 ALTER 的语义漂移，不把 checksum 检查称作完整 schema diff。

存在 pending 时，先 await 备份成功，再复核本地文件和历史没有变化，之后运行真实 Prisma migrate deploy。CLI 使用显式的临时配置和当前 runtime 生成的连接环境，不发现旧 dotenv 配置，不把 URL/密码放进参数或日志。错误只返回类别，不转发原始 CLI 输出。完成后再次检查账本和实例身份；无 pending 不重复备份。

迁移失败时不启动消费者、不 reset/resolve 账本、不自动回写旧 dump，保留升级前备份和错误状态。恢复到另一个新目录验证旧版本数据，再决定如何处理程序与迁移版本。

## 私有备份包

`desktop-pg-backup.mjs` 仅在消费者尚未启动或已停止、且持有本实例管理锁时创建备份。SQL dump 是数据库快照，文件复制并非跨数据库/文件系统事务，因此不宣称支持任意外部写入者同时修改素材时的一致备份。

备份包括数据库，以及当前明确登记的持久配套文件：

- `credentials-encryption.key`（存在时必须是 32 字节）；
- `snowluma-home.json`、`local-exec-audit.jsonl`；
- `stickers/`、`sticker-originals/` 和持久生成图片 `images/` 的全部普通文件。

不带源实例 pgdata、DPAPI 密文、桌面 Session/bootstrap 文件、日志/cache、任意个人文件或外部协议程序的安装/登录文件。SnowLuma 路径配置只是指针，不能冒充已备份其程序和登录状态。数据库也可能含明文凭据，因此整个备份包必须按敏感数据保护。

通过实际数据库字段判断是否依赖旧密钥：角色 modelConfig 的旧 v1 密文、渠道 credentialsCiphertext、角色扮演 v1 密文。确有依赖而缺 key 时拒绝备份；合法的新实例如果没有旧密文且未生成 key，不会被无意义地挡住。这里只证明密钥存在与字节完整，不证明源库原本损坏的密钥一定可解开所有旧值；恢复演练须做实际解密验证。

文件带大小和 SHA256 清单，临时 partial 目录全部完成后才 rename 为成功备份。拒绝链接、特殊文件、路径穿越、重复/未登记 payload、错误密钥声明与哈希不符；不自动修剪新格式备份。

`yarn desktop:backup` 会按持久化绑定选择 embedded 分支。必须先关闭正在占有实例的桌面应用；应用还在运行时返回管理锁 busy，不绕过锁复制半套素材。旧 Docker 备份路径保持原样。external 桌面备份尚未接入专用客户端工具，明确报错，不改去备份默认 Docker 容器。

## 恢复只能写到新目录

```powershell
yarn desktop:db:restore --backup 'D:\private-backups\desktop-<标识>' --data-dir 'D:\YilingData\restored-install'
```

先校验整个包再创建目标目录。恢复创建新 PG 实例和当前用户 DPAPI 凭据，目标只允许空闲空数据库，`pg_restore` 使用 single-transaction/exit-on-error，不使用 DROP、clean 或覆盖开关。已有表、视图、序列、函数、自定义类型或 schema 的目标不接受恢复。

SQL 与素材恢复、文件校验及密钥依赖检查成功后，撤销**目标副本**中旧的登录会话，再提交 ready 绑定。源数据库、源会话和源素材不改动。失败关闭已确认实例，保留 restoring 阶段，不能当成可正常启动的安装，也不自动重新建空库。

恢复本身不执行模型调用，不启动 Worker、Scheduler、QQ 或网页。启动恢复副本前仍要遵循显式切换要求，不能把原实例和副本一起接到同一协议账号运行。

## Supervisor 接线与限制

- embedded 分支只打开已绑定实例，生成统一连接环境给迁移、建号、Web、Worker、Scheduler；不复制开发目录里的密钥到新实例。embedded 不接受 skip-migrate。
- Web/Worker/Scheduler 连接分别标记 PGAPPNAME，便于在目标库活动中核对。Worker 的管理锁增加显式数据库实例命名空间，避免同一源码目录下开发库的 Worker 挡住另一个 embedded 库；不传命名空间时旧锁身份保持兼容。
- 正常关闭与启动失败都先停止消费者，再关闭自己管理的数据库。不会停止仅连接的旧 Docker/external 服务。启动期间退出会在当前迁移步骤返回后检查取消，不宣称能无条件立即中断迁移；外层启动器超时/强杀后的完整进程树恢复仍需发布验收。
- embedded 尚无 QQ 协议栈实例归属验证，暂不自动复用全局端口上的旧适配器；日志明确提示手动配置。旧 Docker 分支维持原 QQ 逻辑。此处未改渠道 API 或消息协议。
- 失败初始化隔离操作只对明确未形成可用 cluster 的目录做保留证据的兄弟目录改名，并按 DATA_DIR/数据库两层管理锁串行化；ready、PG_VERSION/control、进程标记/记录或未知链接均拒绝。它不是恢复已初始化数据库的通用“强制重置”。

## 验证状态

无库回归已通过：迁移账本与备份顺序、配置绑定、路径/清单/哈希防护。第一轮真实应用演练通过：所有迁移、恢复前后全部 public 表条数、记忆来源、日记版本、图片字节、实际旧密文解密、目标会话撤销且源会话保留、篡改/覆盖/缺 key 拒绝、绑定 supervisor Web 就绪和正常关闭。

第二轮已通过真实 SQL 故障演练：先完成一版迁移并保存合成 checkpoint，再让下一版迁移失败；升级前备份可恢复 checkpoint 和无失败行的旧迁移历史，原失败账本不自动重试。离线备份 CLI 成功，运行中备份 CLI 被管理锁拒绝。

三类真实消费者已通过活动核对：Web 登录拒绝请求、Worker 与 Scheduler 的 PGAPPNAME 同时出现在同一个恢复库；不存在误复用另一个数据库 Worker 的情况。无库 Worker 守护回归新增同源码不同实例并行、同实例仍去重的场景并通过。最终启动失败收尾回归也已通过：打开自有 PG 后遇到不匹配的迁移历史，supervisor 不发 ready、退出为失败且关闭受控数据库。完整隔离应用回归约 123 秒。项目类型、lint、隐私与测试计划校验通过，生产构建报告完成且退出码为零；后台输出读取接口未能返回该次构建明细，未据此声称没有构建 warning。未运行全量业务测试，不把测试计划校验当作全量测试。

回归入口：

```powershell
yarn test:desktop-database-config
yarn test:desktop-pg-migrations
node scripts/test-memory-worker-supervisor.mjs
$env:YILING_TEST_PG_BIN = '<已校验PG16的绝对bin路径>'
yarn desktop:pg:init-recovery
yarn desktop:pg:application-smoke
```

正式安装包接线、程序路径布局、跨平台 collation 决策、跨用户/干净 Windows 验收、免登录和旧用户切换仍是后续阶段。
