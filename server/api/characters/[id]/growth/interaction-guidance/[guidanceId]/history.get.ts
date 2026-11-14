import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { listInteractionGuidanceHistory, parseInteractionGuidanceListQuery } from "../../../../../../utils/interaction-guidance";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const guidanceId = requireUuid(getRouterParam(event, "guidanceId") ?? "", "互动指导");
  const { page, pageSize } = parseInteractionGuidanceListQuery(getQuery(event));
  return listInteractionGuidanceHistory(getPrisma(), { ownerId, characterId, guidanceId, page, pageSize });
});
