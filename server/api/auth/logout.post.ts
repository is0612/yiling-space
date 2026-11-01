import { setHeader, setResponseStatus } from "h3";
import { buildClearSessionCookie, readSessionToken, resolveSessionUser, revokeSessionByToken } from "../../utils/auth";
import { getPrisma } from "../../utils/prisma";

/**
 * Revokes the presented session (if any) and clears the cookie. Always succeeds so a stale or
 * already-revoked cookie cannot trap the browser in a logged-in state.
 */
export default defineEventHandler(async (event) => {
  const token = readSessionToken(event);
  if (token) {
    const user = await resolveSessionUser(token);
    if (user) {
      await revokeSessionByToken(token);
      await getPrisma()
        .auditLog.create({
          data: {
            actorType: "USER",
            actorId: user.id,
            action: "auth.logout",
            entityType: "User",
            entityId: user.id,
          },
        })
        .catch(() => undefined);
    }
  }
  setHeader(event, "set-cookie", buildClearSessionCookie());
  setResponseStatus(event, 204);
  return null;
});
