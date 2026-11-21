# 内嵌 PostgreSQL：持久化运行时基础切片

## 状态与范围

这是 A0 后的独立基础切片，不是完成整个 A1 安装包接入。它尚未被正式 supervisor、安装器或备份按钮调用，也没有改动服务器部署、业务 API、schema 或认证。运行时仅支持 Windows；不以未经验证的文件锁或明文凭据降级支持其他平台。

实现位于 `scripts/desktop-pg-runtime.mjs`，相关职责分为工具调用/路径处理 `desktop-pg-tools.mjs`、DPAPI 和原子状态文件 `desktop-pg-store.mjs`、OS 管理锁 `desktop-pg-lock.mjs`。A0 原型已复用相同工具模块，保留原有隔离验证入口。

## 显式创建与打开

`openDesktopPostgres({ binDir, rootDir, initialize: true })` 只创建不存在的实例目录；目录已存在时拒绝，不查看 Docker 状态后自动另建空库。

首次成功后调用 `descriptor()` 获得非敏感的 instanceId、systemIdentifier、数据库主版本、端口和库名。此安装绑定应由后续 supervisor 配置层保存；当前没有自动改写任何用户配置。

已有实例必须使用 `openDesktopPostgres({ binDir, rootDir, expectedInstanceId })`。绑定缺失或错误、不是本运行时的清单、控制文件身份不符、主版本错误、初始化未完成或凭据损坏都会停止，不重置、不重新 initdb。

实例目录包含：

- `runtime.json`：版本化非敏感清单，记录 initializing/ready 阶段、安装实例 ID、PG 控制文件系统标识及最近管理的进程身份。
- `credentials.dpapi.json`：Windows 当前用户 DPAPI 密文，用实例 ID 作额外绑定，不保存明文数据库密码。
- `pgdata/`：数据库，仍使用 PostgreSQL 16、UTF8、C/libc；这仍是技术验证策略，不是跨平台排序兼容结论。
- `postgres.log`、可选的私有 `initdb-diagnostic.json` 和 `backups/`：诊断及数据库 dump。

状态文件通过排他临时文件写入后 rename 替换；中断的临时文件不作为正式清单读取。跨文件初始化不是事务，任何缺件或未提交 ready 的状态都拒绝自动接管。初始化失败保留证据，不自动删除目录。

## 凭据、权限与统一配置

根目录关闭 ACL 继承，仅授予当前用户和 SYSTEM 权限；如果旧根目录存在额外显式 Allow 主体，则拒绝继续，不能只调用 grant:r 就宣称它已私有。该校验不等于完整的全树离线安全审计；尚未实测另一 Windows 账号的实际访问。

DPAPI 使用 CurrentUser 和实例 entropy。凭据只通过私有 stdin/捕获 stdout 进出固定的 PowerShell 加解密脚本，不进入命令行、URL 日志、渲染层、ready 事件或 Session。初始化 pwfile 用后删除；dump 必需密码仅传入该子进程环境。SQL 连接只使用当前实例配置，不读取 `.env` 或旧 DATABASE_URL，并显式覆盖 PGOPTIONS、SSL 与文本编码。

`childEnvironment(base)` 返回**敏感**的子进程环境，其中 DATABASE_URL 从当前实例端口、库名和凭据统一生成，旧 PG 连接环境被清除。只能传给本应用管理的消费者，不能打印或发送给页面。当前只用测试子进程实际验证了它；尚未给真实 Nitro/Worker/Scheduler 接线。

DPAPI 不是跨电脑备份格式，也不替代数据库迁移。搬到另一机器/用户时需显式恢复数据并重新建立本机凭据与绑定，禁止因解密失败改用明文或重新建空库。

## 唯一管理与异常接管

锁使用规范化真实目录的 SHA256 命名 Windows 管道，靠 OS first-instance 互斥，管理进程退出时自动释放。不依赖 PID 文件抢删、超时 unlink 或猜测陈旧锁；管道不传认证或数据库数据，锁只负责互斥，不承担用户授权。

启动前先校验 `PG_VERSION` 和 `pg_controldata` 系统标识。已有 live postmaster 时，核对 PID 文件数据目录/端口、OS 可执行文件路径/创建时间、持久化进程记录，以及通过受保护管理凭据读取的 SQL 系统标识与服务器实际数据目录，匹配后才接管。

