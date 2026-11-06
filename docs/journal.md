# 日记与手账

同一天有两份**独立文本**，共用当天的聊天、忆泡和人设作为素材，但写作方式和内容组织不同：

| 文本 | 回答什么问题 | 写法 |
| --- | --- | --- |
| 日记（DIARY） | 「今天发生的事让我有什么感受？」 | 第一人称叙事，推荐 150–400 字；平淡的一天可以更短，服务端只拒绝空/纯符号/明显重复的占位 |
| 手账（HANDBOOK） | 「今天有什么值得留下来？」 | 结构化记录：短句、列表、可选栏目；每条栏目要带来源证据 |

不能拿日记截断当手账，也不能把手账列表扩写成日记。两份可以有相同的事实，但不重复同一段表达。

## 手账的栏目

- **今日片段**：2–4 条短句，值得收藏的瞬间；不重新罗列当天所有事件。
- **今日想法**：1–2 句，必须有当天经历支撑，不写通用格言。
- **今日一句**：从日记正文里**原样摘取的连续原文**（不改写、不拼接、不加引号），服务端校验。
- **灵感与发现**：当天产生的小发现、想法或灵感，可空。
- **待续事项**：还没结束、想继续关注的事，可空。
- **标签**：1–5 个主题词。

以上都可空；没有值得记录的内容时允许整份 SKIP，不为了填满栏目硬写。手账不是每日总结，也不是第二份忆泡。

**来源证据**：模型必须为每条片段 / 想法 / 灵感 / 待续返回 `evidence`：栏目原文 `text`、真实来源 ID、来源里的连续原文 `quote`。服务端会过滤不存在的 ID、找不到的 quote，以及和来源没有实际内容重叠的栏目；没有证据的栏目直接丢弃，不能拿全局 `sourceMessageIds` 蒙混过关。今日一句不需要 evidence（它只能从日记正文摘）。

## 数据

- `character_journals`：一天一个日期主体（`@@unique([memoryScopeId, dayKey])`）。整天 `status` 只有 `ACTIVE` / `SKIPPED` + `skipReason`；另外 `diaryState` / `handbookState` 各自记录 `PENDING` / `GENERATED` / `SKIPPED`，`diaryDecidedAt` / `handbookDecidedAt` 记录上次做决定的时间。**不能用整天 `status` 判断两份都完成**：一份写了、另一份暂时没内容时，整天仍是 `ACTIVE`。
- `journal_revisions`：完整的版本，`kind` 区分 `DIARY` / `HANDBOOK`，版本号按 `(journalId, kind)` 各自递增（`@@unique([journalId, kind, version])`）。
  - 日记：`title` + `content`。
  - 手账：`content`（片段 / 灵感 / 待续，带 `##` 小标题）+ `thought` + `quote` + `tags`。
  - 手账的 `sourceDiaryRevisionId` 指向「这一句摘自哪一版日记」；日记重写后仍指向当时那一版，可追溯。
- 两份文本的 `sourceMessageIds` / `sourceEventIds` 各自保存；消息被清理后指针保留。

## 生成

- 任务类型 `GENERATE_JOURNAL`，每天为「昨天」（角色时区）排一次。任务显式带 `journalDayKey` / `journalTarget`（`BOTH` / `DIARY` / `HANDBOOK`），Worker 不再从幂等键最后一个冒号后的字段猜日期；旧任务没有这两个字段时才回退解析 `journal:{scope}:{dayKey}[:DIARY|:HANDBOOK][:retry-…]`。
- 取材：角色全局范围 + 角色主人的私人范围（主人 QQ 私聊）；其他用户的私人范围**不读**。按会话配额取，避免一个热闹的群把私聊挤出去。
- **原始消息优先，忆泡兜底**：原始消息被清理后，只要当天还有 ACTIVE 忆泡，仍可以只用忆泡生成；提示词会明确「只剩忆泡，不能编造对话原文」，细节不足的栏目留空或 SKIP。原始消息和忆泡都没有才落 SKIPPED。
- 生成顺序：先生成日记，再把这一版日记正文交给手账生成；手账的「一句」只能从这里摘。两份各自一次模型调用，各自可以 SKIP。
- 缺一份时只补缺的那一份（任务目标带 `DIARY` / `HANDBOOK`）；已有正文或人工编辑过的那份不会被覆盖。两份都缺时才排 `BOTH`。
- **SKIP 按份记录**：某一份模型判断没内容时，只把这一份的 `state` 标 `SKIPPED` 并记 `decidedAt`，整天不会因此变成「两份都完成」。没有新对话时不重复调模型；`decidedAt` 之后这一天又来了新消息，才允许重新评估这一份（幂等键追加 `:retry-{decidedAt}`，同一次决定不会重复排任务）。
- 没有对话/忆泡、或两份都判断没内容 → 日期主体落 `SKIPPED` + 原因，不写空文本。
- 模型没配或额度用完 → 任务留在队列退避重试（`maxAttempts=24`）。单次生成抛错时按 `attemptCount/maxAttempts` 进入 `RETRY_WAIT` 或 `FAILED`；已经成功写入的那一份不会回滚，重试只补缺失的另一份。
- 原始消息清理会等待同一范围、同一截止时间之前的 `GENERATE_SNAPSHOT` / `REGENERATE_SNAPSHOT` / `EXTRACT_EVENTS` / `GENERATE_JOURNAL` 未完成任务；`QUEUED` / `RUNNING` / `RETRY_WAIT` 一律等待，`FAILED` 只等 24 小时宽限期，避免永久失败把原文钉死。清理事务内会锁住 `memory_jobs` 表并再检查一次，插入新任务必须等清理提交，避免「检查完又插进来」的竞态。
- **重写与人工编辑并发**：AI 重写在模型调用期间如果用户保存了编辑/恢复，`persistRevision` 会发现最新版是 `USER_EDITED` / `RESTORED` 且创建时间晚于本次生成开始，于是不落 AI 版本并保留人工版；API 返回 409 并说明原因。auto/manual 本身就不覆盖已有正文。
- 用量记 `model_usages.kind = "journal"`，`metadata.text` 区分 diary / handbook。

