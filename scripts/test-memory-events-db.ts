/**
 * 第二遍检测：忆泡链路的真实数据库集成验证（不调模型）。
 *
 * 与 `verify:local` 的区别：那套跑的是仓库既有单测；这里用自己的临时角色，
 * 把「去重 / dayKey / 状态 / 查询过滤」这些易错点直接在 PostgreSQL 上验一遍，
 * 跑完把临时数据全部删掉。
 */
// 先加载 .env：直接 `yarn test:memory-events-db` 时没有外层 export，必须自己读。
import "dotenv/config";
import assert from "node:assert/strict";
import { getPrisma } from "../server/utils/prisma";
import { applyMemoryEvents } from "../server/utils/memory-change-apply";
import { makeEventDedupeKey } from "../server/utils/memory-ai";
import { toMemoryTimelineDtos } from "../server/utils/memory-timeline-dto";
import { ensureExternalIdentityScope } from "../server/utils/identity-scope";

const prisma = getPrisma();
const owner = await prisma.user.findFirst({ select: { id: true } });
if (!owner) throw new Error("没有用户，无法建临时角色");

let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    console.log("  ✅", name);
  } else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

const character = await prisma.character.create({
  data: {
    ownerId: owner.id,
    name: "__忆泡自检__",
    basePrompt: "自检用",
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: "global:" + Date.now() } },
  },
  select: { id: true },
});
const scope = await prisma.memoryScope.findFirstOrThrow({
  where: { characterId: character.id },
  select: { id: true },
});

const friendUid = "social-test-" + character.id;
const friendIdentity = await prisma.externalIdentity.create({
  data: { platform: "qq-onebot", platformUid: friendUid, status: "UNVERIFIED" },
  select: { id: true },
});
const friendRelation = await ensureExternalIdentityScope(character.id, "qq-onebot", friendUid, friendIdentity.id);

const conversation = await prisma.conversation.create({
  data: { characterId: character.id, memoryScopeId: scope.id, title: "自检对话" },
  select: { id: true },
});

// 两条消息：一条在东八区 10-30 23:30（UTC 仍是 10-30 15:30），一条在 10-31 00:30。
// 第一条挂外部账号（群友），第二条标主人 —— 用来验证参与者引用怎么推导。
const messageLate = await prisma.message.create({
  data: {
    conversationId: conversation.id,
    role: "USER",
    content: "深夜聊到很晚",
    occurredAt: new Date("2026-10-30T15:30:00Z"),
    metadata: { authorOpenId: friendUid, platform: "qq-onebot", authorDisplayName: "小明" },
  },
  select: { id: true, occurredAt: true },
});
const messageEarly = await prisma.message.create({
  data: {
    conversationId: conversation.id,
    role: "USER",
    content: "凌晨又聊了一句",
    occurredAt: new Date("2026-10-30T16:30:00Z"),
    metadata: { authorOpenId: "owner-1", platform: "qq-onebot", isOwner: true },
  },
  select: { id: true, occurredAt: true },
});
const evidence = new Map([
  [messageLate.id, {
    id: messageLate.id,
    role: "USER" as const,
    occurredAt: messageLate.occurredAt,
    conversationId: conversation.id,
    authorOpenId: friendUid,
    platform: "qq-onebot",
  }],
  [messageEarly.id, {
    id: messageEarly.id,
    role: "USER" as const,
    occurredAt: messageEarly.occurredAt,
    conversationId: conversation.id,
    authorOpenId: "owner-1",
    platform: "qq-onebot",
    isOwner: true,
  }],
]);

const base = {
  precision: "exact" as const,
  keywords: ["自检"],
  participants: ["小明"],
  confidence: 0.9,
};

