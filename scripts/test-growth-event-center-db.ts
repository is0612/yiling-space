import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { publishGrowthEvent } from "../server/utils/growth-event-center";
import {
  claimNextGrowthEventDelivery,
  cleanupGrowthEvents,
  completeGrowthEventDelivery,
  failGrowthEventDelivery,
  processNextGrowthEventDelivery,
  renewGrowthEventDeliveryLease,
  retryFailedGrowthEventDelivery,
} from "../server/utils/growth-event-delivery";
import { GROWTH_EVENT_HANDLERS } from "../server/utils/growth-event-consumers";
import { readMemoryEventReference } from "../server/utils/growth-domain-gateway";
import { collectWatchdogFindings } from "../server/utils/watchdog";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none");
assert(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname),
  "成长事件集成测试仅允许连接本机 PostgreSQL。");
const databaseName = databaseUrl.pathname.replace(/^\//, "");
assert(/^yiling_growth_event_test_[a-f0-9]{32}$/.test(databaseName),
  `拒绝执行：当前库「${databaseName}」不是一次性成长事件测试库。`);

const prisma = getPrisma();
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const owner = await prisma.user.create({
  data: { username: `growth-event-${suffix}`, passwordHash: "x", role: "USER", status: "ACTIVE" },
  select: { id: true },
});
const characterA = await prisma.character.create({
  data: {
    ownerId: owner.id,
    name: "成长事件测试角色 A",
    basePrompt: "isolated test",
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `growth-event-a:${suffix}` } },
  },
  select: { id: true },
});
const characterB = await prisma.character.create({
  data: {
    ownerId: owner.id,
    name: "成长事件测试角色 B",
    basePrompt: "isolated test",
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `growth-event-b:${suffix}` } },
  },
  select: { id: true },
});
const scopeA = await prisma.memoryScope.findFirstOrThrow({
  where: { characterId: characterA.id, scopeType: "CHARACTER_GLOBAL" },
  select: { id: true },
});

async function createMemoryEvent(title: string) {
  return prisma.memoryEvent.create({
    data: {
      memoryScopeId: scopeA.id,
      dayKey: "2026-11-10",
      occurredAt: new Date("2026-11-10T00:00:00.000Z"),
      title,
      detail: "只用于验证事件 Outbox，不包含任何真实用户内容。",
      dedupeKey: `growth-event:${suffix}:${title}`,
    },
    select: { id: true, occurredAt: true },
  });
}

