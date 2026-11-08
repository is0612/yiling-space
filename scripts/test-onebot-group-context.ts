/**
 * 群聊短期上下文与话题参与的纯逻辑测试：成员代号、背景预算、话题建立/续期/过期。
 * 不连数据库、不调模型。
 */

import assert from "node:assert/strict";
import { createGroupContext, type GroupMessageFacts } from "../server/utils/channel-adapter/onebot/group-context";
import { readOnebotMentionQqs, readOnebotMentionTargets, readOnebotMentions, readOnebotReplyToId } from "../server/utils/channel-adapter/onebot/types";

const SELF = "999";
let now = 1_000_000;
const minutes = (n: number) => n * 60_000;

const ctx = createGroupContext({
  selfQq: SELF,
  now: () => now,
  maxMessages: 5,
  maxChars: 60,
  topicTtlMs: minutes(3),
  topicMaxLifeMs: minutes(15),
  maxTopics: 3,
});

const facts = (patch: Partial<GroupMessageFacts> & { messageId: string; senderQq: string }): GroupMessageFacts => ({
  at: now,
  displayName: `用户${patch.senderQq}`,
  text: "",
  mentionTargets: [],
  replyToMessageId: "",
  ...patch,
});

// ── 1. 成员代号：同 QQ 改名仍是同一人，同名不同 QQ 分开 ─────────
ctx.remember("g:1", facts({ messageId: "m1", senderQq: "111", displayName: "小鱼", text: "在吗" }));
ctx.remember("g:1", facts({ messageId: "m2", senderQq: "222", displayName: "小鱼", text: "我也叫小鱼" }));
ctx.remember("g:1", facts({ messageId: "m3", senderQq: "111", displayName: "改了名", text: "还是我" }));
assert.equal(ctx.memberCode("g:1", "111"), "member_1", "QQ 111 的代号要稳定。");
assert.equal(ctx.memberCode("g:1", "222"), "member_2", "同名不同 QQ 必须是两个成员。");
assert.equal(ctx.memberCode("g:1", "111"), "member_1", "改昵称不改代号。");

// 不同群各自编号，不串。
assert.equal(ctx.memberCode("g:2", "111"), "member_1", "另一个群的代号从 member_1 重新开始。");

// ── 1b. 引用回复要 @ 原文作者：message id → QQ ──────────────────
// 提示词里只有代号，真实账号留在进程内，发送侧靠这张表把 @ 补上。
assert.equal(ctx.senderOf("g:1", "m1"), "111", "引用 m1 就 @ 发 m1 的人。");
assert.equal(ctx.senderOf("g:1", "m2"), "222");
assert.equal(ctx.senderOf("g:2", "m1"), null, "别的群的消息 id 不能串到本群。");
assert.equal(ctx.senderOf("g:1", "no-such-id"), null, "查不到就别 @。");
assert.equal(ctx.senderOf("g:1", ""), null);
now += 2;
assert.equal(ctx.senderOf("g:1", "m1", 1), null, "调用方可以用更窄的时间上限，排除已过期的历史发言。");

// ── 2. 入模正文：@ 她自己 / 别人 / 全体 ────────────────────────
assert.equal(ctx.formatText("g:1", `@${SELF} 你好`), "@self 你好");
assert.equal(ctx.formatText("g:1", "@111 你好"), "@member_1 你好");
assert.equal(ctx.formatText("g:1", "@222 你好"), "@member_2 你好");
assert.equal(ctx.formatText("g:1", "@all 开会了"), "@all 开会了", "@全体不是她本人。");
assert.equal(ctx.formatText("g:1", "[CQ:at,qq=999] 你好"), "@self 你好", "字符串消息里的 CQ 码也要代号化。");
assert.equal(ctx.formatText("g:1", "没有 at 的正文"), "没有 at 的正文");

// ── 3. 背景：排除本轮、按时间正序、受预算限制 ──────────────────
const background = ctx.background("g:1", ["m3"]);
assert.deepEqual(background.map((line) => line.id), ["m1", "m2"], "本轮消息不能再当背景拼一遍。");
assert.equal(background[0]!.member, "member_1");
assert.equal(background[0]!.text, "在吗");

