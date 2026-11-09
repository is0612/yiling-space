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
console.log("Memory progress character/type filtering checks passed (mock queries, no database).");
