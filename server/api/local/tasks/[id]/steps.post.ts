import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { LocalObserveError } from "../../../../utils/local-observe";
import { setLocalTaskSteps, updateLocalTaskStep } from "../../../../utils/local-tasks";

export default defineEventHandler(async event => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  const body = await readBody<Record<string, unknown>>(event);
  if (!id || !body || typeof body !== "object" || Array.isArray(body)) throw createError({ statusCode: 400, message: "步骤参数无效。" });
  try {
    const task = body.action === "plan"
      ? await setLocalTaskSteps(id, body.titles, actor.user.id)
      : await updateLocalTaskStep(id, { index: body.index, action: body.action, kind: body.kind, requestId: body.requestId, note: body.note }, actor.user.id);
    return { task };
  } catch (error) {
    if (error instanceof LocalObserveError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
