import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { listMemoryProgress } from "../server/utils/memory-progress";

// No database or provider calls: verify filtering happens before the row limit.
const queries: Array<Record<string, unknown>> = [];
const prisma = { memoryJob: { findMany: async (query: Record<string, unknown>) => { queries.push(query); return []; } } } as unknown as PrismaClient;
await listMemoryProgress(prisma, { ownerId: "owner", characterId: "character", type: "EXTRACT_EVENTS" });
const filtered = queries[0]!;
const where = filtered.where as Record<string, unknown>;
assert.deepEqual(where.memoryScope, { is: { characterId: "character", character: { is: { ownerId: "owner" } } } });
assert.equal(where.type, "EXTRACT_EVENTS");
assert.equal(where.OR, undefined, "character history must retain failures older than the global ninety-second window");
assert.deepEqual(filtered.orderBy, [{ createdAt: "desc" }]);
assert.equal(filtered.take, 20);
await listMemoryProgress(prisma, { ownerId: "owner" });
const globalWhere = queries[1]!.where as Record<string, unknown>;
assert.deepEqual(globalWhere.memoryScope, { is: { character: { is: { ownerId: "owner" } } } });
assert(Array.isArray(globalWhere.OR), "the global panel must retain its bounded active/recent history semantics");
assert.deepEqual(queries[1]!.orderBy, [{ createdAt: "asc" }]);
const runAt = new Date("2026-11-10T17:00:00Z");
const retryPrisma = { memoryJob: { findMany: async () => [{
  id: "retry", memoryScopeId: "scope", type: "GENERATE_SNAPSHOT", status: "RETRY_WAIT",
  idempotencyKey: "snapshot:test", periodStart: new Date("2026-11-09T16:00:00Z"), periodEnd: runAt,
  startedAt: null, updatedAt: runAt, runAt, attemptCount: 1, maxAttempts: 3, lockedAt: null, lastError: "LLM_OUTPUT_TRUNCATED",
  memoryScope: { scopeType: "CHARACTER_GLOBAL", character: { id: "character", name: "测试角色", memorySetting: { timezone: "Asia/Shanghai" } } },
}] } } as unknown as PrismaClient;
const retryRows = await listMemoryProgress(retryPrisma, { ownerId: "owner" });
assert.equal(retryRows[0]?.runAt, runAt.toISOString());
assert.equal(retryRows[0]?.attemptCount, 1);
assert.equal(retryRows[0]?.maxAttempts, 3);
const selected = queries[0]!.select as Record<string, unknown>;
for (const field of ["runAt", "attemptCount", "maxAttempts"]) assert.equal(selected[field], true);
console.log("Memory progress filtering and persisted retry metadata checks passed (mock queries, no database).");
