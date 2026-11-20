import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { autoContinueLimit, planAutoContinue, runAutoContinue, scheduleAutoContinue } from "../server/utils/auto-continue";
import { createLocalTask } from "../server/utils/local-tasks";

const db = getPrisma();
const actor = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const conversationId = randomUUID();
const tasks: string[] = [];
const previous = process.env.YILING_AUTO_CONTINUE;

try {
  await db.user.create({ data: { id: actor, username: `auto-continue-test-${actor}`, passwordHash: "x", role: "ADMIN" } });
  await db.character.create({ data: { id: characterId, ownerId: actor, name: "自动续办", basePrompt: "test" } });
  await db.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` } });
  await db.conversation.create({ data: { id: conversationId, characterId, memoryScopeId: scopeId, title: "auto" } });

  // Switch off: nothing runs and nothing is recorded.
  delete process.env.YILING_AUTO_CONTINUE;
  assert.deepEqual(await planAutoContinue("00000000-0000-4000-8000-000000000000"), { run: false, reason: "disabled" });

  process.env.YILING_AUTO_CONTINUE = "1";
  const task = await createLocalTask({ title: "自动", goal: "g", plan: "p", actorId: actor, characterId, conversationId });
  tasks.push(task.id);
  await db.localTask.update({ where: { id: task.id }, data: { status: "RUNNING" } });

  assert.deepEqual(await planAutoContinue(task.id), { run: false, reason: "task_off" });
  await db.localTask.update({ where: { id: task.id }, data: { autoContinue: true } });
  const planned = await planAutoContinue(task.id);
  assert.equal(planned.run, true, "Enabled task with a conversation is allowed to run");

  // A pending approval must freeze the loop: nothing new may be proposed while the owner decides.
  const waiting = await db.localBrowserRequest.create({ data: { actorId: actor, characterId, conversationId, taskId: task.id,
    url: "https://example.com/", actions: [{ kind: "scroll", y: 10 }], reason: "t" } });
  assert.deepEqual(await planAutoContinue(task.id), { run: false, reason: "pending_approval" });
  await db.localBrowserRequest.update({ where: { id: waiting.id }, data: { status: "FILLED" } });
  assert.deepEqual(await planAutoContinue(task.id), { run: false, reason: "pending_approval" }, "A filled form also blocks the loop");
  await db.localBrowserRequest.delete({ where: { id: waiting.id } });

  // The round budget is claimed before the call, so an unreachable endpoint still spends exactly one round.
  process.env.PORT = "1";
  const first = await runAutoContinue(task.id, actor);
  assert.equal(first.started, true);
  assert.equal(first.ok, false);
  assert.equal((await db.localTask.findUniqueOrThrow({ where: { id: task.id } })).autoRounds, 1);
  assert.equal(await db.session.count({ where: { userAgent: "yiling-auto-continue" } }), 0, "The self-call session is removed again");

  await db.localTask.update({ where: { id: task.id }, data: { autoRounds: autoContinueLimit() } });
  assert.deepEqual(await planAutoContinue(task.id), { run: false, reason: "round_limit" });
  assert.equal((await runAutoContinue(task.id, actor)).started, false);

  // Finished tasks never resume on their own.
  await db.localTask.update({ where: { id: task.id }, data: { status: "SUCCEEDED", autoRounds: 0 } });
  assert.equal((await planAutoContinue(task.id)).run, false);

  scheduleAutoContinue(null, actor);
  scheduleAutoContinue(task.id, actor);
  console.log("Auto continue: master switch, per-task switch, pending freeze, durable round budget, session cleanup and finished-task stop passed.");
} finally {
  if (previous === undefined) delete process.env.YILING_AUTO_CONTINUE;
  else process.env.YILING_AUTO_CONTINUE = previous;
  await db.localBrowserRequest.deleteMany({ where: { taskId: { in: tasks } } }).catch(() => {});
  await db.localTask.deleteMany({ where: { id: { in: tasks } } }).catch(() => {});
  await db.conversation.deleteMany({ where: { id: conversationId } }).catch(() => {});
  await db.memoryScope.deleteMany({ where: { id: scopeId } }).catch(() => {});
  await db.character.deleteMany({ where: { id: characterId, ownerId: actor } }).catch(() => {});
  await db.session.deleteMany({ where: { userId: actor } }).catch(() => {});
  await db.user.deleteMany({ where: { id: actor, username: `auto-continue-test-${actor}` } }).catch(() => {});
  await db.$disconnect();
}
