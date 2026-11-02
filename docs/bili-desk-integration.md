# bili-desk 迁移进 yiling-space 方案

> **状态：方案已落地，迁移脚本已移除。** B站 现在由 `run-bili-adapter.ts` 驱动，记忆直接存进
> yiling-space 的长期记忆 / 快照 / 会话，不再使用 bili-desk 那套 `human-world.md`、`seen.md` 文件级记忆。
> 本文保留作为设计记录，第 8 节的迁移脚本已删除。

> 目标：把 bili-desk（AI 角色刷 B站 的后台）的**全部能力**搬进 yiling-space，之后删除 bili-desk。
> 定位：yiling-space 是「基于记忆的多角色 AI 后台」，B站是其第三个渠道（QQ 已实现、微信规划中）。
> 核心价值：**让 B站 AI 角色读/写 yiling-space 的记忆系统（长期记忆 + 快照 + 会话），不再用 bili-desk
> 的 human-world.md / seen.md 这些文件级朴素记忆。**

## 1. 现状盘点（bili-desk 有什么）

bili-desk（同一个作者的旧项目，现已退役）分两层能力：

| 层 | 模块 | 文件 | 搬迁去向 |
| --- | --- | --- | --- |
| 通用控制台 | 命令目录（8 组，bili-cli 命令 + 参数 + 写操作标记） | `backend/app/catalog.py` | 迁移为 TS 常量 `catalog.ts` |
| 通用控制台 | bili CLI 执行器（跨进程调用） | `backend/app/runner.py` + `subproc.py` + `netenv.py` | 迁移为 `runner.ts`（Node `child_process`） |
| 通用控制台 | 扫码登录 | `main.py /api/login` + `media.py` 二维码 | 迁移为 B站渠道登录接口 |
| 通用控制台 | 数据目录/备份/换人 | `profile.py` + `paths.py` | 复用 yiling-space 的备份机制（PostgreSQL dump） |
| 通用控制台 | 图片代理（封面/本地图/远程图） | `media.py` | 迁移为只读代理接口 |
| 自动值班 | 值班章程（步骤 + 规矩） | `duty/duty.md` | 迁移为提示词模板 `duty-prompt.ts` |
| 自动值班 | 谷时调度器 | `agent.py scheduler_loop` | 迁移为记忆 Worker 式调度 |
| 自动值班 | 判重表（seen.md） | `agent.py seen()` | 迁移为数据库表 `BiliSeenVideo` |
| 自动值班 | 人格札记（human-world.md） | `agent.py journal_*` | **替换为长期记忆 + 快照** |
| 自动值班 | 报告（out/<date>.md） | `agent.py report()` | 迁移为数据库表 `BiliRoundReport` |
| 自动值班 | 人设（AGENTS.md） | `settings.py` | **替换为角色 basePrompt** |

## 2. 核心思路：换大脑，留手

bili-desk 的「大脑」是 headless dsh 会话，读 AGENTS.md（人设）+ duty.md（章程）+ human-world.md
（札记）+ seen.md（判重），用 bili 命令刷视频。这套「大脑」与 yiling-space 高度重叠，且 yiling-space
更强（版本化、来源追溯、身份隔离、审计）。

**决策：**

- **留** bili-desk 的「手」：bili CLI 执行器 + 命令目录 + 值班章程（这些是 B站 专属的，yiling-space 没有）。
- **换** bili-desk 的「大脑/记忆/闹钟」：
  - AGENTS.md 人设 → 角色 `basePrompt`
  - human-world.md 札记 → 长期记忆 + 周期快照
  - seen.md 判重 → `BiliSeenVideo` 表
  - out/ 报告 → `BiliRoundReport` 表
  - headless dsh 会话 → yiling-space 的模型调用（`chat-reply` + 角色模型配置）
  - APScheduler → yiling-space 的持久化调度（复用 memory-scheduler / memory-worker 模式）

## 3. 落地结构

`server/utils/channel-adapter/` 下新增 `bili/` 子目录（与 `qq.ts` 并列）：

