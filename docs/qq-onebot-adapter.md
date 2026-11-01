# QQ 小号（OneBot v11）渠道接入设计

## 1. 背景与定位

yiling-hub 要养的是「QQ 小号挂 AI」——即用一个**个人 QQ 号**（仿真群友 / 好友），
而不是官方机器人号。

这种形态需要走 **OneBot v11 协议**：通过一个挂载在 QQ 客户端里的第三方网关（如
SnowLuma），把 QQ 消息转成 OneBot v11 事件推送给 yiling-hub，yiling-hub 再通过 OneBot
HTTP API 把回复发回 QQ。

本方案是 **QQ 的唯一通道**：官方机器人 `qq` 已于 2026-10-27 下线，相关文件（`qq.ts` /
`serve.ts` / `configure.ts` / `types.ts` / `route.ts`、`yarn channel:run`、
`scripts/mock-qq-gateway.mjs`）全部删除。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 与官方机器人的关系 | **取代**：官方机器人渠道已删除，只保留 `qq-onebot` |
| 平台标识 | **`qq-onebot`**，与已下线的 `qq` 区分，记忆/身份严格隔离 |
| 协议 | OneBot v11，**正向 WebSocket**（yiling-hub 作为 WS 客户端连网关） |
| 网关 | SnowLuma（或任何兼容 OneBot v11 的实现），部署/登录由用户自理 |
| 大脑 | **yiling-hub 自己的模型 + 记忆**（不复用 qq-bridge 的 DSH） |

> 参考项目：`github.com/Derpyu520/qq-bridge`。它用 SnowLuma + OneBot v11 把 QQ 消息桥
> 接给 DSH。yiling-hub 借鉴其「SnowLuma 作 OneBot 网关」的思路，但大脑换成自己的
> `handleChannelMessage` 流水线（角色人格 + 分层记忆 + 跨平台身份绑定）。

## 3. 架构

```
个人 QQ 号（小号）
   │  消息收发（挂在 QQ 客户端进程里的原生 Hook）
   ▼
SnowLuma 网关（用户自行部署、扫码登录 QQ）
   │  OneBot v11 正向 WebSocket（ws://127.0.0.1:3001）
   │  OneBot v11 HTTP API     （http://127.0.0.1:3000）
   ▼
yiling-hub onebot 适配器（channel-adapter/onebot/）
   │  client.ts     —— WS 连接、心跳、事件解析、断线重连
   │  serve.ts      —— 事件 → 通用流水线 handleChannelMessage
   │  configure.ts  —— 从 DB 加载连接（解密 wsUrl / accessToken）
   ▼
通用渠道流水线 pipeline.ts
   ├─ 角色绑定 CharacterChannelBinding
   ├─ 外部身份 ExternalIdentity(platform="qq-onebot", uid=QQ号)  + 身份记忆范围
   ├─ 记忆检索（角色全局 + 本人身份私人记忆）
   └─ 模型回复 → 持久化 → 发回 QQ
```

## 4. 平台标识与记忆隔离

- `platform = "qq-onebot"`，与官方 `qq` 是两个独立平台。
- `ExternalIdentity.platformUid` 用 **QQ 号（user_id）**，而非官方 bot 的 openid。
- `MemoryScope.scopeKey = character:{cid}:external:qq-onebot:{qq号}`，与官方 `qq`、
  B站 `bili` 的记忆天然隔离，互不串味。
- 若同一 QQ 号同时是官方机器人绑定用户 + 小号，仍视为**两个外部身份**，除非管理员
  在「身份管理」里显式验证绑定到同一个 yiling-hub 用户。

## 5. OneBot v11 事件与字段映射

| OneBot v11 事件 | post_type | message_type | 会话 key | 平台 uid |
|-----------------|-----------|--------------|----------|----------|
| 私聊消息 | message | private | `c:<user_id>` | `user_id` |
| 群聊消息 | message | group | `g:<group_id>` | `user_id`（发消息的人） |
| 群临时会话 | message | group | `c:<user_id>` | `user_id` |

