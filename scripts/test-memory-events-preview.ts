import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../src/generated/prisma/client";
import { previewMemoryEvents } from "../server/utils/memory-events-preview";

const now = new Date("2026-11-09T08:00:00Z");
const options = { ownerId: "owner", characterId: "character", now };
function fixture() {
  const queries: Array<{ scope: string; where: Record<string, unknown> }> = [];
  const days: Array<Record<string, unknown>> = [];
  const jobs: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = { global: 3, private: 2, external: 4 };
  let forbidden = false;
  let noGlobal = false;
  let many = false;
  let legacyOwner = true;
  const mock = {
    character: { findFirst: async (query: { where: unknown }) => {
      assert.deepEqual(query.where, { id: "character", ownerId: "owner" });
      return forbidden ? null : { id: "character", name: "测试角色", ownerId: "owner", memorySetting: { timezone: "Asia/Shanghai" }, memoryScopes: [
        ...(!noGlobal ? [{ id: "global", scopeType: "CHARACTER_GLOBAL", userId: null }] : []),
        { id: "private", scopeType: "USER_PRIVATE", userId: "owner" },
        { id: "someone-else", scopeType: "USER_PRIVATE", userId: "other" },
      ] };
    } },
    characterChannelBinding: { findMany: async () => [{ connection: { metadata: { ownerQq: "123456789" } } }] },
    memoryScope: { findMany: async () => [
      { id: "external", scopeKey: "qq:external:987654321" },
      { id: "old-owner", scopeKey: "character:character:external:qq-onebot:123456789" },
    ] },
    memoryEventDay: { findMany: async () => days },
    memoryJob: { findMany: async () => jobs },
    message: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        const scope = ((where.conversation as { is: { memoryScopeId: string } }).is).memoryScopeId;
        assert(!["old-owner", "someone-else"].includes(scope));
        queries.push({ scope, where });
        return many ? 120 : counts[scope]!;
      },
      groupBy: async (query: { where: Record<string, unknown>; take: number }) => {
        const scope = (query.where.conversation as { is: { memoryScopeId: string } }).is.memoryScopeId;
        return Array.from({ length: many ? Math.min(120, query.take) : 1 }, (_, i) => ({ conversationId: `${scope}-${i}`, _count: { _all: many ? 1 : counts[scope] } }));
      },
    },
    conversation: {
      findFirst: async () => legacyOwner ? { id: "legacy-owner" } : null,
      findMany: async () => [{ id: "global-0", title: "群聊测试", externalConversationId: "g:123" }],
    },
  };
  return { prisma: mock as unknown as PrismaClient, queries, days, jobs, counts,
    forbid: () => { forbidden = true; }, noGlobal: () => { noGlobal = true; }, many: () => { many = true; },
    noLegacy: () => { legacyOwner = false; } };
}
const f = fixture();
const result = await previewMemoryEvents(f.prisma, options);
assert.equal(result.totalMessages, 18);
assert.equal(result.rows.length, 6);
assert.equal(result.truncated, false);
assert.equal(result.checkedAt, now.toISOString());
assert.equal(result.rows[0]?.conversationLabel, "群聊测试");
assert.match(result.notice!, /预览不含待归位主人的旧私聊/);
assert.equal(result.hasLegacyOwnerChats, true);
assert.deepEqual(Object.keys(result).sort(), ["characterId", "characterName", "timeZone", "checkedAt", "totalMessages", "rows", "truncated", "hasLegacyOwnerChats", "notice"].sort());
assert.deepEqual(Object.keys(result.rows[0]!).sort(), ["key", "dayKey", "conversationLabel", "scopeLabel", "pendingMessages"].sort());
assert(f.queries.filter(q => q.scope === "external").every(q => JSON.stringify(q.where).includes('"startsWith":"c:"')));
const cursor = fixture();
cursor.days.push({ memoryScopeId: "global", dayKey: "2026-11-08", state: "FINAL", extractedAt: new Date("2026-11-08T10:00:00Z"), extractedMessageId: "cursor" });
await previewMemoryEvents(cursor.prisma, options);
assert.match(JSON.stringify(cursor.queries[0]?.where), /cursor/);
assert.equal(cursor.queries.length, 6, "FINAL yesterday is still readable when final job can be newly queued");
const finished = fixture();
finished.jobs.push({ idempotencyKey: "events-final:global:2026-11-08", status: "SUCCEEDED", lockedAt: null });
finished.days.push({ memoryScopeId: "private", dayKey: "2026-11-09", state: "FINAL", extractedAt: null });
finished.jobs.push({ idempotencyKey: "events-hour:external:2026-11-09:16", status: "RUNNING", lockedAt: now });
const completed = await previewMemoryEvents(finished.prisma, options);
assert.equal(completed.totalMessages, 9, "completed final, finalized today and actively claimed task are not startable");
assert.match(completed.notice!, /正在运行/);
finished.jobs[1] = { idempotencyKey: "events-hour:external:2026-11-09:16", status: "RUNNING", lockedAt: new Date(now.getTime() - 6 * 60_000) };
assert.equal((await previewMemoryEvents(finished.prisma, options)).totalMessages, 13, "expired running lease can be reclaimed by POST");
const large = fixture(); large.many();
const bounded = await previewMemoryEvents(large.prisma, options);
assert.equal(bounded.rows.length, 100);
assert.equal(bounded.totalMessages, 720, "row limit must not truncate total count");
assert.equal(bounded.truncated, true);
const normal = fixture(); normal.noLegacy();
const ordinary = await previewMemoryEvents(normal.prisma, options);
assert.equal(ordinary.hasLegacyOwnerChats, false);
assert.equal(ordinary.notice, null, "configured owner QQ alone must not imply legacy chats");
const denied = fixture(); denied.forbid();
await assert.rejects(previewMemoryEvents(denied.prisma, options), { statusCode: 404 });
assert.equal(denied.queries.length, 0);
const noScope = fixture(); noScope.noGlobal();
await assert.rejects(previewMemoryEvents(noScope.prisma, options), { statusCode: 409 });
const route = readFileSync(new URL("../server/api/characters/[id]/memory-events/preview.get.ts", import.meta.url), "utf8");
assert.match(route, /await requireActorUserId\(event\)/);
assert.match(route, /requireUuid\(getRouterParam/);
console.log("Memory event preview mock tests passed: owner isolation, target scopes, cursor/FINAL/lease rules, bounded rows with full counts, read-only dependencies and route guards.");
