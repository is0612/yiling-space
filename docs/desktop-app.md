# 桌面端：内嵌数据库、安装包与免登录

> 最后合并：2026-11-24。本文由原来 7 份分阶段记录（`desktop-postgres-a0` → `desktop-postgres-runtime` → `desktop-database-integration` → `desktop-installer` → `desktop-identity` → `desktop-identity-handoff` → `desktop-vc-runtime`）合并而成，保留全部决策、边界与踩过的坑。
> 现行验收状态以 [PROJECT_PROGRESS](development/PROJECT_PROGRESS.md) 为准；本文描述的是「桌面端怎么搭起来的、为什么这么搭」。
>
> **一句话现状：** 内嵌 PostgreSQL、显式数据目录绑定、迁移闸门、备份恢复、安装/升级/卸载、安装态主人绑定与免登录都已实现并通过隔离验收。**未验的是发布级事项**：干净 Windows VM、第二个系统用户、杀软与代码签名、系统重启恢复、另一台机器的免登录升级、旧 Docker 库的自动迁移。

## 1. 形态与目录

两种运行方式，互不影响：

| 入口 | 用途 | 数据库 |
|---|---|---|
| `yarn desktop` | 源码开发，supervisor 管 Nuxt dev，热更新 | 沿用原 Docker 路径 |
| `yarn desktop:production` | 源码生产模式，复用已有 `.output` | 同上 |
| 安装版 | 发给别人，包内自带 Node / Electron / PG | 内嵌 PG，无需目标机装 Docker / Node / Yarn |

**程序、数据、状态三者分开且互不包含：**

- **程序**：默认 `%LOCALAPPDATA%\YilingSpace`。真实程序路径**必须是 ASCII** —— 用来规避 PG16 initdb 在非 ASCII share 绝对路径上的编码问题（见 §2.6）。用户 profile 路径含中文时，改落到 OS 注册的 Public 目录下 `YilingSpace-<当前SID>` 私有子目录，不建全局 junction、不依赖 8.3 短文件名。
- **数据**：默认 `%LOCALAPPDATA%\YilingSpaceData`，**允许中文路径**。
- **安装状态**：另一个私有目录 `YilingSpaceInstallState`。

旧 Docker 安装不自动转换；默认无绑定时仍走 Docker，Docker 故障**不回落**新空库。

## 2. 内嵌 PostgreSQL

### 2.1 发行物来源

- 官方 Windows 下载页指向 EDB binaries，允许把 binaries zip 用于其他应用安装器。
- 固定 **Windows x64 PostgreSQL 16.16-2**，SHA256 `add1de261b150e6923266abee293f05050795e73f5356158aee4221a2170c073`。
- 只放行运行时与两份原始许可文件（`server_license.txt`、`commandlinetools_3rd_party_licenses.txt`），不带 pgAdmin / StackBuilder。
- 保留 bin/lib/share 约 1638 个文件、124 MiB；实际 payload 约 1.2 GiB。
- 这是 EDB 同源 HTTPS 的发布校验，**不是**经过独立验证的 PGDG 签名；不代表完成全部供应链审查。`distribution.json` 登记全部文件大小/hash，但它不是独立签名，防不住同一可信用户同时改程序与清单。
- 许可证允许分发，但组合发行物中的第三方依赖仍需分别清点声明。

### 2.2 实例目录与状态文件

实例目录含 `runtime.json`（非敏感清单：initializing/ready、实例 ID、PG 控制文件系统标识、最近管理的进程身份）、`credentials.dpapi.json`、`pgdata/`、`postgres.log`、可选的 `initdb-diagnostic.json` 与 `backups/`。

状态文件用排他临时文件写入后 rename 替换；中断的临时文件不作为正式清单。跨文件初始化不是事务，任何缺件或未 commit ready 的状态都拒绝自动接管。初始化失败保留证据，**不自动删目录**。

