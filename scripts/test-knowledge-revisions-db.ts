import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { createSession } from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";
import editKnowledgeItem from "../server/api/characters/[id]/growth/knowledge/items/[itemId].patch";
import getKnowledgeHistory from "../server/api/characters/[id]/growth/knowledge/items/[itemId]/history.get";

const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert.match(database, /^yiling_knowledge_revision_test_[a-f0-9]{32}$/,
  "Run through test:knowledge-revisions-isolated only.");

const prisma = getPrisma();
const ownerId = randomUUID();
const characterAId = randomUUID();
const characterBId = randomUUID();
const app = createApp();
const router = createRouter();
router.patch("/characters/:id/growth/knowledge/items/:itemId", editKnowledgeItem);
router.get("/characters/:id/growth/knowledge/items/:itemId/history", getKnowledgeHistory);
app.use(router);
const server = createServer(toNodeListener(app));

async function readJson(response: Response) {
  return await response.json() as Record<string, unknown>;
}

try {
  await prisma.user.create({
    data: { id: ownerId, username: `knowledge-revision-${ownerId.slice(0, 8)}`, passwordHash: "test-only" },
  });
  await prisma.character.createMany({
    data: [
      { id: characterAId, ownerId, name: "知识版本测试 A", basePrompt: "test" },
      { id: characterBId, ownerId, name: "知识版本测试 B", basePrompt: "test" },
    ],
  });
  const item = await prisma.knowledgeItem.create({
    data: {
      characterId: characterAId,
      title: "黑洞",
      content: "旧版正文",
      category: "SCIENCE",
      tags: ["天文学"],
      confidence: 0.8,
      sourceType: "CHAT",
      sourceRef: { conversationId: "conversation-source", messageIds: ["message-1"] },
    },
  });
  const session = await createSession({ userId: ownerId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const patch = async (characterId: string, body: Record<string, unknown>, cookie = session.token) => {
    const response = await fetch(`${base}/characters/${characterId}/growth/knowledge/items/${item.id}`, {
      method: "PATCH",
      headers: { cookie: `yiling_session=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await readJson(response) };
  };
  const history = async (characterId: string, cookie = session.token) => {
    const response = await fetch(`${base}/characters/${characterId}/growth/knowledge/items/${item.id}/history`, {
      headers: { cookie: `yiling_session=${cookie}` },
    });
    return { status: response.status, body: await readJson(response) };
  };

  // ── 1. Authentication and character ownership boundaries ──────────────
  assert.equal((await patch(characterAId, { revision: 1, title: "未授权" }, "invalid-session")).status, 401);
  assert.equal((await patch(characterBId, { revision: 1, title: "跨角色修改" })).status, 404);
  assert.equal((await history(characterBId)).status, 404);

  // ── 2. Source metadata is immutable from the edit endpoint ──────────────
  assert.equal((await patch(characterAId, { revision: 1, sourceRef: { forged: true } })).status, 400);

  // ── 3. A valid edit snapshots the replaced version atomically ───────────
  const first = await patch(characterAId, {
    revision: 1,
    title: "黑洞与事件视界",
    content: "修订后的正文",
    category: "ASTRONOMY",
    tags: ["天文学", "相对论"],
    confidence: 0.94,
  });
  assert.equal(first.status, 200);
  const firstBody = first.body as { item: { revision: number; title: string; sourceType: string; sourceRef: { messageIds: string[] } }; unchanged: boolean };
  assert.equal(firstBody.item.revision, 2);
  assert.equal(firstBody.item.title, "黑洞与事件视界");
  assert.equal(firstBody.item.sourceType, "CHAT");
  assert.deepEqual(firstBody.item.sourceRef.messageIds, ["message-1"]);
  assert.equal(firstBody.unchanged, false);

  const firstSnapshot = await prisma.knowledgeItemRevision.findUniqueOrThrow({
    where: { itemId_revision: { itemId: item.id, revision: 1 } },
  });
  assert.equal(firstSnapshot.title, "黑洞");
  assert.equal(firstSnapshot.content, "旧版正文");
  assert.equal(firstSnapshot.sourceType, "CHAT");
  assert.deepEqual(firstSnapshot.sourceRef, { conversationId: "conversation-source", messageIds: ["message-1"] });

  // No-op edits do not manufacture a new version.
  const noOp = await patch(characterAId, { revision: 2, title: "黑洞与事件视界" });
  assert.equal(noOp.status, 200);
  assert.equal((noOp.body as { unchanged: boolean }).unchanged, true);
  assert.equal(await prisma.knowledgeItemRevision.count({ where: { itemId: item.id } }), 1);

  // A stale editor cannot overwrite the accepted revision.
  assert.equal((await patch(characterAId, { revision: 1, title: "过期表单" })).status, 409);
  assert.equal((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: item.id } })).title, "黑洞与事件视界");

  // ── 4. Concurrent edits with the same expected revision: exactly one wins ──
  const concurrent = await Promise.all([
    patch(characterAId, { revision: 2, content: "并发版本 A" }),
    patch(characterAId, { revision: 2, content: "并发版本 B" }),
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const current = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(current.revision, 3);
  assert.ok(["并发版本 A", "并发版本 B"].includes(current.content));
  assert.equal(await prisma.knowledgeItemRevision.count({ where: { itemId: item.id } }), 2);

  // ── 5. History remains scoped and ordered, and follows item deletion ───
  const historyResult = await history(characterAId);
  assert.equal(historyResult.status, 200);
  const historyBody = historyResult.body as { currentRevision: number; revisions: Array<{ revision: number; title: string; content: string }> };
  assert.equal(historyBody.currentRevision, 3);
  assert.deepEqual(historyBody.revisions.map(row => row.revision), [2, 1]);
  assert.equal(historyBody.revisions[0]?.content, "修订后的正文");

  await prisma.knowledgeItem.delete({ where: { id: item.id } });
  assert.equal(await prisma.knowledgeItemRevision.count({ where: { itemId: item.id } }), 0);

  console.log("Knowledge revisions DB checks passed: auth, role isolation, immutable source metadata, atomic snapshots, no-op, stale write rejection, concurrent optimistic locking, ordered history and cascade delete.");
} finally {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await prisma.knowledgeItemRevision.deleteMany({ where: { item: { characterId: { in: [characterAId, characterBId] } } } }).catch(() => undefined);
  await prisma.knowledgeItem.deleteMany({ where: { characterId: { in: [characterAId, characterBId] } } }).catch(() => undefined);
  await prisma.knowledgeCandidate.deleteMany({ where: { characterId: { in: [characterAId, characterBId] } } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: { in: [characterAId, characterBId] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect();
}
