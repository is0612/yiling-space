import { getQuery, setHeader } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { listLocalBrowserRequests } from "../../../utils/local-browser";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const status = getQuery(event).status;
  setHeader(event, "Cache-Control", "no-store");
  return { requests: await listLocalBrowserRequests(typeof status === "string" ? status : "PENDING") };
});