`openDesktopPostgres({ binDir, rootDir, initialize: true })` 只创建不存在的实例目录；已存在就拒绝，不会看 Docker 状态后自己另建空库。已有实例必须给 `expectedInstanceId`，绑定缺失/错误、不是本运行时清单、控制文件不符、主版本错误、初始化未完成、凭据损坏 → 一律停止，**不重置、不重新 initdb**。

### 2.3 凭据与权限

- 根目录关闭 ACL 继承，只授当前用户、SYSTEM 与本机 Administrators（以管理员安装时 Windows 会自动加这条；管理员本就能取得所有权，拒绝只会让安装失败）。其他显式 Allow 主体（Everyone/Users 等）一律拒绝并报告主体 SID。
- 密码用 Windows 当前用户 **DPAPI** 加密，以实例 ID 作额外绑定；加解密只走固定的 PowerShell 脚本，凭据经私有 stdin/stdout 进出，**不进命令行、URL 日志、渲染层、ready 事件或 Session**。
- `initdb` 的 pwfile 用后即删；dump 必需密码只传入该子进程环境。
- `childEnvironment(base)` 返回**敏感**环境，`DATABASE_URL` 由当前实例统一生成、清掉旧 PG 连接环境，只能交给本应用管理的消费者，不能打印或发给页面。
- DPAPI 不是跨机器备份格式。搬到别的机器/用户必须显式恢复数据并重建本机凭据与绑定，**禁止因解密失败改用明文或重建空库**。

### 2.4 唯一管理与异常接管

- 锁用「规范化真实目录的 SHA256」命名 Windows 管道，靠 OS first-instance 互斥，管理进程退出自动释放。不靠 PID 文件抢删、不超时 unlink、不猜陈旧锁。
- 启动前校验 `PG_VERSION` 与 `pg_controldata` 系统标识。已有 live postmaster 时，核对 PID 文件的数据目录/端口、OS 可执行文件路径/创建时间、持久化进程记录，以及通过受保护管理凭据读到的 SQL 系统标识与实际数据目录 —— 全部匹配才接管。
- 管理进程崩了而 PG 还在跑：新管理者可重新取锁并复用同一 postmaster。身份未知或 SQL 验证失败时不认领、不误停，保留 `stop_unconfirmed` 诊断。已确认死亡的 postmaster 遗留文件交给 PostgreSQL 自己处理，**不自行为 unlink PID 文件**。
- **PID 文件丢了但持久记录的 PID/OS 创建时间仍指向活库 → 拒绝启动第二个实例**，也不能把 close 报成成功。
- 新端口有界重试三次，已占用不当成本实例。`close()` 只停当前持锁且身份匹配的实例，重复 close 幂等；**不按进程名杀 PostgreSQL**，不删持久数据。

### 2.5 会话时区固定 UTC

集群启动参数带 `-c timezone=UTC`。所有时间列都是 `timestamptz`，跨日/跨时聚合显式写 `AT TIME ZONE`，不读会话时区。

**理由不是风格。** Prisma 走驱动适配器时，`$queryRaw` 返回的 `timestamptz` 会被当成「本地墙上时间再当 UTC」。服务器时区跟着 Windows（东八区）时整体偏移 8 小时，成长事件租约领取（`runAt <= now`）、日志状态回填这类比较会直接判空或取错版本。

`desktop:pg:init-recovery` 断言重开后的 `current_setting('TimeZone')` 是 `UTC`。这也是**本地跑 `test:*-db` 全量业务测试的前提**，否则那些套件会以时区偏移的形式失败。

### 2.6 Windows 路径边界（踩过的坑）