console.log("\n[1] 首次写入 + 跨零点 dayKey");
const first = await prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "DRAFT" },
  [
    {
      ...base,
      occurredAt: messageLate.occurredAt.toISOString(),
      title: "和小明在海边游泳",
      detail: "下午去的银滩",
      evidenceMessageIds: [messageLate.id],
    },
    {
      ...base,
      occurredAt: messageEarly.occurredAt.toISOString(), // UTC 10-30 16:30 = 东八区 10-31 00:30
      title: "凌晨吃了夜宵",
      detail: "半夜出去吃东西",
      evidenceMessageIds: [messageEarly.id],
    },
  ],
  evidence,
));
check("两条不同事件都写入", first.applied.length === 2, first);
const lateEvent = await prisma.memoryEvent.findFirst({ where: { memoryScopeId: scope.id, title: "和小明在海边游泳" } });
const earlyEvent = await prisma.memoryEvent.findFirst({ where: { memoryScopeId: scope.id, title: "凌晨吃了夜宵" } });
check("23:30 那条归到 10-30", lateEvent?.dayKey === "2026-10-30", lateEvent?.dayKey);
check("00:30 那条归到 10-31（跨零点不串天）", earlyEvent?.dayKey === "2026-10-31", earlyEvent?.dayKey);
check(
  "全部证据消息都回写（不只第一条）",
  (lateEvent?.sourceMessageIds ?? []).includes(messageLate.id) && (lateEvent?.sourceMessageIds ?? []).length === 1,
  lateEvent?.sourceMessageIds,
);
check("忆泡记录所属会话（供按群检索）", lateEvent?.conversationId === conversation.id, lateEvent?.conversationId);
const linkedExperience = await prisma.socialExperience.findMany({
  where: { scopeId: friendRelation.scopeId },
  select: { memoryEventId: true, sourceKey: true },
});
check(
  "群聊忆泡自动关联到参与者自己的角色关系",
  linkedExperience.length === 1 && linkedExperience[0]?.memoryEventId === lateEvent?.id,
  linkedExperience,
);
check(
  "主人单独发言的忆泡不误关联到群友关系",
  await prisma.socialExperience.count({ where: { scopeId: friendRelation.scopeId, memoryEventId: earlyEvent?.id ?? "" } }) === 0,
);

// 参与者引用：从证据消息的作者推导，不是模型写的显示名。
const lateRefs = (lateEvent?.participantRefs ?? []) as Array<Record<string, unknown>>;
const earlyRefs = (earlyEvent?.participantRefs ?? []) as Array<Record<string, unknown>>;
check(
  "群友的忆泡推出 external 引用",
  lateRefs.some((ref) => ref.kind === "external" && ref.externalId === friendUid && ref.platform === "qq-onebot"),
  lateRefs,
);
check(
  "主人发的忆泡推出 owner 引用",
  earlyRefs.some((ref) => ref.kind === "owner"),
  earlyRefs,
);

console.log("\n[2] 精确去重（同标题重跑）");
const repeat = await prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "FINAL" },
  [{ ...base, occurredAt: messageLate.occurredAt.toISOString(), title: "和小明在海边游泳", detail: "重复", evidenceMessageIds: [messageLate.id] }],
  evidence,
));
check("同标题不会被写第二遍", repeat.applied.length === 0 && repeat.skipped === 1, repeat);

console.log("\n[3] 近义去重（换说法的同一件事）");
const near = await prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "FINAL" },
  [{ ...base, occurredAt: messageLate.occurredAt.toISOString(), title: "和小明一起在海边游泳玩水", detail: "换个说法", evidenceMessageIds: [messageLate.id] }],
  evidence,
));
check("改写标题保守保留，不凭公共子串吞事实", near.applied.length === 1 && near.skipped === 0, near);
check(
  "同一底层证据在重复提炼中只累计一次",
  await prisma.socialExperience.count({ where: { scopeId: friendRelation.scopeId } }) === 1,
);


console.log("\n[4] 只撞人名的短标题");
const shortSame = await prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "FINAL" },
  [{ ...base, occurredAt: messageLate.occurredAt.toISOString(), title: "和小明在银滩的事", detail: "同一天同一个人", evidenceMessageIds: [messageLate.id] }],
  evidence,
));
check("同一天同一人不同标题仍保留", shortSame.applied.length === 1, shortSame);
const shortOther = await prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "FINAL" },
  [{ ...base, participants: ["小月"], occurredAt: messageLate.occurredAt.toISOString(), title: "和小月在银滩的事", detail: "不同的人", evidenceMessageIds: [messageLate.id] }],
  evidence,
));
check("参与人不同（非角色词）→ 不判重", shortOther.applied.length === 1, shortOther);

