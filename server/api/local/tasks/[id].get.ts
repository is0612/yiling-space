import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { LocalObserveError } from "../../../utils/local-observe";
import { getLocalTask } from "../../../utils/local-tasks";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少任务 ID。" });
  try {
    return { task: await getLocalTask(id) };
  } catch (error) {
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