- **中文程序路径会炸**：在中文 PostgreSQL 程序目录实测，initdb 的 bootstrap 通过，post-bootstrap 阶段报 UTF8 无效字节。原因是 PG16 initdb 把绝对 share 路径写进 single-user SQL，原生路径字节与 UTF8 SQL 不一致。改 `PGCLIENTENCODING`、显式 `client_encoding` 都无效；相对 `-L` 因上游要求绝对路径而不可用。**结论是运行时在任何数据目录创建前直接拒绝非 ASCII 的程序路径** —— 这是发布前仍待解决的安装布局限制。
- **中文数据目录可以**：PG 原生 PID 文件里的目录可能用系统 ANSI 编码。工具先严格按 UTF8 解，失败后按当前系统编码转换；SQL 验证读原始字节，避免把本地路径误当业务正文。业务协议与数据库仍是 UTF8。已通过中文数据目录的基础持久化测试，但**不宣称所有代码页、locale、Unicode 字符都兼容**。
- 初始化统一选 PG16 + UTF-8 + libc/C + SCRAM，六个工具版本必须一致。C 只是技术原型，**不代表与 Alpine 容器排序兼容**，也没有中文拼音序。

## 3. 绑定、迁移与备份

### 3.1 显式创建与模式选择

`desktop-database.json` 存在指定应用数据目录内，记录 schema 版本、embedded 模式、固定子目录 `database`、实例 ID、PG 系统标识与 initializing/restoring/ready 阶段，**不存连接密码**。

- `desktop:db:init` 必须给**不存在的新数据目录**，父目录须已存在。旧目录看起来空也不接管。
- 已有 ready 绑定优先；显式指定与绑定矛盾的 docker/external 报错。embedded 无绑定、未知模式、auto 一律拒绝。
- `YILING_PG_BIN` 必须是已验证 PG16 的绝对 bin 路径；未设置时只查预定安装位置 `../runtime/pgsql/bin`，不猜本机其他 PostgreSQL。

```powershell
$env:YILING_PG_BIN = 'D:\YilingRuntime\pgsql\bin'
yarn desktop:db:init --data-dir 'D:\YilingData\new-install'
$env:YILING_DATA_DIR = 'D:\YilingData\new-install'
$env:YILING_DB_RUNTIME = 'embedded'
yarn desktop
```

### 3.2 Prisma 迁移闸门

只接受已验证的 embedded runtime。按本地 `migration.sql` 的 SHA256 与 `_prisma_migrations` 记录算待执行项，**不解析 `migrate status` 的自然语言输出**。

拒绝：未知历史、校验和不符、顺序不一致、重复完成记录、未处理失败记录、矛盾状态、没有合法迁移历史的非空 public 业务表。正常 rolled-back 记录不算完成。**checksum 检查不等于完整 schema diff**，检测不出任意手工 ALTER 的语义漂移。

有 pending 时：先备份成功 → 复核本地文件与历史没变 → 真实 `migrate deploy` → 再检查账本与实例身份。无 pending 不重复备份。迁移失败时不启动消费者、不 reset/resolve 账本、不自动回写旧 dump，保留升级前备份。

### 3.3 私有备份包

只在消费者未启动或已停止、且持有本实例管理锁时创建。SQL dump 是数据库快照，文件复制不是跨库/跨文件系统事务，**不宣称支持外部写入者同时修改素材时的一致备份**。

包含：数据库 + 已登记的持久配套文件（`credentials-encryption.key`、`snowluma-home.json`、`local-exec-audit.jsonl`、`stickers/`、`sticker-originals/`、持久生成图片 `images/`）。

不包含：源实例 pgdata、DPAPI 密文、桌面 Session/bootstrap、日志/cache、个人文件、外部协议程序的安装与登录文件。SnowLuma 路径配置只是指针，不能冒充已备份其程序与登录状态。**整个备份包按敏感数据保护**。

通过实际字段判断是否依赖旧密钥（角色 `modelConfig` 旧 v1 密文、渠道 `credentialsCiphertext`、角色扮演 v1 密文）；确有依赖而缺 key 拒绝备份。这只证明密钥存在且字节完整，**不证明源库损坏的密钥一定解得开旧值**，恢复演练须实际解密验证。

