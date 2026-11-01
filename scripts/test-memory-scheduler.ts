import assert from "node:assert/strict";
import { buildDueMemoryPeriods, isOwnerPrivateScopeKey } from "../server/utils/memory-scheduler";

const anchorEnd = new Date("2026-10-01T00:00:00.000Z");

const beforeBoundary = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  now: new Date("2026-09-30T23:59:59.999Z"),
});
assert.equal(beforeBoundary.periods.length, 0, "A cycle must not enqueue before its exact end boundary.");

const exactBoundary = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  now: anchorEnd,
});
assert.equal(exactBoundary.periods.length, 1, "A cycle must enqueue when now equals the end boundary.");
assert.equal(exactBoundary.periods[0]?.periodStart.toISOString(), "2026-09-23T00:00:00.000Z");
assert.equal(exactBoundary.periods[0]?.periodEnd.toISOString(), "2026-10-01T00:00:00.000Z");
assert.equal(exactBoundary.periods[0]?.idempotencyKey, "auto-snapshot:scope-1:2026-09-23T00:00:00.000Z:2026-10-01T00:00:00.000Z");
assert.equal(exactBoundary.nextSnapshotAt?.toISOString(), "2026-10-09T00:00:00.000Z");
assert.equal(exactBoundary.stillDue, false);

const missedCycles = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  now: new Date("2026-10-20T12:00:00.000Z"),
});
assert.equal(missedCycles.periods.length, 3, "Overdue cycles should be backfilled one period at a time.");
assert.equal(missedCycles.periods[2]?.periodEnd.toISOString(), "2026-10-17T00:00:00.000Z");
assert.equal(missedCycles.nextSnapshotAt?.toISOString(), "2026-10-25T00:00:00.000Z");

const pendingIntervalBeforeBoundary = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  pendingIntervalDays: 3,
  now: new Date("2026-09-30T23:59:59.999Z"),
});
assert.equal(pendingIntervalBeforeBoundary.periods.length, 0, "A pending interval must not advance before the current boundary.");
assert.equal(pendingIntervalBeforeBoundary.nextSnapshotAt?.toISOString(), anchorEnd.toISOString());

const pendingIntervalAtBoundary = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  pendingIntervalDays: 3,
  now: anchorEnd,
});
assert.equal(pendingIntervalAtBoundary.periods.length, 1, "The in-flight period must close using the active interval.");
assert.equal(pendingIntervalAtBoundary.periods[0]?.periodStart.toISOString(), "2026-09-23T00:00:00.000Z");
assert.equal(pendingIntervalAtBoundary.periods[0]?.periodEnd.toISOString(), "2026-10-01T00:00:00.000Z");
assert.equal(pendingIntervalAtBoundary.nextSnapshotAt?.toISOString(), "2026-10-04T00:00:00.000Z", "The next boundary should advance using the pending 3-day interval.");

const pendingIntervalBackfill = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  pendingIntervalDays: 3,
  now: new Date("2026-10-10T00:00:00.000Z"),
});
assert.deepEqual(
  pendingIntervalBackfill.periods.map((period) => [period.periodStart.toISOString(), period.periodEnd.toISOString()]),
  [
    ["2026-09-23T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["2026-10-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z"],
    ["2026-10-04T00:00:00.000Z", "2026-10-07T00:00:00.000Z"],
    ["2026-10-07T00:00:00.000Z", "2026-10-10T00:00:00.000Z"],
  ],
  "Missed periods after the pending boundary must use the new interval.",
);
assert.equal(pendingIntervalBackfill.nextSnapshotAt?.toISOString(), "2026-10-13T00:00:00.000Z");

const invalidPendingInterval = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 8,
  pendingIntervalDays: 0,
  now: anchorEnd,
});
assert.equal(invalidPendingInterval.periods.length, 0, "Invalid pending intervals must not produce snapshot jobs.");

const cappedBackfill = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 1,
  now: new Date("2026-10-20T00:00:00.000Z"),
  maxPeriods: 5,
});
assert.equal(cappedBackfill.periods.length, 5);
assert.equal(cappedBackfill.stillDue, true, "Backfill caps must leave the setting due for the next scheduler pass.");

const disabledOrNotDue = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: new Date("2026-10-21T00:00:00.000Z"),
  intervalDays: 8,
  now: anchorEnd,
});
assert.equal(disabledOrNotDue.periods.length, 0);
assert.equal(disabledOrNotDue.nextSnapshotAt?.toISOString(), "2026-10-21T00:00:00.000Z");

const invalidInterval = buildDueMemoryPeriods({
  memoryScopeId: "scope-1",
  nextSnapshotAt: anchorEnd,
  intervalDays: 0,
  now: anchorEnd,
});
assert.equal(invalidInterval.periods.length, 0);

// 主人自己的 QQ 私聊范围不能当「别人的私聊」排忆泡：写进 EXTERNAL 的事件主人读不到。
assert.equal(
  isOwnerPrivateScopeKey("character:abc:external:qq-onebot:10001", ["10001"]),
  true,
  "主人 QQ 的外部身份范围要跳过。",
);
assert.equal(
  isOwnerPrivateScopeKey("character:abc:external:qq-onebot:100011", ["10001"]),
  false,
  "账号匹配必须整段相等，不能把 100011 当成 10001。",
);
assert.equal(
  isOwnerPrivateScopeKey("character:abc:external:qq-onebot:90001", ["10001"]),
  false,
  "别人的私聊范围照常排。",
);
assert.equal(
  isOwnerPrivateScopeKey("character:abc:external:qq-onebot:10001", []),
  false,
  "没配主人 QQ 时不误伤。",
);

console.log("Memory scheduler unit tests passed: exact boundary, deferred interval changes, no early scheduling, mixed-interval backfill, idempotency keys, capped backlog, invalid intervals, and owner-private scope exclusion.");