其他事件（notice / request / meta_event）默认忽略，仅处理 `post_type === "message"`
且 `message_type` 为 `private` / `group`。

- `externalMessageId` = `message_id`（幂等去重）。
- `externalConversationId` = 上述会话 key。
- `authorPlatformUid` = `user_id`（字符串化），用于 upsert ExternalIdentity。
- `authorDisplayName` = `sender.nickname` / `sender.card`（群名片优先）。

## 6. 消息解析

OneBot v11 的 `message` 字段是**分段数组**（CQ 码），例如：

```json
[
  { "type": "text", "data": { "text": "你好" } },
  { "type": "at",   "data": { "qq": "123456" } },
  { "type": "image", "data": { "url": "http://..." } }
]
```

适配器把文本段拼成 `content`；`at` 段转换为 `@qq号`；`face` 段查内置清单还原成中文名
（`[害羞]`、`[白眼]`），清单外的 id 与语音/视频等仍用通用占位符（`[表情]`/`[语音]`）。
语音/视频不下载；**图片默认也不下载**，正文里只留 `[图片]`。

表情名有意义：对方发「害羞」还是「白眼」，语气完全不同。一律写成 `[表情]` 等于没告诉模型
任何东西。

### 6.1 看图旁路（`image-understanding.ts`，角色级开关、默认关）

`readOnebotImages()` 从 image 段取出 `data.url`，下载后交给视觉模型，拿到 2-4 句中文描述，
再把正文里的 `[图片]` 换成 `[图片：<描述>]`。她要"看见"，靠的是这段文字。

开关在网页「系统管理 → QQ 渠道 → 角色行为 → **看群里的图**」（`modelConfig.imageUnderstanding === true`），
和「发表情」一样是角色级、绑定的所有号共用。默认关：看图必然多一次模型调用，
不能因为部署时配了个环境变量就悄悄开始花钱。

- **只认 `data.url`**：`data.file` 是文件名，不是路径。表情包（sticker）常常没有 `url`，
  那就还是 `[图片]`。
- **`url` 带 rkey、有时效**：收到消息的当口就下载；不要把 url 存库隔天再用。
  拿不到新图时重新拉一次 history 会拿到新 url，但本适配器不需要主动拉 history。
- **白名单**：`url` 是外部输入。协议只允许 http(s)，字面量与 DNS 解析结果都不许落在
  回环/私网/链路本地（含 `169.254.169.254` 这类元数据地址），重定向后的最终地址要再查一遍。
- **限额**：一轮最多 3 张、单张 ≤ 4MB、下载 8 秒、视觉调用 20 秒；失败静默降级回 `[图片]`。
- **只在过闸门之后调视觉**：群聊闸门是零成本的纯函数，被丢掉的那一轮不该为看图花钱。
- **用哪个模型看**：角色 `modelConfig.visionModel` > 环境变量 `VISION_MODEL` > 角色自己的聊天模型；
  Base URL / Key 同理逐级回落（`VISION_BASE_URL`/`VISION_API_KEY` 都是可选的）。
  也就是说**打开开关就能用**，不用再准备第二份凭据；想统一换更便宜的视觉模型时才需要配环境变量。
- 调用记账 `model_usages.kind = "vision"`，与聊天额度同一个日界。

#### 6.1.1 实测：`deepseek-flash` 其实能看图，但仍然默认走旁路

2026-10-29 用 `yarn probe:vision <characterId> --image <png>` 对 `api.deepseek.com` 的
`deepseek-flash` 做了盲测：现场生成随机数字图（模型只能靠"看见"答对），两次分别答对
`3` 与 `0`，猜中概率各 1/10。所以「flash 不能看图」这个说法**在这个端点上不成立** ——
它接受 `image_url`（含 data URL），也确实读到了内容。

不改成直传的原因不是"能不能"，而是"稳不稳"：

