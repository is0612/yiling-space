import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { createInteractionGuidanceCandidate, updateInteractionGuidance, selectInteractionGuidance, readInteractionGuidance, parseInteractionGuidancePatch, interactionGuidanceNextStatus, GUIDANCE_REASON, listInteractionGuidance, listInteractionGuidanceHistory } from "../server/utils/interaction-guidance";

assert.throws(() => parseInteractionGuidancePatch({ expectedRevision: 1, operation: "EDIT", context: "" }));
assert.throws(() => parseInteractionGuidancePatch({ expectedRevision: 1, operation: "EDIT", reason: "private" }));
assert.throws(() => parseInteractionGuidancePatch({ expectedRevision: 1, operation: "EDIT", chatScope: "GROUP_PRIVATE" }));
assert.throws(() => parseInteractionGuidancePatch({ expectedRevision: 0, operation: "ACTIVATE" }));
assert.throws(() => parseInteractionGuidancePatch({ expectedRevision: 1, operation: "ACTIVATE", content: "bypass" }));
assert.throws(() => parseInteractionGuidancePatch({ expectedRevision: 1, operation: "EDIT", content: "x".repeat(401) }));
assert.equal(interactionGuidanceNextStatus("PENDING", "ACTIVATE"), "ACTIVE");
assert.throws(() => interactionGuidanceNextStatus("REJECTED", "ACTIVATE"));
let row: any = { id: "guidance", characterId: "character", kind: "UNDERSTANDING", content: "先听清对方意图", context: "", chatScope: "ALL", status: "PENDING", revision: 1, sourceRefs: [], reason: GUIDANCE_REASON };
let revisionWrites = 0, auditWrites = 0, sourceReads = 0, owner = true, cas = 1;
const db: any = {
  $queryRaw: async () => owner ? [{ id: "character" }] : [],
  character: { findFirst: async () => owner ? { id: "character" } : null },
  interactionExperience: { findMany: async () => { sourceReads++; return []; } },
  characterInteractionGuidance: {
    create: async ({ data }: any) => (row = { ...data, id: "guidance" }),
    findFirst: async ({ where }: any) => where.characterId === row.characterId && where.id === row.id ? { ...row } : null,
    findUniqueOrThrow: async () => ({ ...row }),
    updateMany: async ({ data }: any) => { if (cas) row = { ...row, ...data, revision: row.revision + 1 }; return { count: cas }; },
    findMany: async ({ where }: any) => { assert.equal(where.characterId, "character"); return [{ ...row }]; },
    count: async () => 1,
  },
  characterInteractionGuidanceRevision: { create: async () => { revisionWrites++; }, findMany: async () => [], count: async () => 0 },
  auditLog: { create: async () => { auditWrites++; } },
};
db.$transaction = async (fn: any) => fn(db);
const prisma = db as PrismaClient;
const candidate = await createInteractionGuidanceCandidate(db, { characterId: "character", kind: "UNDERSTANDING", content: "先听清对方意图", context: "讨论", chatScope: "ALL", sourceRefs: [{ type: "experience", id: "source" }], actorId: "owner" });
assert.equal(candidate.status, "PENDING"); assert.equal(candidate.reason, GUIDANCE_REASON);
assert.equal(revisionWrites, 1); assert.equal(auditWrites, 1);
await assert.rejects(updateInteractionGuidance(prisma, { ownerId: "owner", characterId: "character", guidanceId: "guidance", body: { operation: "ACTIVATE", expectedRevision: 1 } }), { statusCode: 409 });
row.status = "ACTIVE";
await updateInteractionGuidance(prisma, { ownerId: "owner", characterId: "character", guidanceId: "guidance", body: { operation: "DISABLE", expectedRevision: 1 } });
assert.equal(row.status, "DISABLED");
await updateInteractionGuidance(prisma, { ownerId: "owner", characterId: "character", guidanceId: "guidance", body: { operation: "ACTIVATE", expectedRevision: 2 } });
assert.equal(sourceReads, 0, "already accepted guidance never needs private evidence");
assert.equal(row.status, "ACTIVE");
await assert.rejects(updateInteractionGuidance(prisma, { ownerId: "owner", characterId: "character", guidanceId: "guidance", body: { operation: "DISABLE", expectedRevision: 1 } }), { statusCode: 409 });
cas = 0;
await assert.rejects(updateInteractionGuidance(prisma, { ownerId: "owner", characterId: "character", guidanceId: "guidance", body: { operation: "DISABLE", expectedRevision: 3 } }), { statusCode: 409 });
owner = false;
await assert.rejects(listInteractionGuidance(prisma, { ownerId: "other", characterId: "character", status: "ALL", q: "", page: 1, pageSize: 20 }), { statusCode: 404 });
await assert.rejects(listInteractionGuidanceHistory(prisma, { ownerId: "other", characterId: "character", guidanceId: "guidance", page: 1, pageSize: 20 }), { statusCode: 404 });
owner = true;
const rows = ["ALL", "GROUP", "PRIVATE"].map((chatScope, n) => ({ id: `id${n}`, content: "抽象指导", context: "", status: "ACTIVE", chatScope }));
assert.deepEqual(selectInteractionGuidance("私聊", rows, "GROUP").map(x => x.id), ["id0", "id1"]);
assert.deepEqual(selectInteractionGuidance("群聊", rows, "PRIVATE").map(x => x.id), ["id0", "id2"]);
assert.equal(selectInteractionGuidance("群聊", rows).length, 1);
assert.equal(selectInteractionGuidance("你好", [{ ...rows[0]!, context: "倾诉" }], "PRIVATE").length, 0);
assert.equal(selectInteractionGuidance("倾诉", [{ ...rows[0]!, context: "倾诉" }], "PRIVATE").length, 1);
assert.equal(selectInteractionGuidance("", rows, "GROUP", 0).length, 0);
row = { ...row, context: "", sourceRefs: [{ id: "private-source" }], reason: "private-reason" };
const safe = await readInteractionGuidance(prisma, { characterId: "character", query: "", chatScene: "PRIVATE" });
assert.deepEqual(Object.keys(safe[0]!).sort(), ["content", "context", "id", "weight"]);
assert.equal(safe[0]!.weight, 1);
assert(!JSON.stringify(safe).includes("private-source"));
console.log("Interaction guidance domain: owner/revision/status, candidate-only creation, independent accepted lifecycle, source rejection, scope/context/budget and private-free output passed (mock).");
