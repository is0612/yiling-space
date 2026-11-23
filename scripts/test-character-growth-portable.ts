import assert from "node:assert/strict";
import { emptyCharacterGrowthBundle, growthCounts, parseCharacterGrowthBundle, parseGrowthMetadata, characterGrowthMappedId } from "../server/utils/character-growth-portable";
const empty = emptyCharacterGrowthBundle();
assert.deepEqual(parseCharacterGrowthBundle(empty), empty);
assert(Object.values(growthCounts(empty)).every(count => count === 0));
for (const value of [null, {}, { ...empty, version: 3 }, { ...empty, credentials: "secret" }, { ...empty, tables: { ...empty.tables, arbitraryTable: [] } }]) assert.throws(() => parseCharacterGrowthBundle(value));
for (const value of [{ apiKey: "secret" }, { __proto__: { secret: true } }, { note: Infinity }, { leaseToken: "x" }, { ownerId: "x" }, { content: "x".repeat(4001) }]) assert.throws(() => parseGrowthMetadata(value, "test"));
assert.deepEqual(parseGrowthMetadata({ sourceType: "MemoryEvent", sourceId: "source", historical: true }, "test"), { sourceType: "MemoryEvent", sourceId: "source", historical: true });
const id = "12345678-1234-4234-8234-123456789012";
assert.equal(characterGrowthMappedId(id, "knowledgeItems", id), characterGrowthMappedId(id, "knowledgeItems", id));
assert.notEqual(characterGrowthMappedId(id, "knowledgeItems", id), characterGrowthMappedId(id, "knowledgeCandidates", id));
const timestamp = "2026-11-10T00:00:00Z";
const run = { id, periodStart: "2026-11-09T00:00:00Z", periodEnd: timestamp, status: "SUCCEEDED", attemptCount: 1, maxAttempts: 3, lastError: null, model: null, promptVersion: null, sourcesHash: null, completedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
const bundle = emptyCharacterGrowthBundle(); bundle.tables.reflectionRuns.push(run as never);
assert.equal(parseCharacterGrowthBundle(bundle).tables.reflectionRuns.length, 1);
assert.throws(() => parseCharacterGrowthBundle({ ...bundle, tables: { ...bundle.tables, reflectionRuns: [run, run] } }));
for (const changed of [{ ...run, leaseToken: id }, { ...run, id: "bad" }, { ...run, periodStart: "2026-02-30T00:00:00Z" }, { ...run, periodEnd: run.periodStart }, { ...run, sourcesHash: "bad" }]) assert.throws(() => parseCharacterGrowthBundle({ ...bundle, tables: { ...bundle.tables, reflectionRuns: [changed] } }));
const suggestion = { id: "22345678-1234-4234-8234-123456789012", runId: id, title: "结论", observation: "观察", inference: "推断", recommendation: "建议", sourceRefs: [{ key: `memory:${id}`, type: "memory", id, hash: "a".repeat(64), title: "来源", excerpt: "摘录" }], status: "PENDING", reviewNote: null, reviewedAt: null, acceptedAt: null, createdAt: timestamp, updatedAt: timestamp };
const linked = { ...bundle, tables: { ...bundle.tables, reflectionSuggestions: [suggestion] } };
const context = { eventIds: new Set([id]), snapshotIds: new Set<string>(), friends: new Set<string>(), includeFriends: false };
assert.equal(parseCharacterGrowthBundle(linked, context).tables.reflectionSuggestions.length, 1);
assert.throws(() => parseCharacterGrowthBundle(linked, { ...context, eventIds: new Set() }));
assert.throws(() => parseCharacterGrowthBundle({ ...linked, tables: { ...linked.tables, reflectionSuggestions: [{ ...suggestion, runId: suggestion.id }] } }));
assert.throws(() => parseCharacterGrowthBundle({ ...linked, tables: { ...linked.tables, reflectionSuggestions: [{ ...suggestion, status: "ACCEPTED" }] } }));
assert.throws(() => parseCharacterGrowthBundle({ ...bundle, tables: { ...bundle.tables, reflectionRuns: [{ ...run, reviewedByUserId: id }] } }));

/**
 * v2 的知识主题三表。
 *
 * 兼容口径：v1 老卡没有这三张表，读进来补空数组 —— 不补就会在「字段必须齐全」那里整卡失败，
 * 而老卡本身没有任何问题。v2 卡声明了版本号，就必须把三段都带上。
 */
const v1Tables = Object.fromEntries(Object.entries(empty.tables).filter(([key]) => !key.startsWith("knowledgeTopic")));
const parsedV1 = parseCharacterGrowthBundle({ version: 1, warnings: [], tables: v1Tables });
assert.equal(parsedV1.version, 1);
assert.deepEqual(parsedV1.tables.knowledgeTopics, [], "v1 老卡按空主题读取");
assert.deepEqual(parsedV1.tables.knowledgeTopicMembers, []);
assert.deepEqual(parsedV1.tables.knowledgeTopicRevisions, []);
assert.throws(() => parseCharacterGrowthBundle({ version: 2, warnings: [], tables: v1Tables }), undefined, "v2 卡缺主题段要拒绝");

const topicItem = { id, candidateId: null, title: "深海", content: "鲸鱼住在深海里", category: "GENERAL", tags: [], confidence: null, status: "ACTIVE", sourceType: "MANUAL", sourceRef: null, revision: 1, createdAt: timestamp, updatedAt: timestamp };
const topic = { id: "32345678-1234-4234-8234-123456789012", name: "海洋", description: "关于海的一切", status: "ACTIVE", revision: 1, createdAt: timestamp, updatedAt: timestamp };
const member = { id: "42345678-1234-4234-8234-123456789012", topicId: topic.id, itemId: id, itemRevision: 1, createdAt: timestamp };
const withTopics = { ...empty, tables: { ...empty.tables, knowledgeItems: [topicItem], knowledgeTopics: [topic], knowledgeTopicMembers: [member] } };
assert.equal(parseCharacterGrowthBundle(withTopics).tables.knowledgeTopicMembers.length, 1);
assert.throws(
  () => parseCharacterGrowthBundle({ ...withTopics, tables: { ...withTopics.tables, knowledgeTopicMembers: [{ ...member, itemId: "52345678-1234-4234-8234-123456789012" }] } }),
  undefined,
  "成员指向不存在的知识条目要拒绝（否则主题页会有一条点不开的引用）",
);
assert.throws(() => parseCharacterGrowthBundle({ ...withTopics, tables: { ...withTopics.tables, knowledgeTopicMembers: [member, member] } }), undefined, "同一条目挂在同一主题下两次要拒绝");
assert.throws(
  () => parseCharacterGrowthBundle({ ...withTopics, tables: { ...withTopics.tables, knowledgeTopics: [{ ...topic, status: "MERGED" }] } }),
  undefined,
  "MERGED 主题是指向别的主题的指针，不带",
);
console.log("Growth portable checks passed: empty bundle, field whitelist, safe metadata, UUID/date/hash bounds, duplicate identities and deterministic mapping.");
