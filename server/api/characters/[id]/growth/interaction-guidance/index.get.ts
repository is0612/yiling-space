import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { listInteractionGuidance, parseInteractionGuidanceListQuery } from "../../../../../utils/interaction-guidance";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  return listInteractionGuidance(getPrisma(), { ownerId, characterId, ...parseInteractionGuidanceListQuery(getQuery(event)) });
});