// 条数上限：只留最近 maxMessages 条。
for (let index = 0; index < 8; index += 1) {
  now += 1;
  ctx.remember("g:3", facts({ messageId: `x${index}`, senderQq: "111", text: `第${index}条` }));
}
assert.equal(ctx.background("g:3", []).length, 5, "缓存按 maxMessages 截断。");
assert.equal(ctx.background("g:3", [])[4]!.id, "x7", "留下的是最近的。");

// ── 4. 话题：建立、候选、过期 ─────────────────────────────────
const topicKey = "g:9";
assert.equal(ctx.topicCandidate(topicKey, []), false, "没有任何话题时不是候选。");

now += 10_000;
const ask = facts({ messageId: "a1", senderQq: "111", text: `@${SELF} 晚饭吃什么`, mentionTargets: ["self"] });
ctx.recordReply(topicKey, [ask], { source: "mention" });
assert.equal(ctx.activeTopicCount(topicKey), 1);
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a2", senderQq: "111" })]), true, "参与者继续说，算话题候选。");
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a3", senderQq: "333" })]), false, "陌生人说话不算。");
assert.deepEqual(ctx.anchors(topicKey).map((anchor) => anchor.id), ["a1"]);
assert.deepEqual(ctx.anchors(topicKey, new Set(["a1"])), [], "身份被禁止后，不再向模型提供它的旧话题锚点。");
assert.equal(
  ctx.topicCandidate(topicKey, [facts({ messageId: "a2-blocked", senderQq: "111" })], new Set(["111"])),
  false,
  "被禁止成员的历史话题不再触发模型接话。",
);

// 恰好 3 分钟：还活着；超过就失效。
now += minutes(3) - 1;
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a4", senderQq: "111" })]), true);
now += 2;
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a5", senderQq: "111" })]), false, "3 分钟无互动就过期。");

// ── 5. 沉默续期：只认已有锚点 + followup/shared_topic，且受绝对上限 ──
const refreshKey = "g:10";
now += 1_000;
const startedAt = now;
ctx.recordReply(refreshKey, [facts({ messageId: "b1", senderQq: "111", text: "聊游戏" })], { source: "ambient" });
assert.equal(
  ctx.refreshFromDecision(refreshKey, { relation: "unrelated", evidenceMessageIds: [] }),
  false,
  "无关判断不能续期。",
);
assert.equal(
  ctx.refreshFromDecision(refreshKey, { relation: "followup", topicAnchorMessageId: "b1", evidenceMessageIds: ["b2"] }),
  true,
);
// 靠合法的 followup 一直续，但绝对上限 15 分钟一到就必须失效。
for (let step = 0; step < 7; step += 1) {
  now += minutes(2) - 1;
  ctx.refreshFromDecision(refreshKey, { relation: "followup", topicAnchorMessageId: "b1", evidenceMessageIds: [] });
}
now = startedAt + minutes(15) + 1;
assert.equal(ctx.activeTopicCount(refreshKey), 0, "话题最长活 15 分钟，不能被无限续命。");

// ── 6. 并行话题与淘汰：最多 3 个，丢最久没互动的 ───────────────
const multiKey = "g:11";
now += minutes(20);
for (const [index, qq] of ["111", "222", "333", "444"].entries()) {
  now += 1_000;
  ctx.recordReply(multiKey, [facts({ messageId: `t${index}`, senderQq: qq })], { source: "ambient" });
}
assert.equal(ctx.activeTopicCount(multiKey), 3, "话题数有上限。");
const remainingAnchors = ctx.anchors(multiKey).map((anchor) => anchor.id);
assert(remainingAnchors.includes("t3"), "最新的那条一定还在。");
assert(!remainingAnchors.includes("t0"), "最久没互动的被淘汰。");

