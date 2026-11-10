import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { addGoalProgress } from "../../../../../../utils/goals";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const goalId = requireUuid(getRouterParam(event, "goalId") ?? "", "目标");
  return addGoalProgress(getPrisma(), { ownerId, characterId, goalId, body: await readBody(event) });
});
