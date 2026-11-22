# 忆灵空间桌面端（Electron）

桌面窗口由 Electron 提供；普通 Node 启动器管理数据库、Nitro、Scheduler 和 Worker。当前区分**源码启动**与**新安装包**，不会把既有 Docker 数据库自动换成新空库。

## 源码开发启动

```powershell
yarn desktop:install
yarn build
yarn desktop
```

源码仍使用原 `.env` / 默认 Docker 路径，或前阶段显式创建的 embedded 绑定。也可使用项目根目录的桌面启动批处理。缺少 Node/Yarn/Docker 等开发前置时按安装文档处理，不由 AI 静默安装。

开发时先退出桌面端再重新构建：`yarn build` 会替换 `.output` 带哈希模块，不能把旧进程仍在引用的目录当热更新。F12 或 Ctrl+Shift+I 打开开发者工具。

源码启动的 Electron profile 默认优先 `.tmp/electron`，再尝试数据目录和临时目录；这是开发兼容行为。安装版使用绑定数据目录下的私有 profile，不允许外部 `--user-data-dir` 覆盖或公共缓存回落。

## 新安装包

```powershell
node scripts/desktop-pack.mjs --pg-archive '<固定官方PG归档>' --node-license '<匹配Node版本的完整LICENSE>'
node scripts/desktop-installer.mjs --source 'dist/YilingSpace-Payload-<version>'
```

构建机按仓库要求使用 Yarn Classic；生成的 payload 随带 Node、Electron、PG、生产依赖和后台 Worker 所需源码。默认不带 `.env`、`.data` 或开发 Nuxt 路径；`--with-env` / `--with-data` 已被拒绝。私有数据迁移使用备份/恢复，不把配置好的开发目录发给别人。

`YilingSpace-Payload-*` 是安装源，不是可直接初始化数据的便携目录；安装版必须从安装器创建的入口启动。安装器产物为 `YilingSpace-Installer-*`，双击其中的安装批处理。目标无需单独安装 Docker、Node、Yarn，也无需先手写 `.env`，但目前必须已有 PG 所需的 VC x64 系统运行库；安装源与程序目录都提供「检查运行库.bat」和官方准备说明；缺失、错误位数、加载失败或无法验证时明确中止，用户自行从微软下载并交互安装后重试。当前未确认维护者再分发资格，不携带微软安装程序或 DLL，也不自动安装或提升，详见 [VC 运行库记录](../docs/desktop-vc-runtime.md)。

完整目录策略、固定 PG 哈希/许可证、实际验收和限制见 [Windows 安装包记录](../docs/desktop-installer.md)。当前是本机验证阶段，尚未完成干净系统、第二系统用户、杀软、签名和公开发布验收。

## 程序与数据

- 程序选用支持的 ASCII 路径；中文 profile 会选择 OS Public 中以当前 SID/SYSTEM 为主、兼容本机 Administrators 的私有程序目录，不能用未知预占目录。
- 数据与安装状态位于当前用户 LocalAppData 的独立目录，不随程序更新/卸载删除；中文数据路径已在隔离测试中验证。
- 安装状态将 installationId 与数据库 binding 关联。已有数据丢失或身份不符时拒绝补建空库；安装 metadata 损坏也不回退源码 Docker 路径。
- 初始化空库后仍创建管理员，只自动绑定本次确实首建的精确账号；已有库先正常登录，再明确「绑定当前账号为本机主人」。绑定后通过私有进程通道在加载页面前注入 HttpOnly/Secure/Strict Cookie，普通浏览器仍需登录；源码入口不启用该免登录。
- 随机首次密码仍保存在私有 first-run-admin.txt 供手动登录/恢复，已有账号密码不改。文件菜单可重新连接或取消本机免登录，解绑只撤本安装会话、不删数据。实现与未验边界见 [桌面身份记录](../docs/desktop-identity.md)。

关闭窗口默认退出；可在文件菜单选择本次驻留托盘。文件菜单的退出项（Ctrl+Shift+Q）彻底退出。窗口几何信息保存在 profile 的 window-state.json。桌面 Cookie 与开发 Cookie 名称分开，安装版 profile 也相互隔离。

Windows 安装版启动器显式持有安装锁，后端/窗口有受控的独立进程组和原父进程句柄监测；源码入口保留原有 IO/进程组策略，不强制启用安装态监测。Electron 显式使用普通 Node 已准备的 profile。源码兼容回归可用 `yarn desktop:source:smoke`，其中后端为明确隔离的 Mock，不连接业务库。正常退出先等待消费者及自有 PG 收尾；已有 Docker/external 实例不主动停止。异常父进程退出不能因 stdout/stderr 断管而跳过清理，详细故障对照见 [工程教训第 7 节](../docs/engineering-lessons.md)。

## 备份、升级和卸载

安装后退出应用，再使用程序目录的 backup.bat。它读取同一安装/数据库绑定，不误用默认 Docker 容器。备份包含数据库及已登记密钥、图片/贴图等持久材料，仍须作为敏感文件保护。备份/新目录恢复入口见 [数据库接入记录](../docs/desktop-database-integration.md)。

升级和卸载时应用必须已退出，运行中返回 busy，不按进程名杀用户程序。升级保留 previous 程序快照，卸载保留 uninstalled 程序快照和全部应用数据；复装能复用原安装绑定及数据库。快照暂不自动修剪，会占磁盘。未知旧安装、旧数据或无法确认停止的实例不覆盖。

legacy Docker 源码分支保留 QQ 栈原有管理方式；embedded 尚未验证协议栈实例归属，暂不自动复用全局端口上的旧 QQ 适配器。这个阶段没有改渠道 API、消息协议或角色行为。

## 本阶段尚未做

- 自动登录/桌面身份恢复。
- 旧 Docker 数据库自动迁移或切换。
- 合法的 app-local VC 运行库或官方运行库安装流程集成、干净 Windows 验收。
- 自动更新、代码签名、完整跨用户/杀软/系统重启发布验证。

不能把受限 PATH 的本机成功当成“所有全新 Windows 无前置条件即可运行”。