- 它是思考模型。同一张 2 字符 OCR 图，`max_tokens=1536`/`4096` 都被思考过程吃光
  （`finish_reason=length`，思考 1500~6200 字），给到 `8192` 时直接 30 秒超时。
  一张图就可能吃掉一轮群聊的预算，甚至回不出话。
- 旁路把视觉这一步限制在「2-4 句、400 tokens 输出」，成本与延迟可预测
  （实测单张 5 秒），并且换成任何纯文本模型都不用改代码。

要直传也可以：把图作为 `image_url` 放进聊天请求，但必须同时给足 `max_tokens`，
并接受偶发超时（超时那一轮应当降级成只看文字）。

## 7. 回复发送

- 私聊 → `send_private_msg`（`user_id`, `message`）。
- 群聊 → `send_group_msg`（`group_id`, `message`）。
- `message` 可以是纯文本，也可以是段数组（`face` / `image` / `at`）。
- 群聊怎么回由绑定配置 `groupChatMode` 决定，连接级 `replyOnlyWhenMentioned` 只作老数据的兜底：
  - `mention`：只把「@ 她 / 叫到 `groupAliases` 里的名字 / 已参与话题的后续」放进判断，不开放无关水群；
  - `ambient`（默认）：被 @ 后跟进 + 自然水群，详见 7.1；
  - `all`：每轮都回，保留老行为（不再有单条快速路径）。
- 群聊统一走一条攒批管道：@ 也要等 `mentionWindowSeconds`（默认 4 秒），换来的是她能看见前几句。
- 私聊总是回复。
- 回复按 OneBot HTTP API 发送（默认 `http://127.0.0.1:3000`），带 `Authorization:
  Bearer <token>` 头（SnowLuma 的 HTTP token 与 WS token 可能不同，分别配置）。
- **发送失败要看 `retcode`**：OneBot v11 出错时 HTTP 仍是 200（被风控、小号下线、群已解散），
  错误只在 body 的 `retcode` 里。只查 `response.ok` 会把「没发出去」记成「发成功」。

### 7.1 群聊上下文与自然接话（`group-chat.ts` / `group-context.ts`）

群聊不是一问一答。她在群里应该像个人：接得上就说一句，接不上就潜水。
所有群消息走**同一条管道**：「短期上下文 → 攒批 → 零成本闸门 → 一次模型判断并生成回复」。
`mention | ambient | all` 只是三种放行策略，不再有「@ 走单条、水群走攒批」两套入口。

1. **短期上下文**（`group-context.ts`，进程内有界，重启丢失是预期降级）：
   按「绑定 + 群」缓存最近 5 分钟、最多 40 条；被闸门丢掉的消息也在里面，作为下一轮背景。
   QQ 号在入模前换成 `member_n`，@ 她写 `@self`、@ 别人写 `@member_n`；昵称只做展示，
   同名不同 QQ 必须是两个成员。回复**发送成功**后才登记话题参与（锚点 + 参与者），
   3 分钟无相关互动过期、最长活 15 分钟；最多 3 个并行话题，满了淘汰最久没互动的。
2. **攒批**：按 `bindingId + conversationKey` 缓冲，被 @ 或叫到名字用 `mentionWindowSeconds`（4 秒），
   `all` 档最多 3 秒，其余用 `batchWindowSeconds`（12 秒）；从第一条起最多等 45 秒。
3. **闸门**（`evaluateGroupChatGate`，纯函数，不花 token，顺序不能改）：
   `all` → `mention` 档只放 direct/named/topic → 安静时段（只挡非 direct）→ 每日上限 →
   最短间隔 → direct → named → 话题候选 → `ambientChance` 抽签。
   只有真实 @（at 段 QQ 是她）与 `all` 档 `mustReply = true`；名字命中、话题候选、抽签
   都允许模型沉默，也不绕过安静时段；群规限流、日上限、最短间隔对 direct 同样生效。