文件带大小与 SHA256 清单，全部完成后才 rename 为成功备份；拒绝链接、特殊文件、路径穿越、重复/未登记 payload、错误密钥声明与哈希不符。不自动修剪备份。

`yarn desktop:backup` 必须先关闭占用实例的桌面应用；应用还在运行时返回管理锁 busy，**不绕过锁复制半套素材**。external 桌面备份未接入，明确报错，不改去备份默认 Docker 容器。

### 3.4 恢复只能写到新目录

```powershell
yarn desktop:db:restore --backup 'D:\private-backups\desktop-<标识>' --data-dir 'D:\YilingData\restored-install'
```

先校验整包再创建目标目录。恢复创建新 PG 实例与当前用户 DPAPI 凭据；目标只允许空闲空数据库，`pg_restore` 用 single-transaction / exit-on-error，**不用 DROP、clean 或覆盖开关**。已有表/视图/序列/函数/自定义类型/schema 的目标不接受恢复。

成功后撤销**目标副本**的旧登录会话，再 commit ready 绑定；源数据库、源会话、源素材不动。失败则关闭已确认实例、保留 restoring 阶段，不当成可启动的安装，**不自动重建空库**。

恢复本身不调模型、不启 Worker/Scheduler/QQ/网页。启动恢复副本前仍要显式切换，**不能把原实例和副本接同一个协议账号同时跑**。

### 3.5 Supervisor 接线

- embedded 分支只打开已绑定实例，生成统一连接环境给迁移、建号、Web、Worker、Scheduler；不复制开发目录的密钥。embedded 不接受 skip-migrate。
- Web / Worker / Scheduler 连接分别标记 `PGAPPNAME`，便于在目标库活动里核对。Worker 管理锁增加显式数据库实例命名空间 —— 否则同一源码目录下开发库的 Worker 会挡住另一个 embedded 库。
- 正常关闭与启动失败都先停消费者再关自己管的数据库；**不会停仅连接的旧 Docker/external 服务**。
- embedded 尚无 QQ 协议栈实例归属验证，暂不自动复用全局端口上的旧适配器，日志提示手动配置。
- 失败初始化隔离只对「明确未形成可用 cluster」的目录做保留证据的兄弟目录改名，并按 DATA_DIR/数据库两层锁串行化。**它不是恢复已初始化数据库的通用「强制重置」**。

## 4. 安装包

### 4.1 payload 与许可证

`desktop-pack.mjs` 默认产出 ASCII 名 `dist/YilingSpace-Payload-<version>` —— 它是**安装源 payload**，不是已初始化的便携实例。`--with-env` / `--with-data` 被明确拒绝：私有迁移走显式备份恢复，不把真实 `.data` 或凭据带进可分享的包。

随包：Node、Electron、生产依赖、`.output`、Worker 所需源码与 Prisma 工具、PG 的 bin/lib/share、许可证声明。不复制开发 `.nuxt` 的绝对路径配置。

Node 来自构建机，版本记进 package metadata，并附匹配版本的完整 LICENSE（本轮用 Node v26.13.1 上游许可证，因为本机安装目录没带）。Electron/Chromium 原始许可与生产依赖声明随目录保留；**许可证保留不替代组合发行物审查**。

```powershell
node scripts/desktop-pack.mjs --pg-archive '<已下载官方归档>' --node-license '<匹配Node版本的完整LICENSE>'
node scripts/desktop-installer.mjs --source 'dist/YilingSpace-Payload-<version>'
```

`--skip-build` 只用于复用现有 `.output` 的本地验证；`--force` 只接受已识别、无私有材料的旧产物并保留 previous 副本。package metadata 记录源码提交与 dirty 状态 —— **dirty 产物不得被描述成干净发布验收**。

### 4.2 VC 运行库前置（为什么默认不塞 DLL）

