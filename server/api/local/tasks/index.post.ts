import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { LocalObserveError } from "../../../utils/local-observe";
import { createLocalTask } from "../../../utils/local-tasks";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const body = await readBody<{ title?: unknown; goal?: unknown; plan?: unknown }>(event).catch(() => null);
  try {
    return {
      task: await createLocalTask({
        title: typeof body?.title === "string" ? body.title : "",
        goal: typeof body?.goal === "string" ? body.goal : "",
        plan: typeof body?.plan === "string" ? body.plan : "",
        actorId: actor.user.id,
      }),
    };
  } catch (error) {
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
