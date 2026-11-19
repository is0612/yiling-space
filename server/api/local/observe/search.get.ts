import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import {
  auditLocalObserve,
  LocalObserveError,
  resolveObserveRoot,
  searchLocalProject,
} from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const query = getQuery(event);
  const rootId = typeof query.rootId === "string" ? query.rootId : "";
  const q = typeof query.q === "string" ? query.q : "";
  const rawPath = typeof query.path === "string" ? query.path : "";
  try {
    const root = await resolveObserveRoot(rootId);
    const result = searchLocalProject(root.path, q, rawPath);
    auditLocalObserve(actor.user.id, "search", {
      rootId: root.id,
      root: root.path,
      path: rawPath,
      query: q,
      matches: result.matches.length,
      scanned: result.scanned,
      truncated: result.truncated,
    });
    return { ...result, root };
  } catch (error) {
    auditLocalObserve(actor.user.id, "search", {
      rootId,
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
