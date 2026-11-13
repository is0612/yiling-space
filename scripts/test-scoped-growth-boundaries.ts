import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyCharacterGrowthBundle, parseCharacterGrowthBundle } from "../server/utils/character-growth-portable";
const bundle = emptyCharacterGrowthBundle();
bundle.tables.reflectionRuns.push({ id: randomUUID(), periodStart: "2026-11-12T00:00:00.000Z", periodEnd: "2026-11-13T00:00:00.000Z", status: "SUCCEEDED", attemptCount: 1, maxAttempts: 3, lastError: null, model: null, promptVersion: null, sourcesHash: null, completedAt: null, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" });
assert.equal(parseCharacterGrowthBundle(bundle).version, 1);
for (const patch of [{ conversationId: randomUUID() }, { memoryScopeId: randomUUID() }, { conversationId: randomUUID(), memoryScopeId: randomUUID() }]) {
  const scoped = structuredClone(bundle) as any;
  Object.assign(scoped.tables.reflectionRuns[0], patch);
  assert.throws(() => parseCharacterGrowthBundle(scoped), /私人反思/);
}
const habits = structuredClone(bundle) as any;
habits.tables.expressionHabits = [{ conversationId: randomUUID(), memoryScopeId: randomUUID(), content: "PRIVATE" }];
assert.throws(() => parseCharacterGrowthBundle(habits), /未知字段/);
console.log("Scoped growth portable checks passed: v5 unchanged, scoped or half-scoped reflection rejected, expression habits remain unsupported instead of becoming global.");
