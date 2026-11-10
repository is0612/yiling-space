import assert from "node:assert/strict";
import { growthEventRetryDelayMs } from "../server/utils/growth-event-delivery";
import {
  GROWTH_EVENT_LEASE_MS,
  GROWTH_EVENT_MAX_ATTEMPTS,
  GROWTH_EVENT_MAX_PAYLOAD_BYTES,
  GROWTH_EVENT_SUCCESS_RETENTION_DAYS,
  listGrowthEventSubscribers,
  normalizeGrowthEventInput,
} from "../server/utils/growth-event-center";

const valid = {
  characterId: "6c66d8c4-80a8-4b84-9c20-1b9bb72a09b4",
  sourceDomain: "memory" as const,
  eventType: "memory.event.created",
  aggregateType: "MemoryEvent",
  aggregateId: "6c66d8c4-80a8-4b84-9c20-1b9bb72a09b4",
  occurredAt: new Date("2026-11-10T00:00:00.000Z"),
  idempotencyKey: "memory.event.created:6c66d8c4-80a8-4b84-9c20-1b9bb72a09b4",
  payload: { sourceId: "6c66d8c4-80a8-4b84-9c20-1b9bb72a09b4" },
};

const normalized = normalizeGrowthEventInput(valid);
assert.equal(normalized.schemaVersion, 1);
assert.equal(normalized.eventType, "memory.event.created");
assert.deepEqual(normalized.payload, valid.payload);
assert.deepEqual(listGrowthEventSubscribers("memory.event.created"), ["growth.memory-source-integrity"]);
assert.deepEqual(listGrowthEventSubscribers("social.experience.created"), ["social.relationship-assessment-dispatch"]);
assert.equal(GROWTH_EVENT_LEASE_MS, 5 * 60 * 1000);
assert.equal(GROWTH_EVENT_MAX_ATTEMPTS, 5);
assert.equal(GROWTH_EVENT_SUCCESS_RETENTION_DAYS, 30);
assert.equal(growthEventRetryDelayMs(1), 60_000);
assert.equal(growthEventRetryDelayMs(2), 120_000);
assert.equal(growthEventRetryDelayMs(3), 240_000);
assert.equal(growthEventRetryDelayMs(99), 6 * 60 * 60 * 1000);

const invalidCases: Array<[string, Record<string, unknown>]> = [
  ["empty character", { characterId: " " }],
  ["invalid character id", { characterId: "character-id" }],
  ["unknown domain", { sourceDomain: "other" }],
  ["invalid event type", { eventType: "Memory Event Created" }],
  ["event type source mismatch", { eventType: "social.experience.created" }],
  ["oversized payload", { payload: { text: "x".repeat(GROWTH_EVENT_MAX_PAYLOAD_BYTES) } }],
  ["empty aggregate", { aggregateType: "" }],
  ["empty aggregate id", { aggregateId: "" }],
  ["empty idempotency key", { idempotencyKey: "" }],
  ["invalid schema version", { schemaVersion: 0 }],
  ["invalid timestamp", { occurredAt: new Date("invalid") }],
];
for (const [label, patch] of invalidCases) {
  assert.throws(() => normalizeGrowthEventInput({ ...valid, ...patch } as never), undefined, label);
}

console.log("Growth Event Center contract tests passed.");
