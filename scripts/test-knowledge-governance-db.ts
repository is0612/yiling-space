import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { createSession } from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";
import mergeKnowledgeItem from "../server/api/characters/[id]/growth/knowledge/items/[itemId]/merge.post";
import resolveKnowledgeRelation from "../server/api/characters/[id]/growth/knowledge/relations/[relationId]/resolve.post";

const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert.match(database, /^yiling_knowledge_governance_test_[a-f0-9]{32}$/,
  "Run through test:knowledge-governance-isolated only.");

const prisma = getPrisma();
const ownerId = randomUUID();
const characterAId = randomUUID();
const characterBId = randomUUID();
const app = createApp();
const router = createRouter();
router.post("/characters/:id/growth/knowledge/items/:itemId/merge", mergeKnowledgeItem);
router.post("/characters/:id/growth/knowledge/relations/:relationId/resolve", resolveKnowledgeRelation);
app.use(router);
const server = createServer(toNodeListener(app));

async function request(path: string, body: Record<string, unknown>, cookie?: string) {
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, {
    method: "POST",
    headers: {
      ...(cookie ? { cookie: `yiling_session=${cookie}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
function relationPair(a: string, b: string) {
  return a < b ? { sourceItemId: a, targetItemId: b } : { sourceItemId: b, targetItemId: a };
}

try {
  await prisma.user.create({
    data: { id: ownerId, username: `knowledge-governance-${ownerId.slice(0, 8)}`, passwordHash: "test-only" },
  });
  await prisma.character.createMany({
    data: [
      { id: characterAId, ownerId, name: "知识治理测试 A", basePrompt: "test" },
      { id: characterBId, ownerId, name: "知识治理测试 B", basePrompt: "test" },
    ],
  });
  const makeItem = (characterId: string, title: string, content = `${title} 原文`) => prisma.knowledgeItem.create({
    data: {
      characterId, title, content, category: "GENERAL", tags: ["原始标签"], confidence: 0.8,
      sourceType: "CHAT", sourceRef: { source: title, messageIds: [`message-${title}`] },
    },
  });
  const [source, target, staleSource, staleTarget, conflictA, conflictB, verifyA, verifyB, keepA, keepB, crossRole] = await Promise.all([
    makeItem(characterAId, "重复源知识"),
    makeItem(characterAId, "重复目标知识"),
    makeItem(characterAId, "过期源知识"),
    makeItem(characterAId, "过期目标知识"),
    makeItem(characterAId, "冲突知识 A"),
    makeItem(characterAId, "冲突知识 B"),
    makeItem(characterAId, "待核实 A"),
    makeItem(characterAId, "待核实 B"),
    makeItem(characterAId, "独立保留 A"),
    makeItem(characterAId, "独立保留 B"),
    makeItem(characterBId, "其他角色知识"),
  ]);
  const duplicate = await prisma.knowledgeItemRelation.create({
    data: { characterId: characterAId, ...relationPair(source.id, target.id), relationType: "DUPLICATE" },
  });
  const staleDuplicate = await prisma.knowledgeItemRelation.create({
    data: { characterId: characterAId, ...relationPair(staleSource.id, staleTarget.id), relationType: "DUPLICATE" },
  });
  const conflict = await prisma.knowledgeItemRelation.create({
    data: { characterId: characterAId, ...relationPair(conflictA.id, conflictB.id), relationType: "CONFLICT" },
  });
  const verifyConflict = await prisma.knowledgeItemRelation.create({
    data: { characterId: characterAId, ...relationPair(verifyA.id, verifyB.id), relationType: "CONFLICT" },
  });
  const keepDuplicate = await prisma.knowledgeItemRelation.create({
    data: { characterId: characterAId, ...relationPair(keepA.id, keepB.id), relationType: "DUPLICATE" },
  });

  const session = await createSession({ userId: ownerId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const mergePath = (characterId: string, itemId: string) =>
    `/characters/${characterId}/growth/knowledge/items/${itemId}/merge`;
  const resolvePath = (characterId: string, relationId: string) =>
    `/characters/${characterId}/growth/knowledge/relations/${relationId}/resolve`;

  // Authentication and character boundaries.
  assert.equal((await request(mergePath(characterAId, source.id), {
    targetItemId: target.id, expectedSourceRevision: 1, expectedTargetRevision: 1,
    title: "合并标题", content: "合并正文", category: "GENERAL", tags: [], confidence: 0.9,
  })).status, 401);
  assert.equal((await request(mergePath(characterAId, source.id), {
    targetItemId: crossRole.id, expectedSourceRevision: 1, expectedTargetRevision: 1,
    title: "越权", content: "越权", category: "GENERAL", tags: [], confidence: 0.9,
  }, session.token)).status, 404);

  // Stale merge must leave both records and their histories untouched.
  const stale = await request(mergePath(characterAId, staleSource.id), {
    targetItemId: staleTarget.id, expectedSourceRevision: 9, expectedTargetRevision: 1,
    title: "不应保存", content: "不应保存", category: "GENERAL", tags: [], confidence: 0.9,
  }, session.token);
  assert.equal(stale.status, 409);
  assert.equal((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: staleSource.id } })).status, "ACTIVE");
  assert.equal(await prisma.knowledgeItemRevision.count({ where: { itemId: { in: [staleSource.id, staleTarget.id] } } }), 0);
  assert.equal(await prisma.knowledgeItemRelation.count({ where: { characterId: characterAId, relationType: "MERGED_INTO" } }), 0);

  // A confirmed merge snapshots both old versions, updates target, marks source MERGED and records lineage.
  const merged = await request(mergePath(characterAId, source.id), {
    targetItemId: target.id,
    expectedSourceRevision: 1,
    expectedTargetRevision: 1,
    title: "合并后的标题",
    content: "由用户确认的完整合并正文",
    category: "SCIENCE",
    tags: ["天文学", "相对论"],
    confidence: 0.95,
  }, session.token);
  assert.equal(merged.status, 200);
  const sourceAfter = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: source.id } });
  const targetAfter = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(sourceAfter.status, "MERGED");
  assert.equal(sourceAfter.revision, 2);
  assert.equal(targetAfter.status, "ACTIVE");
  assert.equal(targetAfter.revision, 2);
  assert.equal(targetAfter.title, "合并后的标题");
  assert.equal(targetAfter.content, "由用户确认的完整合并正文");
  assert.equal(targetAfter.sourceType, "CHAT");
  assert.deepEqual(targetAfter.sourceRef, { source: "重复目标知识", messageIds: ["message-重复目标知识"] });
  const sourceSnapshot = await prisma.knowledgeItemRevision.findUniqueOrThrow({
    where: { itemId_revision: { itemId: source.id, revision: 1 } },
  });
  const targetSnapshot = await prisma.knowledgeItemRevision.findUniqueOrThrow({
    where: { itemId_revision: { itemId: target.id, revision: 1 } },
  });
  assert.equal(sourceSnapshot.status, "ACTIVE");
  assert.equal(sourceSnapshot.content, "重复源知识 原文");
  assert.equal(targetSnapshot.content, "重复目标知识 原文");
  assert.equal(sourceSnapshot.sourceType, "CHAT");
  const lineage = await prisma.knowledgeItemRelation.findFirstOrThrow({
    where: { characterId: characterAId, sourceItemId: source.id, targetItemId: target.id, relationType: "MERGED_INTO" },
  });
  assert.equal(lineage.status, "RESOLVED");
  assert.equal(lineage.resolution, "MERGED");
  assert.equal((await prisma.knowledgeItemRelation.findUniqueOrThrow({ where: { id: duplicate.id } })).resolution, "MERGED");

  // Conflict confirmation preserves both ACTIVE items and their contents.
  const confirmedConflict = await request(resolvePath(characterAId, conflict.id), {
    action: "CONFIRM_CONFLICT", expectedSourceRevision: 1, expectedTargetRevision: 1,
  }, session.token);
  assert.equal(confirmedConflict.status, 200);
  const conflictAfter = await prisma.knowledgeItemRelation.findUniqueOrThrow({ where: { id: conflict.id } });
  assert.equal(conflictAfter.status, "RESOLVED");
  assert.equal(conflictAfter.resolution, "CONFIRM_CONFLICT");
  assert.equal((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: conflictA.id } })).status, "ACTIVE");
  assert.equal((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: conflictB.id } })).content, "冲突知识 B 原文");

  // Needs verification stays OPEN; duplicate can be explicitly kept separate.
  const pending = await request(resolvePath(characterAId, verifyConflict.id), {
    action: "NEEDS_VERIFICATION", expectedSourceRevision: 1, expectedTargetRevision: 1,
  }, session.token);
  assert.equal(pending.status, 200);
  const pendingRelation = await prisma.knowledgeItemRelation.findUniqueOrThrow({ where: { id: verifyConflict.id } });
  assert.equal(pendingRelation.status, "OPEN");
  assert.equal(pendingRelation.resolution, "NEEDS_VERIFICATION");
  assert.equal(pendingRelation.resolvedAt, null);

  const kept = await request(resolvePath(characterAId, keepDuplicate.id), {
    action: "KEEP_SEPARATE", expectedSourceRevision: 1, expectedTargetRevision: 1,
  }, session.token);
  assert.equal(kept.status, 200);
  assert.equal((await prisma.knowledgeItemRelation.findUniqueOrThrow({ where: { id: keepDuplicate.id } })).resolution, "KEEP_SEPARATE");
  assert.equal((await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: keepA.id } })).status, "ACTIVE");

  // Wrong action for relation type and stale revisions are rejected.
  assert.equal((await request(resolvePath(characterAId, conflict.id), {
    action: "DISMISS", expectedSourceRevision: 1, expectedTargetRevision: 1,
  }, session.token)).status, 409);
  assert.equal((await request(resolvePath(characterAId, staleDuplicate.id), {
    action: "CONFIRM_CONFLICT", expectedSourceRevision: 1, expectedTargetRevision: 1,
  }, session.token)).status, 400);

  console.log("Knowledge governance DB checks passed: auth, role isolation, atomic merge snapshots, source lineage, stale rejection, conflict preservation, verification and keep-separate decisions.");
} finally {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await prisma.knowledgeItemRelation.deleteMany({ where: { characterId: { in: [characterAId, characterBId] } } }).catch(() => undefined);
  await prisma.knowledgeItemRevision.deleteMany({ where: { item: { characterId: { in: [characterAId, characterBId] } } } }).catch(() => undefined);
  await prisma.knowledgeItem.deleteMany({ where: { characterId: { in: [characterAId, characterBId] } } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: { in: [characterAId, characterBId] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect();
}
