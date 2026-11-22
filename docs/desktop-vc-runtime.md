# 桌面 VC x64 运行库：检测与官方准备流程

## 本轮交付

默认不向安装包加入微软 VC 安装程序或系统 DLL。安装器提供独立的「检查运行库.bat」、check-runtime.ps1 和 VC-runtime-guide.html；说明与检查器也会留在安装后的程序目录。检查失败时在安装/数据初始化前停止，用户自行完成微软安装器要求的步骤后再重试。

这解决的是明确前置检查与准备流程，**不是已完成 app-local VC 随包分发**。应用本体仍不需要目标机另装 Docker、Node 或 Yarn，但首次补系统运行库可能需要用户接受许可、管理员授权或重启，不能承诺完全无管理员前置。

## 为什么默认不直接塞 DLL / EXE

微软官方资料明确存在许可条件，不能把签名有效或用户接受运行时 EULA 当作项目维护者已有再分发权。

- [Redistribute Visual C++ files](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170) 的 Redistributable files and licensing："Distribution of the Visual C++ Runtime Redistributable package, merge modules, and individual binaries is limited to licensed Visual Studio users and is subject to Microsoft Software License Terms."
- [Latest supported downloads](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170) 同样要求相应 Visual Studio 许可；架构应与应用匹配，运行库版本不得早于构建工具。它提供最新官方 x64 下载入口，不能把某个系统已装版本当作最新发行物版本。
- [Visual Studio 2026 REDIST 清单](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution) 与 [2022 清单](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution) 的分发授权以有效许可和相应 License Terms 为条件；Community 或 Build Tools 的名称不构成本项目已满足条款的证明。

本轮没有确认维护者的具体许可资格，因此选择仅给出[微软官方下载说明](https://learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist)。没有镜像下载、抽取/拷贝 System32 DLL、携带 vc_redist.exe、自动调用 /quiet 或 /passive、自动提权、修改 DLL 搜索路径或接受许可。

以后如确认适用许可并决定实现 app-local，须另行核对具体版本、REDIST 文件、依赖与许可材料、安全更新责任；本代码没有给出一个绕过许可条件的开关。微软同时推荐中央运行库部署以便独立更新，本轮没有把 app-local 技术可行写成法律上无条件可用。

## 检测实际做了什么

`desktop-vc-runtime.mjs` 静态读取 PE 的正常和现代 delay import 表，先验证 PG 发行物完整性，再扫描 bin 的 exe/dll。固定 PG 发行物实际需要：

- msvcp140.dll
- vcruntime140.dll
- vcruntime140_1.dll

Windows API set/UCRT 不按物理文件存在性猜缺失。DLL 本身须在真实 System32 可读取且为 x64；固定原生探针只在真实系统目录对已知 VC 名称调用 LoadLibraryExW（System32 搜索范围）并 FreeLibrary。传入其它 systemRoot 不会让检查器加载任意用户 DLL。

结果区分 ready、missing、incompatible、unverified，并给出具体检查项、架构和文件版本诊断。ready 只证明这些只读检查通过，**不是完整 PG 导入符号/工具链版本兼容、微软签名认证、或干净系统发布认证**。当前机的实际 PG 初始化在前阶段已测试；本轮未通过改动 System32 模拟一台缺运行库的机器。

不提供 pgRoot 的命令只检查最低已知组件，报告 scope=known-minimum；安装和安装态首次启动始终检查包内已验证 PG 的完整依赖，scope=pg-distribution。源码启动分支不增加这个强制前置。

## 用户操作

1. 双击「检查运行库.bat」；通过后再运行安装入口。
2. 若缺失、位数错误、加载失败或无法验证，打开同目录 VC-runtime-guide.html。
3. 从微软页面自行选择最新受支持的 x64 运行库，交互运行并自行决定许可、UAC 和重启请求。本项目不执行这个安装器。
4. 重新检查；只有检查通过才进入应用安装。损坏的 PG payload 单独报错，不误引导用户重装 VC。

只读命令：

```powershell
# 仓库诊断（最低已知组件，不是完整PG发布验证）
yarn desktop:vc:check
# 对一个包内已校验的PG做完整依赖检查
node scripts/desktop-vc-check.mjs --pg-root '<payload>/runtime/pgsql'
```

检查入口返回 0 表示该范围通过，2 表示运行库前置未满足，1 表示检查/发行物本身有错误。直接安装命令的运行库前置错误同样返回 2。

## 验证与边界

- PE 边界、损坏输入、导入家族筛选、错误架构、加载失败、无法验证等有合成回归，明确使用注入检查结果；不把占位 DLL 当真正可加载的运行库。
- 集成回归验证所有未就绪结果都早于程序/状态/数据目录创建。
- 当前 Windows 对实际已验证 PG 的三项系统 DLL 原生加载检查通过，未安装或修改系统组件。
- 最小非安装 fixture 使用随包 Node 实际执行生成的 check-runtime.ps1；再把 fixture 内的检查入口替换为明确的合成结果，验证安装脚本以 2 提前返回、没有调用安装器或创建目标目录。它不是整个桌面包/GUI 或数据库演练。
- 检查器和指南已被打包器列为必需脚本；生成器拒绝缺检查器的旧 payload，要求重新构建。

回归入口：

```powershell
yarn test:desktop-vc-runtime
yarn test:desktop-vc-integration
yarn test:desktop-package-state
$env:YILING_TEST_PG_DISTRIBUTION = '<已验证PG发行物目录>'
yarn desktop:vc:guide-smoke
```

本轮回归、类型检查、完整 lint、隐私门禁和测试计划校验通过。安装器 HTML/PowerShell 的生成和实际执行已验证；本轮没有重建正在使用的 Nuxt Web 输出，也没有重复整包 GUI/数据库演练。

尚未进行真正缺少 VC 的干净 Windows VM、用户交互运行微软安装器、UAC/重启、杀软、不同用户或公开发布验证。没有修改真实数据库、服务器认证或角色模型设置。免登录仍在本轮范围外。
