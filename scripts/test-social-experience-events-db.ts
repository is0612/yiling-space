import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../src/generated/prisma/client";
import { getPrisma } from "../server/utils/prisma";
import { publishGrowthEvent } from "../server/utils/growth-event-center";
import {
  claimNextGrowthEventDelivery,
  cleanupGrowthEvents,
  completeGrowthEventDelivery,
  failGrowthEventDelivery,
} from "../server/utils/growth-event-delivery";
import { GROWTH_EVENT_HANDLERS } from "../server/utils/growth-event-consumers";
import { readSocialExperienceReference } from "../server/utils/social-experience-gateway";
import { linkMemoryEventToSocialExperiences } from "../server/utils/social-experiences";
import {
  claimNextSocialRelationshipAssessmentTask,
  runSocialRelationshipQueueMaintenance,
} from "../server/utils/social-relationship-queue";

// Check both boundaries before constructing a client or opening a connection.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname),
  "Social experience event tests require a local PostgreSQL host.");
assert(/^\/yiling_growth_event_test_[a-f0-9]{32}$/.test(databaseUrl.pathname),
  "Social experience event tests require a disposable Growth Event Center database.");
const existingOptions = databaseUrl.searchParams.get("options") ?? "";
databaseUrl.searchParams.set("options", `${existingOptions} -c statement_timeout=5000 -c lock_timeout=3000`.trim());
process.env.DATABASE_URL = databaseUrl.toString();
const prisma = getPrisma();
const consumerKey = "social.relationship-assessment-dispatch";
const consumer = GROWTH_EVENT_HANDLERS[consumerKey];
assert(consumer, "The social relationship dispatch consumer must be registered.");
const DAY = 24 * 60 * 60 * 1000;

type Fixture = {
  characterId: string;
  otherCharacterId: string;
  globalScopeId: string;
  otherGlobalScopeId: string;
  relationScopeId: string;
  otherRelationScopeId: string;
  platformUid: string;
};

