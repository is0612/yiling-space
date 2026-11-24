import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

// Execute the actual endpoint with controlled transaction/row-lock doubles. This is an
// offline handler regression, not a PostgreSQL lock reproduction; no .env is loaded.
const source = readFileSync(new URL("../server/api/admin/users/[id].patch.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
type Account = { id: string; role: string; status: string; displayName?: string; passwordHash?: string };
type Request = { actorId: string; targetId: string; body: Record<string, unknown> };
type Update = { where: { id: string }; data: Partial<Account> };
const account = (id: string, role = "ADMIN", status = "ACTIVE"): Account => ({ id, role, status });
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";
function harness(initial: Account[], options: { failRevoke?: boolean; concurrentActors?: number } = {}) {
  const users = new Map(initial.map(row => [row.id, { ...row }]));
  const revoked = new Set<string>();
  const audit: unknown[] = [];
  const trace: string[] = [];
  let lockTail = Promise.resolve();
  let arrivals = 0;
  let releaseActors!: () => void;
  const actorsReady = new Promise<void>(resolve => { releaseActors = resolve; });
  const findUnique = async ({ where }: { where: { id: string } }) => {
    const row = users.get(where.id);
    return row ? { ...row } : null;
  };
  const count = async ({ where }: { where: { id: { not: string } } }) =>
    [...users.values()].filter(row => row.role === "ADMIN" && row.status === "ACTIVE" && row.id !== where.id.not).length;
  const prisma = {
    // Deliberately retain old outside-transaction reads so regressions fail on the invariant.
    user: { findUnique, count },
    auditLog: { create: async (entry: unknown) => { audit.push(entry); } },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      let locked = false;
      let unlock: (() => void) | undefined;
      const undo = new Map<string, Account>();
      const revokedBefore = new Set(revoked);
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join("?");
          assert.match(sql, /WHERE\s+"role"\s*=\s*'ADMIN'/i);
          assert.match(sql, /ORDER BY\s+"id"\s+FOR UPDATE/i, "all disables must lock administrators in a fixed order");
          assert.doesNotMatch(sql, /ACTIVE|"status"/i, "inactive ADMIN rows must also belong to the lock set");
          const predecessor = lockTail;
          lockTail = new Promise<void>(resolve => { unlock = resolve; });
          await predecessor;
          locked = true;
          trace.push("lock");
          return [...users.values()].filter(row => row.role === "ADMIN").map(row => ({ id: row.id }));
        },
        user: {
          findUnique: async (input: { where: { id: string } }) => {
            trace.push(locked ? "read-after-lock" : "read");
            return findUnique(input);
          },
          count: async (input: { where: { id: { not: string } } }) => {
            assert(locked, "last-admin count must occur while holding the transaction lock");
            assert.equal(trace.at(-1), "read-after-lock", "target must be refreshed after acquiring the lock");
            trace.push("count");
            return count(input);
          },
          update: async ({ where, data }: Update) => {
            const row = users.get(where.id);
            assert(row);
            if (data.status === "DISABLED" && row.role === "ADMIN") assert(locked);
            undo.set(row.id, { ...row });
            Object.assign(row, data);
            trace.push("update");
            return { ...row };
          },
        },
        session: { updateMany: async ({ where }: { where: { userId: string } }) => {
          if (options.failRevoke) throw new Error("synthetic revoke failure");
          revoked.add(where.userId);
          return { count: 1 };
        } },
      };
      try { return await run(tx); }
      catch (error) {
        for (const [id, row] of undo) users.set(id, row);
        if (undo.size) {
          revoked.clear();
          for (const id of revokedBefore) revoked.add(id);
        }
        throw error;
      } finally { unlock?.(); }
    },
  };
  const dependencies: Record<string, unknown> = {
    h3: {
      createError: (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input),
      getRouterParam: (event: Request) => event.targetId,
      readBody: async (event: Request) => event.body,
    },
    "../../../utils/auth": {
      requireAdminActor: async (event: Request) => {
        const actor = users.get(event.actorId);
        assert(actor?.role === "ADMIN" && actor.status === "ACTIVE");
        // Both requests finish authentication before either can enter its transaction.
        arrivals++;
        if (arrivals >= (options.concurrentActors ?? 1)) releaseActors();
        await actorsReady;
        return { user: { ...actor } };
      },
      hashPassword: async (password: string) => `synthetic-hash:${password}`,
      checkPasswordPolicy: () => ({ ok: true }),
      passwordPolicyMessage: () => "invalid password",
    },
    "../../../utils/local-api": {
      requireUuid: (value: string) => value,
      readTrimmedString: (value: unknown) => typeof value === "string" ? value.trim() : "",
    },
    "../../../utils/prisma": { getPrisma: () => prisma },
  };
  const exports: { default?: (event: Request) => Promise<unknown> } = {};
  new Script(compiled).runInNewContext({
    exports,
    require: (name: string) => {
      assert(name in dependencies, `unexpected handler dependency: ${name}`);
      return dependencies[name];
    },
    defineEventHandler: (handler: unknown) => handler,
  });
  assert(exports.default);
  return { users, revoked, audit, trace, run: exports.default };
}
const is400 = (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 400;
const disable = (actorId: string, targetId: string): Request => ({ actorId, targetId, body: { status: "DISABLED" } });

{
  const h = harness([account(a), account(b)], { concurrentActors: 2 });
  const results = await Promise.allSettled([h.run(disable(a, b)), h.run(disable(b, a))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "cross-disables must have exactly one winner");
  const loser = results.find(result => result.status === "rejected");
  assert(loser?.status === "rejected" && is400(loser.reason));
  assert.equal([...h.users.values()].filter(row => row.status === "ACTIVE").length, 1);
  assert.equal(h.revoked.size, 1);
  assert.equal(h.audit.length, 1);
  assert.equal(h.trace.filter(entry => entry === "lock").length, 2);
}
{
  const h = harness([account(a), account(b), account(c, "ADMIN", "DISABLED")], { concurrentActors: 2 });
  const results = await Promise.allSettled([h.run(disable(a, b)), h.run(disable(b, a))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "disabled ADMIN rows cannot count as working administrators");
  const loser = results.find(result => result.status === "rejected");
  assert(loser?.status === "rejected" && is400(loser.reason));
}
{
  const h = harness([account(a)]);
  await assert.rejects(h.run(disable(a, a)), is400);
  assert.equal(h.users.get(a)?.status, "ACTIVE");
  assert.equal(h.revoked.size, 0);
  assert.equal(h.audit.length, 0);
}
{
  const h = harness([account(a), account(b, "USER")]);
  await h.run(disable(a, b));
  assert.equal(h.users.get(b)?.status, "DISABLED");
  assert(h.revoked.has(b));
  assert(!h.trace.includes("lock"), "ordinary user disables need no ADMIN collection lock");
  await h.run({ actorId: a, targetId: b, body: { status: "ACTIVE" } });
  assert.equal(h.users.get(b)?.status, "ACTIVE");
  assert(h.revoked.has(b), "re-enabling does not restore old sessions");
}
{
  const h = harness([account(a), account(b)]);
  await h.run({ actorId: a, targetId: b, body: { displayName: "Updated", password: "new-password-1" } });
  assert.equal(h.users.get(b)?.displayName, "Updated");
  assert.equal(h.users.get(b)?.passwordHash, "synthetic-hash:new-password-1");
  assert(h.revoked.has(b));
  assert(!h.trace.includes("lock"), "ADMIN profile/password updates need no collection lock");
}
{
  const h = harness([account(a), account(b)], { failRevoke: true });
  await assert.rejects(h.run(disable(a, b)), /synthetic revoke failure/);
  assert.equal(h.users.get(b)?.status, "ACTIVE");
  assert.equal(h.revoked.size, 0);
  assert.equal(h.audit.length, 0);
}
{
  const h = harness([account(a)]);
  await assert.rejects(h.run(disable(a, b)), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 404);
  assert.equal(h.audit.length, 0);
}
console.log("Admin disables: controlled cross-disable race, last-admin/self guards, ordinary updates and rollback passed (offline handler mocks; no PostgreSQL lock verification).");
