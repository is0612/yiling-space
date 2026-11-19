import { requireAdminActor } from "../../../utils/auth";
import { listLocalObserveRoots } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  return { roots: await listLocalObserveRoots(false) };
});
