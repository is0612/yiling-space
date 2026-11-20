import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { loadPromptEventCandidates } from "../server/utils/prompt-event-candidates";
import { parseEventParticipantQuery, selectEventsForPrompt } from "../server/utils/memory-event-retrieval";
import { resolveParticipantAccounts } from "../server/utils/participant-names";

const connectionString = process.env.DATABASE_URL ?? "";
assert.equal(process.env.YILING_CHAT_ISOLATED_DB, "1");
assert(/^\/yiling_chat_test_[a-f0-9]{32}$/.test(new URL(connectionString).pathname), "Disposable chat database required.");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const userId = randomUUID();
const characterId = randomUUID();
const global = randomUUID();
const own = randomUUID();
const other = randomUUID();
const groupA = randomUUID();
const groupB = randomUUID();
const account = "123456789"; // Synthetic account, never a real identity.
const now = new Date("2026-11-20T10:00:00Z");
const firstPerson = randomUUID();
const firstTopic = randomUUID();
const boundaryInside = randomUUID();
const refs = [{ kind: "external", platform: "qq-onebot", externalId: account, displayName: "旧昵称" }];
const base = { memoryScopeId: global, conversationId: groupA, dayKey: "2026-11-20", detail: "合成事件", participants: [], keywords: [] };
try {
  await prisma.user.create({ data: { id: userId, username: `events-${userId}`, passwordHash: "synthetic-only" } });
  await prisma.character.create({ data: {
    id: characterId, ownerId: userId, name: "忆泡验收角色", basePrompt: "synthetic-only",
    memoryScopes: { create: [
      { id: global, scopeType: "CHARACTER_GLOBAL", scopeKey: `global:${characterId}` },
      { id: own, scopeType: "USER_PRIVATE", scopeKey: `own:${characterId}`, userId },
      { id: other, scopeType: "EXTERNAL_IDENTITY", scopeKey: `other:${characterId}` },
    ] },
  } });
  await prisma.conversation.createMany({ data: [
    { id: groupA, characterId, memoryScopeId: global, title: "合成群甲" },
    { id: groupB, characterId, memoryScopeId: global, title: "合成群乙" },
  ] });
  await prisma.message.create({ data: { conversationId: groupA, role: "USER", content: "合成改名证据", occurredAt: now,
    metadata: { platform: "qq-onebot", authorOpenId: account, authorDisplayName: "新昵称" } } });
  await prisma.memoryEvent.createMany({ data: [
    ...Array.from({ length: 210 }, (_, i) => ({ ...base, title: "近期园艺", occurredAt: new Date(now.getTime() + i * 1000), dedupeKey: `recent:${i}` })),
    ...Array.from({ length: 400 }, (_, i) => ({ ...base, dayKey: "2024-01-01", title: "早期无关散步", occurredAt: new Date(Date.parse("2024-01-01T00:00:00Z") + i * 1000), dedupeKey: `early:${i}` })),
    ...Array.from({ length: 360 }, (_, i) => ({ ...base, dayKey: "2025-06-01", title: "和旧昵称继续交流", participants: ["旧昵称"], participantRefs: refs,
      occurredAt: new Date(Date.parse("2025-06-01T00:00:00Z") + i * 1000), dedupeKey: `person:${i}` })),
    { ...base, id: firstPerson, dayKey: "2025-01-02", title: "与旧昵称初次见面", participants: ["旧昵称"], participantRefs: refs,
      occurredAt: new Date("2025-01-02T09:00:00+08:00"), dedupeKey: "first-person" },
    { ...base, id: firstTopic, dayKey: "2025-03-01", title: "第一次制作星砂风铃", keywords: ["星砂风铃"],
      occurredAt: new Date("2025-03-01T12:00:00+08:00"), dedupeKey: "first-topic" },
    { ...base, dayKey: "2026-01-01", title: "后来再做星砂风铃", keywords: ["星砂风铃"],
      occurredAt: new Date("2026-01-01T12:00:00+08:00"), dedupeKey: "later-topic" },
    { ...base, id: boundaryInside, dayKey: "2025-01-02", title: "凌晨旧事", occurredAt: new Date("2025-01-02T00:30:00+08:00"), dedupeKey: "day-inside" },
    { ...base, dayKey: "2025-01-01", title: "前一天的旧事", occurredAt: new Date("2025-01-01T23:30:00+08:00"), dedupeKey: "day-before" },
    { ...base, dayKey: "2025-01-03", title: "第二天边界", occurredAt: new Date("2025-01-03T00:00:00+08:00"), dedupeKey: "day-after" },
    { ...base, dayKey: "2023-01-01", title: "已归档旧昵称事件", status: "ARCHIVED", participants: ["旧昵称"], participantRefs: refs,
      occurredAt: new Date("2023-01-01T00:00:00Z"), dedupeKey: "archived" },
    { ...base, conversationId: groupB, dayKey: "2023-01-01", title: "另一个群的旧昵称事件", participants: ["旧昵称"], participantRefs: refs,
      occurredAt: new Date("2023-01-01T00:00:00Z"), dedupeKey: "other-group" },
    { ...base, memoryScopeId: own, conversationId: null, dayKey: "2022-01-01", title: "主人私人旧事", participants: ["旧昵称"], participantRefs: refs,
      occurredAt: new Date("2022-01-01T00:00:00Z"), dedupeKey: "own-private" },
    { ...base, memoryScopeId: other, conversationId: null, dayKey: "2021-01-01", title: "别人私人旧事", participants: ["旧昵称"], participantRefs: refs,
      occurredAt: new Date("2021-01-01T00:00:00Z"), dedupeKey: "other-private" },
  ] });
  const legacy = await prisma.memoryEvent.findMany({ where: { memoryScopeId: global, status: "ACTIVE", conversationId: groupA },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 200 });
  assert(!legacy.some(event => [firstPerson, firstTopic, boundaryInside].includes(event.id)), "Fixture must reproduce the recent-window miss.");
  const participantIds = await resolveParticipantAccounts(prisma, "新昵称", { characterId, platform: "qq-onebot" });
  assert.deepEqual(participantIds, [account], "Use the actual identity resolver, not a fabricated rename map.");
  const queryIds = async (query: string) => {
    const name = parseEventParticipantQuery(query);
    return name ? resolveParticipantAccounts(prisma, name, { characterId, platform: "qq-onebot" }) : [];
  };
  const load = async (query: string) => loadPromptEventCandidates(prisma, {
    readableScopeIds: [global], query, groupConversationId: groupA, participantIds: await queryIds(query), now, timeZone: "Asia/Shanghai",
  });
  const select = async (query: string) => selectEventsForPrompt(query, await load(query), { participantIds: await queryIds(query), now, timeZone: "Asia/Shanghai" });
  const person = await select("第一次见到新昵称是什么时候");
  assert.equal(person.items[0]?.id, firstPerson, "Rename/account lookup must reach the oldest person event, beyond both recent and supplemental caps.");
  const topic = await select("第一次制作星砂风铃是什么时候");
  assert.equal(topic.items[0]?.id, firstTopic, "Filter the topic before the cap; early unrelated events must not crowd out its first occurrence.");
  const day = await select("2025-01-02那天发生了什么");
  assert.deepEqual(new Set(day.items.map(event => event.id)), new Set([firstPerson, boundaryInside]), "Date filtering uses the character timezone and a half-open interval.");
  const unknown = await select("第一次见到陌生昵称是什么时候");
  assert.equal(unknown.items.length, 0, "An unknown participant must not inherit somebody else's first event.");
  const absent = await select("2020-01-02那天发生了什么");
  assert.equal(absent.items.length, 0);
  const pool = await load("第一次见到新昵称是什么时候");
  assert.equal(new Set(pool.map(event => event.id)).size, pool.length, "Recent and historical candidates are deduplicated.");
  assert(pool.every(event => event.memoryScopeId === global));
  assert(!pool.some(event => /另一个群|私人|已归档/.test(event.title)));
  assert.deepEqual(await loadPromptEventCandidates(prisma, { readableScopeIds: [global], query: "2025-01-02", groupConversationId: null }), []);
  assert.deepEqual(await loadPromptEventCandidates(prisma, { readableScopeIds: [], query: "第一次见到新昵称" }), []);
  const privatePool = await loadPromptEventCandidates(prisma, { readableScopeIds: [own], query: "旧昵称", now });
  assert.equal(privatePool.length, 1, "Small authorized private histories remain available without supplemental scans.");
  console.log("Layered event retrieval acceptance:", JSON.stringify({ oldDate: "candidate+selected", renamedFirstPerson: "candidate+selected", firstTopic: "candidate+selected", groupAndPrivateIsolation: "passed", answerCorrect: "unverified: no real model called" }));
} finally {
  await prisma.conversation.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
