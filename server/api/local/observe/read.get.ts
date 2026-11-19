import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { auditLocalObserve, LocalObserveError, readLocalTextFile } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const raw = getQuery(event).path;
  const pathInput = typeof raw === "string" ? raw : "";
  try {
    const result = readLocalTextFile(pathInput);
    auditLocalObserve(actor.user.id, "read", {
      path: result.path,
      bytes: result.size,
      lines: result.lines,
    });
    return result;
  } catch (error) {
    auditLocalObserve(actor.user.id, "read", {
      path: pathInput,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
