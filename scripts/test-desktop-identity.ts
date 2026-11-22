import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createDesktopIdentityService } from "../server/utils/desktop-identity";
import type { DesktopIdentityContext } from "../server/utils/desktop-identity";
import { hashSessionToken } from "../server/utils/auth";

/**
 * Desktop owner binding, entirely offline.
 *
 * A synthetic Prisma client is installed in the process-wide cache, so no database connection is
 * opened. File-system checks, atomic owner writes and ACL preconditions run against temporary
 * directories that are removed at the end.
 */

type FakeUser = { id: string; role: "ADMIN" | "USER"; status: "ACTIVE" | "DISABLED" };
type FakeSession = { id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null; userAgent?: string | null };

const users = new Map<string, FakeUser>();
const sessions = new Map<string, FakeSession>();
let order: string[] = [];
let userUpdates = 0;
let failRevoke = false;
let failAudit = false;
const audits: Array<{ action: string; actorId?: string | null; details: Record<string, unknown> }> = [];

function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function sessionRow(session: FakeSession): Record<string, unknown> {
  return { ...session };
}

function findSessionBy(predicate: (session: FakeSession) => boolean): FakeSession | undefined {
  return [...sessions.values()].find(predicate);
}

const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes('FROM "users"')) {
      order.push("lock-user");
      const user = users.get(String(values[0]));
      return user ? [{ status: user.status }] : [];
    }
    if (text.includes('FROM "sessions"')) {
      order.push("lock-session");
      const session = sessions.get(String(values[0]));
      return session ? [sessionRow(session)] : [];
    }
    throw new Error("Unexpected query in fake: " + text);
  },
  session: {
    findUnique: async (args: { where: { tokenHash: string } }) => {
      order.push("lookup-session");
      const session = findSessionBy((candidate) => candidate.tokenHash === args.where.tokenHash);
      return session ? { id: session.id, userId: session.userId } : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const session = findSessionBy((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
      return session ? { id: session.id, tokenHash: session.tokenHash, revokedAt: session.revokedAt } : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const id = randomUUID();
      sessions.set(id, {
        id,
        userId: String(args.data.userId),
        tokenHash: String(args.data.tokenHash),
        expiresAt: args.data.expiresAt as Date,
        revokedAt: null,
        userAgent: typeof args.data.userAgent === "string" ? args.data.userAgent : null,
      });
      return { id };
    },
    update: async (args: { where: { id: string }; data: { revokedAt: Date } }) => {
      if (failRevoke) throw new Error("synthetic revoke failure");
      const session = sessions.get(args.where.id);
      assert(session, "fake update: session must exist");
      session.revokedAt = args.data.revokedAt;
      return sessionRow(session);
    },
  },
  user: {
    update: async () => {
      userUpdates += 1;
      return {};
    },
  },
};

const fakePrisma = {
  $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  session: {
    findFirst: tx.session.findFirst,
    update: tx.session.update,
    create: tx.session.create,
  },
  auditLog: {
    create: async (args: { data: { action: string; actorId?: string | null; details: Record<string, unknown> } }) => {
      if (failAudit) throw new Error("synthetic audit failure");
      audits.push({ action: args.data.action, actorId: args.data.actorId, details: args.data.details });
      return { id: randomUUID() };
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      order.push("lookup-user");
      const user = users.get(args.where.id);
      return user ? { status: user.status } : null;
    },
    findMany: async (args: { where: { role: string; status: string } }) =>
      [...users.values()].filter((user) => user.role === args.where.role && user.status === args.where.status).map((user) => ({ id: user.id })),
    count: async () => users.size,
    update: tx.user.update,
  },
};
(globalThis as unknown as { __yilingPrisma?: unknown }).__yilingPrisma = fakePrisma;

function resetDb(input: { admins?: Array<{ status: "ACTIVE" | "DISABLED" }> } = {}) {
  users.clear();
  sessions.clear();
  order = [];
  userUpdates = 0;
  failRevoke = false;
  failAudit = false;
  audits.length = 0;
  for (const admin of input.admins ?? []) {
    const id = randomUUID();
    users.set(id, { id, role: "ADMIN", status: admin.status });
  }
}

function protectDirectory(directory: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    return;
  }
  const identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = /S-1-5-(?:\d+-)+\d+/u.exec(identity.stdout)?.[0];
  assert(sid, "The current user SID must be readable to prepare a private test directory.");
  const result = spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "Protecting the temporary directory failed: " + result.stdout + result.stderr);
}

