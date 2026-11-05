import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modelCallLogStatus, modelCallLogWhere, parseModelCallLogQuery, readModelCallLogs, toModelCallLogItem, type ModelCallLogRow } from "../server/utils/model-call-logs";
import type { getPrisma } from "../server/utils/prisma";

const now = new Date("2026-11-04T16:01:00Z");
const defaults = parseModelCallLogQuery({});
assert.deepEqual(defaults, { days: 7, page: 1, pageSize: 20 });
const where = modelCallLogWhere("owned-character", defaults, now);
assert.equal(where.characterId, "owned-character");
assert.deepEqual(where.createdAt, { gte: new Date("2026-10-29T16:00:00Z"), lt: new Date("2026-11-05T16:00:00Z") });
assert.deepEqual(modelCallLogWhere("c", parseModelCallLogQuery({ days: "1", kind: "chat", model: "exact-model" }), now), {
  characterId: "c", createdAt: { gte: new Date("2026-11-04T16:00:00Z"), lt: new Date("2026-11-05T16:00:00Z") }, kind: "chat", model: "exact-model",
});
for (const query of [{ days: "2" }, { days: ["7", "30"] }, { kind: "raw-sql" }, { kind: "" }, { model: "x".repeat(121) }, { model: " " }, { page: "0" }, { page: "1.5" }, { page: "1e2" }, { page: "9007199254740991" }, { pageSize: "100" }]) {
  assert.throws(() => parseModelCallLogQuery(query), { statusCode: 400 });
}
assert.equal(parseModelCallLogQuery({ model: "x".repeat(120), pageSize: "50", page: "2", days: "30" }).pageSize, 50);
const row: ModelCallLogRow = { id: "log-id", createdAt: new Date("2026-11-05T02:00:00Z"), kind: "chat", model: "deepseek-flash", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, reasoningTokens: null, cacheHitTokens: 1_000_000, cacheMissTokens: 0, metadata: null };
assert.equal(toModelCallLogItem(row).status, "unknown", "Positive tokens never imply success.");
assert.equal(toModelCallLogItem(row).costCny, 0.1, "Use peak pricing and actual cache hits at row time.");
assert.equal(toModelCallLogItem({ ...row, createdAt: new Date("2026-11-05T00:00:00Z") }).costCny, 0.05);
assert.equal(toModelCallLogItem({ ...row, cacheHitTokens: null }).costCny, 3);
assert.equal(toModelCallLogItem({ ...row, model: "unpriced-private-model" }).costCny, null);
const missing = toModelCallLogItem({ ...row, totalTokens: 0, promptTokens: 0, cacheHitTokens: null, metadata: { status: "failed", reason: "timeout", attempts: 2 } });
assert.equal(missing.usageReported, false);
assert.equal(missing.costCny, null);
assert.equal(missing.status, "failed");
assert.equal(missing.attempts, 2);
assert.equal(missing.reason, "timeout");
assert.equal(toModelCallLogItem({ ...row, metadata: { reason: "model_generation_failed", durationMs: 1234 } }).reason, "model_generation_failed");
assert.equal(toModelCallLogItem({ ...row, metadata: { durationMs: 1234 } }).durationMs, 1234);
for (const durationMs of [-1, 3_600_001, 0.5, "1234", Infinity]) assert.equal(toModelCallLogItem({ ...row, metadata: { durationMs } }).durationMs, null);
for (const status of ["success", "no_sources", "context_answered"]) assert.equal(modelCallLogStatus({ status }), "success");
for (const status of ["failed", "final_reply_failed"]) assert.equal(modelCallLogStatus({ status }), "failed");
for (const metadata of [null, [], { status: "ok" }, { status: "SUCCESS" }, { httpStatus: 200 }]) assert.equal(modelCallLogStatus(metadata), "unknown");
const unsafe = toModelCallLogItem({ ...row, metadata: { status: "success", reason: "Bearer sk-secret prompt content", finishReason: "raw provider error!", apiKey: "secret", prompt: "private", attempts: -1, httpStatus: 999 } });
assert.equal(unsafe.reason, null);
assert.equal(unsafe.finishReason, null);
assert.equal(unsafe.attempts, null);
assert.equal(unsafe.httpStatus, null);
assert.ok(!JSON.stringify(unsafe).includes("secret"));
assert.equal(toModelCallLogItem({ ...row, metadata: { finishReason: "stop", httpStatus: 429, attempts: 0 } }).httpStatus, 429);

// Exercise real query orchestration against a bounded delegate; no live database is touched.
const calls: { method: string; args: Record<string, unknown> }[] = [];
let countIndex = 0;
const fake = { modelUsage: {
  findMany: async (args: Record<string, unknown>) => { calls.push({ method: "findMany", args }); return [row]; },
  aggregate: async (args: Record<string, unknown>) => { calls.push({ method: "aggregate", args }); return { _count: { _all: 8 }, _sum: { totalTokens: 123 } }; },
  count: async (args: Record<string, unknown>) => { calls.push({ method: "count", args }); return [3, 2, 1][countIndex++]; },
  groupBy: async (args: Record<string, unknown>) => { calls.push({ method: "groupBy", args }); return args.by instanceof Array && args.by[0] === "model" ? [{ model: "deepseek-flash" }] : [{ kind: "chat" }]; },
} } as unknown as ReturnType<typeof getPrisma>;
const result = await readModelCallLogs("owned-character", { ...defaults, kind: "chat", model: "deepseek-flash", page: 3, pageSize: 50 }, fake, now);
assert.deepEqual(result.summary, { records: 8, totalTokens: 123, failed: 2, unknown: 3, usageMissingRecords: 1 });
assert.equal(result.total, 8);
const list = calls.find((call) => call.method === "findMany")!.args;
assert.equal(list.take, 50);
assert.equal(list.skip, 100);
assert.deepEqual(list.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
for (const facet of calls.filter((call) => call.method === "groupBy")) {
  assert.equal(facet.args.take, 200);
  assert.deepEqual(facet.args.where, where, "Facets ignore active model/kind filters but retain owner character/date.");
}
const countCalls = calls.filter((call) => call.method === "count");
assert.ok(JSON.stringify(countCalls[0]).includes('"path":["status"]'));
assert.ok(JSON.stringify(countCalls[1]).includes("final_reply_failed"));
assert.ok(JSON.stringify(countCalls[2]).includes('"lte":0'));
for (const call of calls) assert.ok(JSON.stringify(call.args.where).includes("owned-character"));
const route = readFileSync(new URL("../server/api/characters/[id]/usage/logs.get.ts", import.meta.url), "utf8");
assert.match(route, /await requireActorUserId\(event\)/);
assert.match(route, /where: \{ id: characterId, ownerId \}/);
assert.match(route, /if \(!character\) throw createError\(\{ statusCode: 404/);
assert.ok(route.indexOf("if (!character)") < route.indexOf("return readModelCallLogs("));
assert.doesNotMatch(route, /\.(create|update|delete|upsert)(Many)?\(/);
console.log("Model call logs: filters, Shanghai dates, safe metadata, unknown status, pricing, bounded queries and authorization source checks passed (no database).");