微软授权明确：Visual C++ 可再发行组件的分发**仅限有 Visual Studio 许可的用户**，并受其许可条款约束。本项目未确认维护者的具体许可资格，所以选择只提供官方下载说明：

- 不镜像下载、不抽取/拷贝 System32 DLL、不携带 `vc_redist.exe`、不自动 `/quiet`、不提权、不改 DLL 搜索路径、不代接受许可。
- 安装器附带「检查运行库.bat」、`check-runtime.ps1`、`VC-runtime-guide.html`，未就绪时在复制/初始化前停止。
- 检测方式：静态读取 PE 的正常与 delay import 表，先验证 PG 发行物完整性再扫 bin 的 exe/dll。固定发行物实际需要 `msvcp140.dll`、`vcruntime140.dll`、`vcruntime140_1.dll`；必须在真实 System32 可读且为 x64，并做原生 `LoadLibraryExW` 加载验证。**窗口 API set/UCRT 不按文件存在性猜缺失**。
- 结果分 ready / missing / incompatible / unverified；ready 只证明这些只读检查通过，**不是**导入符号/工具链版本兼容、微软签名认证或干净系统发布认证。

```powershell
yarn desktop:vc:check                                       # 最低已知组件
node scripts/desktop-vc-check.mjs --pg-root '<payload>/runtime/pgsql'   # 完整依赖
```

退出码：0 通过 / 2 前置未满足 / 1 检查或发行物本身有错。

### 4.3 首次启动与中断保护

安装器只复制程序并提交安装状态，**不预创建空库**。普通 Node 启动器持安装状态的 OS 锁，校验程序代号、PG 清单与路径，再显式创建新数据目录。

数据库 binding 从 initializing 阶段就带 `installationId`；只有与本安装身份一致的 ready 数据才能在中断后继续，**丢失已绑定数据时拒绝补建空库**。

有 install 标记但 package metadata 损坏时，拒绝回退到 legacy/Docker。安装源 payload 不能直接跑 Electron 跳过安装身份，真正的安装始终经普通 Node 启动器。Electron profile 在绑定数据目录内，不与其它安装或开发窗口共用。

首次密码保留在私有 `first-run-admin.txt` 供手动登录/恢复，**不打印到 ready 或日志**。

### 4.4 升级与卸载

安装锁覆盖应用生命周期、升级、卸载。应用运行时升级/卸载返回 busy，**不按进程名杀用户程序**。

新程序先复制到唯一 installing 兄弟目录，验证后交换，旧程序留 previous 快照。状态提交失败尽量恢复原程序与 anchor、保留失败现场。跨进程强杀不是完整 journal 事务，留下的不明目录不会自动删除或当成新安装。

卸载先把随包 Node 复制到私有临时维护目录（避免从被删目录跑 exe），数据确认停止后仅把程序保留为 uninstalled 快照。数据库、素材、密钥、Electron profile、状态都留在原位。复装读取保留的安装身份，复用原实例，**不新建数据库**。

**程序回退快照会占磁盘**，本轮没有自动修剪入口；也不代表卸载后程序字节立即全部释放。

### 4.5 进程生命周期（Windows Job 的坑）

故障最初表现为「管道通知不到达」。独立对照确认根因是 Node/libuv 在 Windows 默认关联 Job 的终止行为：杀掉启动器时普通后端和守卫被一起结束，来不及执行 lost 回调，而部分原生后代仍残留。相同无库实验仅把后端设为 detached，就得到 attached/lost 日志并自行收尾。

安装态因此显式分离 supervisor/Electron 的进程组，但**不 unref、不放弃句柄**；正常退出仍由原启动器发控制命令并等待。源码入口保留原 IO/进程组语义。另用 Windows 原进程句柄守卫核对创建时间并等待真实原进程退出，**不凭 PID 或 EOF 推断**；守卫不读数据库凭据。

另一处已实验证实的问题：父管道断开后的 stdout/stderr EPIPE 不能让收尾日志自己中断清理 —— 文件日志优先，诊断通道错误不抛成生命周期失败。

