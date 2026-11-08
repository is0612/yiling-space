# 跨平台身份绑定方案

> **2026-10-31 定位调整**：鱼实际只在 QQ 活跃，"跨三个平台认同一个人"的假设落空，绑定从上线
> 到清理前一次都没被用过（318 条全是 `UNVERIFIED`）。这套数据现在承担的是**「她的朋友」**——
> 某个角色认识的某个人，按角色分开记。第 1–5 节保留原始设计（绑定接口仍在，页面不再提供入口），
> 第 6 节是当前实际用法。

> 目标：让"同一个角色在 B站/微信/QQ 上的账号"共享人格记忆（角色全局），同时按平台隔离
> 每个外部用户的私人记忆；并提供管理员验证、绑定、解绑外部身份的能力。
>
> 这是"三平台记忆汇聚到一个角色"的关键一环 —— 隔离逻辑已就位（`resolveChatMemoryScopes`），
> 本方案补齐的是「身份写入 + 绑定管理 + UI」。

## 1. 背景：已经有什么，缺什么

**已经有的（隔离规则已实现且正确）：**

- `ExternalIdentity` 表：`platform` + `platformUid` 唯一，`status`（UNVERIFIED/VERIFIED/REVOKED），
  `linkedUserId`，`connectionId`，`metadata`。
- `MemoryScope` 支持 `EXTERNAL_IDENTITY` 类型，`externalIdentityId` 外键。
- `resolveChatMemoryScopes()` 只放行 `VERIFIED` 且 `linkedUserId === actingUserId` 的外部身份记忆；
  `CHARACTER_GLOBAL` 始终可读。未验证身份、他人身份、未知类型一律拒绝。

**缺的（本方案补齐）：**

1. **身份写入**：渠道消息进来时，没有地方创建/更新 `ExternalIdentity`（目前表是空的）。
2. **绑定管理 API**：没有"查看身份列表 / 验证绑定 / 解绑 / 撤销"的接口。
3. **前端 UI**：没有身份管理页面。
4. **渠道流水线**：`handleChannelMessage` 目前只读角色全局记忆，没有为外部身份建立/检索私人记忆。

## 2. 核心设计决策

### 2.1 身份的三态与合并规则

| 状态 | 含义 | 记忆可读 |
| --- | --- | --- |
| `UNVERIFIED` | 默认，只在某个平台出现过，未确认是谁 | 其私人记忆仅该平台该 uid 内部可读，不跨平台 |
| `VERIFIED` | 管理员确认该外部身份 = 某个 yiling-space 用户 | 该身份的私人记忆可被 `linkedUserId` 在**站内网页对话**中读取（渠道私聊暂不读，见 2.3） |
| `REVOKED` | 已解绑/撤销 | 记忆保留但不再参与该用户的检索 |

**关键规则（对齐 CLAUDE.md 第 4 条）：**
- 默认隔离：不同平台的同名/同昵称身份**绝不自动合并**。
- 只有管理员显式执行「验证绑定」后，`status=VERIFIED` + `linkedUserId` 才成立，私人记忆才跨平台打通。
- 绑定是**单向、显式、可撤销**的，且留审计记录。

### 2.2 记忆归属：三层清晰分工

| 层 | scopeType | 存什么 | 谁读 |
| --- | --- | --- | --- |
| 人格层 | `CHARACTER_GLOBAL` | "大肥鱼是谁"（性格/长期偏好/三观） | 所有绑定该角色的平台 |
| 平台身份层 | `EXTERNAL_IDENTITY` | "B站 uid=123 跟大肥鱼聊过啥" | 仅该外部身份（未验证）或绑定用户（已验证） |
| 站内用户层 | `USER_PRIVATE` | "yiling-space 注册用户跟大肥鱼聊过啥" | 仅该用户 |

**结论**：三平台"汇聚"的是**人格层**（自动，天然共享）；平台互动记忆**默认隔离**，只有管理员显式绑定后才跨平台打通。这既满足"汇聚"，又满足"不乱合并"。

### 2.3 已知缺口：绑定只在站内生效，渠道之间互不可见

渠道私聊（`handleChannelMessage`）挑可读范围时只取「当前身份自己的 scope」+ 角色全局，
**完全不看 `status` / `linkedUserId`**；而唯一读绑定的 `resolveChatMemoryScopes()` 只被站内
`/api/characters/[id]/chat` 调用（`grep linkedUserId server/` 只有这两处）。

