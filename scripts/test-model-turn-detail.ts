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
capture.update({ response: { action: "reply", reply: "没找到", explanation: "没有相关证据" } });
const restored = readModelTurnDetail(capture.serialize());
assert.equal(restored?.memory.status, "no_sources");
assert.equal(restored?.response.status, "success");
assert.equal(restored?.response.explanation, "没有相关证据");
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
