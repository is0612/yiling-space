import { getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { listLocalTasks } from "../../../utils/local-tasks";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const status = getQuery(event).status;
  return { tasks: await listLocalTasks(typeof status === "string" ? status : "") };
});
