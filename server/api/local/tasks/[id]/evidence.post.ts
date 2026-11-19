import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { LocalObserveError } from "../../../../utils/local-observe";
import { recordLocalTaskEvidence } from "../../../../utils/local-tasks";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少任务 ID。" });
  const body = await readBody<{ outcome?: unknown; note?: unknown; kind?: unknown }>(event).catch(() => null);
  try {
    return await recordLocalTaskEvidence(id, {
      outcome: body?.outcome, note: body?.note, kind: body?.kind, actorId: actor.user.id,
    });
  } catch (error) {
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