// ── 7. 解析：@ 指向与引用 ─────────────────────────────────────
assert.deepEqual(
  readOnebotMentionTargets({ message: [
    { type: "at", data: { qq: 999 } },
    { type: "at", data: { qq: 111 } },
    { type: "at", data: { qq: "all" } },
  ] }, SELF),
  ["self", "other", "all"],
);
assert.deepEqual(
  readOnebotMentionTargets({ message: "[CQ:at,qq=999] 你好" }, SELF),
  ["self"],
  "字符串消息也要认 CQ 码。",
);
assert.deepEqual(readOnebotMentionTargets({ message: "[CQ:at,qq=111] 你好" }, ""), ["other"], "没有 selfId 时不要猜 self。");
// 结构化 at 段：保留顺序、目标 QQ 与网关可选的显示名。昵称只用于展示，认人仍看 qq。
assert.deepEqual(
  readOnebotMentions({ message: [
    { type: "text", data: { text: "先问 " } },
    { type: "at", data: { qq: 111, name: "外部 bot" } },
    { type: "text", data: { text: " 再问 " } },
    { type: "at", data: { qq: 999 } },
  ] }, SELF),
  [
    { qq: "111", name: "外部 bot", target: "other" },
    { qq: "999", name: "", target: "self" },
  ],
  "at 段要按出现顺序保留 qq 与可选 name，不能只留一个分类。",
);
assert.deepEqual(
  readOnebotMentions({ message: [
    { type: "at", data: { qq: 111, name: "某个称呼" } },
    { type: "at", data: { qq: 222, name: "某个称呼" } },
  ] }, SELF).map((mention) => [mention.qq, mention.name, mention.target]),
  [["111", "某个称呼", "other"], ["222", "某个称呼", "other"]],
  "同名不同 QQ 必须分成两个对象；认人只认 QQ，不认昵称。",
);
assert.equal(
  readOnebotReplyToId({ message: [{ type: "reply", data: { id: 42 } }, { type: "text", data: { text: "嗯" } }] }),
  "42",
);
assert.equal(readOnebotReplyToId({ message: [{ type: "text", data: { text: "嗯" } }] }), "", "没有引用就是空串。");

// ── 8. 归属：谁是谁的人 ────────────────────────────────────────
// 2026-10-31 21:00「我的鱼也是成气候了」说的是他自己那条鱼，她认成自己，回「谁是你的鱼了」。
// 光靠提示词说「所有格不是你」她无处可比，得把群里的归属摆出来。
const ownership = createGroupContext({ selfQq: SELF, now: () => now });

// 自述（硬证据）：@ 了谁又喊「主人」，那个 QQ 就是他的主人。
ownership.remember("g:o", facts({
  messageId: "o1",
  senderQq: "111",
  displayName: "群友甲",
  text: "在吗",
}));
ownership.remember("g:o", facts({
  messageId: "o2",
  senderQq: "222",
  displayName: "千人安知鱼之乐",
  text: "主人夸我了",
  mentionQqs: ["111"],
}));
assert.deepEqual(
  ownership.members("g:o"),
  [{ member: "member_2", speaker: "千人安知鱼之乐", belongsTo: "member_1", belongsToName: "群友甲" }],
  "「@某人 主人夸我了」要能学成归属。",
);
assert.deepEqual(ownership.members("g:o", new Set(["222"])), [], "被禁止成员不再进入群成员关系提示。");

// 群名片（弱线索）：`X的Y` 与 `Y（主人：X）` 两种写法都认。
const fromNames = createGroupContext({ selfQq: SELF, now: () => now });
fromNames.remember("g:n", facts({ messageId: "n1", senderQq: "311", displayName: "小明", text: "在" }));
fromNames.remember("g:n", facts({ messageId: "n2", senderQq: "312", displayName: "小明的小鱼", text: "在" }));
fromNames.remember("g:n", facts({ messageId: "n3", senderQq: "313", displayName: "小蓝", text: "在" }));
fromNames.remember("g:n", facts({ messageId: "n4", senderQq: "314", displayName: "小鱼儿（主人：小蓝）", text: "在" }));
assert.deepEqual(
  fromNames.members("g:n").map((entry) => [entry.speaker, entry.belongsToName]),
  [["小明的小鱼", "小明"], ["小鱼儿（主人：小蓝）", "小蓝"]],
  "群名片里的两种归属写法都要认。",
);

