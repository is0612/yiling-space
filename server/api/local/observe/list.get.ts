import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { auditLocalObserve, listLocalDirectory, LocalObserveError } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const raw = getQuery(event).path;
  const pathInput = typeof raw === "string" ? raw : "";
  try {
    const result = listLocalDirectory(pathInput);
    auditLocalObserve(actor.user.id, "list", {
      path: result.path,
      entries: result.entries.length,
      truncated: result.truncated,
    });
    return result;
  } catch (error) {
    auditLocalObserve(actor.user.id, "list", {
      path: pathInput,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
