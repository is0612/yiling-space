import assert from "node:assert/strict";
import { deleteCharacterCompletely, removeCharacterStickerDirs } from "../server/utils/character-delete";

// Pure mocks only: no dotenv, Prisma client creation, fs calls, or real deletions.
type Dependencies = NonNullable<Parameters<typeof deleteCharacterCompletely>[1]>;
type Database = NonNullable<Dependencies["prisma"]>;
type Transaction = Parameters<Parameters<Database["$transaction"]>[0]>[0];
type Directories = NonNullable<Dependencies["stickerDirectories"]>;
const characterId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const request = { characterId, ownerId };
const safeWarning = "角色已删除，但表情包文件清理未完成，请联系管理员处理。";
const secretError = Object.assign(new Error("D:/private/secret.png token=supersecret"), { code: "EACCES" });

function fixture(options: {
  auditFails?: boolean;
  deleteFails?: boolean;
  updateFails?: boolean;
  statError?: Error;
  rmFailureAt?: number;
  absent?: boolean;
  missing?: boolean;
} = {}) {
  let state = { character: true, related: 5, audit: null as null | Parameters<Transaction["auditLog"]["create"]>[0]["data"] };
  const events: string[] = [];
  const warnings: unknown[] = [];
  const stats: string[] = [];
  const removed: string[] = [];
  const invalidations: string[] = [];
  const database: Database = {
    async $transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
      events.push("transaction");
      const draft = structuredClone(state);
      const deleteMany = (table: string) => ({
        async deleteMany(args: { where: { characterId: string } }) {
          assert.deepEqual(args.where, { characterId });
          events.push(table);
          draft.related--;
          return { count: 1 };
        },
      });
      const tx: Transaction = {
        character: {
          async findFirst({ where }) {
            events.push("ownership");
            assert.equal(where.id, characterId);
            return draft.character && !options.missing && where.ownerId === ownerId ? { name: "测试角色" } : null;
          },
          async delete({ where }) {
            assert.deepEqual(where, { id: characterId, ownerId });
            events.push("delete");
            if (options.deleteFails) throw new Error("database delete failed");
            draft.character = false;
            return {};
          },
        },
        conversation: deleteMany("conversation"),
        memoryScope: deleteMany("scope"),
        chatRequest: deleteMany("requests"),
        groupActivity: deleteMany("activity"),
        onebotGroupAnnouncement: deleteMany("announcements"),
        auditLog: {
          async create({ data }) {
            events.push("audit");
            assert.equal(draft.character, false);
            if (options.auditFails) throw new Error("audit unavailable");
            draft.audit = data;
            return { id: "audit-1" };
          },
        },
      };
      try {
        const result = await run(tx);
        state = draft;
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
    auditLog: {
      async update({ where, data }) {
        events.push("audit-update");
        assert.deepEqual(where, { id: "audit-1" });
        if (options.updateFails) throw secretError;
        assert.ok(state.audit);
        state.audit.details = data.details;
        return {};
      },
    },
  };
  const directories: Directories = {
    async stat(target) {
      assert.ok(events.includes("commit"), "filesystem must run only after commit");
      stats.push(target);
      if (options.statError) throw options.statError;
      if (options.absent) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {};
    },
    async rm(target, args) {
      assert.deepEqual(args, { recursive: true, force: true });
      removed.push(target);
      if (removed.length === options.rmFailureAt) throw secretError;
    },
    invalidate(id) { invalidations.push(id); },
  };
  const dependencies: Dependencies = {
    prisma: database,
    stickerDirectories: directories,
    warn(message, metadata) { warnings.push({ message, metadata }); },
  };
  return { dependencies, events, warnings, stats, removed, invalidations, state: () => state };
}

// Mandatory audit failure rolls back all mock database state and never touches files/cache.
for (const options of [{ auditFails: true }, { deleteFails: true }]) {
  const f = fixture(options);
  await assert.rejects(deleteCharacterCompletely(request, f.dependencies), /audit unavailable|database delete failed/);
  assert.deepEqual(f.state(), { character: true, related: 5, audit: null });
  assert.equal(f.events.at(-1), "rollback");
  assert.deepEqual(f.stats, []);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.invalidations, []);
}

