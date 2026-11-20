import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { LocalObserveError } from "../../../../utils/local-observe";
import { rejectLocalBrowserRequest } from "../../../../utils/local-browser";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少请求 ID。" });
  const body = await readBody<{ reason?: unknown } | null>(event).catch(() => null);
  try {
    return { request: await rejectLocalBrowserRequest(id, actor.user.id, typeof body?.reason === "string" ? body.reason : "") };
  } catch (error) {
    if (error instanceof LocalObserveError) throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    throw error;
  }
});