type Fixture = { dataDir: string; identity: DesktopIdentityContext; cleanup: () => void };

function createFixture(overrides: Partial<DesktopIdentityContext> = {}, options: { protect?: boolean } = {}): Fixture {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yiling-desktop-identity-"));
  const identity: DesktopIdentityContext = {
    installationId: randomUUID(),
    databaseInstanceId: randomUUID(),
    systemIdentifier: "7710915531008694268",
    ...overrides,
  };
  fs.writeFileSync(path.join(dataDir, "desktop-database.json"), JSON.stringify({
    format: "yiling-desktop-database", version: 1, runtime: "embedded", root: "database", phase: "ready",
    installationId: identity.installationId, instanceId: identity.databaseInstanceId,
    systemIdentifier: identity.systemIdentifier, majorVersion: 16,
  }));
  fs.mkdirSync(path.join(dataDir, "database"));
  fs.writeFileSync(path.join(dataDir, "database", "runtime.json"), JSON.stringify({
    purpose: "YILING_DESKTOP_PG_V1", schemaVersion: 1, phase: "ready",
    instanceId: identity.databaseInstanceId, systemIdentifier: identity.systemIdentifier,
  }));
  if (options.protect !== false) protectDirectory(dataDir);
  return {
    dataDir,
    identity,
    cleanup: () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function seedSession(input: { userId: string; token: string; expiresAt?: Date; revokedAt?: Date | null }): FakeSession {
  const session: FakeSession = {
    id: randomUUID(),
    userId: input.userId,
    tokenHash: hashSessionToken(input.token),
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: input.revokedAt ?? null,
  };
  sessions.set(session.id, session);
  return session;
}

function token(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 11);
}

assert.match(token(), /^[A-Za-z0-9_-]{43}$/u, "Synthetic tokens must match the opaque-cookie shape.");

const owners: Fixture[] = [];
function serviceFor(fixture: Fixture, freshUserId?: string) {
  owners.push(fixture);
  return createDesktopIdentityService({ dataDir: fixture.dataDir, identity: fixture.identity, freshUserId });
}

async function rejectsWithCode(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => (error as { code?: string }).code === code);
}