async function scenario(label: string, run: (fixture: Fixture) => Promise<void>) {
  console.log(`\n[social-events] ${label}`);
  const owner = await prisma.user.create({
    data: { username: `social-events-${randomUUID()}`, passwordHash: "isolated-test-only", role: "USER", status: "ACTIVE" },
    select: { id: true },
  });
  const characterIds: string[] = [];
  let identityId: string | undefined;
  try {
    const characters = [];
    for (const label of ["A", "B"]) {
      const character = await prisma.character.create({
        data: { ownerId: owner.id, name: `社交事件回归 ${label}`, basePrompt: "disposable fixture" },
        select: { id: true },
      });
      characterIds.push(character.id);
      characters.push(character);
    }
    const characterId = characters[0]!.id;
    const otherCharacterId = characters[1]!.id;
    const identity = await prisma.externalIdentity.create({
      data: { platform: "qq", platformUid: `social-event-test-${randomUUID()}`, displayName: "测试参与者" },
      select: { id: true, platformUid: true },
    });
    identityId = identity.id;
    const scopes = [];
    for (const id of characterIds) {
      const global = await prisma.memoryScope.create({
        data: { characterId: id, scopeType: "CHARACTER_GLOBAL", scopeKey: `social-events:global:${id}` },
        select: { id: true },
      });
      const relation = await prisma.memoryScope.create({
        data: { characterId: id, scopeType: "EXTERNAL_IDENTITY", externalIdentityId: identity.id, scopeKey: `social-events:relation:${id}` },
        select: { id: true },
      });
      scopes.push({ global: global.id, relation: relation.id });
    }
    await run({
      characterId, otherCharacterId, platformUid: identity.platformUid,
      globalScopeId: scopes[0]!.global, relationScopeId: scopes[0]!.relation,
      otherGlobalScopeId: scopes[1]!.global, otherRelationScopeId: scopes[1]!.relation,
    });
  } finally {
    // Claims are global: remove this scenario's events before allowing the next one.
    await prisma.growthEvent.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.auditLog.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    if (identityId) await prisma.externalIdentity.delete({ where: { id: identityId } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
}

async function createSource(fixture: Fixture, tx: Prisma.TransactionClient = prisma, memoryScopeId = fixture.globalScopeId) {
  return tx.memoryEvent.create({
    data: {
      memoryScopeId, dayKey: "2026-11-10", occurredAt: new Date("2026-11-10T00:00:00.000Z"),
      title: "社交事件测试来源", detail: "只用于一次性数据库回归，不包含真实业务数据。",
      dedupeKey: `social-event-test:${randomUUID()}`,
    },
    select: { id: true, occurredAt: true },
  });
}

function linkInput(fixture: Fixture, sourceId: string, sourceMessageIds = [randomUUID()]) {
  return {
    characterId: fixture.characterId, memoryEventId: sourceId, sourceMessageIds,
    participantRefs: [{ kind: "external", platform: "qq", externalId: fixture.platformUid, displayName: "测试参与者" }],
  };
}

async function link(fixture: Fixture) {
  const source = await createSource(fixture);
  const input = linkInput(fixture, source.id);
  assert.equal(await prisma.$transaction(tx => linkMemoryEventToSocialExperiences(tx, input)), 1);
  const experience = await prisma.socialExperience.findFirstOrThrow({ where: { memoryEventId: source.id } });
  return { source, input, experience };
}

function eventInput(fixture: Fixture, experienceId: string, occurredAt: Date, idempotencyKey = `social.experience.created:${experienceId}`) {
  return {
    characterId: fixture.characterId, sourceDomain: "social" as const, eventType: "social.experience.created",
    aggregateType: "SocialExperience", aggregateId: experienceId, occurredAt, idempotencyKey,
    payload: { sourceId: experienceId, sourceType: "SocialExperience" },
  };
}

async function claim(fixture: Fixture) {
  const lease = await claimNextGrowthEventDelivery(prisma, { workerId: `social-test-${randomUUID()}`, now: new Date(Date.now() + 1_000) });
  assert(lease, "Expected one isolated fixture delivery.");
  assert.equal(lease.event.characterId, fixture.characterId, "A global claim must not consume another scenario's fixture.");
  assert.equal(lease.consumerKey, consumerKey);
  return lease;
}

async function consume(fixture: Fixture) {
  const lease = await claim(fixture);
  const status = await completeGrowthEventDelivery(prisma, lease, consumer, new Date());
  return { lease, status };
}

async function task(fixture: Fixture) {
  return prisma.socialRelationshipAssessmentTask.findUnique({ where: { scopeId: fixture.relationScopeId } });
}

try {
  await scenario("live link commits PENDING experience, Outbox and delivery atomically; maintenance leaves PENDING alone", async fixture => {
    const rollbackSourceId = randomUUID();
    await assert.rejects(() => prisma.$transaction(async tx => {
      await tx.memoryEvent.create({ data: {
        id: rollbackSourceId, memoryScopeId: fixture.globalScopeId, dayKey: "2026-11-10", occurredAt: new Date(),
        title: "事务回滚", detail: "synthetic rollback", dedupeKey: `rollback:${randomUUID()}`,
      } });
      assert.equal(await linkMemoryEventToSocialExperiences(tx, linkInput(fixture, rollbackSourceId)), 1);
      assert.equal(await tx.socialExperience.count({ where: { scopeId: fixture.relationScopeId, assessmentDispatchStatus: "PENDING" } }), 1);
      assert.equal(await tx.growthEvent.count({ where: { characterId: fixture.characterId, eventType: "social.experience.created" } }), 1);
      assert.equal(await tx.growthEventDelivery.count({ where: { event: { characterId: fixture.characterId } } }), 1);
      assert.equal(await tx.socialRelationshipAssessmentTask.count({ where: { scopeId: fixture.relationScopeId } }), 0);
      throw new Error("social outbox rollback expected");
    }), /social outbox rollback expected/);
    assert.equal(await prisma.memoryEvent.findUnique({ where: { id: rollbackSourceId } }), null);
    assert.equal(await prisma.socialExperience.count({ where: { scopeId: fixture.relationScopeId } }), 0);
    assert.equal(await prisma.growthEvent.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(await prisma.growthEventDelivery.count({ where: { event: { characterId: fixture.characterId } } }), 0);

    const { input, experience } = await link(fixture);
    assert.equal(experience.assessmentDispatchStatus, "PENDING");
    const event = await prisma.growthEvent.findFirstOrThrow({ where: { characterId: fixture.characterId } });
    assert.equal(event.sourceDomain, "social");
    assert.equal(event.eventType, "social.experience.created");
    assert.equal(event.aggregateId, experience.id);
    assert.equal(await prisma.growthEventDelivery.count({ where: { eventId: event.id, consumerKey } }), 1);
    assert.equal(await task(fixture), null, "Live link must not directly enqueue an assessment.");
    await runSocialRelationshipQueueMaintenance(prisma);
    assert.equal(await task(fixture), null, "Maintenance cannot steal a PENDING experience from the consumer.");
    assert.equal((await consume(fixture)).status, "SUCCEEDED");
    const queued = await task(fixture);
    assert(queued);
    assert.equal(queued.status, "QUEUED");
    assert.equal(queued.generation, 1);
    assert.deepEqual(queued.triggerReasons, ["NEW_EXPERIENCE"]);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: experience.id } })).assessmentDispatchStatus, "QUEUED");
    assert.equal(await prisma.$transaction(tx => linkMemoryEventToSocialExperiences(tx, input)), 0);
    assert.equal(await prisma.growthEvent.count({ where: { characterId: fixture.characterId } }), 1, "Duplicate link cannot publish another event.");
    assert.equal((await task(fixture))?.generation, 1);
  });

  await scenario("two distinct deliveries concurrently dispatch one experience only once", async fixture => {
    const { experience, source } = await link(fixture);
    await prisma.$transaction(tx => publishGrowthEvent(tx, eventInput(fixture, experience.id, source.occurredAt, `second-event:${randomUUID()}`)));
    const leases = await Promise.all([claim(fixture), claim(fixture)]);
    assert.notEqual(leases[0]!.deliveryId, leases[1]!.deliveryId);
    assert.notEqual(leases[0]!.eventId, leases[1]!.eventId);
    const results = await Promise.allSettled(leases.map(lease => completeGrowthEventDelivery(prisma, lease, consumer, new Date())));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    assert.deepEqual(results.map(result => result.status === "fulfilled" ? result.value : null).sort(), ["SKIPPED", "SUCCEEDED"]);
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal(await prisma.socialRelationshipAssessmentTask.count({ where: { scopeId: fixture.relationScopeId } }), 1);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: experience.id } })).assessmentDispatchStatus, "QUEUED");
  });

  await scenario("throw after enqueue rolls marker and task back; retry dispatches successfully", async fixture => {
    const { experience } = await link(fixture);
    const lease = await claim(fixture);
    const failedAt = new Date();
    await assert.rejects(() => completeGrowthEventDelivery(prisma, lease, async (tx, event) => {
      await consumer(tx, event);
      assert.equal((await tx.socialExperience.findUniqueOrThrow({ where: { id: experience.id } })).assessmentDispatchStatus, "QUEUED");
      assert.equal((await tx.socialRelationshipAssessmentTask.findUniqueOrThrow({ where: { scopeId: fixture.relationScopeId } })).generation, 1);
      throw new Error("after enqueue rollback expected");
    }, failedAt), /after enqueue rollback expected/);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: experience.id } })).assessmentDispatchStatus, "PENDING");
    assert.equal(await task(fixture), null);
    assert.equal((await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } })).status, "RUNNING");
    assert.equal(await failGrowthEventDelivery(prisma, lease, new Error("after enqueue rollback expected"), failedAt), "RETRY_WAIT");
    const delivery = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } });
    const retryAt = new Date(delivery.runAt.getTime() + 1);
    const retry = await claimNextGrowthEventDelivery(prisma, { workerId: "social-retry", now: retryAt });
    assert(retry);
    assert.equal(retry.deliveryId, lease.deliveryId);
    assert(retry.fencingToken > lease.fencingToken);
    assert.equal(await completeGrowthEventDelivery(prisma, retry, consumer, retryAt), "SUCCEEDED");
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: experience.id } })).assessmentDispatchStatus, "QUEUED");
  });

  await scenario("new experience during RUNNING advances generation without replacing the assessment lease", async fixture => {
    await link(fixture);
    await consume(fixture);
    const assessmentLease = await claimNextSocialRelationshipAssessmentTask(prisma, {
      scopeId: fixture.relationScopeId, workerId: "assessment-running", now: new Date(Date.now() + 1_000),
    });
    assert(assessmentLease);
    assert.equal(assessmentLease.generation, 1);
    const before = await task(fixture);
    assert(before);
    await link(fixture);
    await consume(fixture);
    const after = await task(fixture);
    assert(after);
    assert.equal(after.status, "RUNNING");
    assert.equal(after.generation, 2);
    assert.equal(after.processedGeneration, before.processedGeneration);
    assert.equal(after.leaseToken, before.leaseToken);
    assert.equal(after.lockedBy, before.lockedBy);
    assert.equal(after.fencingToken, before.fencingToken);
    assert.equal(after.leaseExpiresAt?.getTime(), before.leaseExpiresAt?.getTime());
    assert.equal(after.lockedAt?.getTime(), before.lockedAt?.getTime());
    assert.equal(after.runAt.getTime(), before.runAt.getTime());
    assert.equal(after.attemptCount, before.attemptCount);
  });

  await scenario("Gateway rejects mismatched relation/source characters; consumer skips missing references", async fixture => {
    const { experience, source } = await link(fixture);
    assert(await prisma.$transaction(tx => readSocialExperienceReference(tx, fixture.characterId, experience.id)));
    assert.equal(await prisma.$transaction(tx => readSocialExperienceReference(tx, fixture.otherCharacterId, experience.id)), null);
    const otherSource = await createSource(fixture, prisma, fixture.otherGlobalScopeId);
    const crossSource = await prisma.socialExperience.create({ data: {
      scopeId: fixture.relationScopeId, memoryEventId: otherSource.id, sourceKey: randomUUID(), assessmentDispatchStatus: "PENDING",
    } });
    const crossRelation = await prisma.socialExperience.create({ data: {
      scopeId: fixture.otherRelationScopeId, memoryEventId: source.id, sourceKey: randomUUID(), assessmentDispatchStatus: "PENDING",
    } });
    for (const id of [crossSource.id, crossRelation.id, randomUUID()]) {
      assert.equal(await prisma.$transaction(tx => readSocialExperienceReference(tx, fixture.characterId, id)), null);
    }
    await assert.rejects(() => prisma.$transaction(tx => linkMemoryEventToSocialExperiences(tx, linkInput(fixture, otherSource.id))), /不属于当前角色/);
    // Remove the valid fixture's pending event so all remaining deliveries test invalid references.
    await prisma.growthEvent.deleteMany({ where: { characterId: fixture.characterId } });
    for (const id of [crossSource.id, crossRelation.id, randomUUID()]) {
      await prisma.$transaction(tx => publishGrowthEvent(tx, eventInput(fixture, id, source.occurredAt)));
      assert.equal((await consume(fixture)).status, "SKIPPED");
    }
    assert.equal(await task(fixture), null);
    assert.equal(await prisma.socialRelationshipAssessmentTask.count({ where: { scopeId: fixture.otherRelationScopeId } }), 0);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: crossSource.id } })).assessmentDispatchStatus, "PENDING");
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: crossRelation.id } })).assessmentDispatchStatus, "PENDING");
  });

  await scenario("deleted source is skipped; archived source stays traceable and dispatchable", async fixture => {
    const missing = await link(fixture);
    await prisma.memoryEvent.delete({ where: { id: missing.source.id } });
    assert.equal(await prisma.$transaction(tx => readSocialExperienceReference(tx, fixture.characterId, missing.experience.id)), null);
    assert.equal((await consume(fixture)).status, "SKIPPED");
    assert.equal(await task(fixture), null);
    const archived = await link(fixture);
    await prisma.memoryEvent.update({ where: { id: archived.source.id }, data: { status: "ARCHIVED" } });
    const reference = await prisma.$transaction(tx => readSocialExperienceReference(tx, fixture.characterId, archived.experience.id));
    assert.equal(reference?.sourceStatus, "ARCHIVED");
    assert.equal(reference?.dispatchStatus, "PENDING");
    assert.equal((await consume(fixture)).status, "SUCCEEDED", "Archive preserves traceability and closes event dispatch responsibility.");
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: archived.experience.id } })).assessmentDispatchStatus, "QUEUED");
  });

  await scenario("legacy bulk insert emits no event and remains recoverable by maintenance", async fixture => {
    const source = await createSource(fixture);
    const result = await prisma.socialExperience.createMany({ data: [{
      scopeId: fixture.relationScopeId, memoryEventId: source.id, sourceKey: randomUUID(),
    }], skipDuplicates: true });
    assert.equal(result.count, 1);
    const legacy = await prisma.socialExperience.findFirstOrThrow({ where: { scopeId: fixture.relationScopeId } });
    assert.equal(legacy.assessmentDispatchStatus, "LEGACY");
    assert.equal(await prisma.growthEvent.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(await prisma.growthEventDelivery.count({ where: { event: { characterId: fixture.characterId } } }), 0);
    assert.equal(await task(fixture), null);
    const recovered = await runSocialRelationshipQueueMaintenance(prisma);
    assert.equal(recovered.backfilled, 1);
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal((await task(fixture))?.status, "QUEUED");
    assert.deepEqual((await task(fixture))?.triggerReasons, ["EXISTING_EXPERIENCE_RECOVERY"]);
    await runSocialRelationshipQueueMaintenance(prisma);
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal(await prisma.growthEvent.count({ where: { characterId: fixture.characterId } }), 0);
  });

  await scenario("event retention cleanup and republishing the same experience cannot advance generation again", async fixture => {
    const { experience, source } = await link(fixture);
    const completed = await consume(fixture);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal(await cleanupGrowthEvents(prisma, { now: new Date(Date.now() + 31 * DAY), retentionDays: 30 }), 1);
    assert.equal(await prisma.growthEvent.findUnique({ where: { id: completed.lease.eventId } }), null);
    assert.equal(await prisma.growthEventDelivery.findUnique({ where: { id: completed.lease.deliveryId } }), null);
    const replay = await prisma.$transaction(tx => publishGrowthEvent(tx, eventInput(fixture, experience.id, source.occurredAt)));
    assert.equal(replay.created, true, "The retired Outbox key may be recreated; domain marker must still prevent redispatch.");
    assert.notEqual(replay.eventId, completed.lease.eventId);
    assert.equal((await consume(fixture)).status, "SKIPPED");
    assert.equal((await task(fixture))?.generation, 1);
    assert.equal((await prisma.socialExperience.findUniqueOrThrow({ where: { id: experience.id } })).assessmentDispatchStatus, "QUEUED");
  });

  console.log("Social experience event DB tests passed.");
} finally {
  await prisma.$disconnect();
}
