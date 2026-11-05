import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import { queueManualMemoryEvents } from "../server/utils/memory-events-manual-queue";
import { createManualMemoryEventsHandler } from "../server/api/characters/[id]/memory-events/extract.post";
import { localDayHour, resolveDayWindow } from "../server/utils/memory-event-time";

// Refuse business databases even when this entry is invoked outside the isolated runner.
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const conversationId = randomUUID();
const now = new Date();
const { dayKey, hour } = localDayHour(now, "Asia/Shanghai");
const window = resolveDayWindow(dayKey, "Asia/Shanghai");
const input = {
  memoryScopeId: scopeId, privateOnly: false, dayKey,
  idempotencyKey: `events-hour:${scopeId}:${dayKey}:${hour}`,
  periodStart: window.start, periodEnd: window.end, hourly: true, now,
};
const calls: string[] = [];
const app = createApp();
const router = createRouter();
router.post("/characters/:id/memory-events/extract", createManualMemoryEventsHandler(async (_db, options) => {
  assert.equal(options?.ownerId, ownerId);
  assert.ok(options?.jobId, "handler must pass the exact target job ID");
  calls.push(options.jobId);
  // Mock only execution: all handler routing, authentication and queue SQL remain real.
  return { processed: false, message: "mock worker intentionally leaves queue untouched" };
}));
app.use(router);
const server = createServer(toNodeListener(app));
try {
  await prisma.user.create({ data: { id: ownerId, username: `manual-${ownerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId, name: "Manual queue test", basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${scopeId}` } });
  await prisma.conversation.create({ data: { id: conversationId, characterId, memoryScopeId: scopeId } });
  const ids = [randomUUID(), randomUUID()].sort();
  const occurredAt = new Date(window.start.getTime() + 1000);
  await prisma.message.create({ data: { id: ids[0], conversationId, role: "USER", content: "first", occurredAt } });
  const otherCharacter = await prisma.character.create({ data: {
    ownerId, name: "Unrelated queue", basePrompt: "test",
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `other:${randomUUID()}` } },
  }, include: { memoryScopes: true } });
  const unrelatedJob = await prisma.memoryJob.create({ data: {
    memoryScopeId: otherCharacter.memoryScopes[0]!.id, type: "EXTRACT_EVENTS",
    idempotencyKey: `unrelated:${randomUUID()}`, periodStart: window.start, periodEnd: window.end,
    runAt: new Date(now.getTime() - 3600000),
  } });
  const session = await createSession({ userId: ownerId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = async (target = characterId, cookie = session.token) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/characters/${target}/memory-events/extract`, {
      method: "POST", headers: { cookie: `yiling_session=${cookie}` },
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(characterId, "invalid-session")).status, 401);
  assert.equal((await request(randomUUID())).status, 404);
  assert.equal(calls.length, 0);
  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.body.queued.length, 1);
  const job = await prisma.memoryJob.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  assert.deepEqual(calls, [job.id]);
  await prisma.memoryEventDay.create({ data: { memoryScopeId: scopeId, dayKey, extractedAt: occurredAt, extractedMessageId: ids[0] } });
  await prisma.memoryJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", completedAt: now, attemptCount: 1 } });
  assert.equal((await request()).body.queued.length, 0, "completed hour without new evidence stays completed");
  await prisma.message.create({ data: { id: ids[1], conversationId, role: "USER", content: "same timestamp, later UUID", occurredAt } });
  assert.equal((await request()).body.queued.length, 1, "actual handler requeues succeeded hour for new evidence");
  assert.equal(await prisma.memoryJob.count({ where: { memoryScopeId: scopeId } }), 1, "clicks never add unique jobs");
  assert.deepEqual(calls, [job.id, job.id]);
  assert.deepEqual(await prisma.memoryJob.findUnique({ where: { id: unrelatedJob.id } }), unrelatedJob,
    "request must leave an older job for another character untouched");
  for (const status of ["QUEUED", "RETRY_WAIT", "SKIPPED"] as const) {
    await prisma.memoryJob.update({ where: { id: job.id }, data: { status, runAt: new Date(now.getTime() + 3600000) } });
    assert.equal(await queueManualMemoryEvents(prisma, input), job.id);
    const woken = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(woken.status, "QUEUED");
    assert.equal(woken.runAt.getTime(), now.getTime());
  }
  for (const status of ["RUNNING", "FAILED", "CANCELLED"] as const) {
    const before = await prisma.memoryJob.update({ where: { id: job.id }, data: { status, lockedBy: "other-worker", lockedAt: now } });
    assert.equal(await queueManualMemoryEvents(prisma, input), null);
    assert.deepEqual(await prisma.memoryJob.findUnique({ where: { id: job.id } }), before);
  }
  await prisma.memoryJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED" } });
  assert.equal(await queueManualMemoryEvents(prisma, { ...input, hourly: false }), null, "successful final jobs retain scheduler idempotency");
  await prisma.$executeRaw`UPDATE memory_jobs SET "updatedAt" = '2026-11-01T00:00:00.123456Z'::timestamptz WHERE id = ${job.id}::uuid`;
  assert.equal(await queueManualMemoryEvents(prisma, input), job.id,
    "legacy microsecond updatedAt can be requeued without JS Date precision loss");
  // Force a worker claim between read and CAS using the real delegate and SQL.
  const raced = new Proxy(prisma, {
    get(target, key) {
      if (key === "$executeRaw") return async (...args: Parameters<typeof target.$executeRaw>) => {
        await target.memoryJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedBy: "race-worker", lockedAt: now } });
        return target.$executeRaw(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.equal(await queueManualMemoryEvents(raced, input), null);
  const claimed = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(claimed.status, "RUNNING");
  assert.equal(claimed.lockedBy, "race-worker");
  // Same-status updatedAt races must fail too, not just RUNNING transitions.
  await prisma.memoryJob.update({ where: { id: job.id }, data: { status: "QUEUED" } });
  const updatedRace = new Proxy(prisma, {
    get(target, key) {
      if (key === "$executeRaw") return async (...args: Parameters<typeof target.$executeRaw>) => {
        await target.$executeRaw`UPDATE memory_jobs SET "updatedAt" = "updatedAt" + interval '1 microsecond' WHERE id = ${job.id}::uuid`;
        return target.$executeRaw(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.equal(await queueManualMemoryEvents(updatedRace, input), null);
  assert.equal(await prisma.memoryJob.count({ where: { memoryScopeId: scopeId } }), 1);
  const privateInput = { ...input, idempotencyKey: `private-only:${randomUUID()}`, privateOnly: true };
  assert.equal(await queueManualMemoryEvents(prisma, privateInput), null,
    "external private extraction never queues historical group/local evidence");
  const concurrentInput = { ...input, idempotencyKey: `events-hour:${scopeId}:${dayKey}:next-test-hour` };
  const concurrent = await Promise.all([
    queueManualMemoryEvents(prisma, concurrentInput), queueManualMemoryEvents(prisma, concurrentInput),
  ]);
  const concurrentJob = await prisma.memoryJob.findUniqueOrThrow({ where: { idempotencyKey: concurrentInput.idempotencyKey } });
  assert.ok(concurrent.some((id) => id === concurrentJob.id));
  assert.ok(concurrent.every((id) => id === null || id === concurrentJob.id));
  assert.equal(await prisma.memoryJob.count({ where: { idempotencyKey: concurrentInput.idempotencyKey } }), 1);
  console.log("Manual memory queue passed: real h3 auth/handler, DB queue reuse, cursor increment, state/updatedAt CAS, exact worker target; no model calls.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
