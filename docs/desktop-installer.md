# Windows 桌面安装包接入与验证

## 当前范围

本阶段将已验证的内嵌 PG 接入分发源、安装、首次启动、升级和卸载。源码 `yarn desktop` 保留原有路径；新安装包无需目标机安装 Docker、Node 或 Yarn，也不要求用户先写 `.env`。这不表示免登录已完成：首次空库仍使用现有管理员建号和登录页，模型 Key 仍由用户在应用中配置。

没有迁移或切换真实用户数据库，没有改服务器部署。当前产物是本机隔离验证包；干净 Windows、不同系统账号、杀软和代码签名验收尚未完成，不能当作已认证的公开发布包。

## 干净分发源与许可证

`desktop-pack.mjs` 默认生成 ASCII 名称 `dist/YilingSpace-Payload-<version>`，它是**安装源 payload**，不是已初始化便携实例。原 `--with-env` / `--with-data` 被明确拒绝；私有迁移应使用显式备份恢复流程，不把真实 `.data` 或凭据带进可分享安装包。

随包包括：Node、Electron、生产依赖、构建好的 `.output`、Worker 所需源码和 Prisma 工具、PG 的 bin/lib/share、以及许可证声明。不复制开发 `.nuxt` 的绝对路径配置，TSX 使用包内最小路径配置。