```
channel-adapter/
  qq.ts                      # 已有
  bili/
    types.ts                 # BILI_PLATFORM="bili"、消息/事件/读取函数
    catalog.ts               # 命令目录（从 catalog.py 迁移，8 组命令）
    runner.ts                # runBili(argv)：跨进程调 bili CLI
    duty-prompt.ts           # 值班章程提示词模板（从 duty.md 迁移）
    llm.ts                   # 值班专用模型调用（裸文本，不套聊天的 JSON 契约）
    duty-pipeline.ts         # 主动值班流水线（刷一轮）
    duty-scheduler.ts        # 谷时窗口调度（复用 MemoryJob 队列模式）
    serve.ts                 # createBiliMessageHandler：被动回复 → 通用 pipeline
    configure.ts             # loadBiliConnections（复用 loadQqConnections 模式）
```

新增脚本（对齐现有 `onebot:run`）：

- `yarn bili:run` → `scripts/run-bili-adapter.ts`（长驻：调度 + 被动回复）
- `yarn bili:scheduler:run` / `--watch`
- `yarn bili:worker:run` / `--watch`（如果值班任务走独立 Worker）

## 4. 数据模型改动（Prisma）

复用已有 `PlatformConnection`（platform="bili"）与 `CharacterChannelBinding`。B站连接配置
（数据目录、bili 可执行文件路径、perDay/keywords/zone 等值班设置）写入 `metadata` JSON，
B站凭证沿用 `%APPDATA%\bili-cli\credential.json`（不随代码走）。

### 4.0 bili CLI 独立安装（不依赖 bili-desk）

bili 命令来自 PyPI 的 `bili-agent` 包（github.com/kukemc/bili-cli，MIT）。它不随代码走，
需要装进项目自己的 `.venv`（已加入 `.gitignore`）。换台机器重建环境：

```bash
# 用 uv（或用 pip 亦可）装进项目 .venv
uv venv .venv --python 3.13
uv pip install --python .venv/Scripts/python.exe "bili-agent==0.6.0"

# 验证
.venv/Scripts/bili.exe --version   # {"ok": true, "data": {"version": "0.6.0"}}
```

`runner.ts` 的 `resolveBiliBin()` 查找顺序：`BILI_BIN` 环境变量 → 项目 `.venv/Scripts/bili.exe`
（Windows）→ PATH 里的 `bili`。

**代理残留坑**：机器上残留死代理（如 `http_proxy=http://127.0.0.1:62614`，代理软件已关但变量还在）
会让 bili 撞上 `ProxyError: 502 Bad Gateway`。`runner.ts` 起子进程前会发 CONNECT 探针
（连 `api.bilibili.com:443`），代理连不上上游就摘掉代理变量改直连——对齐 bili-desk 的 `netenv.py`。

新增两张 B站专属表：

```prisma
model BiliRoundReport {
  id          String   @id @default(uuid()) @db.Uuid
  bindingId   String   @db.Uuid
  day         String   @db.VarChar(10)
  roundIndex  Int
  pickedCount Int      @default(0)
  content     String   @db.Text
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  binding     CharacterChannelBinding @relation(fields: [bindingId], references: [id], onDelete: Cascade)
  @@unique([bindingId, day, roundIndex])
  @@map("bili_round_reports")
}

model BiliSeenVideo {
  id        String   @id @default(uuid()) @db.Uuid
  bindingId String   @db.Uuid
  bvid      String   @db.VarChar(32)
  title     String?  @db.VarChar(255)
  author    String?  @db.VarChar(120)
  result    String   @db.VarChar(20)
  reason    String?  @db.Text
  seenAt    DateTime @default(now()) @db.Timestamptz(6)
  binding   CharacterChannelBinding @relation(fields: [bindingId], references: [id], onDelete: Cascade)
  @@unique([bindingId, bvid])
  @@index([bindingId, seenAt])
  @@map("bili_seen_videos")
}
```

## 5. 两条流水线

### 5.1 主动值班（核心新增）

谷时窗口触发 → 「刷一轮」：

1. 读判重表（`BiliSeenVideo`，7 天内看过的不再挑）。
2. 找候选：`bili feed recommend` / `bili hot rank` / `bili search video`（≤25 条）。
3. 看懂候选：`bili video watch --comments --frames`。
4. 判断：结合角色 `basePrompt` + 检索到的长期记忆/快照，决定是否值得。
5. 收尾：
   - 报告写 `BiliRoundReport`（`### BV号` 段落）。
   - 判重写 `BiliSeenVideo`。
   - 私信：默认 `bili dm send owner --file <tmp>`（收件人 = 值班设置里的「主人」）。
     值班设置里可以把收件人换成指定 UID（`dmTargetUid`），对方没聊过 / 非互关时要开
     「允许给陌生人发第一条私信」才会带 `--allow-new`，否则 CLI 直接拒发。
   - 公开评论（仅开启）：`bili comment post --file <tmp>`。
   - **人格札记 → 追加为角色长期记忆**（这就是"B站 AI 有记忆"的落点）。