try {
  // 1. First boot with a freshly created account binds only that exact ACTIVE ADMIN.
  resetDb({ admins: [{ status: "ACTIVE" }] });
  const firstAdmin = [...users.values()][0];
  assert(firstAdmin);
  const fresh = createFixture();
  const freshService = serviceFor(fresh, firstAdmin.id);
  assert.deepEqual(await freshService.initialize(), { state: "bound" });
  const freshOwner = JSON.parse(fs.readFileSync(path.join(fresh.dataDir, "desktop-owner.json"), "utf8"));
  assert.equal(freshOwner.ownerUserId, firstAdmin.id);
  assert.equal(freshOwner.status, "active");
  assert.equal(freshOwner.currentSession, null);
  assert.equal(freshOwner.context.installationId, fresh.identity.installationId);
  const boundAudit = audits.find((entry) => entry.action === "desktop.owner_bound");
  assert(boundAudit, "The first automatic binding must leave an audit entry.");
  assert.deepEqual(Object.keys(boundAudit.details).sort(), ["installationId", "source"]);
  assert.equal(boundAudit.details.installationId, fresh.identity.installationId);
  // The same call is idempotent and does not rebind.
  assert.deepEqual(await freshService.initialize(), { state: "bound" });

  // 2. Without a fresh id, a database that happens to have one account stays UNBOUND.
  const noFresh = createFixture();
  const noFreshService = serviceFor(noFresh);
  assert.deepEqual(await noFreshService.initialize(), { state: "unbound" });
  assert.equal(fs.existsSync(path.join(noFresh.dataDir, "desktop-owner.json")), false, "Never guess the owner from the only account.");

  // 3. Fresh-id mismatch (two admins, or an id that is not the created one) refuses to bind.
  resetDb({ admins: [{ status: "ACTIVE" }, { status: "ACTIVE" }] });
  const twoAdmins = createFixture();
  await rejectsWithCode(() => serviceFor(twoAdmins, [...users.keys()][0]).initialize(), "desktop_identity_fresh_account_mismatch");
  assert.equal(fs.existsSync(path.join(twoAdmins.dataDir, "desktop-owner.json")), false);

  resetDb({ admins: [{ status: "ACTIVE" }] });
  const wrongId = createFixture();
  await rejectsWithCode(() => serviceFor(wrongId, randomUUID()).initialize(), "desktop_identity_fresh_account_mismatch");

  // A database holding one admin plus one ordinary user is not a fresh installation.
  resetDb({ admins: [{ status: "ACTIVE" }] });
  const adminOnly = [...users.values()][0];
  assert(adminOnly);
  const extraUser = randomUUID();
  users.set(extraUser, { id: extraUser, role: "USER", status: "ACTIVE" });
  const restoredDir = createFixture();
  await rejectsWithCode(() => serviceFor(restoredDir, adminOnly.id).initialize(), "desktop_identity_fresh_account_mismatch");
  assert.equal(fs.existsSync(path.join(restoredDir.dataDir, "desktop-owner.json")), false, "An older/restored database must stay unbound.");

  // 4. Database context must match the identity this process was started with.
  const mismatch = createFixture();
  const databaseFile = path.join(mismatch.dataDir, "desktop-database.json");
  const databaseRecord = JSON.parse(fs.readFileSync(databaseFile, "utf8"));
  databaseRecord.instanceId = randomUUID();
  fs.writeFileSync(databaseFile, JSON.stringify(databaseRecord));
  const mismatchService = serviceFor(mismatch);
  assert.deepEqual(await mismatchService.getStatus(), { state: "blocked", code: "desktop_identity_context_invalid" });
  await rejectsWithCode(() => mismatchService.initialize(), "desktop_identity_context_invalid");

  // 5. A valid session binds the owner; disabled, expired and revoked sessions do not.
  resetDb();
  const ownerId = randomUUID();
  users.set(ownerId, { id: ownerId, role: "ADMIN", status: "ACTIVE" });
  const fixture = createFixture();
  const service = serviceFor(fixture);
  assert.deepEqual(await service.getStatus(), { state: "unbound" });

  await rejectsWithCode(() => service.bindFromSession("too-short"), "desktop_identity_session_invalid");
  await rejectsWithCode(() => service.bindFromSession(token()), "desktop_identity_session_invalid");

  const validToken = token();
  seedSession({ userId: ownerId, token: validToken });
  assert.deepEqual(await service.bindFromSession(validToken), { state: "bound" });
  assert.deepEqual(order.slice(-3), ["lookup-session", "lock-user", "lock-session"], "Lock the account before the session.");
  const boundRecord = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "desktop-owner.json"), "utf8"));
  assert.equal(boundRecord.ownerUserId, ownerId);
  assert.equal(boundRecord.status, "active");
  assert.equal(JSON.stringify(boundRecord).includes(validToken), false, "The owner file must never contain the raw token.");

  const expiredToken = token();
  seedSession({ userId: ownerId, token: expiredToken, expiresAt: new Date(Date.now() - 1000) });
  const revokedToken = token();
  seedSession({ userId: ownerId, token: revokedToken, revokedAt: new Date() });
  await rejectsWithCode(() => service.bindFromSession(expiredToken), "desktop_identity_session_invalid");
  await rejectsWithCode(() => service.bindFromSession(revokedToken), "desktop_identity_session_invalid");

  // 6. A different account cannot silently take over an active binding.
  resetDb();
  const otherId = randomUUID();
  users.set(ownerId, { id: ownerId, role: "ADMIN", status: "ACTIVE" });
  users.set(otherId, { id: otherId, role: "USER", status: "ACTIVE" });
  const conflictToken = token();
  seedSession({ userId: otherId, token: conflictToken });
  await rejectsWithCode(() => service.bindFromSession(conflictToken), "desktop_owner_already_bound");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dataDir, "desktop-owner.json"), "utf8")).ownerUserId, ownerId);

  // 7. Issuing a desktop session without a binding is refused.
  const unboundDir = createFixture();
  const unboundService = serviceFor(unboundDir);
  await rejectsWithCode(() => unboundService.issueSession(), "desktop_owner_not_bound");

  // 8. Issued sessions use the shared token/hash/TTL policy, persist only the hash, and rotate.
  resetDb();
  users.set(ownerId, { id: ownerId, role: "ADMIN", status: "ACTIVE" });
  users.set(otherId, { id: otherId, role: "USER", status: "ACTIVE" });
  const issueDir = createFixture();
  const issueService = serviceFor(issueDir);
  const bindToken = token();
  seedSession({ userId: ownerId, token: bindToken });
  await issueService.bindFromSession(bindToken);

  const webSession = seedSession({ userId: ownerId, token: token() });
  const first = await issueService.issueSession();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.cookieName.length > 0, true);
  assert.equal(typeof first.secure, "boolean");
  const afterFirst = JSON.parse(fs.readFileSync(path.join(issueDir.dataDir, "desktop-owner.json"), "utf8"));
  assert.equal(afterFirst.currentSession.tokenHash, hashSessionToken(first.token));
  assert.equal(JSON.stringify(afterFirst).includes(first.token), false, "Only the hash may be persisted.");
  assert.equal(afterFirst.currentSession.expiresAt, first.expiresAt);
  const firstSession = [...sessions.values()].find((session) => session.tokenHash === hashSessionToken(first.token));
  assert(firstSession);
  assert.equal(firstSession.userAgent, "YilingSpace-Desktop", "Desktop sessions must be identifiable in the device list.");
  assert.equal(firstSession.revokedAt, null);

  const second = await issueService.issueSession();
  assert.notEqual(second.token, first.token);
  const firstAfterRotation = sessions.get(firstSession.id);
  assert(firstAfterRotation);
  assert(firstAfterRotation.revokedAt instanceof Date, "The previous desktop session must be revoked precisely.");
  const webAfterRotation = sessions.get(webSession.id);
  assert(webAfterRotation);
  assert.equal(webAfterRotation.revokedAt, null, "Never revoke an unrelated (web) session.");
  assert.equal(userUpdates, 0, "Issuing a session must not mutate the account.");

  // 8b. If the old cookie cannot be revoked, keep the binding/ref and issue nothing new.
  const rotateOwnerId = randomUUID();
  users.set(rotateOwnerId, { id: rotateOwnerId, role: "ADMIN", status: "ACTIVE" });
  const rotateDir = createFixture();
  const rotateService = serviceFor(rotateDir);
  const rotateProof = token();
  seedSession({ userId: rotateOwnerId, token: rotateProof });
  await rotateService.bindFromSession(rotateProof);
  const firstRotate = await rotateService.issueSession();
  const rotateOwnerFile = path.join(rotateDir.dataDir, "desktop-owner.json");
  const beforeFailedRotation = JSON.parse(fs.readFileSync(rotateOwnerFile, "utf8"));
  const sessionsBefore = sessions.size;
  failRevoke = true;
  try {
    await rejectsWithCode(() => rotateService.issueSession(), "desktop_identity_session_revoke_failed");
  } finally {
    failRevoke = false;
  }
  assert.equal(sessions.size, sessionsBefore, "A failed old-cookie revocation must not issue a new session.");
  const afterFailedRotation = JSON.parse(fs.readFileSync(rotateOwnerFile, "utf8"));
  assert.deepEqual(afterFailedRotation.currentSession, beforeFailedRotation.currentSession, "The old reference must be kept.");
  const keptSession = sessions.get(beforeFailedRotation.currentSession.id);
  assert(keptSession);
  assert.equal(keptSession.revokedAt, null, "The still-referenced cookie must remain live for a retry.");
  const recovered = await rotateService.issueSession();
  assert.notEqual(recovered.token, firstRotate.token);
  const recoveredSession = sessions.get(beforeFailedRotation.currentSession.id);
  assert(recoveredSession);
  assert(recoveredSession.revokedAt instanceof Date, "A successful retry revokes the old cookie.");

  // 9. Disabled owner is reported blocked and cannot obtain a new session.
  const owner = users.get(ownerId);
  assert(owner);
  owner.status = "DISABLED";
  assert.deepEqual(await issueService.getStatus(), { state: "blocked", code: "desktop_owner_unavailable" });
  await rejectsWithCode(() => issueService.issueSession(), "desktop_owner_unavailable");
  owner.status = "ACTIVE";

  // 10. Normal exit revokes the current desktop session but keeps the active binding.
  const beforeExit = JSON.parse(fs.readFileSync(path.join(issueDir.dataDir, "desktop-owner.json"), "utf8"));
  assert.deepEqual(await issueService.revokeCurrentSession(), { state: "bound" });
  const secondSession = [...sessions.values()].find((session) => session.tokenHash === beforeExit.currentSession.tokenHash);
  assert(secondSession);
  assert(secondSession.revokedAt instanceof Date, "Normal exit must revoke the session it issued.");
  const afterExit = JSON.parse(fs.readFileSync(path.join(issueDir.dataDir, "desktop-owner.json"), "utf8"));
  assert.equal(afterExit.currentSession, null);
  assert.equal(afterExit.status, "active", "Normal exit must not unbind the owner.");
  const reissued = await issueService.issueSession();
  assert.match(reissued.token, /^[A-Za-z0-9_-]{43}$/u);

  // 11. Unbind revokes the current session, persists "revoked", and allows a deliberate rebind.
  assert.deepEqual(await issueService.unbind(), { state: "revoked" });
  const afterUnbind = JSON.parse(fs.readFileSync(path.join(issueDir.dataDir, "desktop-owner.json"), "utf8"));
  assert.equal(afterUnbind.status, "revoked");
  assert.equal(afterUnbind.currentSession, null);
  const reissuedSession = [...sessions.values()].find((session) => session.tokenHash === hashSessionToken(reissued.token));
  assert(reissuedSession);
  assert(reissuedSession.revokedAt instanceof Date, "Unbind must revoke its own session.");
  assert.deepEqual(await issueService.getStatus(), { state: "revoked" });

  const rebindToken = token();
  seedSession({ userId: otherId, token: rebindToken });
  assert.deepEqual(await issueService.bindFromSession(rebindToken), { state: "bound" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(issueDir.dataDir, "desktop-owner.json"), "utf8")).ownerUserId, otherId);

  // 12. Foreign context or corrupted owner files block instead of being overwritten.
  const foreignDir = createFixture();
  const foreignService = serviceFor(foreignDir);
  const foreignBind = token();
  seedSession({ userId: otherId, token: foreignBind });
  await foreignService.bindFromSession(foreignBind);
  const foreignFile = path.join(foreignDir.dataDir, "desktop-owner.json");
  const foreignRecord = JSON.parse(fs.readFileSync(foreignFile, "utf8"));
  foreignRecord.context.installationId = randomUUID();
  fs.writeFileSync(foreignFile, JSON.stringify(foreignRecord));
  assert.deepEqual(await foreignService.getStatus(), { state: "blocked", code: "desktop_owner_context_mismatch" });
  await rejectsWithCode(() => foreignService.issueSession(), "desktop_owner_context_mismatch");

  const brokenRecord = JSON.parse(fs.readFileSync(foreignFile, "utf8"));
  brokenRecord.context.installationId = foreignDir.identity.installationId;
  delete brokenRecord.currentSession;
  fs.writeFileSync(foreignFile, JSON.stringify(brokenRecord));
  assert.deepEqual(await foreignService.getStatus(), { state: "blocked", code: "desktop_owner_file_invalid" });
  await rejectsWithCode(() => foreignService.unbind(), "desktop_owner_file_invalid");

  // 13. A loosened data-directory ACL blocks owner-file access.
  if (process.platform === "win32") {
    const aclDir = createFixture();
    const aclService = serviceFor(aclDir);
    const aclBind = token();
    seedSession({ userId: otherId, token: aclBind });
    await aclService.bindFromSession(aclBind);
    const loosen = spawnSync("icacls.exe", [aclDir.dataDir, "/grant", "*S-1-1-0:(OI)(CI)R"], { encoding: "utf8" });
    assert.equal(loosen.status, 0);
    try {
      const looseService = serviceFor(aclDir);
      assert.deepEqual(await looseService.getStatus(), { state: "blocked", code: "desktop_identity_directory_not_private" });
    } finally {
      spawnSync("icacls.exe", [aclDir.dataDir, "/remove:g", "*S-1-1-0"], { encoding: "utf8" });
    }

    // 13b. An explicit Everyone grant on the owner file itself is refused, even though the file
    // inherits the private parent ACL and is not required to be independently "protected".
    const fileAclDir = createFixture();
    const fileAclService = serviceFor(fileAclDir);
    const fileAclBind = token();
    seedSession({ userId: otherId, token: fileAclBind });
    await fileAclService.bindFromSession(fileAclBind);
    const ownerPath = path.join(fileAclDir.dataDir, "desktop-owner.json");
    const grantFile = spawnSync("icacls.exe", [ownerPath, "/grant", "*S-1-1-0:R"], { encoding: "utf8" });
    assert.equal(grantFile.status, 0);
    try {
      const exposedService = serviceFor(fileAclDir);
      assert.deepEqual(await exposedService.getStatus(), { state: "blocked", code: "desktop_identity_owner_file_not_private" });
      await rejectsWithCode(() => exposedService.issueSession(), "desktop_identity_owner_file_not_private");
    } finally {
      spawnSync("icacls.exe", [ownerPath, "/remove:g", "*S-1-1-0"], { encoding: "utf8" });
    }
  }

  // 13c. A disabled/deleted owner can still be unbound, and only then can another active account
  // be bound explicitly with its own Cookie proof.
  resetDb();
  const oldOwner = randomUUID();
  const newOwner = randomUUID();
  users.set(oldOwner, { id: oldOwner, role: "ADMIN", status: "ACTIVE" });
  users.set(newOwner, { id: newOwner, role: "ADMIN", status: "ACTIVE" });
  const recoverDir = createFixture();
  const recoverService = serviceFor(recoverDir);
  const oldProof = token();
  seedSession({ userId: oldOwner, token: oldProof });
  assert.deepEqual(await recoverService.bindFromSession(oldProof), { state: "bound" });
  const disabled = users.get(oldOwner);
  assert(disabled);
  disabled.status = "DISABLED";
  assert.deepEqual(await recoverService.getStatus(), { state: "blocked", code: "desktop_owner_unavailable" });
  assert.deepEqual(await recoverService.unbind(), { state: "revoked" });
  assert.deepEqual(await recoverService.getStatus(), { state: "revoked" }, "After an explicit unbind the state must be revoked, not blocked.");
  const newProof = token();
  seedSession({ userId: newOwner, token: newProof });
  assert.deepEqual(await recoverService.bindFromSession(newProof), { state: "bound" });
  const recoveredRecord = JSON.parse(fs.readFileSync(path.join(recoverDir.dataDir, "desktop-owner.json"), "utf8"));
  assert.equal(recoveredRecord.ownerUserId, newOwner);
  assert.equal(recoveredRecord.status, "active");
  const unboundAudit = audits.find((entry) => entry.action === "desktop.owner_unbound");
  assert(unboundAudit, "Unbinding must leave an audit entry.");
  assert.equal(unboundAudit.actorId, oldOwner);
  assert.deepEqual(Object.keys(unboundAudit.details).sort(), ["installationId", "source"], "Audit details must not contain tokens or hashes.");
  assert.equal(unboundAudit.details.installationId, recoverDir.identity.installationId);
  assert.equal(unboundAudit.details.source, "desktop");

  // A deleted owner follows the same path: blocked → unbind → revoked → explicit rebind.
  resetDb();
  const deletedOwner = randomUUID();
  const replacement = randomUUID();
  users.set(deletedOwner, { id: deletedOwner, role: "ADMIN", status: "ACTIVE" });
  users.set(replacement, { id: replacement, role: "ADMIN", status: "ACTIVE" });
  const deletedDir = createFixture();
  const deletedService = serviceFor(deletedDir);
  const deletedProof = token();
  seedSession({ userId: deletedOwner, token: deletedProof });
  await deletedService.bindFromSession(deletedProof);
  users.delete(deletedOwner);
  assert.deepEqual(await deletedService.getStatus(), { state: "blocked", code: "desktop_owner_unavailable" });
  assert.deepEqual(await deletedService.unbind(), { state: "revoked" });
  assert.deepEqual(await deletedService.getStatus(), { state: "revoked" });
  const replacementProof = token();
  seedSession({ userId: replacement, token: replacementProof });
  assert.deepEqual(await deletedService.bindFromSession(replacementProof), { state: "bound" });

  // 13d. A best-effort audit failure must never undo a successful binding.
  resetDb();
  users.set(ownerId, { id: ownerId, role: "ADMIN", status: "ACTIVE" });
  const auditDir = createFixture();
  const auditService = serviceFor(auditDir);
  const auditProof = token();
  seedSession({ userId: ownerId, token: auditProof });
  failAudit = true;
  try {
    assert.deepEqual(await auditService.bindFromSession(auditProof), { state: "bound" });
  } finally {
    failAudit = false;
  }
  assert.equal(audits.length, 0, "A failed audit write must not emit a phantom entry.");
  assert.deepEqual(await auditService.getStatus(), { state: "bound" });
  assert.equal(JSON.stringify(audits).includes(hashSessionToken(auditProof)), false);

  // 14. Calls are serialised: concurrent issues leave exactly one live desktop session.
  resetDb();
  users.set(ownerId, { id: ownerId, role: "ADMIN", status: "ACTIVE" });
  const serialDir = createFixture();
  const serialService = serviceFor(serialDir);
  const serialBind = token();
  seedSession({ userId: ownerId, token: serialBind });
  await serialService.bindFromSession(serialBind);
  const [left, right] = await Promise.all([serialService.issueSession(), serialService.issueSession()]);
  assert.notEqual(left.token, right.token);
  const live = [...sessions.values()].filter((session) =>
    session.revokedAt === null
    && (session.tokenHash === hashSessionToken(left.token) || session.tokenHash === hashSessionToken(right.token)));
  assert.equal(live.length, 1, "Serialised rotation must leave exactly one live desktop session.");
  assert.equal(live[0]?.tokenHash, hashSessionToken(right.token), "The last issued session must be the current one.");

  console.log("Desktop identity passed: fresh-install-only init (single account + matching ACTIVE ADMIN), revoked-first status so a disabled/deleted owner can unbind and rebind explicitly, DB/context and private-ACL gating for directory and owner file, atomic hash-only owner file, locked session-bound binding with post-lock hash check, blocked disabled/foreign/invalid states, precise rotation/unbind/exit revocation without touching web sessions, failed old-cookie revocation issuing nothing, best-effort token-free audit, and serialised issuance; no database or HTTP route was used.");
} finally {
  for (const fixture of owners) {
    try { fixture.cleanup(); } catch { /* best effort for temporary fixtures */ }
  }
  delete (globalThis as unknown as { __yilingPrisma?: unknown }).__yilingPrisma;
}
