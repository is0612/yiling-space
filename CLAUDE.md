# Yiling Space：AI 开发约束

> 本文件只写「现在必须怎么做」。事故经过、实测数据与排查过程见 [工程教训](docs/engineering-lessons.md)（按领域分节，含日期、症状、根因与回归测试）。

在修改代码前，先阅读：
- `README.md`
- `docs/INDEX.md`（文档地图：哪份是现行规范、哪份只是历史存档，别照着归档文档施工）
- `docs/忆灵空间 · 功能总表.md`（每个功能到底做到哪了，唯一状态入口）
- 与当前任务相关的 `docs/` 文档
- `docs/openapi.yaml`（涉及 API 时）
- `docs/local-development-and-data-migration.md`（涉及本地环境、数据库或部署时）
- `INSTALL-FOR-AI.md`（别人让你「在本机装一下」时先读它，按它的步骤走）

## 首次安装（给 AI）

1. 装依赖一律 `yarn install`，**不要用 pnpm / npm 装**：仓库锁的是 `yarn.lock` + `packageManager: yarn@1.22.22`，混装会多出一份 lock，后续 `verify:local` 会各装一套。`postinstall` 会顺带跑 `nuxt prepare` 与 `prisma generate`。
2. `yarn setup` 是交互向导，**只在真实终端里由用户本人跑**；AI、脚本、CI、管道里必须用 `yarn setup --yes`（随机库密码 + `admin` / `admin123`，装完提醒用户改密码），只看计划用 `yarn setup --dry-run --yes`。非 TTY 下跑交互版会被直接挡下。
3. 缺 Node 20.19+ / yarn 1.22 / Docker 时停下来让用户自己装，不要提权静默安装 —— 批准策略为 never 时这类命令会被自动拒绝。
4. 装完跑 `yarn check:env` 并把输出交给用户；没配模型 Key 时页面能开但 AI 一个字不回，别只说「装好了」。

## 运行配置（服务端 `.env`）

