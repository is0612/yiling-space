import { listSessions, readSessionToken, requireActor } from "../../../utils/auth";

/**
 * Device list for the account security page. The session token hash is never returned: the client
 * only receives an opaque id, timestamps and a derived device label.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const sessions = await listSessions({ userId: actor.user.id, currentToken: readSessionToken(event) });
  return { mode: actor.mode, sessions };
});
