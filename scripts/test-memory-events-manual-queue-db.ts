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
  // 运行中：不能抢 Worker 已经领走的任务。
  const runningJob = await prisma.memoryJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", lockedBy: "other-worker", lockedAt: now },
  });
  assert.equal(await queueManualMemoryEvents(prisma, input), null);
  assert.deepEqual(await prisma.memoryJob.findUnique({ where: { id: job.id } }), runningJob);
  /**
   * 失败 / 已取消：手点「立即整理忆泡」就是人工重试。
   *
   * 以前这两种状态会被当成「没得整理」，页面回一句「昨天和今天都还没有对话」——
   * 对话明明在，只是上一次没跑成。重跑时还要把上次的痕迹清干净，
   * 否则 attemptCount 已到上限，重排一次也立刻再判失败。
   */
  for (const status of ["FAILED", "CANCELLED"] as const) {
    await prisma.memoryJob.update({
      where: { id: job.id },
      data: { status, attemptCount: 3, lastError: "synthetic timeout", startedAt: now, completedAt: now },
    });
    assert.equal(await queueManualMemoryEvents(prisma, input), job.id, `${status} 的任务要能被手动整理重新排起来。`);
    const retried = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(retried.status, "QUEUED");
    assert.equal(retried.attemptCount, 0, "重试要把 attemptCount 清零，否则预算已经用光。");
    assert.equal(retried.lastError, null);
    assert.equal(retried.startedAt, null);
    assert.equal(retried.completedAt, null);
    assert.equal(retried.runAt.getTime(), now.getTime());
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

  // ── 端到端：失败之后点按钮，页面不该再收到「没什么可整理的」 ──────────────
  await prisma.memoryJob.update({
    where: { id: job.id },
    data: { status: "FAILED", attemptCount: 3, lastError: "synthetic timeout" },
  });
  const retriedByClick = await request();
  assert.equal(retriedByClick.body.queued.length, 1, "上一次失败的那一段要能被按钮重新排起来。");
  assert.equal(retriedByClick.body.notice, "queued");
  assert.equal((await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).status, "QUEUED");

  // 还在跑：不能抢 Worker，但页面要说清是「正在整理」而不是「没有对话」。
  await prisma.memoryJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", lockedBy: "worker-a", lockedAt: now },
  });
  const whileRunning = await request();
  assert.equal(whileRunning.body.queued.length, 0);
  assert.equal(whileRunning.body.notice, "running");

  /**
   * 卡住的「运行中」：领走它的进程已经不在了（租约过期），这时按钮必须能接管。
   * 和任务监控的重新入队共用同一个 5 分钟，否则页面标「卡住」、按钮说「正在整理」。
   */
  await prisma.memoryJob.update({
    where: { id: job.id },
    data: {
      status: "RUNNING",
      lockedBy: "dead-worker",
      lockedAt: new Date(now.getTime() - 10 * 60 * 1000),
      attemptCount: 3,
      lastError: "worker vanished",
    },
  });
  assert.equal(await queueManualMemoryEvents(prisma, input), job.id, "租约过期的运行中任务要能被按钮接管。");
  const reclaimed = await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(reclaimed.status, "QUEUED");
  assert.equal(reclaimed.lockedAt, null);
  assert.equal(reclaimed.lockedBy, null);
  assert.equal(reclaimed.attemptCount, 0, "接管重跑要重新给满次数。");
  assert.equal(reclaimed.lastError, null);

  // 整理完且没有新消息：这时才该说「没有可整理的新对话」。
  await prisma.memoryJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED" } });
  await prisma.memoryEventDay.upsert({
    where: { memoryScopeId_dayKey: { memoryScopeId: scopeId, dayKey } },
    create: { memoryScopeId: scopeId, dayKey, extractedAt: occurredAt, extractedMessageId: ids[1] },
    update: { extractedAt: occurredAt, extractedMessageId: ids[1] },
  });
  const nothingNew = await request();
  assert.equal(nothingNew.body.queued.length, 0);
  assert.equal(nothingNew.body.notice, "no-new-messages");

  console.log("Manual memory queue passed: real h3 auth/handler, DB queue reuse, cursor increment, state/updatedAt CAS, exact worker target, failed/cancelled retry, stale-lease takeover and running/no-new notices; no model calls.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
