import assert from "node:assert/strict";
import {
  CROSS_CHANNEL_MAX_LINES,
  CROSS_CHANNEL_TOKEN_BUDGET,
  CROSS_CHANNEL_WINDOW_MINUTES,
  selectCrossChannelContext,
  type CrossChannelCandidate,
  type SelectCrossChannelOptions,
} from "../server/utils/cross-channel-context";

/**
 * 跨窗口旁路的单元测试。
 *
 * 锁的是三条边界，每一条错了都会让私聊变成「群聊转播」或者干脆什么都带不进来：
 * 1. 只认这个人在群里说的 —— 群里第三人的话一个字都不能进私聊；
 * 2. 她的回应只认「紧跟在他后面」的那一句 —— 她在群里回别人的话跟这次私聊无关；
 * 3. 时间窗、条数、预算三重上限，且第一条永远放行。
 *
 * 全部输入都是内存数据，不连数据库、不调模型。
 */

const now = new Date("2026-11-02T23:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const OWNER = "10001";
const STRANGER = "20002";

/** 一条群消息。默认是主人说的，省得每个用例重复写。 */
const msg = (
  id: string,
  role: "USER" | "ASSISTANT",
  minutes: number,
  overrides: Partial<CrossChannelCandidate> = {},
): CrossChannelCandidate => ({
  id,
  role,
  content: `正文-${id}`,
  occurredAt: minutesAgo(minutes),
  conversationId: "conv-group-a",
  groupLabel: "QQ群 123456",
  ...(role === "USER" ? { authorOpenId: OWNER, authorDisplayName: "主人" } : {}),
  ...overrides,
});

const select = (candidates: CrossChannelCandidate[], overrides: Partial<SelectCrossChannelOptions> = {}) => selectCrossChannelContext(candidates, {
  now,
  ownerUid: OWNER,
  ...overrides,
});

// ── 只认这个人自己说的 ─────────────────────────────────────────────────────
{
  const result = select([
    msg("a1", "USER", 10),
    msg("a2", "USER", 9, { authorOpenId: STRANGER, content: "别人说的话" }),
    msg("a3", "USER", 8),
  ]);
  assert.deepEqual(result.lines.map((line) => line.id), ["a1", "a3"], "群里第三人说的话不能进私聊。");
  assert.equal(result.ownerLines, 2, "ownerLines 只数他自己的发言。");
  assert(
    result.lines.every((line) => line.content !== "别人说的话"),
    "正文里也不能夹带别人的话。",
  );
}

// 没有发言人字段（老数据缺 metadata）按「不是他」处理，宁可少带也不认错人。
{
  const result = select([msg("b1", "USER", 5, { authorOpenId: undefined })]);
  assert.equal(result.lines.length, 0, "认不出是谁说的，就不要带。");
}

// ── 她的回应：只认紧跟在他后面那句 ─────────────────────────────────────────
{
  const result = select([
    msg("c1", "USER", 20),
    msg("c2", "ASSISTANT", 19), // 紧跟在他后面 → 带
    msg("c3", "USER", 15, { authorOpenId: STRANGER, content: "群友插话" }),
    msg("c4", "ASSISTANT", 14), // 接的是群友，不该带
    msg("c5", "USER", 13),
    msg("c6", "ASSISTANT", 1), // 隔了 12 分钟 → 不是接他的
  ]);
  assert.deepEqual(result.lines.map((line) => line.id), ["c1", "c2", "c5"], "只带接在他后面的那句回应。");
}

// 同一个群里她在别处的回应不能因为「这个会话里有主人发言」就整段带进来。
{
  const result = select([
    msg("d1", "USER", 30),
    msg("d2", "ASSISTANT", 29, { conversationId: "conv-group-b" }),
  ]);
  assert.deepEqual(result.lines.map((line) => line.id), ["d1"], "别的群的回应不能串进来。");
}

// ── 时间窗 ────────────────────────────────────────────────────────────────
{
  const result = select([
    msg("e1", "USER", CROSS_CHANNEL_WINDOW_MINUTES + 1),
    msg("e2", "USER", CROSS_CHANNEL_WINDOW_MINUTES - 1),
  ]);
  assert.deepEqual(result.lines.map((line) => line.id), ["e2"], "超出时间窗的发言交给忆泡，这里不带。");
}

// ── 排序与条数 ─────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: CROSS_CHANNEL_MAX_LINES + 5 }, (_, index) => msg(`f${index}`, "USER", 60 - index));
  const result = select(many);
  assert.equal(result.lines.length, CROSS_CHANNEL_MAX_LINES, "条数上限要生效。");
  const times = result.lines.map((line) => new Date(line.occurredAt).getTime());
  assert.deepEqual(times, [...times].sort((left, right) => left - right), "输出必须按时间正序，模型是顺着读的。");
  assert.equal(result.lines.at(-1)?.id, "f20", "超上限时留最近的那几条。");
  assert.equal(result.lines[0]?.id, "f5", "被裁掉的是更早的那几条。");
  assert(result.dropped > 0, "被裁掉的条数要能报出来。");
}

