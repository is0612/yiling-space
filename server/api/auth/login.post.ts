import { createError, getHeader, readBody, setHeader } from "h3";
import {
  DUMMY_PASSWORD_HASH,
  buildSessionCookie,
  clientAddressOf,
  countRecentLoginFailures,
  createSessionForVerifiedPassword,
  isLoginThrottled,
  readPasswordField,
  recordLoginAttempt,
  revokeExpiredSessions,
  sessionTtlMs,
  verifyPassword,
} from "../../utils/auth";
import { readTrimmedString } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event);
  const username = readTrimmedString(body?.username, "用户名", 100, { required: true });
  const password = readPasswordField(body?.password, "密码");

  const ip = clientAddressOf(event);
  const failures = await countRecentLoginFailures({ username, ip });
  if (isLoginThrottled(failures)) {
    throw createError({ statusCode: 429, statusMessage: "登录尝试过于频繁，请稍后再试。" });
  }

  const prisma = getPrisma();
  const account = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, displayName: true, status: true, role: true, passwordHash: true },
  });
  const passwordMatches = await verifyPassword(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  const authenticated = Boolean(account) && passwordMatches && account?.status === "ACTIVE";

  if (!authenticated || !account) {
    await recordLoginAttempt({ username, ip, succeeded: false });
    await prisma.auditLog
      .create({
        data: {
          actorType: "USER",
          actorId: account?.id ?? null,
          action: "auth.login_failed",
          entityType: "User",
          entityId: account?.id ?? null,
          details: { username },
        },
      })
      .catch(() => undefined);
    throw createError({ statusCode: 401, statusMessage: "用户名或密码不正确。" });
  }

  // 密码校验通过不等于还能登录：管理员可能刚好重置了密码或停用了账号。
  // 建会话时再比对一次密码哈希（并对账号行加锁），避免旧密码在重置之后仍然开出会话。
  const session = await createSessionForVerifiedPassword({
    userId: account.id,
    expectedPasswordHash: account.passwordHash,
    ip,
    userAgent: getHeader(event, "user-agent") ?? undefined,
  });
  if (!session) {
    await recordLoginAttempt({ username, ip, succeeded: false });
    await prisma.auditLog
      .create({
        data: {
          actorType: "USER",
          actorId: account.id,
          action: "auth.login_failed",
          entityType: "User",
          entityId: account.id,
          details: { username, reason: "credentials_changed" },
        },
      })
      .catch(() => undefined);
    throw createError({ statusCode: 401, statusMessage: "用户名或密码不正确。" });
  }

  await recordLoginAttempt({ username, ip, succeeded: true });
  setHeader(event, "set-cookie", buildSessionCookie(session.token, sessionTtlMs()));
  await revokeExpiredSessions().catch(() => undefined);
  await prisma.auditLog
    .create({
      data: {
        actorType: "USER",
        actorId: account.id,
        action: "auth.login",
        entityType: "User",
        entityId: account.id,
        details: { username: account.username },
      },
    })
    .catch(() => undefined);

  return {
    user: { id: account.id, username: account.username, displayName: account.displayName, role: account.role },
    expiresAt: session.expiresAt.toISOString(),
  };
});
