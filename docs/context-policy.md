# 上下文装配策略层（ContextPlan）

> 状态：设计（2026-11-16），完整 ContextPlan 尚未实现。网页与 QQ 已共享长期记忆、快照、忆泡的**候选读取**（`prompt-memory-candidates.ts` / `prompt-event-candidates.ts`）和**选择与整形**（`prompt-memory-selection.ts`：预算装配、scope 标签、忆泡 600 字截断、名字刷新），见 [检索验收](memory-retrieval-acceptance.md)。这仍是写死的顺序与条件，不是计划驱动装配，不改变本文 P0 / P1 的验收状态。
> 定位：回答「这一轮提示词里放什么」。不改变提示词怎么写，也不替代闸门、预算与范围校验。

---

## 1. 一句话与边界

**策略层管「放什么」，提示词模板管「怎么写」。**

| | 内容 | 归属 | 是否允许改动 |
|---|---|---|---|
| 提示词模板 | 人设、语气、边界、禁语、输出格式要求 | `server/utils/chat-reply.ts`（版本号 `PROMPT_TEMPLATE_VERSION`） | 改代码、过评审、升版本 |
| 装配决策 | 本轮放哪几类来源、各多少条 / 多少 token、什么顺序、什么条件跳过 | **本文定义的 `ContextPlan`** | 改计划、跑样例、看 `turnDetail` |
| 硬闸门 | 该不该回、是否静默、限流 | `onebot/group-chat.ts`、`group-mute.ts` | 不进策略层 |

**不要把提示词模板搬进策略层。** 模板一旦可以数据化编辑，就会出现「代码一份、配置一份」的双来源，版本断言与评审同时失效。

---

## 2. 现状：决策散在三处

一次回复的上下文装配目前分布在：

- `server/utils/channel-adapter/pipeline.ts`：并行查长期记忆、快照、忆泡、跨窗口、熟人卡，并做范围过滤；
- `server/utils/memory-retrieval.ts` / `memory-budget.ts`：预算装配、衰减与召回加成；
- `server/utils/chat-reply.ts`：按固定顺序把各段拼进提示词，并附带「现在是几点」「私聊/群聊边界」等规则段。

预算数字已经是配置（`modelConfig.memoryTokenBudget` 等），但**「这次要不要查原文」「问句是日期还是话题」「群聊要不要带跨窗口」仍是散落的 if**。结果是同一个问题「她这轮为什么没想起那件事」要翻三个文件。

---

## 3. 目标结构

### 3.1 计划对象

```ts
export type ContextSource =
  | "recentMessages"
  | "memory"
  | "snapshot"
  | "event"
  | "rawMessage"
  | "knowledge"      // 知识库落地后新增
  | "crossChannel"
  | "speakerCard";

export type ContextPlanSegment = {
  source: ContextSource;
  budget: number;          // token 上限
  limit: number;           // 条数上限
  /** 为什么放它。写进 turnDetail，供排查与验收。 */
  reason:
    | "always"
    | "question_has_date"
    | "question_has_topic"
    | "keyword_hit"
    | "owner_cross_channel"
    | "group_scope_only";
  /** 是否允许为空：为空时记录 reason，不阻断回复。 */
  optional: boolean;
};

export type ContextPlan = {
  segments: ContextPlanSegment[];
  /** 总预算；超过时按段顺序截断，最后一段可被挤压。 */
  totalBudget: number;
};
```

### 3.2 纯函数

```ts
planContextTurn(input: {
  surface: "desktop" | "private" | "group";
  isOwner: boolean;
  questionKind: "date" | "topic" | "none";
  hasKnowledgeHit: boolean;   // 知识库落地后才有意义
  config: CharacterModelConfig;
}): ContextPlan
```

- 纯函数、不查库、不读时间：所有输入显式传入，便于单测与固定样例。
- 真正的查询仍由 `pipeline.ts` 执行；计划只决定「查哪些、留多少」。
- `chat-reply.ts` 不再自行判断顺序与取舍，只按 plan 渲染。

