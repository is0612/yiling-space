import assert from "node:assert/strict";
import {
  buildGroupActivityContext,
  isGroupActivityQuery,
  parseSelfNames,
} from "../server/utils/group-activity-stats";
import {
  isSelfFactQuery,
  selectJournalFactSentences,
  selfFactTerms,
} from "../server/utils/journal-facts";

// ── 「跟谁聊」问句识别 ─────────────────────────────────────
for (const question of [
  "昨天跟谁聊天了",
  "这个群里谁跟你聊天最多",
  "你今天都在群里跟谁聊天了",
  "我问的是这个群 你昨天都跟谁聊天了",
  "谁跟你聊得最多",
]) {
  assert.equal(isGroupActivityQuery(question), true, `应识别为问人：${question}`);
}
for (const statement of [
  "你今天吃了吗",
  "谁在群里",
  "这条视频挺好看",
  "别问了",
]) {
  assert.equal(isGroupActivityQuery(statement), false, `不该识别为问人：${statement}`);
}

// ── 群内称呼 ──────────────────────────────────────────────
assert.deepEqual(
  parseSelfNames({ characterName: "小鲸鱼i", groupAliases: "小鲸鱼，小鲸鱼i" }),
  ["小鲸鱼i", "小鲸鱼"],
  "角色名与绑定别名都要算进去，且去重",
);
assert.deepEqual(parseSelfNames({ characterName: "小鲸鱼i" }), ["小鲸鱼i"]);

// ── 聚合：只数 USER、@ 她/叫名字才记 atYou ─────────────────
const rows = [
  {
    content: "@100000 早上好",
    occurredAt: new Date("2026-11-03T01:00:00Z"),
    metadata: { authorOpenId: "1001", authorDisplayName: "昔涟" },
  },
  {
    content: "今天吃什么",
    occurredAt: new Date("2026-11-03T01:05:00Z"),
    metadata: { authorOpenId: "1001", authorDisplayName: "昔涟" },
  },
  {
    content: "小鲸鱼在吗",
    occurredAt: new Date("2026-11-03T01:10:00Z"),
    metadata: { authorOpenId: "1002", authorDisplayName: "白夜" },
  },
  {
    content: "@all 集合",
    occurredAt: new Date("2026-11-03T01:15:00Z"),
    metadata: { authorOpenId: "1002", authorDisplayName: "白夜" },
  },
  {
    content: "路过",
    occurredAt: new Date("2026-11-03T01:20:00Z"),
    metadata: { authorOpenId: "1003", authorDisplayName: "路人" },
  },
];
const fakePrisma = {
  message: { findMany: async () => rows },
} as unknown as Parameters<typeof buildGroupActivityContext>[0]["prisma"];

const activity = await buildGroupActivityContext({
  prisma: fakePrisma,
  conversationId: "conversation-1",
  query: "昨天跟谁聊天了",
  now: new Date("2026-11-04T01:00:00Z"),
  timeZone: "Asia/Shanghai",
  selfQq: "100000",
  selfNames: ["小鲸鱼i", "小鲸鱼"],
});
assert.ok(activity, "有消息时应返回统计");
assert.equal(activity!.rangeLabel, "昨天");
assert.equal(activity!.totalMessages, 5);
assert.equal(activity!.members.length, 3);
const xilian = activity!.members.find((member) => member.name === "昔涟")!;
assert.equal(xilian.messages, 2);
assert.equal(xilian.atYou, 1, "@ 她 + 普通闲聊：只算一条 directed");
const baizhi = activity!.members.find((member) => member.name === "白夜")!;
assert.equal(baizhi.messages, 2);
assert.equal(baizhi.atYou, 2, "叫到名字与 @all 都算 directed");

// ── 手账稳定事实 ──────────────────────────────────────────
assert.equal(isSelfFactQuery("你记得你生日吗"), true);
assert.equal(isSelfFactQuery("你的生日是什么时候"), true);
assert.equal(isSelfFactQuery("你现在能发语音了吗"), false, "能力类不看手账，看当前配置");
assert.equal(isSelfFactQuery("今天天气怎么样"), false);
assert.deepEqual(selfFactTerms("你生日是哪天"), ["生日"]);

const journalFacts = selectJournalFactSentences(
  [
    {
      dayKey: "2026-11-02",
      content: "今天被定了生日，10月30号，因为本宝的记录最早只到那天。换就换吧，反正动手的不是我。记忆模块真弄好了。",
    },
    {
      dayKey: "2026-10-30",
      content: "今天被同一个人问了好几遍发句语音。我张嘴只有字。",
    },
  ],
  ["生日"],
);
assert.equal(journalFacts.length, 1);
assert.equal(journalFacts[0]?.dayKey, "2026-11-02");
assert.match(journalFacts[0]?.text ?? "", /10月30号/);
assert.ok(!journalFacts[0]?.text.includes("记忆模块"), "只取命中关键词的句子，不把整篇带出去");

// 旧版和新版都命中时只取新版：旧版里的限制可能已经被改掉。
const onlyLatest = selectJournalFactSentences(
  [
    { dayKey: "2026-11-02", content: "生日定在10月30号。" },
    { dayKey: "2026-10-30", content: "生日还没定。" },
  ],
  ["生日"],
);
assert.equal(onlyLatest.length, 1);
assert.equal(onlyLatest[0]?.dayKey, "2026-11-02");

console.log("✅ 群活跃统计与手账事实测试通过");