后果：

- **主人**：跨平台天然连通，靠的是「私聊挂 `USER_PRIVATE` scope + 渠道传 `isOwner`」，
  和绑定无关。
- **普通外部用户**：同一个人的 B站 与 QQ 私聊记忆**互不可见**，哪怕管理员已把两个号
  `VERIFIED` 绑到同一个用户。对他来说「换平台 = 失忆」。

补法（尚未实现）：`pipeline.ts` 的 `readableScopeIds` 在私聊分支里，若当前身份 `VERIFIED`
且 `linkedUserId = U`，并上 U 的 `USER_PRIVATE` scope，以及 U 名下其他已验证身份的 scope。
代价是绑错人会让两边记忆串味，且已经读进上下文的内容无法追回。

**决定（2026-10-31）**：先不动，等真的需要「同一个人换平台还接得上」时再补。在此之前，
页面文案与本节都应把它描述为"站内打通"，不要说成"跨平台打通"。

## 3. 实现内容

### 3.1 身份写入（渠道流水线改造）

在 `handleChannelMessage`（`channel-adapter/pipeline.ts`）里，收到消息时：

1. 用 `platform + authorOpenId`（或 `authorUid`）upsert 一条 `ExternalIdentity`（初始 `UNVERIFIED`），
   关联到当前 `connectionId`，`metadata` 存昵称/头像等。
2. 为该外部身份建立/查找 `EXTERNAL_IDENTITY` 类型的 `MemoryScope`
   （`scopeKey = character:{characterId}:external:{platform}:{platformUid}`）。
3. 会话落在该外部身份的 scope 下；检索时，`resolveChatMemoryScopes` 会自动处理：
   - 未验证身份 → 只有该身份自己的记忆 + 角色全局参与；
   - 已验证且绑定当前用户 → 额外带上该用户的私人记忆。

> 注意：B站渠道的 `authorOpenId` 目前是 `authorUid`（B站 uid）。QQ 渠道是 `user_openid`。
> 统一用 `platform + platformUid` 作为外部身份键。

**只记一对一私聊来访者，群聊不建身份。** 群会话挂在角色全局 scope 下
（`conversationScopeId` 的群聊分支），身份 scope 建出来没有任何地方读它；而身份表的
定位是「谁来找过她」，一个群里几十号人全记进去，真正的私聊来访者会被淹掉，管理员
绑定时也找不到人。群友说过的话照常入库，只是不产生外部身份和私人记忆范围；他哪天来
私聊，第一句就会补上这行身份。

### 3.2 绑定管理 API（`server/api/admin/identities/`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/admin/identities` | 列出外部身份（按平台/状态筛选，含是否已绑定、关联用户） |
| POST | `/api/admin/identities/[id]/verify` | 验证并绑定到指定 `userId`（`status=VERIFIED`, `linkedUserId`） |
| POST | `/api/admin/identities/[id]/unlink` | 解绑（`status=UNVERIFIED`，清空 `linkedUserId`） |
| POST | `/api/admin/identities/[id]/revoke` | 撤销（`status=REVOKED`） |

所有操作走 `requireAdminActor`，写审计日志（`identity.verified` / `identity.unlinked` / `identity.revoked`）。

### 3.3 前端页面（`app/pages/identities.vue`）

管理员身份管理页：
- 列出所有外部身份（平台、uid、昵称、状态、是否绑定用户、关联的角色、最近互动时间与会话数）。
- 支持"绑定到用户"（选择 yiling-space 用户）、"解绑"、"撤销"；已撤销的身份可以「恢复绑定」。
- 仅管理员可见，普通用户访问返回 403。

## 4. 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| I1 | 渠道流水线写入 `ExternalIdentity` + `EXTERNAL_IDENTITY` scope（仅私聊） | `test:identity-ingest` 通过（B站/QQ 私聊事件 → 身份+scope 建立，幂等） |
| I2 | 绑定管理 API（列表/验证/解绑/撤销）+ 审计 | `test:identity-admin` 通过 |
| I3 | 前端身份管理页 | 管理员可查看/绑定/解绑 |
| I4 | 检索打通：已验证身份绑定用户后，跨平台私人记忆进入检索 | `test:identity-retrieval` 通过 |

