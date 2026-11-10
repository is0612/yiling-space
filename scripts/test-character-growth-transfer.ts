import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { emptyCharacterGrowthBundle } from "../server/utils/character-growth-portable";
import { loadCharacterGrowth, importCharacterGrowth } from "../server/utils/character-growth-transfer";

const characterId = randomUUID(); const ownerId = randomUUID();
const queries: Array<{ table: string; args: any }> = [];
const rows: Record<string, any[]> = {};
const names = ["knowledgeCandidate", "knowledgeItem", "knowledgeItemRevision", "knowledgeItemRelation", "socialExperience", "socialRelationshipAssessment", "socialRelationshipAssessmentReview", "socialRelationChange", "socialRelationChangeEvidence", "socialRelationshipAssessmentEvidence", "reflectionRun", "reflectionSuggestion", "growthEvent", "growthEventDelivery", "memoryEvent", "memorySnapshot", "memoryScope"];
const ledger: any[] = [];
const db: Record<string, any> = {
  character: { findFirst: async ({ where }: any) => where.id === characterId && where.ownerId === ownerId ? { id: characterId } : null },
  characterGrowthImportIdentity: {
    findMany: async () => ledger,
    findUnique: async ({ where }: any) => ledger.find(r => Object.entries(where.characterId_domain_originId).every(([k, v]) => r[k] === v)) ?? null,
    create: async ({ data }: any) => { ledger.push(data); return data; },
  },
  $queryRaw: async () => [{ id: characterId }],
};
for (const table of names) {
  rows[table] = [];
  db[table] = {
    findMany: async (args: any) => {
      queries.push({ table, args });
      const all = rows[table]!;
      const selected = args.where?.id && typeof args.where.id === "string" ? all.filter(row => row.id === args.where.id) : all;
      return selected.map(row => args.select ? Object.fromEntries(Object.keys(args.select).filter(key => key in row).map(key => [key, row[key]])) : row);
    },
    createMany: async ({ data }: any) => { let count = 0; for (const row of data) if (!rows[table]!.some(old => old.id === row.id)) { rows[table]!.push(row); count++; } return { count }; },
  };
}
const prisma = db as unknown as PrismaClient;
await assert.rejects(() => loadCharacterGrowth({ prisma, characterId, ownerId: randomUUID(), includeFriends: false }), (e: any) => e.statusCode === 404);
const empty = await loadCharacterGrowth({ prisma, characterId, ownerId, includeFriends: false });
assert(Object.values(empty.tables).every(table => table.length === 0));
assert(!queries.some(query => query.table.startsWith("social")), "No friend data query is allowed when friends are excluded");
for (const query of queries) {
  if (query.table !== "characterGrowthImportIdentity") assert(query.args.select, `${query.table} must explicitly whitelist fields`);
  if (query.table === "knowledgeCandidate" || query.table === "knowledgeItem") assert(!query.args.where.sourceType.in.includes("CHAT"));
}
const sourceId = randomUUID(); const stamp = "2026-11-10T00:00:00.000Z";
const bundle = emptyCharacterGrowthBundle();
bundle.tables.knowledgeCandidates.push({ id: sourceId, sourceType: "MANUAL", sourceRef: null, rawContent: "用于验证稳定导入的公开知识候选", status: "PENDING", processedResult: null, processingError: null, processedAt: null, createdAt: stamp, updatedAt: stamp });
const tx = db as unknown as Prisma.TransactionClient;
const first = await importCharacterGrowth(tx, { characterId, ownerId, bundle, includeFriends: false });
assert.equal(first.added.knowledgeCandidates, 1);
assert.notEqual(rows.knowledgeCandidate![0].id, sourceId);
const second = await importCharacterGrowth(tx, { characterId, ownerId, bundle, includeFriends: false });
assert.equal(second.added.knowledgeCandidates, 0); assert.equal(rows.knowledgeCandidate!.length, 1);
const reexported = await loadCharacterGrowth({ prisma, characterId, ownerId, includeFriends: false });
assert.equal(reexported.tables.knowledgeCandidates[0]!.id, sourceId, "Re-export restores stable original identity");
const nativeId = randomUUID();
rows.knowledgeCandidate!.push({ ...bundle.tables.knowledgeCandidates[0], id: nativeId });
const nativeBundle = emptyCharacterGrowthBundle(); nativeBundle.tables.knowledgeCandidates.push({ ...bundle.tables.knowledgeCandidates[0]!, id: nativeId });
const native = await importCharacterGrowth(tx, { characterId, ownerId, bundle: nativeBundle, includeFriends: false });
assert.equal(native.added.knowledgeCandidates, 0, "Returning a native row to its original role must adopt it");
assert(ledger.some(row => row.originId === nativeId && row.localId === nativeId));
console.log("Growth transfer checks passed: owner isolation, explicit selects, no friend queries, CHAT exclusion, stable replay, re-export identity and native round-trip adoption.");
