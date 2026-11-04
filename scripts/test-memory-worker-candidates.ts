/** Mocked queue only: no database client, network request, credential file, or paid model call. */
import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { readConfiguredMemoryJobCandidates } from "../server/utils/memory-worker-candidates";
import { isMemoryModelConfigured } from "../server/utils/memory-ai";

const now = new Date("2026-11-04T12:00:00Z");
const configured = { chatModel: "mock-model", chatApiKeyEncrypted: "v1.mock-placeholder" };
const ownership = { memoryScope: { is: { character: { is: { ownerId: "owner-a" } } } } };
type Row = ReturnType<typeof job>;
function job(index: number, characterId = "unconfigured", modelConfig: unknown = {}) {
  return {
    id: `job-${String(index).padStart(6, "0")}`,
    type: "EXTRACT_EVENTS",
    status: "QUEUED",
    attemptCount: 0,
    maxAttempts: 3,
    runAt: new Date(now.getTime() - 100_000 + index),
    periodEnd: new Date(now.getTime() - 20_000),
    createdAt: new Date(now.getTime() - 30_000),
    memoryScope: { characterId, character: { ownerId: "owner-a", modelConfig } },
  };
}

function mockDb(rows: Row[], expectedOwnership: Prisma.MemoryJobWhereInput = ownership) {
  const reads: Prisma.MemoryJobFindManyArgs[] = [];
  const original = structuredClone(rows);
  const prisma = {
    memoryJob: {
      async findMany(args: Prisma.MemoryJobFindManyArgs) {
        reads.push(args);
        assert.equal(args.take, 100, "Each database read stays bounded.");
        assert.deepEqual(args.orderBy, [{ runAt: "asc" }, { periodEnd: "asc" }, { createdAt: "asc" }, { id: "asc" }]);
        assert.deepEqual(args.where?.type, { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "EXTRACT_EVENTS", "GENERATE_JOURNAL"] });
        assert.deepEqual(args.where?.status, { in: ["QUEUED", "RETRY_WAIT"] });
        assert.deepEqual(args.where?.runAt, { lte: now });
        assert.equal(args.skip, undefined, "Exclusion, not unstable offset pagination.");
        const clauses = args.where?.AND as Prisma.MemoryJobWhereInput[];
        assert.deepEqual(clauses[0], expectedOwnership, "Ownership survives EVERY scan query.");
        const exclusion = clauses[1]?.memoryScope?.is?.characterId as { notIn?: string[] } | undefined;
        const excluded = exclusion?.notIn ?? [];
        const ownerId = expectedOwnership === ownership ? "owner-a" : undefined;
        return rows.filter((row) => (!ownerId || row.memoryScope.character.ownerId === ownerId)
          && !excluded.includes(row.memoryScope.characterId)
          && ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "EXTRACT_EVENTS", "GENERATE_JOURNAL"].includes(row.type)
          && ["QUEUED", "RETRY_WAIT"].includes(row.status)
          && row.runAt <= now)
          .sort((a, b) => a.runAt.getTime() - b.runAt.getTime()
            || a.periodEnd.getTime() - b.periodEnd.getTime()
            || a.createdAt.getTime() - b.createdAt.getTime()
            || a.id.localeCompare(b.id))
          .slice(0, args.take!);
      },
    },
  } as unknown as Pick<PrismaClient, "memoryJob">;
  return { prisma, reads, unchanged: () => assert.deepEqual(rows, original, "Selection must never mutate jobs/attempts.") };
}

