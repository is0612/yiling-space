import { resolveActorContext } from "../../utils/auth";

/**
 * Current session state for the web UI. Returns 200 with `user: null` for anonymous visitors so the
 * login page can render instead of treating "not logged in" as an error.
 */
export default defineEventHandler(async (event) => {
  const actor = await resolveActorContext(event);
  if (actor.mode === "anonymous") {
    return { mode: "anonymous" as const, reason: actor.reason, user: null };
  }
  return { mode: actor.mode, reason: null, user: actor.user };
});
