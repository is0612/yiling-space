import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  SESSION_COOKIE_NAME,
  createSessionForVerifiedDesktopOwner,
  hashSessionToken,
  isSecureCookieRuntime,
  revokeSessionForUser,
} from "./auth";
import { getPrisma } from "./prisma";

/**
 * Desktop owner binding and password-less session issuance.
 *
 * This module is driven by the private desktop control path (Nitro → supervisor → launcher →
 * Electron IPC). It is not an HTTP API: nothing here is reachable from a public route, and the
 * session it issues is written into the Electron cookie jar by the launcher, not returned to a
 * browser request. A caller must therefore already hold the verified OS installation identity.
 *
 * The owner file lives next to `desktop-database.json` in the installed data directory, which the
 * installer protects with a private ACL. It stores only a session id/hash/expiry — never the token.
 */

export type DesktopIdentityContext = {
  installationId: string;
  databaseInstanceId: string;
  systemIdentifier: string;
};

export type DesktopIdentityStatus = {
  state: "bound" | "unbound" | "revoked" | "blocked";
  code?: string;
};

export type DesktopIssuedSession = {
  token: string;
  expiresAt: string;
  cookieName: string;
  secure: boolean;
};

type DesktopSessionRef = { id: string; tokenHash: string; expiresAt: string };

type DesktopOwnerRecord = {
  format: "yiling-desktop-owner";
  version: 1;
  context: DesktopIdentityContext;
  ownerUserId: string;
  status: "active" | "revoked";
  currentSession: DesktopSessionRef | null;
};

const OWNER_FORMAT = "yiling-desktop-owner";
const DATABASE_FORMAT = "yiling-desktop-database";
const RUNTIME_PURPOSE = "YILING_DESKTOP_PG_V1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DESKTOP_USER_AGENT = "YilingSpace-Desktop";

function failure(code: string): never {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  throw error;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "desktop_identity_unavailable";
}

function normalizeIdentity(input: DesktopIdentityContext): DesktopIdentityContext {
  if (!input || typeof input.installationId !== "string" || !UUID_PATTERN.test(input.installationId)) {
    failure("desktop_identity_context_invalid");
  }
  if (typeof input.databaseInstanceId !== "string" || !UUID_PATTERN.test(input.databaseInstanceId)) {
    failure("desktop_identity_context_invalid");
  }
  if (typeof input.systemIdentifier !== "string" || !/^\d{6,24}$/.test(input.systemIdentifier)) {
    failure("desktop_identity_context_invalid");
  }
  return {
    installationId: input.installationId,
    databaseInstanceId: input.databaseInstanceId,
    systemIdentifier: input.systemIdentifier,
  };
}

function sameContext(left: DesktopIdentityContext, right: DesktopIdentityContext): boolean {
  return left.installationId === right.installationId
    && left.databaseInstanceId === right.databaseInstanceId
    && left.systemIdentifier === right.systemIdentifier;
}

function parseOwnerRecord(value: unknown, identity: DesktopIdentityContext): DesktopOwnerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failure("desktop_owner_file_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "context,currentSession,format,ownerUserId,status,version") failure("desktop_owner_file_invalid");
  if (record.format !== OWNER_FORMAT || record.version !== 1) failure("desktop_owner_file_invalid");
  if (typeof record.ownerUserId !== "string" || !UUID_PATTERN.test(record.ownerUserId)) failure("desktop_owner_file_invalid");
  if (record.status !== "active" && record.status !== "revoked") failure("desktop_owner_file_invalid");

  const context = record.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) failure("desktop_owner_file_invalid");
  const contextKeys = Object.keys(context as Record<string, unknown>).sort().join(",");
  if (contextKeys !== "databaseInstanceId,installationId,systemIdentifier") failure("desktop_owner_file_invalid");
  const parsedContext = context as DesktopIdentityContext;
  if (typeof parsedContext.installationId !== "string" || typeof parsedContext.databaseInstanceId !== "string"
    || typeof parsedContext.systemIdentifier !== "string") failure("desktop_owner_file_invalid");
  // A record written for another installation/database is evidence of a foreign or restored data
  // directory: refuse it instead of silently rebinding or overwriting.
  if (!sameContext(parsedContext, identity)) failure("desktop_owner_context_mismatch");

  let currentSession: DesktopSessionRef | null = null;
  if (record.currentSession !== null) {
    const ref = record.currentSession;
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) failure("desktop_owner_file_invalid");
    const refKeys = Object.keys(ref as Record<string, unknown>).sort().join(",");
    if (refKeys !== "expiresAt,id,tokenHash") failure("desktop_owner_file_invalid");
    const candidate = ref as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !UUID_PATTERN.test(candidate.id)) failure("desktop_owner_file_invalid");
    if (typeof candidate.tokenHash !== "string" || !HASH_PATTERN.test(candidate.tokenHash)) failure("desktop_owner_file_invalid");
    if (typeof candidate.expiresAt !== "string") failure("desktop_owner_file_invalid");
    const expiresAt = new Date(candidate.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== candidate.expiresAt) failure("desktop_owner_file_invalid");
    if (record.status === "revoked") failure("desktop_owner_file_invalid");
    currentSession = { id: candidate.id, tokenHash: candidate.tokenHash, expiresAt: candidate.expiresAt };
  }

  return {
    format: OWNER_FORMAT,
    version: 1,
    context: parsedContext,
    ownerUserId: record.ownerUserId,
    status: record.status,
    currentSession,
  };
}

