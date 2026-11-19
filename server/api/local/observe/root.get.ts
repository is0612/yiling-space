import { requireAdminActor } from "../../../utils/auth";
import { localObserveRootInfo } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  return localObserveRootInfo();
});