模型参数：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`；超时 `LLM_CHAT_TIMEOUT_MS`（聊天，默认 60 秒）与 `LLM_JOB_TIMEOUT_MS`（忆泡/快照/日记等后台任务，默认 180 秒），旧版共用的 `LLM_TIMEOUT_MS` 仍作兜底。角色级模型配置优先于这些默认值。视觉另有 `VISION_MODEL`。改提示词模板必须递增 `server/utils/chat-reply.ts` 的 `PROMPT_TEMPLATE_VERSION`，相关回归有版本断言。

## 命名约定

品牌名是 **Yiling Space**（中文「忆灵空间」，仓库 `is0612/yiling-space`）。但**基础设施标识保持旧名，不要跟着改**：数据库/用户 `yiling_hub`、容器 `yiling-hub-db`、数据卷 `yiling_hub_postgres_data`、备份文件名前缀 `yiling-hub-`。已有安装的数据全挂在这些名字下。同理保留角色卡格式 `yiling-hub.character`（旧卡要能导入）。要动这些必须同时给出迁移方案。

## 项目约束

1. 这是通用的多角色 AI 养成平台。角色名称、设定、模型配置和渠道必须由数据驱动，不能硬编码某个特定角色。
2. 必须区分原始消息/事件、周期快照和长期记忆。默认 8 天是快照生成间隔，不是原始消息的保留期限。
3. 快照重新生成必须创建新版本，不能无痕覆盖历史版本；重要的人工修改需要审计记录。
4. 记忆必须有明确范围：角色全局记忆与用户私人记忆不可混用。跨平台身份只有在经过验证的绑定流程后才能合并。
5. API 行为以 `docs/openapi.yaml` 为契约。修改接口时同步更新契约与相关 Mock/测试。
6. 数据库结构变更必须通过 Prisma schema 和 migration 管理，禁止只改数据库而不提交迁移文件。
7. 任何公开部署的写接口都必须有服务端鉴权和授权校验。不能把密钥、数据库凭据或管理员 Token 暴露给浏览器、提交到 Git 或写入普通日志。
8. 周期任务必须持久化，具备幂等性、失败重试、可观测状态和错过周期后的补处理能力。正式任务不能依赖 Web 进程内的 `setInterval` 保证执行。
9. AI 输出的总结应尽可能保留来源；不确定的推断不能写成确定事实。
10. 本地 Mock 只用于开发验证，必须明确标注，不能伪装成真实数据库或真实任务状态。
11. 换电脑和灾难恢复需要遵循本地开发与数据迁移文档。备份文件和真实环境变量不可提交到 Git。
12. 一次只实现用户当前要求的范围。开始前检查仓库现状，不要覆盖已有实现或擅自扩大需求。**路线图不等于任务书**：`docs/` 里的阶段规划只是方向，不代表用户批准了下一步。动手前先说出最小切片和止损点；做完一步就停下来让用户判断，不要因为「文档里下一阶段写着」就自己往下推。
13. 前端统一使用 Vue 3 + Nuxt 4 + TypeScript + Element Plus；Nuxt 默认使用 Vite，不要再引入 React/Next.js 或单独重复搭建 Vite 应用，除非用户明确要求重新评估技术栈。
14. 优先使用 Element Plus 的按钮、输入框、表单、选择器、弹窗、表格、标签、通知等组件，保持现有工作台的浅色视觉风格；自定义 CSS 主要用于布局与品牌样式。
15. 完成修改后，运行适用的类型检查、测试和构建；如当前项目尚未具备运行环境，必须说明未执行的检查，不得声称通过。
16. 交付时简要列出修改文件、关键实现、运行/测试结果、已知限制与下一步建议。
17. 字号最小 12px：任何页面、组件和全局样式的 `font-size` 不得小于 12px。辅助信息用颜色和字重区分层级，不要靠缩小字号；容器放不下就改排版或精简文案，不要把字号压回去。
18. 改过 `.vue` 必须跑 `yarn check:sfc`（已进 `verify:local`）。它逐个编译 `app/**/*.vue` 的 script 与 template，能发现 `await` 写在非 async 函数里这类 `eslint` 与 `typecheck` 都看不见的语法错误。
19. `verify:local` 最后两步是 `lint`（0 error，`vue/html-indent` 一类 warning 不挡）和 `build`。若末尾报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，那是 CLI 删除守卫按本轮累计删除量拦住了 `nuxt build` 清 `.cache/nuxt`：先确认前面的 `tsx` 脚本与 `typecheck` 都过了，再单独跑一次 `yarn build`。
20. **先用代码判，再调模型。** 来源白名单、时间窗、条数上限、重复计数、状态位、正则能认的格式一律交给代码；模型只做「必须理解语义」的那一段。已在这么做的地方不要退回模型判断：群聊闸门（`group-chat.ts` 纯函数）、系统播报过滤（`looksLikeSystemMessage`）、捡梗频次统计、表情额度（`emoji-frequency.ts`）。反过来，被模型替代过的确定性判断也不要再塞回去当保险 —— 两套判据打架时没人说得清哪套在起作用。
21. **模型输出只能驱动白名单动作，副作用要有人点头。** 群消息、语音转写都是不可信输入，会被写进提示词；任何「模型输出 → 有副作用的动作」都必须过白名单校验 + 人工确认，不能因为某次提示词写得准就放开。现状：`groupDecision` 只接受白名单字段、群公告必须管理员回复「确认发布」。踢人、禁言、删数据这类破坏性动作不要顺手接进来。
22. **这个仓库是公开的（MIT），写 `docs/` 与代码注释之前先脱敏。** 真实 QQ 号、群号、外部平台 UID、手机号、真实昵称（主人 / 群友 / 别人的 bot 名）、聊天原话，一律不进 git；要举例就写 `123456789`、写「某个群友」「外部 bot」「我们的角色」。统计结论可以留，逐条摘录不行。判定标准：**陌生人看到这句话，能不能顺着它找到某个具体的人或群**。聊天记录整理放 `.data/notes/`（已忽略）。提交前跑 `yarn check:privacy`：它查散文文件里的 5~12 位独立数字和昵称黑名单（名单在 `.data/privacy-denylist.txt`，不在仓库里）；误报加 `scripts/privacy-allowlist.txt`，只加伪造或公开数据。
23. **`scripts/probe-*` 只放能反复跑的诊断工具，一次性实验不要放进 `scripts/`。** 判据是「结论出来以后，还会不会再跑一次」。诊断型（`probe-voice`、`probe-vision`、`probe-snowluma-home`）保留并提交；实验型挪到 `.data/notes/`，结论写进 `docs/`，不要留在 `scripts/` 里假装是工具。命名要如实，一次性脚本带日期后缀（`xxx.2026-11-06.ts`）。`probe-*` 打的是真模型，跑之前先估次数，别在调试循环里反复跑。
24. **两个版本：开发版（仓库 + `启动忆灵空间.bat`）给自己，使用版（镜像 + `docker-compose.prod.yml`）给别人。** 使用版是 `yarn build` 的 `.output` 加 tsx 直跑的 Worker，由 `scripts/launch-prod.mjs` 启动，容器启动时自动 `prisma migrate deploy`。发布走 `node scripts/docker-pack.mjs`，细节见 `docs/使用版打包与分发.md`。
    - 两套**绝不能共用同一个数据库**：两个 Worker 会重复消费同一批任务，两个 OneBot 适配器会重复收发同一条消息；使用版靠独立项目名、容器名、卷名和端口（默认 8801）隔开。
    - 不要给 `docker-compose.prod.yml` 加 `build: .`：那等于在对方机器上编译源码，使用版就退化成开发版。
    - 镜像必须带 `server/`、`scripts/`、`src/generated/prisma` 和完整 `node_modules`（含 `tsx`、`prisma`）；只发 `.output` 会「网页能开、记忆不更新」。
25. **改了 `server/utils/channel-adapter/` 下的代码，必须重启 QQ 适配器才生效**（`yarn onebot:run` 是 `tsx` 长驻进程，不热重载；Nuxt dev 的热更新管不到它）。判断是否生效看 `.data/onebot-adapter.log` 里最新一条 `onebot-connected` 的时间，早于改代码时间就是还在跑旧代码。

26. **桌面退出不能被诊断通道打断。** stdout/stderr 断管不许跳过数据库收尾；Windows 受控子进程需区分默认 Job 终止与显式退出，原进程身份验证、正常停止等待和唯一消费者管理权不能省略。故障记录见 `docs/engineering-lessons.md` 第 7 节。

## 领域状态与硬规则

### 4.1 记忆与检索

**状态**：分层为原始消息 / 忆泡 `MemoryEvent`（事实层，只追加）/ 周期快照 `MemorySnapshot`（版本化）/ 长期记忆 `MemoryItem`（结论层，可替代）。Worker 消费 `GENERATE_SNAPSHOT`、`REGENERATE_SNAPSHOT`、`EXTRACT_EVENTS`、`GENERATE_JOURNAL`。任务租约 5 分钟并续期（`memory-job-lease.ts`），回收在每次领取任务时顺带做（`reclaimExpiredMemoryJobs`）。停滞检测在 `watchdog.ts`（纯函数 + 只读取数），常驻 `yarn watchdog:run`，七类结论 `task_stuck` / `worker_stalled` / `scheduler_stalled` / `snapshot_silent` / `growth_event_worker_stalled` / `growth_event_delivery_stuck` / `growth_event_delivery_failed`。

候选读取与选择是共用模块：`prompt-memory-candidates.ts`（记忆/快照）、`prompt-event-candidates.ts`（忆泡）、`prompt-memory-selection.ts`（预算装配、scope 标签、忆泡 600 字截断、名字刷新）；网页 `chat.post.ts` 与 QQ `pipeline.ts` 都走这三个。相关工具：跨窗口 `cross-channel-context.ts`、原文检索 `message-retrieval.ts`、忆泡选择 `memory-event-retrieval.ts`、调度 `memory-scheduler.ts`。模型自报引用经白名单后写到 `usedSources`（`usedMemoryIds` / `usedSnapshotIds` / `usedEventIds` / `usedRawMessageIds`），回写消息 metadata 与回合详情。

**规则**：

- 检索范围只走 `resolveChatMemoryScopes()`：只放行角色全局范围与当前用户自己的私人范围；未验证外部身份、他人范围与未知类型一律拒绝。写入接口只接受 `scope: character | private`，来源只带 `character` / `private` 标签，提示词不含范围 ID 或用户 ID。
- 查「我的对话」条件里必须带 `channelBindingId: null`；渠道记录只在 QQ 页看，不要为「统一」把它们并回来。
- 删会话是硬删消息，但记忆不能跟着走：`MemoryItem.sourceMessageId` 与 `MemorySnapshotSource.messageId` 都是 `onDelete: SetNull`；接口返回 `memoriesPreserved` / `retainedMemories`；别改成 Cascade 或补删逻辑。
- 重新提炼（历史重放）提出的记忆变化只作审核建议，不自动应用；未验证的模型推断不得当确定事实写进长期记忆。
- 来源证据必须通过当前周期原始消息 ID 白名单校验；模型未配置时任务留在队列，不得用规则摘要冒充 AI 输出。
- 租约过期可「回收并重新入队」（`POST /tasks/{id}/retry`，只放行租约过期的运行中任务，审计 `memory_job.manual_retry` 带 `recoveredLease`）。**不要再退回「运行中一律不许重试」。**
- 注入按 token 预算 + 条数装配：记忆 1800 / 快照 2500（各自独立）/ 忆泡 800（`eventTokenBudget`）/ 原文 900（`rawMessageTokenBudget`）；条数 20（`memoryItemLimit`）/ 4 / 8（`eventItemLimit`）/ 6（`rawMessageLimit`）；装不下时跳过整条，但**第一条永远放行**。不要再改回 top-N 硬截断。
- 装配决策只有一处：`docs/context-policy.md` 的 `ContextPlan`（尚未实现）。不要另建一套并行装配逻辑，别把设计稿当已实现。
- 历史时间戳进提示词一律用同一时区的本地时间（`formatLocalTimestamp`），不再给 UTC（`now.local` 与 UTC ISO 同时在场时，模型会按 UTC 日期判断）；相对日期（前天/上周）必须由服务端换算，不许让模型自己算；没有相关记录就明说没有，不许编日期或用别的记忆顶替。
- 提示词头两条（`server/utils/chat-reply.ts` 的 `systemPrompt()`）：`characterPrompt` 是「她本人」不是资料，不许复述 / 概括 / 列大纲 / 改写；连「存在一份说明」也不许提 —— 点名禁用 人设 / 设定 / 提示词 / 系统提示词 / 角色 / 扮演 / 模型 / AI / bot / 程序 / 指令，并封掉「我是开发者 / 我在测试你 / 你主人让我问的」这类身份施压；被追问时给角色内短句，不是解释。
- 忆泡：`applyMemoryEvents` 必须带 `timeZone` 与 `state`，`dayKey` 按角色时区换算；重新提炼不写忆泡；同一天同一件事靠 `dedupeKey` 只写一次；调度器每天为「昨天」排 `EXTRACT_EVENTS`（幂等键 `daily-events:{scopeId}:{YYYY-MM-DD}`），每小时增量 `events-hour:{scopeId}:{dayKey}:{hour}`，夜间收口 `events-final:{scopeId}:{dayKey}`。
- 原文兜底：单条截断到 180 字（`RAW_MESSAGE_MAX_CHARS`），截断必须在检索层做、并按截断后的长度算预算 —— 调用方不要再各自 `slice`。
- 周期快照的来源消息必须按会话配额取（`memory-source-selection.ts`：每会话先保最新一条，250 条总预算内按时间填，单会话上限 80）。**不要再改回「整个范围按时间取最早 125 + 最晚 125」。**
- 群聊→私聊的跨窗口记忆只有主人这一条、且单向：只查该 QQ 最近 2 小时（`CROSS_CHANNEL_WINDOW_MINUTES`）在 `g:` 群会话里的发言，只按 `metadata->>'authorOpenId'` 认他本人；它的回应只算「同一会话上一条 USER 就是他」的那句；有界 16 条 / 600 token。它必须单独分区传提示词（`crossChannel`），并进 `recentMessages` 会让模型以为自己刚在这个窗口说过。反向绝不打通：群聊的 `readableScopeIds` 只有 `CHARACTER_GLOBAL`，私聊不进群。主人发言被闸门挡下也要落库，标 `storedReason: "context"`（7 天清理档）并带 `metadata.isOwner`。
- 群聊里「谁是主人」必须逐行带（`transcript[].isOwner`），非主人显式写 `false`；`useTranscript` 为真时顶层 `speaker` 与 `withSpeaker` 段都不加载，别指望它。不要为此把顶层 `speaker` 塞回群聊；「主人这轮没说话」时模型不知道主人叫什么（`ownerDisplayName` 只在私聊路径解析），这是已知缺口。
- 主人私聊挂在主人 `USER_PRIVATE` 范围（`ensureOwnerPrivateScope`），跟随全局周期一起排快照；普通群友私聊挂 `EXTERNAL_IDENTITY`、不排快照。**不要再退回「所有私聊一律挂全局 / 一律不排快照」的两种极端。**
- 参与者：`participants` 是显示名、`participantRefs` 是身份引用；群名片这类弱线索必须过校验（解析出的主人名要能在同一窗口找到对应成员），`member_n` 必须和 transcript 里同一个人。跨平台同名不合并。
- 名字/别名只是弱线索：不能强制回复、不能绕过安静时段。

回归：`test:memory-retrieval`、`test:memory-selection`、`test:memory-reach`、`test:memory-budget`、`test:memory-events`、`test:chat-private-memory(-db)`、`test:memory-source-selection`、`test:cross-channel-context`、`test:chat-speaker-context`、`test:chat-conversation-delete-db`、`test:memory-scheduler-db`、`test:private-chat-events-db`、`test:owner-private-scope-db`。排查工具：`yarn probe:memory-reach --character=<id> --query="…" [--memory=<id>]`。

### 4.2 账号与鉴权

**状态**：`sessions` 表只存会话令牌的 SHA-256 哈希；Cookie `yiling_session`（HttpOnly / SameSite=Strict / 生产 Secure）；密码 scrypt；失败写 `login_attempts` 并按用户名与来源地址限流；`User.role` 只有 ADMIN/USER；`/api/admin/*` 走 `requireAdminActor()`；业务接口按会话 `userId` 过滤。本地开发保留受限回退（开发构建 + `YILING_LOCAL_API_ENABLED=true` + 未关闭 `YILING_ALLOW_DEV_OWNER_BYPASS` + 回环 Host），生产构建没有该通道。

**规则**：携带失效 Cookie 时必须重新登录，不能回退成开发身份。所有 `/api` 请求过同源/跨站校验。

未完成：密码重置、注册邮箱验证（都需 SMTP）、渠道断线重连、渠道按外部用户隔离私人记忆、公网加固（HTTPS、反向代理信任、备份演练）。

回归：`test:auth`、`test:auth-db`、`test:auth-flows`、`test:auth-admin-reset`。

### 4.3 QQ 渠道（OneBot v11）

**状态**：唯一通道 `server/utils/channel-adapter/onebot/*`，WS 收消息 + HTTP API 发消息，Token 加密入库。绑定 `routingKey` 存逗号分隔的多个群号；留空或 `"*"` 是默认绑定（收所有群 + 私聊）。群聊档位 `config.groupChatMode`（`mention | ambient | all`，默认 ambient）+ `config.groupChatModes = { "<群号>": 档位 }` 按群覆盖。闸门是纯函数（顺序：静默档 → all 档 → mention 档 → 安静时段 → 日上限 → 最短间隔 → direct → named → 话题候选 → 抽签），不过就整轮丢掉、不落库、不调模型。**mention 档只放 direct**（@ 本人或戳本人），名字与话题续接在那档里只作背景。上下文按「绑定 + 群」缓存 5 分钟 / 40 条；QQ 号入模前换成 `member_n`、@ 她写 `@self`。攒批按 `bindingId + conversationKey`（被 @ 4 秒、`all` 3 秒、其余 12 秒、上限 45 秒）。

**规则**：

- QQ 官方机器人渠道（AppID + AppSecret）已于 2026-10-27 下线，**不要再恢复**。
- 路由：`parseBindingRoutingKeys()` 拆数组做 `includes` 命中；`normalizeRoutingKey()` 同时接受字符串与字符串数组、去重、限 255 字符。**不要再退回「每群绑一条、单值字符串精确匹配」。**
- 私聊必须保留「没有默认绑定但只有一条启用中绑定就用她」的兜底；多条绑定又无默认绑定时返回 null，不许猜。
- 群聊档位必须走 `groupChatForGroup()`（`flushGroupRound` 与 `handleRoutedEvent` 都走），不许再直读 `binding.groupChat`。前端只提交当前群号列表里的覆盖项（`QqCharacterBehavior`）。**不要再退回「@ 走单条、水群走攒批」两套入口。**
- 群消息入口不排队：普通群消息直接进 `handleRoutedEvent`，只有私聊和群指令（`isGroupCommandMessage`）走 `enqueueConversation`；`QUEUE_STALE_MS` 的 `stale_in_queue` 只淘汰群指令。需要串行的是「处理」，不是「登记」。`lastEventAt` 在事件入口统一更新（`touchLastEventAt`，60 秒节流）。
- 静默档（`group-mute.ts`）：群主/管理员/主人 @ 她或叫到名字说「闭嘴」后十分钟不接话，消息仍落库，@ 不解除，只有主人说「可以说了」或到期恢复；闸门里排在 `direct` 之前。
- `all` 档的 `addressedToOthers`：这一批有人 @ 了别的群成员、既没 @ 她也没叫她名字就挡掉。判据只认 at 段（`readOnebotMentionTargets` 的 `self | other | all`）；`@all` 不算 @ 别人、也不算 @ 本人。延续：同一个人刚 @ 过别人、2 分钟内没有 at 段的话仍算在跟那个人讲（`addressedOtherWithin`）。
- 被澄清（`isClarificationMessage`：短句 ≤24 字 + 「没说你/不是说你/别误会/跟你没关系」）且这批 @ 她的话全是澄清时，放行但 `mustReply = false`（`reason: "clarification"`）。长句里「没说你」后面还跟着正事的必须回；戳一戳永不算澄清；`all` 档不受影响。
- 戳一戳是 notice，不是 message：`client.ts` 在 WS 入口用 `resolveOnebotPokeEvent` 翻译成正文 `（戳了戳你）` 的合成消息（`message_id` 也是合成的），`serve.ts` 见 `event.poke` 直接置 `direct`，必须能穿过 mention 档；戳的不是她就丢掉。
- 解模型 JSON 一律走 `parseJsonLoose(text, { expect: "object" })`，**不许裸 `JSON.parse`**（`response_format: json_object` 只是请求不是保证）。
- **不要再退回「群里每句都进模型再逐条回」。**
- 群内归属（`groupMembers`）：群消息自述是硬证据、优先；群名片是弱线索，必须校验后才用，「这张表错一条比少一条更糟」。
- 提示词两条：别人在教/给另一个 bot 打分的那段属于那两个人，不许以被教者身份接、不许替人批改；主语是第三人时她只做传话筒。
- 临时会话：对一个 OneBot 是 `message_type: "private"` + `sub_type: "group"`，**来源群号在 `sender.group_id`，不在顶层**。回复必须带回群号（SnowLuma 见 `group_id > 0` 才走 `sendGroupTempMessage`），再留一次「退回普通私聊」重试，两条都失败把两个 error 一起抛出。`tempGroupId` 要从 `OnebotResolvedEvent` 一路传到 `createReplySender` 的 target，两条发送路径（`sendOnebotPrivateMessage` 第四参数、`sendOnebotCustomFace` 的 `target.tempGroupId`）都要带。TTL 7 天（`TEMP_SESSION_TTL_MS`），别按「几分钟过期」设计。回归测试的事件形状必须照网关真实下发造（`sender: { user_id, nickname, group_id }`，顶层不放 `group_id`）；取回执按 `action` 找、不许取 `messages[0]`。
- 一键启动必须包含「把这个号挂上面板」（`attachQqSession`，`channel-adapter/onebot/autostart.ts`）：`ensureOnebotStack` 的 `already-running` 短路必须同时要求网关端口在听；挑进程只能按 `account.uin` 精确匹配（`pickQqProcess`），多开匹配不到就返回 null，不许猜。顺序是先对齐节点配置、后建会话。
- 限流按绑定配置（`replyWindowMinutes` / `replyLimitPerWindow`，0 = 不限）：滚动窗口只统计本角色在该群的 `ASSISTANT` 消息，达到上限静默、不调模型；群公告不受限。别宣称能协调群里其他账号或执行跨鱼群规。
- 渠道页「这条链路通到哪」（`app/components/QqChannelChain.vue`）的断点按因果挑（`app/utils/qq-channel.ts` 的 `resolveChainRoot`：先网关、再适配器、最后小号；`platform_connections.status` 只有适配器会写）；断点之后一律置灰、全页只允许一个红点。
- 前端渠道入口只有「系统管理 → QQ 渠道」（`app/pages/qq.vue`，只列 `qq-onebot`），**不要再合并回通用「渠道管理」页**（`app/pages/channels.vue` 已删除）。凭据不回显；保存时地址/Token 留空表示沿用旧值（`channels/index.post.ts`），别改成直接覆盖。
- 群公告：草稿 10 分钟有效，`PENDING → PUBLISHING` 原子认领，重复事件不得二次发布；只认群主/管理员；回复「确认发布」才发。踢人、禁言等破坏性动作不要顺手放开。
- 引用与 @ 是两件事（`buildQuoteSegments`，`onebot/serve.ts`；`groupDecision.replyToMessageId` → reply 段、`groupDecision.atMessageId` → at 段）：回最新一条 → 不引用也不 @；接中间夹了别人话的旧句 → 只引用不 @；主动点名 → 只 @ 不引用。**别退回「凡引用必 @」。**「哪条是最新」由代码判（`pickQuoteTarget`）。`replyToMessageId` 只能来自本轮 transcript 的 id（`readGroupDecision` 白名单）；`atMessageId` 号池是「本轮 ∪ groupBackground」；@ 的账号由发送侧按 message id 现查（`groupContext.senderOf`），**不要把 QQ 号塞进 transcript**。引的是她自己的消息就不 @（`selfQq`）。
- 语音条替代正文时只发一个 `record` 段：引用和 @ 都丢掉（`quoteTarget` / `atTarget` 在 `replyVoice` 时一律 `undefined`，提示词也叫模型别填，见 `chat-reply.ts` 的 `withVoiceReply` 段）。别再为加引用或 @ 把这两行改回去，除非协议端/客户端换了。端到端在 `yarn test:onebot`「9.8」段（按 `CI_QUOTE_REPLY` / `CI_AT_REPLY` 哨兵回填后验出站段）；提示词里只有 `member_1` 这类代号。
- 分条发送（`reply-segments.ts` + `createReplySender`）：渠道用 `segmentCapable` 声明能力，声明之后提示词才告诉她「换行 = 另起一条」。① 最多 3 条，超出并回最后一条，不许丢半句；② 引用与 @ 只挂第一条；③ 语音轮次不拆；④ 看着像排版就不拆（列表/编号/标题行首，或某段超过 60 字）—— 这条必须在代码里判。落库仍是一行 ASSISTANT（`metadata.replySegments` 记条数），群限流按轮算；条间留 350~900ms 随机间隔。
- 表情（face 段）：能力由 `ChannelMessageInput.faceCatalog` 声明，清单在 `onebot/faces.ts`；开关 `modelConfig.emojiEnabled` 默认关。**表情必须单独一条消息**，id 只记在 `metadata.faceIds`、绝不进 `content`；别再退回「从 reply 文本里认 `[face]` 占位符」。发送侧要查 OneBot 的 `retcode`（出错时 HTTP 仍是 200）。recentMessages 里给带过图的 ASSISTANT 行加 `hadSticker: true`（`readStoredStickerFlag` 认 stickerId + faceIds），提示词要求「带过图就认领，别否认、也别认领没发过的图」。
- 贴图（表情包）：清单非空时优先贴图、内置表情不再进提示词；两者共用 `emojiEnabled`、同一份额度与「单独一条消息」。清单进提示词前先做减法（剔除上一张、封顶 12、没用过的先上且其余打乱，`pickStickerCatalog`）。**频率靠额度兜，不靠提示词打压**：`modelConfig.emojiWindowMinutes` / `emojiPerWindow`（默认 10 分钟 3 张），按会话分别算，判定在 `server/utils/emoji-frequency.ts`，按 `occurredAt` 回表数、不能复用 `recentStoredMessages`。提示词里不许再写「大多数回复别发表情」。
- 贴图发送优先 `send_custom_face`（`sendOnebotCustomFace`），判据是行上的 `qqEmojiId`（`<QQ号>_0_0_0_<md5>_0_0`；`mface` 段要裸 md5、字段名驼峰 `emojiId`，两者别混）；收藏里没有就退回 image 段（本地文件转 `base64://`）并记日志「收藏表情发送失败，退回图片段」。不要在 `sendOnebotCustomFace` 前把异常吞掉。`qqEmojiId` 必须出现在 `STICKER_CATALOG_SELECT` 并经 `pickStickerCatalog` 带到 `ChannelReplySender` 的 `sticker` 选项（`test-stickers` 有断言锁这一步）。文件名一律服务端生成、只认 `uuid.ext`（`safeFileName`）。发出最大宽度 200（`sticker-image.ts`，只缩不放、只定宽）；gif/webp 必须 `animated: true`。**不要再退回「只能发 QQ 默认表情」。**
- 「什么时候用」那一栏的 AI 建议只回建议、不写库（落库走 PATCH），传输入框里当前的名字；只看名字那条走 `callRawModel`（预算 1200 + 截断翻倍重试；`deepseek-flash` 是思考型模型，给 120 tokens 会思考吃满、HTTP 200 但正文为空），不要自己拼请求；建议逻辑在 `server/utils/sticker-usage.ts`；只看名字那条必须能单独走通（有图才走视觉）；服务端只认 `data:image/` 且限 40 万字符，别把它当上传通道。
- 偷表情包（`sticker-collect.ts`）：开关 `stickerAutoCollect` 默认关；只收群聊图、不收自己发的、一轮最多 1 张；按内容 SHA-256（`contentHash`）去重；泛称名（`GENERIC_NAMES`）与 `{"skip":true}` 都不收；提示词只写「明显不能当表情才 skip，拿不准一律正常起名」。管理页「重新识别」（`POST /api/characters/{id}/stickers/{stickerId}/relabel`）写库并回新 DTO；模型判为截图时不改数据。**不要再退回「只能手动传表情包」。**
- 收藏夹同步（`planStickerSync`）：匹配从严到松（`qqEmojiId` 相等 → `qqMd5` 相等只回填 id、不重新导入 → 都没有才推/导）；**删除一律软删**（`deletedAt`，回收站 30 天，`purge` 才是真删）；拉不到列表 ≠ 全被删（什么都不做并回 `warnings`）；导入不调模型；上限 `MAX_IMPORT_PER_RUN=60` / `MAX_PUSH_PER_RUN=30` / `MAX_NAME_SYNC_PER_RUN=20`，剩余要报出来；`resId` 不是 url，别拿它下载；下载用 `fetch_custom_face_detail` 的 `url`（rkey 有时效），新图入 QQ 用 `add_custom_face`。四个 action 都非 OneBot 标准，必须先判 `retcode`（不认识的 action 回 `retcode: 1404 "unknown action"`，HTTP 仍是 200）。名字以本地为准：PATCH 改名回写 QQ 备注（`modify_custom_face`，失败不阻断本地改名），「重新识别」批量打标后靠同步追平。**不要再退回「表情只有本地一份」。**
- 梗语录（`character_catchphrases`）：与 `styleExamples` 必须分开；**不要再把梗塞回基础人设或对话示例**。挑选 `pickCatchphraseCatalog` 三档（没用过最前、冷却中的垫底但不剔除），冷却 2 小时（`CATCHPHRASE_COOLDOWN_MS`），进提示词打 `justSaid` 标，一次最多 15 条。提示词只写匹配、不写频率。注入点在 `chat.post.ts` 与 `pipeline.ts`，管道自己查库。沉默轮必须吞掉 `usedCatchphraseIds`（`chat-reply.ts`）。不要只加文本框：资料弹窗是 612px 定高 + 四档 `max-height` 断点的精调布局。
- 捡梗（`catchphrase-mine.ts`）：判定靠重复不靠语义（≥3 次、≥2 人、4~60 字、噪声名单）；统计之前必须挡掉系统播报（`looksLikeSystemMessage`）；捡回来一律 `PENDING`，否掉的存 `REJECTED` 不删行；弹窗要给依据（哪个群、几次、几人、原话条数）。主路径人工加（多行、一行一句、一次贴多条、超 20 条拒收）。
- 群看图（`server/utils/image-understanding.ts`）：聊天模型不接受 `image_url`，图必须先进提示词前变成文字，正文里的 `[图片]` 换成 `[图片：<描述>]`；默认关，只认 `data.url`，公网白名单（含 DNS 与重定向后地址），一轮最多 3 张，失败静默降级。**先过群聊闸门再调视觉**；记账 `kind = "vision"`。不要再退回「把图塞进聊天请求」。
- 画图（`server/utils/image-generation.ts`，`docs/image-generation.md`）：她画图 = 聊天模型写 `imagePrompt` → `/v1/images/generations` → 缩到最长边 1280 落 `.data/images/<characterId>/` → **单独一条 `image` 段**（文字先发，图不带引用与 @）。**默认要 `response_format: "b64_json"`，别改回 `url`**：MiniMax 的直链在乌兰察布 OSS 上，2026-11-22 出现过一次 10 秒连接超时（undici Agent 的 `connectTimeout` 默认值），接口 200、钱花了、图取不回来，表现是她「说画好了却什么都没发」；下载只在「服务商无视参数只回 url」或「不认 b64（400）」时才走，且失败重试一次。开关 `imageEnabled` 默认关；`imageChance` 默认 5、冷却 30 分钟、每日 8 张，**被明确要求（`isImageRequested`）时跳过概率与冷却，但每日上限仍然生效**。判定必须窄：排除「画重点 / 画饼 / 漫画 / 动画 / 画风 / 规划」、询问能力（「你会画图吗」不算下单）和否定（「别画了 / 不用画了」）；但**「画 + 动作量词」必须单列一条**（`再画一次试试` / `画一遍` / `画几回`），2026-11-22 就是漏了这条，用户连发两句「再画一次试试」全被判成不是下单，她只顾着答「画好了」；整句只剩 `再画` / `画一下` / `画吧` 时也认。否定词只否定紧贴的动词（`别管我，你画一个` 仍然算）。画图与语音、表情包**互斥**（同一句话不用两种方式说）。凭据是独立一把 `imageApiKey`，**不许与 `visionApiKey`（看图）互相回落** —— 两家几乎必然不是同一家，回落只会换来看不清原因的 401。按张计费、**不写 `model_usages`**，只留 `[image]` 日志。落库只记 `metadata.image.path` 与尺寸，下一轮靠 `hadImage` 带进 recentMessages（否则她会说「我没画过图」）。任何失败都只发文字。
- QQ 空间（`server/utils/channel-adapter/onebot/qzone.ts`，文档 `docs/qq-qzone.md`）：发说说走协议端 `send_qzone_msg`（`sendOnebotQzonePost`，`ugc_right` 1 公开 / 4 好友 / 64 仅自己），评论走网页 `emotion_cgi_re_feeds`（`topicId` = 说说 tid、`hostUin` = 被评论的人、`uin` = 她自己，两个 uin 写反就变成给自己留言）。动态**不能用 `feeds3_html_more`**，改用 `emotion_cgi_msglist_v6?uin=<某人>`（干净 JSON，`tid` / `content` / `created_time` 齐全；域名是 `taotao.qq.com`）。按人查：`listQzoneFriendMoods` 串行、每人 2 条、最多 5 人，第一个 `-3000` 就停；名单优先 `qzoneFriendQqs`，留空退回 `get_friend_list` 前 5 个，必须滤掉设备号（`我的电脑/我的手机/我的Pad`）和她自己。凭证从 `get_cookies { domain: "qzone.qq.com" }` 取，`g_tk` 由 `p_skey` 按 5381 哈希算、每一步都要 `& 0x7fffffff`。①「没有 tid」不等于没发出去，只在明确「动作不存在」（1404/404/不支持）时降级 CGI，其余停手；②确认词与群公告分开（`确认发说说` / `确认评论`）；③评论必须有明确目标（先「看看空间」列编号，进程内缓存 10 分钟、不落库）；④只认主人 QQ、每条人工确认、默认每天 3 条说说 / 8 条评论 / 30 分钟冷却。群友说「发条说说」一律当闲聊。
- QQ 空间主动问（`qzone-proactive.ts`，挂进 `yarn proactive:run`，每 60 秒 `runQzoneAutoTick`）：内容全由她自己定，落 `PENDING` 草稿后私信主人征求同意。触发靠固定时间点（`qzoneAutoAskTimes`，容差 5 分钟、错过不补）+ `qzoneAutoAskDailyMax`（默认 2），**没到点不调模型**。①口语审批只认短词（`isQzoneApprove`/`isQzoneReject`），顺序排在精确确认词之后；②两条 `PENDING` 并存时口语「行」不指定发哪个，让人说清楚、绝不瞎猜；③已有待确认草稿就跳过这轮；④主动问不占 `proactive.ts` 的日上限。拒绝落 `REJECTED_BY_OWNER`。

回归：`test:onebot`、`test:onebot-multigroup`、`test:onebot-panel`、`test:onebot-reply`、`test:reply-segments`、`test:onebot-group-chat`、`test:onebot-group-context`、`test:group-mute`、`test:onebot-announcement`、`test:onebot-faces`、`test:stickers`、`test:sticker-collect`、`test:sticker-image`、`test:qq-sticker-sync`、`test:catchphrases`、`test:system-message`、`test:image-understanding`、`test:voice`、`test:voice-provider`、`test:qzone`、`test:qzone-db`、`test:qq-chain`。真机工具：`yarn probe:qzone`、`yarn probe:custom-face --flow`。

### 4.4 主动找话与群冷场

**状态**：私聊走 `proactive*.ts`（`docs/proactive-messaging.md`），目的池 `proactive_intents` 按 `characterId + dedupeKey` 去重；群冷场走 `group-initiative*.ts` + `group-activity.ts`，两条链同进程各自报错。常驻 `yarn proactive:run`。

**规则**：
- 默认关（`PROACTIVE_DEFAULTS.enabled = false`）。闸门必须先判配置性问题（开关/收件人/额度）再判时间性问题（安静时段/间隔/主人在聊），**先判闸门再调模型**；发出后必须落成一条 `ASSISTANT` 消息。页面「立即试一次」的 `force` 只跳时间类闸门，不跳开关、收件人和额度。
- 收件人取最近一次 `c:` 前缀的 QQ 私聊，不要求用户手填主人 QQ。
- 不要塞进 Web 进程的 `setInterval`。
- 群冷场：「这个群安静了多久」必须查 `group_activities`（绑定 + 群唯一，适配器侧节流 20 秒一次），不能拿 `conversations.lastMessageAt` 代替。
- 「仅被 @ 时回复」的群一律不主动起话题：档位必须走 `groupChatForGroup()`，`force` 也绕不过。
- 一次 tick 只花一次模型调用（按安静时长排序取第一个过闸门的群）；模型输出 `-` 也算一次尝试（写 `lastAttemptAt`）。群里开口不用目的池。提示词三条硬约束不能删：不 @ 任何人、不寒暄开场、想不出就输出 `-`。「立即试一次」会真往群里发一条。

回归：`test:proactive`、`test:proactive-db`、`test:group-initiative`、`test:group-initiative-db`、`test:social-proactive-contact-policy`。

### 4.5 日记与手账

**状态**：`character_journals`（一天一份，`@@unique([memoryScopeId, dayKey])`）+ `journal_revisions`（`kind` = `DIARY` / `HANDBOOK`，版本按 `(journalId, kind)` 递增）。生成走 `GENERATE_JOURNAL`（`journal:{globalScopeId}:{YYYY-MM-DD}`，每天为「昨天」排一次，`maxAttempts=24`）：先生成日记，再把这一版日记正文交给手账摘句，两次调用各自记账（`kind = "journal"`）。

**规则**：同一天两份是独立文本，不能拿日记截断当手账、也不能把手账列表扩写成日记。手账的 `quote` 必须是某一版日记正文里的连续原文（只忽略空白做子串校验；校验失败只丢这一句），并记 `sourceDiaryRevisionId`。来源 ID 必须过输入白名单，编造 ID 整条拒绝。取材只读角色全局 + 角色主人自己的私人范围。**自动任务永不覆盖已有文本**；编辑/重写/恢复都只动指定那一份的新版本并写审计。次日只把前一天手账的 `quote` 注入提示词（字段 `journal`），只在网页对话与主人私聊注入。

回归：`test:journal`、`test:journal-db`、`test:journal-flow-db`。设计见 `docs/journal.md`。

### 4.6 用量与记账

**状态**：`model_usages` 由 `server/utils/model-usage.ts` 写入（kind / model / prompt / completion / total / reasoning / `cacheHitTokens`），埋点在 `chat.post.ts`、`pipeline.ts`、`memory-worker.ts`。额度取 `modelConfig.dailyTokenLimit`（0 = 不限，东八区日界），超额时对话 429、QQ 静默跳过。

**规则**：
- 记账失败只写日志，不许把已经成功的回复变成错误。
- 输入必须分缓存命中/未命中两档（DeepSeek `prompt_cache_hit_tokens`、OpenAI 兼容 `prompt_tokens_details.cached_tokens`），命中价按 `cacheHitInput` 算；按每一行自己的调用时间取价。
- 没有缓存明细的旧行只能按未命中价估，在 `uncachedCalls` 里计数并在页面说明「金额偏高」，不许用平均命中率反推。
- 认不出的模型必须标「未定价」并单独累计 `unpricedTokens`，不许当 0 元、也不许套别的模型的价格。
- 厂商调价用 `.env` 的 `MODEL_PRICING` 覆盖，美元模型用 `USD_CNY_RATE` 折算。

回归：`test:model-usage`、`test:model-pricing`、`test:model-call-logs`、`test:model-turn-detail`。

### 4.7 成长数据中心

**状态**：`GrowthEvent` / `GrowthEventDelivery`，幂等发布、fencing 租约投递、重试、只读记忆来源消费者、Watchdog、30 天终态清理。忆泡与社交经历在真实创建时发布事件。默认本地启动器同时启动共享 Worker，`YILING_WORKER_DISABLED=1` 可关闭。

**规则**：Event Center 不是万能数据表或中央 AI；领域保留数据所有权，用 `Character.id` 统一角色身份；事件只带来源引用与最小 payload，Outbox 与领域写入同事务。知识领域接入仍需分阶段推进。

回归：`test:growth-event-center`、`test:growth-event-center-isolated`、`test:social-relationship-*-isolated`。

### 4.8 前端与框架

**规则**（覆盖 `vue-best-practices` skill，优先级高于该 skill）：
- **禁止引入 Pinia，也禁止模块级 `reactive`/`ref` 单例**（SSR 下会跨请求串号）；跨页面共享状态一律用 Nuxt `useState`，范本 `app/composables/useActiveCharacter.ts` 与 `useAuthSession.ts`。
- 路由走 Nuxt 文件路由与 `app/middleware/*.ts`，动态参数用 `route.params.id`；不要按 `vue-router-best-practices` 的思路新增路由配置文件或额外引入 `vue-router`。
- 数据获取用 `useAsyncData` / `useFetch`；SSR 转发登录态用 `useRequestFetch()`；不要改成客户端 `onMounted` + `$fetch`。
- Element Plus 优先：先查 `el-*`，skill 的手写控件与自定义过渡/弹层只在确实没有对应能力时才考虑。
- 拆分按 skill `SKILL.md` 1.2 的责任边界判（行为是否一起变化、是否共担同一不变量），文件行数只作复查信号；跨文件大范围重构仍要先给方案。
- 与本文档冲突时以本文档为准；不得为迁就 skill 引入新依赖或重搭技术栈。

## 事故与实测记录

按领域记录的事故经过、症状、根因、修复要点与回归测试名，见 [工程教训](docs/engineering-lessons.md)。新增事故写进那份文档，本文件只保留由此产生的硬规则。
