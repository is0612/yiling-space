import assert from "node:assert/strict";
import {
  buildSocialProactiveContactSegments,
  evaluateSocialProactiveContactGate,
  type SocialProactiveContactGateInput,
} from "../server/utils/social-proactive-contact-policy";

const now = new Date("2026-11-09T12:00:00.000Z");
const base: SocialProactiveContactGateInput = {
  proactiveContactEnabled: true,
  relationshipStage: "FRIEND",
  relationshipStatus: "NORMAL",
  identityKind: "HUMAN",
  friendChatPolicy: "DEFAULT",
  channelAvailable: true,
  hasCommonGroup: true,
  groupMode: "ambient",
  quietHours: false,
  targetMemberVerified: true,
  targetIsAi: false,
  consecutiveAiRounds: 0,
  maxConsecutiveAiRounds: 3,
  sentToday: 0,
  dailyLimit: 2,
  lastContactAt: null,
  cooldownMs: 60 * 60_000,
  now,
};

function gate(overrides: Partial<SocialProactiveContactGateInput> = {}) {
  return evaluateSocialProactiveContactGate({ ...base, ...overrides });
}

assert.deepEqual(gate(), { allowed: true, reason: "ok" });
assert.equal(gate({ proactiveContactEnabled: false }).reason, "not_authorized",
  "主动联系授权必须独立存在");
assert.equal(gate({ relationshipStage: "ACQUAINTANCE" }).reason, "relationship_not_close");
assert.equal(gate({ relationshipStatus: "DISTANT" }).reason, "relationship_not_healthy");
assert.equal(gate({ relationshipStatus: "UNOBSERVED" }).reason, "relationship_not_healthy");
assert.equal(gate({ friendChatPolicy: "BLOCK" }).reason, "friend_blocked");
assert.equal(gate({ identityKind: "AI" }).reason, "ai_friend_not_allowed",
  "AI 好友不能绕过现有默认禁聊策略");
assert.equal(gate({ identityKind: "AI", friendChatPolicy: "ALLOW", targetIsAi: true }).reason, "ok",
  "人工允许交流的 AI 好友可以成为主动联系对象");
assert.equal(gate({ channelAvailable: false }).reason, "channel_unavailable");
assert.equal(gate({ hasCommonGroup: false }).reason, "no_common_group");
assert.equal(gate({ groupMode: "mention" }).reason, "group_mode_forbids");
assert.equal(gate({ groupMode: null }).reason, "group_mode_forbids",
  "未知群模式必须 fail closed");
assert.equal(gate({ quietHours: true }).reason, "quiet_hours",
  "共同群的安静时段内不主动联系");
assert.equal(gate({ targetMemberVerified: false }).reason, "target_not_verified",
  "不能用历史群成员记录代替发送前核验");
assert.equal(gate({ targetIsAi: true, consecutiveAiRounds: 3 }).reason, "ai_dialogue_limit");
assert.equal(gate({ sentToday: 2 }).reason, "daily_limit");
assert.equal(gate({ dailyLimit: 0 }).reason, "daily_limit");
assert.equal(gate({
  lastContactAt: new Date(now.getTime() - 30 * 60_000),
}).reason, "friend_cooldown");
assert.equal(gate({
  lastContactAt: new Date(now.getTime() - 60 * 60_000),
}).reason, "ok", "刚好到冷却边界时放行");

assert.deepEqual(buildSocialProactiveContactSegments("123456789", "  最近还好吗？  "), [
  { type: "at", data: { qq: "123456789" } },
  { type: "text", data: { text: " 最近还好吗？" } },
]);
assert.throws(() => buildSocialProactiveContactSegments("[CQ:at,qq=123456789]", "你好"), /invalid_target_qq/);
assert.throws(() => buildSocialProactiveContactSegments("123456789", "  "), /empty_contact_content/);


console.log("social-proactive-contact-policy: 全部通过");