6. 所有动作持久化 + 审计。

### 5.2 被动回复（复用通用 pipeline）

私信/评论/@ 事件 → `createBiliMessageHandler` → `routeEventToBinding` → 复用
`handleChannelMessage`（去重 → 绑角色 → 记忆检索 → 模型回复 → 持久化 → 回发）。
与 QQ 差异仅在事件类型与 `sendReply`（调 `bili dm send` / `bili comment post`）。

## 6. 值班实现方式（关键决策）

- **A. 工具循环（tool-calling）**：提示词注入 bili 命令目录，模型在循环里自主决定调哪个 bili 命令、
  解析返回、再决定下一步。忠实还原 bili-desk 的「headless dsh 自主刷」，最灵活。
- **B. 脚本化流程**：把「刷一轮」固定为步骤，只在「判断值不值得」时调模型。更可控、省 token。

**建议：先 B 后 A。** Phase 1 用 B 跑通端到端（风险低、可验收），Phase 2 升级到 A。

## 7. 分阶段计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1 | `runner.ts` + `catalog.ts`：Node 调 bili CLI（只读命令先行） | `yarn test:bili-runner` |
| M2 | Prisma 迁移（BiliRoundReport / BiliSeenVideo）+ 连接配置读写 | `yarn test:bili-db` |
| M3 | 主动值班流水线（脚本化）+ 谷时调度（Scheduler/Worker） | 端到端刷一轮，报告/判重/记忆入库 |
| M4 | 被动回复（私信/评论 → 通用 pipeline） | `yarn test:bili-channel` |
| M5 | 工具循环升级（可选）+ 前端「渠道管理 → B站」+ 值班面板 | 全流程可验收 |
| M6 | 迁移 bili-desk 的 data/（config/seen/out/workspace）→ yiling-space 数据库；**删除 bili-desk** | 数据不丢，旧项目下线 |

## 8. 迁移数据（删除 bili-desk 前必做）

bili-desk 的 `data/`（config.json / seen.md / out/ / workspace/AGENTS.md / human-world.md）里
是你已经积累的 AI 人格和历史。删除前需迁移：

- `workspace/AGENTS.md` → 对应角色的 `basePrompt`。
- `human-world.md` 札记 → 长期记忆条目（标注迁移来源）。
- `seen.md` 判重表 → `BiliSeenVideo`。
- `out/*.md` 报告 → `BiliRoundReport`（或归档为文件保留）。
- `config.json` 值班设置 → 连接的 `metadata`。

迁移脚本 `scripts/import-bili-desk.ts` 已移除。它从未产出过数据——库里没有带 bili-desk 标记的记忆，
`BiliSeenVideo` 最早的记录也晚于适配器上线时间，说明那次迁移没有落库任何东西；而 B站 现在直接走
yiling-space 自己的长期记忆，不需要再从旧项目搬。下面的内容保留，作为当时的设计记录。

## 9. 风险与约束

- **bili CLI 依赖**：需本机装 bili-cli 与凭证；Node 调 bili 是跨进程调用，Windows 需隐藏控制台窗口
  （对应 bili-desk 的 `CREATE_NO_WINDOW` / `SW_HIDE`）。
- **中文路径 / libcurl 证书**：需设 `CURL_CA_BUNDLE`（bili-desk README 已注明）。
- **合规与风控**：写操作默认 `--dry-run`，评论/私信限流，`risk_control`/`captcha_required` 立即停手。
- **主人是 CLI 的配置**：`bili owner set` 写进 bili CLI 自己的 dataHome（跟登录凭证同目录），不入库。
  值班台的「主人」段每次打开都现读（`owner show`）；换号登录后要重设，否则 `dm send owner`
  和 `comment post --at owner` 还认上一个人。多账号时命令必须带对配置目录，否则会读到别人的 owner。

  ⚠️ 配置目录的开关是 **`BILI_CLI_HOME`**（`bili_cli/config.py` 的 `home()`），
  `BILI_DESK_HOME` 是 bili-desk 时代的老名字，v0.6.0 完全不认（实测设了照样读
  `%APPDATA%\bili-cli`）。连接里的 `metadata.dataHome` 现在两个变量都传，值相同。