PG 从固定 [EDB 16.16-2 归档](https://get.enterprisedb.com/postgresql/postgresql-16.16-2-windows-x64-binaries.zip)流式校验官方公布 SHA256 后提取，白名单只包含运行时和两份原始许可文件，不带 pgAdmin/StackBuilder。`distribution.json` 登记全部文件大小/hash，安装与启动前检查缺失、额外文件、链接和损坏；完整性清单不是独立签名认证，不能防御同一可信用户同时修改程序与清单。

Node 来自当前构建机，版本记录到 package metadata；构建要求匹配版本的完整 LICENSE。本轮使用 [Node v26.13.1 上游许可证](https://raw.githubusercontent.com/nodejs/node/v26.13.1/LICENSE)，因为本机安装目录没有附带它；不是使用 npm 的许可证代替。Electron/Chromium 原始许可及生产依赖声明随相应目录保留。许可证保留不替代后续组合发行物审查。

## 构建入口

```powershell
# 构建机仍使用仓库约定的 Yarn Classic；目标机不需要它。
node scripts/desktop-pack.mjs --pg-archive '<已下载官方归档>' --node-license '<匹配Node版本的完整LICENSE>'
node scripts/desktop-installer.mjs --source 'dist/YilingSpace-Payload-<version>'
```

`--skip-build` 仅用于明确复用现有 `.output` 的本地验证。`--force` 只接受已识别、没有私有安装材料的旧产物，并保留 previous 副本，不递归删除未知输出目录。package metadata 记录源码提交和 dirty 状态；dirty/本地代码刷新产物不得被描述成已做过干净发布验收。

安装器为 payload 加上 install.ps1、卸载脚本和批处理。所有实际逻辑由**随包 Node**运行，不要求目标机通过网络安装依赖。

## 系统运行库前置条件

安装器现在先验证 PG 发行物，再从实际 PE 导入表识别 VC 依赖；固定发行物需要 msvcp140.dll、vcruntime140.dll、vcruntime140_1.dll。检查包括真实 System32 的可读性、x64 架构和原生加载结果，不再只看一个文件是否存在。未就绪时在复制/初始化前停止。

安装源和程序目录均附带「检查运行库.bat」、check-runtime.ps1 和 VC-runtime-guide.html，用户可从微软自行下载并交互安装后重试；不会自动提权、接受许可或重启。微软再分发条件尚未在本项目维护者侧确认，因此本包不加入微软 EXE/DLL，应用本体无需 Docker/Node/Yarn 但系统前置仍可能需要管理员处理。许可依据、命令及验证边界见 [VC 运行库记录](desktop-vc-runtime.md)。不能声称完全干净 Windows 零前置一键可用，干净 VM 验收仍待完成。

## 程序、数据、状态分开

- 程序默认位于当前用户 LocalAppData 下的 YilingSpace，但真实程序路径必须是 ASCII，规避目前 PG16 initdb 在非 ASCII share 绝对路径中复现的编码问题。
- 若用户 profile 路径含中文等非 ASCII，默认改用 OS 注册的 Public 目录下 `YilingSpace-<当前SID>` 私有子目录；不是公共可读安装，也不创建全局 junction 或依赖 8.3 短文件名。未知预占目录直接拒绝，不抢占权限或覆盖。
- 数据默认是当前用户 LocalAppData/YilingSpaceData，允许中文数据路径；安装状态是另一个私有 YilingSpaceInstallState 目录。二者都在程序目录之外、互不包含。
- 本轮额外验证了当前**非提升**用户能够在 OS Public 下创建 SID 私有权限目录，探针已清理。未拥有第二个 Windows 账号，不把它称作跨用户完整验收。若默认位置不可写或不是支持的 ASCII 位置，安装中止并要求选择安全位置，不自动切换数据库。

`desktop-install-engine.mjs` 在复制前和持锁后检查剩余磁盘空间，空间不足不停止旧 DB、不改旧 anchor，不删除快照腾空间。首次安装拒绝未知旧程序、未知旧数据，即使目录看起来为空也不接管。旧 Docker 版安装不自动转换。

## 首次启动与中断保护

安装器只复制程序并提交安装状态，不预创建空库。普通 Node 启动器持有安装状态的 OS 管理锁，校验程序代号、PG 清单与路径，再显式创建新数据目录。数据库 binding 从 initializing 阶段就带 installationId；只有与本安装身份一致的 ready 数据才可在中断后继续，丢失已绑定数据时拒绝补建空库。

源码没有 package/install 标记时维持旧行为；已经存在 install 标记但 package metadata 损坏时拒绝 legacy/Docker 回退。安装源 payload 不能直接运行 Electron 来跳过安装身份，真正的安装始终经普通 Node 启动器。Electron profile 位于绑定数据目录，不与其它安装或开发窗口共用。

首个数据库初始化和真实 Prisma 迁移由前阶段的闸门负责。安装版现在只对本次空库首建的精确账号自动绑定；已有库先正常登录并明确绑定，随后由私有进程通道向专用 Electron Session 注入普通会话 Cookie。首次密码仍保留在私有 first-run-admin.txt 供手动登录/恢复，不打印到 ready 或日志。绑定、解绑、重连与安全边界见 [桌面身份记录](desktop-identity.md)。

## 升级与卸载

安装锁覆盖应用生命周期、升级、卸载。应用还在运行时升级/卸载返回 busy，不按进程名杀用户程序。更新仅接受已登记路径和 installationId，先核实当前 PG/数据绑定并停止已确认的孤儿实例；未知或无法确认的状态中止。

新程序先复制到唯一 installing 兄弟目录，验证后交换程序目录，旧程序留 previous 快照。状态提交失败尽量恢复原程序和 anchor，保留失败现场；跨进程强杀不是完整 journal 事务，留下的不明目录不会自动删除或当成新安装接管。

卸载脚本先将随包 Node 复制到私有临时维护目录，避免从被移除的目录运行 exe；数据确认停止后，仅将已登记程序保留为 uninstalled 快照，状态标记 uninstalled。数据库、素材、密钥、Electron profile 和状态保持原位置。复装读取保留的安装身份，复用原实例，不新建数据库。

**程序回退快照会占磁盘**，本轮没有提供自动修剪入口；不是声称卸载后程序字节立即全部释放。应用数据不会为了腾空间被删除。隔离测试成功后可按专门的测试身份校验清理自己的程序副本，生产安装逻辑不这样自动清理。

## 进程生命周期

正常退出先关闭窗口，再等待 supervisor 停止 Worker、Scheduler、Web 和自己的 PG，最后释放安装锁。Web/Scheduler 复用受控 Node 父进程守卫，独立手动运行不受影响。

故障测试最初表面表现为管道通知不到达，独立对照进一步确认根因是 Node/libuv 在 Windows 默认关联 Job 的终止行为：杀掉启动器时，普通后端和守卫被一起结束，来不及执行 lost 回调，而部分原生后代仍残留。相同无库实验仅把后端设为 detached，就得到 attached/lost 日志并自行收尾。

Windows 安装态因此显式分离 supervisor/Electron 的进程组，但不 unref、不放弃句柄；正常退出仍由原启动器发控制命令并等待。源码入口保留原有 IO/进程组语义，不强制启用安装态后端监测；两个入口分别验收，Electron 始终显式使用启动器准备的 userData 路径。另用 Windows 原进程句柄守卫核对创建时间并等待真实原进程退出，避免仅凭 PID 或 EOF 推断。守卫不读取数据库凭据；PID/创建 ticks 是严格数字的非敏感生命周期参数。启动前要拿到附加握手，也不在守卫里用 ReadToEnd(stdin) 等待 EOF。

后端已 ready 后退出会关闭其窗口；启动器仍活着时，异常后端退出还会尝试通过正确安装绑定接管并停止自有 PG，而不是全局杀 postgres。缺少可靠身份时保留诊断，不误停其他实例。还修复了另一处已实验证实的问题：父管道断开后的 stdout/stderr EPIPE 不能让收尾日志自己中断清理，文件日志优先且诊断通道错误不抛成生命周期失败。最终冻结包的启动器/后端强制终止回收均已通过。

## 本机验证与剩余边界

已完成：PG 固定归档验证、合成发行物/安装引擎回归、低空间拒绝、只读默认布局诊断、当前非提升用户的 Public 私有目录探针。实际 payload 约 1.2 GiB；目标安装/更新还需要数据和程序快照空间，不沿用早期几十 MB 的估计。

第一轮真实安装回归已通过：限制 PATH 只保留 Windows 系统工具，使用包内 Node/Electron/PG 首次初始化、真实迁移、DOM 确认登录页、第二次点击激活、运行中升级/卸载拒绝、关闭后升级保留 checkpoint、卸载保留数据、复装仍为原实例。测试关闭了快捷方式和注册表写入，没有改用户当前安装。截图留在忽略目录；本轮只做 DOM/进程链路验收，不宣称完成像素观感或人工视觉验收。

异常退出回归最初失败，已保留现场并只回收了路径/创建时间验证匹配的测试进程，未影响真实 DB。最终从全部最新源码重新构建的冻结候选包已完整通过：受限 PATH 的包内运行、真实 Electron 登录页、首次 PG/迁移、第二次点击、启动器/后端强制退出后的窗口/消费者/PG回收、运行中拒绝升级卸载、升级保留 checkpoint、卸载保留数据、复装同一实例。截图/日志和合成数据保留在忽略的测试目录中；成功测试的程序副本按安装ID核实后清理。

类型检查、完整 lint、隐私门禁、测试计划校验和生产构建通过；未跑全量业务测试，未进行人工像素观感验收。构建的依赖 peer warning 不等于已完成全部发布依赖审查，VC 和干净系统项仍按下节保留。

2026-11-22 在另一台**非开发机**的中文用户名 Windows 上，用 b552378 验收包完成首次安装：VC 检查通过，安装器输出 installed 状态与独立的程序/数据/状态目录，程序落在 Public 下的 SID 私有目录。旧包在该机报告 ACL 拒绝；兼容 Administrators 并增强诊断后用户反馈安装和启动可用，但未取得该机完整 ACL 证据独立确认原失败主体。随后用户反馈退出重开、卸载复装及数据保留也可用；这是远端人工反馈，未读取该机数据库或日志独立复核。第二系统用户、杀软、签名、系统重启和本轮免登录升级仍不在这些反馈的覆盖范围内。

本轮身份切片的正常安装入口已另测通过：从隔离源码与生产构建生成开发候选包，用包内 Node 启动真实 launcher，首屏即为绑定账号、Cookie 不可被页面脚本读取；菜单桥退出后 PG 停止、当前私有会话引用清空，再开仍为同一主人且无需密码。该项关闭真实快捷方式/HKCU 写入，不升级当前用户安装，也未用真实模型/QQ。

尚未验证：真正未装任何运行库的干净 Windows VM、第二系统用户、Defender/其它杀软、系统重启、正式代码签名/发布流水线，以及另一台机器的免登录升级和原生绑定确认点击。受限 PATH 的本机成功不能代替这些验收。旧用户数据库自动迁移仍在本轮范围外。

```powershell
yarn test:desktop-pg-distribution
yarn test:desktop-install-engine
yarn test:desktop-package-state
node scripts/test-desktop-parent-watch.mjs
$env:YILING_TEST_INSTALLER = '<本地隔离安装器目录>'
yarn desktop:package:smoke
```
