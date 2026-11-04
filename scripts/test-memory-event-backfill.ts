import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";
import { localDayKey, resolveDayWindow } from "../server/utils/memory-event-time";

type Scope = { id: string; scopeType: string; userId?: string; scopeKey?: string };
type Message = { scopeId: string; characterId: string; externalId: string | null; occurredAt: Date };
type Job = { memoryScopeId: string; type: string; idempotencyKey: string; status: string; periodStart?: Date; periodEnd?: Date };

// This is deliberately a fake Prisma, not a database integration test. No client is constructed,
// no .env is loaded, and no model/worker is invoked. SQL contract assertions guard its safety
// predicates; the fake models the query's date/anti-join semantics, not PostgreSQL execution.
function fixture(timezone = "Asia/Shanghai") {
  const characterId = "character-a";
  const scopes: Scope[] = [
    { id: "global", scopeType: "CHARACTER_GLOBAL" },
    { id: "owner", scopeType: "USER_PRIVATE", userId: "owner-user" },
    { id: "other-user", scopeType: "USER_PRIVATE", userId: "other-user" },
  ];
  const externalScopes = [
    { id: "friend", scopeKey: "character:a:external:qq-onebot:200" },
    { id: "old-owner", scopeKey: "character:a:external:qq-onebot:100" },
  ];
  const setting = {
    characterId, snapshotIntervalDays: 3, pendingSnapshotIntervalDays: null,
    anchorAt: new Date("2026-01-01T00:00:00Z"), nextSnapshotAt: new Date("2030-01-01T00:00:00Z"),
    autoSnapshotEnabled: true, timezone, rawMessageRetentionDays: 30, rawMessageCleanupEnabled: false,
    character: { ownerId: "owner-user", memoryScopes: scopes,
      channelBindings: [{ connection: { platform: "qq-onebot", metadata: { ownerQq: " 100 " } } }] },
  };
  const messages: Message[] = [];
  const jobs = new Map<string, Job>();
  const finalDays = new Set<string>();
  const queryScopes: string[] = [];
  let externalLookups = 0;
  const fake = {
    characterMemorySetting: { findMany: async (args: { where: unknown }) => {
      assert.deepEqual(args.where, { character: { is: { ownerId: "owner-user" } } });
      return [setting];
    } },
    memoryScope: { findMany: async (args: { where: unknown }) => {
      externalLookups++;
      assert.deepEqual(args.where, { characterId, scopeType: "EXTERNAL_IDENTITY",
        conversations: { some: { externalConversationId: { startsWith: "c:" } } } });
      return externalScopes;
    } },
    // These tests have no recent messages or journal sources; isolate event history scheduling.
    message: { findFirst: async () => null },
    memoryEvent: { findFirst: async () => null },
    characterJournal: { findUnique: async () => null },
    memoryJob: { createMany: async ({ data, skipDuplicates }: { data: Job[]; skipDuplicates: boolean }) => {
      assert.equal(skipDuplicates, true);
      let count = 0;
      for (const job of data) {
        if (jobs.has(job.idempotencyKey)) continue;
        jobs.set(job.idempotencyKey, job);
        count++;
      }
      return { count };
    } },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      characterMemorySetting: { findUnique: async () => ({ ...setting, autoSnapshotEnabled: false }) },
    }),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      assert.match(sql, /c\."memoryScopeId" = \?::uuid/);
      assert.match(sql, /c\."characterId" = \?::uuid/);
      assert.match(sql, /c\."externalConversationId" LIKE 'c:%'/);
      assert.match(sql, /m\."occurredAt" < \?/);
      assert.match(sql, /e\.state = 'FINAL'/);
      assert.match(sql, /j\.type = 'EXTRACT_EVENTS'/);
      assert.match(sql, /'events-final:'/);
      assert.match(sql, /'daily-events:'/);
      assert.doesNotMatch(sql, /j\.status/, "Failed/cancelled jobs must still suppress duplicates");
      assert.ok(sql.indexOf("WHERE NOT EXISTS") < sql.indexOf("LIMIT"), "Exclude handled days before applying cap");
      assert.match(sql, /ORDER BY d\."dayKey" ASC\s+LIMIT \?/);
      const [zone, scopeId, charId, privateOnly, before, dayScope, jobScope, keyScope, legacyScope, limit] = values as
        [string, string, string, boolean, Date, string, string, string, string, number];
      assert.equal(values.length, 10);
      for (const boundScope of [dayScope, jobScope, keyScope, legacyScope]) assert.equal(boundScope, scopeId);
      assert.equal(zone, timezone);
      assert.equal(charId, characterId);
      assert.equal(limit, 24);
      queryScopes.push(scopeId);
      const days = new Set(messages.filter((m) => m.scopeId === scopeId && m.characterId === charId
        && (!privateOnly || m.externalId?.startsWith("c:")) && m.occurredAt < before)
        .map((m) => localDayKey(m.occurredAt, zone)));
      return [...days].filter((day) => !finalDays.has(`${scopeId}:${day}`)
        && !jobs.has(`events-final:${scopeId}:${day}`) && !jobs.has(`daily-events:${scopeId}:${day}`))
        .sort().slice(0, limit).map((dayKey) => ({ dayKey }));
    },
  };
  const prisma = fake as unknown as PrismaClient;
  const now = new Date("2026-11-05T04:00:00Z");
  const run = () => enqueueDueMemorySnapshots(prisma, { now, ownerId: "owner-user" });
  const add = (scopeId: string, day: string, externalId: string | null = null, charId = characterId) => {
    const { start } = resolveDayWindow(day, timezone);
    messages.push({ scopeId, characterId: charId, externalId, occurredAt: new Date(start.getTime() + 3_600_000) });
  };
  const seedJob = (scope: string, day: string, status: string, prefix = "events-final") => {
    const idempotencyKey = `${prefix}:${scope}:${day}`;
    jobs.set(idempotencyKey, { memoryScopeId: scope, type: "EXTRACT_EVENTS", status, idempotencyKey });
  };
  return { setting, jobs, messages, finalDays, queryScopes, run, add, seedJob, get externalLookups() { return externalLookups; } };
}