- **安全**：B站凭证不随代码走、不入 Git；写接口走服务端鉴权（`requireAdminActor`）。
- **范围**：一次只做用户要求的一个阶段（CLAUDE.md 第 12 条），不擅自扩大。

## 10. 待确认

- [ ] 值班实现：先脚本化（B）还是直接工具循环（A）？建议先 B。
- [ ] 迁移 bili-desk 现有 `data/` 里的历史（人设/札记/判重/报告），还是从零开始？
- [ ] 值班任务是否复用现有 `MemoryJob` 队列，还是新增独立的 `BiliJob` 队列？

## 11. 实现状态（2026-10-27）

脚本化流水线（方案 B）已补齐第 5.1 节列的全部步骤。此前只有「找候选 → 逐条判标题 → 写报告」，
缺「看懂」「投递」，且调度与被动回复都是断的。

### 11.1 一轮的实际步骤

| 步骤 | 实现 | 说明 |
| --- | --- | --- |
| 读判重 + 额度 | ✅ | 7 天内看过的不再进来；额度按自然日算 |
| 找候选 | ✅ | `feed recommend` + `hot rank` + `search video --order new`，去重后最多 25 条 |
| 粗筛 | ✅ | 把标题/简介/推荐理由/播放量交给模型，返回 BV 数组，最多 `min(5, 剩余额度+2)` 条 |
| 看懂 | ✅ | 对入选的逐条 `video watch --comments 5 --max-chars 1200 --frames <设置>` |
| 终判 | ✅ | 基于看懂的正文判「值得/跳过」，同时产出理由与一句评论 |
| 投递 | ✅ | 私信汇总成一条 `dm send owner --file`；评论 `comment post <BV> --file --at` |
| 对外动作 | ✅ | 分数够就 `video fav <BV>`；开了发动态就 `dynamic post --file`（见 11.3） |
| 收尾 | ✅ | 报告（`### BV` + `分数：N`）、判重表（含 score）、人格札记（长期记忆） |

**为什么两级筛**：`video watch` 会拉字幕、可能触发语音转写，是整条链路最贵的操作
（单条最慢几十分钟）。先用列表元数据粗筛，只对入选的付出 watch 的代价。

### 11.2 踩过的坑（都已修）

1. **UP 主名字恒为空** —— 列表命令返回的 `author` 是**对象** `{mid, name}`，不是字符串；
   `typeof author === "string"` 永远 false。而 `video watch` 用的是 `owner: {mid, name}`。
   现在统一走 `cards.ts` 的 `readAuthor()`，字符串/对象/`uname`/嵌套都认。
2. **`search video --order pubdate` 是非法参数** —— 合法值只有
   `default / views / new / danmaku / favorites / comments`。传非法值 CLI 直接抛
   `invalid_argument`，而旧代码不检查返回码，错误被静默吞掉 → 关键词搜索整条路径全废。
   现已改用 `new`，并且所有命令都过 `readBiliError()`。
3. **`hot rank` 根本没被调用** —— 提示词里写了，脚本里漏了。已补上，这是最稳的来源
   （不依赖账号的推荐画像）。
4. **判词误判** —— 旧实现 `reply.includes("值得")` 会把「不**值得**」判成挑中。
   现改为取最早出现的判词定性，判不出来一律跳过。
5. **谷时窗口每分钟触发一次** —— `refreshState()` 里 `windowsRun` 写死 `[]`，
   而窗口判断恰恰靠它。现在从 `BiliRoundReport.createdAt` 反推窗口标记，重启也不丢。
6. **跨午夜一个夜算两轮** —— 夜间窗口 18:00–09:00 跨自然日，当晚和次日凌晨会各跑一次。
   加了 `windowDayKey()`：凌晨 0–9 点归到前一天。
7. **被动回复字段全错位** —— `dm list` 返回会话卡片（`uid` / `last_message.text` / `from`），
   `feed replies` 返回 `content` / `user.mid` / `on.bvid` / `rpid`，旧代码读的是
   `item.id` / `item.text`，导致每条消息都被当 `missing_fields` 丢掉。
   另外 `{ok,data:{items}}` 的封装要先剥 `data` 再取 `items`。
8. **回复别人的评论用了 `comment post`** —— 那是发新根评论。已改为
   `comment reply <BV> <rpid> [--root]`，才是楼中楼。
