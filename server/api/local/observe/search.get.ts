import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { auditLocalObserve, LocalObserveError, searchLocalProject } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q : "";
  const rawPath = typeof query.path === "string" ? query.path : "";
  try {
    const result = searchLocalProject(q, rawPath);
    auditLocalObserve(actor.user.id, "search", {
      path: rawPath,
      query: q,
      matches: result.matches.length,
      scanned: result.scanned,
      truncated: result.truncated,
    });
    return result;
  } catch (error) {
    auditLocalObserve(actor.user.id, "search", {
      path: rawPath,
      query: q,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
