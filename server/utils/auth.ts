import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createError, getHeader, getRequestURL, type H3Event } from "h3";
import { getPrisma } from "./prisma";

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE_NAME = "yiling_session";
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_LAST_USED_REFRESH_MS = 5 * 60 * 1000;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT_PER_USER = 5;
export const LOGIN_FAILURE_LIMIT_PER_IP = 20;
export const LOGIN_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MIN_SESSION_TTL_HOURS = 1;
export const MAX_SESSION_TTL_HOURS = 720;
export const DEFAULT_SESSION_TTL_HOURS = 12;

export type AuthMode = "session" | "local-dev" | "anonymous";

export type UserRoleValue = "ADMIN" | "USER";

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRoleValue;
};

export type ActorContext =
  | { mode: "session"; user: AuthenticatedUser }
  | { mode: "local-dev"; user: AuthenticatedUser }
  | { mode: "anonymous"; reason: "missing_session" | "invalid_session" | "disabled_user"; user: null };

// ---------------------------------------------------------------------------
// Password hashing (scrypt; the format matches scripts/seed-dev-user.ts)
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return "scrypt$" + salt.toString("base64url") + "$" + derived.toString("base64url");
}

function parseStoredPasswordHash(storedHash: string): { salt: Buffer; digest: Buffer } | null {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  const salt = Buffer.from(parts[1] ?? "", "base64url");
  const digest = Buffer.from(parts[2] ?? "", "base64url");
  if (salt.length < 8 || digest.length !== 64) return null;
  return { salt, digest };
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredPasswordHash(storedHash);
  if (!parsed) return false;
  const derived = await scrypt(password, parsed.salt, parsed.digest.length) as Buffer;
  return derived.length === parsed.digest.length && timingSafeEqual(derived, parsed.digest);
}

/**
 * Verified against this constant when the account does not exist, so a missing user and a wrong
 * password take comparable time and cannot be told apart by latency.
 */
export const DUMMY_PASSWORD_HASH = "scrypt$1NXKk3kzK9HVvczz_d_I4Q$NrOGKeahE3B0LhCEErUpuOa1gMif9MMfKSeN_8hw5DKBSkgAJb7TtwsVvtF3VCll9RUGfpUp6KK1saQ_w-0wug";

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordPolicyViolation = "too_short" | "too_long" | "needs_letter" | "needs_digit" | "reused";

export type PasswordPolicyDecision = { ok: true } | { ok: false; reason: PasswordPolicyViolation };

/**
 * Rules for a *new* password. Existing passwords are never re-validated, so tightening the policy
 * cannot lock out an account that was created under an older one.
 */
export function checkPasswordPolicy(password: string, currentPassword?: string): PasswordPolicyDecision {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: "too_long" };
  if (!/[A-Za-z]/.test(password)) return { ok: false, reason: "needs_letter" };
  if (!/[0-9]/.test(password)) return { ok: false, reason: "needs_digit" };
  if (currentPassword !== undefined && password === currentPassword) return { ok: false, reason: "reused" };
  return { ok: true };
}

export function passwordPolicyMessage(reason: PasswordPolicyViolation): string {
  switch (reason) {
    case "too_short":
      return `新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`;
    case "too_long":
      return `新密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符。`;
    case "needs_letter":
      return "新密码必须包含至少一个字母。";
    case "needs_digit":
      return "新密码必须包含至少一个数字。";
    case "reused":
      return "新密码不能与当前密码相同。";
  }
}