9. **粗筛/终判套了聊天的 JSON 封装，整轮变空**（2026-10-28）—— 值班原来复用
   `generateConversationReply`：它强制 `response_format: json_object` 并要求返回
   `{reply, usedMemoryIds, usedSnapshotIds}`，拿不到 `reply` 就抛 `LLM_INVALID_RESPONSE`。
   而粗筛题目要求「只输出一个 BV 数组」，模型照做直接回数组 → 封装解不出 `reply` → 整轮抛错。
   表现是：报告全是「本轮没有挑中的视频」，判重表里每条都是「粗筛没留」，页面看着像「全跳过了」。
   只放人设（2000 字）时侥幸能过，加了刷站口味（system 约 3400 字）后必现 —— 属于「内容一变长就爆」。
   **已拆出 `llm.ts`**：直接打 chat/completions、不带 `response_format`、原样返回裸文本；
   `test:bili-llm` 钉住「裸数组能返回」「不带 response_format」「错误码明确」三件事。
   顺带补上可观测性：`notes`（模型报错、限流、风控）现在跟报告一起落库（`--- 过程记录 ---`），
   `run-round` 接口也会透出，前端在 0 条挑中时直接弹出第一条原因。

10. **思考型模型把 max_tokens 吃光，正文是空的**（2026-10-28，紧接着第 9 条）—— 拆出裸文本调用后
   第一轮又报 `LLM_EMPTY_REPLY`。抓原始响应才看明白：`deepseek-flash` 是思考模型，
   它先产出 `reasoning_content`，而 `max_tokens` 同时管思考和正文。给 800/1024 的预算，
   25 条候选光思考就用满（`finish_reason=length`、`reasoning_tokens=1024`、`content` 为空）。
   实测同一批候选，思考量在 **1500~2200 tokens** 之间浮动（同一模型两次都不一样）。
   现在：粗筛 4096、终判 3072 起步；正文为空且被 `length` 截断时自动翻倍重试一次（上限 8192）；
   仍为空则错误信息里写明 `finish_reason` 和思考 token 数，一眼区分「预算不够」和「内容被过滤」。
   排查入口：`npx tsx scripts/probe-bili-raw.ts`（取最近一轮真实候选，打印 finish_reason /
   reasoning_tokens / content 长度，`BUDGETS=1024,4096` 可换档位）。

### 11.3 对外动作：打分 / 收藏 / 发动态（借鉴 surfcore，2026-10-28）

原来的终判只输出「值得 / 跳过 + 理由」，是个二元判断 —— 挑中的五条之间没有顺序，
也没法回答「今天最值得的是哪一条」。现在补上一条 0-20 的分数，再让分数驱动后面的动作。

| 动作 | 触发条件 | 硬闸 | 落在哪 |
| --- | --- | --- | --- |
| 打分 | 每条走到终判的都打分 | 模型不给就是 `null`，**不当 0** | `bili_seen_videos.score`，报告里 `分数：N` |
| 收藏 | 分数 ≥ `duty.favMinScore`（默认 0 = 关） | 每天最多 2 条；理由少于 6 字不收 | `bili_actions`(kind=`fav`) |
| 发动态 | `duty.autoDynamic` 打开，且当天最高分 ≥ `duty.dynamicMinScore`（默认 15） | 每天 1 条；两条隔 30 分钟；正文要过公开闸 | `bili_actions`(kind=`dynamic`) |

三个判断：

- **分数缺省必须是 `null` 而不是 `0`**。0 分的意思是「差到极点」，会当成当天最低分压掉别的东西；
  「这轮没打分」应该当作没发生。混在一起，收藏和发动态的阈值判定就全乱了。
- **动态正文 = 理由 + 标题 + 链接**，不额外调一次模型（一轮已经 30 次调用）。
  但理由本来是写给主人的私信，发到动态上等于换了一群读者，所以先过 `sanitizePublicText()`：
  去掉 `@` 提及、6 位以上连续数字（QQ 号 / UID）、以及含「主人 / 私信 / 报备 / 额度 / 群友」的整句。
  整段都被挡掉就不发 —— 宁可这一天不发，也不发一条只剩标题和链接的空壳。
- **`bili_actions` 记在库里而不是内存**：每天几次、隔多久这类判定，进程一重启内存计数就归零，
  而账号那边的痕迹删不掉。表按 `(bindingId, day, kind)` 建索引，冲突直接加外键级联。

收藏与发动态都是**默认关**的。理由跟表情开关一样：默认开的话，用户是先看到「她一天发了十条动态」
才去想怎么关。

