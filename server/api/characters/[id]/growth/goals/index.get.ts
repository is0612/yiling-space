import { getRouterParam, getQuery } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parseGoalListQuery } from "../../../../../utils/goals-domain";
import { listGoals } from "../../../../../utils/goals";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  return listGoals(getPrisma(), { ownerId, characterId, ...parseGoalListQuery(getQuery(event)) });
});