管理进程崩溃而 PostgreSQL 尚在运行时，新管理者可以重新取得锁并复用同一个 postmaster；身份未知或 SQL 验证失败时不认领、不误停，保留 stop_unconfirmed 诊断。已确认死亡的 postmaster 遗留文件交给 PostgreSQL 自己处理，不自行 unlink PID 文件。若 PID 文件丢失但持久化 PID/OS 创建时间仍指向活着的数据库，则拒绝启动第二个实例，也不能把 close 报成成功；需要保留诊断并恢复管理依据。

新启动端口有界尝试三次，已占用端口不当成本实例；所有消费者用最终配置。`close()` 只停止当前持有锁且身份匹配的实例，核对控制文件、PID、端口和 OS 创建时间后 fast stop，再释放管理锁；重复 close 幂等。不按进程名杀 PostgreSQL，也不删除持久数据。

`backup()` 当前仅产出非超级业务账号的数据库 dump，以 partial 文件完成后 rename；不等于包含素材、解密密钥和完整恢复流程的正式桌面备份。A0 已验证独立库 restore，本切片尚未接入正式备份/恢复工具。

## 本轮发现的 Windows 路径边界

实际测试在中文 PostgreSQL 程序目录中复现：initdb 的 bootstrap 通过，但 post-bootstrap 阶段发生 UTF8 无效字节错误。PG16 initdb 将绝对 share 路径写入 single-user SQL；当前构建的原生路径字节与 UTF8 SQL 不一致。参考 [PG16 initdb 源码](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/bin/initdb/initdb.c)。

更改 PGCLIENTENCODING 的隔离对照没有修复，显式 client_encoding 对照也失败；没有因此改变业务数据库编码。相对 -L 方案因上游要求绝对路径而未采用。运行时现阶段在任何数据目录创建前明确拒绝非 ASCII 的真实 PostgreSQL 程序路径；这是**正式发布前仍待解决的安装布局限制**，不是已支持任意中文安装位置。

中文数据目录是另一条路径：PG 原生 PID 文件中的目录可能使用 Windows 系统 ANSI 编码。工具模块先严格解 UTF8，失败后通过当前系统编码转换；SQL 验证读取服务器 PID 文件原始字节，避免把本地路径误当 UTF8 业务正文。整个业务协议和数据库仍为 UTF8。当前已通过中文数据目录的基础持久化测试，不由此宣称全部代码页、系统 locale 或所有 Unicode 字符都已兼容。

## 验证入口与证据

```powershell
$env:YILING_TEST_PG_BIN = (Resolve-Path '.data/vendor/postgresql-a0/release-16.16-2/pgsql/bin').Path
yarn test:desktop-pg-lock
yarn desktop:pg:smoke
yarn desktop:pg:runtime-smoke
```

不导入 dotenv；所有数据库与记录均在新建隔离目录中，未连接用户真实业务库。成功清理测试实例；失败时尝试关闭已确认实例，不能确认时保留目录并报错，不继续删除。

锁测试已通过：同进程/跨进程争用、真实路径别名、独立实例、并发只有一个赢家、正常释放、管理进程强制退出后重取锁。A0 回归已通过。

持久化基础测试已通过：DPAPI 新进程重开、占用端口避让、统一环境真实查询、管理者崩溃后复用原 postmaster、旧数据保留、错误绑定、未完成状态和损坏密文拒绝重建。最终补充的回归也已通过：崩溃接管前后 PID/OS 创建时间相同，额外显式 Everyone Allow 在启动前被拒绝，Windows 大小写目录别名可正确重开；PID 标记缺失但数据库仍活着时，close 与崩溃后的重新打开均拒绝误判/重复启动。最终持久化冒烟约 40 秒。项目类型检查、完整 lint、隐私检查、测试计划校验和生产构建通过；测试计划校验不等于跑过全部业务测试，本轮未运行全量业务套件。

## 下一切片边界

还需要：正式安装路径与 locale/provider 决策、完整 migration/备份恢复、系统重启和长期数据库崩溃退避验证、安装/升级/卸载与统一消费者环境接入、干净 Windows/多用户验收。本轮不接管旧 Docker/external 数据库，不切真实库，不增加公共免登录接口，也没有实施主人绑定或桌面认证通道。
