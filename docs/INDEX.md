# 文档索引

> 最后整理：2026-11-27
> **唯一的功能状态入口是 [忆灵空间 · 功能总表](<忆灵空间 · 功能总表.md>)**，本索引只负责告诉你「哪份该读、哪份只是留档」。
>
> 判断依据：文件自身声明的状态；实施状态以当前 `main` 源码和可复现测试为准。
> 代码与文档不一致时，一律以 `CLAUDE.md` 和源码为准。

## 怎么用这份索引

- 改代码前 → 先看「一、现行规范」。
- 想知道某个功能做到哪了 → 看 [功能总表](<忆灵空间 · 功能总表.md>)，不要看设计文档。
- 「三、历史存档」里的文档不用读，只在追查「当初为什么这么定」时才翻。
- 验收报告是某个提交当时的证据快照，不能当作现状。

---

## 一、现行规范与约定（改代码前必读）

| 文档 | 管什么 |
|---|---|
| [忆灵空间 · 功能总表](<忆灵空间 · 功能总表.md>) | 每个功能的 ✅/🟡/⚪ 状态，唯一状态入口 |
| [memory-system](memory-system.md) | 分层记忆、忆泡、周期快照规则 |
| [data-model](data-model.md) | 逻辑数据模型（可执行结构以 `schema.prisma` 为准） |
| [context-policy](context-policy.md) | 一轮提示词里放什么（ContextPlan，P0 已落地、P1 未开始） |
| [security](security.md) | 权限边界、隐私、密钥处理 |
| [deployment](deployment.md) | 部署、备份、扩展 |
| [local-development-and-data-migration](local-development-and-data-migration.md) | 本地开发、迁移、数据搬迁 |
| [test-organization](test-organization.md) | 测试入口与隔离运行约定 |
| [frontend-api-requests](frontend-api-requests.md) | 前端调业务接口的约定 |
| [engineering-lessons](engineering-lessons.md) | 事故经过与由此产生的硬规则 |
| [development/代码审查与变更验收规范](development/代码审查与变更验收规范.md) | P1/P2/P3 风险分级、审查流程、独立复审与放行标准 |
| [产品定位与跨平台架构原则](<产品定位与跨平台架构原则.md>) | 长期方向；不是已实现清单 |
| [development/PROJECT_PROGRESS](development/PROJECT_PROGRESS.md) | 分批次进度与验收边界 |
| [qq-onebot-adapter](qq-onebot-adapter.md) / [qq-onebot-deploy](qq-onebot-deploy.md) | QQ 渠道接入与部署 |
| [cross-platform-identity](cross-platform-identity.md) | 身份绑定 |

## 二、功能设计（已实现，作设计记录）

功能已经在跑，文档的价值是「为什么这么设计」，改这块时要看。

| 文档 | 功能 |
|---|---|
| [character-card](character-card.md) | 角色卡导出、导入、替换 |
| [desktop-app](desktop-app.md) | 桌面端全部：内嵌 PG、迁移备份、安装包、VC 前置、免登录 |
| [形象档案设计](<形象档案设计.md>) | 视觉身份资料库、参考图与版本 |
| [image-generation](image-generation.md) | 聊天生图链路 |
| [本机生图接口](<本机生图接口.md>) | Anima / ComfyUI 调用方式 |
| [daily-life-and-photography-design](daily-life-and-photography-design.md) | 日常生活与拍照（**仍在做**：自动排程、上下文注入、主动分享未完成） |
| [knowledge-system](knowledge-system.md) | 知识系统与主题治理 |
| [social-relationship-system](social-relationship-system.md) | 好友档案、关系阶段、评估 |
| [growth-data-center-architecture](growth-data-center-architecture.md) | 统一成长数据中心 |
| [interaction-experiences](interaction-experiences.md) | 短期互动经验卡 |
| [expression-habits](expression-habits.md) | 语料与表达习惯 |
| [preference-system](preference-system.md) | 偏好 |
| [goals-and-wishes](goals-and-wishes.md) | 目标与愿望 |
| [self-understanding](self-understanding.md) | 自我认知的证据视图 |
| [journal](journal.md) | 日记与手账 |
| [roleplay](roleplay.md) | 轻量角色扮演 |
| [voice](voice.md) | QQ 语音收发 |
| [proactive-messaging](proactive-messaging.md) | 主动找话 |
| [sticker-qq-sync](sticker-qq-sync.md) | 表情包与 QQ 收藏夹同步 |
| [unified-model-settings](unified-model-settings.md) / [model-purpose-defaults](model-purpose-defaults.md) | 模型设置页与用途默认值 |
| [local-observe](local-observe.md) | 本地观察与执行（仅管理员） |
| [使用版打包与分发](<使用版打包与分发.md>) | 使用版两种运行方式 |
| [growth-read-diagnostics](growth-read-diagnostics.md) | 成长数据读取诊断 |
| [catchphrase-samples](catchphrase-samples.md) | 梗语录模板（可照抄的素材，不是规范） |

