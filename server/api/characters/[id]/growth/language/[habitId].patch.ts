import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { updateExpressionHabit } from "../../../../../utils/expression-habits";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const habitId = requireUuid(getRouterParam(event, "habitId") ?? "", "表达习惯");
  return updateExpressionHabit(getPrisma(), { ownerId, characterId, habitId, body: await readBody(event) });
});
