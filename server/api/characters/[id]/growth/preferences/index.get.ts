import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parsePreferenceListQuery } from "../../../../../utils/preferences-domain";
import { listPreferences } from "../../../../../utils/preferences";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  return listPreferences(getPrisma(), { ownerId, characterId, ...parsePreferenceListQuery(getQuery(event)) });
});
