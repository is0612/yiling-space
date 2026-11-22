import assert from "node:assert/strict";
import { createSessionForVerifiedDesktopOwner, createSessionForVerifiedPassword, hashSessionToken, sessionTtlMs } from "../server/utils/auth";

/**
 * Desktop-owner session issuance, isolated from any database.
 *
 * `getPrisma()` returns the process-wide cached client, so a synthetic client installed here keeps
 * this test off PostgreSQL entirely. No password, token or HTTP route is exercised: the function's
 * contract is that the private desktop control service already verified the OS/owner binding.
 */

type Row = Record<string, unknown>;
type CreatedSession = Record<string, unknown>;
type RecordedQuery = { text: string; values: unknown[] };

let rows: Row[] = [];
const created: CreatedSession[] = [];
const queries: RecordedQuery[] = [];
const userMutations: string[] = [];
let sequence = 0;

const sessionCreate = async (args: { data: Record<string, unknown>; select: { id: true } }) => {
  created.push(args.data);
  sequence += 1;
  return { id: `session-${sequence}` };
};

const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?"), values });
    return rows;
  },
  session: { create: sessionCreate },
};

const fakePrisma = {
  session: { create: sessionCreate },
  $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  user: {
    update: async () => {
      userMutations.push("update");
      return {};
    },
  },
};

(globalThis as unknown as { __yilingPrisma?: unknown }).__yilingPrisma = fakePrisma;

const userId = "11111111-1111-4111-8111-111111111111";
const reset = (nextRows: Row[]) => {
  rows = nextRows;
  created.length = 0;
  queries.length = 0;
  userMutations.length = 0;
  sequence = 0;
};

// 1. Active account: one row lock, one session, token/hash/TTL policy shared with password logins.
reset([{ status: "ACTIVE" }]);
const active = await createSessionForVerifiedDesktopOwner({ userId, userAgent: "YilingDesktop/0.1" });
assert(active, "An ACTIVE account must receive a session.");
assert.match(active.id, /^session-\d+$/, "The internal session id must come back for precise revocation.");
assert.match(active.token, /^[A-Za-z0-9_-]{40,}$/, "Desktop sessions must use opaque base64url tokens.");
assert.equal(active.token.length > 40, true);
assert.equal(created.length, 1);
assert.equal(created[0]?.userId, userId, "Only the requested account may be written.");
assert.equal(created[0]?.tokenHash, hashSessionToken(active.token), "Only the token hash may be stored.");
assert.notEqual(created[0]?.tokenHash, active.token);
assert.equal(created[0]?.ipHash, null, "The desktop path has no client IP to record.");
assert.equal(created[0]?.userAgent, "YilingDesktop/0.1");
const ttl = active.expiresAt.getTime() - Date.now();
assert(Math.abs(ttl - sessionTtlMs()) < 5_000, "Desktop sessions must use the shared TTL policy, not a fixed 90 days.");
assert(queries.length === 1, "One locked read before inserting.");
assert.match(queries[0]!.text, /FROM "users"/u);
assert.match(queries[0]!.text, /FOR UPDATE/u, "The account row must be locked so a concurrent disable is serialised.");
assert.deepEqual(queries[0]!.values, [userId], "The lock must target exactly the requested account.");
assert.equal(userMutations.length, 0, "Issuing a session must not change password, role or status.");

// 2. Disabled or deleted accounts never receive a session.
reset([{ status: "DISABLED" }]);
assert.equal(await createSessionForVerifiedDesktopOwner({ userId }), null);
assert.equal(created.length, 0, "A disabled account must not get a session row.");
reset([]);
assert.equal(await createSessionForVerifiedDesktopOwner({ userId }), null, "A deleted account must not get a session row.");
assert.equal(created.length, 0);

// 3. Malformed ids stop before touching the database.
reset([{ status: "ACTIVE" }]);
assert.equal(await createSessionForVerifiedDesktopOwner({ userId: "not-a-uuid" }), null);
assert.equal(queries.length, 0, "An invalid id must not reach SQL.");
assert.equal(created.length, 0);

// 4. User agents are truncated, not rejected.
reset([{ status: "ACTIVE" }]);
await createSessionForVerifiedDesktopOwner({ userId, userAgent: "x".repeat(400) });
assert.equal(String(created[0]?.userAgent).length, 255);

// 5. Shared policy: TTL still follows AUTH_SESSION_TTL_HOURS instead of a fixed desktop lifetime.
const originalTtl = process.env.AUTH_SESSION_TTL_HOURS;
try {
  process.env.AUTH_SESSION_TTL_HOURS = "30";
  reset([{ status: "ACTIVE" }]);
  const configured = await createSessionForVerifiedDesktopOwner({ userId });
  assert(configured);
  const configuredTtl = configured.expiresAt.getTime() - Date.now();
  assert(Math.abs(configuredTtl - 30 * 60 * 60 * 1000) < 5_000);
} finally {
  if (originalTtl === undefined) delete process.env.AUTH_SESSION_TTL_HOURS;
  else process.env.AUTH_SESSION_TTL_HOURS = originalTtl;
}

// 6. The password path keeps its concurrency check: a mismatched hash still issues nothing.
reset([{ passwordHash: "hash-a", status: "ACTIVE" }]);
const passwordSession = await createSessionForVerifiedPassword({
  userId,
  expectedPasswordHash: "hash-a",
  userAgent: "password-login",
});
assert(passwordSession, "A matching password hash must keep issuing a session.");
assert.equal(created[0]?.userId, userId);
assert.deepEqual(queries[0]!.values, [userId]);

reset([{ passwordHash: "hash-a", status: "ACTIVE" }]);
assert.equal(
  await createSessionForVerifiedPassword({ userId, expectedPasswordHash: "hash-b" }),
  null,
  "A password reset between verification and insert must still block session creation.",
);
assert.equal(created.length, 0, "No session may be written when the stored hash changed.");

reset([{ passwordHash: "hash-a", status: "DISABLED" }]);
assert.equal(await createSessionForVerifiedPassword({ userId, expectedPasswordHash: "hash-a" }), null);
assert.equal(created.length, 0);

reset([]);
assert.equal(await createSessionForVerifiedPassword({ userId, expectedPasswordHash: "hash-a" }), null);

// 7. The password path keeps returning only token/expiresAt, never the internal session id.
reset([{ passwordHash: "hash-a", status: "ACTIVE" }]);
const plain = await createSessionForVerifiedPassword({ userId, expectedPasswordHash: "hash-a" });
assert(plain);
assert.deepEqual(Object.keys(plain).sort(), ["expiresAt", "token"], "The existing return shape must not change.");

delete (globalThis as unknown as { __yilingPrisma?: unknown }).__yilingPrisma;
console.log("Desktop owner session passed: ACTIVE-only issuance, FOR UPDATE lock bound to one user, shared token/hash/TTL policy, truncated user agent, no account mutation, and unchanged password-login concurrency guard; no database or HTTP route was used.");
