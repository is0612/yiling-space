import { createError, getHeader, readBody, setHeader } from "h3";
import {
  buildSessionCookie,
  checkPasswordPolicy,
  clientAddressOf,
  countRecentLoginFailures,
  createSession,
  hashClientAddress,
  hashPassword,
  isLoginThrottled,
  isRegistrationEnabled,
  passwordPolicyMessage,
  readPasswordField,
  recordLoginAttempt,
  sessionTtlMs,
} from "../../utils/auth";
import { readTrimmedString } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 100;

function normalizeEmail(value: unknown): string {
  const email = readTrimmedString(value, "邮箱", MAX_EMAIL_LENGTH, { required: true }).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw createError({ statusCode: 400, statusMessage: "邮箱格式不正确。" });
  }
  return email;
}

/**
 * Self-registration, enabled only when the operator opts in (YILING_ALLOW_REGISTRATION=true). The
 * email address is the account identifier: it is stored both in the `email` column and (as the
 * login handle) in `username`, so the existing login endpoint accepts it with no change. No
 * verification email is sent — this deployment has no SMTP by design; a verify step can be added
 * later behind another opt-in flag.
 */
export default defineEventHandler(async (event) => {
  if (!isRegistrationEnabled()) {
    throw createError({ statusCode: 403, statusMessage: "当前未开放自助注册。" });
  }

  const body = await readBody<Record<string, unknown>>(event);
  const email = normalizeEmail(body?.email);
  const password = readPasswordField(body?.password, "密码");
  const displayName = readTrimmedString(body?.displayName, "显示名", 120) || email.split("@")[0];

  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    throw createError({ statusCode: 400, statusMessage: passwordPolicyMessage(policy.reason) });
  }

  const ip = clientAddressOf(event);
  const failures = await countRecentLoginFailures({ username: email, ip });
  if (isLoginThrottled(failures)) {
    throw createError({ statusCode: 429, statusMessage: "注册尝试过于频繁，请稍后再试。" });
  }

  const prisma = getPrisma();
  const existing = await prisma.user.findFirst({
    where: { OR: [{ username: email }, { email }] },
    select: { id: true },
  });
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: "该邮箱已注册，请直接登录。" });
  }

  const user = await prisma.user.create({
    data: {
      username: email,
      email,
      passwordHash: await hashPassword(password),
      displayName: displayName || null,
      role: "USER",
      status: "ACTIVE",
      registrationIpHash: hashClientAddress(ip),
    },
    select: { id: true, username: true, displayName: true, role: true },
  });

  await recordLoginAttempt({ username: email, ip, succeeded: true });

  const session = await createSession({ userId: user.id, ip, userAgent: getHeader(event, "user-agent") ?? undefined });
  setHeader(event, "set-cookie", buildSessionCookie(session.token, sessionTtlMs()));

  await prisma.auditLog
    .create({
      data: {
        actorType: "USER",
        actorId: user.id,
        action: "auth.register",
        entityType: "User",
        entityId: user.id,
        details: { email },
      },
    })
    .catch(() => undefined);

  return { user, expiresAt: session.expiresAt.toISOString() };
});
