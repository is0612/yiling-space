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

桌面版会话 Cookie 使用 `yiling_session_desktop`（开发版仍是 `yiling_session`），两者同时登录不会互相顶掉。

## 数据目录

默认仍是项目根目录的 `.data/`。桌面端可设置：

```powershell
$env:YILING_DATA_DIR = "$env:LOCALAPPDATA\YilingSpace\data"
yarn desktop
```

日志在 `<data>/logs/desktop.log` 与 `<data>/logs/desktop-supervisor.log`。
Electron 的 Chromium profile（缓存，不是用户数据）默认放 `.tmp/electron`；如果那里不可写，
会依次回退 `<data>/electron` 和系统临时目录。

> ⚠️ 如果改了 `YILING_DATA_DIR` 却继续用旧数据库，必须把旧 `.data/credentials-encryption.key`
> 一起复制过去；否则数据库里的 OneBot/SnowLuma 凭据解不开，页面会提示解密失败。

## 当前边界

- 还没有安装包、签名、自动更新；这是可运行原型。
- Docker 自动启动目前只覆盖 `docker desktop start` 与 `docker compose up -d db`；
  未装 Docker、登录卡住等分支还需要按 `docs/桌面化架构评估.md` 第 7 节补齐。
- QQ/SnowLuma 仍由服务端插件自动补起，桌面退出时不会接管它们；后续要改成
  supervisor 管理或提供开关。
- Worker 复用 `scripts/memory-worker-supervisor.mjs` 的跨进程锁；已有开发实例在跑时，
  桌面实例会显示 `worker-already-supervised`，不会重复消费。
