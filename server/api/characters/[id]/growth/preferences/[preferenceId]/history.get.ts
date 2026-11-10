import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { parsePreferenceListQuery } from "../../../../../../utils/preferences-domain";
import { listPreferenceHistory } from "../../../../../../utils/preferences";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const preferenceId = requireUuid(getRouterParam(event, "preferenceId") ?? "", "偏好");
  const { page, pageSize } = parsePreferenceListQuery(getQuery(event));
  return listPreferenceHistory(getPrisma(), { ownerId, characterId, preferenceId, page, pageSize });
});
