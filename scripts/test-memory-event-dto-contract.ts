/**
 * MemoryEvent（忆泡）响应契约回归。
 *
 * 守四件事：
 * 1. 日子详情与编辑接口共用 `toMemoryEvent`，形状不再分叉
 *    （编辑接口原先没有 confidence / sourceMessageIds，日子详情没有 dayKey）；
 * 2. 不泄漏内部字段：`memoryScopeId` / `participantRefs` / `keywords` / `dedupeKey` / `originId`；
 * 3. `scope` 的语义映射：scopeType → character / private / external；
 * 4. `dayKey` 是可选字段（日子详情不重复回传），不能因为一处没有就写死成必填。
 *
 * 时间线条目（`toMemoryTimelineDtos`）是跨实体的联合形状，不属于这个契约，这里不测。
 */
import assert from "node:assert/strict";
import { memoryEventScopeOf, toMemoryEvent, type MemoryEventRow } from "../server/utils/memory-event-dto";
import { MEMORY_EVENT_SCOPES, MEMORY_EVENT_STATES, MEMORY_EVENT_STATUSES, MEMORY_SCOPE_TYPES } from "../shared/types/memory";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const at = new Date("2026-11-22T08:30:00.000Z");

// 照真实 `memory_events` 行造：带上所有不该发出去的内部字段。
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  originId: "22222222-2222-4222-8222-222222222222",
  memoryScopeId: "33333333-3333-4333-8333-333333333333",
  conversationId: "44444444-4444-4444-8444-444444444444",
  dayKey: "2026-11-22",
  state: "FINAL",
  occurredAt: at,
  timeOfDay: "深夜",
  precision: "part_of_day",
  place: "海边",
  title: "一起看星星",
  detail: "聊到很晚，认出了北斗七星。",
  keywords: ["星星", "北斗"],
  participants: ["主人"],
  participantRefs: [{ kind: "owner", id: "55555555-5555-4555-8555-555555555555" }],
  confidence: 0.82,
  sourceMessageId: "66666666-6666-4666-8666-666666666666",
  sourceMessageIds: ["66666666-6666-4666-8666-666666666666"],
  sourceSnapshotId: null,
  dedupeKey: "dedupe-marker",
  status: "ACTIVE",
  createdAt: at,
  memoryScope: { scopeType: "CHARACTER_GLOBAL" },
} as unknown as MemoryEventRow;

const event = toMemoryEvent(row);
assert.deepEqual(
  Object.keys(event).sort(),
  ["confidence", "dayKey", "detail", "id", "occurredAt", "participants", "place", "scope", "sourceMessageIds", "state", "status", "timeOfDay", "title"],
  "MemoryEvent 只应有契约里的字段",
);
for (const leaked of ["memoryScopeId", "participantRefs", "keywords", "dedupeKey", "originId", "conversationId", "precision", "sourceMessageId", "sourceSnapshotId", "createdAt", "memoryScope"]) {
  assert.ok(!(leaked in (event as unknown as Record<string, unknown>)), `忆泡不应带内部字段 ${leaked}`);
}

assert.match(event.occurredAt, ISO, "occurredAt 必须是 ISO 8601 UTC 字符串");
assert.equal(event.confidence, 0.82);
assert.ok(MEMORY_EVENT_STATES.includes(event.state));
assert.ok(MEMORY_EVENT_STATUSES.includes(event.status));
assert.ok(MEMORY_EVENT_SCOPES.includes(event.scope));

// dayKey 可选：日子详情不 select 它（同一个接口里 dayKey 在顶层），此时不应凭空造一个。
const withoutDayKey = toMemoryEvent({ ...row, dayKey: undefined } as unknown as MemoryEventRow);
assert.ok(!("dayKey" in withoutDayKey), "没有 dayKey 时不应输出该字段");

// confidence 的 null 语义要保留（草稿可能还没算分）。
assert.equal(toMemoryEvent({ ...row, confidence: null } as unknown as MemoryEventRow).confidence, null);
// sourceMessageIds 空数组也要保留（前端按它渲染「依据」）。
assert.deepEqual(toMemoryEvent({ ...row, sourceMessageIds: [] } as unknown as MemoryEventRow).sourceMessageIds, []);

// scope 三档映射，且认不出来的范围按 character 处理（不能误判成私人）。
assert.equal(memoryEventScopeOf("CHARACTER_GLOBAL"), "character");
assert.equal(memoryEventScopeOf("USER_PRIVATE"), "private");
assert.equal(memoryEventScopeOf("EXTERNAL_IDENTITY"), "external");
for (const scopeType of MEMORY_SCOPE_TYPES) {
  assert.ok(MEMORY_EVENT_SCOPES.includes(memoryEventScopeOf(scopeType)), `scopeType ${scopeType} 的映射结果必须在契约内`);
}
assert.equal(memoryEventScopeOf("UNKNOWN_SCOPE"), "character", "认不出的范围按角色全局，不能默认成私人");

console.log("MemoryEvent contract: 两处同源整形、字段白名单、dayKey 可选语义、confidence/sourceMessageIds 空值保留与 scope 三档映射均符合 shared/types/memory.ts。");
