# 忆灵空间桌面壳（Electron 原型）

这是阶段二的桌面壳。它只负责窗口；数据库、Nitro、Worker、QQ 栈由启动器（普通 Node）拉起的
`scripts/desktop-supervisor.mjs` 管理，不塞进 Electron 主进程。

## 运行前提

- Windows + Docker Desktop（数据库仍用现有 `yiling-hub-db` 容器）
- 项目根目录已有 `.env`
- 已执行过 `yarn build`（`desktop` 加载的是 `.output` 的生产服务）

## 安装与启动

```powershell
# 第一次：只装桌面壳自己的 Electron（不影响根目录依赖）
yarn desktop:install

# 启动
yarn desktop
```

也可以直接双击项目根目录的 `启动忆灵空间-桌面版.bat`；它会检查 Node/yarn、缺 Electron 时自动安装，然后启动桌面壳。

`yarn desktop` 实际执行 `desktop/launch.cjs`：先由普通 Node 起 supervisor，拿到 ready URL 后再开
Electron 窗口；窗口退出时由启动器停 supervisor。顺序为：

```text
Docker 数据库 → prisma migrate deploy → Nitro → Scheduler → Worker → QQ 栈（可选）→ 窗口
```

为什么不让 Electron 主进程起 supervisor：Electron 的子进程在部分 Windows 安全策略下拿不到正常
文件权限，SnowLuma 会在 `mkdir <SnowLuma>\tmp` 处 EPERM；普通 Node 起 supervisor 才和手动
`yarn onebot:stack` 一样可靠。

QQ 栈由 supervisor 以 `scripts/start-qq-stack.ts --managed` 启动，优先用系统 Node（不是 Electron 的
run-as-node，后者在部分机器上带不起 SnowLuma），并同时检查面板 `5099` 与 `3001/3002`；
退出时通过 stdin 让它依次停 adapter / watchdog / SnowLuma。如果这三者都在监听（例如你手动跑过
`yarn onebot:stack`），不会重复启动。桌面模式下 Nitro 的 `onebot-autostart` 插件会被关掉，
避免两套进程抢同一组端口。

启动器会清掉继承来的 `ELECTRON_RUN_AS_NODE`（否则 Electron 会退化成 Node），
并在少数机器上 Chromium 沙箱直接崩溃时自动重试一次 `--no-sandbox`。

窗口里按 **F12** 或 **Ctrl+Shift+I** 打开 / 关闭开发者工具；这是窗口内快捷键，不影响其它应用。

关闭窗口默认退出桌面端。确认系统托盘能看到图标后，可从「文件 → 关闭窗口时保留在托盘」开启本次驻留。
Windows 窗口顶部可通过「文件 → 退出忆灵空间」（`Ctrl+Shift+Q`）彻底退出。托盘图标是否常驻由 Windows 的「任务栏设置 → 其他系统托盘图标」控制。
开发时先退出桌面端，再执行 `yarn build`，构建完成后重新启动。构建会替换 `.output` 内带哈希的模块，
旧进程可能仍引用被替换的模块，访问页面时就会报 `Cannot find module`；刷新页面不会重启服务。
窗口大小/位置/最大化状态会记在 Electron userData 的 `window-state.json`，下次按原来的位置打开。
托盘菜单还可以直接打开数据目录和日志目录。

角色卡 / 对话 Markdown 导出会弹出系统「保存」对话框，由你选择可写目录；不再依赖默认下载目录，
避免 Windows 在受保护目录上报「需要管理员权限」。

桌面版会话 Cookie 使用 `yiling_session_desktop`（开发版仍是 `yiling_session`），两者同时登录不会互相顶掉。

## 数据目录

默认仍是项目根目录的 `.data/`。桌面端可设置：

```powershell
$env:YILING_DATA_DIR = "$env:LOCALAPPDATA\YilingSpace\data"
yarn desktop
```

## 首次启动

