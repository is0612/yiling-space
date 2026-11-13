import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { listInteractionExperiences, parseInteractionExperienceListQuery } from "../../../../../utils/interaction-experiences";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  return listInteractionExperiences(getPrisma(), { ownerId, characterId, ...parseInteractionExperienceListQuery(getQuery(event)) });
});
