import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { createSession } from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";
// 这些路由文件用 Nuxt 自动导入的 defineEventHandler / createError，直接静态 import 会
// 在模块求值阶段拿不到全局符号，所以先注入基础符号再动态导入。
(globalThis as Record<string, unknown>).defineEventHandler = (handler: unknown) => handler;
(globalThis as Record<string, unknown>).createError = (await import("h3")).createError;

const route = async (path: string) => (await import(path)).default;
const archiveItem = await route("../server/api/characters/[id]/growth/knowledge/items/[itemId]/archive.post");
const unarchiveItem = await route("../server/api/characters/[id]/growth/knowledge/items/[itemId]/unarchive.post");
const trashItem = await route("../server/api/characters/[id]/growth/knowledge/items/[itemId]/trash.post");
const restoreItem = await route("../server/api/characters/[id]/growth/knowledge/items/[itemId]/restore.post");
const purgeItem = await route("../server/api/characters/[id]/growth/knowledge/items/[itemId].delete");
const trashList = await route("../server/api/characters/[id]/growth/knowledge/trash.get");
const searchKnowledge = await route("../server/api/characters/[id]/growth/knowledge/search.get");
const workspace = await route("../server/api/characters/[id]/growth/knowledge/index.get");
const deleteCandidate = await route("../server/api/characters/[id]/growth/knowledge/candidates/[candidateId].delete");
const purgeDismissedCandidates = await route("../server/api/characters/[id]/growth/knowledge/candidates/purge-dismissed.post");

const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert.match(database, /^yiling_knowledge_lifecycle_test_[a-f0-9]{32}$/,
  "Run through test:knowledge-lifecycle-isolated only.");

const prisma = getPrisma();
const ownerId = randomUUID();
const characterAId = randomUUID();
const characterBId = randomUUID();

const app = createApp();
const router = createRouter();
router.post("/characters/:id/growth/knowledge/items/:itemId/archive", archiveItem);
router.post("/characters/:id/growth/knowledge/items/:itemId/unarchive", unarchiveItem);
router.post("/characters/:id/growth/knowledge/items/:itemId/trash", trashItem);
router.post("/characters/:id/growth/knowledge/items/:itemId/restore", restoreItem);
router.delete("/characters/:id/growth/knowledge/items/:itemId", purgeItem);
router.get("/characters/:id/growth/knowledge/trash", trashList);
router.get("/characters/:id/growth/knowledge/search", searchKnowledge);
router.get("/characters/:id/growth/knowledge", workspace);
router.delete("/characters/:id/growth/knowledge/candidates/:candidateId", deleteCandidate);
router.post("/characters/:id/growth/knowledge/candidates/purge-dismissed", purgeDismissedCandidates);
app.use(router);
const server = createServer(toNodeListener(app));

