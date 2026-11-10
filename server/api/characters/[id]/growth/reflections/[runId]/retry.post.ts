import { getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { retryReflection } from "../../../../../../utils/reflection-service";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const runId = requireUuid(getRouterParam(event, "runId") ?? "", "反思任务");
  return retryReflection(getPrisma(), { ownerId, characterId, runId });
});