const history = fixture();
for (let n = 0; n < 60; n++) {
  const day = new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
  history.add("global", day);
  history.add("global", day); // many messages on a day still yield one task
}
assert.equal((await history.run()).jobsQueued, 24, "First round must be bounded");
assert.equal((await history.run()).jobsQueued, 24, "Queued oldest days must not pin the scan window");
assert.equal((await history.run()).jobsQueued, 12, "All dates beyond multiple batches must eventually be queued");
assert.equal((await history.run()).jobsQueued, 0, "Repeated round must be idempotent without worker completion");
assert.equal(history.jobs.size, 60);
history.add("global", "2025-02-01");
assert.equal((await history.run()).jobsQueued, 1, "Late older dates must not be lost behind a high-water cursor");

const states = fixture();
for (const [i, status] of ["QUEUED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"].entries()) {
  const day = `2026-10-${String(i + 1).padStart(2, "0")}`;
  states.add("global", day);
  states.seedJob("global", day, status);
}
states.add("global", "2026-10-08");
states.finalDays.add("global:2026-10-08");
states.add("global", "2026-10-09");
states.seedJob("global", "2026-10-09", "FAILED", "daily-events");
states.add("global", "2026-10-10"); // DRAFT day: hourly jobs must not suppress finalization
states.seedJob("global", "2026-10-10:8", "SUCCEEDED", "events-hour");
states.add("global", "2026-11-04"); // yesterday remains included
states.add("global", "2026-11-05"); // today must not be finalized
states.add("global", "2026-11-06"); // future must not be finalized
assert.equal((await states.run()).jobsQueued, 2);
assert.ok(states.jobs.has("events-final:global:2026-10-10"));
assert.ok(states.jobs.has("events-final:global:2026-11-04"));
assert.ok(!states.jobs.has("events-final:global:2026-10-08"));
assert.ok(!states.jobs.has("events-final:global:2026-11-05"));
assert.ok(!states.jobs.has("events-final:global:2026-11-06"));

const privacy = fixture();
privacy.add("owner", "2026-10-20", "c:100");
privacy.add("friend", "2026-10-21", "c:200");
privacy.add("friend", "2026-10-22", "g:999");
privacy.add("friend", "2026-10-23", null);
privacy.add("friend", "2026-10-24", "c:200", "different-character");
privacy.add("old-owner", "2026-10-25", "c:100");
privacy.add("other-user", "2026-10-26", null);
assert.equal((await privacy.run()).jobsQueued, 2);
assert.deepEqual(privacy.queryScopes, ["global", "owner", "friend"]);
assert.ok(privacy.jobs.has("events-final:owner:2026-10-20"));
assert.ok(privacy.jobs.has("events-final:friend:2026-10-21"));

const disabled = fixture();
disabled.setting.autoSnapshotEnabled = false;
disabled.add("global", "2026-01-01");
assert.equal((await disabled.run()).jobsQueued, 0);
assert.equal(disabled.externalLookups, 0);
assert.deepEqual(disabled.queryScopes, []);

const races = fixture();
races.add("global", "2026-10-01");
const reports = await Promise.all([races.run(), races.run()]);
assert.equal(reports.reduce((sum, report) => sum + report.jobsQueued, 0), 1, "Unique final key must settle concurrent scans");
assert.equal(races.jobs.size, 1);

// Local midnight (not UTC dates), including the 25-hour daylight-saving fall-back day.
const dst = fixture("America/New_York");
dst.messages.push({ scopeId: "global", characterId: "character-a", externalId: null,
  occurredAt: new Date("2026-11-02T04:30:00Z") }); // still Nov 1 locally
await dst.run();
const dstJob = dst.jobs.get("events-final:global:2026-11-01")!;
assert.equal(dstJob.periodStart?.toISOString(), "2026-11-01T04:00:00.000Z");
assert.equal(dstJob.periodEnd?.toISOString(), "2026-11-02T05:00:00.000Z");
assert.equal(dstJob.periodEnd!.getTime() - dstJob.periodStart!.getTime(), 25 * 3_600_000);

console.log("PASS memory event historical backfill: bounded progress, idempotency/states, scope safety, disabled switch, races and timezone/DST (mocked, no DB/model).");