**仍在进行中、会持续更新**：[memory-backlog](memory-backlog.md)（忆泡待办）、[real-use-acceptance](real-use-acceptance.md)（真实使用验收）。

## 三、历史存档（已完成 / 已被取代，不用再读）

打开这些文档前先知道：它们记录的是当时的判断，**不是现在的实施依据**。

| 文档 | 为什么归档 |
|---|---|
| [qq-group-context-reply-plan](qq-group-context-reply-plan.md) | 已被 v2 取代，文档自己标了「历史方案」 |
| [qq-group-context-reply-plan-v2](qq-group-context-reply-plan-v2.md) | 2026-11 已落地，现行行为看 `CLAUDE.md` 4.3 |
| [chat-reply-prompt-v75](chat-reply-prompt-v75.md) / [v76](chat-reply-prompt-v76.md) | 提示词版本存档；当前源码是唯一事实来源 |
| [product-and-technical-plan](product-and-technical-plan.md) | V1.2 原始方案留档 |
| [development-phases](development-phases.md) | Phase 0–5 的验收标准，阶段已过 |
| [next-stage-implementation-plan](next-stage-implementation-plan.md) | 2026-11-18 排期，已被推进覆盖 |
| [项目全板块检查与优化交接](<项目全板块检查与优化交接.md>) | 2026-11-05 换机交接（含已移除的 B 站记录） |
| [角色与角色卡优化交接](<角色与角色卡优化交接.md>) | 同上，专项附件 |
| [忆泡设计构想](<忆泡设计构想.md>) | 核心层 2026-11 已落地 |
| [memory-and-growth](memory-and-growth.md) | 2026-11-03 的一段工作总结 |
| [忆灵空间 · 功能介绍](<忆灵空间 · 功能介绍.md>) | 2026-11-01 的能力快照，已落后（见文件头横幅） |
| [桌面化架构评估](<桌面化架构评估.md>) | 阶段一预检，结论已采纳并实施 |
| [桌面端改造方案-内嵌数据库与免登录](<桌面端改造方案-内嵌数据库与免登录.md>) | 方案已基本落地 |
| ~~desktop-postgres-a0 / runtime / database-integration / installer / identity / identity-handoff / vc-runtime~~ | 七份分阶段记录已合并为 [desktop-app](desktop-app.md)，不再单独存在 |
| [assistant-collaboration-plan](assistant-collaboration-plan.md) | 2026-11-11 的调用链盘点与第二批设计，已实现 |

## 四、一次性验收报告（当时证据，不是现状）

| 文档 | 验收对象 |
|---|---|
| [memory-retrieval-acceptance](memory-retrieval-acceptance.md) | 核心记忆检索第一批 |
| [growth-loop-acceptance](growth-loop-acceptance.md) | 反思 / 成长闭环 |
| [growth-consumer-acceptance](growth-consumer-acceptance.md) | 成长数据真实消费者接入 |
| [education-transfer-acceptance](education-transfer-acceptance.md) | 私聊教育跨场景迁移 |
| [stage-2-system-acceptance](stage-2-system-acceptance.md) | 阶段 2 全系统整合 |
| [形象档案统一验收清单](<形象档案统一验收清单.md>) | 形象档案合并 main 后的回归项 |
| [qq-media-fix-acceptance](qq-media-fix-acceptance.md) | QQ 画图与媒体回复修复 |
| [ci-reliability-review-2026-11-19](ci-reliability-review-2026-11-19.md) | 当时的 CI 与可靠性检查 |

## 五、构想与待开发（未排期，别当需求）

| 文档 | 状态 |
|---|---|
| [公共世界与事件记忆设计构想](<公共世界与事件记忆设计构想.md>) | 设计构想，尚未实现 |
| [角色成长功能规划](<角色成长功能规划.md>) | 规划，2026-11-03 建立 |
| [group-expression-learning-plan](group-expression-learning-plan.md) | 待开发；阶段规划不等于获准执行 |
| [dispatched-outreach-plan](dispatched-outreach-plan.md) | 部分实现，卡在 §6 两个决策项 |

---

## 整理结论（2026-11-24）

- 现存 **70 份** Markdown。**没有需要删除的空白或重复文档**，问题是「状态没标清」，不是「文档太多」。
- 真正该先读的只有 **14 份现行规范**；历史存档只在追查设计来源时翻。
- 最该维护的两份是 [功能总表](<忆灵空间 · 功能总表.md>)（功能状态）和 [PROJECT_PROGRESS](development/PROJECT_PROGRESS.md)（批次进度与验收边界）。
- 本轮已把桌面端 7 份分阶段记录合并为 [desktop-app](desktop-app.md)：按主题重组，保留全部决策与坑，514 行压到 330 行。