4. **模型决定**：过闸门只是「值得看一眼」。`generateConversationReply` 收
   `transcript`（本轮，带消息 id 与 member）+ `groupBackground`（只看不回）+
   `groupAnchors`（参与过的话题）+ `policy.direct`；一次调用同时返回回复与可选的
   `groupDecision`（relation / 锚点 / 证据 id，全部白名单校验）。
   `action: "silent"` 就什么都不发（usage 照常记账）；只有发送成功才更新话题。

被 @ 的轮次传 `allowSilent: false` —— 点名了还说「不想说」比乱回更糟。
群聊只读角色全局记忆，不拼任何人的 identity scope：一轮里好几个人，谁的私人记忆都不该端出来。
失败与跳过都打一行 `[onebot] 群聊 {"groupId","reason","direct","topics"}`，排查「她为什么没说话」先看这个。

参数都在绑定的 `config` 里：`groupChatMode` / `batchWindowSeconds` / `mentionWindowSeconds` /
`minGapSeconds` / `dailyMax` / `quietStart` / `quietEnd` / `ambientChance` / `groupAliases`。
默认值见 `GROUP_CHAT_DEFAULTS`（自然档：间隔 90 秒、每天 60 句、无关闲聊 15%、23:30-07:30 安静）。
回归测试：`yarn test:onebot-group-chat`（闸门与攒批）、`yarn test:onebot-group-context`（上下文与话题）。

### 7.2 表情

QQ 是唯一支持表情段的渠道。链路：

1. 角色模型设置里打开「QQ 渠道发表情」（`modelConfig.emojiEnabled`，默认关）。
2. 装配提示词时把 `ONEBOT_FACES` 清单作为 `availableFaces` 塞进输入，系统提示词才允许模型返回
   `faces` 字段（最多 1 个 id）。
3. 返回值校验：只认清单内的 id，去重，截断到 1 个 —— 模型偶尔会自己编 id。
4. 发送时**正文一条、表情一条**。拼进正文会卡在句子中间，而且表情发失败不该连累正文。
5. 表情 id 记在消息 `metadata.faceIds`，**不进 `content`**：正文要能原样重放给下一轮模型，
   混进段标记会被当成用户打的字。
6. 冷却：上一条回复带过表情且间隔小于 10 分钟，本轮不再发。否则一个爱发表情的角色会句句贴图。

清单故意不是 QQ 的完整 face 表 —— 菜刀、骷髅、炸弹也在表里，但模型分不清开玩笑和真发火。

### 7.3 群公告（草稿 + 确认）

群管理只开放「群公告」一项，默认关闭；连接设置里勾选「允许群主/管理员让她拟群公告」后才生效。

- 触发：群主/管理员 @ 小号并说「写个群公告：主题」。普通成员、以及网关没给 `sender.role` 的消息一律不触发。
- 拟稿：复用角色模型与人设，输出 500 字以内的公告正文；主题留空时参考最近的群聊。
- 确认：草稿落库为 `onebot_group_announcements`（PENDING，10 分钟有效）。管理员回复「确认发布」（可带 @）后才调用 SnowLuma 的 `_send_group_notice`。
- 幂等：草稿用 `PENDING → PUBLISHING` 原子认领，重复投递的确认事件不会二次发布；同一群再次拟稿会作废旧草稿。
- 审计：成功/失败都写 `audit_logs`（`channel.group_announcement_published` / `channel.group_announcement_failed`），不含 Token。
- 前提：小号必须是该群管理员，否则接口会拒绝。踢人、禁言、全员禁言等破坏性动作不在本期范围。

### 7.4 群发言频率限制

群规要求「单只鱼 5 条消息」时，在「角色在 QQ 上的行为」里设成「每 10 分钟最多回复 4 条」：

- 滚动窗口内，这条鱼在该群最多回复 4 条；第 5 条起直接静默，不调用模型、不发任何提示。
- 时间窗和上限都可配：`CharacterChannelBinding.config.replyWindowMinutes` / `replyLimitPerWindow`，只对该绑定生效；上限 0 = 不限。旧字段 `replyLimitPer10Min` 仍兼容。
- 只统计这条鱼自己的回复（`messages` 里该会话的 `ASSISTANT` 消息），无法协调群里其他系统或账号的发言。
- 群公告的拟稿/确认不受此限制，因为那是管理员显式操作。

