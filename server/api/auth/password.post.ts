import { readBody } from "h3";
import { changePassword, readPasswordField, readSessionToken, requireActorUserId } from "../../utils/auth";
import { getPrisma } from "../../utils/prisma";

/**
 * Changes the administrator password. Every other session is revoked on success; the session that
 * performed the change stays valid so the user is not thrown out of the page.
 */
export default defineEventHandler(async (event) => {
  const userId = await requireActorUserId(event);
  const body = await readBody<Record<string, unknown>>(event);
  const currentPassword = readPasswordField(body?.currentPassword, "当前密码");
  const newPassword = readPasswordField(body?.newPassword, "新密码");

  const result = await changePassword({
    userId,
    currentPassword,
    newPassword,
    currentToken: readSessionToken(event),
  });

  await getPrisma()
    .auditLog.create({
      data: {
        actorType: "USER",
        actorId: userId,
        action: "auth.password_changed",
        entityType: "User",
        entityId: userId,
        details: { revokedSessions: result.revokedSessions },
      },
    })
    .catch(() => undefined);

  return { changed: true, revokedSessions: result.revokedSessions };
});
