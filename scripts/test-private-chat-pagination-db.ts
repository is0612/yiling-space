import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import handler from "../server/api/characters/[id]/private-chats.get";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";

const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const ownerId = randomUUID();
const strangerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const conversationId = randomUUID();
const occurredAt = new Date("2026-11-01T12:00:00.000Z");
const router = createRouter();
router.get("/characters/:id/private-chats", handler);
const app = createApp();
app.use(router);
const server = createServer(toNodeListener(app));
let token = "";
let strangerToken = "";
let base = "";
type Page = {
  selectedConversationId: string;
  messages: Array<{ id: string; occurredAt: string }>;
  hasMore: boolean;
  nextCursor: { before: string; beforeId: string } | null;
  totals: { chats: number; messages: number };
};
async function request(query: Record<string, string> = {}, cookie = token) {
  const params = new URLSearchParams({ conversationId, ...query });
  const response = await fetch(`${base}/characters/${characterId}/private-chats?${params}`, {
    headers: { cookie: `yiling_session=${cookie}` },
  });
  return { status: response.status, body: await response.json() as Page };
}

try {
  await prisma.user.createMany({ data: [ownerId, strangerId].map((id) => ({ id, username: `private-page-${id}`, passwordHash: "test-only" })) });
  await prisma.character.create({ data: { id: characterId, ownerId, name: `private-page-${characterId}`, basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `private-page:${scopeId}` } });
  await prisma.conversation.create({ data: {
    id: conversationId, characterId, memoryScopeId: scopeId,
    externalConversationId: `c:${randomInt(100_000_000, 999_999_999)}`, lastMessageAt: occurredAt,
  } });
  const ids = Array.from({ length: 201 }, () => randomUUID()).sort();
  await prisma.message.createMany({ data: ids.map((id) => ({
    id, conversationId, role: "USER" as const, eventType: "message", content: `pagination-${id}`, occurredAt,
  })) });
  token = (await createSession({ userId: ownerId })).token;
  strangerToken = (await createSession({ userId: strangerId })).token;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.body.selectedConversationId, conversationId);
  assert.equal(first.body.messages.length, 200);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.totals.messages, 201);
  assert.deepEqual(first.body.messages.map((message) => message.id), ids.slice(1));
  assert.deepEqual(first.body.nextCursor, { before: occurredAt.toISOString(), beforeId: ids[1] });
  assert(first.body.nextCursor);
  const second = await request(first.body.nextCursor);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.messages.map((message) => message.id), ids.slice(0, 1));
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.nextCursor, null);
  const collected = [...second.body.messages, ...first.body.messages].map((message) => message.id);
  assert.equal(new Set(collected).size, 201);
  assert.deepEqual(collected, ids, "Timestamp ties must neither skip nor duplicate messages");

  const legacy = await request({ before: occurredAt.toISOString() });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.messages, []);
  assert.equal(legacy.body.hasMore, false);
  assert.equal(legacy.body.nextCursor, null);
  assert.equal((await request({ before: occurredAt.toISOString(), beforeId: "not-a-uuid" })).status, 400);
  assert.equal((await request({ beforeId: randomUUID() })).status, 400);
  assert.equal((await request({}, strangerToken)).status, 404);
  assert.equal((await request({ conversationId: randomUUID() })).status, 404);
  console.log("Private chat pagination PostgreSQL API checks passed: 201 same-timestamp messages across two pages, exact unique UUID ordering, legacy before, invalid cursor 400 and foreign owner 404.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    await prisma.conversation.deleteMany({ where: { id: conversationId, characterId } });
    await prisma.memoryScope.deleteMany({ where: { id: scopeId, characterId } });
    await prisma.character.deleteMany({ where: { id: characterId, ownerId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  } finally {
    await prisma.$disconnect();
  }
}