## 版本与人工操作

- 编辑：`PATCH /api/characters/{id}/journals/{dayKey}` 带 `kind`，只改那一份，新建 `USER_EDITED` 版本；另一份和旧版本都不动。
- 重写：`POST .../regenerate` 带 `target`（`DIARY` / `HANDBOOK` / `BOTH`），每份各自追加 `AI_REWRITE` 版本。
- 恢复：`POST .../restore` 带 `kind` + `version`，复制成新的 `RESTORED` 版本。
- 历史：`GET .../revisions?kind=DIARY|HANDBOOK`。
- 自动任务永远不会覆盖已有文本；用户触发的生成、编辑、重写、恢复分别写审计：`journal.generated` / `journal.edited` / `journal.regenerated` / `journal.restored`。审计记录与对应版本、当天主体状态在同一个数据库事务里提交：审计失败时版本也回滚，避免接口报错但正文已经改变；后台自动任务没有用户操作者，不伪造 USER 审计。

## 次日注入

网页对话与主人私聊会把**前一天手账里的「一句」**带进提示词（字段 `journal`）；群聊与普通人的私聊不注入，整份日记/手账也不进提示词。提示词（v20）明确写：那句是她自己写的，不是对方说的，也不是关于对方的事实。拆分前的旧数据如果 quote 记在日记版本上，读取时会兜底。

## 页面

侧栏「工作空间 → 日记手账」（`/journal`）：

- 左边按天列表（日记首句、手账那句、两份各自的版本标记），右边两个 tab：日记 / 手账。
- 列表接口返回角色时区、`todayKey`、`yesterdayKey`；页面的「今天/昨天」、默认补写日期和版本时间都按角色时区，不按浏览器时区。
- 每份文本独立「编辑 / 重写 / 历史版本」，另一份不受影响。
- 手账按 `##` 小标题渲染成栏目；想法、一句（含「摘自第 N 版日记」）、标签单独展示。
- 「补写某一天」默认两份都补；哪份缺就补哪份。
- 和「忆泡日历」互相跳转。

## V1 不做

- 私人日记/手账（按每个用户各一份）——目前只有角色全局一本。
- 角色卡导出 / 导入带日记与手账（正文、想法、一句、标签与历史版本），但不带来源消息/忆泡的 id 指针。
- 看门狗暂不检查「日记/手账停了」；任务监控能看 `GENERATE_JOURNAL` 的队列、失败、重试与最后错误，暂不新增独立 finding。
- `diaryState` / `handbookState` 是生成决策状态，详情接口会返回；页面主要按「有没有正文」展示，不把 `PENDING` 当成失败。
- 手账图片/贴纸、分享、公开、统计。

## 测试

- `yarn test:journal`：日记长度/空内容、手账栏目渲染、来源 evidence（真实/假 ID/不匹配/事件来源）、一句必须来自给定日记、日期键、角色时区日历、SKIP。
- `yarn test:journal-db`：两份独立版本、改一份不动另一份、一句追溯、恢复、次日读取、唯一约束、级联删除、调度器、migration 状态回填（隔离 schema）。
- `yarn test:journal-flow-db`：Scheduler → Worker → Service → DB：只有忆泡生成、只缺一份补齐、SKIP 按份记录与新聊天后重评、显式任务参数、旧幂等键兼容、非法任务键失败、清理等待手账、失败重试、并发生成复用、regenerate 与人工编辑并发。
- `yarn test:chat-reply` / `test:chat-speaker-context` / `test:chat-private-memory`：提示词版本与注入边界。