### 7.5 群聊触发 B站 值班

在连接设置里填「主人 QQ 号」「主人称呼」，并在「角色在 QQ 上的行为」里给这个角色打开「刷一轮 B站」后，主人可以在群里 @ 她说：

> 去刷一轮 B站

- **只认主人 QQ**：其他群友发同一句话会被直接忽略，不进入普通聊天。
- 角色必须已在「B站 值班台」绑定账号；没有绑定时会回复提示。
- 执行的是与值班台「跑一轮」相同的 `runDutyRound`：当天额度、模型、bili CLI、评论/收藏/动态等设置全部照常生效。
- 先回一句「收到，我去刷一轮」，再在后台跑；同一角色不会并发跑两轮，刷完在群里报结果。
- 默认关闭；主人 QQ 留空时指令不生效。它不会因为群友说“刷B站”就执行。
- 主人称呼会作为对话上下文写进提示词（只传称呼，不传 QQ 号），让她认得出主人；留空时回退到外部身份/当前群名片。

## 8. 配置字段（存储于 PlatformConnection）

平台标识：`qq-onebot`。`credentialsCiphertext` 内加密 JSON：

```json
{
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3002",
  "accessToken": "ws-token",
  "httpToken": "http-token",
  "replyOnlyWhenMentioned": true
}
```

- `accessToken`：WS 鉴权。Node 内置的 WebSocket 不支持自定义握手头，所以拼成 `?access_token=`
  查询参数（SnowLuma 对 `Authorization: Bearer` 与查询参数都认）。
- `httpToken`：HTTP API 鉴权（SnowLuma 的 HTTP token 与 WS token 是**不同值**）。
- 环境变量兜底：`ONEBOT_WS_URL` / `ONEBOT_HTTP_URL` / `ONEBOT_TOKEN`。

## 9. 断线重连与状态

- 客户端维护 WS 心跳（OneBot v11 无标准心跳，SnowLuma 靠 WS 层 + 定时
  `get_status` 探活；适配器每 30s 探活一次，失败即重连）。
- 重连指数退避（1s/2s/4s…上限 30s）。
- 连接状态回写 `PlatformConnection.status`：`CONNECTED` / `ERROR` / `DISCONNECTED`。

## 10. 与 qq-bridge 的差异

| 维度 | qq-bridge | yiling-hub onebot |
|------|-----------|-------------------|
| 大脑 | DSH agent | yiling-hub 角色 + 分层记忆 |
| 会话模型 | 每个 QQ 会话一个 DSH 会话 | 每个 externalConversationId 一条 Conversation |
| 记忆 | DSH 自身 | MemoryItem / MemorySnapshot，按身份范围隔离 |
| 工具 | MCP（发消息/搜网） | 复用 yiling-hub 通用流水线（暂无 MCP 工具） |
| 身份 | QQ 号 | ExternalIdentity + 跨平台绑定（可汇聚到同一用户） |

## 11. 分阶段

- **M1（本次）**：OneBot v11 协议层 + 配置加载 + 消息处理 + runner + mock 测试。
- **M2（已完成，2026-10-29；2026-10-30 合并为一条管道）**：群聊自然接话 —— 攒批 + 零成本闸门 + 模型 `silent`，
  @ 与水群共用同一条上下文管道（提到名字只是弱线索），见 7.1。没有做 qq-bridge 那种 agent 工具循环（每轮多几次工具调用，token 是单轮的几倍）。
- **M3（部分完成，2026-10-29）**：图片识别已接（6.1「看图旁路」，默认关，需要配视觉模型）。
  语音仍未做：`[语音]` 仍是占位符，转写要另接 ASR，且 QQ 语音文件名与直链的时效性同样需要验证。
