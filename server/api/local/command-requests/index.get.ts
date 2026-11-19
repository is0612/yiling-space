import { getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { listLocalCommandRequests } from "../../../utils/local-command";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const status = getQuery(event).status;
  return { requests: await listLocalCommandRequests(typeof status === "string" ? status : "PENDING") };
});