### 11.4 侧栏菜单：非常用命令默认收起

命令目录 45 条，常用的不到 20 条。`catalog.ts` 给常用项打 `common: true`，
`defaultHiddenBiliItemIds()` 给出默认隐藏集；页面把「隐藏清单 + 版本号」存进 localStorage，
版本对不上（老配置）时把默认集并进去再存一次 —— 否则升级后侧栏毫无变化。

仍然存「隐藏清单」而不是「显示清单」：bili CLI 以后新增的命令默认可见，不用再去勾一次。
菜单管理里留了「恢复默认」，回到常用可见、其余收起的初始布局。

### 11.5 主人内容：优先刷（`duty.ownerFirst`）+ 互动（`owner-watch.ts`）

用户要的「关注主人的 B站、看主人动态、点赞评论收藏投币、私信互动」里，除了「关注」之外
全部落在这里。**「看到」和「动手」拆成两个开关**，因为它们该被分开决定：

| 开关 | 做什么 | 缺省 |
| --- | --- | --- |
| `duty.ownerFirst` | 主人的投稿进候选最前面，她会像刷别的视频一样 watch、写理由、挑中报备 | 关 |
| `duty.ownerWatch` | 对主人的新投稿点赞/收藏/评论/投币，然后私信汇报 | 关 |

只开 `ownerFirst` = 她会看，但什么都不做；只开 `ownerWatch` = 她会动手，但那几条不会
再进值班流（各走各的账，见下）。两个都开就是「看完顺便动了手」。一层都不想丢的人
就两个都开。

#### 11.5.1 主人优先怎么保证的

`collectCandidates` 把 `ownerFirst` 的投稿**先 push**，所以它在候选列表最前面。但顺序
只是「更容易被模型留下」，不是保证。真正的保证在 `mergeOwnerFirst()`：

- 主人的投稿**不管粗筛留没留都进细看队列**，上限 `OWNER_PICK_MAX = 2` 条；
- `watchLimit` 比主人条数还小时，**从模型挑的里挤**，不挤主人的。

上限 2 条是硬性取舍：主人连发六条就把一整轮占满了，她刷到的世界只剩一个人 ——
那是关注，不是刷 B站。

时间窗在 `pickOwnerCandidates()`：只看**最近 30 天**发的（`OWNER_FRESH_DAYS`），一条都没有时
退回最近 3 条并标 `fellBack`。不设窗口的话，主人一年没更新时 `user videos --size 6` 会把
去年的六条全拉进来，她这轮就在「优先看」一堆老视频，看着很像 bug。

另外「7 天内看过的不再进来」由 `seenBvids` 管，和 30 天窗口是两回事：前者防重复，
后者防「把陈年投稿当成这轮刷到的」。

主人投稿的终判也换了问法：原来问「值不值得占主人的注意力」，用在主人自己的视频上
很别扭（模型的自然反应是「跳过」）。现在不问判断，只问「看完想说什么 + 有多喜欢」，
代码里再兜一层 `worth = true`（`isOwnerVideo`）—— 主人发的她肯定看完，模型没有否决权。

和 11.1 的「刷推荐流」是**两条独立的线**，判据正好相反：

| | 刷推荐流（`duty-pipeline.ts`） | 主人互动（`owner-watch.ts`） |
| --- | --- | --- |
| 对象 | 推荐 / 热榜 / 搜索来的候选（可插入主人投稿） | 只有主人一个人 |
| 挑不挑 | 挑，挑不中是常态 | 不挑，主人发的她一定看 |
| 吃不吃值班额度 | 吃 `perDay` | **不吃** —— 今天推荐流挑够了，主人发新视频照样该去看 |
| 开关 | 一直跑 | `duty.ownerWatch`，默认关 |

一轮的顺序：**先主人互动，再看额度**。这样「今天额度已用完」不会连带把主人那边也停掉；
只有模型 token 额度见底（`readDailyQuota().exceeded`）才两条一起停，因为打分要花钱。

#### 11.5.2 两条线各记各的账（别合并）

这是做「优先刷」时踩到的真实冲突：

- `bili_seen_videos` = **值班流看过什么**，值班流会排除 7 天内的记录；
- 如果 `owner-watch` 也往里写，主人的新投稿就会被自己的互动线「吃掉」——
  互动做了，但刷视频那条线再也看不到它，等于没认真看。

