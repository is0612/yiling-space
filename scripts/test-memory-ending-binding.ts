import assert from "node:assert/strict";
import { applyMemoryChange, type MemoryApplyContext, type MemoryApplyTx, type MemoryEvidenceMessage } from "../server/utils/memory-change-apply";
import type { MemoryChange } from "../server/utils/memory-ai";

// Directly exercise the production mutator; no parser or real database hides a missing guard.
const at = new Date("2026-11-25T12:00:00Z");
const message: MemoryEvidenceMessage = { id: "done", role: "USER", occurredAt: at };
const change: MemoryChange = { action: "INVALIDATE", category: "FACT", content: "已完成", confidence: 0.95,
  relatedMemoryId: "m", invalidationBasis: "TEMPORARY_STATE_ENDED", evidenceMessageIds: ["plan", "done"], endingEvidenceMessageIds: ["done"] };
const event = { title: "完成", detail: "确认完成", endedMemoryIds: ["m"], evidenceMessageIds: ["done"] };
async function run(options: { events?: readonly unknown[]; evidence?: MemoryEvidenceMessage[]; mutation?: Partial<MemoryChange>; category?: "FACT" | "EVENT" | "RELATIONSHIP" | "PREFERENCE"; accepted?: boolean } = {}) {
  let writes = 0;
  let audits = 0;
  let stored: Date | undefined;
  const category = options.category ?? "FACT";
  const tx = {
    $queryRaw: async () => [],
    memoryItem: { findFirst: async () => ({ category, content: "待完成" }), updateMany: async ({ data }: any) => { writes++; stored = data.validTo; return { count: 1 }; } },
    auditLog: { create: async ({ data }: any) => { audits++; assert.deepEqual(data.details.matchedImportantEventIndexes, [1, 2]); } },
  } as unknown as MemoryApplyTx;
  const ctx: MemoryApplyContext = { memoryScopeId: "scope", characterId: "c", snapshotId: "s", actorType: "WORKER", auditActionPrefix: "memory.ai_",
    canTarget: id => id === "m", bindingMemoryIds: new Set(["m", "other"]), resolvePrevious: async () => ({ category, content: "待完成" }),
    handledMemoryIds: new Set(), existingDedupeKeys: new Set(), existingItemSignatures: new Set() };
  const result = await applyMemoryChange(tx, ctx, { ...change, ...options.mutation }, options.evidence ?? [message], { importantEvents: options.events });
  assert.equal(Boolean(result), options.accepted ?? false);
  assert.equal(writes, options.accepted ? 1 : 0);
  assert.equal(audits, options.accepted ? 1 : 0);
  if (options.accepted) assert.deepEqual(stored, at);
}
await run();
for (const events of [[{ ...event, endedMemoryIds: undefined }], [{ ...event, endedMemoryIds: [] }],
  [{ ...event, endedMemoryIds: ["other"] }], [{ ...event, endedMemoryIds: ["m", "unknown"] }],
  [{ ...event, endedMemoryIds: ["m", "m"] }], [{ ...event, evidenceMessageIds: [] }]]) await run({ events });
await run({ events: [event], mutation: { endingEvidenceMessageIds: undefined } });
await run({ events: [event], mutation: { endingEvidenceMessageIds: ["done", "another"] }, evidence: [message, { ...message, id: "another" }] });
await run({ events: [event], mutation: { evidenceMessageIds: ["plan"] } });
await run({ events: [event], evidence: [{ ...message, role: "ASSISTANT" }] });
await run({ events: [event], evidence: [] });
await run({ events: [event], evidence: [{ ...message, occurredAt: new Date(NaN) }] });
for (const category of ["EVENT", "RELATIONSHIP", "PREFERENCE"] as const) await run({ events: [event], category });
await run({ events: [null, event, event], evidence: [{ id: "plan", role: "USER", occurredAt: new Date("2026-11-20T00:00:00Z") }, message], accepted: true });
console.log("Direct memory apply binding guards passed: rejected inputs never update or audit, valid binding persists confirmation time and snapshot indexes.");
