import { createError, getRouterParam, setHeader } from "h3";
import {
  buildClearSessionCookie,
  readSessionToken,
  requireActorUserId,
  revokeSessionForUser,
} from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/**
 * Revokes one session of the acting account. Revoking the session you are currently using also
 * clears the cookie, so the browser does not keep presenting a dead token.
 */
export default defineEventHandler(async (event) => {
  const userId = await requireActorUserId(event);
  const sessionId = requireUuid(getRouterParam(event, "id") ?? "", "会话");

  const outcome = await revokeSessionForUser({ userId, sessionId, currentToken: readSessionToken(event) });
  if (outcome === "not_found") {
    // A session belonging to another account must be indistinguishable from a missing one.
    throw createError({ statusCode: 404, statusMessage: "会话不存在或已经失效。" });
  }

  await getPrisma()
    .auditLog.create({
      data: {
        actorType: "USER",
        actorId: userId,
        action: "auth.session_revoked",
        entityType: "Session",
        entityId: sessionId,
        details: { selfRevoked: outcome === "revoked_current" },
      },
    })
    .catch(() => undefined);

  const currentRevoked = outcome === "revoked_current";
  if (currentRevoked) setHeader(event, "set-cookie", buildClearSessionCookie());
  return { revoked: true, currentRevoked };
});