// 名字对不上人就不上表：一张半准的表比没有表更糟。
const ghost = createGroupContext({ selfQq: SELF, now: () => now });
ghost.remember("g:g", facts({ messageId: "g1", senderQq: "411", displayName: "某人家的鱼", text: "在" }));
assert.deepEqual(ghost.members("g:g"), [], "主人不在窗口里，宁可不给，也不要给个查不到的代号。");

// 只认「恰好 @ 一个别人」：@ 两个分不清认的是谁；@ 她自己更不算。
const ambiguous = createGroupContext({ selfQq: SELF, now: () => now });
ambiguous.remember("g:a", facts({ messageId: "a1", senderQq: "511", displayName: "甲", text: "在" }));
ambiguous.remember("g:a", facts({ messageId: "a2", senderQq: "512", displayName: "乙", text: "主人" }));
ambiguous.remember("g:a", facts({
  messageId: "a3",
  senderQq: "513",
  displayName: "丙",
  text: "主人好",
  mentionQqs: ["511", "512"],
}));
ambiguous.remember("g:a", facts({ messageId: "a4", senderQq: "514", displayName: "丁", text: "主人", mentionQqs: [SELF] }));
assert.deepEqual(ambiguous.members("g:a"), [], "@ 了两个别人或 @ 了她自己时都不记归属。");

// ── 9. 原始 @ QQ：判断「@ 的是别人」不能只靠代号化后的方向 ──────
// mentionTargets 只有 self/other/all 三个方向，两个不同的「别人」分不开；
// 学归属、判「刚才在跟谁讲话」都需要原始 QQ。
assert.deepEqual(
  readOnebotMentionQqs({ message: "[CQ:at,qq=111] 你好" }),
  ["111"],
  "字符串消息里的 CQ 码要能取出被 @ 的 QQ。",
);
assert.deepEqual(
  readOnebotMentionQqs({ message: [{ type: "at", data: { qq: "111" } }, { type: "at", data: { qq: "222" } }] }),
  ["111", "222"],
  "数组消息里的 at 段要按顺序取出。",
);
assert.deepEqual(readOnebotMentionQqs({ message: "[CQ:at,qq=all] 开会" }), ["all"], "@全体原样保留。");
assert.deepEqual(
  readOnebotMentionQqs({ message: "[CQ:at,qq=111][CQ:at,qq=111] 你好" }),
  ["111"],
  "同一个人 @ 两次只算一次，否则「恰好 @ 一个」的判断会失效。",
);
assert.deepEqual(readOnebotMentionQqs({ message: "没有 at" }), [], "没有 @ 就是空数组。");
assert.deepEqual(readOnebotMentionQqs({}), [], "缺字段不许抛错。");

// 结构化 at 段要一路带到背景里：只给 `@member_2` 而不说这个代号是谁，
// 模型仍会把 @ 后面的称呼算到当前角色头上。
const structured = createGroupContext({ selfQq: SELF, now: () => now });
structured.remember("g:m", facts({
  messageId: "m1",
  senderQq: "111",
  displayName: "群友甲",
  text: "@222 这个声音好听",
  mentionTargets: ["other"],
  mentions: [{ qq: "222", name: "外部 bot", target: "other" }],
}));
assert.deepEqual(
  structured.background("g:m", []).map((line) => ({ text: line.text, mentions: line.mentions })),
  [{
    text: "@member_1 这个声音好听",
    mentions: [{ target: "other", member: "member_1", speaker: "外部 bot" }],
  }],
  "背景行要带上被 @ 的对象代号与显示名，且真实 QQ 不进提示词。",
);

