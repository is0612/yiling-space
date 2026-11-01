import assert from "node:assert/strict";
import {
  buildGroupMemberDeltas, buildStoredMessageMetadata, resolveOwnerPrivateScopeRepair,
} from "../server/utils/channel-adapter/pipeline";
import { readSourceMessageIsOwner } from "../server/utils/conversation-message";

/**
 * 渠道消息落库 metadata 的单元测试。
 *
 * 重点锁 `mentionTargets`：群聊里同时跑着好几个 bot，别人 @ 另一个号说的话
 * 如果没被落库，提炼忆泡时就只能靠猜 —— 于是出现「群友嫌她 AI 味太浓」其实在说别人。
 */

const base = {
  platform: "qq-onebot",
  storedReason: "replied" as const,
  message: { authorOpenId: "556", content: "你好" },
};

assert.equal(
  buildStoredMessageMetadata(base).mentionTargets,
  undefined,
  "没有 @ 段时不能凭空写 mentionTargets。",
);
assert.deepEqual(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "@别人 你今天怎么没来", mentionTargets: ["other"] },
  }).mentionTargets,
  ["other"],
  "@ 别人的消息要标 other，提炼时才知道这句话不是冲她说的。",
);
assert.deepEqual(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "@她 在吗", mentionTargets: ["self", "all"] },
  }).mentionTargets,
  ["self", "all"],
  "@ 她 / @全体 要原样保留。",
);
assert.equal(
  buildStoredMessageMetadata({ ...base, storedReason: "mentioned" }).storedReason,
  "mentioned",
  "被闸门挡下的点名轮次要标 mentioned，方便按原因做保留策略。",
);
assert.equal(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "222", content: "在吗", speaker: { isOwner: true }, member: "member_1" },
  }).isOwner,
  true,
  "主人发的消息要标 isOwner，群聊提炼才认得出主人。",
);
assert.equal(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "管理命令仅管理员可用。", member: "member_3" },
  }).systemBroadcast,
  true,
  "别的机器人的命令回执要标 systemBroadcast，后面整批跳过。",
);
assert.equal(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "今天好热", voices: [{ url: "x" }] },
  }).hasVoice,
  true,
  "语音转写落库要标 hasVoice。",
);

// ── 群成员归属（group_members）──────────────────────────────────────────────
// 这张表决定「这个屋里出现过谁」，熟客榜靠它做「按群分」。最容易写错的是聚合：
// 同一人一轮说多句要合成一条、时间取最早/最晚而不是数组首尾、昵称取最新。

const t1 = new Date("2026-11-01T10:00:00Z");
const t2 = new Date("2026-11-01T10:00:05Z");
const t3 = new Date("2026-11-01T10:00:09Z");

const deltas = buildGroupMemberDeltas([
  { authorOpenId: "1001", authorDisplayName: "昔涟", occurredAt: t2 },
  // 同一个人再说一句，中间夹着别人 —— 顺序不能决定区间。
  { authorOpenId: "1002", authorDisplayName: "鱼小四", occurredAt: t1 },
  { authorOpenId: "1001", authorDisplayName: "昔涟（改名）", occurredAt: t3 },
  // 空 uid（NoneBot 的某些事件没有作者）不能凭空建一条成员。
  { authorOpenId: "   ", authorDisplayName: "幽灵", occurredAt: t1 },
]);

assert.equal(deltas.length, 2, "一轮里同一人说了两句，成员表只该有一条。");
const first = deltas.find((row) => row.platformUid === "1001");
assert(first, "发言人要进成员增量。");
assert.equal(first?.count, 2, "同一轮说两句要累加两次。");
assert.equal(first?.firstSpokeAt.getTime(), t2.getTime(), "首次发言取最早那条，不是数组第一条。");
assert.equal(first?.lastSpokeAt.getTime(), t3.getTime(), "最后发言取最晚那条。");
assert.equal(first?.displayName, "昔涟（改名）", "昵称取最新一条：群里改群名片很频繁。");
assert(!deltas.some((row) => row.platformUid === ""), "空 uid 不能建成员行。");
assert(
  deltas.find((row) => row.platformUid === "1002")?.displayName === "鱼小四",
  "没有 displayName 的人不能凭空编一个名字。",
);
assert.equal(buildGroupMemberDeltas([]).length, 0, "空批次不产生任何成员行。");
assert.equal(
  buildGroupMemberDeltas([{ authorOpenId: "", authorPlatformUid: "2002", occurredAt: t1 }])[0]?.platformUid,
  "2002",
  "authorPlatformUid 优先于 authorOpenId（前者才是平台稳定 id）。",
);

// ── 提炼时的「主人」判定 ───────────────────────────────────────────────────
// 桌面对话没有渠道账号，唯一能进来的人就是角色主人；漏标的话，私聊忆泡只剩一个
// self 引用，读起来像她自己跟自己发生了这件事。群聊/渠道仍只认 metadata.isOwner。
assert.equal(
  readSourceMessageIsOwner({ source: "yiling-chat-ui" }, { origin: "本地对话", role: "USER" }),
  true,
  "桌面对话的 USER 消息就是主人说的。",
);
assert.equal(
  readSourceMessageIsOwner({ source: "yiling-chat-ui" }, { origin: "本地对话", role: "ASSISTANT" }),
  false,
  "她自己的消息不能标成主人。",
);
assert.equal(
  readSourceMessageIsOwner({ authorOpenId: "556" }, { origin: "私聊", role: "USER" }),
  false,
  "渠道私聊里的普通用户不是主人，仍然只认 isOwner。",
);
assert.equal(
  readSourceMessageIsOwner({ isOwner: true }, { origin: "QQ群 123456", role: "USER" }),
  true,
  "群聊里渠道明确标了 isOwner 的才是主人。",
);

// ── 主人私聊会话归位 ───────────────────────────────────────────────────────
// 会话按 (binding, externalConversationId) 复用：早于「主人专属范围」创建的会话还挂在
// EXTERNAL_IDENTITY 上，不迁移的话主人之后说的话不排忆泡、也进不了私人记忆。
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: true, ownerPrivateScopeId: "owner-scope", currentScopeId: "external-scope" }),
  "owner-scope",
  "主人发言时，挂在外部身份范围上的老会话要迁到主人私人范围。",
);
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: true, ownerPrivateScopeId: "owner-scope", currentScopeId: "owner-scope" }),
  null,
  "已经在主人范围里就不用再写。",
);
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: false, ownerPrivateScopeId: "owner-scope", currentScopeId: "external-scope" }),
  null,
  "不是主人的私聊绝不往主人范围搬 —— 猜错等于把主人的私聊暴露给外人。",
);
assert.equal(
  resolveOwnerPrivateScopeRepair({ isOwnerTurn: true, ownerPrivateScopeId: null, currentScopeId: "external-scope" }),
  null,
  "没有主人私人范围时什么都不做。",
);

console.log("渠道消息 metadata 测试通过：无 @ / @ 别人 / @ 她与 @全体 / mentioned / 主人 / 系统播报 / 语音 / 群成员归属聚合 / 提炼主人判定 / 主人私聊归位。");
