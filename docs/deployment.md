# 部署与扩展

本文汇总 Phase 6「部署和扩展」相关事项：HTTPS 与反向代理、配置管理、监控与告警、日志轮转、数据删除策略，以及后续扩展方向。备份与恢复见 `docs/local-development-and-data-migration.md`。

## 1. 进程模型

Yiling Space 由两部分组成：

- **Web 服务**（Nuxt/Nitro）：`yarn build` 后 `node .output/server/index.mjs`（或 `yarn start`），对外提供页面与 `/api`。
- **后台进程**（独立运行，与 Web 服务解耦）：
  - `yarn scheduler:run`：按周期边界把快照/清理任务入队。
  - `yarn worker:run`：单轮处理记忆任务、社交关系评估和统一成长事件投递；事件消费者只在自身需要时调用领域读取接口。
  - `yarn worker:watch`：常驻运行上述共享 Worker，并每小时清理超过 30 天且所有消费者均已终态的成长事件。
  - 双击根目录「启动忆灵空间」时，`scripts/launch.mjs` 默认会同时启动 `worker:watch`；只想启动 Web 可设置 `YILING_WORKER_DISABLED=1`。
  - `yarn onebot:run`：QQ 小号（OneBot v11）渠道适配器（长连接收消息并回复）。
  - `yarn bili:run`：B站 值班适配器（谷时调度 + 被动回复）。部署细节见 `docs/B站值班服务器部署清单.md`。

这些后台进程可以与本机 Web 服务同机运行，也可以部署到独立主机/容器。它们之间通过 PostgreSQL 的任务队列协调，天然支持横向拆分。

## 2. HTTPS 与反向代理

Web 服务默认监听 HTTP（本地 `127.0.0.1`）。公网部署时，在它前面放反向代理并终结 TLS。

Nginx 示例（`/etc/nginx/sites-available/yiling`）：

```nginx
server {
    listen 80;
    server_name hub.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    # 会话 Cookie 依赖这几个头；Host 必须与浏览器看到的域名一致（否则同源校验会拒绝请求）。
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    client_max_body_size 10m;
}
```

要点：

- `YILING_COOKIE_SECURE=true`（或 `NODE_ENV=production`）会让会话 Cookie 带 `Secure`，必须配合 HTTPS。
- 同源/跨站校验依赖 `Host` 头与浏览器 `Origin` 一致；反向代理务必保留 `Host`，不要改写域名。
- 反向代理可配置客户端 IP 透传（`X-Forwarded-For`），但服务端只在明确配置可信代理后才应信任它——当前实现默认不信任该头。

## 3. 配置管理

所有配置经环境变量注入（见 `.env.example`）。生产环境不要复用本地 `.env`，而是为每个环境单独设置：