// Success preserves existing audit details and runs cleanup after mandatory audit/commit.
{
  const f = fixture();
  const result = await deleteCharacterCompletely(request, f.dependencies);
  assert.deepEqual(result, {
    id: characterId, name: "测试角色", removedStickerDirs: true,
    purged: { chatRequests: 1, groupActivities: 1, announcements: 1 },
  });
  assert.deepEqual(f.state().audit, {
    actorType: "USER", actorId: ownerId, characterId: null,
    action: "character.deleted", entityType: "Character", entityId: characterId,
    details: { name: "测试角色", chatRequests: 1, groupActivities: 1, announcements: 1, removedStickerDirs: true },
  });
  assert.ok(f.events.indexOf("audit") < f.events.indexOf("commit"));
  assert.equal(f.removed.length, 2);
  assert.deepEqual(f.invalidations, [characterId]);
  assert.deepEqual(f.warnings, []);
}

// Includes partial cleanup: first dir may already be gone when the second rm fails.
for (const options of [{ rmFailureAt: 1 }, { rmFailureAt: 2 }, { statError: secretError }]) {
  const f = fixture(options);
  const result = await deleteCharacterCompletely(request, f.dependencies);
  assert.equal(f.state().character, false);
  assert.ok(f.state().audit, "core audit cannot be skipped on cleanup failure");
  assert.equal(result?.removedStickerDirs, false);
  assert.equal(result?.cleanupWarning, safeWarning);
  assert.equal(f.state().audit?.details.cleanupWarning, safeWarning);
  assert.deepEqual(f.invalidations, [characterId]);
  assert.deepEqual(f.warnings, [{
    message: "[character-delete] 角色删除后的收尾未完成",
    metadata: { characterId, stage: "sticker-cleanup" },
  }]);
  assert.doesNotMatch(JSON.stringify({ result, warnings: f.warnings }), /private|supersecret|EACCES/);
}

// ENOENT means absent; permission and all other stat errors must propagate from directory helper.
{
  const f = fixture({ absent: true });
  const result = await deleteCharacterCompletely(request, f.dependencies);
  assert.equal(result?.removedStickerDirs, false);
  assert.equal(result?.cleanupWarning, undefined);
  assert.equal(f.stats.length, 2);
  assert.equal(f.removed.length, 0);
  assert.deepEqual(f.invalidations, [characterId]);
  assert.deepEqual(f.warnings, []);
}
for (const code of ["EACCES", "EIO", "ENOTDIR", undefined]) {
  let invalidated = 0;
  const error = Object.assign(new Error("stat failed"), { code });
  await assert.rejects(removeCharacterStickerDirs(characterId, {
    async stat() { throw error; },
    async rm() { assert.fail("stat failure must not call rm"); },
    invalidate() { invalidated++; },
  }), (caught) => caught === error);
  assert.equal(invalidated, 1);
}

// Unknown/foreign ownership cannot purge, audit, clean files, or invalidate another character.
for (const [options, args] of [[{ missing: true }, request], [{}, { characterId, ownerId: otherId }]] as const) {
  const f = fixture(options);
  assert.equal(await deleteCharacterCompletely(args, f.dependencies), null);
  assert.deepEqual(f.events, ["transaction", "ownership", "commit"]);
  assert.deepEqual(f.state(), { character: true, related: 5, audit: null });
  assert.deepEqual(f.stats, []);
  assert.deepEqual(f.invalidations, []);
}

// Postcommit audit enrichment is best effort; the committed core audit still exists.
{
  const f = fixture({ updateFails: true });
  const result = await deleteCharacterCompletely(request, f.dependencies);
  assert.equal(result?.removedStickerDirs, true);
  assert.equal(result?.cleanupWarning, undefined);
  assert.equal(f.state().audit?.action, "character.deleted");
  assert.equal(f.state().audit?.details.removedStickerDirs, false);
  assert.deepEqual(f.warnings, [{
    message: "[character-delete] 角色删除后的收尾未完成",
    metadata: { characterId, stage: "audit-cleanup-update" },
  }]);
}
{
  const f = fixture({ rmFailureAt: 1, updateFails: true });
  f.dependencies.warn = () => { throw secretError; };
  const result = await deleteCharacterCompletely(request, f.dependencies);
  assert.equal(result?.cleanupWarning, safeWarning, "logger failures cannot turn committed deletion into failure");
  assert.ok(f.state().audit);
}
await assert.rejects(removeCharacterStickerDirs("../../etc", {
  async stat() { assert.fail("invalid id must not inspect files"); },
  async rm() { assert.fail("invalid id must not delete files"); },
  invalidate() { assert.fail("invalid id must not invalidate unrelated caches"); },
}), /拒绝删除非 uuid 目录/);

console.log("character-delete failure regression: passed (pure mocks; no DB/files modified)");
