import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { PrismaClient } from "../src/generated/prisma/client";
import { getPrisma } from "../server/utils/prisma";
import { publishGrowthEvent } from "../server/utils/growth-event-center";
import {
  claimNextGrowthEventDelivery,
  completeGrowthEventDelivery,
  failGrowthEventDelivery,
  renewGrowthEventDeliveryLease,
} from "../server/utils/growth-event-delivery";
import { collectWatchdogFindings } from "../server/utils/watchdog";

// Both guards run before constructing a client or opening a connection.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname),
  "Growth Event Center concurrency tests require a local PostgreSQL host.");
assert(/^\/yiling_growth_event_test_[a-f0-9]{32}$/.test(databaseUrl.pathname),
  "Growth Event Center concurrency tests require a disposable isolated database.");
// Bound every pool connection: the former blocking UPDATE must fail rather than hang.
const existingOptions = databaseUrl.searchParams.get("options") ?? "";
databaseUrl.searchParams.set("options", `${existingOptions} -c statement_timeout=4000 -c lock_timeout=2000`.trim());
process.env.DATABASE_URL = databaseUrl.toString();
const prisma = getPrisma();
const MINUTE = 60_000;

type Scenario = { characterId: string; ownerId: string; now: Date };

async function scenario(label: string, run: (context: Scenario) => Promise<void>) {
  console.log(`\n[concurrency] ${label}`);
  const owner = await prisma.user.create({
    data: { username: `growth-concurrency-${randomUUID()}`, passwordHash: "test-only", role: "USER", status: "ACTIVE" },
    select: { id: true },
  });
  let characterId: string | undefined;
  try {
    const character = await prisma.character.create({
      data: { ownerId: owner.id, name: `并发回归 ${randomUUID()}`, basePrompt: "disposable concurrency fixture" },
      select: { id: true },
    });
    characterId = character.id;
    await run({ characterId, ownerId: owner.id, now: new Date() });
  } finally {
    if (characterId) {
      // Explicit per-scenario cleanup keeps the global claim queue free of earlier fixtures.
      await prisma.growthEvent.deleteMany({ where: { characterId } });
      await prisma.auditLog.deleteMany({ where: { characterId } });
      await prisma.character.delete({ where: { id: characterId } });
    }
    await prisma.user.delete({ where: { id: owner.id } });
  }
}

async function queue(context: Scenario, count: number) {
  const events = Array.from({ length: count }, () => ({
    id: randomUUID(), characterId: context.characterId, sourceDomain: "memory",
    eventType: "memory.event.created", aggregateType: "MemoryEvent", aggregateId: randomUUID(),
    occurredAt: context.now, idempotencyKey: `concurrency:${randomUUID()}`,
  }));
  await prisma.growthEvent.createMany({ data: events });
  const deliveries = events.map(event => ({
    id: randomUUID(), eventId: event.id, consumerKey: "growth.memory-source-integrity", runAt: context.now,
  }));
  await prisma.growthEventDelivery.createMany({ data: deliveries });
  return deliveries;
}

async function claim(workerId: string, now: Date) {
  return claimNextGrowthEventDelivery(prisma, { workerId, now });
}

async function withRowLock(deliveryId: string, run: (connection: Client) => Promise<void>) {
  const connection = new Client({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 4_000 });
  await connection.connect();
  try {
    await connection.query("BEGIN");
    // Awaited row acquisition is the barrier; claims start only once this lock is held.
    await connection.query('SELECT "id" FROM "growth_event_deliveries" WHERE "id" = $1 FOR UPDATE', [deliveryId]);
    await run(connection);
  } finally {
    await connection.query("ROLLBACK"); // Harmless if the scenario committed the renewal.
    await connection.end();
  }
}