export function readPasswordField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能为空。` });
  }
  if (value.length > 4096) {
    throw createError({ statusCode: 400, statusMessage: `${label}长度超出限制。` });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashClientAddress(address: string): string {
  return createHash("sha256").update("yiling-ip:" + address, "utf8").digest("hex");
}

export function sessionTtlMs(): number {
  const raw = Number(process.env.AUTH_SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw >= MIN_SESSION_TTL_HOURS && raw <= MAX_SESSION_TTL_HOURS
    ? raw
    : DEFAULT_SESSION_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function isSecureCookieRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YILING_COOKIE_SECURE === "true";
}

export function buildSessionCookie(token: string, ttlMs: number, secure = isSecureCookieRuntime()): string {
  const attributes = [
    SESSION_COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + Math.max(1, Math.floor(ttlMs / 1000)),
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function buildClearSessionCookie(secure = isSecureCookieRuntime()): string {
  const attributes = [SESSION_COOKIE_NAME + "=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readSessionToken(event: H3Event): string {
  const header = getHeader(event, "cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return value;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

export function isLoginThrottled(input: {
  userFailures: number;
  ipFailures: number;
  perUserLimit?: number;
  perIpLimit?: number;
}): boolean {
  const perUser = input.perUserLimit ?? LOGIN_FAILURE_LIMIT_PER_USER;
  const perIp = input.perIpLimit ?? LOGIN_FAILURE_LIMIT_PER_IP;
  return input.userFailures >= perUser || input.ipFailures >= perIp;
}

// ---------------------------------------------------------------------------
// Actor resolution
// ---------------------------------------------------------------------------

/**
 * Decides who is acting on a request. A presented-but-invalid session never silently falls back to
 * the local development user: an expired or revoked cookie must be re-authenticated.
 */
export function resolveActor(input: {
  hasSessionCookie: boolean;
  sessionUser: AuthenticatedUser | null;
  localDevUser: AuthenticatedUser | null;
}): ActorContext {
  if (input.hasSessionCookie) {
    return input.sessionUser
      ? { mode: "session", user: input.sessionUser }
      : { mode: "anonymous", reason: "invalid_session", user: null };
  }
  if (input.localDevUser) return { mode: "local-dev", user: input.localDevUser };
  return { mode: "anonymous", reason: "missing_session", user: null };
}

export function isDevOwnerBypassEnabled(): boolean {
  return process.env.YILING_ALLOW_DEV_OWNER_BYPASS !== "false";
}

function isLoopbackRequest(event: H3Event): boolean {
  const hostHeader = (getHeader(event, "host") ?? "").toLowerCase();
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : (hostHeader.split(":")[0] ?? "");
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

/**
 * The local development owner is a development-only convenience: it requires the dev server,
 * the explicit local API flag, a loopback Host header and the bypass toggle. Production builds
 * never satisfy `import.meta.dev`, so this path cannot exist there.
 */
export function canUseLocalDevOwner(event: H3Event): boolean {
  return Boolean(import.meta.dev)
    && process.env.YILING_LOCAL_API_ENABLED === "true"
    && isDevOwnerBypassEnabled()
    && isLoopbackRequest(event);
}

export async function findLocalDevUser(): Promise<AuthenticatedUser | null> {
  const ownerId = process.env.DEV_OWNER_ID;
  if (!ownerId) return null;
  const user = await getPrisma().user.findUnique({
    where: { id: ownerId },
    select: { id: true, username: true, displayName: true, status: true, role: true },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

export async function resolveSessionUser(token: string): Promise<AuthenticatedUser | null> {
  const prisma = getPrisma();
  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, username: true, displayName: true, status: true, role: true } },
    },
  });
  if (!session) return null;
  if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return null;
  if (session.user.status !== "ACTIVE") return null;

  // Touch the session at most every few minutes so a busy client does not write on every request.
  if (now.getTime() - session.lastUsedAt.getTime() > SESSION_LAST_USED_REFRESH_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: now } }).catch(() => undefined);
  }
  return { id: session.user.id, username: session.user.username, displayName: session.user.displayName, role: session.user.role };
}

export async function resolveActorContext(event: H3Event): Promise<ActorContext> {
  const token = readSessionToken(event);
  const sessionUser = token ? await resolveSessionUser(token) : null;
  const localDevUser = !token && canUseLocalDevOwner(event) ? await findLocalDevUser() : null;
  return resolveActor({ hasSessionCookie: Boolean(token), sessionUser, localDevUser });
}

export async function requireActor(event: H3Event): Promise<Extract<ActorContext, { mode: "session" | "local-dev" }>> {
  const actor = await resolveActorContext(event);
  if (actor.mode === "anonymous") {
    if (actor.reason === "invalid_session") {
      throw createError({ statusCode: 401, statusMessage: "登录状态已失效，请重新登录。" });
    }
    throw createError({ statusCode: 401, statusMessage: "请先登录后再访问该接口。" });
  }
  return actor;
}

export async function requireActorUserId(event: H3Event): Promise<string> {
  const actor = await requireActor(event);
  return actor.user.id;
}

// ---------------------------------------------------------------------------
// Administrator gate
// ---------------------------------------------------------------------------

export function canAdminister(role: UserRoleValue | null | undefined): boolean {
  return role === "ADMIN";
}

/**
 * Self-registration is opt-in: it stays closed until the operator explicitly enables it on the
 * deployed server, so a local instance or an accidentally exposed one does not accept strangers.
 */
export function isRegistrationEnabled(): boolean {
  return process.env.YILING_ALLOW_REGISTRATION === "true";
}

export async function requireAdminActor(event: H3Event): Promise<Extract<ActorContext, { mode: "session" | "local-dev" }>> {
  const actor = await requireActor(event);
  if (actor.user.role !== "ADMIN") {
    throw createError({ statusCode: 403, statusMessage: "该操作仅限管理员。" });
  }
  return actor;
}

// ---------------------------------------------------------------------------
// Session and login-attempt persistence
// ---------------------------------------------------------------------------

export async function createSession(input: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const ttlMs = sessionTtlMs();
  const expiresAt = new Date(Date.now() + ttlMs);
  await getPrisma().session.create({
    data: {
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ipHash: input.ip ? hashClientAddress(input.ip) : null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 255) : null,
    },
    select: { id: true },
  });
  return { token, expiresAt };
}

export async function revokeSessionByToken(token: string): Promise<boolean> {
  if (!token) return false;
  const result = await getPrisma().session.updateMany({
    where: { tokenHash: hashSessionToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export async function recordLoginAttempt(input: {
  username: string;
  ip: string;
  succeeded: boolean;
}): Promise<void> {
  const prisma = getPrisma();
  await prisma.loginAttempt.create({
    data: {
      username: input.username.slice(0, 100),
      ipHash: hashClientAddress(input.ip),
      succeeded: input.succeeded,
    },
  });
  if (input.succeeded) {
    // A successful login clears that account's failure history.
    await prisma.loginAttempt.deleteMany({ where: { username: input.username.slice(0, 100), succeeded: false } });
  }
  // Opportunistic retention: keep the table small without a scheduled job.
  await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - LOGIN_ATTEMPT_RETENTION_MS) } },
  }).catch(() => undefined);
}

export async function countRecentLoginFailures(input: {
  username: string;
  ip: string;
}): Promise<{ userFailures: number; ipFailures: number }> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - LOGIN_FAILURE_WINDOW_MS);
  const ipHash = hashClientAddress(input.ip);
  const [userFailures, ipFailures] = await Promise.all([
    prisma.loginAttempt.count({ where: { username: input.username.slice(0, 100), succeeded: false, createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { ipHash, succeeded: false, createdAt: { gte: since } } }),
  ]);
  return { userFailures, ipFailures };
}

export async function revokeExpiredSessions(): Promise<number> {
  const result = await getPrisma().session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
        { revokedAt: { not: null, lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}

export function clientAddressOf(event: H3Event): string {
  // Nuxt/nitro populates this from the socket or the trusted proxy configuration. Never trust a
  // client-supplied X-Forwarded-For unless the deployment explicitly configures a proxy.
  const address = event.node?.req?.socket?.remoteAddress;
  if (address) return address;
  try {
    return getRequestURL(event).hostname;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Session management (device list, revocation, password change)
// ---------------------------------------------------------------------------

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export type DeviceDescription = { label: string; kind: DeviceKind };

/**
 * Turns a User-Agent string into something a person can recognise in a device list. This is a
 * display aid only: no security decision may depend on it, and the raw string is never returned
 * to the client.
 */
export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  const ua = (userAgent ?? "").trim();
  if (!ua) return { label: "未知设备", kind: "unknown" };

  // iPad reports "Macintosh" with "Mobile", so the tablet checks must run before the mobile ones.
  const kind: DeviceKind = /iPad|Tablet/i.test(ua)
    ? "tablet"
    : /iPhone|iPod|Mobile|Android/i.test(ua)
      ? "mobile"
      : "desktop";

  let platform = "";
  if (/Windows NT/i.test(ua)) platform = "Windows";
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = "iOS";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/Mac OS X|Macintosh/i.test(ua)) platform = "macOS";
  else if (/Linux/i.test(ua)) platform = "Linux";

  let browser = "";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS/i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  const label = [platform, browser].filter(Boolean).join(" · ") || "未知设备";
  return { label, kind };
}

export type SessionSummary = {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  device: DeviceDescription;
};

/**
 * Active sessions for one account. `tokenHash` never leaves the server; only the opaque session id
 * and display metadata are returned.
 */
export async function listSessions(input: { userId: string; currentToken?: string }): Promise<SessionSummary[]> {
  const currentHash = input.currentToken ? hashSessionToken(input.currentToken) : "";
  const sessions = await getPrisma().session.findMany({
    where: { userId: input.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, tokenHash: true, createdAt: true, lastUsedAt: true, expiresAt: true, userAgent: true },
  });
  return sessions.map((session) => ({
    id: session.id,
    current: currentHash.length > 0 && session.tokenHash === currentHash,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    device: describeUserAgent(session.userAgent),
  }));
}

export type RevokeSessionOutcome = "revoked" | "revoked_current" | "not_found";

/**
 * Revokes one session, but only if it belongs to the acting account: a valid session id from
 * another account must look exactly like a missing one.
 */
export async function revokeSessionForUser(input: {
  userId: string;
  sessionId: string;
  currentToken?: string;
}): Promise<RevokeSessionOutcome> {
  const prisma = getPrisma();
  const currentHash = input.currentToken ? hashSessionToken(input.currentToken) : "";
  const session = await prisma.session.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, tokenHash: true, revokedAt: true },
  });
  if (!session || session.revokedAt) return "not_found";

  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  return currentHash.length > 0 && session.tokenHash === currentHash ? "revoked_current" : "revoked";
}

/** Revokes every active session of the account except the one making the request. */
export async function revokeOtherSessions(input: { userId: string; currentToken?: string }): Promise<number> {
  const currentHash = input.currentToken ? hashSessionToken(input.currentToken) : "";
  const result = await getPrisma().session.updateMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      ...(currentHash.length > 0 ? { tokenHash: { not: currentHash } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Changes the account password and revokes every other session, so a stolen cookie stops working
 * the moment the owner resets their password. The session performing the change stays valid,
 * otherwise the user would be thrown out of the page they are standing on.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  currentToken?: string;
}): Promise<{ revokedSessions: number }> {
  const prisma = getPrisma();
  const account = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, passwordHash: true, status: true },
  });

  // Always run the comparison, so "no such account" and "wrong password" cost the same.
  const currentMatches = await verifyPassword(input.currentPassword, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!account || !currentMatches || account.status !== "ACTIVE") {
    throw createError({ statusCode: 400, statusMessage: "当前密码不正确。" });
  }

  const policy = checkPasswordPolicy(input.newPassword, input.currentPassword);
  if (!policy.ok) {
    throw createError({ statusCode: 400, statusMessage: passwordPolicyMessage(policy.reason) });
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: account.id }, data: { passwordHash } });
  const revokedSessions = await revokeOtherSessions({ userId: account.id, currentToken: input.currentToken });
  return { revokedSessions };
}
