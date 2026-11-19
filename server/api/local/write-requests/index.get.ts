import { getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { listLocalWriteRequests } from "../../../utils/local-write";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const status = getQuery(event).status;
  return { requests: await listLocalWriteRequests(typeof status === "string" ? status : "PENDING") };
});