type Json = Record<string, unknown>;

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  cookie?: string,
  body?: Json,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `yiling_session=${cookie}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

function itemPath(characterId: string, itemId: string, action?: string) {
  return `/characters/${characterId}/growth/knowledge/items/${itemId}${action ? `/${action}` : ""}`;
}
function candidatePath(characterId: string, candidateId: string) {
  return `/characters/${characterId}/growth/knowledge/candidates/${candidateId}`;
}

function makeItem(characterId: string, title: string, status = "ACTIVE") {
  return prisma.knowledgeItem.create({
    data: {
      characterId, title, content: `${title} 的正文`, category: "GENERAL",
      tags: ["原始标签"], confidence: 0.7, status, sourceType: "MANUAL",
    },
  });
}

async function revisionsOf(itemId: string) {
  return prisma.knowledgeItemRevision.findMany({
    where: { itemId }, orderBy: { revision: "asc" },
    select: { revision: true, status: true, action: true, content: true },
  });
}

try {
  await prisma.user.create({
    data: { id: ownerId, username: `knowledge-lifecycle-${ownerId.slice(0, 8)}`, passwordHash: "test-only" },
  });
  await prisma.character.createMany({
    data: [
      { id: characterAId, ownerId, name: "生命周期测试 A", basePrompt: "test" },
      { id: characterBId, ownerId, name: "生命周期测试 B", basePrompt: "test" },
    ],
  });

  const session = await createSession({ userId: ownerId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // ---------------------------------------------------------------------------
  // 1. 每一种合法状态转换：状态、版本号、快照内容与 action 都要对得上。
  // ---------------------------------------------------------------------------
  const cyclical = await makeItem(characterAId, "归档往返");
  const archived = await call("POST", itemPath(characterAId, cyclical.id, "archive"), session.token, { expectedRevision: 1 });
  assert.equal(archived.status, 200, "ACTIVE → ARCHIVED 应当成功");
  assert.equal(archived.body.item.status, "ARCHIVED");
  assert.equal(archived.body.item.revision, 2);
  let history = await revisionsOf(cyclical.id);
  assert.deepEqual(history.map(row => [row.revision, row.status, row.action]), [[1, "ACTIVE", "ARCHIVE"]],
    "归档必须写一条 action=ARCHIVE 的快照，记录变更前状态");

  const unarchived = await call("POST", itemPath(characterAId, cyclical.id, "unarchive"), session.token, { expectedRevision: 2 });
  assert.equal(unarchived.status, 200, "ARCHIVED → ACTIVE 应当成功");
  assert.equal(unarchived.body.item.status, "ACTIVE");
  assert.equal(unarchived.body.item.revision, 3);
  history = await revisionsOf(cyclical.id);
  assert.deepEqual(history.map(row => row.action), ["ARCHIVE", "UNARCHIVE"]);

  const trashed = await call("POST", itemPath(characterAId, cyclical.id, "trash"), session.token, { expectedRevision: 3 });
  assert.equal(trashed.status, 200, "ACTIVE → TRASHED 应当成功");
  assert.equal(trashed.body.item.status, "TRASHED");
  assert.equal(trashed.body.item.revision, 4);

  const restored = await call("POST", itemPath(characterAId, cyclical.id, "restore"), session.token, { expectedRevision: 4 });
  assert.equal(restored.status, 200, "TRASHED → ACTIVE 应当成功");
  assert.equal(restored.body.item.status, "ACTIVE");
  assert.equal(restored.body.item.revision, 5);

  history = await revisionsOf(cyclical.id);
  assert.deepEqual(history.map(row => row.action), ["ARCHIVE", "UNARCHIVE", "TRASH", "RESTORE"],
    "四种生命周期操作必须各自留下区分于内容编辑的快照");
  assert.ok(history.every(row => row.action !== "CONTENT_EDIT"), "生命周期操作不能伪装成普通内容编辑");

  // ---------------------------------------------------------------------------
  // 2. 非法状态转换一律 409，且不产生任何快照。
  // ---------------------------------------------------------------------------
  const illegal = await makeItem(characterAId, "非法转换");
  assert.equal((await call("POST", itemPath(characterAId, illegal.id, "restore"), session.token, { expectedRevision: 1 })).status, 409,
    "ACTIVE 不能从回收站恢复");
  assert.equal((await call("POST", itemPath(characterAId, illegal.id, "unarchive"), session.token, { expectedRevision: 1 })).status, 409,
    "ACTIVE 不能取消归档");
  assert.equal((await revisionsOf(illegal.id)).length, 0, "非法转换不得留下快照");

  await call("POST", itemPath(characterAId, illegal.id, "archive"), session.token, { expectedRevision: 1 });
  assert.equal((await call("POST", itemPath(characterAId, illegal.id, "trash"), session.token, { expectedRevision: 2 })).status, 409,
    "ARCHIVED 不能直接移入回收站，必须先取消归档");

  const merged = await makeItem(characterAId, "已合并源知识", "MERGED");
  assert.equal((await call("POST", itemPath(characterAId, merged.id, "restore"), session.token, { expectedRevision: 1 })).status, 409,
    "MERGED 不允许普通恢复");
  assert.equal((await call("POST", itemPath(characterAId, merged.id, "archive"), session.token, { expectedRevision: 1 })).status, 409,
    "MERGED 不允许归档");

  // ---------------------------------------------------------------------------
  // 3. revision 冲突与并发：过期版本 409；同一 revision 并发只有一个成功。
  // ---------------------------------------------------------------------------
  const stale = await makeItem(characterAId, "过期版本");
  const staleResult = await call("POST", itemPath(characterAId, stale.id, "archive"), session.token, { expectedRevision: 9 });
  assert.equal(staleResult.status, 409, "过期 revision 必须 409");
  const staleAfter = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(staleAfter.status, "ACTIVE", "被拒绝的请求不能改状态");
  assert.equal(staleAfter.revision, 1, "被拒绝的请求不能改版本号");

  const racing = await makeItem(characterAId, "并发归档");
  const [first, second] = await Promise.all([
    call("POST", itemPath(characterAId, racing.id, "archive"), session.token, { expectedRevision: 1 }),
    call("POST", itemPath(characterAId, racing.id, "archive"), session.token, { expectedRevision: 1 }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], `并发同版本只能成功一次，实际：${statuses.join("/")}`);
  const racingAfter = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: racing.id } });
  assert.equal(racingAfter.revision, 2, "并发下版本也只能加一次");
  assert.equal((await revisionsOf(racing.id)).length, 1, "并发下只能写一条快照");

  // ---------------------------------------------------------------------------
  // 4 & 5. 归档与回收站不参与检索；恢复后重新可检索。
  // ---------------------------------------------------------------------------
  const searchable = await makeItem(characterAId, "水在标准大气压下的沸点");
  const searchPath = `/characters/${characterAId}/growth/knowledge/search?q=%E6%B2%B8%E7%82%B9`;
  const foundActive = await call("GET", searchPath, session.token);
  assert.ok((foundActive.body.items as Json[]).some(row => row.id === searchable.id), "ACTIVE 知识应当能检索到");

  await call("POST", itemPath(characterAId, searchable.id, "archive"), session.token, { expectedRevision: 1 });
  const foundArchived = await call("GET", searchPath, session.token);
  assert.ok(!(foundArchived.body.items as Json[]).some(row => row.id === searchable.id), "归档知识不能出现在检索结果里");

  await call("POST", itemPath(characterAId, searchable.id, "unarchive"), session.token, { expectedRevision: 2 });
  await call("POST", itemPath(characterAId, searchable.id, "trash"), session.token, { expectedRevision: 3 });
  const foundTrashed = await call("GET", searchPath, session.token);
  assert.ok(!(foundTrashed.body.items as Json[]).some(row => row.id === searchable.id), "回收站知识不能出现在检索结果里");

  const listWhileTrashed = await call("GET", `/characters/${characterAId}/growth/knowledge`, session.token);
  assert.ok(!(listWhileTrashed.body.items as Json[]).some(row => row.id === searchable.id), "回收站知识不能出现在正式知识列表里");

  await call("POST", itemPath(characterAId, searchable.id, "restore"), session.token, { expectedRevision: 4 });
  const foundRestored = await call("GET", searchPath, session.token);
  assert.ok((foundRestored.body.items as Json[]).some(row => row.id === searchable.id), "恢复后应当重新可检索");

  // 回收站查询只返回 TRASHED，且限定当前角色。
  const trashedItem = await makeItem(characterAId, "回收站里的条目");
  await call("POST", itemPath(characterAId, trashedItem.id, "trash"), session.token, { expectedRevision: 1 });
  const trashResponse = await call("GET", `/characters/${characterAId}/growth/knowledge/trash`, session.token);
  assert.equal(trashResponse.status, 200);
  const trashIds = (trashResponse.body.items as Json[]).map(row => row.id);
  assert.ok(trashIds.includes(trashedItem.id), "回收站应当列出 TRASHED 知识");
  assert.ok(!trashIds.includes(searchable.id), "回收站不能列出 ACTIVE 知识");
  assert.ok(!trashIds.includes(cyclical.id), "回收站不能列出 ACTIVE 知识");

  // ---------------------------------------------------------------------------
  // 6. 永久删除：状态限制 + 二次确认。
  // ---------------------------------------------------------------------------
  const activeForPurge = await makeItem(characterAId, "不该被永久删除");
  assert.equal((await call("DELETE", itemPath(characterAId, activeForPurge.id), session.token, {
    expectedRevision: 1, confirm: "PERMANENT_DELETE",
  })).status, 409, "非回收站知识必须拒绝永久删除");

  const pendingPurge = await makeItem(characterAId, "待永久删除");
  await call("POST", itemPath(characterAId, pendingPurge.id, "trash"), session.token, { expectedRevision: 1 });
  assert.equal((await call("DELETE", itemPath(characterAId, pendingPurge.id), session.token, {
    expectedRevision: 2,
  })).status, 400, "缺少 confirm 必须拒绝");
  assert.equal((await call("DELETE", itemPath(characterAId, pendingPurge.id), session.token, {
    expectedRevision: 2, confirm: "DELETE",
  })).status, 400, "confirm 口令不正确必须拒绝");
  assert.equal((await call("DELETE", itemPath(characterAId, pendingPurge.id), session.token, {
    expectedRevision: 1, confirm: "PERMANENT_DELETE",
  })).status, 409, "过期 revision 必须拒绝");

  // ---------------------------------------------------------------------------
  // 7. 存在 MERGED_INTO 审计链时拒绝永久删除。
  // ---------------------------------------------------------------------------
  const mergedTarget = await makeItem(characterAId, "合并目标");
  const auditSource = await makeItem(characterAId, "合并源", "MERGED");
  await prisma.knowledgeItemRelation.create({
    data: {
      characterId: characterAId, sourceItemId: auditSource.id, targetItemId: mergedTarget.id,
      relationType: "MERGED_INTO", status: "RESOLVED", resolution: "MERGED",
    },
  });
  await call("POST", itemPath(characterAId, mergedTarget.id, "trash"), session.token, { expectedRevision: 1 });
  const auditBlocked = await call("DELETE", itemPath(characterAId, mergedTarget.id), session.token, {
    expectedRevision: 2, confirm: "PERMANENT_DELETE",
  });
  assert.equal(auditBlocked.status, 409, "参与过合并的知识不能永久删除");
  assert.match(String(auditBlocked.body.statusMessage), /合并/);
  assert.ok(await prisma.knowledgeItem.findUnique({ where: { id: mergedTarget.id } }), "被拒绝时知识必须还在");
  assert.ok(await prisma.knowledgeItemRelation.findFirst({ where: { relationType: "MERGED_INTO", targetItemId: mergedTarget.id } }),
    "被拒绝时审计关系必须完整");

  // 回收站接口的展示派生字段：给页面禁用「永久删除」按钮用，
  // 与上面的接口校验是两回事，页面判断不能替代服务端重新检查。
  const trashWithAudit = await call("GET", `/characters/${characterAId}/growth/knowledge/trash`, session.token);
  const auditRow = (trashWithAudit.body.items as Json[]).find(row => row.id === mergedTarget.id);
  assert.equal(auditRow?.canPermanentlyDelete, false, "参与合并审计链的条目必须标记为不可永久删除");
  const plainTrashRow = (trashWithAudit.body.items as Json[]).find(row => row.id === trashedItem.id);
  assert.equal(plainTrashRow?.canPermanentlyDelete, true, "普通回收站条目应当标记为可永久删除");
  assert.ok((trashWithAudit.body.items as Json[]).every(row => typeof row.canPermanentlyDelete === "boolean"),
    "回收站每个条目都必须带 canPermanentlyDelete");

  // ---------------------------------------------------------------------------
  // 8. 永久删除后：关系与版本历史清理干净，不留孤立数据。
  // ---------------------------------------------------------------------------
  const purgeA = await makeItem(characterAId, "删除前有重复关系 A");
  const purgeB = await makeItem(characterAId, "删除前有重复关系 B");
  const [lowerId, higherId] = [purgeA.id, purgeB.id].sort();
  await prisma.knowledgeItemRelation.create({
    data: { characterId: characterAId, sourceItemId: lowerId, targetItemId: higherId, relationType: "DUPLICATE", status: "OPEN" },
  });
  // 先模拟一次内容编辑，让这条知识在删除前既有内容修订史、也有生命周期快照。
  await prisma.knowledgeItem.update({ where: { id: purgeA.id }, data: { content: "编辑后的内容", revision: 2 } });
  await prisma.knowledgeItemRevision.create({
    data: {
      itemId: purgeA.id, revision: 1, title: "旧标题", content: "旧内容", category: "GENERAL",
      tags: [], confidence: null, status: "ACTIVE", sourceType: "MANUAL", action: "CONTENT_EDIT",
    },
  });
  await call("POST", itemPath(characterAId, purgeA.id, "trash"), session.token, { expectedRevision: 2 });
  const purgeResult = await call("DELETE", itemPath(characterAId, purgeA.id), session.token, {
    expectedRevision: 3, confirm: "PERMANENT_DELETE",
  });
  assert.equal(purgeResult.status, 200, "回收站知识应当可以永久删除");
  assert.equal(purgeResult.body.deletedRevisions, 2, "版本历史（原有一份 + 移入回收站的快照）都应清理");
  assert.ok(Number(purgeResult.body.deletedRelations) >= 1, "普通关系应在事务内清理");
  assert.equal(await prisma.knowledgeItem.findUnique({ where: { id: purgeA.id } }), null);
  assert.equal(await prisma.knowledgeItemRevision.count({ where: { itemId: purgeA.id } }), 0, "不得留下孤立版本");
  assert.equal(await prisma.knowledgeItemRelation.count({
    where: { OR: [{ sourceItemId: purgeA.id }, { targetItemId: purgeA.id }] },
  }), 0, "不得留下孤立关系");
  assert.ok(await prisma.knowledgeItem.findUnique({ where: { id: purgeB.id } }), "对端知识不受影响");

  // ---------------------------------------------------------------------------
  // 9. 候选删除不会删除已入库的正式知识。
  // ---------------------------------------------------------------------------
  const acceptedCandidate = await prisma.knowledgeCandidate.create({
    data: { characterId: characterAId, rawContent: "已入库候选", status: "ACCEPTED" },
  });
  const acceptedItem = await prisma.knowledgeItem.create({
    data: {
      characterId: characterAId, candidateId: acceptedCandidate.id, title: "候选入库的知识",
      content: "正文", category: "GENERAL", tags: [], sourceType: "MANUAL",
    },
  });
  const deleteAccepted = await call("DELETE", candidatePath(characterAId, acceptedCandidate.id), session.token);
  assert.equal(deleteAccepted.status, 200, "已入库候选允许删除候选记录");
  assert.equal(deleteAccepted.body.knowledgeItemRetained, true);
  const survivedItem = await prisma.knowledgeItem.findUnique({ where: { id: acceptedItem.id } });
  assert.ok(survivedItem, "删除候选绝不能删除正式知识");
  assert.equal(survivedItem!.candidateId, null, "外键按 SetNull 解除指向，正文与来源保留");
  assert.equal(survivedItem!.content, "正文");

  const processingCandidate = await prisma.knowledgeCandidate.create({
    data: { characterId: characterAId, rawContent: "处理中候选", status: "PROCESSING" },
  });
  assert.equal((await call("DELETE", candidatePath(characterAId, processingCandidate.id), session.token)).status, 409,
    "处理中的候选不允许删除");

  // ---------------------------------------------------------------------------
  // 10. 批量清理只删已忽略候选，不误删待处理与已入库。
  // ---------------------------------------------------------------------------
  const batchCandidates = await prisma.knowledgeCandidate.createMany({
    data: [
      { characterId: characterAId, rawContent: "待处理", status: "PENDING" },
      { characterId: characterAId, rawContent: "待复核", status: "REVIEW" },
      { characterId: characterAId, rawContent: "已忽略 1", status: "DISMISSED" },
      { characterId: characterAId, rawContent: "已忽略 2", status: "DISMISSED" },
    ],
  });
  assert.equal(batchCandidates.count, 4);
  const purgeCandidates = await call("POST", `/characters/${characterAId}/growth/knowledge/candidates/purge-dismissed`, session.token, {});
  assert.equal(purgeCandidates.status, 200);
  assert.equal(purgeCandidates.body.deletedCount, 2, "只应删除两条 DISMISSED 候选");
  assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: characterAId, status: "PENDING" } }), 1, "待处理候选不能被误删");
  assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: characterAId, status: "REVIEW" } }), 1, "待复核候选不能被误删");
  assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: characterAId, status: "DISMISSED" } }), 0);

  // ---------------------------------------------------------------------------
  // 11. 角色隔离：跨角色读写一律拒绝，回收站也不串角色。
  // ---------------------------------------------------------------------------
  const otherCharacterItem = await makeItem(characterBId, "B 角色的知识");
  assert.equal((await call("POST", itemPath(characterBId, cyclical.id, "archive"), session.token, { expectedRevision: 5 })).status, 404,
    "不能用 B 角色的路径操作 A 角色的知识");
  assert.equal((await call("DELETE", itemPath(characterBId, trashedItem.id), session.token, {
    expectedRevision: 2, confirm: "PERMANENT_DELETE",
  })).status, 404, "不能跨角色永久删除");
  const trashB = await call("GET", `/characters/${characterBId}/growth/knowledge/trash`, session.token);
  assert.deepEqual((trashB.body.items as Json[]).map(row => row.id), [], "B 角色的回收站不能看到 A 角色的知识");
  assert.equal((await call("DELETE", candidatePath(characterBId, acceptedCandidate.id), session.token)).status, 404,
    "不能跨角色删除候选");
  assert.ok(await prisma.knowledgeItem.findUnique({ where: { id: otherCharacterItem.id } }), "B 角色自己的知识必须还在");

  // 未登录不得调用任何生命周期接口（永久删除更不允许被自动化流程顺手触发）。
  assert.equal((await call("POST", itemPath(characterAId, cyclical.id, "archive"), undefined, { expectedRevision: 5 })).status, 401);
  assert.equal((await call("DELETE", itemPath(characterAId, trashedItem.id), undefined, {
    expectedRevision: 2, confirm: "PERMANENT_DELETE",
  })).status, 401);

  console.log("Knowledge lifecycle database checks passed: transitions, illegal moves, optimistic locking, retrieval isolation, restore, purge guards, merge audit protection, cleanup completeness, candidate safety and role isolation.");
} finally {
  server.close();
  await prisma.$disconnect();
}
