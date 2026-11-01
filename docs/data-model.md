# 数据模型设计（逻辑模型草案）

本文定义概念和约束，后续以 `prisma/schema.prisma` 与已提交的 migration 为可执行数据库结构的唯一依据。不要仅凭本文件直接声称数据库已经实现。

## 1. 核心实体

| 实体 | 职责 | 关键约束 |
|---|---|---|
| users | 管理员/内部用户身份 | 账号标识唯一；仅保存必要信息 |
| characters | 角色实例、人设、模型配置 | 必须有关联所有者或明确的单管理员所有权 |
| platform_connections | 外部平台连接实例 | 凭据只能加密或存放于安全凭据系统 |
| character_channel_bindings | 角色与连接的多对多绑定 | 同一绑定不可重复 |
| external_identities | 外部平台账号映射 | 平台 + 外部 UID 唯一；跨平台合并需验证 |
| conversations | 一段角色与用户/渠道会话 | 明确角色、记忆范围和渠道上下文 |
| messages | 原始消息和标准化事件 | 来源消息需要幂等去重；记录发生时间 |
| memory_scopes | 角色全局或用户私人范围 | `scope_key` 唯一 |
| memory_items | 长期记忆条目 | 应保留状态、有效期、置信度和来源 |
| memory_snapshots | 周期或手动快照的版本 | 周期范围清晰；逻辑快照版本不重复 |
| memory_snapshot_sources | 快照与来源的多对多关系 | 来源关系可追溯 |
| memory_reviews | 人对审核建议的处置结果 | `(snapshot_id, change_index)` 唯一；不回写快照正文 |
| character_memory_settings | 默认与角色级周期设置 | 生效周期与待生效周期分开保存；时区合法；原始消息清理须显式启用 |
| memory_jobs | 持久化后台任务 | `idempotency_key` 唯一 |
| onebot_group_announcements | QQ 群公告草稿与发布状态 | 草稿有有效期；`PENDING → PUBLISHING` 原子认领，避免重复发布 |
| audit_logs | 关键管理操作审计 | 不写入密钥或不必要的敏感正文 |

## 2. 关系概览

- 一个角色拥有多个会话、记忆范围和渠道绑定。
- 一个渠道连接可通过绑定关系对应一个或多个角色。
- 一个会话属于一个角色，并有明确的记忆范围。
- 消息属于会话，可作为快照/长期记忆的来源。
- 一个记忆范围有多条长期记忆、多个逻辑快照和多个后台任务。
- 一个逻辑快照有多个版本；每个版本关联零个或多个来源。
- 私人记忆范围只关联到一个已确认的内部主体；不同主体之间隔离。

## 3. 周期与版本的数据库约束

1. 周期使用明确的开始和结束时间，按左闭右开区间计算。
2. 自动任务的幂等键由记忆范围、周期边界和任务类型确定。
3. 快照版本使用逻辑快照标识 + 版本号唯一约束。
4. 重新生成创建新的快照版本；历史版本不物理覆盖。
5. 记忆设置改变不能修改已经完成快照的周期边界。
6. 长期记忆的失效与原始消息清理分别管理。

## 4. 数据完整性

- 对外部消息、快照版本、记忆范围和任务设置适当唯一约束与索引。
- 定义外键删除策略；不应因为删除角色而不加区分地删除所有审计记录。
- 删除用户或隐私数据时，必须按产品删除策略处理关联内容与适用备份。
- 不在 JSON 配置中明文保存平台 Token、Cookie 或服务端 API 密钥。
- 字段名、枚举和值域应在 OpenAPI、Prisma、类型定义和测试中保持一致。

## 5. 实施顺序

Phase 0 先审查本逻辑模型并生成 Prisma Schema 与 OpenAPI 契约；Phase 2 再应用数据库迁移。具体模型必须附关系说明、必要唯一约束、索引策略与测试。

## 6. Concrete Prisma schema

The initial concrete schema is now located at [`prisma/schema.prisma`](../prisma/schema.prisma), with connection configuration in [`prisma.config.ts`](../prisma.config.ts).

The initial model set includes:
- `User`, `Character`
- `PlatformConnection`, `CharacterChannelBinding`, `ExternalIdentity`
- `Conversation`, `Message`
- `MemoryScope`, `MemoryItem`
- `MemorySnapshot`, `MemorySnapshotSource`
- `CharacterMemorySetting`, `MemoryJob`
- `OnebotGroupAnnouncement`
- `AuditLog`

Prisma enum values are uppercase internally. The HTTP API uses lower-case enum strings for user-facing status/role values where specified by `docs/openapi.yaml`; the API service must perform explicit mapping and validation rather than persisting arbitrary strings.

Character creation should be transactional: create the character, its `character_global` memory scope, and default memory settings together. Scope-type consistency must be validated in the application (for example, a global scope has neither `userId` nor `externalIdentityId`; a private user scope uses a verified internal user; an external-identity scope is isolated to one unverified external identity).

The Prisma schema declares `@@unique([snapshotKey, version])`. During the initial SQL migration, add a PostgreSQL partial unique index so at most one row per logical snapshot key can have `status = 'CURRENT'`. Prisma's schema language does not express this partial index directly; preserve it in a committed SQL migration and test it under concurrent worker execution.

The schema is a Phase 0 artifact and has not been applied to any production database. Run `npm install`, `npm run db:format`, and `npm run db:validate` locally before creating migrations.