- 数据库迁移后如果 `users` 表为空，supervisor 会自动建一个管理员：
  - `.env` 里有可用的 `DEV_OWNER_USERNAME` / `DEV_OWNER_PASSWORD` 就用它；
  - 没有就随机生成密码，写到 `<data>/first-run-admin.txt`，登录后请立刻改密码。
- 已有用户的数据库不会被动；想关掉自动初始化，设 `YILING_FIRST_ADMIN=0`。
- Docker 没装 / 没启动 / 登录卡住 / 端口被占用时，窗口会显示错误页和「打开日志目录」按钮，
  不再只弹一句 `spawn` 错误。

日志在 `<data>/logs/desktop.log` 与 `<data>/logs/desktop-supervisor.log`。

## 便携包

```bash
node scripts/desktop-pack.mjs                 # 构建 .output 并打包（不带 .env）
node scripts/desktop-pack.mjs --skip-build    # 复用已有 .output
node scripts/desktop-pack.mjs --with-env      # 连同 .env 一起打（只适合自己迁移）
node scripts/desktop-pack.mjs --with-env --with-data  # 连 .env + .data（密钥/表情/SnowLuma 配置）一起打
```

产出在 `dist/桌面便携版-<version>/`：`runtime/node.exe` + `app/`（含 `.output`、生产依赖、
Electron）+ 启动 bat。目标机器只需要 Docker Desktop，不需要 Node/yarn；`.env` 默认不打包，
首次使用先把 `app/.env.example` 复制成 `app/.env` 并填写数据库/模型配置。
便携目录请放在可写位置（如 `D:\YilingSpace`），不要放 `Program Files`；当前包约 1 GB。
自己迁移时用 `--with-env --with-data`，包内会带数据库密钥和 SnowLuma 配置；这种包不要转发。

备份：
```powershell
yarn desktop:backup                 # 仓库内
node scripts/desktop-backup.mjs backup
```
便携包里双击 `备份数据.bat`。备份在 `<data>/backups/desktop-<时间>/`，含 `database.dump`
和 `credentials-encryption.key`；恢复前必须先停应用。

## 安装包

```powershell
node scripts/desktop-installer.mjs --source "D:\YilingSpace-Portable"
```

产出 `dist/安装包-<version>-本机/`：双击 `安装忆灵空间.bat` 安装到
`%LOCALAPPDATA%\YilingSpace`，创建桌面/开始菜单快捷方式和 HKCU 卸载项，不需要管理员权限。
卸载时 `app\.data` 会移到「文档」下的 `YilingSpace-data-<时间>`，不会直接删用户数据。
这是无管理员脚本安装器，不是 NSIS；要发布给别人的安装包等代码签名后再做。

Electron 的 Chromium profile（缓存，不是用户数据）默认放 `.tmp/electron`；如果那里不可写，
会依次回退 `<data>/electron` 和系统临时目录。

> ⚠️ 如果改了 `YILING_DATA_DIR` 却继续用旧数据库，supervisor 会自动把旧 `.data` 里的
> `credentials-encryption.key` 和 `snowluma-home.json` 复制过去（不搬表情包/语音临时文件）；
> 否则数据库里的 OneBot/SnowLuma 凭据解不开，页面会提示解密失败。

## 当前边界

- 还没有安装包、签名、自动更新；这是可运行原型。
- Docker 自动启动目前只覆盖 `docker desktop start` 与 `docker compose up -d db`；
  未装 Docker、登录卡住等分支还需要按 `docs/桌面化架构评估.md` 第 7 节补齐。
- QQ/SnowLuma 仍由服务端插件自动补起，桌面退出时不会接管它们；后续要改成
  supervisor 管理或提供开关。
- Worker 复用 `scripts/memory-worker-supervisor.mjs` 的跨进程锁；已有开发实例在跑时，
  桌面实例会显示 `worker-already-supervised`，不会重复消费。
