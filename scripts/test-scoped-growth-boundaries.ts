import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CHARACTER_GROWTH_BUNDLE_VERSION, emptyCharacterGrowthBundle, parseCharacterGrowthBundle } from "../server/utils/character-growth-portable";
const bundle = emptyCharacterGrowthBundle();
bundle.tables.reflectionRuns.push({ id: randomUUID(), periodStart: "2026-11-12T00:00:00.000Z", periodEnd: "2026-11-13T00:00:00.000Z", status: "SUCCEEDED", attemptCount: 1, maxAttempts: 3, lastError: null, model: null, promptVersion: null, sourcesHash: null, completedAt: null, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" });
assert.equal(parseCharacterGrowthBundle(bundle).version, CHARACTER_GROWTH_BUNDLE_VERSION,
  "新导出的成长包必须标当前版本（v2 起带知识主题三张表），不要在这里写死数字。");
/**
 * v1（v5 角色卡那套）没有主题三张表：必须照样读得进来，按空数组补齐，版本保持 1。
 * 这条守的是「升级之后老卡不能整卡失败」，不是版本号本身。
 */
const legacy = structuredClone(bundle) as any;
legacy.version = 1;
for (const key of ["knowledgeTopics", "knowledgeTopicMembers", "knowledgeTopicRevisions"]) delete legacy.tables[key];
const legacyParsed = parseCharacterGrowthBundle(legacy);
assert.equal(legacyParsed.version, 1, "v1 老卡不做静默升级，读进来还是 v1。");
assert.deepEqual(legacyParsed.tables.knowledgeTopics, [], "v1 缺的主题表按空数组补齐。");
for (const patch of [{ conversationId: randomUUID() }, { memoryScopeId: randomUUID() }, { conversationId: randomUUID(), memoryScopeId: randomUUID() }]) {
  const scoped = structuredClone(bundle) as any;
  Object.assign(scoped.tables.reflectionRuns[0], patch);
  assert.throws(() => parseCharacterGrowthBundle(scoped), /私人反思/);
}
const habits = structuredClone(bundle) as any;
habits.tables.expressionHabits = [{ conversationId: randomUUID(), memoryScopeId: randomUUID(), content: "PRIVATE" }];
assert.throws(() => parseCharacterGrowthBundle(habits), /未知字段/);
console.log("Scoped growth portable checks passed: current bundle version follows the constant, v1 cards still readable, scoped or half-scoped reflection rejected, expression habits remain unsupported instead of becoming global.");