const envKeys = ["LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "NODE_ENV"] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
try {
  for (const key of envKeys) delete process.env[key];
  process.env.NODE_ENV = "test";

  // The original regression: job 101 must be reachable on every fresh worker invocation.
  const blocked = Array.from({ length: 100 }, (_, i) => job(i));
  const eligible = job(100, "configured", configured);
  const db = mockDb([...blocked, eligible]);
  for (let run = 0; run < 2; run++) {
    const result = await readConfiguredMemoryJobCandidates(db.prisma, now, ownership);
    assert.deepEqual(result.configuredCandidates.map((row) => row.id), [eligible.id]);
    assert.equal(result.hasUnconfiguredCandidates, true);
  }
  assert.equal(db.reads.length, 4);
  db.unchanged();

  // A single character's huge backlog must be eliminated across ALL its scopes at once.
  const huge = mockDb([...Array.from({ length: 10_001 }, (_, i) => job(i)), job(10_002, "configured", configured)]);
  assert.equal((await readConfiguredMemoryJobCandidates(huge.prisma, now, ownership)).configuredCandidates.length, 1);
  assert.equal(huge.reads.length, 2);
  huge.unchanged();

  // No fixed total-page cap: even thousands of DIFFERENT unconfigured characters progress.
  const distinct = mockDb([...Array.from({ length: 1_201 }, (_, i) => job(i, `missing-${i}`)), job(1_202, "configured", configured)]);
  assert.equal((await readConfiguredMemoryJobCandidates(distinct.prisma, now, ownership)).configuredCandidates.length, 1);
  assert.equal(distinct.reads.length, 13);
  distinct.unchanged();

  // Model configuration can change between invocations; exclusions are never cached globally.
  const changed = mockDb(blocked);
  assert.equal((await readConfiguredMemoryJobCandidates(changed.prisma, now, ownership)).configuredCandidates.length, 0);
  blocked[0]!.memoryScope.character.modelConfig = configured;
  assert.equal((await readConfiguredMemoryJobCandidates(changed.prisma, now, ownership)).configuredCandidates[0]?.id, blocked[0]!.id);

  for (const count of [0, 1, 99, 100, 101, 200]) {
    const only = mockDb(Array.from({ length: count }, (_, i) => job(i)));
    const result = await readConfiguredMemoryJobCandidates(only.prisma, now, ownership);
    assert.deepEqual(result.configuredCandidates, []);
    assert.equal(result.hasUnconfiguredCandidates, count > 0, "Keep the worker's existing unconfigured-only message distinct from an empty queue.");
    only.unchanged();
  }

  // Filter ownership, future tasks, wrong types/statuses; retain chronological eligible order.
  const ordered = [job(4, "c4", configured), job(3, "c3", configured), job(2, "c2", configured), job(1)];
  ordered[0]!.runAt = ordered[1]!.runAt; // tie -> periodEnd, createdAt, id
  ordered[1]!.periodEnd = new Date(ordered[0]!.periodEnd.getTime() - 1);
  const otherOwner = job(-3, "other-owner", configured);
  otherOwner.memoryScope.character.ownerId = "owner-b";
  const future = job(200_000, "future", configured);
  const running = job(-2, "running", configured); running.status = "RUNNING";
  const wrongType = job(-1, "cleanup", configured); wrongType.type = "CLEAN_EXPIRED_MESSAGES";
  const filtered = mockDb([...ordered, otherOwner, future, running, wrongType]);
  assert.deepEqual((await readConfiguredMemoryJobCandidates(filtered.prisma, now, ownership)).configuredCandidates.map((row) => row.id), ["job-000002", "job-000003", "job-000004"]);
  filtered.unchanged();
  const allOwners = mockDb([otherOwner], {});
  assert.equal((await readConfiguredMemoryJobCandidates(allOwners.prisma, now, {})).configuredCandidates[0]?.id, otherOwner.id);

  // Preserve isMemoryModelConfigured semantics, not a SQL JSON key-presence approximation.
  assert.equal(isMemoryModelConfigured({}), false);
  assert.equal(isMemoryModelConfigured(configured), true);
  process.env.LLM_API_KEY = "mock-environment-key-not-a-secret";
  process.env.LLM_MODEL = "mock-global-model";
  process.env.LLM_BASE_URL = "https://api.openai.com/v1";
  assert.equal(isMemoryModelConfigured({}), true, "Global fallback is eligible.");
  assert.equal(isMemoryModelConfigured({ chatApiBaseUrl: "https://api.deepseek.com/v1" }), false, "Never lend the global key to a different provider.");
  const fallback = mockDb([job(0), job(1, "custom-provider", { chatApiBaseUrl: "https://api.deepseek.com/v1" })]);
  assert.deepEqual((await readConfiguredMemoryJobCandidates(fallback.prisma, now, ownership)).configuredCandidates.map((row) => row.id), ["job-000000"]);
  fallback.unchanged();
  process.stdout.write("✓ Memory worker candidate starvation regression (mock DB, no model calls): passed\n");
} finally {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}
