import { getRouterParam, getQuery } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { parseGoalListQuery } from "../../../../../../utils/goals-domain";
import { listGoalHistory } from "../../../../../../utils/goals";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const goalId = requireUuid(getRouterParam(event, "goalId") ?? "", "目标");
  const { page, pageSize } = parseGoalListQuery(getQuery(event));
  return listGoalHistory(getPrisma(), { ownerId, characterId, goalId, page, pageSize });
});
