import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModelTurnDetail, readModelTurnDetail, readModelTurnId, sanitizeModelTurnDetail } from "../server/utils/model-turn-detail";
import { toModelCallLogItem } from "../server/utils/model-call-logs";

const huge = "长".repeat(20000);
const detail = sanitizeModelTurnDetail({ version: 1, groupChat: true, messages: Array.from({ length: 60 }, (_, i) => ({ id: String(i), content: huge, apiKey: "secret" })),
  context: { status: "success", summary: huge, evidence: [{ content: "证据" }], reasoning_content: "hidden" },
  memory: { status: "success", query: huge, sources: [{ id: "private", type: "memory", scope: "private", content: "private secret" }, { id: "public", type: "memory", scope: "character", content: huge }] },
  response: { status: "success", action: "silent", explanation: huge, reasoning_content: "hidden" }, apiKey: "secret" });
assert.equal(detail.messages.length, 20);
assert.equal(detail.messages[0].content.length, 1200);
assert.equal(detail.memory.sources?.length, 1);
assert.equal(detail.memory.sources?.[0].id, "public");
assert.equal(detail.context.summary?.length, 1600);
assert.equal(detail.response.explanation?.length, 400);
assert(!JSON.stringify(detail).includes("reasoning_content"));
assert(!JSON.stringify(detail).includes("apiKey"));
const capture = createModelTurnDetail(false, [{ content: "本轮" }]);
capture.update({ memory: { status: "no_sources", query: "昨天" } });
capture.update({ collaboration: { version: 1, elapsedMs: 12, stages: [] }, growthReads: [{ domain: "knowledge", status: "provided" }] });
capture.update({ retrieval: { memory: { count: 3, usedTokens: 420, dropped: 7 }, snapshot: { count: 1, usedTokens: 600, dropped: 2 },
  event: { count: 2, usedTokens: 180, dropped: 0, mode: "range" }, recentEvent: { count: 1 }, used: { memory: 1, snapshot: 0, event: 2 } } });
capture.update({ response: { action: "reply", reply: "没找到", explanation: "没有相关证据" } });
const restored = readModelTurnDetail(capture.serialize());
assert.equal(restored?.memory.status, "no_sources");
assert.equal(restored?.collaboration?.elapsedMs, 12, "private collaboration diagnostics are retained");
assert.equal(restored?.growthReads, undefined, "private growth-read diagnostics remain excluded");
assert.equal(restored?.response.status, "success");
assert.equal(restored?.response.explanation, "没有相关证据");
const retrieval = restored?.retrieval;
assert.equal(retrieval?.memory.count, 3, "记忆分段统计要保留");
assert.equal(retrieval?.memory.dropped, 7, "「被预算挤掉几条」正是排查要看的那一项");
assert.equal(retrieval?.event.mode, "range", "忆泡是按时段还是关键词选的要留下");
assert.equal(retrieval?.event.recent, 1, "近期背景忆泡条数单独记");
assert.deepEqual(retrieval?.used, { memory: 1, snapshot: 0, event: 2 }, "模型自报引用要和「放进去几条」分开记");
assert.deepEqual(restored?.retrieval?.used, retrieval?.used, "落盘再读回不能丢引用计数");
// 计划必须真的落盘：update 只处理 retrieval 那次，contextPlan 被静默丢掉了。
const withPlan = createModelTurnDetail(false, [{ content: "本轮" }], "web");
withPlan.update({
  contextPlan: {
    surface: "desktop", totalBudget: 5100,
    segments: [{ source: "memory", reason: "always", budget: 1800, limit: 20, used: 900, items: 4, optional: true }],
  },
});
const planRoundTrip = readModelTurnDetail(withPlan.serialize());
assert.equal(planRoundTrip?.contextPlan?.segments.length, 1, "计划要能从序列化结果里读回来");
assert.equal(planRoundTrip?.contextPlan?.segments[0]?.used, 900);
assert.equal(planRoundTrip?.contextPlan?.surface, "desktop");

// 只有数字：脏字段、未知 mode、负数与超大值都不该原样落盘。
const dirty = sanitizeModelTurnDetail({
  version: 1, groupChat: true, messages: [], context: { status: "success" }, memory: { status: "success" }, response: { status: "success" },
  retrieval: { memory: { count: -5, usedTokens: 1e9, dropped: "3" }, snapshot: { count: 1, usedTokens: 2, dropped: 0 }, event: { count: 0, usedTokens: 0, dropped: 0, mode: "guess", prompt: "secret" }, apiKey: "secret" },
});
assert.equal(dirty.retrieval, undefined, "缺项或类型不对时整块丢弃，不写半截统计");
const clamped = sanitizeModelTurnDetail({
  version: 1, groupChat: false, messages: [], context: { status: "success" }, memory: { status: "success" }, response: { status: "success" },
  retrieval: { memory: { count: -5, usedTokens: 999_999_999, dropped: 3.6 }, snapshot: { count: 0, usedTokens: 0, dropped: 0 }, event: { count: 0, usedTokens: 0, dropped: 0 }, extra: "secret" },
});
assert.deepEqual(clamped.retrieval, { memory: { count: 0, usedTokens: 100_000, dropped: 4 }, snapshot: { count: 0, usedTokens: 0, dropped: 0 }, event: { count: 0, usedTokens: 0, dropped: 0 } });
assert(!JSON.stringify(clamped).includes("secret"));
const controls = createModelTurnDetail(true, Array.from({ length: 20 }, () => ({ content: String.fromCharCode(1).repeat(1200) })));
assert(controls.serialize().length <= 80_000);
assert(readModelTurnDetail(controls.serialize()));
assert.equal(readModelTurnDetail("bad"), null);
assert.equal(readModelTurnDetail(JSON.stringify({ version: 2 })), null);
assert.equal(readModelTurnDetail(" ".repeat(80001)), null);
assert.equal(readModelTurnId({ turnId: "x" }), null);
const turnId = "11111111-1111-4111-8111-111111111111";
assert.equal(readModelTurnId({ turnId }), turnId);
const row = toModelCallLogItem({ id: "log", kind: "chat", model: "unknown", createdAt: new Date(), metadata: { turnId, turnDetail: capture.serialize() }, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: null, cacheHitTokens: null, cacheMissTokens: null });
assert.equal(row.turnId, turnId);
assert.equal(row.hasTurnDetail, true);
assert(!("turnDetail" in row));
const endpoint = readFileSync("server/api/characters/[id]/usage/logs/[logId]/turn.get.ts", "utf8");
assert(endpoint.indexOf("requireActorUserId(event)") < endpoint.indexOf("prisma.modelUsage.findFirst"));
assert(endpoint.includes("where: { id: characterId, ownerId }"));
assert(endpoint.includes("where: { id: logId, characterId }"));
assert(endpoint.includes('metadata: { path: ["turnId"], equals: turnId }'));
assert(endpoint.includes("readModelTurnDetail(metadata.turnDetail)"));
console.log("Model turn details passed: bounded allowlist, private group-source exclusion, callback capture, legacy and owner/turn query boundaries (no database).");
