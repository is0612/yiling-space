import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import {
  auditLocalObserve,
  LocalObserveError,
  readLocalTextFile,
  resolveObserveRoot,
} from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const query = getQuery(event);
  const rootId = typeof query.rootId === "string" ? query.rootId : "";
  const pathInput = typeof query.path === "string" ? query.path : "";
  try {
    const root = await resolveObserveRoot(rootId);
    const result = readLocalTextFile(root.path, pathInput);
    auditLocalObserve(actor.user.id, "read", {
      rootId: root.id,
      root: root.path,
      path: result.path,
      bytes: result.size,
      lines: result.lines,
    });
    return { ...result, root };
  } catch (error) {
    auditLocalObserve(actor.user.id, "read", {
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
