import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parseExpressionHabitListQuery } from "../../../../../utils/expression-habits-domain";
import { listExpressionHabitSources } from "../../../../../utils/expression-habits";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const query = getQuery(event); const type = query.type ?? "MEMORY_EVENT";
  if (type !== "MEMORY_EVENT" && type !== "REFLECTION_SUGGESTION") throw createError({ statusCode: 400, statusMessage: "表达习惯来源类型无效。" });
  const { page, pageSize, q } = parseExpressionHabitListQuery(query);
  return listExpressionHabitSources(getPrisma(), { ownerId, characterId, type, page, pageSize, q });
});
