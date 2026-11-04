import assert from "node:assert/strict";
import type { Prisma } from "../src/generated/prisma/client";
import { moveConversationEventsToScope } from "../server/utils/memory-event-move";
import { eventMessageWhere } from "../server/utils/memory-event-source";

// Pure mocked transaction; no database client, model, environment loading, or network.
type Day = { state: "DRAFT" | "FINAL"; extractedAt: Date | null; extractedMessageId?: string | null };
const at = (hour: number) => new Date(`2026-11-01T${String(hour).padStart(2, "0")}:00:00Z`);
async function merge(oldDay: Day | null, newDay: Day | null) {
  let target: Day | null = newDay && { ...newDay };
  const tx = {
    message: { findMany: async () => [{ id: "source-message" }] },
    memoryEvent: {
      findMany: async () => [{ id: "event", dayKey: "2026-11-01", dedupeKey: "event-key" }],
      findFirst: async () => null,
      update: async () => ({}),
      count: async () => 1,
    },
    memoryEventDay: {
      findUnique: async (q: { where: { memoryScopeId_dayKey: { memoryScopeId: string } } }) =>
        q.where.memoryScopeId_dayKey.memoryScopeId === "from" ? oldDay : target,
      update: async (q: { where: { memoryScopeId_dayKey: { memoryScopeId: string } }; data: Partial<Day> }) => {
        if (q.where.memoryScopeId_dayKey.memoryScopeId === "to") target = { ...target!, ...q.data };
      },
      create: async (q: { data: Day }) => { target = { ...q.data }; },
    },
  };
  await moveConversationEventsToScope(tx as unknown as Prisma.TransactionClient, {
    conversationId: "moving-conversation", fromScopeId: "from", toScopeId: "to",
  });
  return target!;
}
for (const [source, destination] of [
  [{ state: "FINAL", extractedAt: at(18) }, { state: "DRAFT", extractedAt: at(10), extractedMessageId: "old-id" }],
  [{ state: "DRAFT", extractedAt: at(18) }, { state: "DRAFT", extractedAt: null, extractedMessageId: null }],
  [{ state: "FINAL", extractedAt: at(18) }, null],
  [null, { state: "FINAL", extractedAt: at(18), extractedMessageId: "old-id" }],
] as Array<[Day | null, Day | null]>) {
  const result = await merge(source, destination);
  assert.equal(result.state, "DRAFT");
  assert.equal(result.extractedAt, null, "A scope-local watermark must not skip the destination's unprocessed evidence");
  assert.equal(result.extractedMessageId, null);
  const query = eventMessageWhere({ memoryScopeId: "to", privateOnly: false,
    periodStart: at(0), periodEnd: new Date("2026-11-02T00:00:00Z"), progress: result });
  assert.equal(query.OR, undefined);
  assert.deepEqual(query.occurredAt, { gte: at(0), lt: new Date("2026-11-02T00:00:00Z") },
    "11:00 destination evidence between the former 10:00 / 18:00 cursors remains readable");
}
const final = await merge({ state: "FINAL", extractedAt: at(18) }, { state: "FINAL", extractedAt: at(10) });
assert.equal(final.state, "FINAL", "Two fully extracted scopes may remain closed");
assert.equal(final.extractedMessageId, null);
console.log("Memory move cursor regression passed: separate watermarks, null progress, target without progress, missing source progress, and both FINAL.");
