import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { LocalObserveError } from "../../../utils/local-observe";
import { getLocalTask, setLocalTaskAutoContinue } from "../../../utils/local-tasks";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少任务 ID。" });
  const body = await readBody<{ autoContinue?: unknown } | null>(event);
  if (typeof body?.autoContinue !== "boolean") throw createError({ statusCode: 400, statusMessage: "autoContinue 必须是布尔值。" });
  try {
    await setLocalTaskAutoContinue(id, body.autoContinue, actor.user.id);
    return { task: await getLocalTask(id) };
  } catch (error) {
    if (error instanceof LocalObserveError) throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    throw error;
  }
});