## 5. 边界与约束

- 绑定是**显式人工动作**，不做自动猜测合并（哪怕昵称相同）。
- 绑定后不影响历史：已写入的私人记忆 scope 不变，只是从"该身份可读"变为"绑定用户也可读"。
- 撤销绑定后，该身份的私人记忆不再参与绑定用户的检索，但数据保留（可追溯）。
- 所有绑定/解绑/撤销写审计日志，管理员身份管理页不展示对话/记忆正文。

## 6. 当前定位：她的朋友（2026-10-31 起）

### 6.1 数据落点

**一行 = 一条关系**，不是一个账号。关系就落在 `memory_scopes` 的 `EXTERNAL_IDENTITY` 行上：
`scopeKey` 是 `character:{characterId}:external:{platform}:{uid}`，天然按角色分开，所以同一个
QQ 号跟两个角色聊过就是两条关系，各记各的次数和时间，不需要再建一张要同步的关系表。

新增三个字段（迁移 `20261031203000_friend_relation`）：

| 字段 | 含义 |
| --- | --- |
| `interactionCount` | 累计互动次数 |
| `lastInteractedAt` | 最近一次互动 |
| `firstSource` | `PRIVATE` / `GROUP`，第一次是怎么认识的（之后不再改） |

### 6.2 计数口径

- **私聊**：对方发来消息就 +1（`pipeline.ts` 的 `if (!isGroup)` 分支）。
- **群聊**：只有她**真的回了谁**才 +1 —— 用 `groupDecision.replyToMessageId` / `atMessageId`
  反查作者，两样都没有时取本轮最新一条的作者；`silent` 那轮什么都不记。
  群里没被搭理的发言不会变成朋友，否则一个活跃群几天就攒出几百个"朋友"。
- **记的是「她接话的那条消息」的作者，不是「同群在场的人」**。群里两个人都在说话、她泛回
  一句「你们」，这笔只落在她实际接的那句上。所以页面上的「最近一次」可能比某人在群里的
  最后一次发言早很多 —— 那不是漏记，是口径。
- **引用目标不在本轮批次里**（引用了历史消息、或者上一轮的尾巴）时退回本轮最新一条
  （`pickFriendTargets()`）。早先按 id 硬匹配，匹配不到就整轮一条不记，于是"她明明回了、
  次数却没涨"。

写入统一走 `server/utils/friends.ts` 的 `recordFriendInteraction()`，调用方一律 `catch`——
记账不能挡住已经生成的那句话。**`lastInteractedAt` 只往前推**（同 `group_members.lastSpokeAt`）：
写的是消息的收到时刻，乱序到达、补录旧消息、语音转写晚了的时候不许把时间往回拉。

### 6.3 群聊：熟人卡 + 熟人名册

群聊里有两份关系数据进提示词，分工不同：

**熟人卡（`groupAcquaintances`，v14）** —— 只覆盖**本轮开口的人**里聊过 ≥2 次的，
带次数与最近一次，决定「对这句话用什么语气」。

**熟人名册（`acquaintances`，v23）** —— 分三档，由 `listAcquaintances()` 一次查齐：

| 档位 | 内容 | 谁用 |
| --- | --- | --- |
| `fromPrivate` | 私聊里往来最多的人 | 私聊回答「跟谁最熟」 |
| `fromGroups` | 群里往来最多的人，每条带 `inGroups`（群号） | 私聊当背景；群聊仅当背景 |
| `inThisGroup` | **就在当前这个群**、且她聊过的人 | 群聊决定「对谁热络、对谁客气」 |

为什么分档（v22 那张一维总榜的两个问题）：

1. **分不清是哪个群的熟人**。v22 只按 `firstSource = GROUP` 筛，A 群的熟人会出现在 B 群的榜上，
   她就冲着第一次见的人叫老朋友。现在群聊只认 `inThisGroup`，靠 `group_members` 取交集。
2. **私聊里的亲近对象被挤掉**。次数是「她回过多少次」，群里天天见的人天然高；一张榜念出来，
   私聊里真正亲近的人排不上号。现在私聊两档分开说，提示词明确禁止拼成一张排行榜。

