import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { createGitBranchRequest } from "../../../utils/local-command";
import { LocalObserveError } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const body = await readBody<Record<string, unknown>>(event);
  const { rootId, cwd = "", branch, reason, taskId } = body ?? {};
  if (typeof rootId !== "string" || typeof cwd !== "string" || cwd.length > 500
    || typeof branch !== "string" || typeof reason !== "string" || reason.length > 500
    || (taskId !== undefined && (typeof taskId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(taskId)))) {
    throw createError({ statusCode: 400, statusMessage: "新建分支参数无效。" });
  }
  try {
    const request = await createGitBranchRequest({ rootId, cwd, branch, reason, actorId: actor.user.id, ...(taskId ? { taskId } : {}) });
    return { requestId: request.id, status: request.status };
  } catch (error) {
    if (error instanceof LocalObserveError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