// ── 预算 ──────────────────────────────────────────────────────────────────
{
  const long = Array.from({ length: 12 }, (_, index) => msg(`g${index}`, "USER", 40 - index, { content: "很长的正文".repeat(200) }));
  const result = select(long, { tokenBudget: CROSS_CHANNEL_TOKEN_BUDGET });
  assert(result.lines.length > 0, "预算再紧也不能一条都不给。");
  assert(result.lines.length < long.length, "超预算要真的裁。");
  assert.equal(result.lines.at(-1)?.id, "g11", "优先保最新的那一句。");
}

// 第一条永远放行：单条就超预算时也要给，否则一次提问会变成「她什么都没接到」。
{
  const result = select([msg("h1", "USER", 5, { content: "超长".repeat(4000) })], { tokenBudget: 10 });
  assert.equal(result.lines.length, 1, "第一条不受预算限制。");
  assert(result.lines[0]!.content.length <= 400, "单条正文仍要截断，别把整段贴进提示词。");
}

// ── 兜底 ──────────────────────────────────────────────────────────────────
{
  const result = selectCrossChannelContext([msg("i1", "USER", 5)], { now, ownerUid: "  " });
  assert.equal(result.lines.length, 0, "没有对话方账号时整段跳过，不要瞎猜这是谁。");
  assert.equal(result.ownerLines, 0, "跳过时也要返回一致的计数。");
}

{
  const result = select([msg("j1", "ASSISTANT", 5)]);
  assert.equal(result.lines.length, 0, "只有她的回应、没有他的发言时，一条都不带。");
}

{
  const result = select([]);
  assert.deepEqual(result, { lines: [], ownerLines: 0, dropped: 0 }, "空输入返回空结果。");
}

// 正文前后空白要去掉，但不能改写内容。
{
  const result = select([msg("k1", "USER", 5, { content: "  在群里说了一句  " })]);
  assert.equal(result.lines[0]?.content, "在群里说了一句", "只裁空白，不改正文。");
  assert.equal(result.lines[0]?.speaker, "主人", "带发言人显示名，私聊里她才知道这句是他说的。");
  assert.equal(result.lines[0]?.groupLabel, "QQ群 123456", "来源群要标出来，她才能说「你群里说的」。");
}

// 她自己的回应不需要 speaker（那是她自己说的话），带了反而像第三个人。
{
  const result = select([msg("l1", "USER", 5), msg("l2", "ASSISTANT", 4)]);
  const assistant = result.lines.find((line) => line.id === "l2");
  assert.equal(assistant?.speaker, undefined, "她的回应不能带 speaker。");
  assert.equal(assistant?.role, "ASSISTANT", "角色要是 ASSISTANT，模型才知道那是她自己说的。");
}

console.log("跨窗口上下文测试通过：只认本人 / 忽略他人 / 只带紧随其后的回应 / 跨群不串 / 时间窗 / 条数 / 预算 / 首条放行 / 空输入。");