/** Creates the serialised desktop identity service described above. */
export function createDesktopIdentityService(options: {
  dataDir: string;
  identity: DesktopIdentityContext;
  freshUserId?: string;
}) {
  if (typeof options?.dataDir !== "string" || !path.isAbsolute(options.dataDir)) {
    failure("desktop_identity_data_dir_invalid");
  }
  const dataDir = path.resolve(options.dataDir);
  const identity = normalizeIdentity(options.identity);
  const ownerFile = path.join(dataDir, "desktop-owner.json");
  const databaseFile = path.join(dataDir, "desktop-database.json");
  const runtimeFile = path.join(dataDir, "database", "runtime.json");
  let tail: Promise<unknown> = Promise.resolve();

  /** Every public operation is serialised: a bind must not race an issue or an unbind. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(() => task());
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function ensureDataDir(): void {
    if (!path.isAbsolute(options.dataDir)) failure("desktop_identity_data_dir_invalid");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dataDir);
    } catch {
      failure("desktop_identity_data_dir_invalid");
    }
    if (stat!.isSymbolicLink() || !stat!.isDirectory()) failure("desktop_identity_data_dir_invalid");
  }

  function readJson(file: string, code: string): Record<string, unknown> {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      failure(code);
    }
    if (stat!.isSymbolicLink() || !stat!.isFile() || stat!.size > 64 * 1024) failure(code);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      failure(code);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) failure(code);
    return parsed as Record<string, unknown>;
  }

  /** The installer protects the data directory; a loosened ACL blocks owner-file access. */
  /**
   * Only the current user, SYSTEM and the local Administrators group may appear in the allow list.
   * A directory must also have inheritance disabled; the owner file may inherit the private parent
   * ACL, but an explicit Everyone/Users entry is still refused.
   */
  function assertPrivateAcl(target: string, requireProtected: boolean, code: string): void {
    if (process.platform !== "win32") {
      if ((fs.lstatSync(target).mode & 0o077) !== 0) failure(code);
      return;
    }
    const script = [
      "$ErrorActionPreference='Stop'",
      "$u=[Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$u",
      "$d=$env:YILING_DESKTOP_ACL_PATH",
      "$requireProtected=$env:YILING_DESKTOP_ACL_PROTECTED -eq '1'",
      "$a=Get-Acl -LiteralPath $d",
      "if($requireProtected -and -not $a.AreAccessRulesProtected){'unprotected';exit 0}",
      "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$bad=@()",
      "foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow'){try{$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{$s='unknown'};if($s -ne $me -and $s -ne 'S-1-5-18' -and $s -ne 'S-1-5-32-544'){$bad+=$s}}}",
      "if($bad.Count){'unexpected:'+($bad -join ',')}else{'ok'}",
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8",
      env: { ...process.env, YILING_DESKTOP_ACL_PATH: target, YILING_DESKTOP_ACL_PROTECTED: requireProtected ? "1" : "0" },
      windowsHide: true,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0 || result.stdout.trim() !== "ok") failure(code);
  }

  function assertPrivateDirectory(): void {
    ensureDataDir();
    assertPrivateAcl(dataDir, true, "desktop_identity_directory_not_private");
  }

  function assertPrivateOwnerFile(): void {
    assertPrivateAcl(ownerFile, false, "desktop_identity_owner_file_not_private");
  }

  /** Cross-checks the binding files against the identity this process was started with. */
  function ensureContext(): void {
    ensureDataDir();
    const database = readJson(databaseFile, "desktop_identity_context_invalid");
    if (database.format !== DATABASE_FORMAT || database.version !== 1 || database.runtime !== "embedded"
      || database.root !== "database" || database.phase !== "ready"
      || database.installationId !== identity.installationId
      || database.instanceId !== identity.databaseInstanceId
      || database.systemIdentifier !== identity.systemIdentifier) {
      failure("desktop_identity_context_invalid");
    }
    let databaseDir: fs.Stats;
    try {
      databaseDir = fs.lstatSync(path.join(dataDir, "database"));
    } catch {
      failure("desktop_identity_context_invalid");
    }
    if (databaseDir!.isSymbolicLink() || !databaseDir!.isDirectory()) failure("desktop_identity_context_invalid");
    const runtime = readJson(runtimeFile, "desktop_identity_context_invalid");
    if (runtime.purpose !== RUNTIME_PURPOSE || runtime.phase !== "ready"
      || runtime.instanceId !== identity.databaseInstanceId
      || runtime.systemIdentifier !== identity.systemIdentifier) {
      failure("desktop_identity_context_invalid");
    }
  }

  function readOwner(): { exists: boolean; record: DesktopOwnerRecord | null } {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(ownerFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, record: null };
      failure("desktop_owner_file_invalid");
    }
    if (stat!.isSymbolicLink() || !stat!.isFile() || stat!.size > 16 * 1024) failure("desktop_owner_file_invalid");
    assertPrivateDirectory();
    assertPrivateOwnerFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    } catch {
      failure("desktop_owner_file_invalid");
    }
    return { exists: true, record: parseOwnerRecord(parsed, identity) };
  }

  function writeOwner(record: DesktopOwnerRecord): void {
    assertPrivateDirectory();
    const text = JSON.stringify(record);
    const temporary = ownerFile + ".tmp-" + randomUUID();
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, text, "utf8");
      fs.fsyncSync(descriptor);
    } catch {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
        descriptor = undefined;
      }
      try { fs.unlinkSync(temporary); } catch { /* never created */ }
      failure("desktop_identity_write_failed");
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
      }
    }
    try {
      fs.renameSync(temporary, ownerFile);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean */ }
      failure("desktop_identity_write_failed");
    }
    // Verify the promoted file itself; inherited entries from the private parent are expected,
    // but an explicit Everyone/Users grant is not.
    assertPrivateOwnerFile();
  }

  async function ownerIsActive(ownerUserId: string): Promise<boolean> {
    const user = await getPrisma().user.findUnique({ where: { id: ownerUserId }, select: { status: true } });
    return user?.status === "ACTIVE";
  }

  /**
   * Best-effort audit trail. Details deliberately carry only the installation id and a fixed
   * source label — never a token, session hash or database credential. An audit failure must not
   * undo an otherwise successful local binding.
   */
  async function auditOwner(action: "desktop.owner_bound" | "desktop.owner_unbound", ownerUserId: string): Promise<void> {
    try {
      await getPrisma().auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerUserId,
          action,
          entityType: "DesktopOwnerBinding",
          entityId: identity.installationId,
          details: { installationId: identity.installationId, source: "desktop" },
        },
      });
    } catch {
      // Auditing is not part of the binding transaction.
    }
  }

  async function status(): Promise<DesktopIdentityStatus> {
    try {
      ensureContext();
      const owner = readOwner();
      if (!owner.exists) return { state: "unbound" };
      // "revoked" stays revoked even if the previous owner was deleted or disabled: the desktop
      // user must be able to finish unbinding and then bind a different account with a fresh
      // Cookie proof. This never selects a new owner by itself.
      if (owner.record!.status === "revoked") return { state: "revoked" };
      if (!(await ownerIsActive(owner.record!.ownerUserId))) return { state: "blocked", code: "desktop_owner_unavailable" };
      return { state: "bound" };
    } catch (error) {
      return { state: "blocked", code: codeOf(error) };
    }
  }

  /** Revokes only the session this device issued, after matching id + owner + stored hash. */
  async function revokeOwnedRef(ownerUserId: string, ref: DesktopSessionRef): Promise<boolean> {
    const prisma = getPrisma();
    const session = await prisma.session.findFirst({
      where: { id: ref.id, userId: ownerUserId, tokenHash: ref.tokenHash },
      select: { id: true, revokedAt: true },
    });
    if (!session) return false;
    if (session.revokedAt) return false;
    const outcome = await revokeSessionForUser({ userId: ownerUserId, sessionId: ref.id });
    return outcome !== "not_found";
  }

  async function initialize(): Promise<DesktopIdentityStatus> {
    ensureContext();
    const owner = readOwner();
    if (owner.exists) return status();
    // Never guess the owner from "the only account": restored/older databases may look fresh.
    if (options.freshUserId === undefined || options.freshUserId === "") return { state: "unbound" };
    if (!UUID_PATTERN.test(options.freshUserId)) failure("desktop_identity_fresh_account_mismatch");
    const prisma = getPrisma();
    // A fresh installation has exactly one account in total; a restored/older database that still
    // holds extra users must not be treated as fresh just because one admin happens to match.
    const totalUsers = await prisma.user.count();
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    if (totalUsers !== 1 || admins.length !== 1 || admins[0]?.id !== options.freshUserId) {
      failure("desktop_identity_fresh_account_mismatch");
    }
    writeOwner({
      format: OWNER_FORMAT,
      version: 1,
      context: identity,
      ownerUserId: options.freshUserId,
      status: "active",
      currentSession: null,
    });
    await auditOwner("desktop.owner_bound", options.freshUserId);
    return { state: "bound" };
  }

  async function bindFromSession(token: string): Promise<DesktopIdentityStatus> {
    ensureContext();
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) failure("desktop_identity_session_invalid");
    const tokenHash = hashSessionToken(token);

    const boundUserId = await getPrisma().$transaction(async (tx) => {
      // The lookup is unlocked; the following row locks make the decision safe against a
      // concurrent reset/disable/revoke.
      const located = await tx.session.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true },
      });
      if (!located) return null;
      const users = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS "status"
        FROM "users"
        WHERE "id" = ${located.userId}::uuid
        FOR UPDATE
      `;
      const sessions = await tx.$queryRaw<Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }>>`
        SELECT "id", "userId", "tokenHash", "expiresAt", "revokedAt"
        FROM "sessions"
        WHERE "id" = ${located.id}::uuid
        FOR UPDATE
      `;
      const user = users[0];
      const session = sessions[0];
      const now = new Date();
      if (!user || user.status !== "ACTIVE") return null;
      if (!session || session.userId !== located.userId || session.tokenHash !== tokenHash) return null;
      if (session.revokedAt !== null) return null;
      if (session.expiresAt.getTime() <= now.getTime()) return null;
      return located.userId;
    });
    if (!boundUserId) failure("desktop_identity_session_invalid");

    const owner = readOwner();
    if (owner.exists && owner.record!.status === "active" && owner.record!.ownerUserId !== boundUserId) {
      failure("desktop_owner_already_bound");
    }
    const previous = owner.exists ? owner.record! : null;
    writeOwner({
      format: OWNER_FORMAT,
      version: 1,
      context: identity,
      ownerUserId: boundUserId,
      status: "active",
      currentSession: previous?.ownerUserId === boundUserId ? previous.currentSession : null,
    });
    await auditOwner("desktop.owner_bound", boundUserId);
    return { state: "bound" };
  }

  async function issueSession(): Promise<DesktopIssuedSession> {
    ensureContext();
    const owner = readOwner();
    if (!owner.exists || owner.record!.status !== "active") failure("desktop_owner_not_bound");
    const record = owner.record!;
    const previous = record.currentSession;

    // Rotate the old cookie first: if its precise revocation fails, keep the existing binding and
    // reference untouched and issue no new token, so no forgotten live cookie can linger.
    if (previous) {
      try {
        await revokeOwnedRef(record.ownerUserId, previous);
      } catch {
        failure("desktop_identity_session_revoke_failed");
      }
    }

    const issued = await createSessionForVerifiedDesktopOwner({
      userId: record.ownerUserId,
      userAgent: DESKTOP_USER_AGENT,
    });
    if (!issued) failure("desktop_owner_unavailable");

    const nextRef: DesktopSessionRef = {
      id: issued.id,
      tokenHash: hashSessionToken(issued.token),
      expiresAt: issued.expiresAt.toISOString(),
    };
    try {
      writeOwner({ ...record, currentSession: nextRef });
    } catch (error) {
      await revokeOwnedRef(record.ownerUserId, nextRef).catch(() => undefined);
      throw error;
    }

    return {
      token: issued.token,
      expiresAt: nextRef.expiresAt,
      cookieName: SESSION_COOKIE_NAME,
      secure: isSecureCookieRuntime(),
    };
  }

  async function unbind(): Promise<DesktopIdentityStatus> {
    ensureContext();
    const owner = readOwner();
    if (!owner.exists) return { state: "unbound" };
    const record = owner.record!;
    if (record.currentSession) await revokeOwnedRef(record.ownerUserId, record.currentSession);
    writeOwner({ ...record, status: "revoked", currentSession: null });
    await auditOwner("desktop.owner_unbound", record.ownerUserId);
    return { state: "revoked" };
  }

  async function revokeCurrentSession(): Promise<DesktopIdentityStatus> {
    ensureContext();
    const owner = readOwner();
    if (!owner.exists) return { state: "unbound" };
    const record = owner.record!;
    if (record.currentSession) {
      await revokeOwnedRef(record.ownerUserId, record.currentSession);
      writeOwner({ ...record, currentSession: null });
    }
    return record.status === "revoked" ? { state: "revoked" } : { state: "bound" };
  }

  return {
    initialize: () => serial(initialize),
    getStatus: () => serial(status),
    bindFromSession: (token: string) => serial(() => bindFromSession(token)),
    issueSession: () => serial(issueSession),
    unbind: () => serial(unbind),
    revokeCurrentSession: () => serial(revokeCurrentSession),
  };
}