try {
  console.log("\n[1] 领域数据与 Outbox 同事务回滚");
  const rollbackKey = `rollback:${suffix}`;
  await assert.rejects(() => prisma.$transaction(async (tx) => {
    const row = await tx.memoryEvent.create({
      data: {
        memoryScopeId: scopeA.id,
        dayKey: "2026-11-10",
        occurredAt: new Date(),
        title: "事务回滚测试",
        detail: "rollback",
        dedupeKey: rollbackKey,
      },
      select: { id: true, occurredAt: true },
    });
    await publishGrowthEvent(tx, {
      characterId: characterA.id,
      sourceDomain: "memory",
      eventType: "memory.event.created",
      aggregateType: "MemoryEvent",
      aggregateId: row.id,
      occurredAt: row.occurredAt,
      idempotencyKey: `memory.event.created:${row.id}`,
      payload: { sourceId: row.id },
    });
    throw new Error("rollback expected");
  }), /rollback expected/);
  assert.equal(await prisma.memoryEvent.count({ where: { dedupeKey: rollbackKey } }), 0);
  assert.equal(await prisma.growthEvent.count({ where: { characterId: characterA.id } }), 0);

  console.log("\n[2] 新事件幂等发布与消费者扇出");
  const source = await createMemoryEvent("幂等发布");
  const input = {
    characterId: characterA.id,
    sourceDomain: "memory" as const,
    eventType: "memory.event.created",
    aggregateType: "MemoryEvent",
    aggregateId: source.id,
    occurredAt: source.occurredAt,
    idempotencyKey: `memory.event.created:${source.id}`,
    payload: { sourceId: source.id, sourceType: "MemoryEvent" },
  };
  const first = await prisma.$transaction(tx => publishGrowthEvent(tx, input));
  const duplicate = await prisma.$transaction(tx => publishGrowthEvent(tx, input));
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.eventId, first.eventId);
  assert.equal(await prisma.growthEvent.count({ where: { id: first.eventId } }), 1);
  assert.equal(await prisma.growthEventDelivery.count({ where: { eventId: first.eventId } }), 1);
  const concurrentDuplicates = await Promise.all(Array.from({ length: 4 }, () =>
    prisma.$transaction(tx => publishGrowthEvent(tx, input)),
  ));
  assert(concurrentDuplicates.every(result => !result.created && result.eventId === first.eventId));
  assert.equal(await prisma.growthEventDelivery.count({ where: { eventId: first.eventId } }), 1);
  await assert.rejects(() => prisma.$transaction(tx => publishGrowthEvent(tx, {
    ...input,
    eventType: "memory.event.updated",
  })), /幂等键冲突/, "同一幂等键不能被复用于不同事件类型");

  console.log("\n[3] Gateway 严格按 Character 隔离来源读取");
  const found = await prisma.$transaction(tx => readMemoryEventReference(tx, characterA.id, source.id));
  const crossRole = await prisma.$transaction(tx => readMemoryEventReference(tx, characterB.id, source.id));
  assert.equal(found?.id, source.id);
  assert.equal(found?.characterId, characterA.id);
  assert.equal(crossRole, null);

  console.log("\n[4] 过期租约回收、fencing 与旧执行者保护");
  const firstLease = await claimNextGrowthEventDelivery(prisma, { workerId: `worker-a-${suffix}` });
  assert(firstLease);
  assert.equal(firstLease.eventId, first.eventId);
  assert.equal(firstLease.attemptCount, 1);
  const expiredAt = new Date(firstLease.leaseExpiresAt.getTime() + 1);
  const noImmediateRetry = await claimNextGrowthEventDelivery(prisma, {
    workerId: `worker-b-${suffix}`, now: expiredAt,
  });
  assert.equal(noImmediateRetry, null, "租约回收后必须按退避时间等待");
  const recovered = await prisma.growthEventDelivery.findUniqueOrThrow({
    where: { id: firstLease.deliveryId },
  });
  assert.equal(recovered.status, "RETRY_WAIT");
  assert.equal(recovered.leaseToken, null);
  await assert.rejects(
    () => renewGrowthEventDeliveryLease(prisma, firstLease, new Date(expiredAt.getTime() + 1)),
    /租约已失效/,
  );
  assert.equal(await failGrowthEventDelivery(prisma, firstLease, new Error("stale"), new Date(expiredAt.getTime() + 1)), null);

  console.log("\n[5] 只读消费者重试后成功确认");
  const retryAt = new Date(recovered.runAt.getTime() + 1);
  const secondLease = await claimNextGrowthEventDelivery(prisma, {
    workerId: `worker-b-${suffix}`, now: retryAt,
  });
  assert(secondLease);
  assert(secondLease.fencingToken > firstLease.fencingToken);
  await assert.rejects(
    () => completeGrowthEventDelivery(prisma, firstLease, GROWTH_EVENT_HANDLERS["growth.memory-source-integrity"]!, retryAt),
    /租约已失效/,
    "旧执行者不能确认新租约持有者的投递",
  );
  const completedStatus = await completeGrowthEventDelivery(
    prisma, secondLease, GROWTH_EVENT_HANDLERS["growth.memory-source-integrity"]!, retryAt,
  );
  assert.equal(completedStatus, "SUCCEEDED");
  const completed = await prisma.growthEventDelivery.findUniqueOrThrow({
    where: { id: firstLease.deliveryId },
  });
  assert.equal(completed.status, "SUCCEEDED");
  assert(completed.processedAt);

  console.log("\n[6] 消费者异常进入退避重试");
  const secondSource = await createMemoryEvent("失败重试");
  const secondEvent = await prisma.$transaction(tx => publishGrowthEvent(tx, {
    ...input,
    aggregateId: secondSource.id,
    occurredAt: secondSource.occurredAt,
    idempotencyKey: `memory.event.created:${secondSource.id}`,
    payload: { sourceId: secondSource.id },
  }));
  const failed = await processNextGrowthEventDelivery(prisma, {
    "growth.memory-source-integrity": async (tx) => {
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          characterId: characterA.id,
          action: "growth.test.rollback",
          entityType: "GrowthEvent",
          entityId: secondEvent.eventId,
        },
      });
      throw new Error("temporary consumer failure");
    },
  }, { workerId: `worker-fail-${suffix}` });
  assert.equal(await prisma.auditLog.count({
    where: { action: "growth.test.rollback", entityId: secondEvent.eventId },
  }), 0, "消费者先写后失败时，业务写入必须与确认事务一起回滚");
  assert.equal(failed.processed, true);
  assert.equal(failed.status, "RETRY_WAIT");
  const secondDelivery = await prisma.growthEventDelivery.findUniqueOrThrow({
    where: { eventId_consumerKey: { eventId: secondEvent.eventId, consumerKey: "growth.memory-source-integrity" } },
  });
  assert.equal(secondDelivery.status, "RETRY_WAIT");
  assert.match(secondDelivery.lastError ?? "", /temporary consumer failure/);

  console.log("\\n[7] 来源已不存在时明确 SKIPPED，不进入重试");
  const missingSourceId = randomUUID();
  const missingEvent = await prisma.$transaction(tx => publishGrowthEvent(tx, {
    ...input,
    aggregateId: missingSourceId,
    occurredAt: new Date(),
    idempotencyKey: `memory.event.created:${missingSourceId}`,
    payload: { sourceId: missingSourceId },
  }));
  const skipped = await processNextGrowthEventDelivery(prisma, GROWTH_EVENT_HANDLERS, {
    workerId: `worker-skip-${suffix}`,
  });
  assert.equal(skipped.status, "SKIPPED");
  const skippedDelivery = await prisma.growthEventDelivery.findUniqueOrThrow({
    where: { eventId_consumerKey: { eventId: missingEvent.eventId, consumerKey: "growth.memory-source-integrity" } },
  });
  assert.equal(skippedDelivery.status, "SKIPPED");
  assert.match(skippedDelivery.lastError ?? "", /来源忆泡不存在/);

  console.log("\\n[8] FAILED 投递可审计地手动恢复");
  const manualSource = await createMemoryEvent("手动恢复");
  const manualEvent = await prisma.$transaction(tx => publishGrowthEvent(tx, {
    ...input,
    aggregateId: manualSource.id,
    occurredAt: manualSource.occurredAt,
    idempotencyKey: `memory.event.created:${manualSource.id}`,
    payload: { sourceId: manualSource.id },
  }));
  const manualDelivery = await prisma.growthEventDelivery.findUniqueOrThrow({
    where: { eventId_consumerKey: { eventId: manualEvent.eventId, consumerKey: "growth.memory-source-integrity" } },
  });
  await prisma.growthEventDelivery.update({
    where: { id: manualDelivery.id },
    data: { status: "FAILED", attemptCount: 5, lastError: "terminal failure" },
  });
  const retried = await retryFailedGrowthEventDelivery(prisma, manualDelivery.id);
  assert.equal(retried?.previousAttemptCount, 5);
  assert.equal(retried?.characterId, characterA.id);
  assert.equal(await retryFailedGrowthEventDelivery(prisma, manualDelivery.id), null,
    "同一 FAILED 投递只能被手动恢复一次");
  const requeued = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: manualDelivery.id } });
  assert.equal(requeued.status, "QUEUED");
  assert.equal(requeued.attemptCount, 0);
  assert.equal(requeued.fencingToken, manualDelivery.fencingToken, "恢复不能重置 fencing 单调序列");
  assert.equal(requeued.lastError, "terminal failure", "保留上次错误直到新执行者领取");
  assert(await prisma.auditLog.findFirst({
    where: { action: "growth.event_delivery.manual_retry", entityId: manualDelivery.id },
  }), "手动恢复必须写 SYSTEM 审计");

  console.log("\\n[9] Watchdog 能识别角色范围内的成长事件积压");
  const findings = await collectWatchdogFindings(prisma, new Date(Date.now() + 2 * 60 * 60 * 1000));
  assert(findings.some(finding =>
    finding.code === "growth_event_worker_stalled" && finding.characterId === characterA.id,
  ), "已到期的重试投递积压应定位到所属角色");

  console.log("\\n[10] 成功事件保留期清理，失败事件继续保留");
  const removed = await cleanupGrowthEvents(prisma, {
    now: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    retentionDays: 30,
  });
  assert.equal(removed, 2, "只清理已成功/跳过且超过保留期的事件");
  assert.equal(await prisma.growthEvent.findUnique({ where: { id: first.eventId } }), null);
  assert.equal(await prisma.growthEvent.findUnique({ where: { id: missingEvent.eventId } }), null);
  assert(await prisma.growthEvent.findUnique({ where: { id: secondEvent.eventId } }),
    "仍有待重试投递的事件必须保留");
  assert(await prisma.growthEvent.findUnique({ where: { id: manualEvent.eventId } }),
    "手动恢复后仍在队列中的事件必须保留");

  console.log("Growth Event Center DB integration tests passed.");
} finally {
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [characterA.id, characterB.id] } } });
  await prisma.character.deleteMany({ where: { ownerId: owner.id } });
  await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}