console.log("\n[5] 软删除后时间线不再出现");
const before = await prisma.memoryEvent.count({ where: { memoryScopeId: scope.id, status: "ACTIVE" } });
await prisma.memoryEvent.update({ where: { id: lateEvent!.id }, data: { status: "ARCHIVED" } });
const after = await prisma.memoryEvent.count({ where: { memoryScopeId: scope.id, status: "ACTIVE" } });
check("隐藏一条后 ACTIVE 数量 -1", after === before - 1, { before, after });
const timeline = toMemoryTimelineDtos(
  {
    messages: [],
    memoryItems: [],
    snapshots: [],
    events: await prisma.memoryEvent.findMany({
      where: { memoryScopeId: scope.id, status: "ACTIVE" },
      select: { id: true, occurredAt: true, timeOfDay: true, place: true, participants: true, title: true, detail: true, state: true, memoryScope: { select: { scopeType: true } } },
    }),
  },
  "Asia/Shanghai",
);
check("时间线只含 ACTIVE 的忆泡", timeline.every((entry) => entry.type === "memoryEvent" && entry.title !== "和小明在海边游泳"), timeline.map((entry) => entry.title));

console.log("\n[6] 跨会话证据显式拒绝并回滚整批");
// 按天任务会把桌面对话和群聊放进同一次模型调用；模型偶尔会把两段不相干的对话写成
// 一条事件。参与者引用若照单全收，私聊事件就会带上群成员。
const groupConversation = await prisma.conversation.create({
  data: { characterId: character.id, memoryScopeId: scope.id, title: "自检群聊" },
  select: { id: true },
});
const groupMessage = await prisma.message.create({
  data: {
    conversationId: groupConversation.id,
    role: "USER",
    content: "群里有人说话",
    occurredAt: new Date("2026-10-30T17:00:00Z"),
    metadata: { authorOpenId: "group-1", platform: "qq-onebot" },
  },
  select: { id: true, occurredAt: true },
});
const mixedEvidence = new Map([
  ...evidence,
  [groupMessage.id, {
    id: groupMessage.id,
    role: "USER" as const,
    occurredAt: groupMessage.occurredAt,
    conversationId: groupConversation.id,
    authorOpenId: "group-1",
    platform: "qq-onebot",
  }],
]);
await assert.rejects(prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "FINAL" },
  [{
    ...base,
    occurredAt: messageLate.occurredAt.toISOString(),
    title: "混合来源失败前的有效事件",
    detail: "整批失败时这条也应回滚",
    evidenceMessageIds: [messageLate.id],
  }, {
    ...base,
    occurredAt: messageLate.occurredAt.toISOString(),
    title: "桌面聊了明天的安排",
    detail: "证据里混进了一条群消息",
    evidenceMessageIds: [messageLate.id, groupMessage.id],
  }],
  mixedEvidence,
)), /EVENT_MIXED_CONVERSATION_EVIDENCE/);
const mixedEvent = await prisma.memoryEvent.findFirst({ where: { memoryScopeId: scope.id, title: "桌面聊了明天的安排" } });
check("跨会话证据显式拒绝，事务不落部分事件", mixedEvent === null, mixedEvent);
check("同事务前一条有效事件也回滚", await prisma.memoryEvent.count({ where: { memoryScopeId: scope.id, title: "混合来源失败前的有效事件" } }) === 0);
await prisma.message.delete({ where: { id: groupMessage.id } });
await prisma.conversation.delete({ where: { id: groupConversation.id } });

console.log("\n[7] 参与者补名：泛称换成真名、她自己不进相关人物");
// 线上那条「答题接龙」的形状：participants = {角色自己, 群友}，证据里只有一个外部成员。
// 落库前必须变成真实昵称，否则这条忆泡以后谁都查不出那个人是谁。
const namedEvidence = new Map([[messageLate.id, {
  id: messageLate.id,
  role: "USER" as const,
  occurredAt: messageLate.occurredAt,
  conversationId: conversation.id,
  authorOpenId: "friend-1",
  platform: "qq-onebot",
  speaker: "小明",
}]]);
await prisma.$transaction((tx) => applyMemoryEvents(
  tx,
  {
    memoryScopeId: scope.id, characterId: character.id, snapshotId: null,
    timeZone: "Asia/Shanghai", state: "FINAL", characterName: "__忆泡自检__",
  },
  [{
    ...base,
    occurredAt: messageLate.occurredAt.toISOString(),
    title: "群里玩了答题接龙",
    detail: "她出题，群友答对了",
    participants: ["__忆泡自检__", "群友"],
    evidenceMessageIds: [messageLate.id],
  }],
  namedEvidence,
));
const namedEvent = await prisma.memoryEvent.findFirst({
  where: { memoryScopeId: scope.id, title: "群里玩了答题接龙" },
});
check("泛称补成真实昵称", namedEvent?.participants.join("、") === "小明", namedEvent?.participants);
check("她自己不进相关人物", !(namedEvent?.participants ?? []).includes("__忆泡自检__"), namedEvent?.participants);
check(
  "引用同时记住当时的叫法",
  ((namedEvent?.participantRefs ?? []) as Array<Record<string, unknown>>)
    .some((ref) => ref.kind === "external" && ref.displayName === "小明"),
  namedEvent?.participantRefs,
);

