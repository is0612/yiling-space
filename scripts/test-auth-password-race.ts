import assert from "node:assert/strict";
import { changePassword, hashPassword, hashSessionToken, verifyPassword } from "../server/utils/auth";
import type { PrismaClient } from "../src/generated/prisma/client";

// Exercise the real password service with controlled transaction interleavings.
// No database, HTTP endpoint or model provider is used.
const globals = globalThis as typeof globalThis & { __yilingPrisma?: PrismaClient };
const previous = globals.__yilingPrisma;
const userId = "synthetic-user";
const originalPassword = "original-password-1";
const originalHash = await hashPassword(originalPassword);
const resetHash = await hashPassword("admin-reset-password-2");

type Account = { id: string; status: string; passwordHash: string };
type Session = { tokenHash: string; revokedAt: Date | null };
function harness(options: { beforeTransaction?: (account: Account) => void; failRevoke?: boolean } = {}) {
  const account: Account = { id: userId, status: "ACTIVE", passwordHash: originalHash };
  const sessions: Session[] = ["current", "other"].map(token => ({ tokenHash: hashSessionToken(token), revokedAt: null }));
  let sessionWrites = 0;
  let tail = Promise.resolve();
  const tx = {
    user: {
      // Kept deliberately: a regression to an unconditional update must overwrite the
      // concurrent reset and fail the tests, rather than fail on an absent mock method.
      update: async ({ data }: { data: { passwordHash: string } }) => Object.assign(account, data),
      updateMany: async ({ where, data }: { where: Partial<Account>; data: { passwordHash: string } }) => {
        if (Object.entries(where).some(([key, value]) => account[key as keyof Account] !== value)) return { count: 0 };
        Object.assign(account, data);
        return { count: 1 };
      },
    },
    session: {
      updateMany: async ({ where, data }: { where: { userId: string; tokenHash?: { not: string } }; data: { revokedAt: Date } }) => {
        sessionWrites++;
        if (options.failRevoke) throw new Error("synthetic revocation failure");
        assert.equal(where.userId, userId);
        let count = 0;
        for (const session of sessions) {
          if (!session.revokedAt && session.tokenHash !== where.tokenHash?.not) {
            session.revokedAt = data.revokedAt;
            count++;
          }
        }
        return { count };
      },
    },
  };
  globals.__yilingPrisma = {
    user: { findUnique: async () => ({ ...account }) },
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => {
      // Model the account-row serialization of conditional UPDATE, without timing sleeps.
      const predecessor = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await predecessor;
      options.beforeTransaction?.(account);
      const before = { ...account };
      const beforeSessions = sessions.map(session => ({ ...session }));
      try { return await run(tx); }
      catch (error) {
        Object.assign(account, before);
        sessions.forEach((session, index) => Object.assign(session, beforeSessions[index]!));
        throw error;
      } finally { release(); }
    },
  } as unknown as PrismaClient;
  return { account, sessions, sessionWrites: () => sessionWrites };
}
const changedCredentials = (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 400);
const change = (newPassword = "next-password-3", currentToken: string | undefined = "current") => changePassword({
  userId, currentPassword: originalPassword, newPassword, currentToken,
});
try {
  const reset = harness({ beforeTransaction: account => { account.passwordHash = resetHash; } });
  await assert.rejects(change(), changedCredentials);
  assert.equal(reset.account.passwordHash, resetHash, "a verified old password cannot overwrite an intervening admin reset");
  assert.equal(reset.sessionWrites(), 0, "stale change must not revoke sessions belonging to the new credentials");

  const disabled = harness({ beforeTransaction: account => { account.status = "DISABLED"; } });
  await assert.rejects(change(), changedCredentials);
  assert.equal(disabled.account.passwordHash, originalHash);
  assert.equal(disabled.account.status, "DISABLED");
  assert.equal(disabled.sessionWrites(), 0);

  const concurrent = harness();
  const results = await Promise.allSettled([change("first-password-4"), change("second-password-5")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "two changes verified against one old password must have one winner");
  const loser = results.find(result => result.status === "rejected");
  assert(loser?.status === "rejected" && changedCredentials(loser.reason));
  assert.equal(concurrent.sessionWrites(), 1);

  const success = harness();
  assert.deepEqual(await change(), { revokedSessions: 1 });
  assert(await verifyPassword("next-password-3", success.account.passwordHash));
  assert.equal(success.sessions[0]!.revokedAt, null, "the initiating session stays valid");
  assert(success.sessions[1]!.revokedAt instanceof Date);

  const rollback = harness({ failRevoke: true });
  await assert.rejects(change(), /synthetic revocation failure/);
  assert.equal(rollback.account.passwordHash, originalHash, "revocation failure rolls back the password write");
  assert(rollback.sessions.every(session => session.revokedAt === null));

  const invalid = harness();
  await assert.rejects(changePassword({ userId, currentPassword: "wrong-password", newPassword: "next-password-3" }), changedCredentials);
  assert.equal(invalid.sessionWrites(), 0);
  assert.equal(invalid.account.passwordHash, originalHash);
  console.log("Password changes: intervening reset/disable, concurrent changes, session preservation and rollback passed (mock transactions only).");
} finally {
  if (previous) globals.__yilingPrisma = previous;
  else delete globals.__yilingPrisma;
}
