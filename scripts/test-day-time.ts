import assert from "node:assert/strict";
import { formatDayClock } from "../app/utils/day-time";

const instant = "2026-11-05T16:30:00.000Z";
assert.equal(formatDayClock(instant, "Asia/Shanghai"), "00:30");
assert.equal(formatDayClock(instant, "Asia/Kuala_Lumpur"), "00:30");
assert.equal(formatDayClock(instant, "America/Los_Angeles"), "08:30");
assert.equal(formatDayClock(null, "Asia/Shanghai"), "");
assert.equal(formatDayClock("not-a-date", "Asia/Shanghai"), "");
assert.equal(formatDayClock(instant, "invalid/legacy-zone"), "00:30");

console.log("calendar timezone formatting passed");
