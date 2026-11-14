import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { updateInteractionGuidance } from "../../../../../utils/interaction-guidance";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const guidanceId = requireUuid(getRouterParam(event, "guidanceId") ?? "", "互动指导");
  return updateInteractionGuidance(getPrisma(), { ownerId, characterId, guidanceId, body: await readBody(event) });
});
