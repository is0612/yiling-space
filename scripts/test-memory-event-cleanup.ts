import assert from "node:assert/strict";
import { rawMessageCleanupDependencyCutoff } from "../server/utils/memory-event-cleanup";

const now = new Date("2026-11-10T00:00:00.000Z");
const periodEnd = new Date("2026-10-11T00:00:00.000Z");
const cutoff = rawMessageCleanupDependencyCutoff({ periodEnd, now, retentionDays: 30, contextRetentionDays: 7 });
assert.equal(cutoff.toISOString(), "2026-11-03T00:00:00.000Z", "The dependency scan must cover the newer context-message cutoff.");
assert.ok(new Date("2026-11-01T00:00:00.000Z") < cutoff, "A pending 9-day-old context message must block cleanup.");
assert.equal(
  rawMessageCleanupDependencyCutoff({ periodEnd, now, retentionDays: 3, contextRetentionDays: 7 }).toISOString(),
  "2026-11-07T00:00:00.000Z",
  "Shorter owner retention must bound both evidence and context deletion.",
);
assert.equal(
  rawMessageCleanupDependencyCutoff({ periodEnd: new Date("2026-11-04T00:00:00Z"), now, retentionDays: 30, contextRetentionDays: 7 }).toISOString(),
  "2026-11-04T00:00:00.000Z",
  "The later of evidence and context cutoffs must be used.",
);
console.log("Memory cleanup dependency cutoff tests passed.");