## 5. 免登录与主人绑定

### 5.1 绑定规则

| 场景 | 行为 |
|---|---|
| 新空库 | 只自动绑定**本次启动确实从空库创建**的首账号。服务端再检查整库恰好一个用户、账号 ID 精确匹配且为 ACTIVE ADMIN。不是「看到一个管理员就认作主人」。 |
| 已有库 / 恢复库 | 即使只剩一个账号，也先正常登录，再点「登录并绑定本机」或用户区「绑定当前账号为本机主人」。原生确认**默认取消**。普通 ACTIVE USER 可绑定自己，不会变成管理员。 |

绑定后，同一 Windows 用户从该安装的正常入口启动，Electron 在加载首个业务页面前拿到普通服务端 Session Cookie；退出重开仍是同一账号。菜单可「重新连接绑定的本机身份」「取消本机免登录」。停用/删除账号、解绑、上下文不符或私有通道关闭时**不会偷偷换成别的管理员**。

网页/源码继续原登录与退出；安装版侧栏显示「退出应用」。源码不会因此强制启用本机身份。

### 5.2 私有认证通道

- 启用标志**不是**认证凭证。链路还要求继承的 Node IPC 句柄、每次启动随机密钥与进程代号、带方向与序号的 MAC；初始化只接受一次，重复序号/篡改/跨启动包不能再执行。不通过 stdout、参数、URL 或环境变量搬运启动密钥与 Session Token。
- Nitro 私有插件初始化时核对受保护数据目录、安装 ID、数据库实例 ID 与 PG system identifier；状态写在 `desktop-owner.json`，ACL 限当前用户、SYSTEM、本机 Administrators。**它不抵御已控制当前系统用户或恶意管理员的程序**，也不是提权机制。
- 服务端复用统一随机 Token、SHA-256 入库、TTL 边界与 ACTIVE 检查。签发时锁用户行；账号停用/删除不签发。绑定证明先走正常密码登录，再在事务里锁用户/会话并复查 Cookie 证明未过期、未撤销、哈希一致。**密码哈希本身不当作绑定证明**。
- Token 只经私有链路交给主进程；主进程等专用 persist Session 写好 Cookie 并回读属性成功后才加载页面。保持 HttpOnly / Secure / SameSite=Strict —— 真实 Chromium 实验确认回环 HTTP 也支持 Secure Cookie，**不为省事放宽**。
- preload 身份方法只接受已登记 origin 的主窗口主框架；子框架、其它窗口、跨 origin 拒绝。客户端能力标记只控制展示，**HTTP 服务端仍逐请求验证**会话、账号状态与数据归属。
- **没有新增匿名 local-enter 或兑换 Token 的 HTTP 路由**，公共 OpenAPI 的 login/session/logout 契约不变。

### 5.3 会话撤销

`desktop-owner.json` 只持久化账号 ID、安装/数据库上下文、当前会话 ID/哈希/到期时间，**不存明文 Token**。每次轮换先用 id+userId+tokenHash 核对并撤销自己的旧会话，失败则不再签发 —— 不靠可伪造的 User-Agent 猜哪些会话属于本安装。

正常退出、解绑只精确撤销本安装私有签发的会话，**不撤同一用户的其它 Web 登录**。强杀来不及撤销时，旧桌面会话至多保留到正常到期或下次成功启动的轮换，**不宣称强杀能同步抹掉所有会话**。

撤销 Session ≠ 取消 Windows 本机绑定：绑定仍有效时可明确重连。要禁止以后重建会话，得取消绑定或停用账号。

`desktop-owner.json` 与 Electron Cookie/profile **不加入可迁移备份**；恢复到新实例后要重新建立信任。卸载复装保持原数据目录时保留原绑定。

## 6. 验证入口

