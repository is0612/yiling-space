# 忆泡待办清单

> 状态：进行中（2026-10-31 建立）
> 约定：按优先级从上往下做；「阻塞」表示依赖上一项完成后才有意义。

## P0 · 分段抽取（已落地，2026-11-01）

**已完成**：按天任务改为**按时间分块 + 每块独立调用 + 每块立即落库**，来源选择放宽到 120×8。实测一晚上 368 条时，全天忆泡从 10 条涨到 25 条，20:00 之后漏掉的那段补出 8 条。细节见 `memory-system.md` 的「分块抽取」。

**仍可优化**：块内还是按时间顺序切，没有按话题/锚点切；一次任务最多 8 块（≈960 条），再多的天会被均匀放大块大小而不是加块数。

**改前的样子（留档）**：来源选择每会话 80 条 / 全天 250 条，进模型前再截 120 条（最早 60 + 最新 60）。一天 3381 条时模型只看到约 3.5%，且大群会把其它会话挤掉。

## P1 · 参与者身份引用（已落地，2026-11-01）

**已完成**：`MemoryEvent.participantRefs`（迁移 20261101050000），从证据消息作者推导 —— `ASSISTANT` → `self`、`isOwner` → `owner`、其余带 `authorOpenId` → `external(platform, externalId)`。历史 55 条用 `yarn backfill:participants --apply` 回填（幂等）。细节见 `memory-system.md` 的「参与者身份引用」。

**仍可做**：`participants`（显示名）与 `participantRefs`（身份）还没有交叉校验 —— 模型写的名字对不上账号时，目前以引用为准、名字照显。

## P1 · 参与者身份引用（原始方案，留档）

**问题**：`MemoryEvent.participants` 是模型抄来的显示名（含 `member_3` 这类代号）。昵称一改就对不上，两个群都叫「群友」会混，查不了「和小明都经历过什么」。

**现状**：只能显示，不能可靠检索到人。

**方案**：加结构化引用，展示层仍用名字。

```json
"participants": [
  { "kind": "self" },
  { "kind": "owner" },
  { "kind": "external", "platform": "qq-onebot", "externalId": "10000006", "displayName": "小明" }
]
```

- 引用**从证据消息的 `authorOpenId` 推导**，不靠模型编；
- `self` = 她自己发的消息，`owner` 看 `isOwner`；
- 历史忆泡从 `sourceMessageId` / 证据消息回填；
- 跨平台同人合并仍必须走验证绑定，**不能靠同名自动合并**。

**代价**：`MemoryEvent` 加列（迁移）、提取时写入、DTO 与前端展示跟着改、历史回填脚本。

**为什么排在 P0 后**：现在一天只抽到 5–6 条，先把「记全」做对，再谈「记准到人」。

## P1 · 按原因分层保留（已落地，2026-11-01）

清理任务现在分两档：`storedReason = "silent"`（她看过但没开口的纯上下文行）保留 **7 天**；`replied` / `mentioned`（证据类）按角色设置的保留天数走。取 `min(7, 角色设置)`，用户数字更小时以用户为准。审计新增 `contextCutoff` / `contextMessages`。

**仍可做**：设置页还没把这条规则写进文案；`contextMessages` 还没有对应的页面展示。

`storedReason` 已经落库（`replied` / `silent` / `mentioned`），但清理仍只有「按天数」一刀切。

- `context`（纯上下文行）：7 天
- `mentioned` / `replied`：30 天
- 忆泡 / 快照：永久

注意：现有角色「小鲸鱼i」的 `rawMessageRetentionDays` 仍是 `null`（永久），新建角色才是 30 天。

## P2 · 快照改读当天忆泡（已落地，2026-11-01）

快照不再从原文重造事件：worker 查出周期内的忆泡（`periodEvents`，≤80 条）当权威时间线，`emitEvents: false`，服务端也不再写忆泡。按天任务成为忆泡的唯一产者。

**已知代价**：某天按天任务完全没跑时，那个周期没有忆泡可读（总结仍有，事实层空），靠 `watchdog` 的 `scheduler_stalled` 兜底。

## P2 · 快照改读当天忆泡（原始方案，留档）

8 天周期快照仍从原文重抽一次，和按天的忆泡是两套逻辑、两套配额。长期应改成「读该周期内已有的忆泡汇总」。

**建议做法**：`GENERATE_SNAPSHOT` 的输入里带上该周期的忆泡（`periodEvents`），prompt 要求「发生什么以忆泡为准、原文只用于提炼偏好与结论」；不再让快照任务顺带产 `events`（否则同一天会被两套规则各写一次）。需要真模型验证，且要处理「周期内某天没跑过按天任务」的补排。

## P2 · 参与者硬过滤 / 取首聚合（已落地，2026-11-01）

`selectEventsForPrompt` 新增两条路：问句里出现「和/跟/与某人…」「某人的事」时按 `participants` 过滤；出现「第一次/首次/头一回」时正序取首。`SelectedEvents.mode` 记录这一轮走的是 range / participant / first / keyword。测试在 `test:memory-events`。

**仍可做**：过滤目前按显示名，还没利用 `participantRefs` 的账号（问 QQ 号查人查不到）；跨平台同名仍不合并。

## P3 · 忆泡来源回写 `usedSources`（已落地，2026-11-01）

模型回复现在要回传 `usedEventIds`，按来源白名单过滤后写进 `usedSources.events`（网页对话）与消息 metadata（QQ 通道）。提示词版本 v21。

## P3 · 忆泡日历增强（搜索已落地，2026-11-01）

`GET /days?q=` 按忆泡标题/详情/参与者搜日子；原文按会话分组也已做。日历视图（月历）仍未做。


- 原文按会话分组（本地对话 / 各 QQ 群分开，现在混在一起）；
- 日期列表加搜索；
- 日历视图（现在只有列表）。

## 验证类（随时可做，最便宜）

- [x] 浏览器实测：`/days`、编辑弹窗、隐藏/恢复、时间线日期头、筛选胶囊（2026-10-31 用户手测通过，未发现问题）；
- [ ] 跑两天真实数据，看每天条数、去重命中率、归属错误率；
- [ ] `test:onebot` 连跑 3–5 次确认偶发已消除。

## 工程债

- **P0 · `test:memory-scheduler-db` 的测试隔离**（2026-11-01 记录）：它直接连开发库、且不清理自己造的 scope / job / conversation，重复跑会在
  「Worker should mark a replay as successful when its snapshot already exists」（第 153 行）偶发失败（`CANCELLED` vs `SUCCEEDED`），
  与当次改动无关 —— `git stash` 掉改动连跑同样偶发。修法方向：每次运行用独立的 schema/库，或在结束时按 suffix 清理自己创建的行；
  在此之前 CI 上这条会时不时红一次，看到时先连跑两遍确认是不是环境污染。
- 忆泡「分层保留」的行为目前只有审计字段（`contextCutoff` / `contextMessages`）间接覆盖，没有「10 天前 silent 行被删」的直接断言 —— 建议在测试隔离修好后补上。
- README / CLAUDE.md 功能清单未同步忆泡相关能力（README 已补忆泡一节）；
- CI 覆盖不全（`verify:local` 35 个脚本，CI 约 23 个）；
- 成本观测：**部分完成**（2026-10-31）——忆泡整理改用 `kind=events` 单独记账，忆泡日历的日详情会显示「整理 N 次 · X tokens」；金额仍看总览页，不在这里重复算价。历史行没有区分标记，所以只有新任务会计入。