- `DATABASE_URL`：指向独立、受保护的 PostgreSQL。
- `POSTGRES_*`：仅本地 `docker compose` 使用。
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`：模型服务的默认回退（角色的 API Key 可单独在网页配置，加密保存）。
- `AUTH_SESSION_TTL_HOURS`、`YILING_COOKIE_SECURE`、`YILING_ALLOW_REGISTRATION`、`YILING_ALLOW_DEV_OWNER_BYPASS`：鉴权相关。
- `ONEBOT_*`、`QQ_*`：QQ 小号渠道端点覆盖项（默认值见 `qq-onebot-deploy.md`）。

秘密（数据库密码、模型 Key、OneBot WS/HTTP Token、加密密钥 `.data/credentials-encryption.key`）不得进入 Git 或镜像层，应通过 Secret 管理或受控的环境注入提供。

## 4. 监控与告警

- **存活探针**：`GET /api/health` 返回 `{ ok: true, ... }`，不依赖数据库，供负载均衡/探活使用。
- **就绪探针（仅管理员）**：`GET /api/admin/health` 返回数据库连通性与任务队列计数（queued / running / succeeded / failed），可用作外部监控的数据源。
- **任务状态**：`/tasks` 页面可查看任务的排队、执行、失败与重试状态；后台进程把状态写回 `memory_jobs`。
- **告警建议**：至少对「连续失败任务数」与「数据库连通性」设置阈值告警；磁盘告警针对数据库数据卷（`yiling_postgres_data`）与备份目录所在磁盘。

## 5. 日志轮转

Web 服务与后台进程写标准输出。部署到容器或 systemd 时，由宿主机负责轮转：

- Docker：`logging` 驱动 `json-file` 的 `max-size` / `max-file`，或用 `docker compose` 的 `logging:` 段。
- systemd：`journald` 自带轮转与上限。

应用层日志不落盘文件，因此无需在代码内做轮转；若将来需要持久化审计日志，应写入 `audit_logs` 表而不是日志文件。

## 6. 数据删除策略

- **原始消息清理**：每个角色可配置原始消息保留期（永久 / 30 / 90 / 180 天），由后台清理任务在周期内删除过期原文并写审计记录；有限保留需单独确认授权，不会自动触发。
- **回收站与记忆**：角色删除、记忆删除走回收站/软删除流程（见 `docs/memory-system.md`）。
- **账号注销**：管理员可停用账号（会话立即失效）；账号的完整物理删除与关联数据清理需按产品删除策略另行设计。
- **备份保留**：备份文件按敏感数据对待，异地存放、定期轮换、定期做恢复演练（见迁移文档）。

## 7. 后续扩展

- **水平扩展**：后台进程与 Web 服务解耦，可拆分到独立机器；任务队列以数据库为协调点，注意并发 Worker 的领取互斥（已由状态机保证不重复领取）。
- **对象存储**：若接入图片/附件，需将文件迁出本地目录并纳入独立备份。
- **多渠道**：`server/utils/channel-adapter/` 已抽象出平台无关的消息管线，接入下一个平台只需新增一个 Adapter 并注册连接。
- **多实例部署**：迁移/备份、模型调用与渠道适配器都可独立扩容；数据库作为唯一状态源，保持单写主库 + 定期备份即可。

## 8. 停滞检测（Watchdog）

进程活着不等于任务在走。`yarn watchdog:run` 只读不写地检查记忆任务卡住/积压/未排期/长期零产出、B站 值班长期未运行，以及成长事件投递积压/卡住/达到重试上限。总览页顶部的报警条用的是同一份判定（`server/utils/watchdog.ts`），结论可以直接对上「排期没跑」还是「Worker 没跑」。

值班那条是独立流水线：记忆停着不代表值班没跑，反过来也一样，所以两者会各报一条。

- 单次：`yarn watchdog:run`（有需要处理的项时退出码 1，可直接进计划任务）
- 常驻：`yarn watchdog:run --watch`（默认 5 分钟一轮，`YILING_WATCHDOG_INTERVAL_MS` 可调）
- 跟着 QQ 链路一起起：`yarn onebot:stack`（或双击 `scripts/start-qq.bat`）会在同一窗口里再起一个 `--watch` 实例，日志前缀 `[watchdog]`；它自己崩了不影响 QQ 收发，但会留下 `watchdog-exited` 一行。不想要就设 `YILING_WATCHDOG_DISABLED=1`
- 验证：`yarn test:watchdog`

**判出「卡在运行中」之后怎么解**：租约窗口是 5 分钟（`server/utils/memory-job-lease.ts`），忆泡任务在每次模型请求前续期。过期表示没有及时续期，需要检查执行进程、数据库或运行环境是否停滞，不能单凭过期断言进程已经退出。网页请求中的执行可能被 `yarn dev` 重启打断。回收发生在「下一次有人领取任务」时（`reclaimExpiredMemoryJobs`），所以**整机没有 Worker 在跑时不会自动回收**，任务会一直显示「运行中」：

- 要它自动走：`yarn worker:watch` 一起来就会立刻把这批过期任务打回队列；
- 只想解这一条：任务监控里对那条点「回收并重新入队」（`POST /tasks/{taskId}/retry`，运行中但有租约过期的任务才放行，写审计 `memory_job.manual_retry` + `recoveredLease`）。

## 9. 调度器与 Worker 的启动命令

调度器把到期周期写进 PostgreSQL 任务队列并推进下一周期边界；Worker 消费队列。

```bash
yarn scheduler:run     # 手动扫描一次到期周期
yarn scheduler:watch   # 常驻，默认每 60 秒扫描一次
yarn worker:run        # 单次执行一条任务
yarn worker:watch      # 常驻消费队列
```

Worker 会跟着网页一键启动器（根目录启动批处理）和 QQ 链路（`yarn onebot:stack` / `scripts/start-qq.bat`）一起启动。网页已经在运行时，再运行一键启动器仍会补起 Worker，并保留当前窗口守护它。`YILING_WORKER_DISABLED=1` 可关闭这两个启动器附带的 Worker。

两个入口共用本机守护模块：以仓库绝对路径派生回环监听锁，同一仓库的两个启动器只启动一个受管 Worker；另一个待命，锁释放后接管。锁端口若被无关程序占用会明确报错，不会误认成 Worker。Worker 异常退出后按 5 秒至 60 秒退避重启；正常退出启动器时先给 Worker 5 秒退出，再强制结束并释放锁。任务恢复仍由数据库租约和消息游标负责。

该去重只覆盖这两个启动入口；手动 `yarn worker:watch`、其它仓库副本或其它机器的 Worker 仍可独立运行，任务领取互斥由数据库保证。受管 Worker 额外预加载 IPC 父进程守卫：启动器被强制终止或控制台关闭时，IPC 断开使 Worker 立即退出，未完成任务留待数据库租约回收；手动 Worker 不加载此守卫。生产部署仍应使用 systemd、容器或其它系统守护工具。启动器不会自动启动 Scheduler，自动排期仍需要 `yarn scheduler:watch`。

共享 Worker 消费记忆任务、社交关系评估任务和成长事件投递；Watchdog 分别报告记忆任务积压与成长事件积压、卡住、达到重试上限。

验证本机守护：`node scripts/test-memory-worker-supervisor.mjs`（仅运行临时假 Worker，不连接数据库或调用模型）。

间隔可用 `YILING_MEMORY_SCHEDULER_INTERVAL_MS`（最小 5000）与 `YILING_MEMORY_WORKER_INTERVAL_MS`（最小 1000）调整。

Worker 配置模型后会调用 LLM 对周期对话做结构化总结，验证来源消息 ID，再把快照、长期记忆新增/更新/失效和审计记录放进**同一个数据库事务**。模型未配置时保留队列任务；失败按退避策略重试。

验证：`yarn test:scheduler`（周期边界）、`yarn test:scheduler-db`（幂等与清理）、`yarn test:memory-ai`（来源校验）。


## 10. 统一成长事件中心

- 事件与投递状态分别保存在 `growth_events` / `growth_event_deliveries`，按 `Character.id` 隔离。
- 事件只存来源领域、事件类型/版本、聚合对象引用、时间、最小 payload 和稳定幂等键，不复制聊天正文。
- 领域写入与 Outbox 事件必须在同一数据库事务内；消费者通过角色限定的领域 Gateway 读取来源。
- `worker:watch` 在同一进程内启动独立事件消费循环，不等待社交/记忆模型任务完成。每批最多连续处理 20 条；满批后通过零延时等待让出事件循环并继续查数据库，未领到任务或领取异常时等待 5 秒。`YILING_GROWTH_EVENT_IDLE_INTERVAL_MS` 可改空闲等待（1000–60000 毫秒，非法值回退 5000），独立于 `YILING_MEMORY_WORKER_INTERVAL_MS`。
- 每条消费仍从持久数据库领取，租约 5 分钟、带 fencing token；同一进程的事件循环内不并发领取。失败指数退避，最多 5 次。SKIPPED 是明确终态，不算成功，也不重试。
- 保留清理由独立循环启动时执行一次，以后每小时执行一次，每次最多删除 500 条事件；异常只记日志，不停止消费或原社交/记忆轮。不会为了清空积压在一小时内重复清理批次。
- SIGINT/SIGTERM 会停止后续领取并清除等待计时器，等待正在进行的事件、清理或模型任务完成，再断开 Prisma；不会取消已经开始的数据库调用或模型请求。强制终止进程仍靠原有数据库租约恢复。
- `worker:run` 单次执行一批最多 20 条事件、一次有界清理，以及原有社交维护/社交评估/记忆轮各一次；任一流水线抛错会使单次命令退出码为 1，其余流水线继续执行。纯调度回归：`yarn tsx scripts/test-growth-event-runner.ts`（不连接数据库、不调用模型）。
- 成功、跳过或取消的事件在 30 天后清理；只要存在未完成或 FAILED 投递，事件就保留供恢复和排查。
- Watchdog 检查已到期积压、运行中超时与达到重试上限的投递。详情见 `docs/growth-data-center-architecture.md`。
- 只有明确排查后才手动恢复终态失败投递：`yarn growth:event:retry <deliveryId>`。命令只接受 `FAILED`，将新一轮 attemptCount 归零、保留 fencingToken 单调序列，并写入 `SYSTEM` 审计；重复执行不会重复入队。

## 11. 反思建议

- 先应用 `20261110040000_reflection_suggestions` 和 `20261110050000_reflection_deduplication` 迁移，再更新并重启 Web 与 Worker。真实业务库迁移按备份和发布流程执行；本地验收只使用随机临时库。
- 用户在“成长系统 → 反思与成长”主动发起；`worker:watch` 在原社交/记忆轮中每轮最多处理一条反思，事件投递独立循环不受该模型等待阻塞。没有 Worker 时保持QUEUED，页面需手动刷新。
- 首批明确复用当前角色聊天模型、API地址、凭据与每日额度，不新增独立助手配置。模型请求最长60秒，租约5分钟；最多3次退避后FAILED，拥有者可在页面恢复。旧租约结果不能提交。
- 无可用公开来源时成功返回空建议，不调用模型。模型配置缺失、额度已用尽或供应商失败时任务退避重试，页面只显示安全通用错误，不写入凭据或供应商原始正文。
- 接受建议只保存为本页成长结论和审计，当前不会自动改人设、知识或聊天上下文。反思历史没有自动保留清理；拥有者可删除单次或清空全部反思（包含成长结论），保留来源、用量与审计。运行中任务删除后旧结果不会写回，已发出的模型请求仍可能计费。角色删除时级联删除，接受前来源失效会拒绝。
