# 私聊教育跨场景迁移 · 工程回归验收报告

- 验收日期：2026-11-15
- 分支 / HEAD：`main` / `b4d85f8`（验收开始时与 `origin/main` 同步）
- 检查范围：`30eb939`（迁移主体）、`7d30e61`（重复重试修复 + 渠道策略审核）、`a641c34`（文档）
- 本次性质：只做检查、测试和必要的小修复；不新增功能，未进入下一阶段。

## 1. 数据库

| 检查项 | 结果 |
|---|---|
| `prisma validate` | 通过 |
| `prisma generate` | 通过，产物无 diff（schema 与 client 同步） |
| `prisma migrate status` | 83 个迁移全部应用，`Database schema is up to date` |
| 迁移可重放 | 4 个隔离测试各自在**空库**执行 `migrate deploy` 成功，等同于全链从零重放 |
| 已有数据兼容 | 唯一改动约束的 `20261114101000_education_transfer_source` 是**追加** `EDUCATION_TRANSFER` 分支，`MANUAL` / `SOURCES` / `EXPERIENCE_REFLECT` 三个分支逐字保留；`20261114110000` 的 `chatScope` 用 `NOT NULL DEFAULT 'ALL'` 回填。没有收紧、没有删列，互动经验表未被触碰 |

本次功能在开发库中的实况：互动经验 26 条、互动指导 9 条（全部 `ACTIVE`）+ 18 条版本、表达习惯 4 条（`EDUCATION_TRANSFER` / `ALL` / `ACTIVE`）、渠道策略 0 条、`educationEnabled = true` 的 scope 1 个（false 529 个）。

### 迁移漂移

`prisma migrate diff --from-config-datasource --to-schema` 在验收开始时报告 8 项，其中 2 项由本次功能引入，已在 `20261115100000_education_schema_align` 中修正（仅元数据，不改数据）：

1. `channel_behavior_policies.sourceRefs`：schema 声明了 `@default("[]")`，首版迁移漏写 DB 默认值。补 `SET DEFAULT '[]'`。
2. 互动指导版本表的唯一索引名被 PostgreSQL 截断到 63 字节（`…_revision_ke`），与 Prisma 算出的 `…_revisio_key` 不一致。改名为 Prisma 期望的名字。

修正后 diff 只剩 6 项历史遗留：5 个旧表索引名截断 + `interaction_experience_progress` 一个库里有、schema 里没有的外键。它们与本功能无关，其中外键涉及级联语义（直接删除可能留下孤儿行），因此未在本次处理。

## 2. 专项测试

脚本名以 `package.json` 为准，未拼接不存在的命令。

| 脚本 | 结果 |
|---|---|
| `test:education-transfer`（含 `expression-chat-scope`、`friend-education-permission`、`education-review`） | 通过 |
| `test:education-transfer-isolated` | 通过：SQL / lease、并发去重、owner 候选、采纳、群聊安全读取、驳回持久化 |
| `test:interaction-guidance-isolated` | 通过：并发 worker、PENDING、owner 采纳、上下文与作用域、角色隔离、停用、历史、来源清理独立、驳回证据去重 |
| `test:education-old-evidence-isolated` | 通过：仅旧证据、检查点、不重复调用模型；混合批次保留有效候选；证据不足与错域不产候选 |
| `test:channel-policies-isolated` | 通过：待审 / owner 采纳 / 角色隔离 / 仅 @ 抑制 / 引用保留 / 版本 / 独立重新启用 |
| `test:interaction-guidance`、`test:channel-policies`（附带） | 通过，含页面与提示词断言 |
| `test:expression-habits`、`test:expression-habits-page` | 通过 |

## 3. 静态检查

`yarn typecheck`、`yarn lint`（0 warning）、`yarn run check:sfc`（82 个组件）全部通过；`docs/openapi.yaml` 用 YAML 解析器验过，134 个 path，6 个新接口（互动指导、渠道策略的 list / patch / history）都在。

## 4. 安全边界

| # | 边界 | 结论 | 落点 |
|---|---|---|---|
| 1 | 私聊私人经历不自动迁移到全局 | 成立 | 三条产出路径都写 `PENDING`；`EDUCATION_TRANSFER` 行强制 `conversationId` / `memoryScopeId` 为 NULL，来源只留在 `sourceRefs` |
| 2 | 迁移的是抽象规则而非原文 | 成立 | 入库仅 `content` ≤ 300、`context` ≤ 200 字；正则拦手机号、URL、`@`、`QQ`、`私聊原文`；`reason` 是固定文案；`sourceRefs` 不进提示词 |
| 3 | 候选未经审核不生效 | 成立 | 候选一律 `PENDING`；采纳需 owner + `expectedRevision` CAS；`PENDING → ACTIVE` 时重新校验来源与授权 |
| 4 | 角色之间不泄漏 | 成立 | 所有查询带 `characterId`；接口 `ownerId` 取自会话，域函数再过 `assertPreferenceOwner` / `lockPreferenceOwner` |
| 5 | 群聊只读允许跨场景的规则 | 成立 | 群聊 `chatScene = GROUP` 只取 `ALL` / `GROUP`；`EXPERIENCE_REFLECT` 在 DB 约束与代码里双重排除；原始互动经验只在非群聊注入 |
| 6 | 重复证据不重复计数 | 成立 | 按 `feedbackMessageId` 去重，要求 ≥ 3 条唯一消息且跨 ≥ 2 天；审计按 `(经验 id, revision)` 幂等，同一 revision 不重复计费 |
| 7 | 撤销 / 停用后不再注入 | 成立 | 读取一律 `status = ACTIVE` 且按 `chatScope` 过滤；渠道策略读失败时连 `@` 一起抑制（fail-closed） |
| 8 | 领域助手不越权改正式数据 | 成立 | 只写本领域候选；渠道策略的 `kind` / `content` / `chatScope` 是代码白名单常量，模型无法改写正文 |

设计取舍（非缺陷）：好友撤权只阻止新候选与未采纳候选的启用，**不自动撤销已采纳规则**——已采纳的是主人审核过的抽象规则，文档 `social-relationship-system.md` 已写明。

## 5. 本次修复

1. **新回归没有被任何门禁执行**（真问题）：`30eb939` / `7d30e61` 新增的 7 个测试脚本既不在 `test:unit-suite` 也不在 `verify:local`，而 CI 只跑 `test:unit-suite`。已把 7 个脚本追加到两条链尾，`package.json` 校验通过。
2. **两处 schema 漂移**：新增 `20261115100000_education_schema_align` 修正，已在开发库应用，并在空库重放验证。

## 6. 遗留问题

- 6 项历史迁移漂移（旧模块），本次不动。
- `pg` 的 `client.query() while already executing` 弃用告警：来自 `@prisma/adapter-pg` 内部实现（交互式事务），不是本仓库代码，无法在应用层修。
- 撤权不回收已采纳规则：按设计保留，若产品要求变更需单独立项。

## 7. 结论

- **工程测试通过**：7 组专项测试全绿，含 4 组在一次性空库上跑完整迁移链。
- **静态检查通过**：类型、Lint、组件编译、OpenAPI 解析全绿。
- **真实私聊 / 群聊行为尚未验收**：本次未接真实 QQ。`@` 抑制、群聊读规则、以及「该提才提」的判断仍只在 mock 与 SQL 层验证过，需人工在真实会话里确认。

工程条件具备，可进入下一阶段；真机验收建议在进入前完成。
