/**
 * 跨范围自述事实的真实数据库验证（不调模型）。
 *
 * 场景：主人在私聊里给她开通语音。旧全局记忆还写着「她只会发文字，没有语音功能」，
 * 如果不把它废掉，群里问「你能发语音吗 / 第一句语音什么时候」她就会照旧说不会。
 *
 * 这里验两件事：
 * 1. `scope: "character"` 的 ADD 落到全局范围，而不是当前私聊范围；
 * 2. 指向全局条目的 INVALIDATE 能跨范围执行，旧条目退出 ACTIVE。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { applyMemoryChange } from "../server/utils/memory-change-apply";

const prisma = getPrisma();
const owner = await prisma.user.findFirst({ select: { id: true } });
if (!owner) throw new Error("没有用户，无法建临时角色");

let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) console.log("  ✅", name);
  else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

const character = await prisma.character.create({
  data: {
    ownerId: owner.id,
    name: "__自述事实自检__",
    basePrompt: "自检用",
    memoryScopes: {
      create: [
        { scopeType: "CHARACTER_GLOBAL", scopeKey: "self-fact-global:" + Date.now() },
        { scopeType: "USER_PRIVATE", scopeKey: "self-fact-private:" + Date.now(), userId: owner.id },
      ],
    },
  },
  select: { id: true },
});
const scopes = await prisma.memoryScope.findMany({ where: { characterId: character.id }, select: { id: true, scopeType: true } });
const globalScope = scopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")!;
const privateScope = scopes.find((scope) => scope.scopeType === "USER_PRIVATE")!;

const conversation = await prisma.conversation.create({
  data: { characterId: character.id, memoryScopeId: privateScope.id, title: "自检私聊" },
  select: { id: true },
});
const message = await prisma.message.create({
  data: {
    conversationId: conversation.id,
    role: "USER",
    content: "以后你能发语音了",
    occurredAt: new Date("2026-11-02T06:17:00Z"),
    metadata: { authorOpenId: "owner-1", isOwner: true, platform: "qq-onebot" },
  },
  select: { id: true, occurredAt: true },
});
const snapshot = await prisma.memorySnapshot.create({
  data: {
    snapshotKey: "self-fact-test:" + Date.now(),
    memoryScopeId: privateScope.id,
    periodStart: new Date("2026-11-01T16:00:00Z"),
    periodEnd: new Date("2026-11-02T16:00:00Z"),
    summary: "自检",
    structuredContent: {},
  },
  select: { id: true },
});

const stale = await prisma.memoryItem.create({
  data: {
    memoryScopeId: globalScope.id,
    category: "FACT",
    content: "她只会发文字，没有语音功能",
    status: "ACTIVE",
    validFrom: new Date("2026-11-01T00:00:00Z"),
  },
  select: { id: true },
});

const evidence = [{
  id: message.id,
  occurredAt: message.occurredAt,
  conversationId: conversation.id,
  role: "USER" as const,
  isOwner: true,
  platform: "qq-onebot",
  authorOpenId: "owner-1",
  speaker: "主人",
}];

const currentItems = new Map<string, { category: "FACT"; content: string }>();
const globalItems = new Map([[stale.id, { category: "FACT" as const, content: stale.id }]]);
const ctx = {
  memoryScopeId: privateScope.id,
  characterId: character.id,
  snapshotId: snapshot.id,
  actorType: "WORKER" as const,
  auditActionPrefix: "memory.ai_" as const,
  resolvePrevious: async (memoryId: string) => currentItems.get(memoryId) ?? null,
  canTarget: () => false,
  handledMemoryIds: new Set<string>(),
  existingItemSignatures: new Set<string>(),
  existingDedupeKeys: new Set<string>(),
  global: {
    memoryScopeId: globalScope.id,
    resolvePrevious: async (memoryId: string) => globalItems.get(memoryId) ?? null,
    canTarget: (memoryId: string) => globalItems.has(memoryId),
    handledMemoryIds: new Set<string>(),
    existingItemSignatures: new Set<string>(),
    existingDedupeKeys: new Set<string>(),
    existingItems: [{ id: stale.id, category: "FACT" as const, content: "她只会发文字，没有语音功能" }],
  },
};

console.log("\n[1] scope:character 的 ADD 写进全局");
const added = await prisma.$transaction((tx) => applyMemoryChange(tx, ctx, {
  action: "ADD",
  category: "FACT",
  content: "2026-11-02 主人给她配好文字转语音功能，她第一次能出声发语音",
  confidence: 0.92,
  evidenceMessageIds: [message.id],
  scope: "character",
}, evidence));
check("变更已应用", added?.result === "CREATED", added);
const globalAfterAdd = await prisma.memoryItem.findMany({ where: { memoryScopeId: globalScope.id }, orderBy: { createdAt: "desc" } });
const privateItems = await prisma.memoryItem.count({ where: { memoryScopeId: privateScope.id } });
check("新事实在全局范围", globalAfterAdd.some((item) => item.content.includes("配好文字转语音功能")), globalAfterAdd.map((item) => item.content));
check("私聊范围没有多写一条", privateItems === 0, privateItems);

console.log("\n[2] 指向全局条目的 INVALIDATE 跨范围生效");
const invalidated = await prisma.$transaction((tx) => applyMemoryChange(tx, ctx, {
  action: "INVALIDATE",
  category: "FACT",
  content: "旧记忆不再成立",
  confidence: 0.9,
  relatedMemoryId: stale.id,
  evidenceMessageIds: [message.id],
}, evidence));
check("变更已应用", invalidated?.result === "INVALIDATED", invalidated);
const staleAfter = await prisma.memoryItem.findUnique({ where: { id: stale.id } });
check("旧全局条目退出 ACTIVE", staleAfter?.status === "INVALIDATED", staleAfter?.status);
check("旧条目写上 validTo", Boolean(staleAfter?.validTo), staleAfter?.validTo?.toISOString());

console.log("\n[3] 清理");
await prisma.memoryItem.deleteMany({ where: { memoryScopeId: { in: [globalScope.id, privateScope.id] } } });
await prisma.memorySnapshot.deleteMany({ where: { memoryScopeId: { in: [globalScope.id, privateScope.id] } } });
await prisma.auditLog.deleteMany({ where: { characterId: character.id } });
await prisma.conversation.deleteMany({ where: { characterId: character.id } });
await prisma.memoryScope.deleteMany({ where: { characterId: character.id } });
await prisma.character.delete({ where: { id: character.id } });
check("临时数据清理干净", (await prisma.character.count({ where: { id: character.id } })) === 0);

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n跨范围自述事实自检通过。");
