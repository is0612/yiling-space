import { getRouterParam, getQuery, createError } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parseGoalListQuery } from "../../../../../utils/goals-domain";
import { listGoalSources } from "../../../../../utils/goals";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const query = getQuery(event); const type = query.type ?? "MEMORY_EVENT";
  if (type !== "MEMORY_EVENT" && type !== "REFLECTION_SUGGESTION") throw createError({ statusCode: 400, statusMessage: "来源类型无效。" });
  const { q, page, pageSize } = parseGoalListQuery(query);
  return listGoalSources(getPrisma(), { ownerId, characterId, type, q, page, pageSize });
});
