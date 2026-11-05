import assert from "node:assert/strict";
import { parseEventParticipantQuery } from "../server/utils/memory-event-retrieval";
import {
  buildOwnerTimelineGroupRawMessageWhere,
  buildPrivateScopeRawMessageWhere,
  resolveOwnerTimelineGroupScopeIds,
  selectUnambiguousParticipantAccounts,
} from "../server/utils/owner-timeline-retrieval";

assert.equal(parseEventParticipantQuery("我第一次和昔涟互动是哪一天"), "昔涟",
  "互动必须作为人物名边界，不能把动作词拼进人物名。");
assert.equal(parseEventParticipantQuery("我最近一次和小七聊天是什么时候"), "小七",
  "最近一次的自然语言问句应提取完整人物名。");
assert.equal(parseEventParticipantQuery("你第一次见到小七是什么时候"), "小七",
  "见到句式必须识别人物。");
assert.equal(parseEventParticipantQuery("我们第一次见面是什么时候"), null,
  "没有明确人物的见面问句不能把“面”识别成人名。");

assert.deepEqual(selectUnambiguousParticipantAccounts({
  exactDisplayNameIds: ["1484361034"],
  fuzzyDisplayNameIds: ["1484361034", "1962605653"],
}), ["1484361034"], "精确昵称命中时不应被其他人的包含匹配覆盖。");
assert.deepEqual(selectUnambiguousParticipantAccounts({
  exactDisplayNameIds: ["1", "2"],
}), [], "精确昵称映射到多个账号时必须拒绝猜测。");
assert.deepEqual(selectUnambiguousParticipantAccounts({
  aliasIds: ["1"], exactDisplayNameIds: ["2"],
}), [], "精确别名与精确昵称指向不同账号时必须拒绝猜测。");
assert.deepEqual(selectUnambiguousParticipantAccounts({
  fuzzyDisplayNameIds: ["1", "2"],
}), [], "模糊匹配命中多个账号时必须拒绝猜测。");
assert.deepEqual(selectUnambiguousParticipantAccounts({
  fuzzyDisplayNameIds: ["1", "1"],
}), ["1"], "同一账号的重复记录应去重。");

assert.deepEqual(resolveOwnerTimelineGroupScopeIds({
  isOwnerTurn: true, globalScopeId: "global", ownerIdentityScopeId: "owner-identity",
}), ["global", "owner-identity"]);
assert.deepEqual(resolveOwnerTimelineGroupScopeIds({
  isOwnerTurn: false, globalScopeId: "global", ownerIdentityScopeId: "friend-identity",
}), ["global"], "普通好友不能获得身份范围中的历史群消息。");

const range = { start: new Date("2026-10-01T00:00:00.000Z"), end: new Date("2026-11-01T00:00:00.000Z") };
const ownerWhere = buildOwnerTimelineGroupRawMessageWhere({
  memoryScopeIds: ["global", "owner-identity"],
  platform: "qq-onebot",
  participantIds: ["person-uid"],
  range,
});
assert.deepEqual(ownerWhere.conversation, {
  memoryScopeId: { in: ["global", "owner-identity"] },
  externalConversationId: { startsWith: "g:" },
});
assert.equal(ownerWhere.role, "USER");
assert.deepEqual(ownerWhere.AND, [
  { metadata: { path: ["platform"], equals: "qq-onebot" } },
  { OR: [{ metadata: { path: ["authorOpenId"], equals: "person-uid" } }] },
]);
assert.deepEqual(ownerWhere.occurredAt, { gte: range.start, lt: range.end });
assert.deepEqual(buildOwnerTimelineGroupRawMessageWhere({
  memoryScopeIds: ["global"], platform: "qq-onebot", participantIds: [],
}), { id: { equals: "__no_owner_timeline_target__" } },
"目标人物账号为空时必须 fail closed，不能退化成整群查询。");

const privateWhere = buildPrivateScopeRawMessageWhere("owner-private", range);
assert.deepEqual(privateWhere.conversation, {
  memoryScopeId: "owner-private",
  NOT: { externalConversationId: { startsWith: "g:" } },
}, "私聊原文查询必须在数据库层排除旧群会话。");
assert.deepEqual(privateWhere.occurredAt, { gte: range.start, lt: range.end });

console.log("主人时间线检索测试通过：人物解析、账号消歧、主人范围授权、目标群原文过滤、私聊群会话隔离。");