// ── 10. 「刚 @ 过别人」的延续：一句话拆两条发时，第二条别当成冲她说 ──
// 2026-10-31 22:02 主人：「@群友乙 不是刷屏」「是这个不适合发群里」。
// 第一条 @ 了群友乙被挡在门外、不落库；第二条没有 @，成了孤立单句，
// 她于是接「不适合你还发，本宝都看见了」。所以「刚 @ 过别人」要留一会儿。
const followed = createGroupContext({ selfQq: SELF, now: () => now });
now += minutes(1);
followed.remember("g:f", facts({
  messageId: "f1",
  senderQq: "111",
  text: "不是刷屏",
  mentionQqs: ["222"],
  mentionTargets: ["other"],
}));
assert.equal(
  followed.addressedOtherWithin("g:f", "111", now + 30_000, minutes(2)),
  true,
  "30 秒后的跟进句仍算在跟那个人讲。",
);
assert.equal(
  followed.addressedOtherWithin("g:f", "111", now + minutes(2) + 1, minutes(2)),
  false,
  "超过两分钟就不该再算，否则上午 @ 过别人、下午说什么都被当成续话。",
);
assert.equal(
  followed.addressedOtherWithin("g:f", "222", now + 30_000, minutes(2)),
  false,
  "只对这个发言人生效，别人说的不算。",
);
assert.equal(
  followed.addressedOtherWithin("g:f", "111", now - 1_000, minutes(2)),
  false,
  "比记录还早的时刻不可能「在之后」。",
);

// @ 她自己、@全体都不算「在跟别人讲」：那两种本来就是冲她/冲大家。
const selfMention = createGroupContext({ selfQq: SELF, now: () => now });
selfMention.remember("g:s", facts({ messageId: "s1", senderQq: "111", text: "在吗", mentionQqs: [SELF] }));
assert.equal(
  selfMention.addressedOtherWithin("g:s", "111", now + 10_000, minutes(2)),
  false,
  "@ 了她自己不是「在跟别人讲」。",
);
selfMention.remember("g:s", facts({ messageId: "s2", senderQq: "111", text: "开会了", mentionQqs: ["all"] }));
assert.equal(
  selfMention.addressedOtherWithin("g:s", "111", now + 10_000, minutes(2)),
  false,
  "@全体是对所有人说的，不该被归到某个别人身上。",
);
assert.equal(
  followed.addressedOtherWithin("g:none", "111", now, minutes(2)),
  false,
  "没说过话的人查不到，不许误判。",
);

// 语境助手的大窗口不改变普通角色背景，也不串群；超过15分钟仍会被清理。
const extended = createGroupContext({ now: () => now });
extended.remember("analysis", facts({ messageId: "teaching", senderQq: "111", at: now - minutes(10), text: "我在教另一个人，拿她举例" }));
extended.remember("analysis", facts({ messageId: "expired", senderQq: "111", at: now - minutes(16), text: "太早了" }));
assert.deepEqual(extended.background("analysis", []), []);
assert.deepEqual(extended.background("analysis", [], { windowMs: minutes(15), maxMessages: 120, maxChars: 24000 }).map(line => line.id), ["teaching"]);
assert.deepEqual(extended.background("other-group", [], { windowMs: minutes(15), maxMessages: 120, maxChars: 24000 }), []);
assert.deepEqual(extended.background("analysis", ["teaching"], { windowMs: minutes(15), maxMessages: 120, maxChars: 24000 }), []);
for (let i = 0; i < 140; i++) extended.remember("busy", facts({ messageId: `busy-${i}`, senderQq: "111", text: "短句" }));
assert.equal(extended.background("busy", []).length, 40);
assert.equal(extended.background("busy", [], { windowMs: minutes(15), maxMessages: 120, maxChars: 24000 }).length, 120);

console.log("群聊上下文测试通过：成员代号、@ 结构化解析（顺序/QQ/显示名/同名不同 QQ）、@ 代号化、背景预算与 @ 对象、话题建立/候选/过期/续期上限、并行话题淘汰、@ 与引用解析、原始 @ QQ、群内归属（自述优先于群名片、查不到人就不上表）、@ 别人之后的续话窗口。");
