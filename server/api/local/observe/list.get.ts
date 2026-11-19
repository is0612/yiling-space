import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import {
  auditLocalObserve,
  listLocalDirectory,
  LocalObserveError,
  resolveObserveRoot,
} from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const query = getQuery(event);
  const rootId = typeof query.rootId === "string" ? query.rootId : "";
  const pathInput = typeof query.path === "string" ? query.path : "";
  try {
    const root = await resolveObserveRoot(rootId);
    const result = listLocalDirectory(root.path, pathInput);
    auditLocalObserve(actor.user.id, "list", {
      rootId: root.id,
      root: root.path,
      path: result.path,
      entries: result.entries.length,
      truncated: result.truncated,
    });
    return { ...result, root };
  } catch (error) {
    auditLocalObserve(actor.user.id, "list", {
      rootId,
      path: pathInput,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
