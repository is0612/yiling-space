# B站值班服务器部署清单

> 适用：把 yiling-hub 的 B站 值班从本机搬到 Linux 服务器。
> **只跑值班不需要 Web 服务**——`yarn bili:run` 自己就是全部；要看报告、改设置、扫码才需要把 Web 起起来。

## 0. 先定三件事

1. **单实例**：`bili:run` 的防重入只在单进程内存里，没有跨机锁。**两台同时跑会重复刷、重复私信**。
2. **国内节点**：B站 API 对海外 IP 风控很凶，容易 `risk_control`。
3. **时区必须是 `Asia/Shanghai`**：谷时窗口（中午 12:00–14:00、夜间 18:00–09:00）按本地时间判断。

## 1. 依赖

| 组件 | 版本 | 验证 |
| --- | --- | --- |
| Node.js | `>=20.19.0`（建议 22 LTS） | `node -v` |
| yarn | 1.22.22（`packageManager` 锁定） | `yarn -v` |
| PostgreSQL | 16 | `psql --version` |
| bili CLI | `bili-agent==0.6.0` | `bili --version` |

```bash
# bili CLI 独立安装（不依赖 bili-desk）
uv tool install "bili-agent==0.6.0"
# 没有 uv 就用：pipx install "bili-agent==0.6.0"
bili --version   # {"ok": true, "data": {"version": "0.6.0"}}
```

## 2. 代码、依赖、数据库

```bash
git clone <repo> /srv/yiling-hub
cd /srv/yiling-hub

# ⚠️ 不要加 --production：tsx 和 prisma 在 devDependencies，
#    而 bili:run / db:migrate:deploy 都要用它们
yarn install --frozen-lockfile

cp .env.example .env
vim .env                      # 见第 3 节

yarn db:generate
yarn db:migrate:deploy        # 生产用 deploy，不要用 migrate dev
```

`yarn build` 只有 Web 服务需要；值班任务本身不读 `dist/`。

## 3. 环境变量（`.env`）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | 指向服务器上的 PostgreSQL |
| `TZ` | ✅ | `Asia/Shanghai`（也建议 `timedatectl set-timezone Asia/Shanghai`） |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 可选 | 只是**兜底**。值班实际用角色自己的模型配置（存在库里、加密） |
| `AUTH_SESSION_TTL_HOURS` | Web 需要 | 默认 12 |
| `YILING_COOKIE_SECURE` | Web 需要 | HTTPS 下设 `true` |
| `YILING_ALLOW_REGISTRATION` | Web 需要 | 默认 `false`，公网开放前再开 |
| `YILING_BILI_DUTY_INTERVAL_MS` | 可选 | 轮询间隔，默认 `60000`（60 秒） |
| `BILI_CLI_HOME` | 可选 | 凭证/owner 目录；留空 = `~/.config/bili-cli`（Linux） |

## 4. 迁数据（本机 → 服务器）

要迁的：

- **数据库**：`pg_dump` 出来在服务器 `psql` 恢复（或项目自带的备份脚本）；
- **`.data/credentials-encryption.key`**：⚠️ 不拷这个，库里存的角色 API Key 解不开，得在网页重新填；
- 判重（95 条）、报告、札记、记忆**都在库里**，不用搬文件。

**不要迁** `%APPDATA%\bili-cli\credential.json`（Windows 路径，跨平台也别带）。登录态在服务器上重新扫，见下一节。

## 5. 首次登录（无 GUI 的服务器）

```bash
# 1) 生成二维码图片
bili auth login --qr-out /tmp/bili-qr.png

# 2) 把图片拉到本地扫（scp / base64 / 临时 nginx 都行）
scp user@server:/tmp/bili-qr.png .

# 3) 扫完确认
bili auth status --wait 120

# 4) 如果私信发给「主人」，设一次（和登录态同目录，换机器要重设）
bili owner set <主人UID>
```

更省事的替代：先临时把 Web 服务起起来，在 `/bili` 页面点「扫码登录」，走的是同一条 CLI、同一份凭证。

## 6. systemd

**值班（必须）** `/etc/systemd/system/bili-duty.service`：

```ini
[Unit]
Description=yiling-hub bili duty adapter
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=yiling
WorkingDirectory=/srv/yiling-hub
Environment=TZ=Asia/Shanghai
EnvironmentFile=/srv/yiling-hub/.env
ExecStart=/usr/bin/yarn bili:run
Restart=always
RestartSec=5
# 日志走 journald，自带轮转
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Web（可选）** `/etc/systemd/system/yiling-web.service`：

```ini
[Unit]
Description=yiling-hub web
After=network-online.target postgresql.service

[Service]
User=yiling
WorkingDirectory=/srv/yiling-hub
Environment=TZ=Asia/Shanghai
EnvironmentFile=/srv/yiling-hub/.env
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bili-duty
sudo journalctl -u bili-duty -f
```

## 7. 验证清单（上线当天按顺序打勾）

- [ ] `bili --version` → 0.6.0
- [ ] `bili auth status` → 已登录、是预期账号
- [ ] `bili owner show` → 主人 UID 正确
- [ ] journal 里出现 `{"event":"bili-adapter-start"}`，之后每分钟一条 `bili-duty-idle`（带跳过原因）
- [ ] 手动跑一轮（Web 值班台「现在跑一轮」，或 `POST /api/admin/bili/run-round`）
- [ ] 库里能看到新报告：`select day,"roundIndex","pickedCount","createdAt" from bili_round_reports order by "createdAt" desc limit 1;`
- [ ] `bili_seen_videos` 有新增行
- [ ] 收得到私信（`bili dm send owner --file msg.txt` 试一条；注意 10 秒/次限流）
- [ ] 等一个真实窗口，确认自动跑了一轮

## 8. 运维

- **日志**：`journalctl -u bili-duty -f`，一行一个 JSON；按 `event` 过滤（`bili-duty-start` / `-done` / `-error`）。
- **重启**：`systemctl restart bili-duty`，状态从数据库重建，重启不会重复刷。
- **备份**：数据库 + `.data/credentials-encryption.key` 一起备；凭证在服务器本地，按机器各自扫码。
- **监控**：`bili-duty-error` 连续出现、`/api/health`（Web）、任务队列失败数（`/tasks`）。

## 9. 容易踩的坑

| 现象 | 原因 / 处理 |
| --- | --- |
| 窗口到了却不跑 | 服务器时区不是 Asia/Shanghai；或 `peakValley=false`；或今日额度已满 |
| `Cannot find module 'tsx'` | 装了 `--production`，把 devDependencies 装回来 |
| 模型调用报未配置 Key | `.data/credentials-encryption.key` 没迁 → 网页重填角色 Key |
| `risk_control` / `captcha_required` | 立刻停手，换网络环境，**不要换方式绕**；海外 IP 尤其容易 |
| 两侧同时私信/重复挑 | 旧机器或第二个实例还在跑，只留一个 |
| 中文路径下 TLS 报错 | 仅 Windows/libcurl 的问题；Linux 服务器一般没有 |
| 夜间窗口被跑两次 | 已用 `windowDayKey()` 处理（0–9 点归前一天），不要自己再改时区 |
