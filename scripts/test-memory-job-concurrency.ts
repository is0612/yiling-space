import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { enqueueAutomaticEventJobs } from "../server/utils/memory-auto-queue";
import { lockExpectedEventDayProgress, MemoryEventProgressConflictError, type EventDayProgress } from "../server/utils/memory-event-progress-lock";

// A transactional state model, not PostgreSQL: no Prisma client, .env, network, or model is used.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function mutex() {
  let tail = Promise.resolve();
  return async () => {
    const previous = tail;
    const done = deferred();
    tail = done.promise;
    await previous;
    return done.resolve;
  };
}
const scope = "00000000-0000-4000-8000-000000000001";
const dayKey = "2026-11-23";
const job: Prisma.MemoryJobCreateManyInput = {
  memoryScopeId: scope, type: "EXTRACT_EVENTS", idempotencyKey: "events-final:test:2026-11-23",
};

async function settingRace(disableFirst: boolean) {
  const acquire = mutex();
  let enabled = true;
  const jobs: string[] = [];
  const acquired = deferred();
  const continueFirst = deferred();
  const db = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      let release: (() => void) | undefined;
      try {
        return await callback({
          $queryRaw: async (strings: TemplateStringsArray) => {
            assert.match(strings.join("?"), /character_memory_settings.*FOR UPDATE/);
            release = await acquire();
            if (!disableFirst) { acquired.resolve(); await continueFirst.promise; }
            return [{ characterId: scope }];
          },
          characterMemorySetting: { findUnique: async () => ({ autoSnapshotEnabled: enabled }) },
          memoryJob: { createMany: async () => { jobs.push("QUEUED"); return { count: 1 }; } },
        });
      } finally { release?.(); }
    },
  } as unknown as PrismaClient;
  const disable = async () => {
    const release = await acquire();
    try {
      if (disableFirst) { acquired.resolve(); await continueFirst.promise; }
      enabled = false;
      for (let n = 0; n < jobs.length; n++) jobs[n] = "CANCELLED";
    } finally { release(); }
  };
  if (disableFirst) {
    const stopping = disable();
    await acquired.promise;
    const inserting = enqueueAutomaticEventJobs(db, scope, [job]);
    continueFirst.resolve();
    await stopping;
    assert.equal((await inserting).count, 0, "A stale scheduler must re-read disabled under lock");
    assert.deepEqual(jobs, []);
  } else {
    const inserting = enqueueAutomaticEventJobs(db, scope, [job]);
    await acquired.promise;
    const stopping = disable();
    continueFirst.resolve();
    assert.equal((await inserting).count, 1);
    await stopping;
    assert.deepEqual(jobs, ["CANCELLED"], "Disable must see an insertion that acquired the lock first");
  }
}
await settingRace(true);
await settingRace(false);

// Both workers hold different valid job tokens. Only the shared scope lock serializes commits.
const acquireScope = mutex();
let persisted: EventDayProgress = null;
let sideEffects = 0;
async function commit(expected: EventDayProgress, next: Exclude<EventDayProgress, null>, hold?: { entered: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> }) {
  let release: (() => void) | undefined;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      assert.match(strings.join("?"), /memory_scopes.*FOR NO KEY UPDATE/);
      release = await acquireScope();
      return [{ id: scope }];
    },
    memoryEventDay: { findUnique: async () => persisted },
  } as unknown as Prisma.TransactionClient;
  try {
    await lockExpectedEventDayProgress(tx, scope, dayKey, expected);
    if (hold) { hold.entered.resolve(); await hold.resume.promise; }
    // Domain writes and progress commit only after the production guard returns.
    sideEffects++;
    persisted = structuredClone(next);
  } finally { release?.(); }
}
const first: Exclude<EventDayProgress, null> = { state: "DRAFT", extractedAt: new Date("2026-11-23T10:00:00Z"), extractedMessageId: "m1" };
const later: Exclude<EventDayProgress, null> = { state: "DRAFT", extractedAt: new Date("2026-11-23T11:00:00Z"), extractedMessageId: "m2" };
const entered = deferred();
const resume = deferred();
const newer = commit(null, later, { entered, resume });
await entered.promise;
const stale = commit(null, first);
resume.resolve();
await newer;
await assert.rejects(stale, MemoryEventProgressConflictError);
assert.deepEqual(persisted, later);
assert.equal(sideEffects, 1, "A stale chunk must not create events, social references, audit, or outbox writes");
await commit(later, { ...later, state: "FINAL" });
await assert.rejects(commit(first, first), MemoryEventProgressConflictError);
await assert.rejects(commit(later, later), MemoryEventProgressConflictError);
await assert.rejects(commit({ ...later, state: "FINAL" }, later), MemoryEventProgressConflictError);
assert.equal((persisted as EventDayProgress)?.state, "FINAL");
assert.equal(sideEffects, 2, "FINAL must remain terminal, including an empty-page finalizer");

// Same timestamp: the message-id tie breaker must participate in CAS.
persisted = structuredClone(later);
await assert.rejects(commit({ ...later, extractedMessageId: "older-at-same-time" }, first), MemoryEventProgressConflictError);
await commit(later, { ...later, extractedAt: new Date("2026-11-23T12:00:00Z"), extractedMessageId: "m3" });
assert.equal((persisted as EventDayProgress)?.extractedMessageId, "m3", "A retry can resume after re-reading persisted progress");

// Source wiring checks complement the state model; they do not claim to execute the worker/model.
const worker = readFileSync(new URL("../server/utils/memory-worker.ts", import.meta.url), "utf8");
const daily = worker.slice(worker.indexOf("export async function runDailyEventJob"), worker.indexOf("async function runJournalJob"));
assert.equal((daily.match(/await lockExpectedEventDayProgress\(/g) ?? []).length, 3, "Guard chunks, empty-page finalization, and final status");
assert.ok(daily.indexOf("await lockExpectedEventDayProgress", daily.indexOf("const result = await prisma.$transaction")) < daily.indexOf("await applyMemoryEvents"));
assert.match(daily, /expectedProgress = \{ state: "DRAFT", extractedAt: chunkEnd\.occurredAt, extractedMessageId: chunkEnd\.id \}/);
assert.match(daily, /if \(day\?\.state === "FINAL"\)/);
const scheduler = readFileSync(new URL("../server/utils/memory-scheduler.ts", import.meta.url), "utf8");
assert.equal((scheduler.match(/await enqueueAutomaticEventJobs\(/g) ?? []).length, 2, "Both hourly and final tasks must use the settings-lock protocol");
console.log("PASS memory job concurrency: serialized disable/enqueue, shared progress CAS, terminal FINAL, stale side effects rejected (transactional model, no DB/model/QQ)");
