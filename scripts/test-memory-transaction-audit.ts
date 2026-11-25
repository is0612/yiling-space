import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import { createError } from "h3";
import type { PrismaClient } from "../src/generated/prisma/client";
import { applyStaleMemories } from "../server/utils/stale-memory-apply";
import { staleMemoryFingerprint, staleEventFingerprint, requireStaleFingerprint } from "../server/utils/stale-memory-version";
import { eventCandidate, memoryCandidate, parseStaleAudit } from "../server/utils/stale-memory-parse";
import { createMemoryApi } from "../app/api/memory";
import { memoryAuditContentSummary } from "../server/utils/memory-audit-summary";
import { localDayKey } from "../server/utils/memory-event-time";

// Actual handler bodies run with injected auth/database. No env, database, HTTP or model.
function load(relative: string, globals: Record<string, unknown>, names = "handler") {
  const text = readFileSync(new URL(relative, import.meta.url), "utf8");
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map(node => node.getText(source)).join("\n").replace(/export default /g, "const handler = ").replace(/\bexport /g, "");
  const output = ts.transpileModule(`(function() { ${body}\n return { ${names} }; })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Script(output).runInContext(createContext({ ...globals, Date, Map, Set }));
}
const ownerId = "11111111-1111-4111-8111-111111111111";
const characterId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const privateBefore = "PRIVATE_MEMORY_BEFORE_SENTINEL";
const privateAfter = "PRIVATE_MEMORY_AFTER_SENTINEL";
const initialMemory = { id: memoryId, memoryScopeId: "scope", memoryScope: { characterId }, category: "FACT", content: privateBefore, importance: 0.6, status: "ACTIVE", deletedAt: null as Date | null, statusBeforeTrash: null as string | null, updatedAt: new Date(), validTo: null };
const initialEvent = { id: eventId, memoryScopeId: "scope", dayKey: "2026-11-24", title: "event", detail: "old event detail", participants: ["friend"], status: "ACTIVE" };

type State = { memory: typeof initialMemory | null; event: typeof initialEvent | null; audits: Array<Record<string, any>> };
function database(options: { failAudit?: boolean; beforeLock?: (state: State) => void } = {}) {
  let state: State = { memory: structuredClone(initialMemory), event: structuredClone(initialEvent), audits: [] };
  const order: string[] = [];
  const prisma = {
    $transaction: async (run: (tx: any) => Promise<unknown>) => {
      const draft = structuredClone(state);
      let firstLock = true;
      const delegate = (key: "memory" | "event") => ({
        findFirst: async () => { order.push(`read:${key}`); return structuredClone(draft[key]); },
        findMany: async ({ where }: any) => {
          order.push(`read:${key}`);
          const row = draft[key];
          return row && where.id.in.includes(row.id) && row.status === where.status ? [row] : [];
        },
        update: async ({ data }: any) => { order.push(`write:${key}`); Object.assign(draft[key]!, data); return draft[key]; },
        delete: async () => { order.push(`delete:${key}`); draft[key] = null; },
      });
      const tx = {
        $queryRaw: async (parts: TemplateStringsArray, id: string) => {
          if (firstLock) { firstLock = false; options.beforeLock?.(draft); }
          if (parts.join("").includes("AND c.id")) {
            assert.match(parts.join(""), /[me]\.status = 'ACTIVE'/, "batch apply must not lock trashed/archived rows");
          }
          order.push(`lock:${parts.join("").includes("memory_items") ? "MEMORY" : "EVENT"}:${id}`);
          return [{ id }];
        },
        memoryItem: delegate("memory"), memoryEvent: delegate("event"),
        memorySnapshotSource: { count: async () => 2 },
        auditLog: { create: async ({ data }: any) => {
          order.push("audit");
          if (options.failAudit) throw new Error("injected audit failure");
          draft.audits.push(data);
          return { id: "audit" };
        } },
      };
      const result = await run(tx);
      state = draft;
      return result;
    },
  };
  return { prisma: prisma as unknown as PrismaClient, state: () => state, order };
}
function globals(prisma: PrismaClient, body: unknown = {}) {
  return {
    createError, memoryAuditContentSummary, defineEventHandler: (handler: unknown) => handler,
    requireActorUserId: async () => ownerId, requireUuid: (id: string) => id,
    getRouterParam: (_event: unknown, key: string) => key === "id" ? memoryId : characterId,
    readBody: async () => body, readTrimmedString: (value: string) => value.trim(), getPrisma: () => prisma,
    readableMemoryScopeSql: () => true, readableMemoryScopeWhere: () => ({}),
  };
}
const actions = [
  { file: "../server/api/memories/[id].patch.ts", body: { content: privateAfter }, action: "memory.updated", from: "ACTIVE", to: "ACTIVE" },
  { file: "../server/api/memories/[id]/trash.post.ts", body: {}, action: "memory.trashed", from: "ACTIVE", to: "TRASHED" },
  { file: "../server/api/memories/[id]/restore.post.ts", body: {}, action: "memory.restored", from: "TRASHED", to: "ARCHIVED" },
  { file: "../server/api/memories/[id].delete.ts", body: {}, action: "memory.deleted", from: "TRASHED", to: null },
];
for (const spec of actions) {
  for (const failAudit of [false, true]) {
    const db = database({ failAudit });
    Object.assign(db.state().memory!, { status: spec.from, statusBeforeTrash: "ARCHIVED" });
    const before = structuredClone(db.state());
    const { handler } = load(spec.file, globals(db.prisma, spec.body));
    if (failAudit) {
      await assert.rejects(handler({}), /injected audit failure/);
      assert.deepEqual(db.state(), before, `${spec.action}: audit failure rolls back mutation`);
    } else {
      await handler({});
      assert.equal(db.state().audits.length, 1);
      const audit = db.state().audits[0]!;
      assert.equal(audit.actorId, ownerId);
      assert.equal(audit.characterId, characterId);
      assert.equal(audit.entityId, memoryId);
      assert.equal(audit.action, spec.action);
      assert.equal(audit.details.before.status, spec.from);
      assert.equal(audit.details.after?.status ?? null, spec.to);
      if (spec.action === "memory.updated") {
        assert.equal(audit.details.before.contentHash, memoryAuditContentSummary(privateBefore).contentHash);
        assert.equal(audit.details.after.contentHash, memoryAuditContentSummary(privateAfter).contentHash);
        assert.equal(audit.details.before.contentLength, privateBefore.length);
        assert.equal(audit.details.after.contentLength, privateAfter.length);
        assert.notEqual(audit.details.before.contentHash, audit.details.after.contentHash);
      }
      if (spec.action === "memory.deleted") assert.equal(audit.details.preservedSnapshotReferences, 2);
      const serializedAudits = JSON.stringify(db.state().audits);
      assert.equal(serializedAudits.includes(privateBefore), false, "global audit must not copy the old private memory body");
      assert.equal(serializedAudits.includes(privateAfter), false, "global audit must not copy the new private memory body");
      if (spec.action === "memory.deleted") {
        assert.equal(audit.details.before.contentHash, memoryAuditContentSummary(privateBefore).contentHash);
        assert.equal(audit.details.before.contentLength, privateBefore.length);
      }
      assert.ok(db.order[0]!.startsWith("lock:"));
    }
  }
}

const input = { ownerId, characterId, items: [
  { kind: "MEMORY" as const, id: memoryId, fingerprint: staleMemoryFingerprint(initialMemory) },
  { kind: "EVENT" as const, id: eventId, fingerprint: staleEventFingerprint(initialEvent) },
] };
const db = database();
assert.deepEqual(await applyStaleMemories(db.prisma, input), { memory: 1, event: 1 });
assert.deepEqual(db.order.slice(0, 2), [`lock:EVENT:${eventId}`, `lock:MEMORY:${memoryId}`]);
assert.equal(db.state().memory!.status, "INVALIDATED");
assert.equal(db.state().event!.status, "ARCHIVED");
assert.equal(db.state().audits.length, 2);

// A competing transaction commits before our row lock is acquired. Read after
// that lock must reject the newer state instead of resurrecting a trashed item.
for (const change of [
  (state: State) => { state.memory!.status = "TRASHED"; },
  (state: State) => { state.memory!.content = "corrected valid fact"; },
  (state: State) => { state.memory!.updatedAt = new Date("2026-11-25T00:00:00Z"); },
  (state: State) => { state.event!.status = "ARCHIVED"; },
  (state: State) => { state.event!.detail = "corrected event"; },
  (state: State) => { state.memory!.memoryScopeId = "different-scope"; },
]) {
  const changed = database({ beforeLock: change });
  await assert.rejects(applyStaleMemories(changed.prisma, input), (error: any) => error.statusCode === 409);
  assert.equal(changed.order.some(entry => entry.startsWith("write:")), false, "validate the entire batch before writing");
  assert.equal(changed.state().audits.length, 0);
}
const failed = database({ failAudit: true });
await assert.rejects(applyStaleMemories(failed.prisma, input), /injected audit failure/);
assert.equal(failed.state().memory!.status, "ACTIVE");
assert.equal(failed.state().event!.status, "ACTIVE");
assert.equal(failed.state().audits.length, 0);

// Scan executes the actual enrichment code with fake model and repositories.
const scanGlobals = { readableMemoryScopeWhere: () => ({}),
  createError, staleMemoryFingerprint, staleEventFingerprint, memoryCandidate, eventCandidate, parseStaleAudit,
  // 角色时区的「今天」既做提示词锚点也算忆泡区间右端；源码里是 import，注入时要在场。
  localDayKey,
  resolveChatModelSettings: () => ({ model: "mock" }), resolveCharacterApiKey: async () => "fake",
  readDailyQuota: async () => ({ exceeded: false }), recordModelUsage: async () => {},
  callRawModel: async () => '{"items":[{"id":"M1","verdict":"CONTRADICTED","reason":"changed","confidence":0.9},{"id":"E1","verdict":"CONTRADICTED","reason":"changed","confidence":0.9}]}',
};
const longMemory = { ...initialMemory, content: "x".repeat(300) + "full suffix" };
const scanPrisma = {
  character: { findFirst: async () => ({ modelConfig: {} }) },
  memoryItem: { count: async () => 1, findMany: async () => [longMemory] },
  memoryEvent: { count: async () => 1, findMany: async () => [initialEvent] },
};
const { scanStaleMemories } = load("../server/utils/stale-memory-audit.ts", scanGlobals, "scanStaleMemories");
const scan = await scanStaleMemories(scanPrisma, { ownerId, characterId, scopes: ["MEMORY", "EVENT"] });
assert.equal(scan.items.length, 2);
assert.equal(scan.items[0].fingerprint, staleMemoryFingerprint(longMemory));
assert.notEqual(scan.items[0].fingerprint, staleMemoryFingerprint({ ...longMemory, content: scan.items[0].content }));
assert.equal(scan.items[1].fingerprint, staleEventFingerprint(initialEvent));

for (const fingerprint of [undefined, "", "x".repeat(64)]) {
  const { handler } = load("../server/api/characters/[id]/memory-audit/apply.post.ts", {
    ...globals(db.prisma, { items: [{ kind: "MEMORY", id: memoryId, fingerprint }] }),
    requireStaleFingerprint, applyStaleMemories: () => { throw new Error("must not apply invalid fingerprint"); },
  });
  await assert.rejects(handler({}), (error: any) => error.statusCode === 400);
}
const sent: any[] = [];
const api = createMemoryApi((async (value: any) => { sent.push(value); return { memory: 1, event: 0 }; }) as any);
await api.applyStaleMemories({ characterId, items: input.items });
assert.equal(sent[0].data.items[0].fingerprint, input.items[0]!.fingerprint);
console.log("memory transaction audit: mock lifecycle rollback, batch locks/version checks, scan and API fingerprints passed");