console.log("\n[8] 本地日期、会话隔离与旧 UTC 键兼容");
const collisionTitle = "主人提醒明天提交报告";
const collisionAt = new Date("2026-11-01T10:00:00+08:00");
const collisionNextAt = new Date("2026-11-02T01:00:00+08:00");
const otherConversation = await prisma.conversation.create({
  data: { characterId: character.id, memoryScopeId: scope.id, title: "自检另一群" },
  select: { id: true },
});
const applyCollision = (at: Date, conversationId: string, title = collisionTitle) =>
  prisma.$transaction((tx) => applyMemoryEvents(tx,
    { memoryScopeId: scope.id, characterId: character.id, snapshotId: null, timeZone: "Asia/Shanghai", state: "FINAL" },
    [{ ...base, participants: ["主人", "小明"], occurredAt: at.toISOString(), title, detail: title, evidenceMessageIds: [messageLate.id] }],
    new Map([[messageLate.id, { id: messageLate.id, occurredAt: at, conversationId }]]),
  ));
const collisionFirst = await applyCollision(collisionAt, conversation.id);
const collisionNext = await applyCollision(collisionNextAt, conversation.id);
const collisionOther = await applyCollision(collisionAt, otherConversation.id);
check("跨本地日期同标题均落库", collisionFirst.applied.length === 1 && collisionNext.applied.length === 1, { collisionFirst, collisionNext });
check("不同群同标题均落库", collisionOther.applied.length === 1, collisionOther);
const distinctFact = await applyCollision(collisionAt, conversation.id, "主人提醒明天参加体检");
check("同会话同人通用前缀不同事项不吞", distinctFact.applied.length === 1, distinctFact);
const exactRepeat = await applyCollision(collisionAt, conversation.id);
check("v2 精确重跑幂等", exactRepeat.applied.length === 0 && exactRepeat.skipped === 1, exactRepeat);
await prisma.memoryEvent.update({
  where: { id: collisionFirst.applied[0]!.id },
  data: { dedupeKey: makeEventDedupeKey(collisionAt, collisionTitle) },
});
const legacyRepeat = await applyCollision(collisionAt, conversation.id, collisionTitle + "！");
check("旧 key 同本地日同会话规范化标题重跑幂等", legacyRepeat.applied.length === 0 && legacyRepeat.skipped === 1, legacyRepeat);
// 删除新行后再试，确保真正命中旧 UTC 碰撞而非已有 v2 行。
await prisma.memoryEvent.deleteMany({ where: { id: { in: [collisionNext.applied[0]!.id, collisionOther.applied[0]!.id] } } });
const legacyNext = await applyCollision(collisionNextAt, conversation.id);
const legacyOther = await applyCollision(collisionAt, otherConversation.id);
check("旧 UTC 键碰撞不吞次日本地日期", legacyNext.applied.length === 1, legacyNext);
check("旧 key 不跨会话吞同标题", legacyOther.applied.length === 1, legacyOther);
await prisma.memoryEvent.deleteMany({ where: { conversationId: otherConversation.id } });
await prisma.conversation.delete({ where: { id: otherConversation.id } });

console.log("\n[9] 清理");
// 顺序不能反：memory_scopes 对 character 是 Restrict，先清范围下的数据再删角色。
await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: scope.id } });
await prisma.memoryEventDay.deleteMany({ where: { memoryScopeId: scope.id } });
await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
await prisma.conversation.delete({ where: { id: conversation.id } });
await prisma.memoryScope.delete({ where: { id: friendRelation.scopeId } });
await prisma.externalIdentity.delete({ where: { id: friendIdentity.id } });
await prisma.memoryScope.delete({ where: { id: scope.id } });
await prisma.character.delete({ where: { id: character.id } });
check("临时角色与事件清理干净", (await prisma.memoryEvent.count({ where: { memoryScopeId: scope.id } })) === 0);

console.log(failures === 0 ? "\n第二遍检测通过：跨零点归属、本地日与会话隔离、精确与旧键去重、不同事项保留、软删除过滤、混合来源回滚、清理。" : `\n第二遍检测有 ${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