所以：`owner-watch` 改用 `bili_actions` 的 `kind = "owner-done"` 判「这条互动走完没」，
`bili_seen_videos` 只留给值班流。反过来，值班流在评论/收藏前会查
`ownerResult.items[].actions`，同一条视频不重复评论、不重复收藏。

#### 11.5.3 主人互动的一轮步骤

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 读主人 | `owner show` | 复用 `parseBiliOwner`，读不到就整条跳过 |
| 读基线 | `bili_actions` 里 `kind=owner-baseline` | 第一次跑只落基线、**不互动** |
| 拉投稿 | `user videos <mid> --order new --size 10` | 复用 `parseVideoCards`（认 `{items}` 包装） |
| 判新 | `pubdate > 基线 && pubdate > now-7d` | 基线管「不碰历史」，7 天窗口管「不补积压」 |
| 查状态 | `video relation <BV>` | 一次拿回 `liked / coins / favorited / following_up` |
| 点赞 | `video like` | 已赞就跳过 |
| 收藏 | `video fav` | 已藏就跳过 |
| 打分评论 | 模型 | 只喂标题/简介/数据，**不 watch**（单条最慢几十分钟） |
| 投币 | `video coin --coins 1` | 分数 ≥ `ownerCoinMinScore` 且当天第 1 个 |
| 评论 | `comment post <BV> --file --at owner` | 正文过 `sanitizePublicText()` |
| 汇报 | `dm send owner` | 只在这一轮真动过手时发，汇总一条 |

**日报里必须落下「主人」这一段的诊断**，哪怕什么都没发生。`reportLevel = brief` 不写过程记录
（`--- 过程记录 ---`），而「怎么没刷到我的视频」恰恰只能从过程记录里看出来 —— 用户面对
「挑中 5 条」的回执，翻不到任何主人的痕迹，只能猜。所以 `runDutyRound` 单独攒一个
`ownerDiag[]`（不进 notes），连同 `ownerResult.status`（`baseline` / `no-fresh` / `all-done` / `done`）
一起写进 `--- 主人 ---` 段，不受日报档位影响。

四条不能随手改的约束：

- **判重以 `video relation` 为准，不是本地表**。赞/币/藏是账号上的真实状态，本地表只用来
  判「这条投稿处理过没」（防止重复评论）。反过来做的话，用户手动点过的赞会被再点一次
  （CLI 会报已赞，但那是靠报错兜，不是设计）。
- **投币每天最多 1 个**（`COIN_PER_DAY`）。CLI 本地限流是每天 5 个，但那是「防止投太多」，
  不是「有多少投多少」—— 实测这台账号硬币余额只有 2 个，硬币是真实消耗且不可退。
- **关注只做健康检查，不做动作**。bili CLI 没有 `user follow` 命令
  （`bili user follow` → `No such command 'follow'`），要代码化只能自己读 `credential.json`
  的 `sessdata` + `bili_jct` 去调 `x/relation/modify`，等于绕开 CLI 的限流与风控保护。
  所以 `following_up` 为 false 时只写一条 note 提醒用户手动点。
- **`--at owner` 而不是昵称**。CLI 的 `--at` 认 `owner` 这个字面量，比传昵称稳
  （昵称改一个字就 @ 不上）。

主人互动会单独写进 `BiliRoundReport` 最前面（`--- 主人的新投稿 ---`），并且**进人格札记** ——
「我今天去看了主人发的《X》，点赞+评论」这条记忆，是后续聊天里问「你看到我发的了吗」
时她答得上来的依据。

### 11.6 已知限制

- **私信粒度是会话级**：`dm list` 只给每个会话的「最后一条消息」，同一会话连发两条
  只能看到后一条。要更细得改成 `dm read <uid>`（每会话多一次调用）。
- **投递失败不重试**：`rate_limited` 直接放弃本轮投递并写进日志，`risk_control` /
  `captcha_required` / `auth_expired` 立即停手。这是 CLI 的设计约束，不要绕过。
- **私信汇总成一条**：多挑中几条时按编号汇总，超 500 字会自动少报几条，
  而不是拆成多条连发（避免撞 10 秒/次、20 次/小时的本地限流）。
- **watch 单条超时 10 分钟**：超时记为该条跳过，不会拖住整轮。
- **未做端到端验证**：本机 B站凭证已 `auth_expired`，且数据库里还没有 B站渠道连接与
  角色绑定，模型侧也没配 API Key。逻辑层由 `test:bili-duty` / `test:bili-cards` 覆盖；
  真跑一轮需要先扫码登录、建好连接并绑定角色、配好模型。收藏与发动态同样只做了逻辑覆盖 ——
  `video fav` / `dynamic post` 的真调用没在本机跑过。