```powershell
# 需要真 PG 的（不进默认跑批）
$env:YILING_TEST_PG_BIN = (Resolve-Path '.data/vendor/postgresql-a0/release-16.16-2/pgsql/bin').Path
yarn desktop:pg:smoke
yarn desktop:pg:runtime-smoke
yarn desktop:pg:application-smoke
yarn test:desktop-pg-lock
yarn test:desktop-pg-init-recovery

# 无库回归（进 test:all）
yarn test:desktop-database-config
yarn test:desktop-pg-migrations
yarn test:desktop-pg-distribution
yarn test:desktop-install-engine
yarn test:desktop-package-state
yarn test:desktop-vc-runtime
yarn test:desktop-vc-integration
node scripts/test-desktop-parent-watch.mjs
node scripts/test-memory-worker-supervisor.mjs

# 隔离安装冒烟（手动）
$env:YILING_TEST_INSTALLER = '<本地隔离安装器目录>'
yarn desktop:package:smoke
```

初始化失败恢复测试在没有 Windows 或缺 `YILING_TEST_PG_BIN` 时打印跳过并成功退出，**不会让 CI 假红**。所有测试用新建隔离目录与合成数据，不连真实业务库。

## 7. 还没验证的（发布前必须做）

| 项 | 状态 |
|---|---|
| 真正未装任何运行库的干净 Windows VM | 未验 |
| 第二个 Windows 系统用户隔离 | 未验（只验了 Public 目录可创建私有 ACL） |
| Defender / 其它杀软 | 未验 |
| 正式代码签名与发布流水线 | 未做 |
| 系统重启后的数据库恢复 | 未验（只验了同进程 stop/start 与管理者崩溃接管） |
| 另一台机器的免登录升级 + 原生确认真实点击 | 未验 |
| 旧 Docker 库自动迁移到 embedded | 明确不做，需手工备份恢复 |
| 非 ASCII 程序路径 | 明确拒绝，安装布局限制未解决 |
| 长期数据库崩溃退避与故障注入 | 未验 |

## 8. 已通过的关键验收

- **A0 原型**：官方归档 SHA256 完整校验，`desktop:pg:smoke` 跑通（约 9 秒）；覆盖全新建库、错误密码拒绝、UTF8/C、业务角色权限、JSONB/时间戳、dump 与独立 restore、不覆盖目标、身份篡改拒绝停止、停止后清理、同一对象重启复用同一 cluster。
- **持久化运行时**：DPAPI 新进程重开、占用端口避让、统一环境真实查询、管理者崩溃后复用原 postmaster、错误绑定/未完成状态/损坏密文拒绝重建、Windows 大小写目录别名正确重开。
- **显式接入**：真实应用演练过全部迁移、恢复前后所有 public 表条数、记忆来源、日记版本、图片字节、旧密文实际解密、目标会话撤销且源会话保留、篡改/覆盖/缺 key 拒绝；真实 SQL 故障演练（迁移失败 → 升级前备份可恢复 checkpoint，原失败账本不自动重试）；三类消费者用 `PGAPPNAME` 核对连到同一恢复库。
- **安装包**：受限 PATH 下用包内 Node/Electron/PG 首次初始化、真实迁移、DOM 确认登录页、运行中升级/卸载拒绝、关闭后升级保留 checkpoint、卸载保留数据、复装仍为原实例；启动器/后端强制终止后的窗口/消费者/PG 回收。
- **另一台非开发机**（2026-11-22，中文用户名 Windows，b552378 包）：VC 检查通过，程序落在 Public 下 SID 私有目录；用户反馈安装、启动、退出重开、卸载复装及数据保留均可用。**这是远端人工反馈，未读该机数据库或日志独立复核。**
- **身份切片**：私有握手重放/跨启动拒绝、ACTIVE-only 会话与密码并发守卫、目录与文件 ACL、旧单账号不猜、显式解绑恢复、Cookie 属性与注入顺序、渲染入口拒绝、撤销只匹配本安装、重启仍同一主人。
