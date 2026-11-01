import { readSessionToken, requireActorUserId, revokeOtherSessions } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

/** Signs out every other device while keeping the current session alive. */
export default defineEventHandler(async (event) => {
  const userId = await requireActorUserId(event);
  const revoked = await revokeOtherSessions({ userId, currentToken: readSessionToken(event) });

  if (revoked > 0) {
    await getPrisma()
      .auditLog.create({
        data: {
          actorType: "USER",
          actorId: userId,
          action: "auth.sessions_revoked",
          entityType: "Session",
          details: { revoked },
        },
      })
      .catch(() => undefined);
  }

  return { revoked };
});
