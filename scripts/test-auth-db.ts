import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  changePassword,
  countRecentLoginFailures,
  createSession,
  hashClientAddress,
  hashPassword,
  hashSessionToken,
  listSessions,
  recordLoginAttempt,
  resolveSessionUser,
  revokeExpiredSessions,
  revokeOtherSessions,
  revokeSessionByToken,
  revokeSessionForUser,
  verifyPassword,
} from "../server/utils/auth";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，认证数据库测试无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = randomUUID();
const username = `auth-test-${suffix}`;
const bruteForceName = `auth-bruteforce-${suffix}`;
const intruderName = `auth-intruder-${suffix}`;
const ip = "127.0.0.1";
const initialPassword = "integration-test-password";
let userId = "";
let intruderId = "";

function expectStatus(fn: () => Promise<unknown>, statusCode: number) {
  return fn().then(
    () => assert.fail("Expected the call to throw status " + statusCode + "."),
    (error: { statusCode?: number }) => assert.equal(error.statusCode, statusCode),
  );
}

try {
  const user = await prisma.user.create({
    data: { username, passwordHash: await hashPassword(initialPassword), displayName: "认证测试", role: "ADMIN" },
    select: { id: true },
  });
  userId = user.id;

  // 1. A created session resolves back to its user.
  const session = await createSession({ userId, ip, userAgent: "auth-db-test" });
  const resolved = await resolveSessionUser(session.token);
  assert.equal(resolved?.id, userId, "A freshly created session must resolve to its user.");
  assert.equal(resolved?.role, "ADMIN", "A session must carry the account role.");
  assert.equal(await resolveSessionUser("not-a-real-token"), null, "Unknown tokens must not resolve.");

  // 2. Only the hashed token is stored.
  const storedSession = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(session.token) },
    select: { tokenHash: true },
  });
  assert(storedSession && storedSession.tokenHash !== session.token, "The database must not store the raw session token.");
  assert.equal(storedSession?.tokenHash, hashSessionToken(session.token));

  // 3. Expired sessions stop resolving.
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(session.token) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(await resolveSessionUser(session.token), null, "Expired sessions must not authenticate.");

  // 4. Active sessions refresh lastUsedAt when it is stale, and revocation is one-way.
  const second = await createSession({ userId, ip });
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(second.token) },
    data: { lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
  assert.equal((await resolveSessionUser(second.token))?.id, userId);
  const touched = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(second.token) },
    select: { lastUsedAt: true },
  });
  assert(touched && Date.now() - touched.lastUsedAt.getTime() < 60_000, "A stale session should have lastUsedAt refreshed.");
  assert.equal(await revokeSessionByToken(second.token), true, "Revoking an active session must report a change.");
  assert.equal(await resolveSessionUser(second.token), null, "Revoked sessions must not authenticate.");
  assert.equal(await revokeSessionByToken(second.token), false, "Revoking twice must not report a second change.");

  // 5. Disabled accounts cannot authenticate even with a valid session.
  const third = await createSession({ userId, ip });
  await prisma.user.update({ where: { id: userId }, data: { status: "DISABLED" } });
  assert.equal(await resolveSessionUser(third.token), null, "Disabled users must not authenticate.");
  await prisma.user.update({ where: { id: userId }, data: { status: "ACTIVE" } });
  assert.equal((await resolveSessionUser(third.token))?.id, userId, "Re-enabling the account restores existing sessions.");

  // 6. Expired session cleanup removes only old rows.
  const stale = await createSession({ userId, ip });
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(stale.token) },
    data: { expiresAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
  });
  const removed = await revokeExpiredSessions();
  assert(removed >= 1, "Cleanup must delete sessions expired long ago.");
  assert.equal((await resolveSessionUser(third.token))?.id, userId, "Cleanup must keep sessions that are still valid.");

  // 7. Login throttling counters come from the database.
  const before = await countRecentLoginFailures({ username: bruteForceName, ip });
  assert.equal(before.userFailures, 0);
  await recordLoginAttempt({ username: bruteForceName, ip, succeeded: false });
  await recordLoginAttempt({ username: bruteForceName, ip, succeeded: false });
  const afterFailures = await countRecentLoginFailures({ username: bruteForceName, ip });
  assert.equal(afterFailures.userFailures, 2, "Failed attempts must be counted per username.");
  assert(afterFailures.ipFailures >= 2, "Failed attempts must also be counted per client address.");
  await recordLoginAttempt({ username: bruteForceName, ip, succeeded: true });
  const afterSuccess = await countRecentLoginFailures({ username: bruteForceName, ip });
  assert.equal(afterSuccess.userFailures, 0, "A successful login clears that account's failure history.");

  // 8. The stored client address is a hash, never the raw IP.
  const attempt = await prisma.loginAttempt.findFirst({ where: { username: bruteForceName }, select: { ipHash: true } });
  assert(attempt && attempt.ipHash === hashClientAddress(ip), "Login attempts must store a hashed client address.");
  assert.notEqual(attempt?.ipHash, ip, "The raw client address must not be stored.");

  // 9. The device list marks the requesting session and never exposes token hashes.
  const fourth = await createSession({ userId, ip, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" });
  const listed = await listSessions({ userId, currentToken: fourth.token });
  assert.equal(listed.length, 2, "The device list must contain both active sessions.");
  assert.equal(listed.filter((entry) => entry.current).length, 1, "Exactly one session must be marked as current.");
  assert.equal(listed.find((entry) => entry.current)?.device.label, "Windows · Chrome");
  assert.equal(
    listed.find((entry) => !entry.current)?.device.label,
    "未知设备",
    "Sessions created without a User-Agent must fall back to the unknown-device label.",
  );
  for (const entry of listed) {
    assert.equal("tokenHash" in entry, false, "The device list must not expose token hashes.");
  }

  // 10. A session id belonging to another account cannot be revoked.
  const intruder = await prisma.user.create({
    data: { username: intruderName, passwordHash: await hashPassword(initialPassword) },
    select: { id: true },
  });
  intruderId = intruder.id;
  const intruderSession = await createSession({ userId: intruderId, ip });
  const intruderSessionId = (await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(intruderSession.token) },
    select: { id: true },
  }))?.id ?? "";
  assert.equal(
    await revokeSessionForUser({ userId, sessionId: intruderSessionId, currentToken: fourth.token }),
    "not_found",
    "Another account's session must look missing, not revocable.",
  );
  assert.equal((await resolveSessionUser(intruderSession.token))?.id, intruderId, "The foreign session must survive the attempt.");
  assert.equal(
    (await resolveSessionUser(intruderSession.token))?.role,
    "USER",
    "Accounts created without an explicit role must default to USER.",
  );

  // 11. Revoking your own session is reported as such, so the caller can clear the cookie.
  const ownSessionId = (await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(fourth.token) },
    select: { id: true },
  }))?.id ?? "";
  assert.equal(
    await revokeSessionForUser({ userId, sessionId: ownSessionId, currentToken: fourth.token }),
    "revoked_current",
  );
  assert.equal(await resolveSessionUser(fourth.token), null, "A self-revoked session must stop authenticating.");
  assert.equal(
    await revokeSessionForUser({ userId, sessionId: ownSessionId, currentToken: fourth.token }),
    "not_found",
    "Revoking twice must not report a second change.",
  );

  // 12. "Sign out other devices" keeps the calling session alive.
  const current = await createSession({ userId, ip });
  const other = await createSession({ userId, ip });
  const revokedOthers = await revokeOtherSessions({ userId, currentToken: current.token });
  assert(revokedOthers >= 1, "Revoking other sessions must affect at least the one just created.");
  assert.equal(await resolveSessionUser(other.token), null, "Other sessions must be revoked.");
  assert.equal((await resolveSessionUser(current.token))?.id, userId, "The calling session must stay valid.");
  const intruderStillValid = await resolveSessionUser(intruderSession.token);
  assert.equal(intruderStillValid?.id, intruderId, "Revoking your own sessions must not touch another account.");

  // 13. Password change validates the current password and the new password policy.
  await expectStatus(
    () => changePassword({ userId, currentPassword: "wrong-password", newPassword: "another-strong-1", currentToken: current.token }),
    400,
  );
  await expectStatus(
    () => changePassword({ userId, currentPassword: initialPassword, newPassword: "short1", currentToken: current.token }),
    400,
  );
  await expectStatus(
    () => changePassword({ userId, currentPassword: initialPassword, newPassword: "alllettersonly", currentToken: current.token }),
    400,
  );

  // 14. A successful change stores a new hash and signs out every other device.
  const bystander = await createSession({ userId, ip });
  const changed = await changePassword({
    userId,
    currentPassword: initialPassword,
    newPassword: "integration-test-password-2",
    currentToken: current.token,
  });
  assert(changed.revokedSessions >= 1, "A password change must revoke the other sessions.");
  assert.equal(await resolveSessionUser(bystander.token), null, "The bystander session must be revoked.");
  assert.equal((await resolveSessionUser(current.token))?.id, userId, "The session that changed the password must survive.");
  const storedHash = (await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }))?.passwordHash ?? "";
  assert.equal(await verifyPassword("integration-test-password-2", storedHash), true, "The new password must verify.");
  assert.equal(await verifyPassword(initialPassword, storedHash), false, "The old password must stop working.");

  console.log("Auth DB integration passed: session issue/resolve/expiry/revocation, disabled-user rejection, stale-session cleanup, hashed token and address storage, database-backed login throttling counters, device listing, cross-account revocation refusal, self-revocation reporting, sign-out-others, and password change with session invalidation.");
} finally {
  await prisma.session.deleteMany({ where: { userId: { in: [userId, intruderId].filter(Boolean) } } });
  await prisma.loginAttempt.deleteMany({ where: { username: { in: [username, bruteForceName, intruderName] } } });
  if (userId) {
    await prisma.auditLog.deleteMany({ where: { actorId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  if (intruderId) {
    await prisma.auditLog.deleteMany({ where: { actorId: intruderId } });
    await prisma.user.deleteMany({ where: { id: intruderId } });
  }
  await prisma.$disconnect();
}