### 3.3 顺序固定，不可由数据任意重排

顺序建议保持现有语义：最近对话 → 角色设定/时间 → 长期记忆 → 快照 → 忆泡 → 原文兜底 → 知识 → 跨窗口旁路 → 说话人卡。

理由：越靠前的段落越像「她本人的处境」，越靠后越像「外部资料」。允许随意重排会改变模型对信息权重的感知，属于行为变更，不是配置。

---

## 4. 分阶段

### P0：只观测，不改行为

1. 实现 `planContextTurn`，但只用于**描述**现有装配结果：由现有代码路径生成 plan，不驱动渲染；
2. plan 写进 `turnDetail`（`metadata.turnDetail`）新增字段，例如：

```json
{
  "contextPlan": {
    "totalBudget": 6200,
    "segments": [
      { "source": "memory", "budget": 1800, "limit": 20, "reason": "keyword_hit", "used": 1204, "items": 6 },
      { "source": "event", "budget": 800, "limit": 8, "reason": "question_has_date", "used": 0, "items": 0 }
    ]
  }
}
```

`used` / `items` 来自真实装配结果，用来发现「计划里配了、实际一条没用上」的段。

验收：同一批固定样例（至少覆盖：问某天、问某人、无关闲聊、主人跨窗口、无任何命中）在 plan 里的段与现有行为逐项一致。**P0 不允许出现回复内容变化。**

### P1：接入知识库后收口

知识是第一个真正需要「按需、独立预算、可解释」的来源，此时把六类查询统一切换到 plan 驱动：

1. `pipeline.ts` 按 plan 的 `segments` 决定查什么；
2. `chat-reply.ts` 按 plan 渲染；
3. 预算、条数、顺序从 `modelConfig` 与 plan 共同决定，不再散落 if。

---

## 5. 明确不做

- **不做可编辑 DSL / 配置平台**：用户自己拼提示词会变成第二套系统，出问题时无法判断哪套生效。
- **不做「按模型自动优化预算」**：没有依据的自动化会掩盖真实原因。
- **不接管闸门**：静默、限流、提及判定属于「该不该说」，与「放什么」是两件事。
- **不接管范围校验**：`resolveChatMemoryScopes()` 仍是唯一入口，策略层只消费它的结果。
- **不重排固定顺序**（见 3.3）。

---

## 6. 可观测与验收

- `turnDetail` 必须能回答三个问题：**放了哪些来源、各用了多少、为什么放/为什么没放**。
- 固定样例断言 plan 结构，不断言最终提示词字符串（后者只由 `test:chat-reply` 的版本断言负责）。
- 新增预算或来源时，先加样例、再加段。

---

## 7. 风险

| 风险 | 表现 | 处置 |
|---|---|---|
| 计划与实际不一致 | plan 说放了知识，实际没查 | `used` 字段由真实装配回填，P0 期间逐项比对 |
| 过度抽象 | 只有六类来源却先建调度器 | 先做 P0 观测，知识库落地再切 P1 |
| 顺序被当成配置 | 有人改顺序导致行为漂移 | 顺序写死在代码，plan 只读 |
| 双来源 | 代码与 plan 各算一次预算 | 预算只由 plan 决定，`modelConfig` 作为输入 |

---

## 8. 与现有规则的关系

- 符合「先用代码判，再调模型」：计划是确定性的，模型不参与装配决策。
- 不改变「模型输出只驱动白名单动作」：plan 只影响读取，不授予写权限。
- 记忆来源与范围规则仍以 `docs/memory-system.md` 第 9 节为准；本文不重复定义范围。
- 提示词版本号与文案断言不因本文改变。

---

## 9. 后续

1. P0 观测上线后，用真实会话回看：哪些段长期为空、哪些段长期被挤压。
2. 知识库（`docs/knowledge-system.md`）落地时，把 `knowledge` 作为第一个新来源接入 plan，并同步更新本文第 3、4 节。