try {
  await scenario("locked expired row does not block two workers or duplicate a claim", async context => {
    await queue(context, 1);
    const expired = await claim("original", context.now);
    assert(expired);
    const afterExpiry = new Date(expired.leaseExpiresAt.getTime() + 1);
    const unrelated = await queue({ ...context, now: afterExpiry }, 2);
    await withRowLock(expired.deliveryId, async () => {
      // Keep the blocker open until both calls finish. An implementation that waits
      // for the expired row will hit the connection's lock/statement timeout.
      const results = await Promise.all([claim("worker-a", afterExpiry), claim("worker-b", afterExpiry)]);
      assert(results[0] && results[1], "Both workers must claim unrelated ready deliveries while the lock remains held.");
      assert.notEqual(results[0].deliveryId, results[1].deliveryId);
      assert.deepEqual(new Set(results.map(result => result?.deliveryId)), new Set(unrelated.map(row => row.id)));
      const locked = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: expired.deliveryId } });
      assert.equal(locked.status, "RUNNING");
      assert.equal(locked.leaseToken, expired.leaseToken);
    });
  });

  await scenario("uncommitted renewal is skipped and committed renewal is not reclaimed", async context => {
    await queue(context, 1);
    const lease = await claim("renewing-worker", context.now);
    assert(lease);
    const afterOldExpiry = new Date(lease.leaseExpiresAt.getTime() + 1);
    const renewedExpiry = new Date(afterOldExpiry.getTime() + 10 * MINUTE);
    const unrelated = await queue({ ...context, now: afterOldExpiry }, 1);
    await withRowLock(lease.deliveryId, async connection => {
      await connection.query(
        'UPDATE "growth_event_deliveries" SET "leaseExpiresAt" = $2, "lockedAt" = $3 WHERE "id" = $1',
        [lease.deliveryId, renewedExpiry, new Date(lease.leaseExpiresAt.getTime() - 1)],
      );
      const other = await claim("during-renewal", afterOldExpiry);
      assert.equal(other?.deliveryId, unrelated[0]!.id, "Do not wait for or reclaim an uncommitted renewal.");
      await connection.query("COMMIT");
    });
    assert.equal(await claim("after-renewal", afterOldExpiry), null);
    const renewed = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } });
    assert.equal(renewed.status, "RUNNING");
    assert.equal(renewed.leaseToken, lease.leaseToken);
    assert.equal(renewed.fencingToken, lease.fencingToken);
    assert.equal(renewed.leaseExpiresAt?.getTime(), renewedExpiry.getTime());
  });

  await scenario("successful renewal API protects delivery beyond its original expiry", async context => {
    await queue(context, 1);
    const lease = await claim("renew-api-worker", context.now);
    assert(lease);
    const renewalAt = new Date(lease.leaseExpiresAt.getTime() - 1_000);
    const extendedExpiry = await renewGrowthEventDeliveryLease(prisma, lease, renewalAt, 10 * MINUTE);
    assert.equal(extendedExpiry.getTime(), renewalAt.getTime() + 10 * MINUTE);
    assert(extendedExpiry > lease.leaseExpiresAt);
    assert.equal(await claim("after-original-expiry", new Date(lease.leaseExpiresAt.getTime() + 1)), null);
    const row = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } });
    assert.equal(row.status, "RUNNING");
    assert.equal(row.leaseToken, lease.leaseToken);
    assert.equal(row.fencingToken, lease.fencingToken);
    assert.equal(row.lockedAt?.getTime(), renewalAt.getTime());
    assert.equal(row.leaseExpiresAt?.getTime(), extendedExpiry.getTime());
  });

  await scenario("reclamation wins; stale renew, fail and complete lose authority", async context => {
    await queue(context, 1);
    const stale = await claim("stale-worker", context.now);
    assert(stale);
    const expiredAt = new Date(stale.leaseExpiresAt.getTime() + 1);
    assert.equal(await claim("reclaimer", expiredAt), null, "Reclaimed deliveries must respect retry backoff.");
    const recovered = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: stale.deliveryId } });
    assert.equal(recovered.status, "RETRY_WAIT");
    assert.equal(recovered.leaseToken, null);
    await assert.rejects(() => renewGrowthEventDeliveryLease(prisma, stale, expiredAt), /租约已失效/);
    assert.equal(await failGrowthEventDelivery(prisma, stale, new Error("stale failure"), expiredAt), null);
    let handlerCalled = false;
    const assertStaleComplete = () => assert.rejects(() => completeGrowthEventDelivery(prisma, stale, async () => {
      handlerCalled = true;
    }, expiredAt), /租约已失效/);
    await assertStaleComplete();
    assert.equal(handlerCalled, false, "A stale executor must not enter the consumer handler.");

    const retryAt = new Date(recovered.runAt.getTime() + 1);
    const current = await claim("replacement-worker", retryAt);
    assert(current);
    assert(current.fencingToken > stale.fencingToken);
    await assert.rejects(() => renewGrowthEventDeliveryLease(prisma, stale, retryAt), /租约已失效/);
    assert.equal(await failGrowthEventDelivery(prisma, stale, new Error("stale replacement failure"), retryAt), null);
    await assert.rejects(() => completeGrowthEventDelivery(prisma, stale, async () => {
      handlerCalled = true;
    }, retryAt), /租约已失效/);
    assert.equal(handlerCalled, false);
    const preserved = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: current.deliveryId } });
    assert.equal(preserved.status, "RUNNING");
    assert.equal(preserved.leaseToken, current.leaseToken);
    assert.equal(preserved.fencingToken, current.fencingToken);
  });

  await scenario("one claim reclaims at most 100; concurrent workers drain remaining batches", async context => {
    const deliveries = await queue(context, 251);
    await prisma.growthEventDelivery.updateMany({
      where: { event: { characterId: context.characterId } },
      data: { status: "RUNNING", attemptCount: 1, lockedBy: "expired-fixture", leaseToken: randomUUID(),
        fencingToken: 1, lockedAt: new Date(context.now.getTime() - 10 * MINUTE),
        leaseExpiresAt: new Date(context.now.getTime() - 1) },
    });
    // Include a legacy NULL expiry; it must be selected before timestamp expiries.
    await prisma.growthEventDelivery.update({ where: { id: deliveries[0]!.id }, data: { leaseExpiresAt: null } });
    const where = { event: { characterId: context.characterId } };
    await prisma.$transaction(async tx => {
      assert.equal(await claimNextGrowthEventDelivery(tx as unknown as PrismaClient, {
        workerId: "batch-first-held", now: context.now,
      }), null);
      assert.equal(await tx.growthEventDelivery.count({ where: { ...where, status: "RETRY_WAIT" } }), 100);
      assert.equal(await tx.growthEventDelivery.count({ where: { ...where, status: "RUNNING" } }), 151);
      assert.equal((await tx.growthEventDelivery.findUniqueOrThrow({ where: { id: deliveries[0]!.id } })).status, "RETRY_WAIT");

      // The first claim has finished its SQL but this transaction still owns its
      // 100 row locks. Awaiting the second worker here is an explicit barrier:
      // worker two must complete before worker one's transaction can commit.
      assert.equal(await claim("batch-second-independent", context.now), null);
      // A separate connection sees only worker two's committed batch; the first
      // 100 rows still look RUNNING in its snapshot but must have been skipped.
      assert.equal(await prisma.growthEventDelivery.count({ where: { ...where, status: "RETRY_WAIT" } }), 100);
      assert.equal(await prisma.growthEventDelivery.count({ where: { ...where, status: "RUNNING" } }), 151);
      // Inside worker one's transaction both disjoint batches are visible.
      assert.equal(await tx.growthEventDelivery.count({ where: { ...where, status: "RETRY_WAIT" } }), 200);
    }, { maxWait: 5_000, timeout: 12_000 });
    assert.equal(await prisma.growthEventDelivery.count({ where: { ...where, status: "RETRY_WAIT" } }), 200);
    assert.equal(await claim("batch-third-remainder", context.now), null);
    assert.equal(await prisma.growthEventDelivery.count({ where: { ...where, status: "RUNNING" } }), 0);
    assert.equal(await prisma.growthEventDelivery.count({ where: { ...where, status: "RETRY_WAIT" } }), 251);
    const recovered = await prisma.growthEventDelivery.findMany({ where, select: { attemptCount: true, leaseToken: true } });
    assert(recovered.every(row => row.attemptCount === 1 && row.leaseToken === null));
  });

  await scenario("Watchdog measures current runnable time instead of original event age", async context => {
    const [delivery] = await queue(context, 1);
    assert(delivery);
    await prisma.growthEventDelivery.update({
      where: { id: delivery.id },
      data: { status: "RETRY_WAIT", createdAt: new Date(context.now.getTime() - 24 * 60 * MINUTE), runAt: context.now },
    });
    for (const elapsed of [-1, 1, 29 * MINUTE]) {
      const findings = await collectWatchdogFindings(prisma, new Date(context.now.getTime() + elapsed), context.ownerId);
      assert(!findings.some(finding => finding.code === "growth_event_worker_stalled"),
        `An old event runnable for ${elapsed}ms must not be reported as stalled.`);
    }
    const findings = await collectWatchdogFindings(prisma, new Date(context.now.getTime() + 31 * MINUTE), context.ownerId);
    assert(findings.some(finding => finding.code === "growth_event_worker_stalled" && finding.characterId === context.characterId));
  });

  await scenario("consumer writes roll back when handler throws before confirmation", async context => {
    await queue(context, 1);
    const lease = await claim("rollback-consumer", context.now);
    assert(lease);
    const before = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } });
    await assert.rejects(() => completeGrowthEventDelivery(prisma, lease, async tx => {
      await tx.character.update({ where: { id: context.characterId }, data: { basePrompt: "must roll back" } });
      throw new Error("consumer rollback expected");
    }, new Date(context.now.getTime() + 1)), /consumer rollback expected/);
    assert.equal((await prisma.character.findUniqueOrThrow({ where: { id: context.characterId } })).basePrompt, "disposable concurrency fixture");
    const after = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } });
    assert.equal(after.status, "RUNNING");
    assert.equal(after.leaseToken, before.leaseToken);
    assert.equal(after.lockedAt?.getTime(), before.lockedAt?.getTime());
    assert.equal(after.leaseExpiresAt?.getTime(), before.leaseExpiresAt?.getTime());
    assert.equal(after.processedAt, null);
  });

  await scenario("concurrent publication shares one event and one consumer delivery", async context => {
    const input = {
      characterId: context.characterId, sourceDomain: "memory" as const, eventType: "memory.event.created",
      aggregateType: "MemoryEvent", aggregateId: randomUUID(), occurredAt: context.now,
      idempotencyKey: `concurrent-publication:${randomUUID()}`, payload: { testOnly: true },
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => prisma.$transaction(tx => publishGrowthEvent(tx, input),
      { maxWait: 5_000, timeout: 8_000 })));
    assert.equal(new Set(results.map(result => result.eventId)).size, 1);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(await prisma.growthEvent.count({ where: { characterId: context.characterId } }), 1);
    assert.equal(await prisma.growthEventDelivery.count({ where: { eventId: results[0]!.eventId } }), 1);
  });

  console.log("Growth Event Center concurrency DB tests passed.");
} finally {
  await prisma.$disconnect();
}
