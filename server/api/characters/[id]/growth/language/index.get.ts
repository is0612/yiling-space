import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parseExpressionHabitListQuery } from "../../../../../utils/expression-habits-domain";
import { listExpressionHabits } from "../../../../../utils/expression-habits";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  return listExpressionHabits(getPrisma(), { ownerId, characterId, ...parseExpressionHabitListQuery(getQuery(event)) });
});
