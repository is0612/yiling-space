import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../src/generated/prisma/client";
import { loadCharacterExportBundle } from "../server/utils/character-transfer";

const characterId = randomUUID();
const ownerId = randomUUID();
const makeHabit = (content: string, status: string, conversationId: string | null, memoryScopeId: string | null) => ({
  kind: "WORDING", content, context: "context", reason: "reason", chatScope: "PRIVATE", status,
  conversationId, memoryScopeId,
});
const habits = [
  makeHabit("public active", "ACTIVE", null, null),
  makeHabit("public disabled", "DISABLED", null, null),
  makeHabit("private active sentinel", "ACTIVE", randomUUID(), randomUUID()),
  makeHabit("private disabled sentinel", "DISABLED", randomUUID(), randomUUID()),
  makeHabit("conversation-only sentinel", "ACTIVE", randomUUID(), null),
  makeHabit("scope-only sentinel", "DISABLED", null, randomUUID()),
  makeHabit("pending sentinel", "PENDING", null, null),
];
let ignoreScopeWhere = false;
let habitQueries = 0;
const emptyDelegate = { findMany: async () => [], create: async () => ({}) };
const db = new Proxy({
  character: { findFirst: async (args: any) => {
    if (args.where.id !== characterId || args.where.ownerId !== ownerId) return null;
    if (!args.select.expressionHabits) return { id: characterId };
    habitQueries++;
    const query = args.select.expressionHabits;
    const selected = habits.filter(row => query.where.status.in.includes(row.status)
      && (ignoreScopeWhere || Object.entries(query.where).every(([key, value]) => key === "status" || row[key as keyof typeof row] === value)))
      .map(row => Object.fromEntries(Object.keys(query.select).filter(key => query.select[key]).map(key => [key, row[key as keyof typeof row]])));
    return { id: characterId, originCharacterId: characterId, name: "Synthetic role", basePrompt: "prompt",
      styleExamples: "", userAddress: "owner", modelConfig: {}, memorySetting: null, memoryScopes: [],
      catchphrases: [], interactionGuidance: [], channelPolicies: [], expressionHabits: selected,
      goals: [], preferences: [], visualProfile: null, stickers: [] };
  } },
}, { get(target, key) { return Reflect.get(target, key) ?? emptyDelegate; } }) as unknown as PrismaClient;
const globals = globalThis as typeof globalThis & { __yilingPrisma?: PrismaClient };
const previous = globals.__yilingPrisma;
globals.__yilingPrisma = db;
try {
  assert.equal(await loadCharacterExportBundle({ characterId, ownerId: randomUUID() }), null);
  for (const includeFriends of [false, true]) {
    for (const defensiveFilter of [false, true]) {
      ignoreScopeWhere = defensiveFilter;
      const result = await loadCharacterExportBundle({ characterId, ownerId, includeFriends });
      assert(result);
      assert.deepEqual(result.bundle.expressionHabits.map(row => row.content), ["public active", "public disabled"]);
      const serialized = JSON.stringify(result.bundle);
      assert(!serialized.includes("sentinel"), "private or pending habits must never enter sharing or migration bundles");
      assert(!serialized.includes("conversationId"), "scope identifiers must not be serialized with habits");
    }
  }
  assert.equal(habitQueries, 4);
} finally {
  if (previous) globals.__yilingPrisma = previous;
  else delete globals.__yilingPrisma;
}
console.log("Character export private-habit regression passed: owner check, sharing/migration, ACTIVE/DISABLED, partial scopes, defensive filtering.");
