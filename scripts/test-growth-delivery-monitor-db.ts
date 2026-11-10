import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { listGrowthDeliveries, readGrowthDelivery } from "../server/utils/growth-delivery-monitor";
import { retryFailedGrowthEventDelivery, processNextGrowthEventDelivery } from "../server/utils/growth-event-delivery";
import { createGrowthEventRunner } from "../server/utils/growth-event-runner";

const url = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert(/^\/yiling_growth_event_test_[a-f0-9]{32}$/.test(url.pathname));
const prisma = getPrisma();
const owners: string[] = [];
const characters: string[] = [];
const now = new Date();
try {
  for (let i = 0; i < 2; i++) {
    const owner = await prisma.user.create({ data: { username: `monitor-${randomUUID()}`, passwordHash: "test", role: "USER", status: "ACTIVE" } });
    owners.push(owner.id);
    const character = await prisma.character.create({ data: { ownerId: owner.id, name: "隔离监控角色", basePrompt: "test" } });
    characters.push(character.id);
  }
  const sameOwnerCharacter = await prisma.character.create({ data: { ownerId: owners[0]!, name: "同用户另一角色", basePrompt: "test" } });
  characters.push(sameOwnerCharacter.id);
  const makeDelivery = async (characterId: string, status: "QUEUED" | "RUNNING" | "FAILED" | "RETRY_WAIT", runAt = now) => {
    const event = await prisma.growthEvent.create({ data: { characterId, sourceDomain: "memory", eventType: "memory.event.created", aggregateType: "MemoryEvent", aggregateId: randomUUID(), occurredAt: now, idempotencyKey: randomUUID(), payload: { internalPayload: "do not expose" } } });
    return prisma.growthEventDelivery.create({ data: { eventId: event.id, consumerKey: "growth.memory-source-integrity", status, runAt, attemptCount: status === "FAILED" ? 5 : 1, fencingToken: 7, leaseToken: randomUUID(), leaseExpiresAt: status === "RUNNING" ? new Date(now.getTime() - 1) : null, lastError: status === "FAILED" ? "synthetic terminal failure" : null } });
  };
  const queued = await makeDelivery(characters[0]!, "QUEUED", new Date(now.getTime() - 60_000));
  await makeDelivery(characters[0]!, "RETRY_WAIT", new Date(now.getTime() + 60_000));
  const stuck = await makeDelivery(characters[0]!, "RUNNING");
  const failed = await makeDelivery(characters[0]!, "FAILED");
  const foreign = await makeDelivery(characters[1]!, "FAILED");
  const otherRole = await makeDelivery(characters[2]!, "FAILED");
  const input = { ownerId: owners[0]!, characterId: characters[0]!, page: 1, pageSize: 2, now };
  const first = await listGrowthDeliveries(prisma, input);
  assert.equal(first.total, 4); assert.equal(first.items.length, 2); assert.equal(first.totalPages, 2);
  assert.equal(first.summary.readyCount, 1); assert.equal(first.summary.stuckCount, 1);
  assert.equal(first.summary.statusCounts.FAILED, 1);
  assert.equal(first.summary.oldestReadyAt, queued.runAt.toISOString());
  const second = await listGrowthDeliveries(prisma, { ...input, page: 2 });
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 4);
  for (const row of [...first.items, ...second.items]) { assert(!("leaseToken" in row)); assert(!("payload" in row)); }
  const detail = await readGrowthDelivery(prisma, { ...input, deliveryId: stuck.id });
  assert(detail.leaseExpired); assert.equal(detail.fencingToken, 7);
  const waiting = await readGrowthDelivery(prisma, { ...input, deliveryId: queued.id });
  assert.equal(waiting.queueDelayMs, 60_000);
  assert.equal((await listGrowthDeliveries(prisma, { ...input, status: "FAILED" })).total, 1);
  await assert.rejects(() => listGrowthDeliveries(prisma, { ...input, ownerId: owners[1]! }), /角色不存在/);
  for (const deliveryId of [foreign.id, otherRole.id]) {
    await assert.rejects(() => readGrowthDelivery(prisma, { ...input, deliveryId }), /投递不存在/);
    assert.equal(await retryFailedGrowthEventDelivery(prisma, deliveryId, now, { ownerId: input.ownerId, characterId: input.characterId }), null);
  }
  assert.equal(await retryFailedGrowthEventDelivery(prisma, failed.id, now, { ownerId: owners[1]!, characterId: characters[0]! }), null);
  assert.equal(await retryFailedGrowthEventDelivery(prisma, stuck.id, now, { ownerId: input.ownerId, characterId: input.characterId }), null);
  const retries = await Promise.all([1, 2].map(() => retryFailedGrowthEventDelivery(prisma, failed.id, now, { ownerId: input.ownerId, characterId: input.characterId })));
  assert.equal(retries.filter(Boolean).length, 1);
  const recovered = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: failed.id } });
  assert.equal(recovered.status, "QUEUED"); assert.equal(recovered.attemptCount, 0); assert.equal(recovered.fencingToken, 7);
  const restoredDetail = await readGrowthDelivery(prisma, { ...input, deliveryId: failed.id });
  assert.equal(restoredDetail.audits.length, 1); assert.equal(restoredDetail.audits[0]!.actorType, "USER");
  assert.equal(restoredDetail.audits[0]!.actorId, owners[0]);
  const audit = restoredDetail.audits[0]!.details as { previousLastError: string; previousAttemptCount: number };
  assert.equal(audit.previousLastError, "synthetic terminal failure"); assert.equal(audit.previousAttemptCount, 5);
  console.log("Growth delivery monitoring DB tests passed: role/owner isolation, pagination, backlog, lease, whitelist, concurrent recovery and audit.");
  await prisma.growthEvent.deleteMany({ where: { characterId: { in: characters } } });
  const backlog = [];
  for (let index = 0; index < 45; index++) backlog.push(await makeDelivery(characters[index % 2]!, "QUEUED", new Date(now.getTime() - 60_000)));
  let releaseModels!: () => void;
  const models = new Promise<void>(resolve => { releaseModels = resolve; });
  let releaseWorkers!: () => void;
  const workersEntered = new Promise<void>(resolve => { releaseWorkers = resolve; });
  const entered = new Set<number>();
  const seen = new Set<string>();
  const counts = [0, 0];
  let modelsFinished = 0;
  const runners = [0, 1].map(worker => createGrowthEventRunner({
    processEvent: () => processNextGrowthEventDelivery(prisma, {
      "growth.memory-source-integrity": async (_tx, event) => {
        if (!entered.has(worker)) { entered.add(worker); if (entered.size === 2) releaseWorkers(); await workersEntered; }
        assert(!seen.has(event.id), "An event must be handled exactly once across workers");
        seen.add(event.id); counts[worker]! += 1;
      },
    }, { workerId: `throughput-${worker}` }).then(result => {
      if (seen.size === backlog.length) for (const runner of runners) runner.stop();
      return result;
    }),
    cleanup: async () => {},
    runLegacyRound: async () => { await models; modelsFinished += 1; },
    onError: (_pipeline, error) => { for (const runner of runners) runner.stop(); releaseModels(); throw error; },
  }, { watch: true }));
  const timer = setTimeout(() => { for (const runner of runners) runner.stop(); releaseModels(); releaseWorkers(); }, 15_000);
  try {
    const running = runners.map(runner => runner.run());
    await workersEntered;
    // Wait for event workers to stop at a drained queue while both legacy calls stay blocked.
    while (seen.size < backlog.length && !runners[0]!.signal.aborted) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(seen.size, 45); assert(counts.every(count => count > 0));
    assert.equal(modelsFinished, 0, "Backlog must drain before long model tasks are released");
    releaseModels();
    await Promise.all(running);
    assert.equal(await prisma.growthEventDelivery.count({ where: { event: { characterId: { in: characters } }, status: "SUCCEEDED" } }), 45);
    console.log(`Growth throughput DB passed: 45 deliveries drained with blocked model tasks; workers processed ${counts.join("/")}, no duplicates.`);
  } finally { clearTimeout(timer); releaseModels(); releaseWorkers(); for (const runner of runners) runner.stop(); }
} finally {
  await prisma.auditLog.deleteMany({ where: { characterId: { in: characters } } });
  await prisma.character.deleteMany({ where: { id: { in: characters } } });
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
}
