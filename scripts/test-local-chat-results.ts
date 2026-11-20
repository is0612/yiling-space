import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../server/utils/prisma";
import { createLocalBrowserRequest } from "../server/utils/local-browser";
import { readLocalContinuationTask, readLocalChatResults } from "../server/utils/local-chat-results";
import { approveLocalWriteRequest, createLocalWriteRequest } from "../server/utils/local-write";

const db = getPrisma();
const actor = randomUUID();
const characterId = randomUUID();
const rootId = randomUUID();
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-results-"));
let taskId: string | null = null;
try {
  await db.user.create({ data: { id: actor, username: `local-results-test-${actor}`, passwordHash: "x", role: "ADMIN" } });
  await db.character.create({ data: { id: characterId, ownerId: actor, name: "结果测试", basePrompt: "test" } });
  const scope = await db.memoryScope.create({ data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` } });
  const first = await db.conversation.create({ data: { characterId, memoryScopeId: scope.id, title: "first" } });
  const other = await db.conversation.create({ data: { characterId, memoryScopeId: scope.id, title: "other" } });
  const qq = await db.conversation.create({ data: { characterId, memoryScopeId: scope.id, title: "channel", externalConversationId: "g:777" } });
  await db.localAccessRoot.create({ data: { id: rootId, path: folder, label: "results-test", mode: "READ_WRITE" } });
  const write = await createLocalWriteRequest({ rootId, actorId: actor, characterId, conversationId: first.id,
    relativePath: "list.txt", content: "Milk\nEggs\nBread\n", reason: "test", taskPlan: { title: "结果卡片", goal: "test", acceptance: "三行" } });
  taskId = write.taskId;
  assert.equal((await readLocalChatResults(actor, characterId, first.id)).tasks.length, 1);
  assert.equal((await readLocalChatResults(actor, characterId, other.id)).tasks.length, 0);
  await assert.rejects(() => readLocalChatResults(randomUUID(), characterId, first.id), { statusCode: 404 });
  await assert.rejects(() => readLocalChatResults(actor, characterId, qq.id), { statusCode: 404 });
  await assert.rejects(() => readLocalContinuationTask(actor, characterId, first.id, taskId!), { statusCode: 409 });
  await approveLocalWriteRequest(write.id, actor);
  const a = await readLocalChatResults(actor, characterId, first.id);
  const b = await readLocalChatResults(actor, characterId, first.id);
  assert.equal(a.tasks[0]?.status, "RUNNING");
  assert.equal(a.tasks[0]?.writeRequests[0]?.status, "APPLIED");
  assert.equal(a.tasks[0]?.evidence.length, 1);
  assert.match(a.tasks[0]!.evidence[0]!.note, /Milk\nEggs\nBread/);
  assert.deepEqual(a, b, "Repeated polling never creates new messages or results");
  assert.equal(await db.message.count({ where: { conversationId: first.id } }), 0);
  assert.equal(a.tasks[0]?.canContinue, true);
  const resumed = await readLocalContinuationTask(actor, characterId, first.id, taskId!);
  assert.equal(resumed.steps.length, 2);
  await assert.rejects(() => readLocalContinuationTask(actor, characterId, other.id, taskId!), { statusCode: 404 });
  await assert.rejects(() => createLocalWriteRequest({ rootId, taskId: taskId!, characterId, conversationId: first.id,
    actorId: actor, relativePath: "list.txt", content: "Milk\nEggs\nBread\n", reason: "duplicate", avoidCompletedDuplicate: true }), /不要重复执行/);
  const next = await createLocalWriteRequest({ rootId, taskId: taskId!, characterId, conversationId: first.id,
    actorId: actor, relativePath: "next.txt", content: "next step", reason: "continuation", avoidCompletedDuplicate: true });
  assert.equal(next.status, "PENDING");
  assert.equal(next.taskId, taskId);
  assert.equal(fs.existsSync(path.join(folder, "next.txt")), false);
  assert.equal((await readLocalChatResults(actor, characterId, first.id)).tasks[0]?.canContinue, false);
  await approveLocalWriteRequest(next.id, actor);
  assert.equal((await readLocalContinuationTask(actor, characterId, first.id, taskId!)).steps.length, 4);
  assert.equal((await readLocalChatResults(actor, characterId, first.id)).tasks[0]?.evidence.length, 2);
  const browserPending = await db.localBrowserRequest.create({ data: { actorId: actor, characterId, conversationId: first.id,
    taskId: taskId!, url: "https://example.com/", actions: [{ kind: "scroll", direction: "down" }], reason: "test" } });
  const withBrowser = await readLocalChatResults(actor, characterId, first.id);
  assert.equal(withBrowser.browserRequests.length, 1);
  assert.equal(withBrowser.browserRequests[0]?.status, "PENDING");
  assert.equal(withBrowser.tasks[0]?.canContinue, false, "A pending browser request on this task blocks continuation");
  await assert.rejects(() => readLocalContinuationTask(actor, characterId, first.id, taskId!), { statusCode: 409 });
  await db.localBrowserRequest.update({ where: { id: browserPending.id }, data: { status: "SUCCEEDED" } });
  assert.equal((await readLocalChatResults(actor, characterId, first.id)).tasks[0]?.canContinue, true);
  const steppedBrowser = await createLocalBrowserRequest({ actorId: actor, characterId, conversationId: first.id, taskId: taskId!,
    attachStep: true, url: "https://example.com/", actions: [{ kind: "scroll", y: 120 }], reason: "step" });
  const stepped = await readLocalContinuationTask(actor, characterId, first.id, taskId!).catch(() => null);
  assert.equal(stepped, null, "A pending browser step blocks continuation until it is approved");
  const taskWithBrowserStep = await db.localTask.findUniqueOrThrow({ where: { id: taskId! }, select: { steps: true } });
  assert.ok((taskWithBrowserStep.steps as unknown as { request?: { kind: string } }[]).some(step => step.request?.kind === "browser"));
  await db.localBrowserRequest.deleteMany({ where: { id: steppedBrowser.id } });

  const firstBrowser = await createLocalBrowserRequest({ actorId: actor, characterId, conversationId: first.id,
    url: "https://example.com/", actions: [{ kind: "scroll", y: 200 }], reason: "dedupe" });
  await assert.rejects(() => createLocalBrowserRequest({ actorId: actor, characterId, conversationId: first.id,
    url: "https://example.com/", actions: [{ kind: "scroll", y: 200 }], reason: "dedupe again" }), /不要重复提交/);
  await db.localBrowserRequest.deleteMany({ where: { id: firstBrowser.id } });
  // A standalone request in the same conversation is shown but must not freeze an unrelated task.
  const standalone = await db.localBrowserRequest.create({ data: { actorId: actor, characterId, conversationId: first.id,
    url: "https://example.com/", actions: [{ kind: "scroll", y: 10 }], reason: "standalone" } });
  assert.equal((await readLocalChatResults(actor, characterId, first.id)).tasks[0]?.canContinue, true);
  await db.localBrowserRequest.deleteMany({ where: { id: { in: [browserPending.id, standalone.id] } } });

  await db.conversation.delete({ where: { id: first.id } });
  await assert.rejects(() => readLocalChatResults(actor, characterId, first.id), { statusCode: 404 });
  console.log("Chat results: owner/character/conversation isolation, channel refusal, readback, repeat polling and deleted conversation passed.");
} finally {
  await db.localAccessRoot.deleteMany({ where: { id: rootId } });
  if (taskId) await db.localTask.deleteMany({ where: { id: taskId, actorId: actor } });
  await db.conversation.deleteMany({ where: { characterId } });
  await db.memoryScope.deleteMany({ where: { characterId } });
  await db.character.deleteMany({ where: { id: characterId, ownerId: actor } });
  await db.user.deleteMany({ where: { id: actor, username: `local-results-test-${actor}` } });
  fs.rmSync(folder, { recursive: true, force: true });
  await db.$disconnect();
}
