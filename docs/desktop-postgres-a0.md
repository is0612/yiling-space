# 内嵌 PostgreSQL A0：隔离原型与验证

## 范围

本原型独立于桌面正式启动链路。`scripts/embedded-postgres-prototype.mjs` 不读取 `.env` 或业务 `DATABASE_URL`，只在显式父目录下用 `mkdtemp` 创建新的 `yiling-pg-a0-` 目录。它不能打开或接管已有数据目录，不执行业务 migration，不修改 Docker/外部数据库。

`yarn desktop:pg:smoke` 是显式的真实数据库冒烟入口，要求 `YILING_TEST_PG_BIN` 指向已验证发行物的绝对 bin 路径。不把此二进制依赖加入默认测试跑批。数据全部是合成记录，初始化失败时保留诊断；已创建实例后的测试无论成功或失败，都会尝试停止并清理。若无法确认身份或停止状态则保留目录，不继续删除。

## 发行物来源与校验

- [PostgreSQL 官方 Windows 下载说明](https://www.postgresql.org/download/windows/)链接到 [EDB binaries 页面](https://www.enterprisedb.com/download-postgresql-binaries)，明确允许将 binaries zip 用于其他应用安装器。
- A0 选定 Windows x64 PostgreSQL **16.16-2**：[归档](https://get.enterprisedb.com/postgresql/postgresql-16.16-2-windows-x64-binaries.zip)、[EDB 发布的 SHA256](https://get.enterprisedb.com/postgresql/postgresql-16.16-2-windows-x64-binaries.zip.sha256)。
- 固定 SHA256：`add1de261b150e6923266abee293f05050795e73f5356158aee4221a2170c073`。
- 这是 EDB 同源 HTTPS 的发布校验，不是经过独立验证的 PGDG 签名；不据此宣称已完成全部供应链审查。
- 下载与解压产物仅放 `.data/vendor/postgresql-a0/`，不提交二进制或归档。完整归档约 361 MiB；最终运行时体积与正式安装包增量必须在 A1 裁剪后实测，不能沿用早期 70～90 MB 估计。
- [PostgreSQL License](https://www.postgresql.org/about/licence/)允许分发，但组合发行物中的第三方依赖仍需分别清点声明。A0 不生成可对外发布的安装包。

## 已实现的保护

- 初始化显式选择 PostgreSQL 16、UTF-8、libc/C、SCRAM，六个工具的发行版本必须一致。C 仅用于技术原型，不代表与现有 Alpine 容器排序兼容，也不提供中文拼音序。
- Windows 创建目录后用当前系统用户 SID 和 SYSTEM 收紧 ACL，凭据文件只在该目录内排他创建，`initdb` 返回后删除。POSIX 使用 0700/0600；POSIX 分支尚需单独验证。
- 初始化超级用户与业务角色分开，业务库/业务用户仍使用 `yiling_hub`；业务角色不是超级用户、不能建角色或数据库。
- 选择回环临时端口，不使用业务连接 URL。清理继承的 PG 连接环境，SQL/备份恢复始终显式指定本临时实例。
- 启动前读取 `pg_controldata` 的系统标识，启动后通过 SQL 验证系统标识和 data_directory；管理操作校验本地清单、控制文件、PID、端口和数据目录。
- `pg_ctl` 超时后仍检查是否已启动进程；停止不依赖 SQL 正常响应，不按进程名批量杀进程。无法确认归属时拒绝停止，错误保留 diagnosticRoot；存在未确认的 postmaster 标记时报告 stop_unconfirmed。
- dump 使用非超级业务角色；restore 仅接受本次目录内的备份，目标是新的独立数据库，不使用 DROP 或 `--clean`。同名恢复目标已存在时拒绝覆盖。
- 返回对象的 dispose 只删除本次创建且已确认停止的原型目录。数据库密码除受保护的初始化临时文件及 dump/restore 必需的子进程环境外不持久化，不写 Session、日志或命令行；原型进程结束后不保存可重连密码，尚未实现生产所需的跨进程凭据持久化。

## 运行

先从上述发布源获取、核对 SHA256 并解压完整所需的 bin/lib/share；不要只复制 exe。运行例子（PowerShell）：

```powershell
$env:YILING_TEST_PG_BIN = (Resolve-Path '.data/vendor/postgresql-a0/release-16.16-2/pgsql/bin').Path
yarn desktop:pg:smoke
```

此入口不导入 dotenv，即使机器已配置业务库，测试也不会使用它。异常时先查看报出的临时目录；未核对实例归属前不得运行批量 postgres 进程清理。停止失败不能继续删目录。

## 验证状态

本轮已在实际 Windows 环境完成官方归档的完整 SHA256 校验，并使用 PostgreSQL 16.16-2 跑通 `yarn desktop:pg:smoke`，成功用例约 9 秒，临时实例已停止并清理。最后增加故意无效的宿主 PGOPTIONS 污染用例后再次通过，约 8 秒。语法、项目类型检查、完整 lint、隐私检查、测试计划校验和生产构建均通过；测试计划校验不是全量测试执行，本轮未跑全量业务测试。这不是干净 Windows 或多用户发布验收。

实际保留 bin/lib/share 及两个运行时许可文件共 1638 个文件、约 124 MiB，未包含 pgAdmin/StackBuilder；这不是最终裁剪或压缩后的安装包体积。已从归档保留 `server_license.txt` 和 `commandlinetools_3rd_party_licenses.txt`；后者不是有效 UTF-8，正式发布需保留原文件并正确处理编码，不能静默丢弃。

首次实测发现：Windows 上即使指定 `pg_ctl -l`，postgres 仍可能继承捕获管道，导致 Node `spawnSync` 在数据库已就绪后等待至超时。失败处理通过本临时实例的控制文件/PID 确认归属并执行 fast stop，日志确认数据库已关闭，诊断目录保留。修正为只对 pg_ctl 的 start/stop 使用无捕获 stdio，版本查询仍捕获；再次完整冒烟通过。该失败不是数据库无法启动，也不是业务库故障。

冒烟覆盖：全新初始化、错误密码被拒、UTF8/C、业务角色权限、JSONB/时间戳读写、dump/独立 restore、不覆盖目标、身份篡改拒绝停止、停止后清理、同一对象停止再启动复用同一个 cluster。

## A1 前仍需完成

- 正式 locale/provider 决策与 Docker → Windows 的恢复兼容性；依赖 DLL、许可证与普通用户/干净 Windows 验证。
- 跨进程管理锁、崩溃及系统重启恢复、受保护凭据持久化；本原型的重启指同一测试进程中的 stop/start，不是生产重启恢复。
- 端口竞争的有界重试、运行中崩溃退避与故障注入；当前原型遇到冲突失败并保留诊断，不静默复用其他服务器。
- Prisma migration 和完整业务备份恢复验证、统一运行配置、安装/升级/卸载接入。
- 桌面主人绑定、私有认证通道、Cookie 注入和 Web 共存。A0 未改变现有认证行为。

本原型不能作为生产数据库管理器直接接入 supervisor。后续已新增独立的[持久化运行时基础切片](desktop-postgres-runtime.md)，实现 Windows DPAPI、OS 管理锁和跨进程重开/接管；它仍未接入正式桌面链路，也不代表本文列出的全部发布边界已完成。