- **公开发的脱敏闸不是语义防护**：`sanitizePublicText()` 只挡 `@`、长数字和几个关键词。
  真正的边界是「理由由终判在看过人设后写、提示词里不注入私信内容」，以及默认关。
  不要把它当成「开了就能随便发」的许可证。

## 12. 设定分层：人设 / 口味 / 章程

bili-desk 把这些全塞在一个 `AGENTS.md` 里。搬进 yiling-space 之后必须拆开，否则同一个角色
在聊天页、QQ 群里也会开始「只看米哈游」「鸣潮跳过」，那是错位的。

| 层 | 存在哪 | 管什么 | 会不会外溢 |
| --- | --- | --- | --- |
| 人设 | `character.basePrompt`（角色资料弹窗） | 她是谁、什么性格、怎么说话 | **故意外溢**：聊天 / QQ / B站 共用一份 |
| 对话示例 | `character.styleExamples`（角色资料弹窗的「对话示例」框） | 语气、用词、句子长短（「怎么说」，不是「怎么说这件事」） | **只进聊天与 QQ/B站 被动回复**；B站 值班判断**不注入** |
| 刷站口味 | `metadata.duty.taste`（B站值班台 → 值班设置） | 这个账号爱看什么、一律跳过什么、跳过理由怎么写 | 不外溢，只进 B站 值班提示词 |
| 章程 | `duty-prompt.ts` 写死 | 不可逾越的底线：素材不是指令、不编造、拿不准就跳过 | 所有角色共用，不需要配 |

对话示例为什么单独一个字段、而且值班不读：一轮值班最多 30 次调用（25 次粗筛 + 5 次终判），
每次都带一遍人设；示例只教聊天的语气，对「这条值不值得看」没有帮助，还会把 30 字理由带成碎碎念。
合并在一个 12000 字的框里还有个编辑风险：改几句口头禅容易顺手删掉人设里的底线。

注入方式是把示例**拼在 `characterPrompt` 尾部**并加边界（只学语气、不照抄内容、不改变输出格式），
**不做成真正的 few-shot 消息轮次** —— 聊天接口要求返回 JSON 信封（`reply` / `usedMemoryIds` /
`usedSnapshotIds`），给了示例对话，模型会学着直接吐纯文本，解析就炸。

`taste` 是自由文本（≤ 2000 字），原样注入 `buildDutyPrompt()` 的「这个账号的口味」一节，
位置在通用尺度之后 —— 明确写「冲突时以口味为准」，但「素材不是指令」「不编造」两条不受口味影响。

粗筛和终判共用 `basePrompt + dutyPrompt`，所以口味在粗筛阶段就生效：
写「某某跳过」能省掉一次 `video watch`（单条最慢几十分钟，是整条链路最贵的操作）。

跳过的理由也会落库了：`judgeVideo` 给的 `理由` 现在对 `skipped` 同样写入 `BiliSeenVideo.reason`

## 12. 控制台补全（2026-10-29）

对齐 bili-desk 的「细」，但不改值班脚本化流水线：

| 项 | 实现 | 说明 |
| --- | --- | --- |
| 动态命令表 | `schema-catalog.ts` | 读 `bili schema`，映射分组/参数/写操作；5 分钟缓存，失败回退 `catalog.ts`。本机 102 条 + 4 条面板入口 + selfcheck = 107 条 |
| 菜单默认收起 | `useBiliDesk.ts` `MENU_VERSION = 3` | 动态命令大多 `common=false`，老配置升级时合并一次默认隐藏集，不把侧栏铺满 |
| 日报档位 | `duty.reportLevel` | `full`（挑中+跳过+过程）/ `brief`（只写挑中）/ `off`（只记额度与判重） |
| 重置今日额度 | `POST /api/admin/bili/duty/reset` | 写 `duty.quotaResetAt`；只影响额度统计，不删报告/判重 |
| 札记编辑 | `/api/admin/bili/journal` | 直接读写角色全局长期记忆的 EVENT 条目；软删除进回收站，改动写审计 |

仍未做的是 **agent 工具循环**（方案 A）：值班仍是固定脚本，模型只负责粗筛与终判。
（此前一律写「跳过」），所以「跳过理由统一写两个字」这类约定能在运行记录里直接看到。
