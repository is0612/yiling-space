import { createError, getRouterParam, readBody } from "h3";
import {
  checkPasswordPolicy,
  hashPassword,
  passwordPolicyMessage,
  requireAdminActor,
  revokeOtherSessions,
} from "../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

const ALLOWED_STATUSES = new Set(["ACTIVE", "DISABLED"]);

/**
 * Administrator maintenance of an account: display name, enabled/disabled state, and a forced
 * password reset (for a user who forgot theirs). There is no role editing here — the model is one
 * administrator plus ordinary users.
 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const targetId = requireUuid(getRouterParam(event, "id") ?? "", "用户");
  const body = await readBody<Record<string, unknown>>(event);

  const displayName = readTrimmedString(body?.displayName, "显示名", 120);
  const rawStatus = typeof body?.status === "string" ? body.status : "";
  const password = typeof body?.password === "string" && body.password.length > 0 ? body.password : "";

  if (!displayName && !rawStatus && !password) {
    throw createError({ statusCode: 400, statusMessage: "没有需要更新的内容。" });
  }
  if (rawStatus && !ALLOWED_STATUSES.has(rawStatus)) {
    throw createError({ statusCode: 400, statusMessage: "无效的账号状态。" });
  }
  if (password) {
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) {
      throw createError({ statusCode: 400, statusMessage: passwordPolicyMessage(policy.reason) });
    }
  }

  const prisma = getPrisma();
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, status: true, role: true },
  });
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: "用户不存在。" });
  }

  const disabling = rawStatus === "DISABLED";
  if (disabling && target.id === admin.user.id) {
    throw createError({ statusCode: 400, statusMessage: "不能停用自己的账号。" });
  }
  if (disabling && target.role === "ADMIN") {
    // Never leave the system without a working administrator.
    const otherAdmins = await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE", id: { not: target.id } } });
    if (otherAdmins === 0) {
      throw createError({ statusCode: 400, statusMessage: "至少需要保留一个可用的管理员账号。" });
    }
  }

  const data: { displayName?: string | null; status?: "ACTIVE" | "DISABLED"; passwordHash?: string } = {};
  if (displayName) data.displayName = displayName;
  if (rawStatus) data.status = rawStatus as "ACTIVE" | "DISABLED";
  if (password) data.passwordHash = await hashPassword(password);

  await prisma.user.update({ where: { id: targetId }, data });

  if (disabling) {
    await revokeOtherSessions({ userId: targetId });
  }

  await prisma.auditLog
    .create({
      data: {
        actorType: "USER",
        actorId: admin.user.id,
        action: "admin.user_updated",
        entityType: "User",
        entityId: targetId,
        details: { fields: Object.keys(data), disabled: disabling },
      },
    })
    .catch(() => undefined);

  return { updated: true };
});