`inGroups` 用**群号**而不是群名：`Conversation.title` 存的是首条消息片段（实测有「@self 起床没」
这种），当群名用只会喂噪声。群号唯一的作用是让两个同名的人别被读成同一个，提示词里写明
「不许念数字、不许当群名猜」。

`totals` 是「她到底认识多少人」的量级（现在 1 私聊 / 114 群）。榜只有 8 个位置，
不给她量级，她会以为自己全世界的朋友就这么几个。

两份数据都只有名字、次数、最近一次、来源，**不含任何聊过的内容** —— 群里一屋子人都听着，
私事不能端上桌。提示词里的硬约束：

- 不许念次数、不许把名册念给群里、不许当众提私事、不许说「我在别的群还认识谁」；
- **熟人卡与 `inThisGroup` 打架时以熟人卡为准**：名册只有 8 个位置，一个聊过 20 次的人完全可能
  不在榜上，两条都没有记录才当作「基本不认识」，否则她会对熟人装陌生；
- 名册不是本群成员表，不点破谁是生人。

### 6.3.1 群成员归属（`group_members`）

`messages` 表没存发言人的 UID 列（只有 `metadata->>'authorOpenId'`），所以「这个群里出现过谁」
没法直接查。为此加了一张归属表，2026-11-01 首次建表并**从历史消息回填**：

```
group_members(conversationId, characterId, platformUid, displayName,
              messageCount, firstSpokeAt, lastSpokeAt)
  UNIQUE(conversationId, platformUid)
```

- **写**：群聊落库的同一个事务里 upsert（`buildGroupMemberDeltas()`），记的是**所有开口的人**，
  `messageCount` 累加、`lastSpokeAt` 只往前推。
- **读**：`listAcquaintances({ conversationId })` 先取群成员，再跟「她回过谁」取交集。
- 它和 `recordFriendInteraction` 是两条线，别合并：这里记「谁在这个屋里」，
  那里记「她跟谁有交情」。一个活跃群 325 人，她只回过其中 114 个 —— 两个数都对。
- 回填结果：`g:123456781` 325 人 / 5384 条，`g:123456782` 18 人 / 905 条，
  `g:123456783` 8 人 / 551 条。

### 6.4 页面

`/growth/social/friends`（旧 `/identities` 保留重定向），菜单名「好友档案」：按角色切换、搜索昵称/UID/平台、来源分段（全部 / 私聊认识 /
群里认识）、四个排序维度各自升降、统计格为「认识的人 / 聊过两次以上 / 最近七天有来往」。
绑定的三个按钮已从页面移除（接口保留备用）。

筛选、排序、翻页**全在服务端**（`GET /api/admin/identities?characterId=&q=&source=&sort=&dir=&page=&pageSize=`，
一页 12 个）。名单会一直长，全量下发迟早撑不住；现在每次只回一页。

统计带与来源计数由接口另算，口径固定为「这个角色的全部朋友」，**不受关键词和来源筛选影响** ——
否则筛一下「群里认识」，「认识的人」那格数字会跟着变小，就没法当参照了。
排序一律以 `id` 收尾做次级键：只按时间/次数排，同分的人顺序由数据库自由决定，翻页会重复或漏。

### 6.5 与记忆的关系

原来这里只记关系、不产记忆：`memory-scheduler.ts` 只给角色全局和主人私人排快照，
`EXTERNAL_IDENTITY` 从不入队，所以身份行建了、记忆条数是 0，绑过去也读不到东西。

**2026-10-31 已补上提炼这一环**：每个快照周期，只要某个朋友范围在本周期内有会话，就跟着
全局周期排一份 `GENERATE_SNAPSHOT`（`listFriendScopesWithActivity`）。私聊检索本来就把
「当前身份自己的 scope」算在可读范围里，所以记忆一生成就能被读到，读取侧不用改。

两个约束：

- **按需排**：只排本周期真说过话的，没聊过的排了也是 SKIPPED，白占队列。
- **有上限**：单周期最多 `MAX_FRIEND_SCOPES_PER_CYCLE = 50` 个，按最近互动倒序取。
  每个朋友每周期是一次模型调用，人数多了账单会顶上来。

仍未做的只有 2.3 节那件事：不同渠道之间互读（B站私聊 ↔ QQ 私聊）。现在通了的是
「渠道私聊 ↔ 自己的记忆」，不是「同一个人的多个号之间」。
