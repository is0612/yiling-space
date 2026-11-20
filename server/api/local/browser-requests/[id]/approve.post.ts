import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { LocalObserveError } from "../../../../utils/local-observe";
import { approveLocalBrowserRequest } from "../../../../utils/local-browser";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少请求 ID。" });
  try {
    return { request: await approveLocalBrowserRequest(id, actor.user.id) };
  } catch (error) {
    if (error instanceof LocalObserveError) throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    throw error;
  }
});
